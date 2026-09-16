import { describe, expect, it, vi } from 'vitest';

import { eventsToMessages, observationEventSchema } from '../../event/index.js';
import { BUILT_IN_TOOLS, SwitchLLMTool, switchLLMActionSchema } from '../builtins.js';
import { resolveTool } from '../index.js';

describe('SwitchLLMTool (pinned Python switch_llm contract)', () => {
  it('lists sorted profile names and stays an optional builtin', () => {
    const tool = SwitchLLMTool.create({ profileNames: ['slow', 'fast'] });
    expect(tool.name).toBe('switch_llm');
    expect(tool.description).toContain('Available LLM profiles:\n- fast\n- slow');
    expect(tool.description).toContain('next LLM call');
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(BUILT_IN_TOOLS.map((create) => create().name)).not.toContain('switch_llm');
    expect(tool.toResponsesTool().parameters.required).toEqual(['profile_name', 'reason']);
    expect(() => switchLLMActionSchema.parse({ profile_name: 'fast' })).toThrow();
  });

  it('describes an empty store and reports absent conversation binding', async () => {
    const tool = SwitchLLMTool.create({ profileNames: [] });
    expect(tool.description).toContain('No saved LLM profiles are currently available.');
    await expect(tool.execute({ profile_name: 'fast', reason: 'Need speed.' })).resolves.toMatchObject({
      kind: 'SwitchLLMObservation', profile_name: 'fast', reason: 'Need speed.', active_model: null,
      is_error: true, content: [{ text: 'Cannot switch LLM profile without an active conversation.' }],
    });
  });

  it('accepts a selected profile and preserves structured observation fields', async () => {
    const switchProfile = vi.fn().mockResolvedValue({ model: 'fast-model' });
    const observation = await SwitchLLMTool.create({ profileNames: ['fast'], switchProfile })
      .execute({ profile_name: 'fast', reason: 'Need a faster profile.' });
    expect(switchProfile).toHaveBeenCalledExactlyOnceWith('fast');
    expect(observation).toMatchObject({
      kind: 'SwitchLLMObservation', is_error: false, profile_name: 'fast',
      reason: 'Need a faster profile.', active_model: 'fast-model',
    });
    expect(observation.content[0]?.text).toContain('next LLM call');
    const [message] = eventsToMessages([observationEventSchema.parse({
      action_id: 'action', tool_name: 'switch_llm', tool_call_id: 'call', observation,
    })]);
    expect(message?.content).toEqual(observation.content);
  });

  it('reports a missing profile without changing the host selection', async () => {
    let activeModel = 'default-model';
    const tool = SwitchLLMTool.create({ profileNames: ['fast'], switchProfile: (name) => {
      if (name !== 'fast') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      activeModel = 'fast-model';
      return { model: activeModel };
    } });
    const observation = await tool.execute({ profile_name: 'missing', reason: 'Try another model.' });
    expect(observation).toMatchObject({ is_error: true, profile_name: 'missing', active_model: null });
    expect(observation.content[0]?.text).toBe("LLM profile 'missing' was not found.");
    expect(activeModel).toBe('default-model');
  });

  it('reports unexpected resolver failures as tool errors', async () => {
    const tool = SwitchLLMTool.create({ profileNames: ['fast'], switchProfile: () => {
      throw new Error('Cannot read fast');
    } });
    const observation = await tool.execute({ profile_name: 'fast', reason: 'Need access.' });
    expect(observation).toMatchObject({ is_error: true, profile_name: 'fast', reason: 'Need access.', active_model: null });
    expect(observation.content[0]?.text).toContain('Error: Cannot read fast');
  });

  it('resolves by tool name with a host binding and rejects serialized tool parameters', async () => {
    const [tool] = resolveTool({ name: 'switch_llm', params: {} }, {
      profileNames: ['fast'], switchProfile: () => ({ model: 'fast-model' }),
    });
    await expect(tool?.execute({ profile_name: 'fast', reason: 'Speed.' })).resolves.toMatchObject({ active_model: 'fast-model' });
    expect(() => resolveTool({ name: 'switch_llm', params: { profile_name: 'fast' } })).toThrow("SwitchLLMTool doesn't accept parameters");
  });
});
