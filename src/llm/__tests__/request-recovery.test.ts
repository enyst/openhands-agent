// PORT: 1612a78e refresh-on-auth-failure, d62d87e transient HTTP/budget handling.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemorySecretStore, llmProviderSecretRef } from '../../secrets/index.js';
import { createClientFromProfile } from '../factory.js';
import { llmProfileSchema } from '../index.js';
import { LLMCallContext } from '../call-context.js';
import type { FetchLike } from '../client.js';
import type { CreateLlmClientOptions } from '../openai.js';
import { OpenAIChatClient, OpenAIResponsesClient } from '../openai.js';
import type { OpenAISubscriptionAuth } from '../auth/index.js';

afterEach(() => vi.useRealTimers());

type Kind = 'chat' | 'responses' | 'anthropic' | 'gemini';
const kinds: Kind[] = ['chat', 'responses', 'anthropic', 'gemini'];
const retry = { maxAttempts: 3, minWaitMs: 0, maxWaitMs: 0, multiplierMs: 0 };
const context = new LLMCallContext({ sessionId: 'session', promptCacheKey: 'cache' });
const success = (kind: Kind) => kind === 'chat'
  ? { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'recovered' } }] }
  : kind === 'responses' ? { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'recovered' }] }] }
    : kind === 'anthropic' ? { role: 'assistant', content: [{ type: 'text', text: 'recovered' }], usage: { input_tokens: 1, output_tokens: 1 } }
      : { id: 'interaction', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'recovered' }] }] };
const response = (status: number, body: unknown) => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) });
const authName = (kind: Kind) => kind === 'anthropic' ? 'x-api-key' : kind === 'gemini' ? 'x-goog-api-key' : 'authorization';
async function fixture(kind: Kind, fetch: FetchLike, options: Omit<CreateLlmClientOptions, 'fetch'> = {}) {
  const providerId = kind === 'chat' || kind === 'responses' ? 'openai' : kind;
  const profile = llmProfileSchema.parse({ profileId: 'recovery', providerId, model: providerId === 'openai' ? 'gpt-4o' : providerId === 'anthropic' ? 'claude-sonnet-4-5' : 'gemini-2.5-pro', openAiApiMode: kind === 'responses' ? 'responses' : 'chat_completions' });
  const store = new InMemorySecretStore([[llmProviderSecretRef(providerId), 'stale-key']]);
  return { profile, store, client: await createClientFromProfile(profile, store, { fetch, retry, ...options }) };
}

