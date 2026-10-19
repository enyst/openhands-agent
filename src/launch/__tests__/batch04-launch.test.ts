import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Agent } from '../../agent/agent.js';
import { AgentContext } from '../../context/agent-context.js';
import { llmProfileSchema } from '../../llm/index.js';
import { validateAgentProfile } from '../../profiles/index.js';
import { skillSchema } from '../../skills/index.js';
import { agentLaunchAdditionsSchema, finalizeLaunch, normalizeLaunchSource, previewLaunch, resolveLaunch, type LaunchStores } from '../index.js';

const llm = (name: string) => llmProfileSchema.parse({ profileId: name, providerId: 'openai', model: name });
const skill = (name: string, content = name) => skillSchema.parse({ name, content });
const profile = (extra: Record<string, unknown> = {}) => validateAgentProfile({ name: 'test', llm_profile_ref: 'main', tools: [], condenser: { enabled: false }, ...extra });
const stores = (extra: Partial<LaunchStores> = {}): LaunchStores => ({ llmProfiles: { load: name => llm(name) }, mcpConfig: {}, skills: () => [], ...extra });
const runtime = { createClient: async (p: ReturnType<typeof llm>) => ({ profile: p, complete: vi.fn(async () => { throw new Error('offline fixture'); }) }) };

it('matches the executed pinned Python selector for all public-tier/deny-list cases', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/python-profile-skill-selection.json', import.meta.url), 'utf8')) as {
    upstreamCommit: string; cases: { catalog: { name: string; content: string }[]; disabled: string[]; publicSkills: string[] | null; publicSkillNames: string[] | null; expected: { name: string; content: string }[] }[];
  };
  const manifest = JSON.parse(readFileSync(new URL('../../../transpile/upstream.json', import.meta.url), 'utf8')) as { commit: string };
  expect(fixture.upstreamCommit).toBe(manifest.commit);
  for (const item of fixture.cases) {
    const resolved = await resolveLaunch(profile({ public_skills: item.publicSkills, disabled_skills: item.disabled }), stores({
      skills: () => item.catalog.map(value => skill(value.name, value.content)),
      ...(item.publicSkillNames === null ? {} : { publicSkillNames: () => item.publicSkillNames! }),
    }));
    expect(resolved.context?.skills.map(({ name, content }) => ({ name, content }))).toEqual(item.expected);
  }
});

it('overrides only the main profile and records provenance without changing the stored profile or condenser roles', async () => {
  const saved = profile({ condenser: { llm_profile_ref: 'summary' } });
  const resolved = await resolveLaunch(saved, stores(), { llmProfileRef: 'override' });
  expect(saved.agent_kind === 'openhands' && saved.llm_profile_ref).toBe('main');
  expect(resolved.settings.llm_profile_ref).toBe('override');
  expect(resolved.profile).toMatchObject({ llm_profile_ref: 'override', agent_profile_id: saved.id, revision: saved.revision });
  expect(resolved.llmProfiles.summary?.model).toBe('summary');
  expect(resolved.settings.condenser).toMatchObject({ llm_profile_ref: 'summary' });
  expect((await resolveLaunch(saved, stores())).profile?.llm_profile_ref).toBeNull();
  await expect(resolveLaunch(saved, stores({ llmProfiles: { load: () => null } }), { llmProfileRef: 'missing' })).rejects.toMatchObject({ llmProfileRef: 'missing' });
});

it('preserves the optional native hard fallback independently through profile launch', async () => {
  const resolved = await resolveLaunch(profile({ condenser: { condenser_kind: 'agent_reset' }, hard_condenser: { condenser_kind: 'llm_summarizing', llm_profile_ref: 'emergency' } }), stores(), { llmProfileRef: 'override' });
  expect(resolved.settings.hard_condenser?.llm_profile_ref).toBe('emergency');
  expect(resolved.llmProfiles.emergency?.model).toBe('emergency');
});

it('accepts a named model override only with a stored profile request and omits absent additions', () => {
  const additions = { llm_profile_ref: 'other' };
  expect(normalizeLaunchSource({ agentProfileId: 'id', agentLaunchAdditions: additions })).toMatchObject({ kind: 'profile', id: 'id', llmProfileRef: 'other' });
  expect(() => normalizeLaunchSource({ agentSettings: {}, agentLaunchAdditions: additions })).toThrow(/profile/iu);
  expect(() => normalizeLaunchSource({ agentProfileId: 'id', agentSettings: {}, agentLaunchAdditions: additions })).toThrow(/exclusive/iu);
  expect(agentLaunchAdditionsSchema.parse({})).not.toHaveProperty('skills');
  expect(() => agentLaunchAdditionsSchema.parse({ llm_profile_ref: '' })).toThrow();
});

it.each([null, [], ['selected']] as const)('selects only the public tier for public_skills=%j, with global disabled and last duplicate wins', async selection => {
  const p = profile({ public_skills: selection, disabled_skills: ['blocked'] });
  const catalog = [skill('selected', 'old'), skill('other'), skill('user'), skill('project'), skill('blocked'), skill('selected', 'new')];
  const s = stores({ skills: () => catalog, publicSkillNames: () => ['selected', 'other', 'blocked'] });
  const resolved = await resolveLaunch(p, s);
  const expected = selection === null ? ['selected', 'other', 'user', 'project'] : selection.length === 0 ? ['user', 'project'] : ['selected', 'user', 'project'];
  expect(resolved.context?.skills.map(item => item.name)).toEqual(expected);
  if (selection === null || selection.length) expect(resolved.context?.skills.find(item => item.name === 'selected')?.content).toBe('new');
  const preview = await previewLaunch(p, s, runtime); expect(preview.valid).toBe(true); expect(preview.resolved_skills).toEqual(expected);
});

it('treats all skills as public without a tier provider, and reports tier-store errors', async () => {
  expect((await resolveLaunch(profile({ public_skills: [] }), stores({ skills: () => [skill('one')] }))).context?.skills).toEqual([]);
  await expect(resolveLaunch(profile({ public_skills: [] }), stores({ publicSkillNames: () => { throw new Error('private store failure'); } }))).rejects.toThrow('Skill discovery failed');
});

it('adds skills after existing context without overriding names or deny-list, first addition wins, and leaves the original intact', async () => {
  const agent = new Agent({ llm: await runtime.createClient(llm('main')), context: new AgentContext({ skills: [skill('existing')], disabledSkills: ['blocked'] }) });
  const launched = await finalizeLaunch(agent, runtime, { additions: { skills: [skill('existing', 'replace'), skill('blocked'), skill('new', 'first'), skill('new', 'second')] } });
  expect(launched.agent.context?.skills.map(item => [item.name, item.content])).toEqual([['existing', 'existing'], ['new', 'first']]);
  expect(agent.context?.skills.map(item => item.name)).toEqual(['existing']);
});
