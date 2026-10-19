import { z } from 'zod';

import type { ConversationState } from '../conversation/state.js';
import type { Event } from '../event/index.js';
import type { LLMCallContext } from '../llm/call-context.js';
import { LLMResponseError, type LLMClient, type LLMCompletionResponse } from '../llm/client.js';
import { contentToString, messageSchema, textContent, textContentSchema, type LLMProfile, type Message } from '../llm/index.js';
import { createLlmUsageEvent } from '../llm/metrics.js';
import { LLMUsagePersistenceError } from '../llm/usage-persistence.js';
import { MetaProfileStore, metaProfileLlmsSchema, metaProfileSchema, type MetaProfile, type MetaProfileInput } from '../meta-profiles/index.js';
import { registerBuiltinResolver, ToolDefinition, toolAnnotationsSchema } from './index.js';

export const classifyAndSwitchLLMActionSchema = z.object({}).strict();
export const classifyAndSwitchLLMObservationSchema = z.object({
  kind: z.literal('ClassifyAndSwitchLLMObservation').default('ClassifyAndSwitchLLMObservation'),
  content: z.array(textContentSchema).default([]),
  is_error: z.boolean().default(false),
  chosen_class: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  active_model: z.string().nullable().default(null),
}).strict();
export type ClassifyAndSwitchLLMAction = z.infer<typeof classifyAndSwitchLLMActionSchema>;
export type ClassifyAndSwitchLLMObservation = z.infer<typeof classifyAndSwitchLLMObservationSchema>;

export interface MetaProfileRoutingRuntime {
  readonly state: ConversationState;
  listProfileNames(): readonly string[] | Promise<readonly string[]>;
  /** Host resolves saved profile references/credentials; inline profiles use the same native factory. */
  resolveClient(name: string, inlineProfile?: LLMProfile): Promise<LLMClient>;
  /** Durably accept a pending selection without waiting for the step that is executing this tool. */
  switchProfile(name: string, inlineProfile?: LLMProfile): Promise<{ model: string }> | { model: string };
  getCallContext(): LLMCallContext;
}

export interface ClassifyAndSwitchLLMToolOptions {
  readonly metaProfileStore?: Pick<MetaProfileStore, 'list' | 'load'>;
  readonly activeMetaProfile?: string | null;
  readonly metaProfile?: MetaProfileInput | null;
  readonly metaProfileLlms?: Readonly<Record<string, LLMProfile>>;
  readonly runtime?: MetaProfileRoutingRuntime;
}

const CLASSIFIER_SYSTEM_PREFIX = 'You are a model-routing classifier.';

export function buildClassifierPrompt(meta: MetaProfile): string {
  return [CLASSIFIER_SYSTEM_PREFIX, '', 'Based on the recent conversation, pick the single category that best describes the current task.', '', 'Categories:',
    ...meta.classes.map((category, index) => `${index + 1}. ${category.description}`), '',
    'Respond with ONLY the number of the best matching category. If none of the categories clearly apply, respond with 0.',
  ].join('\n');
}

export function parseClassIndex(text: string, numClasses: number): number {
  const match = /-?\d+/u.exec(text);
  const value = match === null ? 0 : Number(match[0]);
  return Number.isInteger(value) && value >= 1 && value <= numClasses ? value : 0;
}

export function renderDirectPrompt(meta: MetaProfile, instanceText: string): string {
  const values: Record<string, string> = { instance_text: instanceText, model_table: meta.model_table ?? '' };
  const rendered = (meta.prompt_template ?? '').replace(/\{\{\s*(instance_text|model_table)\s*\}\}/gu, (_match, name: string) => values[name]!).trim();
  return `${CLASSIFIER_SYSTEM_PREFIX}\n\n${rendered}`;
}

export function parseDirectModel(text: string, availableModels: readonly string[]): string | null {
  const raw = text.trim().replace(/^```[a-zA-Z]*\n?/u, '').replace(/\n?```$/u, '').trim();
  const modelsByCase = new Map(availableModels.map(model => [casefold(model), model]));
  let candidate = '';
  try {
    const match = /\{[\s\S]*\}/u.exec(raw);
    if (match !== null) {
      const value: unknown = JSON.parse(match[0]);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const model = (value as Record<string, unknown>).model;
        candidate = model === undefined ? '' : pythonScalarString(model).trim();
      }
    }
  } catch { /* Fall back to scanning malformed classifier output, as upstream does. */ }
  // A parsed but unknown selection must not fall through to a different model mentioned in prose.
  if (candidate) return modelsByCase.get(casefold(candidate)) ?? null;
  const scan = casefold(raw);
  return [...availableModels].sort((a, b) => b.length - a.length).find(model => scan.includes(casefold(model))) ?? null;
}