describe.each(kinds)('%s credential recovery', kind => {
  it.each([401, 403])('retains typed HTTP %s authentication precedence over quota text', async status => {
    for (const code of ['insufficient_quota', 'usage_limit_reached']) {
      for (const rejectedAgain of [false, true]) {
        const denial = response(status, { error: { code, message: 'private-auth-detail' } });
        const fetch = vi.fn<FetchLike>().mockResolvedValueOnce(denial).mockResolvedValue(rejectedAgain ? denial : response(200, success(kind)));
        const hook = vi.fn(() => 'fresh-key');
        const { client } = await fixture(kind, fetch, { apiKeyRefreshHook: hook });
        const result = await client.complete([]).catch(error => error);
        if (rejectedAgain) {
          expect(result.name).toBe('LLMAuthenticationError');
          expect(String(result)).not.toContain('private-auth-detail');
        } else expect(result.message.content).toEqual([{ type: 'text', text: 'recovered', cache_prompt: false }]);
        expect(hook).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(2);
      }
    }
  });

  it('re-resolves a rejected key once and retains call context without persisting it', async () => {
    const calls: Parameters<FetchLike>[1][] = [];
    const hook = vi.fn(async () => 'fresh-key');
    const { client, profile, store } = await fixture(kind, async (_url, init) => {
      calls.push(init);
      return calls.length === 1 ? response(401, { error: { message: 'private-key-rejected', code: 'token_not_found_in_db' } }) : response(200, success(kind));
    }, { apiKeyRefreshHook: hook });
    expect((await client.complete([], undefined, { callContext: context })).message.content).toEqual([{ type: 'text', text: 'recovered', cache_prompt: false }]);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers[authName(kind)]).toBe(kind === 'chat' || kind === 'responses' ? 'Bearer fresh-key' : 'fresh-key');
    expect(calls[0]!.body).toBe(calls[1]!.body);
    expect(calls.map(call => call.headers['x-litellm-session-id'])).toEqual(['session', 'session']);
    expect(JSON.stringify(profile)).not.toMatch(/fresh-key|stale-key|RefreshHook/);
    expect(await store.get(llmProviderSecretRef(profile.providerId))).toBe('stale-key');
  });

  it('never refreshes twice when the new key is also rejected', async () => {
    const fetch = vi.fn(async () => response(401, { error: { message: 'private-provider-detail' } }));
    const hook = vi.fn(() => 'fresh-key');
    const { client } = await fixture(kind, fetch, { apiKeyRefreshHook: hook });
    const error = await client.complete([]).catch(error => error);
    expect(error.name).toBe('LLMAuthenticationError');
    expect(String(error)).not.toContain('private-provider-detail');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, '', 'stale-key', 'throws'] as const)('does not retry with unavailable refresh result %s', async result => {
    const fetch = vi.fn(async () => response(401, { error: { message: 'rejected' } }));
    const hook = result === undefined ? undefined : vi.fn(() => { if (result === 'throws') throw new Error('hook-private-detail'); return result; });
    const { client } = await fixture(kind, fetch, { apiKeyRefreshHook: hook });
    const error = await client.complete([]).catch(error => error);
    expect(error.name).toBe('LLMAuthenticationError');
    expect(String(error)).not.toContain('hook-private-detail');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe.each(kinds)('%s bounded provider retries', kind => {
  it.each([408, 409, 429, 500, 502, 520, 522, 524, 599])('retries transient HTTP %s on the same model', async status => {
    const fetch = vi.fn<FetchLike>().mockResolvedValueOnce(response(status, { error: { message: 'temporary failure' } })).mockResolvedValueOnce(response(200, success(kind)));
    const hook = vi.fn(() => 'fresh-key');
    const { client } = await fixture(kind, fetch, { apiKeyRefreshHook: hook });
    await client.complete([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![0]).toBe(fetch.mock.calls[1]![0]);
    expect(fetch.mock.calls[0]![1].body).toBe(fetch.mock.calls[1]![1].body);
    expect(hook).not.toHaveBeenCalled();
  });

  it.each([402, 403, 405, 406, 410])('does not retry HTTP %s', async status => {
    const fetch = vi.fn(async () => response(status, { error: { message: 'permanent failure' } }));
    const { client } = await fixture(kind, fetch);
    await expect(client.complete([])).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['budget_exceeded', 'usage_limit_reached', 'insufficient_quota'])('does not retry exhausted allowance %s', async code => {
    const fetch = vi.fn(async () => response(429, { error: { code, message: 'private-team-or-key' } }));
    const { client } = await fixture(kind, fetch);
    const error = await client.complete([]).catch(error => error);
    expect(error.name).toBe(code === 'budget_exceeded' ? 'LLMBudgetExceededError' : 'LLMRateLimitError');
    expect(String(error)).not.toContain('private-team-or-key');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([400, 500, 503])('does not retry exhausted allowance surfaced as HTTP %s', async status => {
    for (const code of ['usage_limit_reached', 'insufficient_quota']) {
      const fetch = vi.fn(async () => response(status, { error: { code, message: 'private-team-or-key' } }));
      const hook = vi.fn(() => 'replacement');
      const { client } = await fixture(kind, fetch, { apiKeyRefreshHook: hook });
      const error = await client.complete([]).catch(error => error);
      expect(error.name).toBe('LLMRateLimitError');
      expect(String(error)).not.toContain('private-team-or-key');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(hook).not.toHaveBeenCalled();
    }
  });

  it('retries HTTP 503 budget text without treating it as a typed budget denial', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValueOnce(response(503, { error: { code: 'budget_exceeded' } })).mockResolvedValueOnce(response(200, success(kind)));
    const { client } = await fixture(kind, fetch);
    await client.complete([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops at the configured attempt budget', async () => {
    const fetch = vi.fn(async () => response(503, { error: { message: 'temporary' } }));
    const { client } = await fixture(kind, fetch);
    await expect(client.complete([])).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe('retry lifecycle boundaries', () => {
  it.each(['APIError', 'APIConnectionError'])('keeps exhausted allowances terminal through injected %s wrappers', async name => {
    for (const marker of ['insufficient_quota', 'usage_limit_reached']) {
      const transportError = Object.assign(new Error(marker), { name, status_code: 503 });
      const fetch = vi.fn<FetchLike>().mockRejectedValue(transportError);
      const { client } = await fixture('chat', fetch);
      const error = await client.complete([]).catch(error => error);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(error.name).toBe('LLMRateLimitError');
    }
  });

  it.each(['APIError', 'APIConnectionError'])('does not infer a budget denial from generic %s text', async name => {
    const error = Object.assign(new Error('budget_exceeded'), { name, status_code: 503 });
    const fetch = vi.fn<FetchLike>().mockRejectedValueOnce(error).mockResolvedValueOnce(response(200, success('chat')));
    const { client } = await fixture('chat', fetch);
    await client.complete([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a directly typed BudgetExceededError', async () => {
    const fetch = vi.fn<FetchLike>().mockRejectedValue(Object.assign(new Error('private detail'), { name: 'BudgetExceededError' }));
    const { client } = await fixture('chat', fetch);
    await expect(client.complete([])).rejects.toMatchObject({ name: 'LLMBudgetExceededError' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('defaults to five total attempts with bounded exponential backoff', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => response(503, { error: { message: 'temporary' } }));
    const { client } = await fixture('chat', fetch, { retry: undefined });
    const pending = client.complete([]).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const [index, delay] of [8000, 16000, 32000, 64000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetch).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(index + 2);
    }
    expect(await pending).toMatchObject({ name: 'LLMHttpError', statusCode: 503 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['APIError', 'APIConnectionError', 'TimeoutError', 'TypeError'])('retries a native transport %s before response consumption', async name => {
    const error = name === 'TypeError' ? new TypeError('fetch failed') : Object.assign(new Error('private-transport-error'), { name, status_code: 522 });
    const fetch = vi.fn<FetchLike>().mockRejectedValueOnce(error).mockResolvedValueOnce(response(200, success('chat')));
    const { client } = await fixture('chat', fetch);
    await client.complete([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry an application failure or caller abort', async () => {
    for (const error of [new Error('application failure'), Object.assign(new Error('abort'), { name: 'AbortError' })]) {
      const fetch = vi.fn<FetchLike>().mockRejectedValue(error);
      const { client } = await fixture('chat', fetch);
      await expect(client.complete([])).rejects.toBe(error);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('does not replay a received response when JSON parsing fails', async () => {
    const fetch = vi.fn(async () => ({ ...response(200, null), json: async () => { throw new TypeError('fetch failed while consuming body'); } }));
    const { client } = await fixture('chat', fetch);
    await expect(client.complete([])).rejects.toThrow('consuming body');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('replaces case-insensitive stale credential headers only on the refresh attempt', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'test', providerId: 'openai', model: 'gpt-4o', headers: { Authorization: 'Bearer stale-header', 'x-other': 'preserved' } });
    const fetch = vi.fn<FetchLike>().mockResolvedValueOnce(response(401, {})).mockResolvedValueOnce(response(200, success('chat')));
    const client = new OpenAIChatClient(profile, 'stale-key', fetch, undefined, { apiKeyRefreshHook: () => 'fresh-key', retry });
    await client.complete([]);
    const headers = fetch.mock.calls[1]![1].headers;
    expect(Object.entries(headers).filter(([name]) => name.toLowerCase() === 'authorization')).toEqual([['authorization', 'Bearer fresh-key']]);
    expect(headers['x-other']).toBe('preserved');
    expect(profile.headers.Authorization).toBe('Bearer stale-header');
  });

  it('does not invoke API-key refresh for subscription credentials', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'subscription', providerId: 'openai', model: 'gpt-5.6', authType: 'subscription' });
    const auth = { refreshIfNeeded: async () => ({ access_token: 'subscription-token' }), extractChatGPTAccountId: async () => null } as unknown as OpenAISubscriptionAuth;
    const fetch = vi.fn(async () => response(401, { error: { message: 'private-auth-detail' } }));
    const hook = vi.fn(() => 'api-key');
    const client = new OpenAIResponsesClient(profile, '', fetch, auth, undefined, { apiKeyRefreshHook: hook, retry });
    await expect(client.complete([])).rejects.toMatchObject({ name: 'LLMAuthenticationError' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(hook).not.toHaveBeenCalled();
  });

  it('never replays a partially consumed subscription stream', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'subscription', providerId: 'openai', model: 'gpt-5.6', authType: 'subscription' });
    const auth = { refreshIfNeeded: async () => ({ access_token: 'subscription-token' }), extractChatGPTAccountId: async () => null } as unknown as OpenAISubscriptionAuth;
    const fetch = vi.fn(async () => ({ ...response(200, null), text: async () => 'data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: {"type":"error","code":"rate_limit_exceeded","message":"private-detail"}\n\n' }));
    const client = new OpenAIResponsesClient(profile, '', fetch, auth, undefined, { retry });
    await expect(client.complete([])).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
