import { z } from 'zod';
import { Agent } from '../agent/agent.js';
import { AgentContext, type AgentContextOptions } from '../context/agent-context.js';
import { llmProfileSchema, type LLMProfile } from '../llm/index.js';
import type { LLMClient } from '../llm/client.js';
import { metaProfileSchema, type MetaProfile } from '../meta-profiles/index.js';
import { validateAgentProfile, type AgentProfile, type OpenHandsAgentProfile } from '../profiles/index.js';
import { validateAgentSettings, materializeCondenser, materializeHardCondenser, type OpenHandsAgentSettings } from '../settings/index.js';
import { Skill } from '../skills/index.js';
import { SubAgentScope, scopeDelegationTools } from '../subagent/scope.js';
import { globalToolRegistry, resolveTool, type ToolDefinition, type ToolSpec } from '../tool/index.js';
import { canonicalToolName, launchToolSpecs, resolveToolSpecs } from '../tool/defaults.js';
import '../tool/builtins.js';

export class AgentLaunchError extends Error {
  readonly code: string = 'invalid_agent_launch';
  toDetail(): Record<string, unknown> { return { code: this.code, message: this.message }; }
}
export class ProfileNotFound extends AgentLaunchError { override readonly code = 'agent_profile_not_found'; }
export class LaunchStoreError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}
export class UnresolvedProfileReferences extends AgentLaunchError {
  override readonly code = 'unresolved_profile_references';
  readonly llmProfileRef: string | null;
  readonly mcpServerRefs: readonly string[];
  readonly metaProfileRef: string | null;
  readonly metaProfileLlmRefs: readonly string[];
  readonly condenserLlmRefs: readonly string[];
  readonly problems: readonly string[];
  constructor(refs: { llmProfileRef?: string | null; mcpServerRefs?: readonly string[]; metaProfileRef?: string | null; metaProfileLlmRefs?: readonly string[]; condenserLlmRefs?: readonly string[] } = {}) {
    const problems: string[] = [];
    if (refs.llmProfileRef) problems.push(`LLM profile '${refs.llmProfileRef}' not found`);
    if (refs.mcpServerRefs?.length) problems.push(`MCP server(s) not configured: ${refs.mcpServerRefs.join(', ')}`);
    if (refs.metaProfileRef) problems.push(`Meta-profile '${refs.metaProfileRef}' not found`);
    if (refs.metaProfileLlmRefs?.length) problems.push(`LLM profile(s) routed to by the meta-profile not found: ${refs.metaProfileLlmRefs.join(', ')}`);
    if (refs.condenserLlmRefs?.length) problems.push(`Condenser LLM profile(s) not found: ${refs.condenserLlmRefs.join(', ')}`);
    super(problems.join('; '));
    this.llmProfileRef = refs.llmProfileRef ?? null;
    this.mcpServerRefs = [...new Set(refs.mcpServerRefs ?? [])];
    this.metaProfileRef = refs.metaProfileRef ?? null;
    this.metaProfileLlmRefs = [...new Set(refs.metaProfileLlmRefs ?? [])];
    this.condenserLlmRefs = [...new Set(refs.condenserLlmRefs ?? [])];
    this.problems = problems;
  }
  override toDetail(): Record<string, unknown> {
    return { ...super.toDetail(), dangling_llm_profile_ref: this.llmProfileRef,
      dangling_mcp_server_refs: this.mcpServerRefs, dangling_meta_profile_ref: this.metaProfileRef,
      dangling_meta_profile_llm_refs: this.metaProfileLlmRefs, dangling_condenser_llm_refs: this.condenserLlmRefs };
  }
}

