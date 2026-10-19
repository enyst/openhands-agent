import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolDefinition, ToolRegistry, resolveTool, toolSpecSchema } from '../index.js';
import { resolveToolSpecs, launchToolSpecs, mergeDuplicateTools, canonicalToolName, foldRetiredToolSwitches } from '../defaults.js';
import '../builtins.js';
import '../classify-and-switch-llm.js';

const spec = (name: string, params = {}) => toolSpecSchema.parse({ name, params });

describe('canonical tool selection (upstream defaults and registry)', () => {
  it('keeps an explicit empty list, and adds switch_llm only to unset defaults', () => {
    expect(resolveToolSpecs(null).map(tool => tool.name)).toEqual(['terminal', 'file_editor', 'task_tracker', 'switch_llm']);
    expect(resolveToolSpecs([])).toEqual([]);
    expect(launchToolSpecs([spec('browser_tool_set'), spec('think')], { browserAvailable: false })).toEqual([spec('think')]);
  });
  it('canonicalizes aliases and keeps the first parameterized duplicate in its original position', () => {
    expect(canonicalToolName('SwitchLLMTool')).toBe('switch_llm');
    expect(mergeDuplicateTools([spec('ClassifyAndSwitchLLMTool'), spec('think'), spec('route_task_to_model', { active_meta_profile: 'a' }), spec('route_task_to_model', { active_meta_profile: 'b' })]))
      .toEqual([spec('route_task_to_model', { active_meta_profile: 'a' }), spec('think')]);
  });
  it('rejects unsupported structured-response configuration instead of discarding it', () => {
    const schema = { type: 'object', properties: { result: { type: 'string' } } };
    expect(() => resolveTool(spec('finish', { response_schema: schema }))).toThrow('response_schema');
    expect(() => resolveTool(spec('think', { response_schema: schema }))).toThrow('response_schema');
    expect(resolveTool(spec('switch_llm', { response_schema: null }))[0]?.name).toBe('switch_llm');
  });
  it('folds persisted switches differently from sparse fresh input', () => {
    expect(foldRetiredToolSwitches({ tools: [] }).tools).toBeNull();
    expect(foldRetiredToolSwitches({ tools: [], enable_sub_agents: true }, { sparse: true }).tools).toEqual([spec('task_tool_set')]);
    expect(foldRetiredToolSwitches({ tools: [spec('think')], enable_sub_agents: true }).tools).toEqual([spec('think'), spec('switch_llm')]);
    expect(foldRetiredToolSwitches({ tools: [spec('SwitchLLMTool')], enable_switch_llm_tool: 'false' }).tools).toEqual([]);
    expect(() => foldRetiredToolSwitches({ enable_sub_agents: 'invalid' })).toThrow();
  });
  it('reports metadata and usability without building tools, snapshots while sealed, then returns live', () => {
    const registry = new ToolRegistry();
    const factory = vi.fn(() => []);
    const usable = vi.fn(() => false);
    registry.registerFactory('host', factory, { catalogDescription: 'Host tool', isUsable: usable });
    expect(registry.getToolCatalog().find(tool => tool.name === 'host')).toMatchObject({ user_selectable: true, usable: false, description: 'Host tool' });
    expect(factory).not.toHaveBeenCalled();
    usable.mockClear();
    expect(registry.getToolCatalog({ checkUsable: false }).find(tool => tool.name === 'host')?.usable).toBe(true);
    expect(usable).not.toHaveBeenCalled();
    registry.registerFactory('broken', factory, { isUsable: () => { throw new Error('probe failed'); } });
    expect(registry.isToolAvailable('broken')).toBe(false);
    expect(registry.getToolCatalog().find(tool => tool.name === 'broken')?.usable).toBe(false);
    registry.sealToolCatalog();
    registry.registerFactory('host', factory, { catalogDescription: 'Changed' });
    registry.registerFactory('late', factory);
    expect(registry.getToolCatalog().some(tool => tool.name === 'late')).toBe(false);
    expect(registry.getToolCatalog().find(tool => tool.name === 'host')?.description).toBe('Host tool');
    registry.unsealToolCatalog();
    expect(registry.getToolCatalog().some(tool => tool.name === 'late')).toBe(true);
    expect(registry.getToolCatalog().find(tool => tool.name === 'host')?.description).toBe('Changed');
  });
  it('does not canonicalize a host override, reports unavailable absent implementations honestly', () => {
    const registry = new ToolRegistry();
    registry.register('finish', new ToolDefinition({ name: 'finish', description: 'custom', inputSchema: z.object({}) }));
    expect(registry.canonicalToolName('FinishTool')).toBe('FinishTool');
    expect(registry.isToolAvailable('browser_tool_set')).toBe(false);
    expect(registry.isToolAvailable('task_tool_set')).toBe(false);
    expect(registry.getToolCatalog().find(tool => tool.name === 'switch_llm')).toMatchObject({ user_selectable: true, in_default_set: true });
    expect(registry.getToolCatalog().find(tool => tool.name === 'route_task_to_model')).toBeUndefined();
  });
});
