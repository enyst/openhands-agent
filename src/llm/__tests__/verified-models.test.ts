import { describe, expect, it } from 'vitest';
import { VERIFIED_MODELS, VERIFIED_NVIDIA_MODELS, VERIFIED_OPENAI_MODELS, VERIFIED_ANTHROPIC_MODELS, VERIFIED_OPENHANDS_MODELS } from '../verified-models.js';

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
