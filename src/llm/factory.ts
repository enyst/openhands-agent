import type { SecretStore } from '../secrets/index.js';
import { createAnthropicClientFromProfile } from './anthropic.js';
import type { LLMClient } from './client.js';
import { createGeminiClientFromProfile } from './gemini.js';
import type { LLMProfile } from './index.js';
import { createOpenAIChatClientFromProfile, createOpenAIResponsesClientFromProfile, type CreateLlmClientOptions } from './openai.js';
import { resolveOpenAiApiMode, resolveProviderFromProfile } from './transport.js';

export { detectProviderFromBaseUrl, resolveProviderFromProfile, type DetectedLlmProvider } from './transport.js';

export async function createClientFromProfile(
  profile: LLMProfile,
  store: SecretStore,
  options: CreateLlmClientOptions = {},
): Promise<LLMClient> {
  if (profile.authType === 'subscription') {
    return createOpenAIResponsesClientFromProfile(profile, store, options);
  }
  const provider = resolveProviderFromProfile(profile);
  if (provider === 'anthropic') {
    return createAnthropicClientFromProfile(profile, store, options);
  }
  if (provider === 'gemini') {
    return createGeminiClientFromProfile(profile, store, options);
  }
  const mode = resolveOpenAiApiMode(profile);
  const resolvedProfile = { ...profile, openAiApiMode: mode };
  if (mode === 'responses') {
    return createOpenAIResponsesClientFromProfile(resolvedProfile, store, options);
  }
  return createOpenAIChatClientFromProfile(resolvedProfile, store, options);
}
