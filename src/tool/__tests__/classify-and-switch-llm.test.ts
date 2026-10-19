import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

import { Agent } from '../../agent/agent.js';
import { LocalConversation } from '../../conversation/local-conversation.js';
import { ConversationState } from '../../conversation/state.js';
import { EventLog } from '../../conversation/event-log.js';
import { messageEventSchema, observationEventSchema } from '../../event/index.js';
import { LocalFileStore } from '../../io/index.js';
import { LLMCallContext } from '../../llm/call-context.js';
import { llmCompletionResponseSchema, LLMResponseError, type LLMClient } from '../../llm/client.js';
import { llmProfileSchema, textContent } from '../../llm/index.js';
import { MetaProfileStore, metaProfileSchema } from '../../meta-profiles/index.js';
import { openHandsAgentSettingsSchema } from '../../settings/index.js';
import { resolveTool } from '../index.js';
import { FinishTool } from '../builtins.js';
import {
  ClassifyAndSwitchLLMTool, buildClassifierMessages, buildClassifierPrompt, parseClassIndex, parseDirectModel,
  recentMessagesText, renderDirectPrompt, type MetaProfileRoutingRuntime,
} from '../classify-and-switch-llm.js';

// PORT: dcf401af tests/sdk/tool/test_classify_and_switch_llm.py.
const meta = metaProfileSchema.parse({ classifier_model: 'classifier', classes: [
  { description: 'UI / images', model: 'visual' }, { description: 'tests', model: 'careful' },
] });
const profile = (name: string) => llmProfileSchema.parse({ profileId: name, providerId: 'openai', model: `${name}-model` });
const roots: string[] = [];
async function root(): Promise<string> { const dir = await mkdtemp(path.join(tmpdir(), 'routing-test-')); roots.push(dir); return dir; }
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function fixture(reply = '2', state = new ConversationState()) {
  const callContext = new LLMCallContext({ sessionId: 'conversation', promptCacheKey: 'cache' });
  const complete = vi.fn(async () => llmCompletionResponseSchema.parse({
    message: { role: 'assistant', content: [textContent(reply)] }, usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
  }));
  const client: LLMClient = { profile: profile('classifier'), complete };
  const resolveClient = vi.fn(async () => client);
  const switchProfile = vi.fn(async (name: string) => ({ model: `${name}-model` }));
  const runtime: MetaProfileRoutingRuntime = { state, listProfileNames: () => ['visual', 'careful'], resolveClient, switchProfile, getCallContext: () => callContext };
  const store = { list: vi.fn(async () => [] as string[]), load: vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }) };
  return { runtime, complete, client, resolveClient, switchProfile, state, callContext, store };
}

test.each([['1', 1], ['2', 2], ['0', 0], ['9', 0], ['-1 then 2', 0], ['none', 0], ['Category 2 fits best', 2]])('class parser %s', (reply, expected) => {
  expect(parseClassIndex(reply as string, 2)).toBe(expected);
});
test.each([
  ['{"model":"GPT-5.4"}', 'gpt-5.4'], ['```json\n{"model":"MiniMax-M3"}\n```', 'minimax-m3'],
  ['I choose GPT-5.4', 'gpt-5.4'], ['{"model":"unknown"} use gpt-5.4', null], ['none', null],
])('direct parser %s', (reply, expected) => expect(parseDirectModel(reply, ['gpt-5.4', 'minimax-m3'])).toBe(expected));