type Awaitable<T> = T | Promise<T>;
export interface LaunchStores {
  readonly llmProfiles: { load(name: string): Awaitable<LLMProfile | null> };
  readonly mcpConfig: Readonly<Record<string, unknown>>;
  readonly skills: () => Awaitable<readonly Skill[]>;
  readonly agentProfiles?: { nameForId(id: string): Awaitable<string | null>; load(name: string): Awaitable<AgentProfile | null> };
  readonly metaProfiles?: { load(name: string): Awaitable<MetaProfile | null> };
  readonly llmProfileNames?: () => Awaitable<readonly string[]>;
  /** Explicit native host choice, never an implicit reuse of the main client. */
  readonly defaultCondenserProfileRef?: string;
}
export interface LaunchedAgentProfile {
  readonly agent_profile_id: string;
  readonly revision: number;
  readonly secret_refs: readonly string[] | null;
}
export type LaunchClientRole = 'main' | 'condenser' | 'hard_condenser';
export type LaunchLlmBindings = Readonly<Partial<Record<LaunchClientRole, LLMProfile>>>;

export interface ResolvedLaunchOptions {
  readonly settings: OpenHandsAgentSettings;
  readonly llmProfiles: Readonly<Record<string, LLMProfile>>;
  readonly context?: AgentContextOptions | null;
  /** Durable role snapshots may share a saved profile ID while retaining different historical configurations. */
  readonly bindings?: LaunchLlmBindings;
  readonly profile?: LaunchedAgentProfile | null;
}

/** Immutable data snapshots; no store or credential resolver crosses this boundary. */
export class ResolvedLaunch {
  readonly settings: OpenHandsAgentSettings;
  readonly llmProfiles: Readonly<Record<string, LLMProfile>>;
  readonly context: AgentContext | null;
  readonly bindings: LaunchLlmBindings;
  readonly profile: LaunchedAgentProfile | null;
  constructor(options: ResolvedLaunchOptions) {
    const settings = validateAgentSettings(copy(options.settings));
    if (settings.agent_kind !== 'openhands') throw new AgentLaunchError('ACP execution is not supported by the native launch runtime (DEV-SDK-005).');
    this.settings = freeze(settings);
    this.llmProfiles = freeze(Object.fromEntries(Object.entries(options.llmProfiles).map(([name, profile]) => [name, llmProfileSchema.parse(copy(profile))])));
    this.bindings = freeze(Object.fromEntries(Object.entries(options.bindings ?? {}).map(([role, profile]) => [role, llmProfileSchema.parse(copy(profile))])));
    this.context = (options.context === null || options.context === undefined) ? null : freeze(cloneContext(options.context));
    this.profile = (options.profile === null || options.profile === undefined) ? null : freeze(copy(options.profile));
    Object.freeze(this);
  }
  get allowedSecrets(): ReadonlySet<string> | null { return (this.profile?.secret_refs === null || this.profile?.secret_refs === undefined) ? null : new Set(this.profile.secret_refs); }
}

export async function resolveLaunch(source: AgentProfile | string, stores: LaunchStores): Promise<ResolvedLaunch> {
  let loaded: AgentProfile | null;
  if (typeof source === 'string') {
    if (!stores.agentProfiles) throw new ProfileNotFound(`Agent profile with id '${source}' not found`);
    const name = await readStore('Agent profile', () => stores.agentProfiles!.nameForId(source));
    loaded = name === null ? null : await readStore('Agent profile', () => stores.agentProfiles!.load(name));
    if (loaded === null) throw new ProfileNotFound(`Agent profile with id '${source}' not found`);
  } else loaded = source;
  let profile: AgentProfile;
  try { profile = validateAgentProfile(copy(loaded)); }
  catch { throw new AgentLaunchError('Invalid agent profile'); }
  if (profile.agent_kind !== 'openhands') throw new AgentLaunchError('ACP execution is not supported by the native launch runtime (DEV-SDK-005).');
  const mcp = filterMcp(stores.mcpConfig, profile.mcp_server_refs);
  const catalog = await loadSkills(stores);
  const context: AgentContextOptions = { skills: deduplicateSkills(catalog, profile.disabled_skills), disabledSkills: profile.disabled_skills,
    systemMessageSuffix: profile.system_message_suffix };
  const settings = validateAgentSettings({ llm_profile_ref: profile.llm_profile_ref, agent: profile.agent,
    tools: profile.tools === null ? null : scopeDelegationTools(profile.tools, new SubAgentScope({ tools: true, mcp_servers: profile.mcp_server_refs !== null })),
    persona: profile.persona, mcp_config: mcp.config, condenser: profile.condenser, verification: profile.verification,
    enable_classify_and_switch_llm_tool: profile.enable_classify_and_switch_llm_tool, active_meta_profile: profile.meta_profile_ref,
    tool_concurrency_limit: profile.tool_concurrency_limit });
  if (settings.agent_kind !== 'openhands') throw new AgentLaunchError('Invalid native settings');
  return resolveSettings(settings, stores, context, { agent_profile_id: profile.id, revision: profile.revision, secret_refs: profile.secret_refs }, mcp.dangling);
}

