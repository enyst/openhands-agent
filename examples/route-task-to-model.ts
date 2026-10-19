/** Deterministic PORT of upstream example 59, including its default-tool registration fix. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  Agent, ClassifyAndSwitchLLMTool, ConversationState, FileEditorTool, FinishTool,
  LocalConversation, MetaProfileStore, TaskTrackerTool, TerminalTool, ToolRegistry,
  llmCompletionResponseSchema, llmProfileSchema, openHandsAgentSettingsSchema,
  textContent, type LLMClient,
} from '@smolpaws/openhands-agent';

const root = await mkdtemp(path.join(tmpdir(), 'route-task-example-'));
try {
  const store = new MetaProfileStore(path.join(root, 'meta-profiles'));
  await store.save('balanced', { classifier_model: 'classifier', classes: [{ description: 'tests', model: 'careful' }] });
  const settings = openHandsAgentSettingsSchema.parse({
    llm_profile_ref: 'main', enable_classify_and_switch_llm_tool: true,
    active_meta_profile: 'balanced', tools: ['terminal', 'file_editor', 'task_tracker'],
  });

  // Register executable default tools before materializing the configured tool names.
  // These tools are available to the agent; this scripted example does not execute commands.
  const registry = new ToolRegistry();
  for (const tool of [TerminalTool.create({ workingDir: root }), FileEditorTool.create({ workspaceRoot: root }), TaskTrackerTool.create()]) {
    registry.register(tool.name, tool);
  }
  const defaultTools = ['terminal', 'file_editor', 'task_tracker'].flatMap(name => registry.resolve({ name, params: {} }));
  const profile = (name: string) => llmProfileSchema.parse({ profileId: name, providerId: 'openai', model: `example-${name}` });
  const toolResponse = (name: string, args: unknown) => llmCompletionResponseSchema.parse({
    message: { role: 'assistant', content: [], tool_calls: [{ id: `call-${name}`, name, arguments: JSON.stringify(args), origin: 'completion' }] },
    usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
  });
  const main: LLMClient = { profile: profile('main'), complete: async () => toolResponse('route_task_to_model', {}) };
  const careful: LLMClient = { profile: profile('careful'), complete: async (_messages, tools) => {
    assert.deepEqual(tools?.slice(0, 3).map(tool => tool.name), ['terminal', 'file_editor', 'task_tracker']);
    return toolResponse('finish', { message: 'Selected the careful profile for the tests.' });
  } };
  const classifier: LLMClient = { profile: profile('classifier'), complete: async () => llmCompletionResponseSchema.parse({
    message: { role: 'assistant', content: [textContent('1')] }, usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
  }) };
  const clients = new Map([['main', main], ['careful', careful], ['classifier', classifier]]);
  const state = new ConversationState();
  let pending: LLMClient | undefined;
  let conversation: LocalConversation;
  const router = ClassifyAndSwitchLLMTool.create({
    metaProfileStore: store, activeMetaProfile: settings.active_meta_profile,
    runtime: {
      state, listProfileNames: () => [...clients.keys()],
      resolveClient: async name => {
        const client = clients.get(name);
        if (client === undefined) throw new Error(`Missing example profile '${name}'`);
        return client;
      },
      switchProfile: name => {
        const client = clients.get(name);
        if (client === undefined) throw new Error(`Missing example profile '${name}'`);
        pending = client;
        return { model: client.profile.model };
      },
      getCallContext: () => conversation.getLLMCallContext(),
    },
  });
  conversation = new LocalConversation({
    agent: new Agent({ llm: main, tools: [...defaultTools, router, FinishTool.create()] }), state, maxIterations: 3,
    onStepBoundary: current => {
      if (pending === undefined) return;
      const llm = pending;
      pending = undefined;
      return new Agent({ llm, tools: current.tools, condenser: current.condenser, context: current.context });
    },
  });
  conversation.sendMessage('Add useful parser tests.');
  await conversation.run();
  assert.equal(conversation.agent.llm.profile.profileId, 'careful');
  assert.equal(state.executionStatus, 'finished');
  assert.equal(state.stats.usage_to_metrics['classifier:classifier']?.records.length, 1);
  console.log('Routed to careful at the step boundary; classifier usage recorded once.');
} finally {
  await rm(root, { recursive: true, force: true });
}
