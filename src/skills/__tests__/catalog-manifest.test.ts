import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { invalidatePublicSkillsCache, loadPublicSkills } from '../catalog.js';
import { parseSkillsMarketplace } from '../catalog-manifest.js';

const roots: string[] = [];
afterEach(async () => { invalidatePublicSkillsCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const base = { name: 'fixture', owner: { name: 'Fixture' } };
const entry = { name: 'one', source: './skills/one' };
const cases = [
  { name: 'omitted plugins are a valid empty selection', manifest: base, valid: true, expected: [] },
  { name: 'empty plugins are a valid empty selection', manifest: { ...base, plugins: [] }, valid: true, expected: [] },
  { name: 'valid plugin selects only its named skill', manifest: { ...base, plugins: [entry] }, valid: true, expected: ['one'] },
  { name: 'structured GitHub source is valid with repo', manifest: { ...base, plugins: [{ ...entry, source: { source: 'github', repo: 'owner/repo' }, strict: 'false' }] }, valid: true, expected: ['one'] },
  { name: 'unknown source kind is accepted by source validation', manifest: { ...base, plugins: [{ ...entry, source: { source: 'future' } }] }, valid: true, expected: ['one'] },
  { name: 'missing root identity and plugin source is invalid', manifest: { plugins: [{ name: 'one' }] }, valid: false, expected: [] },
  { name: 'missing plugin source is invalid', manifest: { ...base, plugins: [{ name: 'one' }] }, valid: false, expected: [] },
  { name: 'structured GitHub source needs repo', manifest: { ...base, plugins: [{ ...entry, source: { source: 'github' } }] }, valid: false, expected: [] },
  { name: 'null plugin list is invalid', manifest: { ...base, plugins: null }, valid: false, expected: [] },
  { name: 'invalid optional metadata is invalid', manifest: { ...base, metadata: { version: 1 }, plugins: [entry] }, valid: false, expected: [] },
  { name: 'invalid unused standalone entry is invalid', manifest: { ...base, skills: [{ name: 'other' }], plugins: [entry] }, valid: false, expected: [] },
  { name: 'invalid optional plugin commands are invalid', manifest: { ...base, plugins: [{ ...entry, commands: 42 }] }, valid: false, expected: [] },
  { name: 'author name may be absent but cannot be null', manifest: { ...base, plugins: [{ ...entry, author: { name: null } }] }, valid: false, expected: [] },
];

it('exposes the validated catalog projection with both omitted entry lists normalized', () => {
  expect(parseSkillsMarketplace(base)).toMatchObject({ ...base, plugins: [], skills: [] });
});

it('preserves catalog source metadata without installing or resolving a plugin', () => {
  const source = { source: 'github', repo: 'owner/repo', ref: 'v1', path: 'skills/one' };
  const parsed = parseSkillsMarketplace({ ...base,
    plugins: [{ name: 'one', description: 'Plugin skill', source }],
    skills: [{ name: 'two', description: 'Standalone skill', source: './skills/two' }],
  });
  expect(parsed.plugins[0]).toMatchObject({ name: 'one', description: 'Plugin skill', source });
  expect(parsed.skills[0]).toMatchObject({ name: 'two', description: 'Standalone skill', source: './skills/two' });
  expect(() => parseSkillsMarketplace({ ...base, plugins: [{ name: 'one' }] })).toThrow();
});

// Pinned Python skill.py::load_marketplace_skill_names validates Marketplace,
// including defaults. Invalid default manifests fall back; invalid custom ones do not.
for (const path of ['marketplaces/default.json', 'marketplaces/custom.json']) {
  it.each(cases)(`${path}: $name`, async ({ manifest, valid, expected }) => {
    const root = await mkdtemp(join(tmpdir(), 'sdk-catalog-manifest-')); roots.push(root);
    for (const name of ['one', 'two']) {
      await mkdir(join(root, 'skills', name), { recursive: true });
      await writeFile(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture\n---\n${name}`);
    }
    await mkdir(join(root, 'marketplaces'));
    await writeFile(join(root, path), JSON.stringify(manifest));
    const skills = await loadPublicSkills({ repoUrl: `https://example.invalid/${root}`, marketplacePath: path, fetchRepository: async () => ({ path: root, pinned: false }) });
    expect(skills.map(skill => skill.name).sort()).toEqual(!valid && path === 'marketplaces/default.json' ? ['one', 'two'] : expected);
  });
}
