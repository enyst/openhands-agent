// PORT: bd33d63 call-context isolation and 7401022 provider cache-key support.
import { describe, expect, it } from 'vitest';
import { LLMCallContext, withLLMCallContext } from '../call-context.js';
import { AnthropicMessagesClient } from '../anthropic.js';
import { GeminiClient } from '../gemini.js';
import { OpenAIChatClient, OpenAIResponsesClient, buildChatCompletionsBody, buildOpenAIResponsesBody } from '../openai.js';
import { llmProfileSchema } from '../index.js';
import type { FetchLike } from '../client.js';

const context = new LLMCallContext({ sessionId: 'conversation-one', promptCacheKey: 'cache-one' });
const successes = {
  chat: { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] },
  responses: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] },
  anthropic: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
  gemini: { id: 'interaction', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }] }] },
};

describe('provider call context projection', () => {
  it.each(['chat', 'responses', 'anthropic', 'gemini'] as const)('projects context through %s without mutating profile headers', async kind => {
    const headers = { 'X-LiteLLM-Session-ID': 'stale', 'x-other': 'preserved' };
    const profile = llmProfileSchema.parse({ profileId: 'test', providerId: kind === 'chat' || kind === 'responses' ? 'openai' : kind,
      model: kind === 'chat' || kind === 'responses' ? 'gpt-4o' : kind === 'anthropic' ? 'claude-sonnet-4-5' : 'gemini-2.5-pro', headers });
    const calls: { headers: Readonly<Record<string, string>>; body: Record<string, unknown> }[] = [];
    const fetch: FetchLike = async (_url, init) => {
      calls.push({ headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => successes[kind], text: async () => '' };
    };
    const client = kind === 'chat' ? new OpenAIChatClient(profile, 'test-key', fetch)
      : kind === 'responses' ? new OpenAIResponsesClient(profile, 'test-key', fetch)
        : kind === 'anthropic' ? new AnthropicMessagesClient(profile, 'test-key', fetch)
          : new GeminiClient(profile, 'test-key', fetch);
    await client.complete([], undefined, { callContext: context });
    const sessionHeaders = Object.entries(calls[0]!.headers).filter(([name]) => name.toLowerCase() === 'x-litellm-session-id');
    expect(sessionHeaders).toEqual([['x-litellm-session-id', 'conversation-one']]);
    expect(calls[0]!.headers['x-other']).toBe('preserved');
    expect(profile.headers).toEqual(headers);
    if (kind === 'chat' || kind === 'responses') expect(calls[0]!.body.prompt_cache_key).toBe('cache-one');
    else expect(calls[0]!.body).not.toHaveProperty('prompt_cache_key');
  });

  it.each([buildChatCompletionsBody, buildOpenAIResponsesBody])('keeps cache key support independent from retention', build => {
    const profile = llmProfileSchema.parse({ profileId: 'test', providerId: 'openai', model: 'gpt-4o', promptCacheKey: 'profile-key' });
    expect(build(profile, [], [], context)).toMatchObject({ prompt_cache_key: 'cache-one' });
    expect(build(profile, [])).toMatchObject({ prompt_cache_key: 'profile-key' });
    expect(build(profile, [], [], context)).not.toHaveProperty('prompt_cache_retention');
  });

  it.each(['claude-opus-4-5-20251101', 'gemini/gemini-2.5-pro', 'prod/my-unknown-alias'])('omits unsupported proxy cache key for %s', model => {
    const profile = llmProfileSchema.parse({ profileId: 'test', providerId: 'litellm_proxy', model });
    expect(buildChatCompletionsBody(profile, [], [], context)).not.toHaveProperty('prompt_cache_key');
  });

  it('honors explicit cache capability overrides for aliases and known models', () => {
    const enabled = llmProfileSchema.parse({ profileId: 'test', providerId: 'litellm_proxy', model: 'prod/my-openai-alias', supportsPromptCacheKey: true });
    const disabled = llmProfileSchema.parse({ profileId: 'test', providerId: 'openai', model: 'gpt-4o', supportsPromptCacheKey: false });
    expect(buildChatCompletionsBody(enabled, [], [], context).prompt_cache_key).toBe('cache-one');
    expect(buildChatCompletionsBody(disabled, [], [], context)).not.toHaveProperty('prompt_cache_key');
  });

  it('applies a key to subscription Responses without retention', () => {
    const profile = llmProfileSchema.parse({ profileId: 'test', providerId: 'openai', model: 'gpt-5.6', authType: 'subscription' });
    const body = buildOpenAIResponsesBody(profile, [], [], context);
    expect(body.prompt_cache_key).toBe('cache-one');
    expect(body).not.toHaveProperty('prompt_cache_retention');
  });

  it.each(['openai/gpt-4o', 'litellm_proxy/prod/openai/gpt-5.2', 'openhands/dev/gpt-6-sol'])('resolves pinned known model capability for %s', model => {
    const profile = llmProfileSchema.parse({ profileId: 'test', providerId: 'litellm_proxy', model });
    expect(buildChatCompletionsBody(profile, [], [], context).prompt_cache_key).toBe('cache-one');
  });

  it('isolates concurrent requests through one client and leaves standalone calls unscoped', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'test', providerId: 'openai', model: 'gpt-4o' });
    const calls: Parameters<FetchLike>[1][] = [];
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const fetch: FetchLike = async (_url, init) => {
      calls.push(init);
      if (calls.length === 1) await barrier;
      else release();
      return { ok: true, status: 200, json: async () => successes.chat, text: async () => '' };
    };
    const client = new OpenAIChatClient(profile, 'test-key', fetch);
    await Promise.all(['one', 'two'].map(id => withLLMCallContext(LLMCallContext.forConversation(id), () => client.complete([]))));
    await client.complete([]);
    expect(calls.map(call => call.headers['x-litellm-session-id'])).toEqual(['one', 'two', undefined]);
    expect(calls.map(call => JSON.parse(call.body).prompt_cache_key)).toEqual(['one', 'two', undefined]);
  });
});
