import type { Content, LLMProfile, Message } from './index.js';
import { supportsPromptCaching } from './provider-quirks.js';

export const ANTHROPIC_CACHE_CONTROL = { type: 'ephemeral' } as const;

/** Python LLM._apply_prompt_caching, applied to request copies, never history. */
export function prepareAnthropicPromptCaching(profile: LLMProfile, messages: readonly Message[]): Message[] {
  const enabled = profile.cachingPrompt !== false && profile.authType !== 'subscription' && supportsPromptCaching(profile);
  const prepared = messages.map(message => ({
    ...message,
    content: message.content.map(content => ({ ...content, cache_prompt: enabled && content.cache_prompt && cacheable(content) })),
  }));
  if (!enabled) return prepared;

  const system = prepared[0];
  if (system?.role === 'system') {
    const first = system.content[0];
    if (first && cacheable(first)) first.cache_prompt = true;
    // The second block is conversation-specific context, not the shared prefix.
    const dynamic = system.content[1];
    if (dynamic) dynamic.cache_prompt = false;
  }
  const latest = [...prepared].reverse().find(message => message.role === 'user' || message.role === 'tool');
  const last = latest && [...latest.content].reverse().find(cacheable);
  if (last) last.cache_prompt = true;
  return prepared;
}

function cacheable(content: Content): boolean {
  return content.type === 'text' ? content.text.length > 0 : content.image_urls.length > 0;
}

/** Apply one profile duration to actual wire breakpoints, including lifted tool results. */
export function finalizeAnthropicCacheBreakpoints(profile: LLMProfile, body: Record<string, unknown>): void {
  const system = Array.isArray(body.system) ? body.system as Record<string, unknown>[] : [];
  const messages = Array.isArray(body.messages) ? body.messages as Record<string, unknown>[] : [];
  const blocks = [...system, ...messages.flatMap(message => [
    message, ...(Array.isArray(message.content) ? message.content as Record<string, unknown>[] : []),
  ])];
  const breakpoints = blocks.filter(block => block.cache_control !== undefined);
  if (breakpoints.length > 4) {
    throw new Error('Anthropic prompt caching supports at most 4 cache breakpoints per request.');
  }
  if (profile.anthropicCacheTtl === '1h') {
    for (const block of breakpoints) block.cache_control = { type: 'ephemeral', ttl: '1h' };
  }
}
