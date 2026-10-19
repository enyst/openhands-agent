import { describe, expect, it, vi } from 'vitest';

import {
  actionEventSchema, agentErrorEventSchema, condensationSummaryEventSchema, eventsToMessages,
  messageEventSchema, observationEventSchema, systemPromptEventSchema, userRejectObservationSchema,
  type LLMConvertibleEvent,
} from '../../event/index.js';
import { llmProfileSchema, messageSchema, textContent, type Message } from '../../llm/index.js';
import type { LLMClient, LLMCompletionOptions, LLMCompletionResponse } from '../../llm/client.js';
import { LLMCallContext } from '../../llm/call-context.js';
import type { ToolDefinition } from '../../tool/index.js';
import { LLMSummarizingCondenser, renderCondenserEvent, View } from '../index.js';
import { ToolCallMatchingProperty } from '../view-properties.js';

const user = (text: string) => messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: [textContent(text)] } });
const system = (text = 'Keep this system prompt') => systemPromptEventSchema.parse({ system_prompt: textContent(text), tools: [] });
const users = (n: number) => Array.from({ length: n }, (_, i) => user(`Event ${i}`));
const action = () => actionEventSchema.parse({ tool_name: 'test_tool', tool_call_id: 'pending', llm_response_id: 'response', action: {},
  tool_call: { id: 'pending', name: 'test_tool', arguments: '{}', origin: 'completion' } });
const observation = (id: string) => observationEventSchema.parse({ tool_name: 'test_tool', tool_call_id: id, action_id: 'action', observation: {} });
const error = (id: string) => agentErrorEventSchema.parse({ tool_name: 'test_tool', tool_call_id: id, error: 'Interrupted' });
const rejection = (id: string) => userRejectObservationSchema.parse({ tool_name: 'test_tool', tool_call_id: id, action_id: 'action', rejection_reason: 'Rejected' });
const profile = llmProfileSchema.parse({ profileId: 'summary', providerId: 'openai', model: 'fixture' });
const response = (): LLMCompletionResponse => ({ message: messageSchema.parse({ role: 'assistant', content: [textContent('Summary')] }) });
const fakeLlm = () => ({ profile, complete: vi.fn(async (_messages: readonly Message[]) => response()) });
const text = (message: Message) => message.content.map(part => part.type === 'text' ? part.text : '').join('');

// PORT: dd8d9f6f tests raw View boundary lookup before property enforcement.
describe('raw View tolerates orphan and duplicate observation-like events', () => {
  it.each([observation, error, rejection])('ignores an orphan without throwing or hiding safe boundaries (%#)', makeResult => {
    const original = [makeResult('orphan'), user('Continue')];
    expect([...new View(original).manipulationIndices]).toEqual([0, 1, 2]);
    expect(View.fromEvents(original).events).toEqual([original[1]]);
  });

  it.each([observation, error, rejection])('does not resolve another pending action (%#)', makeResult => {
    const original = [action(), makeResult('orphan'), observation('pending')];
    expect([...new View(original).manipulationIndices]).toEqual([0, 3]);
    expect([...new ToolCallMatchingProperty().manipulationIndices(original)]).toEqual([0, 3]);
  });

  it('ignores a duplicate result during boundary lookup and retains only its first result on enforcement', () => {
    const original = [action(), observation('pending'), error('pending')];
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { expect([...new View(original).manipulationIndices]).toEqual([0, 2, 3]); }
    finally { warning.mockRestore(); }
    expect(View.fromEvents(original).events).toEqual(original.slice(0, 2));
  });
});