test('direct parser selects longest canonical name and handles scalar JSON model values', () => {
  expect(parseDirectModel('use fast-plus please', ['fast', 'fast-plus'])).toBe('fast-plus');
  expect(parseDirectModel('{"model":123}', ['123'])).toBe('123');
});
test('prompts preserve category order and substitute templates once', () => {
  expect(buildClassifierPrompt(meta)).toContain('1. UI / images\n2. tests');
  expect(buildClassifierPrompt(meta)).toContain('respond with 0');
  const direct = metaProfileSchema.parse({ classifier_model: 'classifier', prompt_template: '{{ model_table }}\n{{ instance_text }}', model_table: 'models' });
  expect(renderDirectPrompt(direct, '{{ model_table }}')).toBe('models\n{{ model_table }}');
});
test('classifier transcript uses only last six nonempty MessageEvents', () => {
  const state = new ConversationState();
  for (let i = 0; i < 8; i++) state.appendEvent(messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: [textContent(`m${i}`)] } }));
  state.appendEvent(messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: [textContent('  ')] } }));
  state.appendEvent(observationEventSchema.parse({ action_id: 'a', tool_name: 'terminal', tool_call_id: 'c', observation: { output: 'exclude tool output' } }));
  expect(recentMessagesText(state.events)).toBe(Array.from({ length: 6 }, (_, i) => `user: m${i + 2}`).join('\n'));
});

