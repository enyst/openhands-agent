import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TerminalTool } from '../../tools/index.js';
import { ToolDefinition, ToolRegistry, NATIVE_TOOL_MODULE_QUALNAMES, getToolModuleQualnames } from '../index.js';
import '../builtins.js';
import '../classify-and-switch-llm.js';

describe('trusted tool module provenance', () => {
  it('reports the registered terminal module for server persistence without constructing tools or probing usability', () => {
    // Python test_server_resolved_tool_modules_are_persisted expects this exact
    // module for the server-resolved terminal, independent of creator imports.
    const registry = new ToolRegistry();
    const factory = vi.fn(() => [TerminalTool.create({ workingDir: '/tmp' })]);
    const usable = vi.fn(() => true);
    registry.registerFactory('terminal', factory, {
      moduleQualname: NATIVE_TOOL_MODULE_QUALNAMES.terminal,
      isUsable: usable,
    });
    registry.registerFactory('client_only', factory, { moduleQualname: 'client.private_module' });
    expect(registry.getToolModuleQualnames(['terminal', 'unknown'])).toEqual({
      terminal: 'openhands.tools.terminal.definition',
    });
    expect(factory).not.toHaveBeenCalled();
    expect(usable).not.toHaveBeenCalled();
    expect(registry.resolve({ name: 'terminal', params: {} })[0]?.name).toBe('terminal');
  });

  it('does not infer provenance from a familiar name or builtin identity marker', () => {
    const registry = new ToolRegistry();
    registry.registerFactory('terminal', () => [TerminalTool.create({ workingDir: '/tmp' })]);
    registry.registerFactory('switch_llm', () => [], { builtinName: 'switch_llm' });
    expect(registry.getToolModuleQualnames(['terminal', 'switch_llm', 'browser_tool_set', 'task_tool_set'])).toEqual({});
  });

  it('uses the exact effective registration when a host shadows a builtin or its alias', () => {
    const registry = new ToolRegistry();
    expect(registry.getToolModuleQualnames(['finish', 'FinishTool'])).toEqual({
      finish: 'openhands.sdk.tool.builtins.finish',
      FinishTool: 'openhands.sdk.tool.builtins.finish',
    });
    registry.register('finish', new ToolDefinition({ name: 'finish', description: 'host override', inputSchema: z.object({}) }));
    expect(registry.getToolModuleQualnames(['finish', 'FinishTool'])).toEqual({
      FinishTool: 'openhands.sdk.tool.builtins.finish',
    });
    registry.registerFactory('FinishTool', () => [], { moduleQualname: 'host.finish' });
    expect(registry.getToolModuleQualnames(['finish', 'FinishTool'])).toEqual({ FinishTool: 'host.finish' });
  });

  it('reads live runtime provenance after a sealed catalog is overridden and copies registration metadata', () => {
    const registry = new ToolRegistry();
    const metadata = { moduleQualname: 'host.original' };
    registry.registerFactory('custom', () => [], metadata);
    metadata.moduleQualname = 'host.mutated';
    registry.sealToolCatalog();
    const original = registry.getToolModuleQualnames(['custom']);
    registry.registerFactory('custom', () => [], { moduleQualname: 'host.replacement' });
    expect(original).toEqual({ custom: 'host.original' });
    expect(registry.getToolModuleQualnames(['custom'])).toEqual({ custom: 'host.replacement' });
    registry.registerFactory('custom', () => []);
    expect(registry.getToolModuleQualnames(['custom'])).toEqual({});
  });

  it('exposes verified builtin provenance without suggesting unavailable tools are registered', () => {
    expect(getToolModuleQualnames(['think', 'switch_llm', 'route_task_to_model', 'task_tracker', 'terminal'])).toEqual({
      think: 'openhands.sdk.tool.builtins.think',
      switch_llm: 'openhands.sdk.tool.builtins.switch_llm',
      route_task_to_model: 'openhands.sdk.tool.builtins.classify_and_switch_llm',
      task_tracker: 'openhands.tools.task_tracker.definition',
    });
    expect(Object.isFrozen(NATIVE_TOOL_MODULE_QUALNAMES)).toBe(true);
  });
});
