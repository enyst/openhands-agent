import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentContext } from '../../context/agent-context.js';
import { skillSchema } from '../../skills/index.js';
import { RemoteWorkspace } from '../index.js';

// Adapted from pinned Python tests/sdk/workspace/remote/test_remote_workspace.py.
describe('RemoteWorkspace skill loading', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('loads skills through the authenticated global endpoint and converts wire metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ skills: [{
      name: 'test-skill', content: 'Test content', description: 'A test skill',
      triggers: ['test'], is_agentskills_format: true, disable_model_invocation: true,
    }] }));
    vi.stubGlobal('fetch', fetchMock);
    const workspace = new RemoteWorkspace({ host: 'https://server.test', apiKey: 'synthetic-key', workingDir: '/workspace' });

    const [skills, context] = await workspace.loadSkillsFromAgentServer();

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: 'test-skill', content: 'Test content', description: 'A test skill',
      trigger: { type: 'keyword', keywords: ['test'] }, isAgentskillsFormat: true, disableModelInvocation: true });
    expect(context.skills).toEqual(skills);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://server.test/api/skills');
    expect(new Headers(init.headers).get('X-Session-API-Key')).toBe('synthetic-key');
    expect(JSON.parse(init.body)).toEqual({ project_dir: '/workspace', load_public: true, load_user: true,
      load_project: true, load_org: true, sandbox_config: null });
  });

  it('preserves caller context and reapplies its disabled-skills deny-list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ skills: [
      { name: 'risky-skill', content: 'Denied' }, { name: 'ok-skill', content: 'Allowed' },
    ] })));
    const fixedTime = new Date('2020-01-01T00:00:00Z');
    const originalSkill = skillSchema.parse({ name: 'original', content: 'original content' });
    const base = new AgentContext({ skills: [originalSkill], disabledSkills: ['risky-skill'],
      userMessageSuffix: 'Follow the client policy.', systemMessageSuffix: 'System policy.',
      currentDatetime: fixedTime, secrets: { TOKEN: { description: 'A runtime credential' } } });

    const [skills, context] = await new RemoteWorkspace({ host: 'https://server.test' })
      .loadSkillsFromAgentServer({ baseContext: base });

    expect(skills.map((skill) => skill.name)).toEqual(['risky-skill', 'ok-skill']);
    expect(context.skills.map((skill) => skill.name)).toEqual(['ok-skill']);
    expect(context.disabledSkills).toEqual(['risky-skill']);
    expect(context.currentDatetime).toBe(fixedTime);
    expect(context.userMessageSuffix).toBe(base.userMessageSuffix);
    expect(context.systemMessageSuffix).toBe(base.systemMessageSuffix);
    expect(context.secrets).toBe(base.secrets);
    expect(base.skills).toEqual([originalSkill]);
  });

  it('preserves an explicitly absent datetime', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ skills: [{ name: 'new', content: 'New' }] })));
    const base = new AgentContext({ currentDatetime: null });
    const [, context] = await new RemoteWorkspace({ host: 'https://server.test' })
      .loadSkillsFromAgentServer({ baseContext: base });
    expect(context.currentDatetime).toBeNull();
    expect(context.getSystemMessageSuffix()).not.toContain('<CURRENT_DATETIME>');
  });

  it.each([200, 404])('retains explicit fallback skills when loading yields none (%s)', async (status) => {
    // Automatic public/user discovery is still deferred; do not invent public skills.
    const fetchMock = vi.fn().mockResolvedValue(json({ skills: [] }, status));
    vi.stubGlobal('fetch', fetchMock);
    const fallback = skillSchema.parse({ name: 'fallback', content: 'Caller-provided fallback' });
    const base = new AgentContext({ skills: [fallback], disabledSkills: ['risky-skill'],
      userMessageSuffix: 'Keep me', currentDatetime: '2020-01-01T00:00' });

    const [skills, context] = await new RemoteWorkspace({ host: 'https://server.test' })
      .loadSkillsFromAgentServer({ baseContext: base });

    expect(skills).toEqual([]);
    expect(context.skills).toEqual([fallback]);
    expect(context.disabledSkills).toEqual(['risky-skill']);
    expect(context.userMessageSuffix).toBe('Keep me');
    expect(context.currentDatetime).toBe('2020-01-01T00:00');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('loads global skills once, then merges projects with later directories taking precedence', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ skills: [{ name: 'same', content: 'Global' }, { name: 'global', content: 'Global' }] }))
      .mockResolvedValueOnce(json({ skills: [{ name: 'same', content: 'First' }] }))
      .mockResolvedValueOnce(json({ skills: [{ name: 'same', content: 'Second', triggers: ['/task'] }] }));
    vi.stubGlobal('fetch', fetchMock);
    const [skills] = await new RemoteWorkspace({ host: 'https://server.test', workingDir: '/workspace' })
      .loadSkillsFromAgentServer({ projectDirs: ['/workspace/one', '/workspace/two'], loadUser: false });

    expect(skills.map((skill) => [skill.name, skill.content])).toEqual([['same', 'Second'], ['global', 'Global']]);
    expect(skills[0]?.trigger).toEqual({ type: 'task', triggers: ['/task'] });
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      { project_dir: '/workspace', load_public: true, load_user: false, load_project: false, load_org: true, sandbox_config: null },
      { project_dir: '/workspace/one', load_public: false, load_user: false, load_project: true, load_org: false, sandbox_config: null },
      { project_dir: '/workspace/two', load_public: false, load_user: false, load_project: true, load_org: false, sandbox_config: null },
    ]);
  });

  it('skips project requests when project loading is disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ skills: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await new RemoteWorkspace({ host: 'https://server.test' })
      .loadSkillsFromAgentServer({ projectDirs: ['/one', '/two'], loadProject: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips invalid wire skills without discarding valid ones', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ skills: [
      { name: 'bad', content: 'Bad', triggers: [42] },
      { name: 'bad-string-trigger', content: 'Bad', triggers: 'test' },
      { name: 'bad-content', content: null }, { name: 'good', content: 'Good' },
    ] })));
    const [skills] = await new RemoteWorkspace({ host: 'https://server.test' }).loadSkillsFromAgentServer();
    expect(skills.map((skill) => skill.name)).toEqual(['good']);
  });

  it('retries transient failures at most three times', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ skills: [{ name: 'recovered', content: 'Recovered' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = new RemoteWorkspace({ host: 'https://server.test' }).loadSkillsFromAgentServer();
    await vi.runAllTimersAsync();
    expect((await result)[0][0]?.name).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('falls back after three server failures', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json({}, 503)));
    vi.stubGlobal('fetch', fetchMock);
    const fallback = skillSchema.parse({ name: 'fallback', content: 'Caller-provided fallback' });
    const base = new AgentContext({ skills: [fallback] });
    const result = new RemoteWorkspace({ host: 'https://server.test' }).loadSkillsFromAgentServer({ baseContext: base });
    await vi.runAllTimersAsync();
    expect((await result)[1].skills).toEqual([fallback]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects an uninitialized workspace without sending a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new RemoteWorkspace({ host: 'undefined' }).loadSkillsFromAgentServer()).rejects.toThrow('Workspace not initialized');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