/** Settings-based callers enter the same snapshot/finalize pipeline as profiles. */
export async function resolveSettingsLaunch(data: unknown, stores: LaunchStores, context: AgentContextOptions | null = null): Promise<ResolvedLaunch> {
  const settings = validateAgentSettings(data);
  if (settings.agent_kind !== 'openhands') throw new AgentLaunchError('ACP execution is not supported by the native launch runtime (DEV-SDK-005).');
  return resolveSettings(settings, stores, context, null, []);
}

async function resolveSettings(settings: OpenHandsAgentSettings, stores: LaunchStores, context: AgentContextOptions | null, profile: LaunchedAgentProfile | null, danglingMcp: readonly string[]): Promise<ResolvedLaunch> {
  const llms: Record<string, LLMProfile> = Object.create(null) as Record<string, LLMProfile>;
  const main = await loadLlm(stores, settings.llm_profile_ref);
  if (main !== null) llms[settings.llm_profile_ref] = main;
  let meta: MetaProfile | null = settings.meta_profile;
  let danglingMeta: string | null = null;
  const danglingMetaLlms: string[] = [];
  const routedLlms: Record<string, LLMProfile> = Object.create(null) as Record<string, LLMProfile>;
  if (settings.enable_classify_and_switch_llm_tool) {
    for (const [name, inline] of Object.entries(settings.meta_profile_llms)) {
      routedLlms[name] = llmProfileSchema.parse({ ...copy(inline), profileId: name });
    }
    if (settings.active_meta_profile !== null && meta === null) {
      meta = stores.metaProfiles ? await readStore('Meta-profile', () => stores.metaProfiles!.load(settings.active_meta_profile!)) : null;
      if (meta === null) danglingMeta = settings.active_meta_profile;
    }
    if (meta !== null) {
      try { meta = metaProfileSchema.parse(copy(meta)); }
      catch { throw new LaunchStoreError('Could not load meta-profile'); }
      for (const name of new Set([meta.classifier_model, ...meta.classes.map(cls => cls.model)])) {
        const inline = settings.meta_profile_llms[name];
        const llm = inline === undefined ? await loadLlm(stores, name) : llmProfileSchema.parse({ ...copy(inline), profileId: name });
        if (llm === null) danglingMetaLlms.push(name); else { routedLlms[name] = llm; if (!Object.hasOwn(llms, name) && inline === undefined) llms[name] = llm; }
      }
      if (meta.prompt_template !== null && stores.llmProfileNames) {
        const names = await readStore('LLM profile', stores.llmProfileNames, false);
        for (const name of names ?? []) {
          if (Object.hasOwn(routedLlms, name)) continue;
          try { const llm = await loadLlm(stores, name); if (llm !== null) { routedLlms[name] = llm; if (!Object.hasOwn(llms, name)) llms[name] = llm; } }
          catch (error) { if (!(error instanceof LaunchStoreError || error instanceof AgentLaunchError)) throw error; }
        }
      }
    }
  }
  const condenserRefs: string[] = [];
  const condenser = settings.condenser;
  let resolvedCondenser = condenser;
  let missingCondenserSelection = false;
  if (condenser.enabled && condenser.condenser_kind === 'llm_summarizing') {
    const ref = condenser.llm_profile_ref ?? stores.defaultCondenserProfileRef;
    if (!ref) missingCondenserSelection = true;
    else { condenserRefs.push(ref); resolvedCondenser = { ...condenser, llm_profile_ref: ref }; }
  }
  if (settings.hard_condenser) condenserRefs.push(settings.hard_condenser.llm_profile_ref);
  const danglingCondensers: string[] = [];
  for (const name of new Set(condenserRefs)) {
    if (Object.hasOwn(llms, name)) continue;
    const llm = await loadLlm(stores, name);
    if (llm === null) danglingCondensers.push(name); else llms[name] = llm;
  }
  if (main === null || danglingMcp.length || danglingMeta !== null || danglingMetaLlms.length || danglingCondensers.length) {
    throw new UnresolvedProfileReferences({ llmProfileRef: main === null ? settings.llm_profile_ref : null, mcpServerRefs: danglingMcp,
      metaProfileRef: danglingMeta, metaProfileLlmRefs: danglingMetaLlms, condenserLlmRefs: danglingCondensers });
  }
  if (missingCondenserSelection) throw new AgentLaunchError('Enabled LLM condenser requires llm_profile_ref or an explicit host defaultCondenserProfileRef.');
  return new ResolvedLaunch({ settings: { ...settings, condenser: resolvedCondenser, meta_profile: meta,
    meta_profile_llms: settings.enable_classify_and_switch_llm_tool ? { ...routedLlms } : copy(settings.meta_profile_llms) }, llmProfiles: llms, context, profile });
}

