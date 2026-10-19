import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { discoverBuiltinAgents, BUILTIN_AGENT_SOURCE } from '../builtins.js';
import { getRegisteredAgentDefinitions, registerAgent, resetAgentRegistryForTests } from '../index.js';

it('discovers the four pinned definitions without registering or constructing an agent', () => {
  resetAgentRegistryForTests(); registerAgent('host-owned', () => { throw new Error('must not run'); }, 'host');
  const definitions = discoverBuiltinAgents();
  expect(definitions.map(definition => definition.name)).toEqual(['bash-runner', 'code-explorer', 'general-purpose', 'web-researcher']);
  expect(definitions.every(definition => definition.level === 'builtin' && definition.system_prompt.length > 0)).toBe(true);
  expect(getRegisteredAgentDefinitions().map(definition => definition.name)).toEqual(['host-owned']);
  const manifest = JSON.parse(readFileSync(new URL('../../../transpile/upstream.json', import.meta.url), 'utf8')) as { commit: string };
  expect(BUILTIN_AGENT_SOURCE.commit).toBe(manifest.commit);
  expect(definitions.find(definition => definition.name === 'general-purpose')?.tools).toEqual(['terminal', 'file_editor', 'task_tracker']);
  expect(definitions.find(definition => definition.name === 'web-researcher')?.mcp_config).toMatchObject({ tavily: { env: { TAVILY_API_KEY: '${TAVILY_API_KEY}' }, enabled: true } });
});

it('filters only browser-dependent builtins and returns independent copies', () => {
  expect(discoverBuiltinAgents({ enableBrowser: false }).map(definition => definition.name)).toEqual(['bash-runner', 'code-explorer', 'general-purpose']);
  const first = discoverBuiltinAgents(); first[0]!.tools.push('mutation');
  first.find(definition => definition.name === 'web-researcher')!.mcp_config!.tavily = {};
  const next = discoverBuiltinAgents();
  expect(next[0]!.tools).toEqual(['terminal']);
  expect(next.find(definition => definition.name === 'web-researcher')!.mcp_config!.tavily).toHaveProperty('command', 'npx');
});
