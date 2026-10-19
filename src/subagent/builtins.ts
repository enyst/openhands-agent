import { AgentDefinition } from './index.js';
import { builtinAgentCatalog, builtinAgentSource } from './builtin-catalog.js';

export const BUILTIN_AGENT_SOURCE = builtinAgentSource;

/** Read-only source definitions. This never registers, constructs, or executes an agent. */
export function discoverBuiltinAgents(options: { readonly enableBrowser?: boolean } = {}): AgentDefinition[] {
  return builtinAgentCatalog
    .filter(definition => options.enableBrowser !== false || definition.name !== 'web-researcher')
    .map(definition => new AgentDefinition(structuredClone(definition)));
}
