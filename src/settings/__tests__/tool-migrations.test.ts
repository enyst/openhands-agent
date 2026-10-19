import { describe, expect, it, vi } from 'vitest';
import { validateAgentSettings, openHandsAgentSettingsSchema } from '../index.js';
import { validateAgentProfile } from '../../profiles/index.js';
const base = { llm_profile_ref: 'main' };

describe('v8 settings and v3 profile migration (upstream #41443fc)', () => {
  it('distinguishes bare new requests from legacy persisted empty lists', () => {
    expect(validateAgentSettings({ ...base, tools: [] }).tools).toEqual([]);
    expect(validateAgentSettings({ ...base, tools: [] }, { persisted: true }).tools).toBeNull();
    expect(validateAgentSettings({ ...base, schema_version: 7, tools: [] }).tools).toBeNull();
    expect(validateAgentSettings({ ...base, schema_version: 8, tools: [] }, { persisted: true }).tools).toEqual([]);
  });
  it('folds sparse switches, serializes only tools, and preserves parameterized aliases', () => {
    const settings = openHandsAgentSettingsSchema.parse({ ...base, tools: [], enable_sub_agents: true });
    expect(settings.tools).toEqual([{ name: 'task_tool_set', params: {} }]);
    expect(JSON.stringify(settings)).not.toMatch(/enable_sub_agents|enable_switch_llm_tool/u);
    const explicit = validateAgentSettings({ ...base, tools: [{ name: 'ClassifyAndSwitchLLMTool', params: { active_meta_profile: 'chosen' } }, { name: 'route_task_to_model', params: { active_meta_profile: 'ignored' } }] });
    expect(explicit.tools).toEqual([{ name: 'route_task_to_model', params: { active_meta_profile: 'chosen' } }]);
  });
  it('migrates v2 profiles and never reinterprets current empty tools', () => {
    const old = validateAgentProfile({ ...base, name: 'custom', schema_version: 2, tools: [], enable_switch_llm_tool: false });
    expect(old.schema_version).toBe(3);
    expect(old.tools).toEqual(['terminal', 'file_editor', 'task_tracker', 'browser_tool_set'].map(name => ({ name, params: {} })));
    expect(validateAgentProfile({ ...base, name: 'new', tools: [] }).tools).toEqual([]);
    expect(() => validateAgentProfile({ ...base, name: 'invalid', schema_version: 0 })).toThrow('No migration');
  });
  it('warns only on deprecated current request input, not migrated legacy storage', () => {
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      validateAgentSettings({ ...base, enable_switch_llm_tool: false });
      expect(warning).toHaveBeenCalledTimes(1);
      validateAgentSettings({ agent_kind: 'acp', llm: { api_key: 'secret' } });
      expect(warning).toHaveBeenCalledTimes(2);
      validateAgentSettings({ agent_kind: 'acp', schema_version: 6, llm: { api_key: 'secret' } });
      validateAgentSettings({ ...base, schema_version: 7, enable_switch_llm_tool: false });
      expect(warning).toHaveBeenCalledTimes(2);
      validateAgentSettings({ agent_kind: 'acp', schema_version: 8, llm: {} }, { persisted: true });
      expect(warning).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('secret');
    } finally { warning.mockRestore(); }
  });
  it('drops ACP llm, rejects it on OpenHands, and keeps persona bounded and OpenHands-only', () => {
    const acp = validateAgentSettings({ agent_kind: 'acp', schema_version: 6, llm: { api_key: 'secret' } });
    expect(JSON.stringify(acp)).not.toContain('secret');
    expect(() => validateAgentSettings({ ...base, llm: { api_key: 'secret' } })).toThrow();
    expect(validateAgentSettings({ ...base, persona: 'My agent' }).persona).toBe('My agent');
    expect(() => validateAgentSettings({ ...base, persona: '' })).toThrow();
    expect(() => validateAgentProfile({ ...base, name: 'p', persona: 'x'.repeat(65537) })).toThrow();
    expect(() => validateAgentSettings({ agent_kind: 'acp', persona: 'x' })).toThrow();
  });
  it('does not persist an unsupported structured-response contract', () => {
    expect(() => validateAgentSettings({ ...base, tools: [{ name: 'finish', params: { response_schema: { type: 'object' } } }] })).toThrow('response_schema');
    expect(() => validateAgentProfile({ ...base, name: 'p', tools: [{ name: 'think', params: { response_schema: { type: 'object' } } }] })).toThrow('response_schema');
  });
  it('rejects unsafe explicit router params before persistence and preserves unrelated host params', () => {
    const bad = [{ name: 'ClassifyAndSwitchLLMTool', params: { meta_profile_llms: { main: { api_key: 'secret' } } } }];
    expect(() => validateAgentSettings({ ...base, tools: bad })).toThrow();
    expect(() => validateAgentProfile({ ...base, name: 'unsafe', tools: bad })).toThrow();
    expect(validateAgentSettings({ ...base, tools: [{ name: 'custom', params: { marker: 'kept' } }] }).tools).toEqual([{ name: 'custom', params: { marker: 'kept' } }]);
  });
});
