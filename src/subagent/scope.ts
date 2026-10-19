import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ToolSpec } from '../tool/index.js';
import { canonicalToolName } from '../tool/defaults.js';

export const SUB_AGENT_SCOPE_PARAM = 'sub_agent_scope';
export const DELEGATION_TOOL_NAMES = ['task_tool_set', 'workflow_tool_set', 'workflow'] as const;
export const subAgentScopeSchema = z.object({ tools: z.boolean().default(false), mcp_servers: z.boolean().default(false) }).strict();

/** Host-supplied capabilities of the actual built agent, not merely its declared profile. */
export interface AgentCapabilitySnapshot {
  readonly tools: readonly string[];
  readonly includeDefaultTools?: readonly string[];
  readonly mcpConfig?: Readonly<Record<string, unknown>> | null;
}

/** Pure scope primitives. A delegation executor must enforce them before starting a child. */
export class SubAgentScope {
  readonly tools: boolean;
  readonly mcp_servers: boolean;

  constructor(data: z.input<typeof subAgentScopeSchema> = {}) {
    const scope = subAgentScopeSchema.parse(data);
    this.tools = scope.tools;
    this.mcp_servers = scope.mcp_servers;
    Object.freeze(this);
  }

  get restricts(): boolean { return this.tools || this.mcp_servers; }

  missingFrom(parent: AgentCapabilitySnapshot, child: AgentCapabilitySnapshot): string[] {
    const missing: string[] = [];
    if (this.tools) {
      const parentTools = names(parent);
      missing.push(...[...names(child)].filter(name => !parentTools.has(name)).sort());
    }
    if (this.mcp_servers) {
      const parentServers = parent.mcpConfig ?? {};
      for (const name of Object.keys(child.mcpConfig ?? {}).sort()) {
        if (!Object.hasOwn(parentServers, name) || !isDeepStrictEqual(parentServers[name], child.mcpConfig?.[name])) {
          missing.push(`MCP server '${name}'`);
        }
      }
    }
    return missing;
  }
}

function names(agent: AgentCapabilitySnapshot): Set<string> {
  return new Set([...agent.tools, ...(agent.includeDefaultTools ?? [])].map(canonicalToolName));
}

export function scopeDelegationTools(tools: readonly ToolSpec[], scope: SubAgentScope): ToolSpec[] {
  if (!scope.restricts) return [...tools];
  return tools.map(tool => {
    if (!(DELEGATION_TOOL_NAMES as readonly string[]).includes(canonicalToolName(tool.name))) return tool;
    const current = subAgentScopeSchema.parse(tool.params?.[SUB_AGENT_SCOPE_PARAM] ?? {});
    return { ...tool, params: { ...tool.params, [SUB_AGENT_SCOPE_PARAM]: {
      tools: current.tools || scope.tools, mcp_servers: current.mcp_servers || scope.mcp_servers,
    } } };
  });
}
