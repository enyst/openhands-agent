import { describe, expect, it } from 'vitest';
import { Agent } from '../../agent/index.js';
import { InMemoryFileStore } from '../../io/index.js';
import { LLMAuthenticationError } from '../../llm/exceptions.js';
import { LLMResponseError } from '../../llm/client.js';
import { llmProfileSchema, messageSchema } from '../../llm/index.js';
import { LocalConversation } from '../local-conversation.js';
import { EventLog } from '../event-log.js';

// Upstream ea606dca: invalid credentials stop the run with one durable friendly event.
describe('friendly authentication failure', () => {
  it.each(['run', 'arun'] as const)('%s persists a safe error and remains recoverable', async method => {
    const store = new InMemoryFileStore();
    const failure = new LLMAuthenticationError('private provider response');
    let fail = true;
    const llm = { profile: llmProfileSchema.parse({ profileId: 'test', providerId: 'openai', model: 'test' }), complete: async () => {
      if (fail) throw failure;
      return { usage: null, message: messageSchema.parse({ role: 'assistant', content: 'done' }) };
    } };
    const conv = new LocalConversation({ agent: new Agent({ llm }), fileStore: store, conversationId: 'auth' });
    await expect(conv[method]()).rejects.toBe(failure);
    expect(conv.state.executionStatus).toBe('error');
    const events = new EventLog(store, 'auth/events').toArray().filter(event => event.kind === 'ConversationErrorEvent');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: 'environment', code: 'LLMAuthenticationError', detail: 'Your LLM API key appears to be invalid or has expired.' });
    expect(JSON.stringify(events)).not.toContain('private provider response');
    fail = false;
    conv.sendMessage('retry');
    await conv[method]();
    expect(conv.state.executionStatus).toBe('finished');
  });

  it('recognizes typed authentication causes without trusting error text', async () => {
    const wrapped = new LLMResponseError({ usage: null }, new LLMAuthenticationError());
    const profile = llmProfileSchema.parse({ profileId: 'test', providerId: 'openai', model: 'test' });
    const conv = new LocalConversation({ agent: new Agent({ llm: { profile, complete: async () => { throw wrapped; } } }) });
    await expect(conv.run()).rejects.toBe(wrapped);
    expect(conv.state.events.filter(event => event.kind === 'ConversationErrorEvent')).toHaveLength(1);
    const ordinary = new LocalConversation({ agent: new Agent({ llm: { profile, complete: async () => { throw new Error('invalid API key'); } } }) });
    await expect(ordinary.run()).rejects.toThrow('invalid API key');
    expect(ordinary.state.events.filter(event => event.kind === 'ConversationErrorEvent')).toHaveLength(0);
  });
});
