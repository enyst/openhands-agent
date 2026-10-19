import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { skillSchema } from '../index.js';
import { invalidatePublicSkillsCache, loadPublicSkills, loadUserSkills, syncPublicSkills } from '../catalog.js';

const roots: string[] = [];
afterEach(async () => { invalidatePublicSkillsCache(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(join(tmpdir(), 'sdk-skills-')); roots.push(dir); return dir; }
async function write(dir: string, file: string, text: string) { const path = join(dir, file); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text); }

it('excludes installed resources through real and symlinked roots, keeps enabled installed skills explicit and preserves user precedence', async () => {
  const dir = await root(); const user = join(dir, 'skills'); const installed = join(user, 'installed');
  await write(user, 'user.md', '---\nname: same\n---\nuser');
  await write(installed, 'disabled/SKILL.md', '---\nname: disabled\n---\ndisabled');
  await write(installed, 'disabled/references/leak.md', 'must not leak');
  await symlink(user, join(dir, 'linked')); await symlink(user, join(user, 'loop'));
  const loadInstalled = vi.fn(async () => [skillSchema.parse({ name: 'same', content: 'installed' }), skillSchema.parse({ name: 'enabled', content: 'enabled' })]);
  for (const path of [user, join(dir, 'linked')]) {
    const result = await loadUserSkills({ directories: [path], installedDirectory: installed, loadInstalled });
    expect(result.map(s => [s.name, s.content])).toEqual([['same', 'user'], ['enabled', 'enabled']]);
  }
  expect(loadInstalled).toHaveBeenCalledTimes(2);
});

it('uses EXTENSIONS_PATH only for the default repository and keys cache by the actual local path', async () => {
  const first = await root(); const second = await root();
  await write(first, 'skills/one.md', 'one'); await write(second, 'skills/two.md', 'two');
  const fetchRepository = vi.fn(async () => { throw new Error('network must not run'); });
  vi.stubEnv('EXTENSIONS_PATH', first);
  expect((await loadPublicSkills({ fetchRepository })).map(s => s.name)).toEqual(['skills/one']);
  vi.stubEnv('EXTENSIONS_PATH', second);
  expect((await loadPublicSkills({ fetchRepository })).map(s => s.name)).toEqual(['skills/two']);
  expect(fetchRepository).not.toHaveBeenCalled();
  expect(await loadPublicSkills({ repoUrl: 'https://example.invalid/custom.git', fetchRepository })).toEqual([]);
  expect(fetchRepository).toHaveBeenCalledOnce();
});

it('retries empty/failed catalogs, caches successful results, and invalidates only after successful strict sync', async () => {
  const dir = await root(); let fail = false;
  const fetchRepository = vi.fn(async (_url: string, _ref: string, options: { strict: boolean }) => { if (fail && options.strict) throw new Error('fetch failed'); return { path: dir, pinned: false }; });
  const options = { repoUrl: 'https://example.invalid/catalog.git', fetchRepository };
  expect(await loadPublicSkills(options)).toEqual([]); await write(dir, 'skills/one.md', 'old');
  expect((await loadPublicSkills(options))[0]?.content).toBe('old');
  await write(dir, 'skills/one.md', 'new'); fail = true;
  await expect(syncPublicSkills(options)).rejects.toThrow('fetch failed');
  expect((await loadPublicSkills(options))[0]?.content).toBe('old');
  fail = false; await syncPublicSkills(options);
  expect((await loadPublicSkills(options))[0]?.content).toBe('new');
  expect(fetchRepository.mock.calls.some(call => call[2].strict)).toBe(true);
});
