import { z } from 'zod';

import { textContent, textContentSchema } from '../llm/index.js';
import { registerBuiltinResolver, ToolDefinition, toolAnnotationsSchema } from './index.js';

export const switchLLMActionSchema = z.object({
  profile_name: z.string().describe('Name of the saved LLM profile to use for future agent steps.'),
  reason: z.string().describe('Brief reason why this profile is a better fit for the next step.'),
}).strict();

export const switchLLMObservationSchema = z.object({
  kind: z.literal('SwitchLLMObservation').default('SwitchLLMObservation'),
  content: z.array(textContentSchema).default([]),
  is_error: z.boolean().default(false),
  profile_name: z.string(),
  reason: z.string().nullable().default(null),
  active_model: z.string().nullable().default(null),
}).strict();

export type SwitchLLMAction = z.infer<typeof switchLLMActionSchema>;
export type SwitchLLMObservation = z.infer<typeof switchLLMObservationSchema>;

export interface SwitchLLMToolOptions {
  readonly profileNames: readonly string[];
  /**
   * Resolve and accept the selection for the next LLM call. A host queuing a
   * step-boundary replacement must durably save it before returning, and must
   * not await the current step (which is awaiting this tool). Hosts own profile
   * storage, credentials, and safe error messages.
   */
  readonly switchProfile?: (profileName: string) => Promise<{ model: string }> | { model: string };
}

export class SwitchLLMTool {
  static readonly className = 'SwitchLLMTool';

  static create(options: SwitchLLMToolOptions = { profileNames: [] }): ToolDefinition<typeof switchLLMActionSchema, typeof switchLLMObservationSchema> {
    const profiles = options.profileNames.length === 0
      ? '- No saved LLM profiles are currently available.'
      : [...options.profileNames].sort().map((name) => `- ${name}`).join('\n');
    return new ToolDefinition({
      name: 'switch_llm',
      description: 'Switch this conversation to a saved LLM profile.\n\n'
        + 'Use this when another available profile is better suited for the next step. '
        + 'The current tool call is still executed by the current model; the switch '
        + 'takes effect on the next LLM call.\n\n'
        + `Available LLM profiles:\n${profiles}\n\n`
        + 'Provide the profile_name exactly as listed and include a concise reason for the switch.',
      inputSchema: switchLLMActionSchema,
      outputSchema: switchLLMObservationSchema,
      annotations: toolAnnotationsSchema.parse({
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
      }),
      executor: async (action) => {
        if (options.switchProfile === undefined) {
          return observation(action, 'Cannot switch LLM profile without an active conversation.', true);
        }
        try {
          const selected = await options.switchProfile(action.profile_name);
          return observation(action,
            `Accepted LLM profile '${action.profile_name}' with model '${selected.model}' for the next LLM call. Reason: ${action.reason}`,
            false, selected.model);
        } catch (error) {
          const missing = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
          const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          return observation(action, missing
            ? `LLM profile '${action.profile_name}' was not found.`
            : `Failed to switch LLM profile '${action.profile_name}': ${detail}`, true);
        }
      },
    });
  }
}

function observation(action: SwitchLLMAction, text: string, isError: boolean, model: string | null = null): SwitchLLMObservation {
  return switchLLMObservationSchema.parse({
    content: [textContent(text)], is_error: isError, profile_name: action.profile_name,
    reason: action.reason, active_model: model,
  });
}

registerBuiltinResolver('switch_llm', (params, context) => {
  if (Object.keys(params).length > 0) throw new Error("SwitchLLMTool doesn't accept parameters");
  return [SwitchLLMTool.create(isSwitchBinding(context) ? context : undefined)];
});

function isSwitchBinding(context: unknown): context is SwitchLLMToolOptions {
  return typeof context === 'object' && context !== null
    && 'profileNames' in context && Array.isArray(context.profileNames)
    && context.profileNames.every((name: unknown) => typeof name === 'string')
    && (!('switchProfile' in context) || context.switchProfile === undefined || typeof context.switchProfile === 'function');
}
