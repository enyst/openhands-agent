import type { Agent } from '../../agent/index.js';
import { ensureLlmHistoryOrigin } from '../../llm/history.js';
import type { ConversationState } from '../state.js';

/** EXT-SDK-003: host preparation runs only outside a model/tool batch. */
export type AgentStepBoundary = (agent: Agent) => Promise<Agent | void> | Agent | void;

export async function applyAgentStepBoundary(
  agent: Agent,
  state: ConversationState,
  callback: AgentStepBoundary | undefined,
): Promise<Agent> {
  if (callback === undefined) return agent;
  // Capture old-profile provenance before a host can activate a replacement.
  await ensureLlmHistoryOrigin(state, agent.llm.profile);
  return await callback(agent) ?? agent;
}
