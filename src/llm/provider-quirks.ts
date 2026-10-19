import { bedrockCacheKeyResolution } from './bedrock-cache.js';
import type { LLMProfile, PromptCacheRetention, ReasoningEffort } from './index.js';
import { PROMPT_CACHE_KEY_MODELS, PROMPT_CACHE_KEY_UNHINTED, PROMPT_CACHE_KEY_HINTED, PROMPT_CACHE_KEY_PROVIDER_DEFAULTS, PROMPT_CACHE_KEY_ROUTING_RULES, PROMPT_CACHE_KEY_PROVIDER_DISPATCH, PROMPT_CACHE_KEY_PREFIX_RESOLUTION } from './prompt-cache-models.js';

export const ANTHROPIC_THINKING_MIN_BUDGET = 1024;
export const ANTHROPIC_THINKING_MAX_BUDGET = 128000;

const PROMPT_CACHE_MODELS = [
  'claude-3-7-sonnet',
  'claude-sonnet-3-7-latest',
  'claude-3-5-sonnet',
  'claude-3-5-haiku',
  'claude-3-haiku',
  'claude-3-opus',
  'claude-sonnet-4',
  'claude-opus-4',
  'claude-haiku-4-5',
  'claude-haiku-5-5',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-fable-5',
] as const;

export function isGpt5Model(model: string | null | undefined): boolean {
  return model?.trim().toLowerCase().includes('gpt-5') === true;
}

