// Python cd17bd89: DigitalOcean is an OpenAI-compatible route with a distinct endpoint.
import { describe, expect, it } from 'vitest';
import { InMemorySecretStore, llmProviderSecretRef } from '../../secrets/index.js';
import { createClientFromProfile } from '../factory.js';
import { llmProfileSchema, textContent } from '../index.js';
import { OpenAIChatClient, OpenAIResponsesClient } from '../openai.js';

describe('DigitalOcean compatible transport', () => {
  it.each(['glm-5.3', 'digitalocean/glm-5.3'])('routes %s without changing the saved profile', async model => {
    const profile = llmProfileSchema.parse({ profileId: 'do', providerId: 'digitalocean', model });
    const before = JSON.stringify(profile);
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const client = await createClientFromProfile(profile, new InMemorySecretStore([[llmProviderSecretRef('digitalocean'), 'fixture']]), {
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), text: async () => '' };
      },
    });
    expect(client).toBeInstanceOf(OpenAIChatClient);
    await client.complete([{ role: 'user', content: [textContent('ping')] }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://inference.do-ai.run/v1/chat/completions', body: { model: 'glm-5.3' } });
    expect(JSON.stringify(profile)).toBe(before);
    expect(client.profile.model).toBe(model);
  });

  it('honors explicit base URL and transport even when the URL contains another provider name', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'do', providerId: 'digitalocean', model: 'digitalocean/glm-5.3', baseUrl: 'https://anthropic.fixture.invalid/v1', openAiApiMode: 'responses' });
    let request: { url: string; body: Record<string, unknown> } | undefined;
    const client = await createClientFromProfile(profile, new InMemorySecretStore([[llmProviderSecretRef('digitalocean'), 'fixture']]), { fetch: async (url, init) => {
      request = { url, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> };
      return { ok: true, status: 200, json: async () => ({ output: [] }), text: async () => '' };
    } });
    expect(client).toBeInstanceOf(OpenAIResponsesClient);
    await client.complete([{ role: 'user', content: [] }]);
    expect(request).toMatchObject({ url: 'https://anthropic.fixture.invalid/v1/responses', body: { model: 'glm-5.3' } });
  });
});
