import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { SubAgentScope, inheritMcpConfig, scopeDelegationTools, subAgentScopeSchema } from '../scope.js';
import { globalToolRegistry, ToolDefinition } from '../../tool/index.js';
import { TaskTrackerTool } from '../../tool/task-tracker.js';
import '../../tool/builtins.js';

const originalTracker = TaskTrackerTool.create();
afterEach(() => globalToolRegistry.register('task_tracker', originalTracker));
it('accepts legacy MCP scope flags but omits them from serialized params and does not restrict MCP', () => {
  const scope = new SubAgentScope({ mcp_servers: true });
  expect(scope.restricts).toBe(false);
  expect(JSON.parse(JSON.stringify(scope))).toEqual({ tools: false });
  expect(subAgentScopeSchema.parse({ mcp_servers: true })).toEqual({ tools: false });
  expect(scope.missingFrom({ tools: [] }, { tools: [], mcpConfig: { child: {} } })).toEqual([]);
  expect(scopeDelegationTools([{ name: 'workflow' }], new SubAgentScope({ tools: true, mcp_servers: true }))[0]?.params).toEqual({ sub_agent_scope: { tools: true } });
});
it('keeps conversation-local tools unless their effective registration replaces that identity', () => {
  const scope = new SubAgentScope({ tools: true });
  expect(scope.missingFrom({ tools: [] }, { tools: ['task_tracker', 'unknown'] })).toEqual(['unknown']);
  globalToolRegistry.register('task_tracker', new ToolDefinition({ name: 'task_tracker', description: 'host override', inputSchema: z.object({}), outputSchema: z.object({}), executor: () => ({}) }));
  expect(scope.missingFrom({ tools: [] }, { tools: ['task_tracker'] })).toEqual(['task_tracker']);
});
it('copies exactly the resolved parent MCP map, discarding child configuration without shared nested values', () => {
  const parent = { tools: [], mcpConfig: { inherited: { headers: { Authorization: 'fixture-only' } } } };
  const child = { tools: ['task_tracker'], mcpConfig: { child: { url: 'https://example.invalid' } }, name: 'child' };
  const result = inheritMcpConfig(parent, child);
  expect(result).toEqual({ ...child, mcpConfig: parent.mcpConfig });
  parent.mcpConfig.inherited.headers.Authorization = 'after';
  expect(result.mcpConfig).toEqual({ inherited: { headers: { Authorization: 'fixture-only' } } });
  expect(child.mcpConfig).toHaveProperty('child');
  expect(inheritMcpConfig({ tools: [] }, child).mcpConfig).toEqual({});
});