async function loadLlm(stores: LaunchStores, name: string): Promise<LLMProfile | null> {
  const profile = await readStore('LLM profile', () => stores.llmProfiles.load(name));
  if (profile === null) return null;
  try { return llmProfileSchema.parse({ ...copy(profile), profileId: name }); }
  catch { throw new LaunchStoreError('Could not load LLM profile'); }
}
async function readStore<T>(label: string, load: () => Awaitable<T | null>, missingIsNull = true): Promise<T | null> {
  try { return await load(); }
  catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
    if (code === 'ENOENT' && missingIsNull) return null;
    const busy = code === 'ETIMEDOUT' || (error instanceof Error && error.name === 'TimeoutError');
    throw new LaunchStoreError(busy ? `${label} store is busy` : `Could not load ${label.toLowerCase()}`, busy);
  }
}
async function loadSkills(stores: LaunchStores): Promise<Skill[]> {
  try { return (await stores.skills()).map(cloneSkill); }
  catch { throw new LaunchStoreError('Skill discovery failed'); }
}
function filterMcp(config: Readonly<Record<string, unknown>>, refs: readonly string[] | null): { config: Record<string, unknown>; dangling: string[] } {
  const names = refs === null ? Object.keys(config) : [...new Set(refs)];
  return { config: Object.fromEntries(names.filter(name => Object.hasOwn(config, name)).map(name => [name, copy(config[name])])), dangling: names.filter(name => !Object.hasOwn(config, name)) };
}
function deduplicateSkills(skills: readonly Skill[], disabled: readonly string[]): Skill[] {
  const selected = new Map<string, Skill>();
  for (const skill of skills) selected.set(skill.name, cloneSkill(skill));
  return [...selected.values()].filter(skill => !disabled.includes(skill.name));
}