test('constructing an enabled tool does not resolve missing profiles or clients', () => {
  const f = fixture();
  expect(ClassifyAndSwitchLLMTool.create({ activeMetaProfile: 'missing', metaProfileStore: f.store, runtime: f.runtime }).name).toBe('route_task_to_model');
  expect(f.store.load).not.toHaveBeenCalled();
  expect(f.store.list).not.toHaveBeenCalled();
  expect(f.resolveClient).not.toHaveBeenCalled();
});
test('named store config is authoritative over stale inline config and sees later file changes', async () => {
  const dir = await root();
  const store = new MetaProfileStore(dir);
  await store.save('active', meta);
  const f = fixture('1');
  const tool = ClassifyAndSwitchLLMTool.create({ activeMetaProfile: 'active', metaProfile: { ...meta, classes: [] }, metaProfileStore: store, runtime: f.runtime });
  expect((await tool.execute({})).model).toBe('visual');
  await writeFile(path.join(dir, 'active.json'), JSON.stringify({ ...meta, classes: [{ description: 'new', model: 'careful' }] }));
  expect((await tool.execute({})).model).toBe('careful');
});
test('only missing named files permit inline fallback; corrupt config never silently falls back', async () => {
  const dir = await root();
  const f = fixture();
  const tool = ClassifyAndSwitchLLMTool.create({ activeMetaProfile: 'cloud', metaProfile: meta, metaProfileStore: new MetaProfileStore(dir), runtime: f.runtime });
  expect((await tool.execute({})).is_error).toBe(false);
  await writeFile(path.join(dir, 'cloud.json'), '{');
  expect((await tool.execute({})).is_error).toBe(true);
  expect(f.complete).toHaveBeenCalledTimes(1);
});
test('without active name choose inline, otherwise alphabetically first; dangling active name is an error', async () => {
  const store = new MetaProfileStore(await root());
  await store.save('z-last', { ...meta, classes: [] });
  await store.save('a-first', meta);
  const f = fixture();
  expect((await ClassifyAndSwitchLLMTool.create({ metaProfileStore: store, runtime: f.runtime }).execute({})).is_error).toBe(false);
  expect((await ClassifyAndSwitchLLMTool.create({ activeMetaProfile: 'absent', metaProfileStore: store, runtime: f.runtime }).execute({})).is_error).toBe(true);
  expect((await ClassifyAndSwitchLLMTool.create({ metaProfile: { ...meta, classes: [] }, metaProfileStore: store, runtime: f.runtime }).execute({})).is_error).toBe(true);
});
test('classifier accounting is persisted before selection; calls share one bucket and inherit context', async () => {
  const dir = await root();
  const fileStore = new LocalFileStore(dir);
  const f = fixture('2', new ConversationState({ eventLog: new EventLog(fileStore, 'events') }));
  f.switchProfile.mockImplementation(async name => {
    expect(f.state.stats.usage_to_metrics['classifier:classifier']?.records.length).toBeGreaterThan(0);
    return { model: `${name}-model` };
  });
  const tool = ClassifyAndSwitchLLMTool.create({ metaProfile: meta, metaProfileStore: f.store, runtime: f.runtime });
  const result = await tool.execute({});
  expect(result).toMatchObject({ chosen_class: 'tests', model: 'careful', active_model: 'careful-model', is_error: false });
  expect(result.content[0]?.text).toContain('next LLM call');
  await tool.execute({});
  expect(f.resolveClient).toHaveBeenCalledTimes(1);
  expect(f.complete).toHaveBeenCalledWith(expect.any(Array), undefined, { callContext: f.callContext });
  const restored = new ConversationState({ eventLog: new EventLog(new LocalFileStore(dir), 'events') });
  expect(restored.stats.usage_to_metrics['classifier:classifier']?.records).toHaveLength(2);
  expect(restored.stats.usage_to_metrics['classifier:classifier']?.known_token_usage.total_tokens).toBe(8);
});
test('invalid classifier reply is accounted but never selects a fallback', async () => {
  const f = fixture('unknown');
  const result = await ClassifyAndSwitchLLMTool.create({ metaProfile: meta, metaProfileStore: f.store, runtime: f.runtime }).execute({});
  expect(result.is_error).toBe(true);
  expect(f.state.stats.usage_to_metrics['classifier:classifier']?.records).toHaveLength(1);
  expect(f.switchProfile).not.toHaveBeenCalled();
});
test('accounting persistence failure escapes without switching or repeating the paid classifier call', async () => {
  const f = fixture();
  vi.spyOn(f.state, 'appendEventAsync').mockRejectedValue(new Error('disk full'));
  const tool = ClassifyAndSwitchLLMTool.create({ metaProfile: meta, metaProfileStore: f.store, runtime: f.runtime });
  await expect(tool.execute({})).rejects.toMatchObject({ name: 'LLMUsagePersistenceError', cause: new Error('disk full') });
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.switchProfile).not.toHaveBeenCalled();
});
test('failed classifier call records received usage once and does not expose raw errors', async () => {
  const f = fixture();
  f.complete.mockRejectedValue(new LLMResponseError({ usage: { promptTokens: 5 } }, new Error('Bearer secret-token')));
  const result = await ClassifyAndSwitchLLMTool.create({ metaProfile: meta, metaProfileStore: f.store, runtime: f.runtime }).execute({});
  expect(result.is_error).toBe(true);
  expect(JSON.stringify(result)).not.toContain('secret-token');
  expect(f.state.stats.usage_to_metrics['classifier:classifier']?.known_token_usage.prompt_tokens).toBe(5);
  expect(f.switchProfile).not.toHaveBeenCalled();
});
test('inline native profiles route with no saved profile database', async () => {
  const f = fixture('{"model":"Careful"}');
  f.runtime.listProfileNames = () => [];
  const inline = { classifier: profile('classifier'), Careful: profile('Careful') };
  const direct = metaProfileSchema.parse({ classifier_model: 'classifier', prompt_template: '{{instance_text}} {{model_table}}', model_table: 'Careful' });
  const result = await ClassifyAndSwitchLLMTool.create({ activeMetaProfile: 'cloud', metaProfile: direct, metaProfileLlms: inline, metaProfileStore: f.store, runtime: f.runtime }).execute({});
  expect(result).toMatchObject({ is_error: false, model: 'Careful', chosen_class: 'model: Careful' });
  expect(f.resolveClient).toHaveBeenCalledWith('classifier', inline.classifier);
  expect(f.switchProfile).toHaveBeenCalledWith('Careful', inline.Careful);
  expect(f.complete.mock.calls[0]?.[0]).toHaveLength(2);
});
test('missing runtime/classifier/target produce errors and rejected client construction can retry', async () => {
  const f = fixture();
  expect((await ClassifyAndSwitchLLMTool.create({ metaProfile: meta, metaProfileStore: f.store }).execute({})).is_error).toBe(true);
  f.resolveClient.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  const tool = ClassifyAndSwitchLLMTool.create({ metaProfile: meta, metaProfileStore: f.store, runtime: f.runtime });
  expect((await tool.execute({})).is_error).toBe(true);
  f.switchProfile.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  expect(await tool.execute({})).toMatchObject({ is_error: true, model: 'careful' });
  expect((await tool.execute({})).is_error).toBe(false);
});
test('opt-in registry aliases accept only supported parameters', () => {
  const f = fixture();
  for (const name of ['route_task_to_model', 'ClassifyAndSwitchLLMTool']) {
    expect(resolveTool({ name, params: {} }, { metaProfile: meta, metaProfileStore: f.store, runtime: f.runtime })[0]?.name).toBe('route_task_to_model');
    expect(() => resolveTool({ name, params: { bogus: 1 } })).toThrow(/only accepts/);
  }
  expect(() => ClassifyAndSwitchLLMTool.create({ bogus: 1 } as never)).toThrow(/only accepts/);
});
test('settings default disabled, preserve native inline profiles and reject raw keys', () => {
  expect(openHandsAgentSettingsSchema.parse({ llm_profile_ref: 'main' })).toMatchObject({ enable_classify_and_switch_llm_tool: false, active_meta_profile: null, meta_profile: null, meta_profile_llms: {} });
  const value = { llm_profile_ref: 'main', enable_classify_and_switch_llm_tool: true, active_meta_profile: 'cloud', meta_profile: meta, meta_profile_llms: { classifier: profile('classifier') } };
  expect(openHandsAgentSettingsSchema.parse(value).meta_profile_llms.classifier).toEqual(profile('classifier'));
  expect(() => openHandsAgentSettingsSchema.parse({ ...value, meta_profile_llms: { classifier: { ...profile('classifier'), api_key: 'private' } } })).toThrow();
});

