import {
  defaultObservabilitySpanNameFromEnv, mergeObservabilityMetadata, observabilityHeaders,
  observabilityParentSpanContextFromEnv, observabilityTagsFromEnv,
  type ConversationObservabilityOptions, type EnvLike, type HeaderInjector,
} from '../observability/index.js';

export interface AutomationContextOptions {
  readonly metadata?: Readonly<Record<string, unknown>> | null;
  readonly tags?: readonly string[] | null;
  readonly spanName?: string | null;
  readonly parentSpanContext?: string | null;
  readonly env?: EnvLike;
  readonly injectHeaders?: HeaderInjector;
}
export type AutomationObservabilityContext = Pick<ConversationObservabilityOptions,
  'observabilityMetadata' | 'observabilityTags' | 'observabilitySpanName' | 'observabilityParentSpanContext'>;

export function automationObservabilityContext(options: AutomationContextOptions = {}): AutomationObservabilityContext {
  const env = options.env ?? process.env;
  const metadata = mergeObservabilityMetadata(options.metadata, env);
  const tags = [...new Set([...observabilityTagsFromEnv(env), ...(options.tags ?? [])].map(tag => tag.trim()).filter(Boolean))];
  const span = options.spanName || defaultObservabilitySpanNameFromEnv(env);
  const parent = options.parentSpanContext || observabilityParentSpanContextFromEnv(env);
  return {
    ...(Object.keys(metadata).length ? { observabilityMetadata: metadata } : {}),
    ...(tags.length ? { observabilityTags: tags } : {}),
    ...(span ? { observabilitySpanName: span } : {}),
    ...(parent ? { observabilityParentSpanContext: parent } : {}),
  };
}

export function automationConversationTags(metadata?: Readonly<Record<string, unknown>> | null, env: EnvLike = process.env): Record<string, string> {
  const merged = mergeObservabilityMetadata(metadata, env);
  const scalar = (name: string): string | undefined => {
    const value = merged[name];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  };
  const id = scalar('automation.id'); const name = scalar('automation.name');
  const run = scalar('automation.run_id'); const trigger = scalar('automation.trigger_source');
  return { ...(id || name || run || trigger ? { automationtrigger: 'automation' } : {}),
    ...(id ? { automationid: id } : {}), ...(name ? { automationname: name } : {}), ...(run ? { automationrunid: run } : {}) };
}

export interface AutomationConversationOptions extends Omit<AutomationContextOptions, 'tags'> {
  readonly observabilityTags?: readonly string[] | null;
  readonly conversationTags?: Readonly<Record<string, string>> | null;
  readonly includeConversationTags?: boolean;
}

/** Native constructor options equivalent to Python automation_conversation_kwargs. */
export function automationConversationOptions(options: AutomationConversationOptions = {}): AutomationObservabilityContext & { readonly tags?: Readonly<Record<string, string>> } {
  const env = options.env ?? process.env;
  const context = automationObservabilityContext({ ...options, tags: options.observabilityTags ?? null,
    spanName: options.spanName || defaultObservabilitySpanNameFromEnv(env) || 'automation.conversation' });
  const tags = options.includeConversationTags === false ? {} : { ...automationConversationTags(options.metadata, env), ...options.conversationTags };
  return { ...context, ...(Object.keys(tags).length ? { tags } : {}) };
}

export const automationConversationKwargs = automationConversationOptions;

export function automationObservabilityHeaders(options: AutomationContextOptions = {}): Record<string, string> {
  const context = automationObservabilityContext(options);
  return observabilityHeaders({ metadata: context.observabilityMetadata ?? null, tags: context.observabilityTags ?? null,
    spanName: context.observabilitySpanName ?? null, parentSpanContext: context.observabilityParentSpanContext ?? null }, options.injectHeaders);
}
