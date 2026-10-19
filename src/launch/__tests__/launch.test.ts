import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, type AgentOptions } from '../../agent/agent.js';
import { AgentContext } from '../../context/agent-context.js';
import { llmProfileSchema } from '../../llm/index.js';
import { validateAgentProfile } from '../../profiles/index.js';
import { validateAgentSettings, openHandsAgentSettingsSchema } from '../../settings/index.js';
import { ToolDefinition } from '../../tool/index.js';
import { AgentLaunchError, LaunchStoreError, ProfileNotFound, UnresolvedProfileReferences, ResolvedLaunch, LaunchedAgent, resolveLaunch, resolveSettingsLaunch, finalizeLaunch, previewLaunch, normalizeLaunchSource, LAUNCH_FIELD_OWNERSHIP, type LaunchStores, type LaunchRuntime } from '../index.js';

const llm = (id: string) => llmProfileSchema.parse({ profileId: id, providerId: 'openai', model: `${id}-model` });
const complete = vi.fn(async () => { throw new Error('no provider calls in launch'); });
const runtime: LaunchRuntime = { createClient: async profile => ({ profile, complete }) };
const profile = (extra: Record<string, unknown> = {}) => validateAgentProfile({ name: 'test', llm_profile_ref: 'main', tools: [], condenser: { enabled: false }, ...extra });
const stores = (extra: Partial<LaunchStores> = {}): LaunchStores => ({ llmProfiles: { load: async name => name === 'main' ? llm('main') : null }, mcpConfig: {}, skills: () => [], ...extra });
const tool = (name: string) => new ToolDefinition({ name, description: name, inputSchema: z.object({}), outputSchema: z.object({}), executor: () => ({}) });
const rawAgent = (context: AgentContext | null = null) => new Agent({ llm: { profile: llm('main'), complete }, context, systemPrompt: 'INLINE' });

