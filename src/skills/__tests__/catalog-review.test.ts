import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { invalidatePublicSkillsCache, loadPublicSkills, loadUserSkills } from '../catalog.js';

const roots: string[] = [];
afterEach(async () => { invalidatePublicSkillsCache(); for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function root(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), 'sdk04-catalog-review-')); roots.push(directory); return directory; }
async function file(directory: string, relative: string, content: string): Promise<void> { const target = join(directory, relative); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, content); }

it('excludes README documentation from both user and public skill discovery', async () => {
  const directory = await root();
  await file(directory, 'skills/README.md', 'Repository documentation');
  await file(directory, 'skills/actual.md', '---\nname: actual\n---\nReal skill');
  const publicSkills = await loadPublicSkills({ repoUrl: 'https://example.invalid/readme.git', marketplacePath: null, fetchRepository: async () => ({ path: directory, pinned: false }) });
  const userSkills = await loadUserSkills({ directories: [join(directory, 'skills')], loadInstalled: async () => [] });
  expect(publicSkills.map(skill => skill.name)).toEqual(['actual']);
  expect(userSkills.map(skill => skill.name)).toEqual(['actual']);
});

it('selects marketplace files before parsing their declared skill names', async () => {
  const directory = await root();
  await file(directory, 'marketplaces/default.json', JSON.stringify({ name: 'fixture', owner: { name: 'fixture' }, plugins: [{ name: 'listed', source: './skills/listed.md' }] }));
  await file(directory, 'skills/listed.md', '---\nname: actual-name\n---\nSelected by filename');
  await file(directory, 'skills/unlisted.md', '---\nname: listed\n---\nMust not enter through name collision');
  const skills = await loadPublicSkills({ repoUrl: 'https://example.invalid/selection.git', fetchRepository: async () => ({ path: directory, pinned: false }) });
  expect(skills.map(skill => [skill.name, skill.content])).toEqual([['actual-name', 'Selected by filename']]);
});

it('uses the repository root as the public legacy skill-name base', async () => {
  const directory = await root(); await file(directory, 'skills/nested/example.md', 'No frontmatter');
  const skills = await loadPublicSkills({ repoUrl: 'https://example.invalid/names.git', marketplacePath: null, fetchRepository: async () => ({ path: directory, pinned: false }) });
  expect(skills.map(skill => skill.name)).toEqual(['skills/nested/example']);
});
