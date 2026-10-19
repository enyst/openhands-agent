// Python 69eb3152: typed Responses projection must retain the observable defaults.
import { describe, expect, it } from 'vitest';
import { llmProfileSchema, messageSchema, textContent } from '../index.js';
import { OpenAIChatClient, OpenAIResponsesClient, buildOpenAIResponsesBody } from '../openai.js';

const profile = llmProfileSchema.parse({ profileId: 'normalization', providerId: 'openai', model: 'gpt-4o', maxInputTokens: 128000 });
async function complete(output: unknown[], counter = { calls: 0 }) {
  const raw = { id: 'response_fixture', output, usage: { input_tokens: 7, output_tokens: 3 } };
  const client = new OpenAIResponsesClient(profile, 'fixture', async () => {
    counter.calls++;
    return { ok: true, status: 200, json: async () => raw, text: async () => JSON.stringify(raw) };
  });
  return { result: await client.complete([{ role: 'user', content: [textContent('ping')] }]), raw, calls: counter.calls };
}

describe('typed Responses normalization', () => {
  it.each([null, {}, { type: 'future_part', text: 42 }, { type: 'output_text', text: 0 }, { type: 'output_text', text: '' }])('ignores unused or empty text part %j', async part => {
    const { result } = await complete([{}, null, { type: 'message', content: [part, { type: 'output_text', text: 'hello' }] }]);
    expect(result.message.content).toEqual([textContent('hello')]);
  });

  it('keeps numeric replay item IDs while using the string call ID', async () => {
    const { result, raw, calls } = await complete([{ type: 'function_call', id: 42, call_id: 'call_1', name: 'foo', arguments: '{}' }]);
    expect(result.message.tool_calls).toEqual([{ id: 'call_1', responses_item_id: '42', name: 'foo', arguments: '{}', origin: 'responses' }]);
    expect(result.raw).toBe(raw);
    expect(result.usage).toMatchObject({ promptTokens: 7, completionTokens: 3 });
    expect(calls).toBe(1);
  });

  it('preserves source optional defaults, fallback call ID and empty reasoning summary', async () => {
    const { result } = await complete([{}, { type: 'message' }, { type: 'function_call', id: 'fc_fallback' }, { type: 'reasoning', summary: [{}] }]);
    expect(result.message.content).toEqual([]);
    expect(result.message.tool_calls).toEqual([{ id: 'fc_fallback', responses_item_id: 'fc_fallback', name: '', arguments: '', origin: 'responses' }]);
    expect(result.message.responses_reasoning_item).toMatchObject({ id: null, summary: [''], content: null });
  });

  it('retains the final reasoning item and replay metadata across durable message parsing', async () => {
    const { result } = await complete([
      { type: 'reasoning', id: 'old', summary: [{ text: 'old' }] },
      { type: 'message', content: [{ type: 'output_text', text: '  Answer  ' }] },
      { type: 'function_call', id: 'fc_item', call_id: 'call_tool', name: 'terminal', arguments: '{}' },
      { type: 'reasoning', id: 'rs_item', summary: [{ text: 'summary' }, {}], content: [{ text: 'reasoning' }], encrypted_content: 'opaque', status: 'completed' },
    ]);
    expect(result.message.content).toEqual([textContent('Answer')]);
    expect(result.message.responses_reasoning_item).toEqual({ id: 'rs_item', summary: ['summary', ''], content: ['reasoning'], encrypted_content: 'opaque', status: 'completed' });
    const restored = messageSchema.parse(JSON.parse(JSON.stringify(result.message)));
    expect(buildOpenAIResponsesBody(profile, [restored]).input).toEqual(buildOpenAIResponsesBody(profile, [result.message]).input);
  });

  it.each([
    { output: [{ type: 'function_call', id: 42, name: 'foo', arguments: '{}' }] },
    { output: [{ type: 'message', content: [{ type: 'output_text', text: 42 }] }] },
    { output: [{ type: 'reasoning', summary: [{ text: 42 }] }] },
  ])('rejects malformed consumed fields without dropping usage or retrying', async ({ output }) => {
    const counter = { calls: 0 };
    await expect(complete(output, counter)).rejects.toMatchObject({ name: 'LLMResponseError', metadata: { usage: { promptTokens: 7, completionTokens: 3 } } });
    expect(counter.calls).toBe(1);
  });

  it('accepts opaque provider metadata without rejecting ordinary Chat text', async () => {
    const raw = { choices: [{ message: { role: 'assistant', content: 'hello', provider_specific_fields: ['extra'] } }] };
    const result = await new OpenAIChatClient(profile, 'fixture', async () => ({ ok: true, status: 200, json: async () => raw, text: async () => '' })).complete([{ role: 'user', content: [] }]);
    expect(result.message.content).toEqual([textContent('hello')]);
    expect(result.raw).toBe(raw);
  });
});
