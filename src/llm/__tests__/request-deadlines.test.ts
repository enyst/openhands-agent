// PORT 656a5c47: per-attempt hard deadlines and per-read streaming idle deadlines.
import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { llmProfileSchema } from '../index.js';
import { OpenAIChatClient, OpenAIResponsesClient } from '../openai.js';
import { AnthropicMessagesClient } from '../anthropic.js';
import { GeminiClient } from '../gemini.js';
import type { OpenAISubscriptionAuth } from '../auth/index.js';
import type { FetchLike, FetchResponseLike } from '../client.js';

const retry = { maxAttempts: 2, minWaitMs: 0, maxWaitMs: 0, multiplierMs: 0 };
const profile = (extra: Record<string, unknown> = {}) => llmProfileSchema.parse({ profileId: 'deadline', providerId: 'openai', model: 'gpt-4o', ...extra });
const chat = { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] };
const completed = 'data: {"type":"response.completed","response":{"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}}\n\n';
const auth = { refreshIfNeeded: async () => ({ access_token: 'fixture' }), extractChatGPTAccountId: async () => null } as unknown as OpenAISubscriptionAuth;
const servers: Server[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); })); });
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  return `http://127.0.0.1:${address.port}`;
}

it('defaults hard timeout to 300, preserves explicit null, and accepts independent zero/null idle', () => {
  expect(profile().timeoutSeconds).toBe(300);
  expect(profile({ timeoutSeconds: null }).timeoutSeconds).toBeNull();
  expect(profile({ timeoutSeconds: 0, streamIdleTimeoutSeconds: null })).toMatchObject({ timeoutSeconds: 0, streamIdleTimeoutSeconds: null });
  expect(profile({ streamIdleTimeoutSeconds: 0 }).streamIdleTimeoutSeconds).toBe(0);
});

it.each(['chat', 'responses', 'anthropic', 'gemini'] as const)('%s bounds a hung successful body inside each attempt', async kind => {
  vi.useFakeTimers();
  const fetch = vi.fn<FetchLike>(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}), text: async () => '' }));
  const p = profile({ timeoutSeconds: 0.02 });
  const client = kind === 'chat' ? new OpenAIChatClient(p, 'fixture', fetch, undefined, { retry })
    : kind === 'responses' ? new OpenAIResponsesClient(p, 'fixture', fetch, undefined, undefined, { retry })
      : kind === 'anthropic' ? new AnthropicMessagesClient(p, 'fixture', fetch, undefined, { retry })
        : new GeminiClient(p, 'fixture', fetch, undefined, { retry });
  let result: unknown;
  void client.complete([]).catch(error => { result = error; });
  await vi.advanceTimersByTimeAsync(45);
  expect(result).toMatchObject({ name: 'LLMTimeoutError', kind: 'hard' });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.every(([, init]) => init.signal?.aborted)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds real HTTP headers and stalled body, retries a fresh attempt, and aborts connections', async () => {
  let calls = 0;
  const baseUrl = await listen(createServer((_req, res) => {
    calls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{');
    // Finite fallback makes the pre-port regression fail without leaving a hung test.
    const timer = setTimeout(() => res.end(JSON.stringify(chat).slice(1)), 150);
    res.on('close', () => clearTimeout(timer));
  }));
  const client = new OpenAIChatClient(profile({ baseUrl, timeoutSeconds: 0.04 }), 'fixture', undefined, undefined, { retry });
  await expect(client.complete([])).rejects.toMatchObject({ name: 'LLMTimeoutError', kind: 'hard' });
  expect(calls).toBe(2);
});

it('retries a real partially received subscription stream only when its idle deadline expires', async () => {
  let calls = 0;
  const url = await listen(createServer((_req, res) => {
    calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
    const timer = setTimeout(() => res.end(completed), 150);
    res.on('close', () => clearTimeout(timer));
  }));
  const fetch: FetchLike = (_url, init) => globalThis.fetch(url, init);
  const client = new OpenAIResponsesClient(profile({ timeoutSeconds: null, streamIdleTimeoutSeconds: 0.04, authType: 'subscription' }), '', fetch, auth, undefined, { retry });
  await expect(client.complete([])).rejects.toMatchObject({ name: 'LLMTimeoutError', kind: 'idle' });
  expect(calls).toBe(2);
});