describe('reference-free native launch', () => {
  it('aggregates dangling main, MCP, and meta profile references', async () => {
    const pending = resolveLaunch(profile({ llm_profile_ref: 'missing', mcp_server_refs: ['gone', 'gone'], enable_classify_and_switch_llm_tool: true, meta_profile_ref: 'router' }), stores());
    await expect(pending).rejects.toMatchObject({ llmProfileRef: 'missing', mcpServerRefs: ['gone'], metaProfileRef: 'router' });
    await expect(pending).rejects.toBeInstanceOf(UnresolvedProfileReferences);
  });
  it('aggregates required routed LLMs independently from main and MCP', async () => {
    await expect(resolveLaunch(profile({ llm_profile_ref: 'gone', mcp_server_refs: ['absent'], enable_classify_and_switch_llm_tool: true, meta_profile_ref: 'router' }), stores({ metaProfiles: { load: async () => ({ classifier_model: 'classifier', classes: [{ model: 'target', description: 'x' }], prompt_template: null, model_table: null }) } }))).rejects.toMatchObject({ llmProfileRef: 'gone', mcpServerRefs: ['absent'], metaProfileLlmRefs: ['classifier', 'target'] });
  });
  it('distinguishes an unreadable or busy store from a missing profile without exposing its contents', async () => {
    const busy = stores({ llmProfiles: { load: async () => { throw Object.assign(new Error('private-key-value'), { code: 'ETIMEDOUT' }); } } });
    await expect(resolveLaunch(profile(), busy)).rejects.toMatchObject({ retryable: true, message: 'LLM profile store is busy' });
    const broken = stores({ llmProfiles: { load: async () => { throw new Error('private-key-value'); } } });
    await expect(resolveLaunch(profile(), broken)).rejects.toBeInstanceOf(LaunchStoreError);
    await expect(resolveLaunch(profile(), broken)).rejects.not.toThrow('private-key-value');
  });
  it('looks up stable profile IDs and reports absent IDs', async () => {
    const saved = profile();
    const resolved = await resolveLaunch(saved.id, stores({ agentProfiles: { nameForId: async () => 'test', load: async () => saved } }));
    expect(resolved.profile?.agent_profile_id).toBe(saved.id);
    await expect(resolveLaunch(saved.id, stores())).rejects.toBeInstanceOf(ProfileNotFound);
  });
  it('copies LLM and MCP snapshots, preserving explicit empty secret and MCP selections', async () => {
    const main = llm('main'); const mcp = { one: { command: 'x', args: ['before'] } };
    const resolved = await resolveLaunch(profile({ secret_refs: [], mcp_server_refs: ['one'] }), stores({ llmProfiles: { load: async () => main }, mcpConfig: mcp }));
    main.model = 'after'; mcp.one.args.push('after');
    expect(resolved.llmProfiles.main?.model).toBe('main-model');
    expect(resolved.settings.mcp_config).toEqual({ one: { command: 'x', args: ['before'] } });
    expect([...resolved.allowedSecrets!]).toEqual([]);
    expect((await resolveLaunch(profile({ mcp_server_refs: [] }), stores({ mcpConfig: mcp }))).settings.mcp_config).toEqual({});
    expect((await resolveLaunch(profile(), stores())).allowedSecrets).toBeNull();
  });
  it('does not read disabled routers; direct mode snapshots every readable saved profile', async () => {
    const load = vi.fn(async () => ({ classifier_model: 'main', classes: [], prompt_template: '{{ instance_text }}', model_table: null }));
    await resolveLaunch(profile({ meta_profile_ref: 'unused' }), stores({ metaProfiles: { load } }));
    expect(load).not.toHaveBeenCalled();
    const resolved = await resolveLaunch(profile({ enable_classify_and_switch_llm_tool: true, meta_profile_ref: 'router' }), stores({ metaProfiles: { load }, llmProfileNames: () => ['main', 'extra', 'bad'], llmProfiles: { load: async name => { if (name === 'bad') throw new Error('corrupt'); return llm(name); } } }));
    expect(Object.keys(resolved.llmProfiles)).toEqual(['main', 'extra']);
  });
  it('keeps every explicit direct-router target ahead of saved discovery even when it is not listed', async () => {
    const resolved = await resolveSettingsLaunch({ llm_profile_ref: 'main', tools: [], condenser: { enabled: false }, enable_classify_and_switch_llm_tool: true,
      meta_profile: { classifier_model: 'main', prompt_template: '{{ instance_text }}' },
      meta_profile_llms: { target: { ...llm('target'), model: 'inline-target' }, unlisted: { ...llm('unlisted'), model: 'inline-unlisted' } },
    }, stores({ llmProfileNames: () => ['main', 'target'], llmProfiles: { load: name => llm(name) } }));
    expect(resolved.settings.meta_profile_llms.target?.model).toBe('inline-target');
    expect(resolved.settings.meta_profile_llms.unlisted?.model).toBe('inline-unlisted');
  });
  it('retains dormant inline router configuration without resolving its references', async () => {
    const load = vi.fn(async () => { throw new Error('disabled router must not load'); });
    const resolved = await resolveSettingsLaunch({ llm_profile_ref: 'main', tools: [], condenser: { enabled: false },
      enable_classify_and_switch_llm_tool: false, active_meta_profile: 'dormant',
      meta_profile: { classifier_model: 'saved' }, meta_profile_llms: { saved: llm('saved') },
    }, stores({ metaProfiles: { load } }));
    expect(resolved.settings.meta_profile?.classifier_model).toBe('saved');
    expect(resolved.settings.meta_profile_llms.saved?.model).toBe('saved-model');
    expect(load).not.toHaveBeenCalled();
  });
  it('snapshots separate condenser profiles and never re-reads stores in finalize', async () => {
    const load = vi.fn(async name => llm(name));
    const resolved = await resolveSettingsLaunch({ llm_profile_ref: 'main', tools: [], condenser: { llm_profile_ref: 'summary', max_tokens: 1000 } }, stores({ llmProfiles: { load } }));
    load.mockRejectedValue(new Error('store changed'));
    const clients: string[] = [];
    const launched = await finalizeLaunch(resolved, { createClient: async p => { clients.push(p.profileId); return { profile: p, complete }; } });
    expect(clients).toEqual(['main', 'summary']);
    expect(launched.agent.condenser).not.toBeNull(); expect(complete).not.toHaveBeenCalled();
  });
  it('keeps an inline routed binding separate from the main and condenser snapshot with the same name', async () => {
    const resolved = await resolveSettingsLaunch({ llm_profile_ref: 'main', tools: [], condenser: { llm_profile_ref: 'main' }, enable_classify_and_switch_llm_tool: true,
      meta_profile: { classifier_model: 'main' }, meta_profile_llms: { main: { ...llm('main'), model: 'routed-override' } } }, stores());
    expect(resolved.llmProfiles.main?.model).toBe('main-model');
    expect(resolved.settings.meta_profile_llms.main?.model).toBe('routed-override');
  });
  it('preserves independent historical role bindings even when every role has the same saved profile ID', async () => {
    const settings = validateAgentSettings({ llm_profile_ref: 'main', tools: [], condenser: { llm_profile_ref: 'main', max_tokens: 1000 } });
    if (settings.agent_kind !== 'openhands') throw new Error('fixture');
    const resolved = new ResolvedLaunch({ settings, llmProfiles: { main: llm('main') }, bindings: {
      main: { ...llm('main'), model: 'active-main' }, condenser: { ...llm('main'), model: 'historical-summary' },
    } });
    const calls: [string, string][] = [];
    await finalizeLaunch(resolved, { createClient: async (profile, role) => { calls.push([role, profile.model]); return { profile, complete }; } });
    expect(calls).toEqual([['main', 'active-main'], ['condenser', 'historical-summary']]);
  });
  it('keeps the hard fallback binding distinct from the prepared main client', async () => {
    const settings = validateAgentSettings({ llm_profile_ref: 'main', tools: [], condenser: { condenser_kind: 'agent_reset' }, hard_condenser: { condenser_kind: 'llm_summarizing', llm_profile_ref: 'main' } });
    if (settings.agent_kind !== 'openhands') throw new Error('fixture');
    const resolved = new ResolvedLaunch({ settings, llmProfiles: { main: llm('main') }, bindings: {
      hard_condenser: { ...llm('main'), model: 'historical-hard-fallback' },
    } });
    const calls: [string, string][] = [];
    await finalizeLaunch(resolved, { createClient: async (profile, role) => { calls.push([role, profile.model]); return { profile, complete }; } });
    expect(calls).toEqual([['main', 'main-model'], ['hard_condenser', 'historical-hard-fallback']]);
  });
  it('refuses unresolved condenser fallback instead of borrowing the main client', async () => {
    await expect(resolveSettingsLaunch({ llm_profile_ref: 'main', tools: [] }, stores())).rejects.toThrow('condenser');
  });
  it('marks selected delegation tools with the profile scope', async () => {
    const resolved = await resolveLaunch(profile({ tools: [{ name: 'task_tool_set' }], mcp_server_refs: [] }), stores());
    expect(resolved.settings.tools?.[0]?.params).toEqual({ sub_agent_scope: { tools: true, mcp_servers: true } });
  });
});

