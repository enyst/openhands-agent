import { z } from 'zod';
import { metaProfileLlmsSchema, metaProfileSchema } from '../meta-profiles/index.js';
import { mergeDuplicateTools, normalizeToolSpecs, rejectBuiltinParams } from './defaults.js';
import { assertSupportedResponseSchema, toolSpecSchema, type ToolSpec } from './index.js';

export const classifyAndSwitchLLMParamsSchema = z.object({
  active_meta_profile: z.string().nullable().optional(),
  meta_profile: metaProfileSchema.nullable().optional(),
  meta_profile_llms: metaProfileLlmsSchema.optional(),
}).strict();

/** Validate every original explicit router spec before deduplication can hide it. */
export function validateToolSpecsForPersistence(tools: readonly unknown[]): ToolSpec[] {
  const specs = normalizeToolSpecs(tools);
  for (const spec of specs) {
    assertSupportedResponseSchema(spec.params);
    if (spec.name === 'route_task_to_model' || spec.name === 'ClassifyAndSwitchLLMTool') {
      const params = { ...spec.params };
      delete params.response_schema;
      if (!classifyAndSwitchLLMParamsSchema.safeParse(params).success) {
        throw new z.ZodError([{ code: 'custom', path: ['tools'], message: 'Invalid native classifier tool parameters.' }]);
      }
    }
  }
  rejectBuiltinParams(specs);
  return mergeDuplicateTools(specs);
}
export const persistedToolSpecsSchema = z.preprocess(value => Array.isArray(value) ? validateToolSpecsForPersistence(value) : value, z.array(toolSpecSchema));
