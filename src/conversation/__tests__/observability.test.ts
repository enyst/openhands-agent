import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../agent/index.js';
import { llmProfileSchema, messageSchema, textContent } from '../../llm/index.js';
import { InMemoryFileStore } from '../../io/index.js';
import type { RootSpanOptions } from '../../observability/index.js';
import { LocalConversation } from '../local-conversation.js';
import { RemoteConversation, type RemoteFetchLike } from '../remote-conversation.js';

const ID = '00000000-0000-0000-0000-000000000001';
const env = { OTEL_ENDPOINT: 'fake', OPENHANDS_OBSERVABILITY_METADATA: '{"automation.id":"auto-1","same":"env"}', OPENHANDS_OBSERVABILITY_SPAN_NAME: 'env.child', LMNR_SPAN_CONTEXT: 'parent-fallback' };
function tracer() {
  const end = vi.fn(); const beginChild = vi.fn(); const setAttribute = vi.fn();
  const spanFactory = vi.fn((_name: string, _options: RootSpanOptions) => ({ end, beginChild, setAttribute }));
  return { end, beginChild, setAttribute, spanFactory, runtime: { env, spanFactory } };
}
function agent() {
  return new Agent({ llm: { profile: llmProfileSchema.parse({ profileId: 'test', providerId: 'openai', model: 'test' }), complete: async () => ({ message: messageSchema.parse({ role: 'assistant', content: [textContent('done')] }), usage: null }) } });
}
describe('conversation observability lifecycle', () => {
  it('keeps one local root across runs and closes it once with metadata, tags, parent and workspace cost registration', async () => {
    const trace = tracer(); const registerConversation = vi.fn(); const registerCost = vi.fn();
    const conversation = new LocalConversation({ agent: agent(), conversationId: ID, fileStore: new InMemoryFileStore(), observability: trace.runtime,
      observabilityMetadata: { same: 'caller', scalar: 3 }, observabilityTags: ['explicit'], userId: 'user', tags: { automationid: 'product' }, workspace: { registerConversation, registerCost } });
    expect(registerConversation).toHaveBeenCalledWith(ID);
    expect(trace.spanFactory).toHaveBeenCalledTimes(1);
    expect(trace.spanFactory).toHaveBeenCalledWith('conversation', expect.objectContaining({ sessionId: ID, userId: 'user', parentSpanContext: 'parent-fallback', metadata: { 'automation.id': 'auto-1', same: 'caller', scalar: 3 }, tags: ['explicit'], attributes: { 'automation.id': 'auto-1', same: 'caller', scalar: 3, 'conversation.tags.automationid': 'product' } }));
    expect(trace.beginChild).toHaveBeenCalledWith('env.child', ['explicit']);
    conversation.sendMessage('one'); await conversation.run();
    conversation.sendMessage('two'); await conversation.run();
    expect(trace.end).not.toHaveBeenCalled();
    conversation.close(); conversation.close();
    expect(trace.end).toHaveBeenCalledTimes(1);
    expect(registerCost).toHaveBeenCalledTimes(1);
  });
  it('propagates merged runtime context to remote create and closes the client root', async () => {
    const trace = tracer(); const bodies: Record<string, unknown>[] = [];
    const fetch: RemoteFetchLike = { async request(url, init) {
      if (init.body) bodies.push(JSON.parse(init.body));
      return { status: 200, ok: true, text: async () => '', json: async () => url.includes('/events/search') ? { items: [], next_page_id: null } : { id: ID, execution_status: 'idle' } };
    } };
    const conversation = await RemoteConversation.create({ host: 'https://agent.test', server: 'python', fetch, observability: trace.runtime,
      request: { workspace: { kind: 'LocalWorkspace', working_dir: '/work' }, agentProfileId: ID, observabilityMetadata: { same: 'caller' }, observabilityParentSpanContext: 'explicit-parent', observabilitySpanName: 'explicit.child' } });
    expect(bodies[0]).toMatchObject({ observability_metadata: { 'automation.id': 'auto-1', same: 'caller' }, observability_span_name: 'explicit.child', observability_parent_span_context: 'explicit-parent' });
    expect(trace.spanFactory).toHaveBeenCalledWith('conversation', expect.objectContaining({ parentSpanContext: 'explicit-parent' }));
    conversation.close(); conversation.close();
    expect(trace.end).toHaveBeenCalledTimes(1);
  });
  it('cleans up a root when remote history initialization fails', async () => {
    const trace = tracer();
    const fetch: RemoteFetchLike = { async request(url) { return { status: 200, ok: true, text: async () => '', json: async () => url.includes('/events/search') ? { invalid: true } : { id: ID, execution_status: 'idle' } }; } };
    await expect(RemoteConversation.attach({ host: 'https://agent.test', conversationId: ID, fetch, observability: trace.runtime })).rejects.toThrow();
    expect(trace.end).toHaveBeenCalledTimes(1);
  });
});
