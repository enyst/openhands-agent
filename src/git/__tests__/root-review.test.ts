import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { fetchWithResolution } from '../../extensions/index.js';
import { atomicWriteText } from '../../utils/files.js';
import { cachedGitFetcher } from '../cached-repo.js';

const roots: string[] = [];
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function root(): string { const directory = mkdtempSync(join(tmpdir(), 'sdk04-root-review-')); roots.push(directory); return directory; }
function git(cwd: string, ...args: string[]): string { return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }

it('checks out a requested cached ref without fetching when update is false', async () => {
  const directory = root(); const source = join(directory, 'source'); mkdirSync(source); git(source, 'init', '-b', 'main');
  writeFileSync(join(source, 'content'), 'old'); git(source, 'add', '.'); git(source, 'commit', '-m', 'old'); const old = git(source, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'content'), 'new'); git(source, 'commit', '-am', 'new');
  const destination = join(directory, 'cache'); await cachedGitFetcher(source, destination, { ref: null, update: true });
  git(destination, 'remote', 'set-url', 'origin', join(directory, 'missing'));
  expect(await cachedGitFetcher(source, destination, { ref: old, update: false })).toBe(old);
  expect(readFileSync(join(destination, 'content'), 'utf8')).toBe('old');
  await expect(cachedGitFetcher(source, destination, { ref: 'missing-ref', update: false })).rejects.toThrow(/checkout/u);
});

it('normalizes empty GitHub shorthand subpaths before checking explicit repoPath ambiguity', async () => {
  const directory = root();
  const result = await fetchWithResolution('github:owner/repo//', directory, { repoPath: 'skills', gitFetcher: async (_url, destination) => {
    mkdirSync(join(destination, 'skills'), { recursive: true }); return 'sha';
  } });
  expect(result.path.endsWith('/skills')).toBe(true);
});

it('applies the exact explicit atomic file mode independently of process umask', () => {
  const target = join(root(), 'state.json');
  // Vitest workers cannot mutate the shared process umask; exercise the API in a child.
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { atomicWriteText } from './src/utils/files.ts'; process.umask(0o077); atomicWriteText(process.argv[1], 'value', 0o640);`, target], { cwd: process.cwd(), stdio: 'pipe' });
  expect(statSync(target).mode & 0o777).toBe(0o640);
  // Also keep this module's public import exercised independently of the child.
  atomicWriteText(target, 'replacement'); expect(readFileSync(target, 'utf8')).toBe('replacement');
});
