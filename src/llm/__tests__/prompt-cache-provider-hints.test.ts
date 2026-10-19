// PORT 411beb8c: provider hints recover cache keys without changing unrelated features.
import probes from './fixtures/prompt-cache-provider-probes.json';
import manifest from '../../../transpile/upstream.json';
import { expect, it, vi } from 'vitest';
import { llmProfileSchema } from '../index.js';
import { supportsOpenAIPromptCacheKey } from '../provider-quirks.js';
import { OpenAIChatClient, buildChatCompletionsBody } from '../openai.js';
import type { MetadataFetchLike } from '../context-budget.js';
import { LLMCallContext } from '../call-context.js';

const profile = (model: string, extra: Record<string, unknown> = {}) => llmProfileSchema.parse({ profileId: 'proxy', providerId: 'litellm_proxy', model, promptCacheKey: 'shard', ...extra });
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
it.each([
  ['deepseek-chat', 'deepseek'], ['minimax-m3', 'minimax'], ['qwen3.8-max', 'dashscope'],
  ['kimi-k2.7-code', 'moonshot'], ['kimi-k3', 'moonshot'], ['trinity-large-thinking', 'openrouter'],
])('recovers the pinned %s capability from %s', (model, servingProvider) => {
  expect(supportsOpenAIPromptCacheKey(profile(`openhands/prod/${model}`), { servingProvider })).toBe(true);
});
it('preserves unhinted known negatives, unknown aliases, passthrough rejection and explicit overrides', () => {
  expect(supportsOpenAIPromptCacheKey(profile('deepseek-chat'))).toBe(false);
  for (const servingProvider of ['litellm_proxy', 'openhands', 'openai', ' deepseek ']) {
    expect(supportsOpenAIPromptCacheKey(profile('claude-opus-5-5'), { servingProvider })).toBe(false);
  }
  expect(supportsOpenAIPromptCacheKey(profile('not-in-pinned-registry'))).toBe(false);
  expect(supportsOpenAIPromptCacheKey(profile('deepseek-chat', { supportsPromptCacheKey: false }), { servingProvider: 'deepseek', supportsPromptCacheKey: true })).toBe(false);
  expect(supportsOpenAIPromptCacheKey(profile('claude-opus-5-5', { supportsPromptCacheKey: true }))).toBe(true);
  expect(supportsOpenAIPromptCacheKey(profile('deepseek-chat'), { servingProvider: 'deepseek', supportsPromptCacheKey: false })).toBe(false);
  expect(supportsOpenAIPromptCacheKey(profile('custom-alias'), { supportsPromptCacheKey: true })).toBe(true);
});
it('only changes the cache key when applying a hint to a request', () => {
  const p = profile('deepseek-chat', { temperature: 0.7, topP: 0.8 });
  const before = buildChatCompletionsBody(p, []);
  const after = buildChatCompletionsBody(p, [], [], undefined, { servingProvider: 'deepseek' });
  expect(after).toEqual({ ...before, prompt_cache_key: 'shard' });
  expect(after).not.toHaveProperty('reasoning_effort');
  expect(after).not.toHaveProperty('prompt_cache_retention');
});
it('discovers cache capability even with an explicit context cap; deduplicates and preserves the saved profile', async () => {
  const p = profile('litellm_proxy/deepseek-chat', { baseUrl: 'https://proxy.test/v1', maxInputTokens: 8192 });
  const original = JSON.stringify(p);
  const metadata = vi.fn<MetadataFetchLike>(async () => response({ data: [{ model_name: 'deepseek-chat', model_info: { litellm_provider: 'deepseek', max_input_tokens: 32000 } }] }));
  const calls: Record<string, unknown>[] = [];
  const client = new OpenAIChatClient(p, 'fixture', async (_url, init) => {
    calls.push(JSON.parse(init.body) as Record<string, unknown>);
    return response({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] });
  }, metadata);
  await Promise.all([client.complete([], undefined, { callContext: new LLMCallContext({ promptCacheKey: 'conversation' }) }), client.complete([])]);
  expect(metadata).toHaveBeenCalledTimes(1);
  expect(metadata.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
  expect(calls.map(item => item.prompt_cache_key)).toEqual(['conversation', 'shard']);
  expect(client.effectiveMaxInputTokens).toBe(8192);
  expect(JSON.stringify(p)).toBe(original);
});
it('does not enable an alias whose matching deployments disagree', async () => {
  const p = profile('deepseek-chat', { baseUrl: 'https://proxy.test/v1' });
  const metadata: MetadataFetchLike = async () => response({ data: [
    { model_name: 'deepseek-chat', model_info: { litellm_provider: 'deepseek' } },
    { model_name: 'deepseek-chat', model_info: { litellm_provider: 'anthropic' } },
  ] });
  const client = new OpenAIChatClient(p, 'fixture', async (_url, init) => {
    expect(JSON.parse(init.body)).not.toHaveProperty('prompt_cache_key');
    return response({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] });
  }, metadata);
  await client.complete([]);
});

it.each(['openai', 'deepseek', 'minimax', 'openrouter', 'dashscope', 'moonshot'])('supports an opaque alias via structurally proven %s handler defaults', servingProvider => {
  expect(supportsOpenAIPromptCacheKey(profile('my-deployment'), { servingProvider })).toBe(true);
  // Actual locked LiteLLM routing generalization, not an overbroad claude-* guess.
  expect(supportsOpenAIPromptCacheKey(profile('claude-opus-99'), { servingProvider })).toBe(false);
  expect(supportsOpenAIPromptCacheKey(profile('claude-unreleased'), { servingProvider })).toBe(true);
});

it('matches the pinned opaque-alias and recognized-prefix oracle', () => {
  expect(probes.upstreamCommit).toBe(manifest.commit);
  for (const row of probes.cases) {
    const check = () => supportsOpenAIPromptCacheKey({ ...profile('oracle-placeholder'), model: row.model }, row.provider === null ? undefined : { servingProvider: row.provider });
    if ('expectedError' in row) {
      expect(row.expectedError).toBe('IndexError');
      expect(check, JSON.stringify(row)).toThrow(new RangeError('Invalid Bedrock model normalization.'));
    } else {
      expect(check(), JSON.stringify(row)).toBe(row.expected);
    }
  }
});

it('keeps empty normalized aliases unresolved while honoring explicit overrides', () => {
  for (const model of ['   ', 'openhands/', 'prod/', 'litellm_proxy/', 'openhands/prod/']) {
    expect(supportsOpenAIPromptCacheKey(profile(model), { servingProvider: 'openai' })).toBe(false);
    expect(supportsOpenAIPromptCacheKey(profile(model, { supportsPromptCacheKey: true }), { servingProvider: 'openai' })).toBe(true);
    expect(supportsOpenAIPromptCacheKey(profile(model), { supportsPromptCacheKey: true })).toBe(true);
  }
});
