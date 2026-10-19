import { describe, expect, it } from 'vitest';

import { InMemorySecretStore, llmProviderSecretRef } from '../../secrets/index.js';
import { AnthropicMessagesClient } from '../anthropic.js';
import { GeminiClient } from '../gemini.js';
import { llmProfileSchema, textContent } from '../index.js';
import { OpenAIChatClient, OpenAIResponsesClient } from '../openai.js';
import { createClientFromProfile, detectProviderFromBaseUrl, resolveProviderFromProfile } from '../factory.js';
import { createLlmUsageEvent, llmHistoryOrigin } from '../metrics.js';
import { latestReportedInputTokens } from '../reported-input.js';
import { historyForProfile } from '../history.js';
import { messageEventSchema } from '../../event/index.js';

interface FakeFetchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

describe('createClientFromProfile', () => {
  it.each(['claude-sonnet-4-5', 'gpt-6-sol'])('restores native signed history with the historical omitted-mode default (%s)', async model => {
    const configured = llmProfileSchema.parse({ profileId: 'same', providerId: 'anthropic', model });
    const oldProfile = { ...configured, openAiApiMode: 'chat_completions' as const };
    const reply = messageEventSchema.parse({ source: 'agent', llm_response_id: 'saved', llm_message: {
      role: 'assistant', content: 'saved reply', thinking_blocks: [{ type: 'thinking', thinking: 'thought', signature: 'signed' }],
    } });
    const usage = createLlmUsageEvent(oldProfile, { usage: null, responseId: 'saved' }, { startedAt: 0, completedAt: 1 });
    const saved = JSON.parse(JSON.stringify([usage, reply])) as [typeof usage, typeof reply];
    const store = new InMemorySecretStore([[llmProviderSecretRef('anthropic'), 'test-key']]);
    const client = await createClientFromProfile(configured, store);
    expect(historyForProfile([saved[1]], saved, client.profile)).toEqual([reply]);
    expect(llmHistoryOrigin(configured)).toBe(llmHistoryOrigin(oldProfile));
  });

  it('binds directly constructed clients with omitted modes to their actual transport', () => {
    const profile = llmProfileSchema.parse({ profileId: 'direct', providerId: 'openai', model: 'gpt-6-sol' });
    expect(llmHistoryOrigin(new OpenAIChatClient(profile, 'test').profile)).toBe(llmHistoryOrigin({ ...profile, openAiApiMode: 'chat_completions' }));
    expect(llmHistoryOrigin(new OpenAIResponsesClient(profile, 'test').profile)).toBe(llmHistoryOrigin({ ...profile, openAiApiMode: 'responses' }));
  });

  it.each([
    ['gpt-4o', 'chat_completions'], ['gpt-6-sol', 'responses'],
  ] as const)('keeps configured and effective %s history bindings identical', async (model, mode) => {
    const configured = llmProfileSchema.parse({ profileId: 'history', providerId: 'openai', model });
    const store = new InMemorySecretStore([[llmProviderSecretRef('openai'), 'test-key']]);
    const client = await createClientFromProfile(configured, store);
    const persisted = llmProfileSchema.parse({ ...configured, openAiApiMode: mode });
    expect(llmHistoryOrigin(configured)).toBe(llmHistoryOrigin(client.profile));
    expect(llmHistoryOrigin(configured)).toBe(llmHistoryOrigin(persisted));
    const event = createLlmUsageEvent(client.profile, { usage: { promptTokens: 750 }, responseId: 'response' }, { startedAt: 0, completedAt: 1, requestSucceeded: true });
    expect(latestReportedInputTokens([event], configured)).toBe(750);
    expect(llmHistoryOrigin({ ...configured, openAiApiMode: mode === 'responses' ? 'chat_completions' : 'responses' })).not.toBe(llmHistoryOrigin(configured));
  });

  // PORT: upstream 3f47426e GPT-6 family transport default.
  it.each(['gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'openai/gpt-6-sol', 'litellm_proxy/gpt-6-luna', 'GPT-6.1-SOL'])(
    'uses Responses for an omitted mode on %s while honoring explicit chat', async model => {
      const store = new InMemorySecretStore([[llmProviderSecretRef('openai'), 'test-key']]);
      const input = { profileId: 'gpt6', providerId: 'openai', model };
      expect(await createClientFromProfile(llmProfileSchema.parse(input), store)).toBeInstanceOf(OpenAIResponsesClient);
      expect(await createClientFromProfile(llmProfileSchema.parse({ ...input, openAiApiMode: 'chat_completions' }), store)).toBeInstanceOf(OpenAIChatClient);
    },
  );

  it('routes Anthropic profiles to the Anthropic Messages client', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'anthropic', providerId: 'anthropic', model: 'claude-sonnet-4-5' });
    const store = new InMemorySecretStore([[llmProviderSecretRef('anthropic'), 'anthropic-key']]);
    const calls: FakeFetchCall[] = [];

    const client = await createClientFromProfile(profile, store, { fetch: fakeFetch('anthropic', calls) });
    const response = await client.complete([{ role: 'user', content: [textContent('ping')] }]);

    expect(client).toBeInstanceOf(AnthropicMessagesClient);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]?.headers['x-api-key']).toBe('anthropic-key');
    expect(response.message.content).toEqual([textContent('anthropic pong')]);
  });

  it('routes Gemini profiles to the Gemini client', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'gemini', providerId: 'gemini', model: 'gemini-3.5-flash' });
    const store = new InMemorySecretStore([[llmProviderSecretRef('gemini'), 'gemini-key']]);
    const calls: FakeFetchCall[] = [];

    const client = await createClientFromProfile(profile, store, { fetch: fakeFetch('gemini', calls) });
    const response = await client.complete([{ role: 'user', content: [textContent('ping')] }]);

    expect(client).toBeInstanceOf(GeminiClient);
    expect(calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(calls[0]?.body).toMatchObject({ model: 'gemini-3.5-flash', store: false });
    expect(calls[0]?.headers['x-goog-api-key']).toBe('gemini-key');
    expect(response.message.content).toEqual([textContent('gemini pong')]);
  });

  it('routes Responses-mode OpenAI-compatible profiles to the Responses client', async () => {
    const profile = llmProfileSchema.parse({
      profileId: 'responses',
      providerId: 'openai',
      model: 'gpt-5-mini',
      openAiApiMode: 'responses',
    });
    const store = new InMemorySecretStore([[llmProviderSecretRef('openai'), 'openai-key']]);
    const calls: FakeFetchCall[] = [];

    const client = await createClientFromProfile(profile, store, { fetch: fakeFetch('responses', calls) });
    await client.complete([{ role: 'user', content: [textContent('ping')] }]);

    expect(client).toBeInstanceOf(OpenAIResponsesClient);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]?.body).toMatchObject({ store: false, include: ['reasoning.encrypted_content'] });
  });

  it('routes OpenAI-compatible chat profiles to the chat client', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'chat', providerId: 'openrouter', model: 'openai/gpt-4.1' });
    const store = new InMemorySecretStore([[llmProviderSecretRef('openrouter'), 'openrouter-key']]);
    const calls: FakeFetchCall[] = [];

    const client = await createClientFromProfile(profile, store, { fetch: fakeFetch('chat', calls) });
    await client.complete([{ role: 'user', content: [textContent('ping')] }]);

    expect(client).toBeInstanceOf(OpenAIChatClient);
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('uses baseUrl detection for custom provider IDs while preserving provider-key lookup', async () => {
    const profile = llmProfileSchema.parse({
      profileId: 'custom-anthropic',
      providerId: 'my-anthropic-proxy',
      model: 'claude-sonnet-4-5',
      baseUrl: 'https://api.anthropic.com',
    });
    const store = new InMemorySecretStore([[llmProviderSecretRef('my-anthropic-proxy'), 'custom-key']]);
    const calls: FakeFetchCall[] = [];

    const client = await createClientFromProfile(profile, store, { fetch: fakeFetch('anthropic', calls) });
    await client.complete([{ role: 'user', content: [textContent('ping')] }]);

    expect(resolveProviderFromProfile(profile)).toBe('anthropic');
    expect(client).toBeInstanceOf(AnthropicMessagesClient);
    expect(calls[0]?.headers['x-api-key']).toBe('custom-key');
  });
});