export interface LaunchToolContext {
  readonly settings: OpenHandsAgentSettings;
  readonly llm: LLMClient;
  readonly llmProfiles: Readonly<Record<string, LLMProfile>>;
}
export interface LaunchRuntime {
  readonly browserAvailable?: boolean;
  readonly createClient: (profile: LLMProfile, role: LaunchClientRole) => Awaitable<LLMClient>;
  /** Binds selected native tools, MCP and optional routing callbacks; must not call a completion. */
  readonly materializeTools?: (specs: readonly ToolSpec[], context: LaunchToolContext) => Awaitable<readonly ToolDefinition[]>;
  readonly toolContext?: unknown;
  readonly isToolAvailable?: (name: string) => boolean;
  readonly loadMemory?: () => Awaitable<string | null>;
  readonly apiKeyAvailable?: (profile: LLMProfile) => Awaitable<boolean>;
}
export const agentLaunchAdditionsSchema = z.object({ system_message_suffix_append: z.string().max(32768).nullable().default(null) }).strict();
export type AgentLaunchAdditions = z.input<typeof agentLaunchAdditionsSchema>;
export interface FinalizeLaunchOptions {
  readonly additions?: AgentLaunchAdditions | null;
  readonly extraSuffixes?: readonly string[];
  readonly clientTools?: readonly ToolDefinition[];
  readonly loadMemory?: boolean;
  readonly managedSecrets?: readonly string[];
  readonly launchedAt?: Date;
}
const FINALIZE_TOKEN = Symbol('finalize launch');
export class LaunchedAgent {
  constructor(readonly agent: Agent, readonly profile: LaunchedAgentProfile | null, token?: symbol) {
    if (token !== FINALIZE_TOKEN) throw new TypeError('LaunchedAgent is built only by finalizeLaunch()');
    Object.freeze(this);
  }
}

