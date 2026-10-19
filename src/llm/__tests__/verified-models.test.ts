import { describe, expect, it } from 'vitest';
import { VERIFIED_MODELS, VERIFIED_NVIDIA_MODELS } from '../verified-models.js';

describe('verified model catalog', () => {
  // Python bd5fff06 adds this model to the NVIDIA catalog.
  it('exposes Nemotron Nano Omni through the NVIDIA list and provider catalog', () => {
    const model = 'nemotron-3-nano-omni-30b-a3b-reasoning';
    expect(VERIFIED_NVIDIA_MODELS).toContain(model);
    expect(VERIFIED_MODELS.nvidia).toContain(model);
  });
});
