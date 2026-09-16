import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { Agent } from '../agent.js';
import { ConversationState } from '../../conversation/state.js';
import { EventLog } from '../../conversation/event-log.js';
import { InMemoryFileStore } from '../../io/index.js';
import { condensationSchema, conversationStateUpdateEventSchema, messageEventSchema, type Event } from '../../event/index.js';
import { ToolDefinition } from '../../tool/index.js';
import { orderCompletedToolResults } from '../../llm/tool-result-order.js';
import { historyForRequests, LLM_REQUEST_BOUNDARY_KEY, requestBoundaryEvent } from '../../llm/request-history.js';
import { View } from '../../context/view.js';
import { CORRECTIVE_NUDGE } from '../response-dispatch.js';
import { llmProfileSchema, messageSchema, type Message } from '../../llm/index.js';
import type { LLMCompletionResponse } from '../../llm/client.js';

const profile = llmProfileSchema.parse({ profileId: 'test', providerId: 'anthropic', model: 'test' });
const user = (text: string) => messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: text } });
const reply = (text: string): LLMCompletionResponse => ({ message: messageSchema.parse({ role: 'assistant', content: text }), usage: null, responseId: 'reused-id' });
const texts = (messages: readonly Message[]) => messages.map(message => [message.role, message.content.map(part => part.type === 'text' ? part.text : part.type).join('|')]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('concurrent user messages in provider request history', () => {
  it('keeps late text and images after the response that did not consume them, including restore', async () => {
    const store = new InMemoryFileStore();
    const state = new ConversationState({ eventLog: new EventLog(store) });
    state.appendEvent(user('A'));
    const pending = deferred<LLMCompletionResponse>();
    const first = new Agent({ llm: { profile, complete: async () => pending.promise } });
    const step = first.step(state);
    state.appendEvent(user('B'));
    state.appendEvent(messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: [{ type: 'image', image_urls: ['data:image/png;base64,AA=='] }] } }));
    pending.resolve(reply('reply-A'));
    await step;
    const durable = structuredClone(state.events);
    expect(texts(state.events.filter(event => event.kind === 'MessageEvent').map(event => event.llm_message))).toEqual([
      ['user', 'A'], ['user', 'B'], ['user', 'image'], ['assistant', 'reply-A'],
    ]);
    const restored = new ConversationState({ eventLog: new EventLog(store) });
    const complete = vi.fn(async (_messages: readonly Message[]) => reply('reply-B'));
    await new Agent({ llm: { profile, complete } }).step(restored);
    expect(texts(complete.mock.calls[0]![0])).toEqual([
      ['user', 'A'], ['assistant', 'reply-A'], ['user', 'B|image'],
    ]);
    expect(restored.events.slice(0, durable.length)).toEqual(durable);
  });

  it.each(['llm_usage', LLM_REQUEST_BOUNDARY_KEY])('uses the request snapshot even when a user arrives while %s persistence is awaited', async (key) => {
    const state = new ConversationState({ events: [user('A')] });
    const append = state.appendEventsAsync.bind(state);
    const persisting = deferred<void>();
    const release = deferred<void>();
    vi.spyOn(state, 'appendEventsAsync').mockImplementation(async (events: readonly Event[]) => {
      if (events.some(event => event.kind === 'ConversationStateUpdateEvent' && event.key === key)) {
        persisting.resolve();
        await release.promise;
      }
      return append(events);
    });
    const complete = vi.fn(async (_messages: readonly Message[]) => reply('reply-A'));
    const agent = new Agent({ llm: { profile, complete } });
    const step = agent.step(state);
    await persisting.promise;
    state.appendEvent(user('B'));
    release.resolve();
    await step;
    await agent.step(state);
    expect(texts(complete.mock.calls[1]![0])).toEqual([
      ['user', 'A'], ['assistant', 'reply-A'], ['user', 'B'],
    ]);
  });

  it('keeps a complete tool batch before input received during completion or tool execution', async () => {
    const state = new ConversationState({ events: [user('A')] });
    const completion = deferred<LLMCompletionResponse>();
    const executing = deferred<void>();
    const toolResult = deferred<void>();
    const lookup = new ToolDefinition({ name: 'lookup', description: 'lookup', inputSchema: z.object({}), executor: async () => {
      executing.resolve();
      await toolResult.promise;
      return { result: 'found' };
    } });
    const complete = vi.fn(async (_messages: readonly Message[]) => complete.mock.calls.length === 1 ? completion.promise : reply('done'));
    const agent = new Agent({ llm: { profile, complete }, tools: [lookup] });
    const running = agent.step(state);
    state.appendEvent(user('B'));
    completion.resolve({ ...reply('lookup'), message: messageSchema.parse({ role: 'assistant', content: 'lookup', tool_calls: [
      { id: 'call-1', name: 'lookup', arguments: '{}', origin: 'completion' }, { id: 'call-2', name: 'lookup', arguments: '{}', origin: 'completion' },
    ] }) });
    await executing.promise;
    state.appendEvent(user('C'));
    toolResult.resolve();
    await running;
    await agent.step(state);
    const request = orderCompletedToolResults(complete.mock.calls[1]![0]);
    expect(request.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user']);
    expect(texts(request).at(-1)).toEqual(['user', 'B|C']);
    expect(request[1]!.tool_calls?.map(call => call.id)).toEqual(['call-1', 'call-2']);
    expect(state.events.filter(event => event.kind !== 'ConversationStateUpdateEvent').map(event => event.kind)).toEqual([
      'MessageEvent', 'MessageEvent', 'ActionEvent', 'ActionEvent', 'MessageEvent', 'ObservationEvent', 'ObservationEvent', 'MessageEvent',
    ]);
  });

  it('keeps a response-owned corrective nudge with its response and persists empty input boundaries', async () => {
    const store = new InMemoryFileStore();
    const state = new ConversationState({ eventLog: new EventLog(store) });
    const pending = deferred<LLMCompletionResponse>();
    const step = new Agent({ llm: { profile, complete: async () => pending.promise } }).step(state);
    state.appendEvent(user('B'));
    pending.resolve(reply(''));
    await step;
    const complete = vi.fn(async (_messages: readonly Message[]) => reply('done'));
    await new Agent({ llm: { profile, complete } }).step(new ConversationState({ eventLog: new EventLog(store) }));
    expect(texts(complete.mock.calls[0]![0])).toEqual([['assistant', ''], ['user', `${CORRECTIVE_NUDGE}|B`]]);
  });

  it('composes causal ordering with profile switching and repeated provider response IDs', async () => {
    const state = new ConversationState({ events: [user('A')] });
    const pending = deferred<LLMCompletionResponse>();
    const first = new Agent({ llm: { profile, complete: async () => pending.promise } }).step(state);
    state.appendEvent(user('B'));
    pending.resolve({ ...reply('reply-A'), message: messageSchema.parse({ ...reply('reply-A').message, thinking_blocks: [{ type: 'thinking', thinking: 'hidden', signature: 'signed' }] }) });
    await first;
    const secondProfile = { ...profile, profileId: 'second' };
    const complete = vi.fn(async (_messages: readonly Message[]) => reply('reply-B'));
    await new Agent({ llm: { profile: secondProfile, complete } }).step(state);
    expect(texts(complete.mock.calls[0]![0])).toEqual([['user', 'A'], ['assistant', 'reply-A'], ['user', 'B']]);
    expect(complete.mock.calls[0]![0][1]!.thinking_blocks).toEqual([]);
    state.appendEvent(user('C'));
    await new Agent({ llm: { profile: secondProfile, complete } }).step(state);
    expect(texts(complete.mock.calls[1]![0])).toEqual([
      ['user', 'A'], ['assistant', 'reply-A'], ['user', 'B'], ['assistant', 'reply-B'], ['user', 'C'],
    ]);
  });

  it('orders late input across consecutive requests idempotently', async () => {
    const state = new ConversationState({ events: [user('A')] });
    const first = deferred<LLMCompletionResponse>();
    const second = deferred<LLMCompletionResponse>();
    const complete = vi.fn(async (_messages: readonly Message[]) => complete.mock.calls.length === 1 ? first.promise : second.promise);
    const agent = new Agent({ llm: { profile, complete } });
    const firstStep = agent.step(state);
    state.appendEvent(user('B'));
    first.resolve(reply('reply-A'));
    await firstStep;
    const secondStep = agent.step(state);
    state.appendEvent(user('C'));
    second.resolve(reply('reply-B'));
    await secondStep;
    const view = View.fromEvents(state.events);
    const projected = historyForRequests(view.events, state.events);
    expect(texts(projected.filter(event => event.kind === 'MessageEvent').map(event => event.llm_message))).toEqual([
      ['user', 'A'], ['assistant', 'reply-A'], ['user', 'B'], ['assistant', 'reply-B'], ['user', 'C'],
    ]);
    expect(historyForRequests(projected, state.events)).toEqual(projected);
  });

  it('does not move input across an unrelated response from overlapping direct steps', () => {
    const first = user('A');
    const second = user('B');
    const responseA = messageEventSchema.parse({ source: 'agent', llm_message: reply('reply-A').message });
    const responseB = messageEventSchema.parse({ source: 'agent', llm_message: reply('reply-B').message });
    const history = [first, second, requestBoundaryEvent(second.id, [responseB]), responseB, requestBoundaryEvent(first.id, [responseA]), responseA];
    const view = View.fromEvents(history);
    expect(historyForRequests(view.events, history)).toEqual(view.events);
  });

  it('resolves a forgotten input boundary without resurrecting it or a forgotten response', async () => {
    const input = user('A');
    const state = new ConversationState({ events: [input] });
    const pending = deferred<LLMCompletionResponse>();
    const step = new Agent({ llm: { profile, complete: async () => pending.promise } }).step(state);
    state.appendEvent(user('B'));
    pending.resolve(reply('reply-A'));
    await step;
    const response = state.events.find(event => event.kind === 'MessageEvent' && event.source === 'agent')!;
    state.appendEvent(condensationSchema.parse({ forgotten_event_ids: [input.id], summary: 'Earlier context', summary_offset: 0 }));
    const view = View.fromEvents(state.events);
    const projected = historyForRequests(view.events, state.events);
    expect(projected.map(event => event.id)).toEqual([view.events[0]!.id, response.id, view.events[1]!.id]);
    state.appendEvent(condensationSchema.parse({ forgotten_event_ids: [response.id] }));
    const forgotten = View.fromEvents(state.events);
    expect(historyForRequests(forgotten.events, state.events)).toEqual(forgotten.events);
  });

  it('keeps summary barriers and unknown legacy history unchanged', () => {
    const input = user('A');
    const late = user('B');
    const response = messageEventSchema.parse({ source: 'agent', llm_message: reply('reply-A').message });
    const legacy = [input, late, response];
    expect(historyForRequests(legacy, legacy)).toEqual(legacy);
    const history: Event[] = [input, late, requestBoundaryEvent(input.id, [response]), response,
      condensationSchema.parse({ forgotten_event_ids: [], summary: 'Summary barrier', summary_offset: 2 }),
    ];
    const view = View.fromEvents(history);
    expect(historyForRequests(view.events, history)).toEqual(view.events);
  });

  it('does not cross a summary inserted inside a response-owned message group', () => {
    const input = user('A');
    const late = user('B');
    const assistant = messageEventSchema.parse({ source: 'agent', llm_message: reply('').message });
    const nudge = messageEventSchema.parse({ source: 'environment', llm_message: { role: 'user', content: CORRECTIVE_NUDGE } });
    const history: Event[] = [input, late, requestBoundaryEvent(input.id, [assistant, nudge]), assistant, nudge,
      condensationSchema.parse({ forgotten_event_ids: [], summary: 'Inside response group', summary_offset: 3 }),
    ];
    const view = View.fromEvents(history);
    expect(historyForRequests(view.events, history)).toEqual(view.events);
  });

  it('does not guess causality from partial, unknown, or misordered batch references', () => {
    const input = user('A');
    const late = user('B');
    const response = messageEventSchema.parse({ source: 'agent', llm_message: reply('reply-A').message });
    const orphan = requestBoundaryEvent(input.id, [response]);
    const partial = [input, late, orphan];
    expect(historyForRequests(View.fromEvents(partial).events, partial)).toEqual([input, late]);
    const missingInput = [input, late, requestBoundaryEvent('missing', [response]), response];
    expect(historyForRequests(View.fromEvents(missingInput).events, missingInput)).toEqual([input, late, response]);
    const markerAfter = [input, late, response, orphan];
    expect(historyForRequests(View.fromEvents(markerAfter).events, markerAfter)).toEqual([input, late, response]);
    const invalid = [input, conversationStateUpdateEventSchema.parse({ key: LLM_REQUEST_BOUNDARY_KEY, value: { version: 999 } })];
    expect(() => historyForRequests([input], invalid)).toThrow();
  });

});
