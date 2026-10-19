import type { LLMProfile, OpenAiApiMode } from './index.js';
import { normalizeOpenAIModelName } from './provider-quirks.js';

const DETECTED_LLM_PROVIDERS = ['anthropic', 'gemini', 'openai', 'openrouter', 'litellm_proxy'] as const;

export type DetectedLlmProvider = (typeof DETECTED_LLM_PROVIDERS)[number];

/** Shared config/history normalization; explicit persisted modes retain their identity. */
export function resolveOpenAiApiMode(profile: LLMProfile): OpenAiApiMode {
  if (profile.openAiApiMode !== undefined) return profile.openAiApiMode;
  const provider = resolveProviderFromProfile(profile);
  // These native transports predate selectable OpenAI modes; preserve their old default digest.
  if (provider === 'anthropic' || provider === 'gemini') return 'chat_completions';
  return /^gpt-6(?:[.-]|$)/u.test(normalizeOpenAIModelName(profile.model)) ? 'responses' : 'chat_completions';
}

export function resolveProviderFromProfile(profile: LLMProfile): DetectedLlmProvider {
  const providerId = profile.providerId.toLowerCase();
  if (isDetectedLlmProvider(providerId)) {
    return providerId;
  }
  return detectProviderFromBaseUrl(profile.baseUrl);
}

export function detectProviderFromBaseUrl(baseUrl?: string | null): DetectedLlmProvider {
  const normalized = (baseUrl ?? '').toLowerCase();
  if (normalized.includes('anthropic')) {
    return 'anthropic';
  }
  if (normalized.includes('generativelanguage.googleapis.com') || normalized.includes('ai.google.dev') || normalized.includes('gemini')) {
    return 'gemini';
  }
  if (normalized.includes('openrouter')) {
    return 'openrouter';
  }
  if (normalized.includes('litellm') || normalized.includes('llm-proxy')) {
    return 'litellm_proxy';
  }
  return 'openai';
}

function isDetectedLlmProvider(providerId: string): providerId is DetectedLlmProvider {
  return DETECTED_LLM_PROVIDERS.includes(providerId as DetectedLlmProvider);
}