export function isGpt56Model(model: string | null | undefined): boolean {
  const normalized = model?.trim().toLowerCase().replace(/^openai\//u, '') ?? '';
  return /^gpt-5\.6(?:[-.]|$)/u.test(normalized);
}

export function isOpenAISubscriptionEndpoint(profile: LLMProfile): boolean {
  const baseUrl = profile.baseUrl?.trim().toLowerCase() ?? '';
  return baseUrl.includes('chatgpt.com/backend-api/codex');
}

export function supportsOpenAIPromptCacheRetention(profile: LLMProfile): boolean {
  if (profile.providerId !== 'openai' || profile.authType === 'subscription' || isOpenAISubscriptionEndpoint(profile) || !isGpt56Model(profile.model)) {
    return false;
  }
  const baseUrl = profile.baseUrl?.trim().toLowerCase();
  return baseUrl === undefined || baseUrl === '' || baseUrl.startsWith('https://api.openai.com/');
}

export function resolveOpenAIPromptCacheRetention(profile: LLMProfile): PromptCacheRetention | undefined {
  if (!supportsOpenAIPromptCacheRetention(profile) || profile.promptCacheRetention === 'disabled') {
    return undefined;
  }
  return profile.promptCacheRetention ?? '24h';
}

export function normalizeOpenAIModelName(model: string): string {
  return model.trim().toLowerCase().replace(/^(?:litellm_proxy|openhands)\//u, '')
    .replace(/^(?:prod|dev|staging|test)\//u, '').replace(/^openai\//u, '');
}

const cacheKeyModels: ReadonlySet<string> = new Set(PROMPT_CACHE_KEY_MODELS);

/** Sanitized runtime metadata only; never persisted into a profile. */
export interface PromptCacheMetadata {
  readonly servingProvider?: string;
  readonly supportsPromptCacheKey?: boolean;
}
const providerDefaults: Readonly<Record<string, { readonly supported: boolean }>> = PROMPT_CACHE_KEY_PROVIDER_DEFAULTS;
const routingRules = PROMPT_CACHE_KEY_ROUTING_RULES.map(rule => ({ provider: rule.provider, pattern: new RegExp(rule.pattern, 'iu') }));

const providerDispatch: Readonly<Record<string, { readonly program: unknown }>> = PROMPT_CACHE_KEY_PROVIDER_DISPATCH;
const resolvedPrefixes: Readonly<Record<string, unknown>> = PROMPT_CACHE_KEY_PREFIX_RESOLUTION;

/** Evaluate only the small expression vocabulary emitted from locked Python selectors. */
function evaluateCacheProgram(program: unknown, model: string): unknown {
  if (!Array.isArray(program)) return undefined;
  const read = (index: number): unknown => evaluateCacheProgram(program[index], model);
  switch (program[0]) {
    case 'value': return program[1] as unknown;
    case 'model': return model;
    case 'if': return read(1) ? read(2) : read(3);
    case 'not': return !read(1);
    case 'or': {
      let value: unknown;
      for (let index = 1; index < program.length; index++) { value = read(index); if (value) return value; }
      return value;
    }
    case 'and': {
      let value: unknown;
      for (let index = 1; index < program.length; index++) { value = read(index); if (!value) return value; }
      return value;
    }
    case 'eq': return read(1) === read(2);
    case 'gt': { const left = read(1), right = read(2); return typeof left === 'number' && typeof right === 'number' && left > right; }
    case 'in': {
      const needle = read(1), haystack = read(2);
      return typeof haystack === 'string' && typeof needle === 'string' ? haystack.includes(needle) : Array.isArray(haystack) && haystack.includes(needle);
    }
    case 'lower': { const value = read(1); return typeof value === 'string' ? value.toLowerCase() : undefined; }
    case 'last': { const value = read(1), separator = read(2); return typeof value === 'string' && typeof separator === 'string' ? value.split(separator).at(-1) : undefined; }
    case 'starts': { const value = read(1), prefix = read(2); return typeof value === 'string' && typeof prefix === 'string' && value.startsWith(prefix); }
    case 'at': { const value = read(1), index = read(2); return typeof value === 'string' && typeof index === 'number' ? value.at(index) : undefined; }
    case 'length': { const value = read(1); return typeof value === 'string' || Array.isArray(value) ? value.length : undefined; }
    case 'digits': { const value = read(1); return typeof value === 'string' && /^\d+$/u.test(value); }
    default: return undefined;
  }
}

function providerCacheResolution(provider: string, model: string): boolean | null {
  if (provider === 'bedrock') return bedrockCacheKeyResolution(model);
  if (Object.hasOwn(providerDispatch, provider)) {
    const result = evaluateCacheProgram(providerDispatch[provider]!.program, model);
    // A proved empty parameter set allows Python's provider-hint fallback.
    return result === null ? null : result === true;
  }
  return Object.hasOwn(providerDefaults, provider) && providerDefaults[provider]!.supported;
}

export function supportsOpenAIPromptCacheKey(profile: LLMProfile, metadata?: PromptCacheMetadata): boolean {
  if (profile.supportsPromptCacheKey !== undefined) return profile.supportsPromptCacheKey;
  if (metadata?.supportsPromptCacheKey !== undefined) return metadata.supportsPromptCacheKey;
  let model = profile.model.trim().toLowerCase().replace(/^(?:litellm_proxy|openhands)\//u, '').replace(/^(?:prod|dev|staging|test)\//u, '');
  if (!model) return false;
  if (model === 'kimi-k3') model = 'moonshot/kimi-k3';
  if (Object.hasOwn(PROMPT_CACHE_KEY_UNHINTED, model)) return PROMPT_CACHE_KEY_UNHINTED[model]!;
  if (cacheKeyModels.has(normalizeOpenAIModelName(model))) return true;
  // Exact registry evidence wins over generated routing generalizations.
  const routedProvider = routingRules.find(rule => rule.pattern.test(model))?.provider;
  if (routedProvider) return providerCacheResolution(routedProvider, model) === true;
  const prefix = model.includes('/') ? model.split('/')[0]! : undefined;
  if (prefix && Object.hasOwn(resolvedPrefixes, prefix)) {
    const resolution = providerCacheResolution(prefix, prefix === 'bedrock' ? model : model.slice(prefix.length + 1));
    if (resolution !== null) return resolution;
  }
  const provider = metadata?.servingProvider?.trim().toLowerCase();
  if (!provider || provider === 'litellm_proxy' || provider === 'openhands') return false;
  const hinted = Object.hasOwn(PROMPT_CACHE_KEY_HINTED, provider) ? PROMPT_CACHE_KEY_HINTED[provider] : undefined;
  if (hinted && Object.hasOwn(hinted, model)) return hinted[model]!;
  // Defaults require structural evidence from the locked handler; no provider allowlist.
  return providerCacheResolution(provider, model) === true;
}

export function resolveOpenAIPromptCacheKey(profile: LLMProfile, contextKey?: string | null, metadata?: PromptCacheMetadata): string | undefined {
  if (!supportsOpenAIPromptCacheKey(profile, metadata)) return undefined;
  return contextKey || profile.promptCacheKey || undefined;
}


export function hasExtendedThinking(profile: LLMProfile): boolean {
  return profile.reasoningEffort !== null;
}

// Reasoning models emit a hidden reasoning/thinking segment alongside the answer,
// and some of them (DeepSeek dual-mode, Moonshot Kimi thinking, MiniMax-M2, ...)
// REQUIRE that segment to be echoed back on the next turn or the provider rejects
// the request (HTTP 400: "reasoning_content ... must be passed back"). See
// `isReasoningModel` for how we decide to send `reasoning_content` / `thinking_blocks`.
//
// NOTE: the Python SDK models this as an explicit per-model `send_reasoning_content`
// feature flag (SEND_REASONING_CONTENT_MODELS). We deliberately renamed it to a
// single `isReasoningModel` predicate: if a model reasons, we echo its reasoning by
// default rather than maintaining a separate "should we send it back" flag. Keep this
// list broader than the Python one on purpose.
const REASONING_MODELS = [
  'deepseek-reasoner',
  'deepseek-r1',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v4.1-flash',
  'kimi-k2-thinking',
  'kimi-k2.5',
  'kimi-k2.6',
  'kimi-k3',
  'minimax-m2',
  'glm-4.6',
  'qwen3',
  'qwq',
] as const;

/**
 * Whether the profile's model produces reasoning/thinking content that must be
 * threaded back to the provider on subsequent turns.
 *
 * Substring match, so an optional provider-qualified id (`deepseek/deepseek-v4-flash`)
 * resolves the same as the bare model name (`deepseek-v4-flash`).
 */
export function isReasoningModel(profile: LLMProfile): boolean {
  const model = profile.model.trim().toLowerCase();
  return REASONING_MODELS.some((candidate) => model.includes(candidate));
}

export function isAnthropicModel(profile: LLMProfile): boolean {
  if (profile.providerId === 'anthropic') {
    return true;
  }
  const model = profile.model.trim().toLowerCase();
  if (model.startsWith('anthropic/') || model.includes('claude')) {
    return true;
  }
  return profile.baseUrl?.toLowerCase().includes('anthropic.com') === true;
}

export function supportsThinkingBlocks(profile: LLMProfile): boolean {
  return isAnthropicModel(profile) && hasExtendedThinking(profile);
}

export function supportsPromptCaching(profile: LLMProfile): boolean {
  if (!isAnthropicModel(profile)) {
    return false;
  }
  const model = profile.model.trim().toLowerCase();
  return PROMPT_CACHE_MODELS.some((needle) => model.includes(needle));
}

export function getAnthropicThinkingBudget(profile: LLMProfile, maxTokens: number): number | undefined {
  if (!supportsThinkingBlocks(profile)) {
    return undefined;
  }
  if (maxTokens <= ANTHROPIC_THINKING_MIN_BUDGET) {
    throw new Error(
      `Anthropic extended thinking requires maxOutputTokens greater than ${ANTHROPIC_THINKING_MIN_BUDGET}; got ${maxTokens}.`,
    );
  }

  const targetBudget = Math.floor(maxTokens * 0.8);
  return Math.min(ANTHROPIC_THINKING_MAX_BUDGET, maxTokens - 1, Math.max(ANTHROPIC_THINKING_MIN_BUDGET, targetBudget));
}

export function normalizeGenerationParamsForModel(profile: LLMProfile): LLMProfile {
  if (isGpt5Model(profile.model)) {
    return { ...profile, temperature: null };
  }
  if (supportsThinkingBlocks(profile)) {
    return { ...profile, temperature: 1 };
  }
  return profile;
}

export function toGeminiThinkingLevel(reasoningEffort: ReasoningEffort | null): 'LOW' | 'MEDIUM' | 'HIGH' | undefined {
  if (reasoningEffort === null) {
    return undefined;
  }
  switch (reasoningEffort) {
    case 'low':
      return 'LOW';
    case 'medium':
      return 'MEDIUM';
    case 'high':
      return 'HIGH';
  }
}