test('a real agent loop activates routing only after the completed tool batch and keeps classifier identity independent', async () => {
  const f = fixture('2');
  let conversation: LocalConversation;
  let pending: LLMClient | undefined;
  const calls: string[] = [];
  const response = (tool: string, arguments_: unknown) => llmCompletionResponseSchema.parse({
    message: { role: 'assistant', content: [], tool_calls: [{ id: `call-${tool}`, name: tool, arguments: JSON.stringify(arguments_), origin: 'completion' }] },
    usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
  });
  const main: LLMClient = { profile: profile('main'), complete: async () => {
    calls.push('main');
    return response('route_task_to_model', {});
  } };
  const target: LLMClient = { profile: profile('careful'), complete: async () => {
    calls.push('careful');
    expect(f.state.events.some(event => event.kind === 'ObservationEvent' && event.tool_name === 'route_task_to_model')).toBe(true);
    expect(f.state.stats.usage_to_metrics['classifier:classifier']?.records).toHaveLength(1);
    return response('finish', { message: 'done' });
  } };
  f.runtime.getCallContext = () => conversation.getLLMCallContext();
  f.switchProfile.mockImplementation(async name => {
    expect(conversation.agent).toBe(initialAgent);
    expect(name).toBe('careful');
    pending = target;
    return { model: target.profile.model };
  });
  const router = ClassifyAndSwitchLLMTool.create({ metaProfile: meta, metaProfileStore: f.store, runtime: f.runtime });
  const initialAgent = new Agent({ llm: main, tools: [router, FinishTool.create()] });
  conversation = new LocalConversation({ agent: initialAgent, state: f.state, maxIterations: 3,
    onStepBoundary: current => {
      if (pending === undefined) return;
      const llm = pending;
      pending = undefined;
      return new Agent({ llm, tools: current.tools, context: current.context, condenser: current.condenser });
    },
  });
  const context = conversation.getLLMCallContext();
  conversation.sendMessage('Write tests');
  await conversation.run();
  expect(calls).toEqual(['main', 'careful']);
  expect(f.state.executionStatus).toBe('finished');
  expect(conversation.getLLMCallContext()).toBe(context);
  expect(f.complete).toHaveBeenCalledWith(expect.any(Array), undefined, { callContext: context });
  expect(f.client.profile.profileId).toBe('classifier');
});