// PORT: d340af22 / a130c8f9 cover the exported APIs, including system events not at index zero.
describe('summarizer preserves the first system prompt and its preceding prefix', () => {
  it('keeps the system first with keepFirst zero under ordinary event pressure', async () => {
    const fixed = system(), original = [fixed, ...users(11)], llm = fakeLlm();
    const c = new LLMSummarizingCondenser({ llm, maxSize: 10, keepFirst: 0 });
    const result = await c.getCondensation(new View(original));
    expect(result.summary_offset).toBe(1);
    expect(result.forgotten_event_ids).toEqual(new Set(original.slice(1, 8).map(event => event.id)));
    const applied = View.fromEvents([...original, result]);
    expect(applied.events[0]).toEqual(fixed);
    expect(eventsToMessages(applied.events)[0]?.role).toBe('system');
  });

  it('preserves through the first system event and rounds its prefix to a safe boundary', async () => {
    const original = [user('Before system'), system(), ...users(10)];
    const view = new View(original);
    Object.defineProperty(view, 'manipulationIndices', { value: { findNext: (at: number) => [0, 3, 8, 12].find(i => i >= at)! } });
    const result = await new LLMSummarizingCondenser({ llm: fakeLlm(), maxSize: 10, keepFirst: 0 }).getCondensation(view);
    expect(result.summary_offset).toBe(3);
    expect(result.forgotten_event_ids).toEqual(new Set(original.slice(3, 8).map(event => event.id)));
  });

  it('protects the system under token pressure with keepFirst zero', async () => {
    const fixed = system(), original = [fixed, ...users(11)];
    const agent: LLMClient = { ...fakeLlm(), getTokenCount: async messages => messages.reduce((count, message) => count + message.content.length * 10, 0) };
    const c = new LLMSummarizingCondenser({ llm: fakeLlm(), keepFirst: 0, maxTokens: 100 });
    const result = await c.getCondensation(new View(original), agent);
    expect(result.summary_offset).toBe(1);
    expect(result.forgotten_event_ids.has(fixed.id)).toBe(false);
    expect(result.forgotten_event_ids.size).toBeGreaterThan(0);
  });

  it.each([false, true])('hard reset keeps the first system prefix, but later systems remain eligible (prefix=%s)', async prefix => {
    const before = prefix ? [user('Before system')] : [];
    const original = [...before, system(), user('Middle'), system('Later system'), ...users(2)];
    const result = await new LLMSummarizingCondenser({ llm: fakeLlm(), keepFirst: 0 }).hardContextReset(new View(original));
    expect(result?.summary_offset).toBe(before.length + 1);
    expect(result?.forgotten_event_ids).toEqual(new Set(original.slice(before.length + 1).map(event => event.id)));
    expect(View.fromEvents([...original, result!]).events.slice(0, before.length + 1)).toEqual(original.slice(0, before.length + 1));
  });

  it('retains the system when an ordinary requested summary fails and falls back to hard reset', async () => {
    const original = [system(), ...users(11)], llm = fakeLlm();
    llm.complete.mockRejectedValueOnce(new Error('Normal summary failed'));
    const result = await new LLMSummarizingCondenser({ llm, keepFirst: 0 }).condense(new View(original, true));
    expect(result).toMatchObject({ kind: 'Condensation', summary_offset: 1 });
    if (!('kind' in result)) throw new Error('Expected condensation');
    expect(result.forgotten_event_ids).toEqual(new Set(original.slice(1).map(event => event.id)));
    expect(eventsToMessages(View.fromEvents([...original, result]).events)[0]?.role).toBe('system');
  });

  it('retains the system on hard fallback when reported pressure exists but candidate counts are unavailable', async () => {
    const original = [system(), ...users(3)], llm = fakeLlm();
    const agent = { ...fakeLlm(), getTokenCount: async () => null };
    const result = await new LLMSummarizingCondenser({ llm, keepFirst: 0, maxTokens: 100 }).condense(new View(original), agent, { reportedInputTokens: 200 });
    expect(result).toMatchObject({ kind: 'Condensation', summary_offset: 1 });
    expect(llm.complete).toHaveBeenCalledTimes(1);
    if (!('kind' in result)) throw new Error('Expected condensation');
    expect(result.forgotten_event_ids.has(original[0]!.id)).toBe(false);
  });

  it('seeds hard-reset clipping from the full original view, including the protected system', async () => {
    const original = [system('S'.repeat(1000)), user('Short')], llm = fakeLlm();
    llm.complete.mockRejectedValue(new Error('Synthetic failure'));
    const c = new LLMSummarizingCondenser({ llm, hardContextResetMaxRetries: 2 });
    const generate = vi.spyOn(c, 'generateCondensation');
    expect(await c.hardContextReset(new View(original))).toBeNull();
    expect(generate.mock.calls.map(call => call[2])).toEqual([null, Math.trunc([...renderCondenserEvent(original[0]!)].length * 0.8)]);
    expect(generate.mock.calls.every(call => call[0].length === 1 && call[0][0] === original[1] && call[1] === 1)).toBe(true);
  });

  it('makes no paid call for a system-only view and keeps empty-view errors explicit', async () => {
    const llm = fakeLlm(), c = new LLMSummarizingCondenser({ llm });
    expect(await c.hardContextReset(new View([system()]))).toBeNull();
    expect(llm.complete).not.toHaveBeenCalled();
    await expect(c.hardContextReset(new View([]))).rejects.toThrow();
  });
});

