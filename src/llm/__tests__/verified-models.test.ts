import manifest from '../../../transpile/upstream.json';
import { describe, expect, it } from 'vitest';
import { VERIFIED_MODELS_PROVENANCE, VERIFIED_OPENROUTER_MODELS, VERIFIED_MODELS, VERIFIED_NVIDIA_MODELS, VERIFIED_OPENAI_MODELS, VERIFIED_ANTHROPIC_MODELS, VERIFIED_OPENHANDS_MODELS } from '../verified-models.js';

describe('verified model catalog', () => {
  // Python c78c9b2 adds GPT-6 sol/luna and Opus 5.5; removes Opus 4.8.
  it.each(['gpt-6-sol', 'gpt-6-luna'])('publishes %s through OpenAI and OpenHands catalogs', model => {
    expect(VERIFIED_OPENAI_MODELS).toContain(model);
    expect(VERIFIED_OPENHANDS_MODELS).toContain(model);
    expect(VERIFIED_MODELS.openai).toContain(model);
    expect(VERIFIED_MODELS.openhands).toContain(model);
  });

  it('replaces Opus 4.8 with Opus 5.5 in both provider and OpenHands views', () => {
    for (const models of [VERIFIED_ANTHROPIC_MODELS, VERIFIED_OPENHANDS_MODELS, VERIFIED_MODELS.anthropic, VERIFIED_MODELS.openhands]) {
      expect(models).toContain('claude-opus-5-5');
      expect(models).not.toContain('claude-opus-4-8');
    }
  });

  // Python bd5fff06 adds this model to the NVIDIA catalog.
  it('exposes Nemotron Nano Omni through the NVIDIA list and provider catalog', () => {
    const model = 'nemotron-3-nano-omni-30b-a3b-reasoning';
    expect(VERIFIED_NVIDIA_MODELS).toContain(model);
    expect(VERIFIED_MODELS.nvidia).toContain(model);
  });
});

// PORT 7c4d3ad2: use real namespaced OpenRouter routes, not provider aliases.
it('publishes verified OpenRouter routes without the transport prefix', () => {
  const routes = (VERIFIED_MODELS as Readonly<Record<string, readonly string[]>>).openrouter;
  expect(routes).toHaveLength(21);
  expect(routes).toEqual(expect.arrayContaining(['anthropic/claude-opus-5', 'openai/gpt-6-astra', 'openai/gpt-5.6-sol', 'moonshotai/kimi-k3']));
  expect(routes).not.toContain('openai/gpt-5.6');
  expect(routes?.every(model => model.includes('/') && !model.startsWith('openrouter/'))).toBe(true);
});

it('binds the catalog to the canonical pin and exposes the same OpenRouter view', () => {
  expect(VERIFIED_MODELS_PROVENANCE.upstream_commit).toBe(manifest.commit);
  expect(VERIFIED_MODELS_PROVENANCE.model_map_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(VERIFIED_OPENROUTER_MODELS).toEqual(VERIFIED_MODELS.openrouter);
});
