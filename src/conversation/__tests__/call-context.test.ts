import { describe, expect, it } from 'vitest';
import { Agent } from '../../agent/index.js';
import { getLLMCallContext, LLMCallContext, withLLMCallContext } from '../../llm/call-context.js';
import type { LLMClient } from '../../llm/client.js';
import { llmProfileSchema, messageSchema } from '../../llm/index.js';
import { ConversationState } from '../state.js';
import { LocalConversation } from '../local-conversation.js';

const profile = llmProfileSchema.parse({ profileId: 'shared', providerId: 'openai', model: 'gpt-6' });
const response = { usage: null, message: messageSchema.parse({ role: 'assistant', content: 'done' }) };

// Adapted from upstream conversation/local/test_call_context_isolation.py (bd33d63f).
describe('conversation-owned LLM call context', () => {
  it('isolates overlapping conversations sharing an agent, including after await', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const seen: unknown[] = [];
    const llm: LLMClient = { profile, complete: async (_messages, _tools, options) => {
      const first = seen.length === 0;
      seen.push(options?.callContext);
      if (first) { entered.resolve(); await release.promise; }
      seen.push(getLLMCallContext());
      return response;
    } };
    const agent = new Agent({ llm });
    const one = new LocalConversation({ agent, state: new ConversationState(), conversationId: 'one' });
    const two = new LocalConversation({ agent, state: new ConversationState(), conversationId: 'two', promptCacheKey: 'shared-shard' });
    const run = one.run();
    await entered.promise;
    await two.run();
    release.resolve();
    await run;
    expect(seen).toEqual([
      { sessionId: 'one', promptCacheKey: 'one' },
      { sessionId: 'two', promptCacheKey: 'shared-shard' },
      { sessionId: 'two', promptCacheKey: 'shared-shard' },
      { sessionId: 'one', promptCacheKey: 'one' },
    ]);
    expect(getLLMCallContext().sessionId).toBeNull();
    expect(profile).not.toHaveProperty('sessionId');
  });

  it('gives memory-only conversations stable unique identity without creating storage', () => {
    const agent = new Agent({ llm: { profile, complete: async () => response } });
    const parent = new LocalConversation({ agent });
    const child = withLLMCallContext(parent.getLLMCallContext(), () => new LocalConversation({ agent }));
    expect(parent.conversationId).toEqual(expect.any(String));
    expect(child.conversationId).not.toBe(parent.conversationId);
    expect(child.getLLMCallContext().sessionId).toBe(child.conversationId);
    expect(child.getLLMCallContext().promptCacheKey).toBe(child.conversationId);
    expect(parent.state.eventLog).toBeNull();
    expect(Object.isFrozen(parent.getLLMCallContext())).toBe(true);
    expect(parent.getLLMCallContext()).toBe(parent.getLLMCallContext());
  });

  it('preserves identity through profile switches, condensers, and maintenance condensation', async () => {
    const seen: unknown[] = [];
    const llm: LLMClient = { profile, complete: async (_messages, _tools, options) => { seen.push(options?.callContext); return response; } };
    const condenser = { handlesCondensationRequests: () => true, condense: async (view: import('../../context/index.js').View, _llm: LLMClient, context?: import('../../context/index.js').CondenserContext) => {
      seen.push(context?.callContext, getLLMCallContext()); return view;
    } };
    const replacement = new Agent({ llm, condenser });
    const conv = new LocalConversation({ agent: new Agent({ llm }), state: new ConversationState(), conversationId: 'stable', onStepBoundary: () => replacement });
    await conv.run();
    await conv.condense();
    expect(seen).toHaveLength(6);
    expect(seen.every(context => context === conv.getLLMCallContext())).toBe(true);
  });

  it('accepts explicit Agent context without changing a surrounding scope', async () => {
    const outer = new LLMCallContext({ sessionId: 'outer' });
    const explicit = new LLMCallContext({ sessionId: 'explicit' });
    const agent = new Agent({ llm: { profile, complete: async (_messages, _tools, options) => {
      expect(options?.callContext).toBe(explicit);
      expect(getLLMCallContext()).toBe(explicit);
      return response;
    } } });
    await withLLMCallContext(outer, async () => {
      await agent.step(new ConversationState(), { callContext: explicit });
      expect(getLLMCallContext()).toBe(outer);
    });
  });
});