describe('runtime finalization', () => {
  it('preserves the legacy agent label without treating it as executable code', async () => {
    const resolved = await resolveLaunch(profile({ agent: 'legacy-custom-label' }), stores());
    expect((await finalizeLaunch(resolved, runtime)).agent).toBeInstanceOf(Agent);
    expect(resolved.settings.agent).toBe('legacy-custom-label');
  });
  it('accepts only the finalize token for branded results', () => {
    expect(() => new LaunchedAgent(rawAgent(), null)).toThrow('finalizeLaunch');
  });
  it('appends suffixes, strips managed context secrets, dedupes client tools, and preserves input', async () => {
    const original = rawAgent(new AgentContext({ currentDatetime: null, systemMessageSuffix: ' PROFILE ', secrets: { managed: 'x', kept: 'y' } }));
    const launched = await finalizeLaunch(original, runtime, { additions: { system_message_suffix_append: ' RUNTIME ' }, extraSuffixes: [' WORKTREE ', '  '], managedSecrets: ['managed'], clientTools: [tool('host'), tool('host')] });
    expect(launched.agent.context?.systemMessageSuffix).toBe('PROFILE\n\nRUNTIME\n\nWORKTREE');
    expect(launched.agent.context?.secrets).toEqual({ kept: 'y' });
    expect(launched.agent.tools.map(t => t.name)).toEqual(['host']);
    expect(original.context?.secrets).toEqual({ managed: 'x', kept: 'y' });
    expect(launched.profile).toBeNull();
  });
  it('preserves raw agent subclass behavior and instance overrides without mutating its input', async () => {
    class CustomAgent extends Agent { override get staticSystemMessage(): string { return `CUSTOM:${this.context?.systemMessageSuffix ?? ''}`; } }
    const original = new CustomAgent({ llm: { profile: llm('main'), complete }, context: new AgentContext({ currentDatetime: null, systemMessageSuffix: 'before' }) });
    const marker = Symbol('extension');
    Object.defineProperty(original, marker, { value: 'retained', enumerable: false });
    const launched = await finalizeLaunch(original, runtime, { extraSuffixes: ['after'] });
    expect(launched.agent).toBeInstanceOf(CustomAgent);
    expect(launched.agent.staticSystemMessage).toBe('CUSTOM:before\n\nafter');
    expect(Object.getOwnPropertyDescriptor(launched.agent, marker)?.value).toBe('retained');
    expect(original.staticSystemMessage).toBe('CUSTOM:before');
    const instance = rawAgent();
    Object.defineProperty(instance, 'staticSystemMessage', { get: () => 'INSTANCE' });
    expect((await finalizeLaunch(instance, runtime)).agent.staticSystemMessage).toBe('INSTANCE');
  });
  it('uses the custom copy hook for agents with private slots and preserves unchanged identity', async () => {
    class PrivateAgent extends Agent {
      #label: string;
      constructor(options: AgentOptions, label: string) { super(options); this.#label = label; }
      override get staticSystemMessage(): string { return `${this.#label}:${this.context?.systemMessageSuffix ?? ''}`; }
      override withOverrides(options: Partial<AgentOptions>): this {
        return new PrivateAgent({ llm: this.llm, context: this.context, tools: this.tools, ...options }, this.#label) as this;
      }
    }
    const original = new PrivateAgent({ llm: { profile: llm('main'), complete } }, 'private');
    expect((await finalizeLaunch(original, runtime)).agent).toBe(original);
    const launched = await finalizeLaunch(original, runtime, { extraSuffixes: ['suffix'] });
    expect(launched.agent.staticSystemMessage).toBe('private:suffix');
    expect(original.staticSystemMessage).toBe('private:');
  });
  it('refreshes date-only ISO timestamps and preserves an offset when no launch time is supplied', async () => {
    const now = new Date('2026-10-01T12:00:00Z');
    expect((await finalizeLaunch(rawAgent(new AgentContext({ currentDatetime: '2020-01-01' })), runtime, { launchedAt: now })).agent.context?.currentDatetime).toEqual(now);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const launched = await finalizeLaunch(rawAgent(new AgentContext({ currentDatetime: '2020-01-01T00:00:00-07:00' })), runtime);
      expect(launched.agent.context?.currentDatetime).toBe('2026-10-01T05:00:00.000-07:00');
    } finally { vi.useRealTimers(); }
  });
  it('applies explicit empty profile secret scope to supplied context metadata', async () => {
    const settings = validateAgentSettings({ llm_profile_ref: 'main', tools: [], condenser: { enabled: false } });
    if (settings.agent_kind !== 'openhands') throw new Error('fixture');
    const resolved = new ResolvedLaunch({ settings, llmProfiles: { main: llm('main') }, context: { secrets: { SECRET: { description: 'private' } }, currentDatetime: null },
      profile: { agent_profile_id: 'fixture', revision: 1, secret_refs: [] } });
    const launched = await finalizeLaunch(resolved, runtime);
    expect(launched.agent.context?.secrets).toEqual({});
    expect(resolved.context?.secrets).toEqual({ SECRET: { description: 'private' } });
  });
  it('refreshes ISO timestamps and leaves suppressed or preformatted timestamps intact', async () => {
    const now = new Date('2026-10-01T12:00:00Z');
    for (const currentDatetime of ['2020-01-01T12:00:00+02:00', new Date('2020-01-01')]) {
      const launched = await finalizeLaunch(rawAgent(new AgentContext({ currentDatetime })), runtime, { launchedAt: now });
      expect(launched.agent.context?.currentDatetime).toEqual(now);
    }
    for (const currentDatetime of [null, 'Friday in a simulation']) {
      expect((await finalizeLaunch(rawAgent(new AgentContext({ currentDatetime })), runtime, { launchedAt: now })).agent.context?.currentDatetime).toBe(currentDatetime);
    }
    expect((await finalizeLaunch(rawAgent(), runtime, { extraSuffixes: ['new'] })).agent.context?.currentDatetime).toBeNull();
  });
  it('requires an actual memory loader and applies its content without introducing a timestamp', async () => {
    await expect(finalizeLaunch(rawAgent(), runtime, { loadMemory: true })).rejects.toThrow('memory loader');
    const launched = await finalizeLaunch(rawAgent(), { ...runtime, loadMemory: async () => 'REMEMBER' }, { loadMemory: true });
    expect(launched.agent.context?.systemMessageSuffix).toBe('REMEMBER');
    expect(launched.agent.context?.currentDatetime).toBeNull();
  });
  it('honors browser availability and always includes finish/think once', async () => {
    const resolved = await resolveLaunch(profile({ tools: [{ name: 'browser_tool_set' }, { name: 'custom' }] }), stores());
    const seen: string[] = [];
    const launched = await finalizeLaunch(resolved, { ...runtime, materializeTools: async specs => { seen.push(...specs.map(t => t.name)); return specs.map(t => tool(t.name)); } });
    expect(seen).toEqual(['custom']);
    expect(launched.agent.tools.map(t => t.name)).toEqual(['custom', 'finish', 'think']);
  });
  it('requires MCP materialization and rejects unsupported ACP or verification execution', async () => {
    const resolved = await resolveLaunch(profile(), stores({ mcpConfig: { configured: {} } }));
    await expect(finalizeLaunch(resolved, runtime)).rejects.toThrow('MCP');
    await expect(resolveLaunch(validateAgentProfile({ name: 'acp', agent_kind: 'acp' }), stores())).rejects.toThrow('ACP');
    const verify = await resolveLaunch(profile({ verification: { critic_enabled: true } }), stores());
    await expect(finalizeLaunch(verify, runtime)).rejects.toThrow('verification');
  });
});

describe('shared preview and request normalization', () => {
  it('reports partial reference diagnostics and actual unavailable tools without any completions', async () => {
    const invalid = await previewLaunch(profile({ mcp_server_refs: ['gone'] }), stores(), runtime);
    expect(invalid).toMatchObject({ valid: false, llm_profile_resolved: true, dangling_mcp_server_refs: ['gone'], resolved_settings: null });
    const tools = await previewLaunch(profile({ tools: [{ name: 'missing-executor' }] }), stores(), runtime);
    expect(tools.valid).toBe(false); expect(tools.unusable_tools).toContain('missing-executor');
    expect(complete).not.toHaveBeenCalled();
  });
  it('keeps unavailable tools invalid even when a host materializer is permissive', async () => {
    const preview = await previewLaunch(profile({ tools: [{ name: 'unavailable' }] }), stores(), { ...runtime,
      isToolAvailable: () => false, materializeTools: async specs => specs.map(spec => tool(spec.name)) });
    expect(preview.valid).toBe(false); expect(preview.resolved_settings).toBeNull();
    expect(preview.errors.join(' ')).toContain('cannot run');
  });
  it('replaces explicit router parameters with enabled settings routing and carries its name', async () => {
    const resolved = await resolveSettingsLaunch({ llm_profile_ref: 'main', tools: [{ name: 'route_task_to_model', params: { active_meta_profile: 'explicit' } }],
      condenser: { enabled: false }, enable_classify_and_switch_llm_tool: true, active_meta_profile: 'settings', meta_profile: { classifier_model: 'main' } }, stores());
    let selected: readonly { name: string; params: Record<string, unknown> }[] = [];
    await finalizeLaunch(resolved, { ...runtime, materializeTools: async specs => { selected = specs; return []; } });
    expect(selected.filter(spec => spec.name === 'route_task_to_model')).toHaveLength(1);
    expect(selected.find(spec => spec.name === 'route_task_to_model')?.params.active_meta_profile).toBe('settings');
  });
  it('uses finalization in a valid preview and exposes no credentials', async () => {
    const preview = await previewLaunch(profile(), stores(), runtime);
    expect(preview.valid).toBe(true); expect(preview.resolved_settings).not.toBeNull();
  });
  it('uses the same memory finalization in preview and reports effective native context', async () => {
    const loadMemory = vi.fn(async () => 'HOST MEMORY');
    const preview = await previewLaunch(profile({ system_message_suffix: 'PROFILE' }), stores(), { ...runtime, loadMemory }, { loadMemory: true });
    expect(loadMemory).toHaveBeenCalledOnce();
    expect(preview.resolved_settings?.agent_context).toMatchObject({ systemMessageSuffix: 'PROFILE\n\nHOST MEMORY' });
  });
  it('requires one launch source; explicit native agent wins redundant settings', () => {
    const agent = rawAgent();
    expect(normalizeLaunchSource({ agent, agentSettings: { invalid: true } })).toEqual({ kind: 'agent', agent });
    expect(() => normalizeLaunchSource({ agentProfileId: 'id', agent })).toThrow(AgentLaunchError);
    expect(() => normalizeLaunchSource({})).toThrow(AgentLaunchError);
    expect(normalizeLaunchSource({ agentProfileId: 'id' })).toEqual({ kind: 'profile', id: 'id' });
  });
  it('assigns every native settings field an explicit owner including hard_condenser', () => {
    const keys = Object.keys(z.toJSONSchema(openHandsAgentSettingsSchema, { io: 'output' }).properties ?? {}).sort();
    expect(Object.keys(LAUNCH_FIELD_OWNERSHIP).sort()).toEqual(keys);
    expect(LAUNCH_FIELD_OWNERSHIP.hard_condenser).toBe('native emergency condenser snapshot/runtime');
    expect(validateAgentSettings({ llm_profile_ref: 'main' }).agent_kind).toBe('openhands');
  });
});
