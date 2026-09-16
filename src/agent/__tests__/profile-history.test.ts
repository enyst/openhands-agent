import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Agent } from '../agent.js';
import { ConversationState } from '../../conversation/state.js';
import { conversationStateUpdateEventSchema, messageEventSchema } from '../../event/index.js';
import { buildAnthropicMessagesBody } from '../../llm/anthropic.js';
import { buildGeminiInteractionsBody } from '../../llm/gemini.js';
import { buildOpenAIResponsesBody } from '../../llm/openai.js';
import { llmProfileSchema, messageSchema, textContent, type LLMProfile, type Message } from '../../llm/index.js';
import { ensureLlmHistoryOrigin, LLM_HISTORY_ORIGIN_KEY } from '../../llm/history.js';
import { createLlmUsageEvent, llmHistoryOrigin } from '../../llm/metrics.js';
import { ToolDefinition } from '../../tool/index.js';

const profiles = [
  llmProfileSchema.parse({ profileId: 'claude', providerId: 'anthropic', model: 'claude-sonnet-4-5', reasoningEffort: 'high' }),
  llmProfileSchema.parse({ profileId: 'gemini', providerId: 'gemini', model: 'gemini-3.6-flash' }),
  llmProfileSchema.parse({ profileId: 'responses', providerId: 'openai', model: 'gpt-5', openAiApiMode: 'responses' }),
];
const lookup = new ToolDefinition({ name: 'lookup', description: 'Look up a value', inputSchema: z.object({}), executor: () => ({ text: 'lookup-result' }) });

function reply(label: string, tool = false): Message {
  return messageSchema.parse({
    role: 'assistant', content: [textContent(`visible-${label}`)], reasoning_content: `plain-${label}`,
    thinking_blocks: [
      { type: 'thinking', thinking: `thought-${label}`, signature: `signed-${label}` },
      { type: 'redacted_thinking', data: `redacted-${label}` },
    ],
    responses_reasoning_item: { id: `reason-${label}`, encrypted_content: `cipher-${label}` },
    ...(tool ? { tool_calls: [{ id: `call-${label}`, name: 'lookup', arguments: '{}', origin: 'completion' }] } : {}),
  });
}

function client(profile: LLMProfile, message: Message) {
  const calls: Message[][] = [];
  return { profile, calls, async complete(input: readonly Message[]) {
    calls.push(structuredClone([...input]));
    // Repeated provider IDs are deliberate: provenance must be resolved in event order.
    return { message, responseId: 'repeated-response-id', usage: null };
  } };
}

function providerBody(profile: LLMProfile, messages: Message[]): unknown {
  if (profile.providerId === 'anthropic') return buildAnthropicMessagesBody(profile, messages);
  if (profile.providerId === 'gemini') return buildGeminiInteractionsBody(profile, messages);
  return buildOpenAIResponsesBody(profile, messages);
}