it('hard deadline caps an active stream and keeps its attribution over the idle timer', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn(async () => {});
  const fetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => null, text: async () => '', body: { getReader: () => ({ cancel,
    read: () => new Promise(resolve => setTimeout(() => resolve({ done: false, value: new TextEncoder().encode('data: {}\n\n') }), 10)),
  }) } });
  const client = new OpenAIResponsesClient(profile({ timeoutSeconds: 0.025, streamIdleTimeoutSeconds: 0.02 }), '', fetch, auth, undefined, { retry: { maxAttempts: 1 } });
  let result: unknown;
  void client.complete([]).catch(error => { result = error; });
  await vi.advanceTimersByTimeAsync(30);
  expect(result).toMatchObject({ name: 'LLMTimeoutError', kind: 'hard' });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('does not relabel or retry transport failures while consuming a stream, and cannot hang on cancel', async () => {
  const failure = Object.assign(new Error('original'), { name: 'TimeoutError' });
  const read = vi.fn(async () => { throw failure; });
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const response: FetchResponseLike = { ok: true, status: 200, json: async () => null, text: async () => '', body: { getReader: () => ({ read, cancel }) } };
  const fetch = vi.fn<FetchLike>(async () => response);
  const client = new OpenAIResponsesClient(profile({ timeoutSeconds: 0.01, streamIdleTimeoutSeconds: null }), '', fetch, auth, undefined, { retry });
  const outcome = await Promise.race([client.complete([]).catch(error => error), new Promise(resolve => setTimeout(() => resolve('still hung'), 100))]);
  expect(outcome).toBe(failure);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('uses timeout as transport policy, never a provider JSON field', async () => {
  const fetch = vi.fn<FetchLike>(async (_url, init) => {
    expect(JSON.parse(init.body)).not.toHaveProperty('timeout');
    return { ok: true, status: 200, json: async () => chat, text: async () => '' };
  });
  await new OpenAIChatClient(profile({ timeoutSeconds: 0.5 }), 'fixture', fetch).complete([]);
});

it.each([undefined, null, 0] as const)('idle setting %s inherits, disables, or expires immediately', async idle => {
  vi.useFakeTimers();
  const cancel = vi.fn(async () => {});
  const fetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => null, text: async () => '', body: { getReader: () => ({ cancel,
    read: () => new Promise(resolve => setTimeout(() => resolve({ done: true, value: new TextEncoder().encode(completed) }), 15)),
  }) } });
  const p = profile({ timeoutSeconds: null, ...(idle === undefined ? {} : { streamIdleTimeoutSeconds: idle }) });
  let result: unknown;
  void new OpenAIResponsesClient(p, '', fetch, auth, undefined, { retry: { maxAttempts: 1 } }).complete([]).then(value => { result = value; }, error => { result = error; });
  await vi.advanceTimersByTimeAsync(20);
  if (idle === 0) expect(result).toMatchObject({ name: 'LLMTimeoutError', kind: 'idle' });
  else expect(result).toHaveProperty('message');
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('clears the hard timer on success and expires zero before starting a request', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn<FetchLike>(async () => ({ ok: true, status: 200, json: async () => chat, text: async () => '' }));
  await new OpenAIChatClient(profile(), 'fixture', fetch).complete([]);
  expect(vi.getTimerCount()).toBe(0);
  const zero = new OpenAIChatClient(profile({ timeoutSeconds: 0 }), 'fixture', fetch, undefined, { retry: { maxAttempts: 1 } });
  await expect(zero.complete([])).rejects.toMatchObject({ name: 'LLMTimeoutError', kind: 'hard' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('exhausted native deadlines put the conversation in ERROR without an endless retry loop', async () => {
  const { Agent } = await import('../../agent/agent.js');
  const { LocalConversation } = await import('../../conversation/local-conversation.js');
  const { conversationExecutionStatus } = await import('../../conversation/state.js');
  const fetch = vi.fn<FetchLike>(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}), text: async () => '' }));
  const client = new OpenAIChatClient(profile({ timeoutSeconds: 0.02 }), 'fixture', fetch, undefined, { retry });
  const conversation = new LocalConversation({ agent: new Agent({ llm: client, tools: [] }), maxIterations: 2 });
  conversation.sendMessage('synthetic timeout');
  await expect(conversation.run()).rejects.toMatchObject({ name: 'LLMTimeoutError' });
  expect(conversation.state.executionStatus).toBe(conversationExecutionStatus.ERROR);
  expect(fetch).toHaveBeenCalledTimes(2);
});