test.each(['create', 'append'] as const)('a real conversation stops after classifier accounting %s fails', async failureKind => {
  const f = fixture();
  if (failureKind === 'append') {
    const append = f.state.appendEventAsync.bind(f.state);
    vi.spyOn(f.state, 'appendEventAsync').mockImplementation(async event => {
      if (event.kind === 'ConversationStateUpdateEvent' && event.key === 'llm_usage'
        && typeof event.value === 'object' && event.value !== null && 'usage_id' in event.value
        && event.value.usage_id === 'classifier:classifier') throw new Error('private storage detail');
      return append(event);
    });
  } else {
    f.complete.mockResolvedValue({ ...llmCompletionResponseSchema.parse({
      message: { role: 'assistant', content: [textContent('2')] }, usage: null,
    }), usage: { promptTokens: -1 } });
  }
  const complete = vi.fn(async () => llmCompletionResponseSchema.parse({
    message: { role: 'assistant', content: [], tool_calls: [{
      id: 'route', name: 'route_task_to_model', arguments: '{}', origin: 'completion',
    }] }, usage: null,
  }));
  const router = ClassifyAndSwitchLLMTool.create({ metaProfile: meta, metaProfileStore: f.store, runtime: f.runtime });
  const conversation = new LocalConversation({ state: f.state,
    agent: new Agent({ llm: { profile: profile('main'), complete }, tools: [router] }), maxIterations: 2 });
  await expect(conversation.run()).rejects.toMatchObject({ name: 'LLMUsagePersistenceError' });
  expect(f.state.executionStatus).toBe('error');
  expect(complete).toHaveBeenCalledTimes(1);
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.switchProfile).not.toHaveBeenCalled();
  expect(f.state.events.some(event => event.kind === 'AgentErrorEvent')).toBe(false);
  expect(JSON.stringify(f.state.events)).not.toContain('private storage detail');
});

// PORT 53a4bc50: direct classifiers must provide a user turn, including empty histories.
test('classifier builders keep system instructions separate from user transcript', () => {
  const direct = metaProfileSchema.parse({ classifier_model: 'classifier', prompt_template: '{{ instance_text }}\n{{ model_table }}', model_table: 'careful' });
  const messages = buildClassifierMessages(direct, '{{ model_table }}');
  expect(messages.map(item => item.role)).toEqual(['system', 'user']);
  expect(messages[0]?.content).toEqual([textContent('You are a model-routing classifier.')]);
  expect(messages[1]?.content).toEqual([textContent('{{ model_table }}\ncareful')]);
  const classes = buildClassifierMessages(meta, 'user: tests');
  expect(classes.map(item => item.role)).toEqual(['system', 'user']);
  expect(classes[0]?.content).toEqual([textContent(buildClassifierPrompt(meta))]);
  expect(classes[1]?.content).toEqual([textContent('Recent conversation:\nuser: tests\n\nCategory number:')]);
});
test('direct classifier works with a provider requiring a nonempty user turn and accounts once', async () => {
  const f = fixture();
  const complete = vi.fn<LLMClient['complete']>(async messages => {
    if (!messages.some(item => item.role === 'user' && item.content.some(content => content.type === 'text' && content.text))) throw new Error('user required');
    expect(messages[1]?.content).toEqual([textContent('(no messages yet)')]);
    return llmCompletionResponseSchema.parse({ message: { role: 'assistant', content: [textContent('{"model":"careful"}')] }, usage: { totalTokens: 4 } });
  });
  f.client.complete = complete;
  const direct = { classifier_model: 'classifier', prompt_template: '{{ instance_text }}' };
  expect(await ClassifyAndSwitchLLMTool.create({ metaProfile: direct, metaProfileStore: f.store, runtime: f.runtime }).execute({})).toMatchObject({ is_error: false, model: 'careful' });
  expect(complete).toHaveBeenCalledTimes(1);
  expect(f.state.stats.usage_to_metrics['classifier:classifier']?.records).toHaveLength(1);
  expect(f.switchProfile).toHaveBeenCalledTimes(1);
});