// PORT: 032e0e99 uses independent instruction and event messages for summary requests.
describe('summarizer instruction/data separation', () => {
  it('passes explicit conversation identity to the independent summary model on each retry', async () => {
    const callContext = new LLMCallContext({ sessionId: 'conversation', promptCacheKey: 'stable-cache' });
    const complete = vi.fn(async (_messages: readonly Message[], _tools?: readonly ToolDefinition[], _options?: LLMCompletionOptions) => response());
    complete.mockRejectedValueOnce(new Error('Retry summary'));
    const llm = { profile, complete };
    await new LLMSummarizingCondenser({ llm }).hardContextReset(new View(users(2)), undefined, { callContext });
    expect(complete).toHaveBeenCalledTimes(2);
    for (const call of complete.mock.calls) expect(call[2]?.callContext).toBe(callContext);
  });

  it('sends instructions as system and all event content including earlier summaries as user', async () => {
    const llm = fakeLlm();
    const original: LLMConvertibleEvent[] = [user('Unique event payload'), condensationSummaryEventSchema.parse({ summary: 'Earlier summary payload' })];
    await new LLMSummarizingCondenser({ llm }).generateCondensation(original, 0);
    const messages = llm.complete.mock.calls[0]![0];
    expect(messages.map(message => message.role)).toEqual(['system', 'user']);
    expect(text(messages[0]!)).toContain('You are maintaining a context-aware state summary');
    expect(text(messages[0]!)).not.toContain('Unique event payload');
    expect(text(messages[0]!)).not.toContain('Earlier summary payload');
    expect(text(messages[1]!)).toBe('<EVENT>\nMessageEvent (user)\n  user: Unique event payload\n</EVENT>\n\n<EVENT>\nCondensationSummaryEvent (environment)\n  user: Earlier summary payload\n</EVENT>\n\n\nNow summarize the events using the rules above.');
  });

  it('keeps instructions intact while shrinking event previews on retries', async () => {
    const llm = fakeLlm();
    llm.complete.mockRejectedValue(new Error('Synthetic failure'));
    await new LLMSummarizingCondenser({ llm, hardContextResetMaxRetries: 3 }).hardContextReset(new View([user('🙂'.repeat(600))]));
    const messages = llm.complete.mock.calls.map(call => call[0]);
    expect(messages.map(items => items.map(message => message.role))).toEqual(Array.from({ length: 3 }, () => ['system', 'user']));
    expect(new Set(messages.map(items => text(items[0]!))).size).toBe(1);
    expect(text(messages[1]![1]!).length).toBeLessThan(text(messages[0]![1]!).length);
  });
});
