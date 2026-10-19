import { describe, expect, it } from 'vitest';
import { actionEventSchema, observationEventSchema } from '../../event/index.js';
import { RemoteConversation, type RemoteFetchLike } from '../remote-conversation.js';
import { ConversationState } from '../state.js';

const ID = '00000000-0000-0000-0000-000000000003';
const action = actionEventSchema.parse({ id: 'action-1', timestamp: '2026-10-01T00:00:00Z', tool_name: 'OptionalTool', tool_call_id: 'call-1', tool_call: { id: 'call-1', name: 'OptionalTool', arguments: '{}', origin: 'completion' }, action: { kind: 'OptionalAction', opaque: { extra: null } } });
const observation = observationEventSchema.parse({ id: 'observation-1', timestamp: '2026-10-01T00:00:01Z', action_id: action.id, tool_call_id: 'call-1', tool_name: 'OptionalTool', observation: { kind: 'OptionalObservation', value: 'retained' } });
function transport(pages: readonly unknown[], status = 200) {
  const calls: { url: string; method: string; headers?: Readonly<Record<string, string>> }[] = [];
  let page = 0;
  const info = { id: ID, execution_status: 'finished', tool_module_qualnames: { OptionalTool: 'missing.optional_module' } };
  const fetch: RemoteFetchLike = { async request(url, init) {
    calls.push({ url, ...init });
    const body = url.includes('/events/search') ? pages[page++] : info;
    return { ok: status === 200, status, json: async () => body, text: async () => '' };
  } };
  return { fetch, calls, info };
}

describe('remote initial history restoration (upstream #5069)', () => {
  it.each(['attach', 'create'] as const)('restores opaque tool events across pages on %s without importing remote module names', async operation => {
    const { fetch, calls, info } = transport([{ items: [action], next_page_id: 'page/2' }, { items: [action, observation], next_page_id: null }]);
    const options = { host: 'https://agent.test', fetch, apiKey: 'session-key' };
    const conversation = operation === 'attach' ? await RemoteConversation.attach({ ...options, conversationId: ID })
      : await RemoteConversation.create({ ...options, server: 'python', request: { workspace: { kind: 'LocalWorkspace', working_dir: '/work' }, agentProfileId: ID } });
    expect(conversation.state.events).toEqual([action, observation]);
    expect(conversation.state.executionStatus).toBe('finished');
    expect(conversation.toolModuleQualnames).toEqual(info.tool_module_qualnames);
    expect(Object.isFrozen(conversation.toolModuleQualnames)).toBe(true);
    info.tool_module_qualnames.OptionalTool = 'changed';
    expect(conversation.toolModuleQualnames.OptionalTool).toBe('missing.optional_module');
    expect(calls).toHaveLength(3);
    expect(new URL(calls[2]!.url).searchParams.get('page_id')).toBe('page/2');
    expect(calls.every(c => c.headers?.['x-session-api-key'] === 'session-key')).toBe(true);
  });

  it.each([
    { items: [{ kind: 'not-an-event' }], next_page_id: null },
    { items: [], next_page_id: 'again' },
    { invalid: true },
  ])('stages all pages and status before mutating supplied state (%j)', async lastPage => {
    const state = new ConversationState({ events: [observation], executionStatus: 'paused' });
    const { fetch } = transport([{ items: [action], next_page_id: 'again' }, lastPage]);
    await expect(RemoteConversation.attach({ host: 'https://agent.test', conversationId: ID, state, fetch })).rejects.toThrow();
    expect(state.events).toEqual([observation]);
    expect(state.executionStatus).toBe('paused');
  });

  it('explicit sync initializes a direct proxy and does not duplicate existing events', async () => {
    const { fetch } = transport([{ items: [action, observation], next_page_id: null }, { items: [action, observation], next_page_id: null }]);
    const state = new ConversationState({ events: [action] });
    const conversation = new RemoteConversation({ host: 'https://agent.test', conversationId: ID, state, fetch });
    await conversation.syncEvents();
    await conversation.syncEvents();
    expect(state.events).toEqual([action, observation]);
  });
});
