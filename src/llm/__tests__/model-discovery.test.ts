// Python c96875fe: verified routes remain discoverable independently of metadata.
import { expect, it } from 'vitest';
import { getSupportedLLMModels, MODEL_DISCOVERY_PROVENANCE } from '../model-discovery.js';
import { VERIFIED_MODELS } from '../verified-models.js';
import manifest from '../../../transpile/upstream.json';

it('unions verified OpenRouter routes even with no dependency metadata', () => {
  const models = getSupportedLLMModels({ modelIds: ['deepseek/deepseek-chat', 'bedrock/anthropic.claude-3'], modelCostIds: [] });
  for (const model of VERIFIED_MODELS.openrouter) expect(models).toContain(`openrouter/${model}`);
  expect(models).toContain('deepseek/deepseek-chat');
  expect(models).not.toContain('bedrock/anthropic.claude-3');
  expect(models).not.toContain('openrouter/openai/gpt-5.6');
});

it('includes only explicitly discovered Bedrock results and retains caller arrays', () => {
  const modelIds = Object.freeze(['bedrock/hidden', 'gpt-4o']);
  const modelCostIds = Object.freeze(['bedrock_converse/hidden', 'custom/model']);
  const bedrockModelIds = Object.freeze(['bedrock/discovered']);
  const models = getSupportedLLMModels({ modelIds, modelCostIds, bedrockModelIds });
  expect(models).toEqual(expect.arrayContaining(['gpt-4o', 'custom/model', 'bedrock/discovered', 'openrouter/deepseek/deepseek-chat']));
  expect(models).not.toContain('bedrock/hidden');
  expect(models).not.toContain('bedrock_converse/hidden');
});

it('uses the locked dependency catalog by default without network discovery', () => {
  const models = getSupportedLLMModels();
  expect(models).toContain('gpt-4o');
  expect(models).toContain('openrouter/deepseek/deepseek-chat');
  expect(models.some(model => model.startsWith('bedrock'))).toBe(false);
});

it('binds the generated model lists to the canonical pin and verified dependency source', () => {
  expect(MODEL_DISCOVERY_PROVENANCE.upstream_commit).toBe(manifest.commit);
  expect(MODEL_DISCOVERY_PROVENANCE.litellm_sdist_sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(MODEL_DISCOVERY_PROVENANCE.source_sha256['__init__.py']).toMatch(/^[a-f0-9]{64}$/u);
  expect(MODEL_DISCOVERY_PROVENANCE.source_sha256['model_prices_and_context_window_backup.json']).toMatch(/^[a-f0-9]{64}$/u);
});
