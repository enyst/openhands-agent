import { LOCKED_MODEL_IDS, LOCKED_MODEL_COST_IDS } from './model-discovery-catalog.js';
import { VERIFIED_MODELS } from './verified-models.js';

export { MODEL_DISCOVERY_PROVENANCE } from './model-discovery-catalog.js';

export interface SupportedLLMModelsOptions {
  readonly modelIds?: readonly string[];
  readonly modelCostIds?: readonly string[];
  /** Results from an actual host-owned authenticated AWS discovery adapter. */
  readonly bedrockModelIds?: readonly string[];
}

/** Offline catalog membership, not a claim of endpoint access or model metadata.
 * Hosts own live AWS discovery; no credentials or provider calls occur here.
 */
export function getSupportedLLMModels(options: SupportedLLMModelsOptions = {}): string[] {
  return [...(options.modelIds ?? LOCKED_MODEL_IDS), ...(options.modelCostIds ?? LOCKED_MODEL_COST_IDS),
    ...VERIFIED_MODELS.openrouter.map(model => `openrouter/${model}`)]
    .filter(model => !model.startsWith('bedrock')).concat(options.bedrockModelIds ?? []);
}
