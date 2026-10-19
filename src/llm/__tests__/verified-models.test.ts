import manifest from '../../../transpile/upstream.json';
import { describe, expect, it } from 'vitest';
import { VERIFIED_MODELS_PROVENANCE, VERIFIED_OPENROUTER_MODELS, VERIFIED_MODELS, VERIFIED_NVIDIA_MODELS, VERIFIED_OPENAI_MODELS, VERIFIED_ANTHROPIC_MODELS, VERIFIED_OPENHANDS_MODELS } from '../verified-models.js';

describe('verified model catalog', () => {
  // Python c3ecd82c: final 1.55 catalog additions and oldest Sonnet removal.
  it('publishes the final pinned GPT, Anthropic and Gemini generations', () => {
    for (const models of [VERIFIED_MODELS.openai, VERIFIED_MODELS.openhands]) expect(models).toContain('gpt-6.1-sol');
    expect(VERIFIED_MODELS.anthropic).toEqual(expect.arrayContaining(['claude-sonnet-5-5', 'claude-haiku-5-5']));
    expect(VERIFIED_MODELS.anthropic).not.toContain('claude-sonnet-4-6');
    expect(VERIFIED_MODELS.openhands).not.toContain('claude-sonnet-4-6');
    expect(VERIFIED_MODELS.gemini).toContain('gemini-4-argon');
    expect(VERIFIED_MODELS.openrouter).toEqual(expect.arrayContaining(['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5', 'openai/gpt-6.1-sol', 'google/gemini-4-argon']));
  });

  it('exposes DigitalOcean tool-capable models with provider-relative names', () => {
    const models = (VERIFIED_MODELS as Readonly<Record<string, readonly string[]>>).digitalocean;
    expect(models).toHaveLength(12);
    expect(models).toEqual(expect.arrayContaining(['glm-5.3', 'openai-gpt-5.6-sol', 'deepseek-v4-pro']));
    expect(models?.every(model => !model.startsWith('digitalocean/'))).toBe(true);
  });
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
  expect(routes).toHaveLength(25);
  expect(routes).toEqual(expect.arrayContaining(['anthropic/claude-opus-5', 'openai/gpt-6-astra', 'openai/gpt-5.6-sol', 'moonshotai/kimi-k3']));
  expect(routes).not.toContain('openai/gpt-5.6');
  expect(routes?.every(model => model.includes('/') && !model.startsWith('openrouter/'))).toBe(true);
});

it('binds the catalog to the canonical pin and exposes the same OpenRouter view', () => {
  expect(VERIFIED_MODELS_PROVENANCE.upstream_commit).toBe(manifest.commit);
  expect(VERIFIED_MODELS_PROVENANCE.model_map_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(VERIFIED_OPENROUTER_MODELS).toEqual(VERIFIED_MODELS.openrouter);
});