export function recentMessagesText(events: readonly Event[], limit = 6): string {
  return events.filter(event => event.kind === 'MessageEvent').flatMap(event => {
    const text = contentToString(event.llm_message.content).join('\n').trim();
    return text ? [`${event.source}: ${text}`] : [];
  }).slice(-limit).join('\n');
}

export class ClassifyAndSwitchLLMTool {
  static readonly className = 'ClassifyAndSwitchLLMTool';

  static create(options: ClassifyAndSwitchLLMToolOptions = {}): ToolDefinition<typeof classifyAndSwitchLLMActionSchema, typeof classifyAndSwitchLLMObservationSchema> {
    const allowed = ['metaProfileStore', 'activeMetaProfile', 'metaProfile', 'metaProfileLlms', 'runtime'];
    if (Object.keys(options).some(name => !allowed.includes(name))) {
      throw new Error('ClassifyAndSwitchLLMTool only accepts metaProfileStore, activeMetaProfile, metaProfile, metaProfileLlms, and runtime.');
    }
    const inlineMeta = options.metaProfile === undefined || options.metaProfile === null ? null : metaProfileSchema.parse(options.metaProfile);
    const inlineLlms = metaProfileLlmsSchema.parse(options.metaProfileLlms ?? {});
    const inlineProfile = (name: string) => Object.hasOwn(inlineLlms, name) ? inlineLlms[name] : undefined;
    // A default store is created lazily so constructing a disabled/unbound tool never touches disk.
    let store = options.metaProfileStore;
    const classifierClients = new Map<string, Promise<LLMClient>>();
    const getStore = () => store ??= new MetaProfileStore();

    const resolveMeta = async (): Promise<MetaProfile> => {
      if (options.activeMetaProfile) {
        try { return await getStore().load(options.activeMetaProfile); }
        catch (error) { if (!isMissing(error)) throw error; }
      }
      if (inlineMeta !== null) return inlineMeta;
      if (options.activeMetaProfile) throw new Error('Active meta-profile could not be resolved from the store or inline configuration.');
      const available = [...await getStore().list()].sort();
      if (available[0] === undefined) throw new Error('No meta-profile is active and none are available in the meta-profile store.');
      return getStore().load(available[0]);
    };

    return new ToolDefinition({
      name: 'route_task_to_model',
      description: 'Classify the current task and switch this conversation to the most suitable saved LLM profile.\n\n'
        + 'Use this near the start of a task (or when the task changes) to route the work to the best model. '
        + 'A classifier model inspects the recent conversation and picks a category from the active meta-profile; '
        + 'the conversation then switches to that category\'s LLM profile. The switch takes effect on the next LLM call.',
      inputSchema: classifyAndSwitchLLMActionSchema,
      outputSchema: classifyAndSwitchLLMObservationSchema,
      annotations: toolAnnotationsSchema.parse({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
      executor: async () => {
        const runtime = options.runtime;
        if (runtime === undefined) return observation('Cannot classify and switch LLM without an active conversation.', true);
        let meta: MetaProfile;
        try { meta = await resolveMeta(); }
        catch { return observation('Failed to resolve the active meta-profile. Check its name, stored JSON and inline configuration.', true); }

        let classifier: LLMClient;
        try {
          let pending = classifierClients.get(meta.classifier_model);
          if (pending === undefined) {
            pending = runtime.resolveClient(meta.classifier_model, inlineProfile(meta.classifier_model));
            classifierClients.set(meta.classifier_model, pending);
            void pending.catch(() => { if (classifierClients.get(meta.classifier_model) === pending) classifierClients.delete(meta.classifier_model); });
          }
          classifier = await pending;
        } catch { return observation(`Failed to load classifier profile '${meta.classifier_model}'.`, true); }

        const transcript = recentMessagesText(runtime.state.events) || '(no messages yet)';
        const messages: Message[] = meta.prompt_template === null
          ? [message('system', buildClassifierPrompt(meta)), message('user', `Recent conversation:\n${transcript}\n\nCategory number:`)]
          : [message('system', renderDirectPrompt(meta, transcript))];
        const callContext = runtime.getCallContext();
        const startedAt = Date.now();
        let response: LLMCompletionResponse | undefined;
        let callFailed = false;
        let failure: unknown;
        try { response = await classifier.complete(messages, undefined, { callContext }); }
        catch (error) { callFailed = true; failure = error; }
        // Event construction and durable append are fatal after the paid call. The
        // tool executor must not turn either failure into an ordinary retryable observation.
        try {
          await runtime.state.appendEventAsync(createLlmUsageEvent(classifier.profile,
            response ?? (failure instanceof LLMResponseError ? failure.metadata : { usage: null }),
            { startedAt, completedAt: Date.now(), usageId: `classifier:${meta.classifier_model}`, requestSucceeded: !callFailed }));
        } catch (error) { throw new LLMUsagePersistenceError(error); }
        if (callFailed || response === undefined) return observation('Classifier call failed. Check the classifier profile and provider connection.', true);
        const reply = contentToString(response.message.content).join('\n');

        let target: string;
        let chosenClass: string;
        if (meta.prompt_template === null) {
          const chosen = meta.classes[parseClassIndex(reply, meta.classes.length) - 1];
          if (chosen === undefined) return observation('Classifier did not pick a valid category; refusing to silently route to a default. Retry the tool or fix the meta-profile classes.', true);
          target = chosen.model;
          chosenClass = chosen.description;
        } else {
          let names: readonly string[];
          try { names = await runtime.listProfileNames(); }
          catch { return observation('Failed to list saved LLM profiles for the classifier selection.', true); }
          const selected = parseDirectModel(reply, [...new Set([...names, ...Object.keys(inlineLlms)])].sort());
          if (selected === null) return observation('Classifier reply did not resolve to a saved LLM profile; refusing to silently route to a default. Retry the tool or extend the model table.', true);
          target = selected;
          chosenClass = `model: ${target}`;
        }
        try {
          const selected = await runtime.switchProfile(target, inlineProfile(target));
          return observation(`Classified task as '${chosenClass}' and accepted LLM profile '${target}' (model '${selected.model}') for the next LLM call.`, false,
            { model: target, chosen_class: chosenClass, active_model: selected.model });
        } catch (error) {
          return observation(isMissing(error) ? `Target LLM profile '${target}' was not found.` : `Failed to switch to LLM profile '${target}'.`, true,
            { model: target, chosen_class: chosenClass });
        }
      },
    });
  }
}

function message(role: 'system' | 'user', text: string): Message {
  return messageSchema.parse({ role, content: [textContent(text)] });
}

function observation(text: string, isError: boolean, fields: Partial<ClassifyAndSwitchLLMObservation> = {}): ClassifyAndSwitchLLMObservation {
  return classifyAndSwitchLLMObservationSchema.parse({ ...fields, content: [textContent(text)], is_error: isError });
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function casefold(text: string): string {
  return text.toLowerCase().replace(/ß/gu, 'ss').replace(/ς/gu, 'σ');
}

function pythonScalarString(value: unknown): string {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string' || typeof value === 'number') return value.toString();
  return typeof value === 'object' ? JSON.stringify(value) : '';
}

const resolverParamsSchema = z.object({
  active_meta_profile: z.string().nullable().optional(),
  meta_profile: metaProfileSchema.nullable().optional(),
  meta_profile_llms: metaProfileLlmsSchema.optional(),
}).strict();
for (const name of ['route_task_to_model', ClassifyAndSwitchLLMTool.className]) {
  registerBuiltinResolver(name, (params, context) => {
    const parsed = resolverParamsSchema.safeParse(params);
    if (!parsed.success) throw new Error('ClassifyAndSwitchLLMTool only accepts active_meta_profile, meta_profile, and native meta_profile_llms parameters.');
    const binding = typeof context === 'object' && context !== null ? context as ClassifyAndSwitchLLMToolOptions : {};
    return [ClassifyAndSwitchLLMTool.create({ ...binding,
      ...(parsed.data.active_meta_profile === undefined ? {} : { activeMetaProfile: parsed.data.active_meta_profile }),
      ...(parsed.data.meta_profile === undefined ? {} : { metaProfile: parsed.data.meta_profile }),
      ...(parsed.data.meta_profile_llms === undefined ? {} : { metaProfileLlms: parsed.data.meta_profile_llms }),
    })];
  });
}
