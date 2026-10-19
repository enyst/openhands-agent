import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '../../agent/agent.js';
import { LocalConversation } from '../../conversation/local-conversation.js';
import { ConversationState } from '../../conversation/state.js';
import { eventsToMessages, messageEventSchema, systemPromptEventSchema, type Event } from '../../event/index.js';
import { llmProfileSchema, messageSchema, textContent, type Message } from '../../llm/index.js';
import { ToolDefinition } from '../../tool/index.js';
import { FinishTool, ThinkTool } from '../../tool/builtins.js';
import { LLMSummarizingCondenser } from '../llm-summarizing-condenser.js';
import { View } from '../view.js';

const profile = llmProfileSchema.parse({ profileId: 'fixture', providerId: 'openai', model: 'fixture' });
const user = (text: string) => messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: text } });
const system = () => systemPromptEventSchema.parse({ system_prompt: textContent('Protected system prompt'), tools: [] });
const summary = () => ({ profile, complete: vi.fn(async () => ({ usage: { promptTokens: 10, completionTokens: 5 }, message: messageSchema.parse({ role: 'assistant', content: 'HARD_RESET_MARKER_7F3A: retained task summary' }) })) });

// Pinned c02 now verifies the reset's exact forgotten set and a subsequent normal cut.
it('c02 preserves the system, replaces all later history with a real summary, and continues through normal condensation', async () => {
  const fixed = system(); const original: Event[] = [fixed, user('HARD_RESET_MARKER_7F3A'), user('Previous work')];
  const llm = summary(); const condenser = new LLMSummarizingCondenser({ llm, maxSize: 100, keepFirst: 4 });
  const first = await condenser.condense(new View(original, true));
  if (!('kind' in first)) throw new Error('Expected hard reset');
  expect(first.summary_offset).toBe(1);
  expect(first.forgotten_event_ids).toEqual(new Set(original.slice(1).map(event => event.id)));
  const after = View.fromEvents([...original, first]);
  expect(after.events[0]).toEqual(fixed); expect(after.events).toHaveLength(2);
  expect(after.events[1]).toMatchObject({ kind: 'CondensationSummaryEvent', summary: expect.stringContaining('HARD_RESET_MARKER_7F3A') });
  const continued = [...original, first, ...Array.from({ length: 12 }, (_, i) => user(`Context marker ${i}`))];
  const second = await condenser.condense(new View(View.fromEvents(continued).events, true));
  if (!('kind' in second)) throw new Error('Expected ordinary condensation');
  expect(second.summary_offset).toBeGreaterThanOrEqual(4);
  expect(second.forgotten_event_ids.has(fixed.id)).toBe(false);
  expect(second.forgotten_event_ids.has(`${first.id}-summary`)).toBe(false);
  const final = View.fromEvents([...continued, second]);
  expect(eventsToMessages(final.events)[0]?.role).toBe('system');
  expect(llm.complete).toHaveBeenCalledTimes(2);
});

// c04's two large outputs, explicit6000/keepFirst2 and20-iteration budget. Native
// DEV-SDK-010 uses reported input one request later, so think calls expose each
// payload to the synthetic provider before the next condensation decision.
it('c04 condenses twice for two separate large tool results and finishes within20iterations', async () => {
  const llm = summary(); const executed: string[] = [];
  const terminal = new ToolDefinition({ name: 'terminal', description: 'Deterministic output fixture', inputSchema: z.object({ command: z.string() }), executor: ({ command }) => {
    executed.push(command); return { text: (command === 'first' ? 'token pressure context ' : 'second context payload ').repeat(2000), is_error: false };
  } });
  const count = (messages: readonly Message[]) => 40 + Math.ceil(JSON.stringify(messages).length / 4);
  const complete = vi.fn(async (messages: readonly Message[]) => {
    const index = complete.mock.calls.length;
    const name = index === 1 || index === 3 ? 'terminal' : index === 5 ? 'finish' : 'think';
    const args = name === 'terminal' ? { command: index === 1 ? 'first' : 'second' } : name === 'finish' ? { message: 'done' } : { thought: 'Continue the requested second output.' };
    return { responseId: `response-${index}`, usage: { promptTokens: count(messages), completionTokens: 5 }, message: messageSchema.parse({ role: 'assistant', content: [], tool_calls: [{ id: `call-${index}`, name, arguments: JSON.stringify(args), origin: 'completion' }] }) };
  });
  const initial = [system(), user('Produce first and second outputs separately, then finish.')];
  const conversation = new LocalConversation({ state: new ConversationState({ events: initial }), maxIterations: 20,
    agent: new Agent({ systemPrompt: 'Protected system prompt', llm: { profile, complete, getTokenCount: async messages => count(messages) }, tools: [terminal, ThinkTool.create(), FinishTool.create()], condenser: new LLMSummarizingCondenser({ llm, maxSize: 1000, maxTokens: 6000, keepFirst: 2 }) }) });
  await conversation.run();
  const condensations = conversation.state.events.filter(event => event.kind === 'Condensation');
  expect(condensations.length).toBeGreaterThanOrEqual(2);
  expect(executed).toEqual(['first', 'second']);
  expect(conversation.state.executionStatus).toBe('finished');
  for (const event of condensations) for (const kept of initial) expect(event.forgotten_event_ids.has(kept.id)).toBe(false);
  expect(complete).toHaveBeenCalledTimes(5);
});