describe('detectProviderFromBaseUrl', () => {
  it.each([
    ['https://api.anthropic.com', 'anthropic'],
    ['https://anthropic.corp.internal', 'anthropic'],
    ['https://generativelanguage.googleapis.com/v1beta', 'gemini'],
    ['https://gemini.local', 'gemini'],
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://openrouter-proxy.example.test', 'openrouter'],
    ['https://llm-proxy.example.test', 'litellm_proxy'],
    [null, 'openai'],
  ] as const)('detects %s as %s', (baseUrl, provider) => {
    expect(detectProviderFromBaseUrl(baseUrl)).toBe(provider);
  });
});

function fakeFetch(kind: 'anthropic' | 'gemini' | 'responses' | 'chat', calls: FakeFetchCall[]) {
  return async (url: string, init: { headers?: HeadersInit; body?: BodyInit | null }) => {
    calls.push({ url, headers: normalizeHeaders(init.headers), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return {
      ok: true,
      status: 200,
      async json() {
        if (kind === 'anthropic') {
          return { role: 'assistant', content: [{ type: 'text', text: 'anthropic pong' }], usage: { input_tokens: 1, output_tokens: 1 } };
        }
        if (kind === 'gemini') {
          return {
            id: 'interaction_1',
            status: 'completed',
            steps: [{ type: 'model_output', content: [{ type: 'text', text: 'gemini pong' }] }],
            usage: { total_input_tokens: 1, total_output_tokens: 1, total_tokens: 2 },
          };
        }
        if (kind === 'responses') {
          return {
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'responses pong' }] }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          };
        }
        return {
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'chat pong' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
      async text() {
        return JSON.stringify(await this.json());
      },
    };
  };
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalized[key.toLowerCase()] = value;
    });
    return normalized;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      normalized[key.toLowerCase()] = value;
    }
    return normalized;
  }
  for (const [key, value] of Object.entries(headers ?? {})) {
    normalized[key.toLowerCase()] = String(value);
  }
  return normalized;
}
