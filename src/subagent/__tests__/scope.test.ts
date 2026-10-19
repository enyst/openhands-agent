import { describe, expect, it, afterEach } from 'vitest';
import { SubAgentScope, scopeDelegationTools } from '../scope.js';
import { getFactoryInfo, registerAgent, resetAgentRegistryForTests, AgentDefinition } from '../index.js';

afterEach(resetAgentRegistryForTests);
describe('bounded sub-agent capability snapshots', () => {
  it('defaults unrestricted and rejects unknown axes', () => {
    expect(new SubAgentScope().restricts).toBe(false);
    expect(() => new SubAgentScope({ unknown: true } as never)).toThrow();
    expect(Object.isFrozen(new SubAgentScope())).toBe(true);
  });
  it('compares canonical tools and exact MCP configuration, sorted', () => {
    const scope = new SubAgentScope({ tools: true, mcp_servers: true });
    expect(scope.missingFrom({ tools: ['finish'], mcpConfig: { same: { url: 'a', headers: { X: '1' } } } }, {
      tools: ['FinishTool', 'z', 'a'], mcpConfig: { same: { headers: { X: '2' }, url: 'a' }, other: {} },
    })).toEqual(['a', 'z', "MCP server 'other'", "MCP server 'same'"]);
    expect(scope.missingFrom({ tools: [], mcpConfig: { same: { a: 1, b: 2 } } }, { tools: [], mcpConfig: { same: { b: 2, a: 1 } } })).toEqual([]);
  });
  it('narrows only delegation tools monotonically without mutating callers', () => {
    const input = [{ name: 'task_tool_set', params: { custom: 1, sub_agent_scope: { tools: true } } }, { name: 'workflow', params: {} }, { name: 'terminal', params: {} }];
    const scoped = scopeDelegationTools(input, new SubAgentScope({ mcp_servers: true }));
    expect(scoped[0]?.params).toEqual({ custom: 1, sub_agent_scope: { tools: true, mcp_servers: true } });
    expect(scoped[1]?.params).toEqual({ sub_agent_scope: { tools: false, mcp_servers: true } });
    expect(scoped[2]).toBe(input[2]);
    expect(input[0]?.params.sub_agent_scope).toEqual({ tools: true });
  });
  it('filters the registry description without calling factories', () => {
    registerAgent('safe', () => { throw new Error('must not execute'); }, new AgentDefinition({ name: 'safe', tools: ['terminal'] }));
    registerAgent('wide', () => { throw new Error('must not execute'); }, 'wide');
    expect(getFactoryInfo(def => def.name === 'safe')).toContain('**safe**');
    expect(getFactoryInfo(def => def.name === 'safe')).not.toContain('**wide**');
    expect(getFactoryInfo(() => false)).toContain('No user-registered agents');
  });
});