export async function finalizeLaunch(source: ResolvedLaunch | Agent, runtime: LaunchRuntime, options: FinalizeLaunchOptions = {}): Promise<LaunchedAgent> {
  let agent: Agent;
  const profile = source instanceof ResolvedLaunch ? source.profile : null;
  if (source instanceof ResolvedLaunch) {
    const settings = copy(source.settings);
    if (settings.verification.critic_enabled || settings.verification.enable_iterative_refinement) throw new AgentLaunchError('Enabled verification requires the native critic execution lifecycle, which is not yet implemented');
    const main = source.bindings.main ?? source.llmProfiles[settings.llm_profile_ref];
    if (main === undefined) throw new AgentLaunchError('Main LLM profile snapshot is missing');
    if (main.profileId !== settings.llm_profile_ref) throw new AgentLaunchError('Main LLM profile snapshot does not match the selected reference');
    if (hasMcp(settings.mcp_config) && !runtime.materializeTools) throw new AgentLaunchError('MCP configuration requires a native host tool materializer');
    const llm = await runtime.createClient(copy(main), 'main');
    let specs = launchToolSpecs(settings.tools, { browserAvailable: runtime.browserAvailable ?? false });
    // A router is selected through settings independently of the ordinary selected tool list.
    if (settings.enable_classify_and_switch_llm_tool) {
      specs = specs.filter(spec => canonicalToolName(spec.name) !== 'route_task_to_model');
      specs.push({ name: 'route_task_to_model', params: {
        ...(settings.active_meta_profile ? { active_meta_profile: settings.active_meta_profile } : {}),
        ...(settings.meta_profile ? { meta_profile: settings.meta_profile } : {}),
        ...(Object.keys(settings.meta_profile_llms).length ? { meta_profile_llms: settings.meta_profile_llms } : {}),
      } });
    }
    let tools: readonly ToolDefinition[];
    try {
      tools = runtime.materializeTools ? await runtime.materializeTools(specs, { settings, llm, llmProfiles: copy(source.llmProfiles) })
        : specs.flatMap(spec => resolveTool(spec, runtime.toolContext));
    } catch { throw new AgentLaunchError('Selected tools could not be materialized'); }
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    for (const name of ['finish', 'think']) if (!byName.has(name)) for (const tool of resolveTool({ name, params: {} }, runtime.toolContext)) byName.set(tool.name, tool);
    const resolveRoleClient = async (name: string, role: 'condenser' | 'hard_condenser'): Promise<LLMClient> => {
      const selected = source.bindings[role] ?? source.llmProfiles[name];
      if (selected === undefined) throw new AgentLaunchError('Condenser LLM profile snapshot is missing');
      if (selected.profileId !== name) throw new AgentLaunchError('Condenser LLM profile snapshot does not match the selected reference');
      return runtime.createClient(copy(selected), role);
    };
    const condenser = await materializeCondenser(settings.condenser, { resolveClient: name => resolveRoleClient(name, 'condenser'), agentLlm: llm,
      ...(source.bindings.condenser === undefined ? {} : { defaultProfileRef: source.bindings.condenser.profileId }) });
    const hardCondenser = await materializeHardCondenser(settings.hard_condenser, { resolveClient: name => resolveRoleClient(name, 'hard_condenser'), agentLlm: llm });
    agent = new Agent({ llm, tools: [...byName.values()], context: source.context === null ? null : cloneContext(source.context),
      condenser, hardCondenser, toolConcurrencyLimit: settings.tool_concurrency_limit, persona: settings.persona });
  } else agent = source;

  let context = agent.context === null ? null : cloneContext(agent.context);
  const ensureContext = (): AgentContext => context ?? new AgentContext({ currentDatetime: null });
  if (context !== null && isTimestamp(context.currentDatetime)) context = cloneContext({ ...context, currentDatetime: options.launchedAt ?? nowWithOffset(context.currentDatetime) });
  const additions = (options.additions === null || options.additions === undefined) ? null : agentLaunchAdditionsSchema.parse(options.additions);
  const suffixes: string[] = [];
  if (options.loadMemory) {
    if (!runtime.loadMemory) throw new AgentLaunchError('Loading memory requires a native memory loader');
    const memory = await runtime.loadMemory(); if (memory?.trim()) suffixes.push(memory.trim());
  }
  suffixes.push(additions?.system_message_suffix_append ?? '', ...(options.extraSuffixes ?? []));
  for (const suffix of suffixes) {
    if (!suffix.trim()) continue;
    const current = ensureContext();
    context = cloneContext({ ...current, systemMessageSuffix: [current.systemMessageSuffix?.trim(), suffix.trim()].filter(Boolean).join('\n\n') });
  }
  if (context?.secrets !== null && context?.secrets !== undefined) {
    const excluded = new Set(options.managedSecrets ?? []);
    const allowed = source instanceof ResolvedLaunch ? source.allowedSecrets : null;
    context = cloneContext({ ...context, secrets: Object.fromEntries(Object.entries(context.secrets).filter(([name]) => !excluded.has(name) && (allowed === null || allowed.has(name)))) });
  }
  const tools = new Map(agent.tools.map(tool => [tool.name, tool]));
  for (const tool of options.clientTools ?? []) if (!tools.has(tool.name)) tools.set(tool.name, tool);
  const selectedTools = [...tools.values()];
  const unchanged = context === agent.context && selectedTools.length === agent.tools.length && selectedTools.every((tool, index) => tool === agent.tools[index]);
  const result = unchanged ? agent : agent.withOverrides({ tools: selectedTools, context });
  return new LaunchedAgent(result, profile, FINALIZE_TOKEN);
}

