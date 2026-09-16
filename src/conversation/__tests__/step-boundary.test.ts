import { describe, expect, it, vi } from 'vitest';

import { Agent } from '../../agent/index.js';
import { InMemoryFileStore } from '../../io/index.js';
import type { LLMClient, LLMCompletionResponse } from '../../llm/client.js';
import { llmProfileSchema, messageSchema } from '../../llm/index.js';
import { FinishTool, SwitchLLMTool, ThinkTool } from '../../tool/builtins.js';
import { ToolDefinition } from '../../tool/index.js';
import { z } from 'zod';
import { LocalConversation } from '../local-conversation.js';

describe('LocalConversation step boundary', () => {
  it('replaces before the first call and preserves the conversation state and run budget', async () => {
    const original = agent('old', [['think']]);
    const first = agent('first', [['think']]);
    const second = agent('second', [['think']]);
    const seen: Agent[] = [];
    const conversation = new LocalConversation({
      agent: original, maxIterations: 2, stuckDetection: true,
      onStepBoundary: (current) => { seen.push(current); return seen.length === 1 ? first : second; },
    });
    const state = conversation.state;
    const detector = conversation.stuckDetector;
    conversation.sendMessage('work');
    await conversation.run();
    expect(seen).toEqual([original, first, second]);
    expect(conversation.agent).toBe(second);
    expect(conversation.state).toBe(state);
    expect(conversation.stuckDetector).toBe(detector);
    expect(conversation.maxIterations).toBe(2);
    expect(conversation.state.executionStatus).toBe('error');
    expect(conversation.state.events.filter((event) => event.kind === 'ConversationStateUpdateEvent' && event.key === 'llm_usage')).toHaveLength(2);
  });

  it('waits for all parallel tools and durable observations before replacing the active agent', async () => {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const replacement = agent('new', [['finish']]);
    let pending = false;
    const switchTool = SwitchLLMTool.create({ profileNames: ['new'], switchProfile: () => {
      pending = true; return { model: 'new-model' };
    } });
    const waitTool = new ToolDefinition({ name: 'wait', description: 'Wait', inputSchema: z.object({}), executor: async () => {
      entered.resolve(); await release.promise; return { text: 'ready', is_error: false };
    } });
    const original = agent('old', [['switch_llm', 'wait']], [switchTool, waitTool], 2);
    const boundary = vi.fn((current: Agent) => {
      if (!pending) return;
      expect(current).toBe(original);
      expect(conversation.state.pendingActions()).toEqual([]);
      expect(conversation.state.eventLog?.toArray().filter((event) => event.kind === 'ObservationEvent')).toHaveLength(2);
      pending = false;
      return replacement;
    });
    const conversation = new LocalConversation({ agent: original, fileStore: new InMemoryFileStore(), onStepBoundary: boundary });
    conversation.sendMessage('switch');
    const run = conversation.run();
    await entered.promise;
    expect(conversation.agent).toBe(original);
    expect(boundary).toHaveBeenCalledTimes(1);
    const concurrentRun = conversation.run();
    await Promise.resolve();
    expect(boundary).toHaveBeenCalledTimes(1);
    release.resolve();
    await Promise.all([run, concurrentRun]);
    expect(conversation.agent).toBe(replacement);
    expect(boundary).toHaveBeenCalledTimes(3);
    expect(conversation.state.executionStatus).toBe('finished');
  });

  it('activates a switch in the same response as finish without waiting for another run', async () => {
    const replacement = agent('new', []);
    let pending = false;
    const tool = SwitchLLMTool.create({ profileNames: ['new'], switchProfile: () => {
      pending = true; return { model: 'new-model' };
    } });
    const original = agent('old', [['switch_llm', 'finish']], [tool]);
    const conversation = new LocalConversation({ agent: original, onStepBoundary: () => {
      if (!pending) return;
      expect(conversation.state.executionStatus).toBe('finished');
      return replacement;
    } });
    conversation.sendMessage('switch and finish');
    await conversation.run();
    expect(conversation.agent).toBe(replacement);
    expect(conversation.state.executionStatus).toBe('finished');
    expect(conversation.state.pendingActions()).toEqual([]);
  });

  it('does not call the hook for paused or already finished runs', async () => {
    const onStepBoundary = vi.fn();
    const conversation = new LocalConversation({ agent: agent('old', []), onStepBoundary });
    conversation.pause();
    await conversation.run();
    conversation.state.executionStatus = 'finished';
    await conversation.run();
    expect(onStepBoundary).not.toHaveBeenCalled();
  });

  it('records the actual latest user event immediately before a step, not a later queued message', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let boundaries = 0;
    const conversation = new LocalConversation({ agent: agent('old', [['finish']]), onStepBoundary: async () => {
      boundaries += 1;
      if (boundaries === 1) { entered.resolve(); await release.promise; }
      else conversation.sendMessage('arrived after the final step');
    } });
    expect(conversation.lastStepUserMessageId).toBeNull();
    conversation.sendMessage('first');
    const run = conversation.run();
    await entered.promise;
    const seen = conversation.sendMessage('arrived during preparation');
    release.resolve();
    await run;
    expect(conversation.lastStepUserMessageId).toBe(seen.id);
    expect(conversation.lastStepUserMessageId).not.toBe(conversation.state.events.at(-1)?.id);
  });

  it('propagates preparation failures without replacing the current agent or making a call', async () => {
    const original = agent('old', []);
    const conversation = new LocalConversation({ agent: original, onStepBoundary: () => { throw new Error('bad selection'); } });
    await expect(conversation.run()).rejects.toThrow('bad selection');
    expect(conversation.agent).toBe(original);
    expect(conversation.state.events.filter((event) => event.kind !== 'ConversationStateUpdateEvent')).toEqual([]);
  });
});

function agent(id: string, steps: string[][], extraTools: ToolDefinition[] = [], concurrency = 1): Agent {
  const responses = [...steps];
  const llm: LLMClient = {
    profile: llmProfileSchema.parse({ profileId: id, providerId: 'openai', model: `${id}-model` }),
    complete: async (): Promise<LLMCompletionResponse> => {
      const names = responses.shift();
      if (names === undefined) throw new Error(`${id} exhausted`);
      return { usage: null, message: messageSchema.parse({ role: 'assistant', content: [], tool_calls: names.map((name, index) => ({
        name, id: `${id}-${responses.length}-${index}`, origin: 'completion',
        arguments: JSON.stringify(name === 'finish' ? { message: 'done' } : name === 'think' ? { thought: 'working' } : name === 'switch_llm' ? { profile_name: 'new', reason: 'Need another model.' } : {}),
      })) }) };
    },
  };
  return new Agent({ llm, tools: [ThinkTool.create(), FinishTool.create(), ...extraTools], toolConcurrencyLimit: concurrency });
}
