import { describe, expect, it } from 'vitest';
import manifest from '../../../transpile/upstream.json';
import { PROMPT_CACHE_KEY_MODELS, PROMPT_CACHE_KEY_PROVENANCE } from '../prompt-cache-models.js';

describe('pinned prompt-cache-key capabilities', () => {
  it('keeps native capability evidence bound to the canonical full Python pin', () => {
    expect(PROMPT_CACHE_KEY_PROVENANCE.upstream_commit).toBe(manifest.commit);
    expect(PROMPT_CACHE_KEY_PROVENANCE.source_sha256).toHaveProperty('openhands-sdk/openhands/sdk/llm/utils/model_features.py');
    expect(PROMPT_CACHE_KEY_PROVENANCE.source_sha256).toHaveProperty('uv.lock');
  });

  it('includes known OpenAI models and excludes unresolved and incompatible aliases', () => {
    for (const model of ['gpt-4o', 'gpt-5.2', 'gpt-6-sol', 'gpt-6-luna']) expect(PROMPT_CACHE_KEY_MODELS).toContain(model);
    for (const model of ['my-openai-alias', 'claude-opus-5-5', 'gemini-2.5-pro']) expect(PROMPT_CACHE_KEY_MODELS).not.toContain(model);
    expect(new Set(PROMPT_CACHE_KEY_MODELS).size).toBe(PROMPT_CACHE_KEY_MODELS.length);
  });
});