export interface AgentProfileDiagnostics {
  readonly agent_kind: string;
  valid: boolean;
  errors: string[];
  unusable_tools: string[];
  llm_profile_ref: string | null;
  llm_profile_resolved: boolean;
  llm_api_key_set: boolean;
  mcp_server_refs: readonly string[] | null;
  resolved_mcp_config_keys: string[];
  dangling_mcp_server_refs: string[];
  disabled_skills: readonly string[];
  resolved_skills: string[];
  secret_refs: readonly string[] | null;
  meta_profile_ref: string | null;
  dangling_meta_profile_ref: string | null;
  dangling_meta_profile_llm_refs: string[];
  resolved_settings: Record<string, unknown> | null;
}
export async function previewLaunch(source: OpenHandsAgentProfile | AgentProfile, stores: LaunchStores, runtime: LaunchRuntime, options: Pick<FinalizeLaunchOptions, 'loadMemory'> = {}): Promise<AgentProfileDiagnostics> {
  const profile = validateAgentProfile(source);
  const native = profile.agent_kind === 'openhands' ? profile : null;
  const mcp = filterMcp(stores.mcpConfig, profile.mcp_server_refs);
  const diagnostics: AgentProfileDiagnostics = { agent_kind: profile.agent_kind, valid: false, errors: [], unusable_tools: [],
    llm_profile_ref: native?.llm_profile_ref ?? null, llm_profile_resolved: false, llm_api_key_set: false,
    mcp_server_refs: profile.mcp_server_refs, resolved_mcp_config_keys: Object.keys(mcp.config), dangling_mcp_server_refs: mcp.dangling,
    disabled_skills: native?.disabled_skills ?? [], resolved_skills: [], secret_refs: profile.secret_refs,
    meta_profile_ref: native?.meta_profile_ref ?? null, dangling_meta_profile_ref: null, dangling_meta_profile_llm_refs: [], resolved_settings: null };
  if (native) diagnostics.unusable_tools = resolveToolSpecs(native.tools).map(tool => tool.name).filter(name => name === 'browser_tool_set'
    ? !runtime.browserAvailable : !(runtime.isToolAvailable?.(name) ?? globalToolRegistry.isToolAvailable(name)));
  const failingTools = diagnostics.unusable_tools.filter(name => name !== 'browser_tool_set');
  if (failingTools.length) diagnostics.errors.push(`Tool(s) this server cannot run: ${failingTools.join(', ')}`);
  try {
    const resolved = await resolveLaunch(profile, stores);
    diagnostics.llm_profile_resolved = true;
    diagnostics.resolved_skills = resolved.context?.skills.map(skill => skill.name) ?? [];
    const main = resolved.llmProfiles[resolved.settings.llm_profile_ref]!;
    diagnostics.llm_api_key_set = await runtime.apiKeyAvailable?.(copy(main)) ?? false;
    const launched = await finalizeLaunch(resolved, runtime, options);
    diagnostics.resolved_skills = launched.agent.context?.skills.map(skill => skill.name) ?? [];
    diagnostics.valid = diagnostics.errors.length === 0;
    if (diagnostics.valid) diagnostics.resolved_settings = redactedSettings({ ...resolved.settings, tools: launchToolSpecs(resolved.settings.tools, { browserAvailable: runtime.browserAvailable ?? false }) }, launched.agent.context);
  } catch (error) {
    if (error instanceof UnresolvedProfileReferences) {
      diagnostics.errors.push(...error.problems); diagnostics.dangling_meta_profile_ref = error.metaProfileRef;
      diagnostics.dangling_meta_profile_llm_refs = [...error.metaProfileLlmRefs];
      if (native) {
        try {
          const main = await loadLlm(stores, native.llm_profile_ref);
          diagnostics.llm_profile_resolved = main !== null;
          if (main !== null) diagnostics.llm_api_key_set = await runtime.apiKeyAvailable?.(copy(main)) ?? false;
          diagnostics.resolved_skills = deduplicateSkills(await loadSkills(stores), native.disabled_skills).map(skill => skill.name);
        } catch { /* Keep the original structured dangling-reference result. */ }
      }
    } else diagnostics.errors.push(error instanceof AgentLaunchError || error instanceof LaunchStoreError ? error.message : 'Agent launch failed');
  }
  return diagnostics;
}