describe('profile switching preserves history without replaying foreign opaque reasoning', () => {
  it.each(profiles)('normalizes outgoing $providerId history while retaining native same-profile continuation', async (profile) => {
    const state = new ConversationState({ events: [messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: 'question' } })] });
    const first = client(profile, reply('first', true));
    await new Agent({ llm: first, tools: [lookup] }).step(state);
    const originalEvents = structuredClone(state.events);
    const secondProfile = { ...profile, profileId: `${profile.profileId}-other` };
    const second = client(secondProfile, reply('second'));
    const secondAgent = new Agent({ llm: second });
    await secondAgent.step(state);
    await secondAgent.step(state);

    const foreign = second.calls[0]!.find(message => message.role === 'assistant')!;
    expect(foreign.content).toEqual(reply('first').content);
    expect(foreign.reasoning_content).toBe('plain-first');
    expect(foreign.tool_calls).toEqual(reply('first', true).tool_calls);
    expect(foreign.thinking_blocks).toEqual([]);
    expect(foreign.responses_reasoning_item).toBeNull();
    expect(second.calls[0]!.find(message => message.role === 'tool')?.content).toEqual([textContent('{"text":"lookup-result"}')]);
    const body = JSON.stringify(providerBody(secondProfile, second.calls[1]!));
    expect(body).not.toContain('signed-first');
    expect(body).not.toContain('redacted-first');
    expect(body).not.toContain('cipher-first');
    expect(body).toContain(profile.providerId === 'openai' ? 'cipher-second' : 'signed-second');

    const restored = new ConversationState({ events: structuredClone(state.events) });
    const returned = client(profile, messageSchema.parse({ role: 'assistant', content: 'back' }));
    await new Agent({ llm: returned }).step(restored);
    const backBody = JSON.stringify(providerBody(profile, returned.calls[0]!));
    expect(backBody).toContain(profile.providerId === 'openai' ? 'cipher-first' : 'signed-first');
    expect(backBody).not.toContain('signed-second');
    expect(backBody).not.toContain('cipher-second');
    expect(state.events.slice(0, originalEvents.length)).toEqual(originalEvents);
    expect(state.stats.coverage.invalid_record_count).toBe(0);
    expect(Object.values(state.stats.usage_to_metrics).flatMap(value => value.records)).toHaveLength(3);
  });

  it.each([
    { model: 'other-model' }, { providerId: 'another-provider' }, { baseUrl: 'https://other.example.test/v1' },
    { openAiApiMode: 'chat_completions' as const }, { authType: 'subscription' as const, subscriptionVendor: 'openai' as const },
    { useProfileKeyOverride: true },
  ])('does not reuse opacity after editing binding fields: %j', async (patch) => {
    const profile = profiles[2]!;
    const state = new ConversationState();
    await new Agent({ llm: client(profile, reply('before')) }).step(state);
    const after = client({ ...profile, ...patch }, messageSchema.parse({ role: 'assistant', content: 'after' }));
    await new Agent({ llm: after }).step(state);
    expect(after.calls[0]![0]!.thinking_blocks).toEqual([]);
    expect(after.calls[0]![0]!.responses_reasoning_item).toBeNull();
  });

  it('preserves legacy cache until an anchored switch, including after persistence and a switch back', async () => {
    const profile = profiles[0]!;
    const old = messageEventSchema.parse({ source: 'agent', llm_message: reply('legacy') });
    const state = new ConversationState({ events: [old] });
    const unchanged = client(profile, messageSchema.parse({ role: 'assistant', content: 'unchanged' }));
    await new Agent({ llm: unchanged }).step(state);
    expect(unchanged.calls[0]![0]!.thinking_blocks).toEqual(old.llm_message.thinking_blocks);
    expect(state.events.some(event => event.kind === 'ConversationStateUpdateEvent' && event.key === LLM_HISTORY_ORIGIN_KEY)).toBe(false);

    await ensureLlmHistoryOrigin(state, profile);
    await ensureLlmHistoryOrigin(state, { ...profile, model: 'replacement' });
    expect(state.events.filter(event => event.kind === 'ConversationStateUpdateEvent' && event.key === LLM_HISTORY_ORIGIN_KEY)).toHaveLength(1);
    const restored = new ConversationState({ events: structuredClone(state.events) });
    const replacement = client({ ...profile, model: 'replacement' }, messageSchema.parse({ role: 'assistant', content: 'new' }));
    await new Agent({ llm: replacement }).step(restored);
    expect(replacement.calls[0]![0]!.thinking_blocks).toEqual([]);
    expect(replacement.calls[0]![0]!.responses_reasoning_item).toBeNull();
    const original = client(profile, messageSchema.parse({ role: 'assistant', content: 'original' }));
    await new Agent({ llm: original }).step(restored);
    expect(original.calls[0]![0]!.thinking_blocks).toEqual(old.llm_message.thinking_blocks);
    expect(restored.events[0]).toEqual(old);
  });

  it('does not trust unknown opaque events appended after the durable origin anchor', async () => {
    const profile = profiles[0]!;
    const state = new ConversationState();
    await ensureLlmHistoryOrigin(state, profile);
    state.appendEvent(messageEventSchema.parse({ source: 'agent', llm_message: reply('unknown-later') }));
    const recorded = client(profile, messageSchema.parse({ role: 'assistant', content: 'next' }));
    await new Agent({ llm: recorded }).step(state);
    expect(recorded.calls[0]![0]!.thinking_blocks).toEqual([]);
  });

  it('uses partial legacy accounting to reject known mixed-model history', async () => {
    const profile = profiles[0]!;
    const usage = createLlmUsageEvent(profiles[1]!, { responseId: 'legacy-response', usage: null }, { startedAt: 0, completedAt: 1 });
    const oldRecord = { ...usage.value as Record<string, unknown> };
    delete oldRecord.history_origin;
    const oldUsage = conversationStateUpdateEventSchema.parse({ ...usage, value: oldRecord });
    const state = new ConversationState({ events: [oldUsage,
      messageEventSchema.parse({ source: 'agent', llm_response_id: 'legacy-response', llm_message: reply('mixed') }),
    ] });
    const target = client(profile, messageSchema.parse({ role: 'assistant', content: 'next' }));
    await new Agent({ llm: target }).step(state);
    expect(target.calls[0]![0]!.thinking_blocks).toEqual([]);
    expect(state.stats.coverage.invalid_record_count).toBe(0);
  });

  it.each([{ content: '' }, { content: '   ' }, { content: [] }])('omits reasoning-only foreign turns with content $content rather than producing empty native assistant messages', async ({ content }) => {
    const state = new ConversationState();
    await new Agent({ llm: client(profiles[0]!, messageSchema.parse({ ...reply('opaque-only'), content })) }).step(state);
    const target = client(profiles[1]!, messageSchema.parse({ role: 'assistant', content: 'next' }));
    await new Agent({ llm: target }).step(state);
    expect(target.calls[0]!.every(message => message.role !== 'assistant')).toBe(true);
    expect(state.events.some(event => event.kind === 'MessageEvent' && event.llm_message.responses_reasoning_item?.encrypted_content === 'cipher-opaque-only')).toBe(true);
  });

  it.each([
    { content: [{ type: 'image', image_urls: ['data:image/png;base64,AA=='] }], extended_content: [] },
    { content: '', extended_content: [textContent('visible extended content')] },
  ])('retains foreign assistant images and extended content when removing opaque reasoning: %j', async (payload) => {
    const state = new ConversationState();
    await ensureLlmHistoryOrigin(state, profiles[0]!);
    state.appendEvent(messageEventSchema.parse({
      source: 'agent', llm_message: { ...reply('visible'), content: payload.content }, extended_content: payload.extended_content,
    }));
    const target = client(profiles[1]!, messageSchema.parse({ role: 'assistant', content: 'next' }));
    await new Agent({ llm: target }).step(state);
    const retained = target.calls[0]!.find(message => message.role === 'assistant');
    expect(retained).toBeDefined();
    expect(retained!.content.some(item => item.type === 'image' || item.type === 'text' && item.text.trim().length > 0)).toBe(true);
    expect(retained!.thinking_blocks).toEqual([]);
    expect(retained!.responses_reasoning_item).toBeNull();
  });

  it('excludes credentials and incidental generation settings from the origin digest', () => {
    const profile = { ...profiles[0]!, baseUrl: 'https://alice:secret@proxy.example.test/v1?key=secret', headers: { authorization: 'Bearer secret' } };
    expect(llmHistoryOrigin(profile)).toMatch(/^[a-f0-9]{64}$/u);
    expect(llmHistoryOrigin({ ...profile, baseUrl: 'https://bob:different@proxy.example.test/v1?key=different', headers: { authorization: 'Bearer different' }, temperature: 0.1 })).toBe(llmHistoryOrigin(profile));
    expect(llmHistoryOrigin({ ...profile, baseUrl: 'https://proxy.example.test/v2' })).not.toBe(llmHistoryOrigin(profile));
  });
});
