import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { fetchWithResolution, getCachePath, parseExtensionSource } from '../index.js';

it('resolves GitHub shorthand subpaths from one repository cache and refuses ambiguous or escaping paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sdk-extension-'));
  try {
    const fetcher = vi.fn(async (_url: string, destination: string) => { await mkdir(join(destination, 'skills', 'one'), { recursive: true }); return 'sha'; });
    const a = await fetchWithResolution('github:owner/repo/skills/one', dir, { gitFetcher: fetcher });
    expect(a.path).toBe(join(getCachePath('github:owner/repo', dir), 'skills', 'one'));
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://github.com/owner/repo.git');
    expect(getCachePath('github:owner/repo/skills/two', dir)).toBe(getCachePath('github:owner/repo', dir));
    await expect(fetchWithResolution('github:owner/repo/skills/one', dir, { repoPath: 'other', gitFetcher: fetcher })).rejects.toThrow(/repoPath|repo_path/u);
    await expect(fetchWithResolution('github:owner/repo/../escape', dir, { gitFetcher: fetcher })).rejects.toThrow(/escapes/u);
    expect(() => parseExtensionSource('github:owner')).toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('rejects repository subpaths escaping through symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sdk-extension-'));
  try {
    await mkdir(join(dir, 'repo')); await mkdir(join(dir, 'outside')); await symlink(join(dir, 'outside'), join(dir, 'repo', 'link'));
    await expect(fetchWithResolution(join(dir, 'repo'), dir, { repoPath: 'link' })).rejects.toThrow(/escapes/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
