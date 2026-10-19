import type { AgentContextOptions } from '../context/agent-context.js';
import type { AgentSettings } from '../settings/index.js';
import { profileVerificationSettingsSchema, validateAgentProfile, type AgentProfile } from './index.js';

export const SEED_PROFILE_NAME = 'default';
export interface SeedProfileOptions {
  readonly name?: string;
  /** Native hosts hold context separately from credential-free persisted settings. */
  readonly context?: Pick<AgentContextOptions, 'disabledSkills' | 'systemMessageSuffix'>;
}

/** Project validated live settings and native context into a secret-free default profile. */
export function buildSeedProfile(settings: AgentSettings, activeLlmProfile: string | null, options: SeedProfileOptions = {}): AgentProfile {
  const name = options.name ?? SEED_PROFILE_NAME;
  if (settings.agent_kind === 'acp') {
    return validateAgentProfile({ name, agent_kind: 'acp', acp_server: settings.acp_server,
      acp_model: settings.acp_model, acp_session_mode: settings.acp_session_mode,
      acp_prompt_timeout: settings.acp_prompt_timeout, acp_startup_timeout: settings.acp_startup_timeout,
      acp_command: settings.acp_command.length === 0 ? null : settings.acp_command.map(quoteShellWord).join(' '),
      acp_args: settings.acp_args.length === 0 ? null : [...settings.acp_args], mcp_server_refs: null });
  }
  return validateAgentProfile({ name, agent_kind: 'openhands', llm_profile_ref: activeLlmProfile || SEED_PROFILE_NAME,
    agent: settings.agent, tools: settings.tools, disabled_skills: [...(options.context?.disabledSkills ?? [])],
    persona: settings.persona, system_message_suffix: options.context?.systemMessageSuffix ?? null,
    condenser: structuredClone(settings.condenser),
    ...(settings.hard_condenser === undefined ? {} : { hard_condenser: structuredClone(settings.hard_condenser) }),
    verification: profileVerificationSettingsSchema.parse(settings.verification),
    enable_classify_and_switch_llm_tool: settings.enable_classify_and_switch_llm_tool,
    meta_profile_ref: settings.active_meta_profile, tool_concurrency_limit: settings.tool_concurrency_limit,
    mcp_server_refs: null });
}

function quoteShellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\"'\"'")}'`;
}