export type NormalizedLaunchSource = { readonly kind: 'agent'; readonly agent: Agent } | { readonly kind: 'profile'; readonly id: string } | { readonly kind: 'settings'; readonly settings: unknown };
export function normalizeLaunchSource(input: { readonly agent?: Agent | null; readonly agentSettings?: unknown; readonly agentProfileId?: string | null }): NormalizedLaunchSource {
  if ((input.agentProfileId !== null && input.agentProfileId !== undefined)) {
    if ((input.agent !== null && input.agent !== undefined) || (input.agentSettings !== null && input.agentSettings !== undefined)) throw new AgentLaunchError('agentProfileId is mutually exclusive with agent and agentSettings');
    if (!input.agentProfileId.trim()) throw new AgentLaunchError('agentProfileId must not be empty');
    return { kind: 'profile', id: input.agentProfileId };
  }
  if ((input.agent !== null && input.agent !== undefined)) return { kind: 'agent', agent: input.agent };
  if ((input.agentSettings !== null && input.agentSettings !== undefined)) return { kind: 'settings', settings: input.agentSettings };
  throw new AgentLaunchError('A launch requires agent, agentSettings, or agentProfileId');
}

/** Audited ownership table: adding a setting requires selecting its launch owner. */
export const LAUNCH_FIELD_OWNERSHIP = {
  schema_version: 'schema', agent_kind: 'native runtime boundary', llm_profile_ref: 'LLM profile snapshot', agent: 'legacy profile label; runtime always native Agent',
  tools: 'profile selection/runtime materialization', persona: 'profile/static prompt', mcp_config: 'filtered snapshot/host materializer',
  enable_classify_and_switch_llm_tool: 'router materialization', active_meta_profile: 'meta profile reference', meta_profile: 'router snapshot',
  meta_profile_llms: 'router LLM snapshots', tool_concurrency_limit: 'agent runtime', condenser: 'condenser snapshot/runtime',
  hard_condenser: 'native emergency condenser snapshot/runtime', verification: 'explicitly rejected until native critic lifecycle exists',
} as const;

function cloneSkill(skill: Skill): Skill { return new Skill(copy({ ...skill })); }
function cloneContext(options: AgentContextOptions): AgentContext {
  const { skills, ...rest } = options;
  return new AgentContext({ ...copy(rest), ...(skills === undefined ? {} : { skills: skills.map(cloneSkill) }) });
}
function copy<T>(value: T): T { return structuredClone(value); }
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) { for (const nested of Object.values(value)) freeze(nested); Object.freeze(value); }
  return value;
}
function isTimestamp(value: Date | string | null): boolean {
  return value instanceof Date ? Number.isFinite(value.getTime()) : typeof value === 'string' && /^\d{4}-\d\d-\d\d(?:T| |$)/u.test(value) && Number.isFinite(Date.parse(value));
}
function nowWithOffset(previous: Date | string | null): Date | string {
  const now = new Date();
  if (typeof previous !== 'string') return now;
  const offset = /([+-])(\d{2}):?(\d{2})$/u.exec(previous);
  if (offset === null) return previous.endsWith('Z') ? now.toISOString() : now;
  const minutes = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '-' ? -1 : 1);
  return new Date(now.getTime() + minutes * 60_000).toISOString().slice(0, -1) + `${offset[1]}${offset[2]}:${offset[3]}`;
}
function hasMcp(value: unknown): boolean { return value !== null && value !== undefined && (typeof value !== 'object' || Object.keys(value).length > 0); }
function redactedSettings(settings: OpenHandsAgentSettings, context: AgentContext | null): Record<string, unknown> {
  return { ...copy(settings), agent_context: context === null ? null : {
    ...copy({ ...context }),
    currentDatetime: context.currentDatetime instanceof Date ? context.currentDatetime.toISOString() : context.currentDatetime,
    secrets: context.secrets === null ? null : Object.fromEntries(context.getSecretInfos().map(info => [info.name, { description: info.description ?? null }])),
  }, mcp_config: Object.fromEntries(Object.keys(settings.mcp_config ?? {}).map(name => [name, '[REDACTED]'])),
    meta_profile_llms: Object.fromEntries(Object.entries(settings.meta_profile_llms).map(([name, profile]) => [name, { profileId: profile.profileId, providerId: profile.providerId, model: profile.model }])) };
}
