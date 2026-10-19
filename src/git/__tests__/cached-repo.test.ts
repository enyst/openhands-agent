import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cachedGitFetcher } from '../cached-repo.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]): string { return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function fixture() { const root = mkdtempSync(join(tmpdir(), 'sdk-cache-')); roots.push(root); const source = join(root, 'source'); mkdirSync(source); git(source, 'init', '-b', 'main'); writeFileSync(join(source, 'content'), 'old'); git(source, 'add', '.'); git(source, 'commit', '-m', 'initial'); const sha = git(source, 'rev-parse', 'HEAD'); return { root, source, destination: join(root, 'cache'), sha }; }

it('updates a real owned cached branch and propagates failed strict fetch while lenient callers keep cache', async () => {
  const f = fixture(); await cachedGitFetcher(f.source, f.destination, { ref: 'main', update: true });
  writeFileSync(join(f.source, 'content'), 'new'); git(f.source, 'commit', '-am', 'next');
  await cachedGitFetcher(f.source, f.destination, { ref: 'main', update: true, strict: true });
  expect(readFileSync(join(f.destination, 'content'), 'utf8')).toBe('new');
  git(f.destination, 'remote', 'set-url', 'origin', join(f.root, 'missing'));
  await expect(cachedGitFetcher(f.source, f.destination, { ref: 'main', update: true, strict: true })).rejects.toThrow(/fetch/u);
  await expect(cachedGitFetcher(f.source, f.destination, { ref: 'main', update: true })).resolves.toBe(git(f.destination, 'rev-parse', 'HEAD'));
});

it('skips fetch for a locally available immutable pin and reports an unavailable ref in strict mode', async () => {
  const f = fixture(); await cachedGitFetcher(f.source, f.destination, { ref: null, update: true });
  await expect(cachedGitFetcher(f.source, f.destination, { ref: 'not-a-ref', update: true, strict: true })).rejects.toThrow(/checkout/u);
  git(f.destination, 'remote', 'set-url', 'origin', join(f.root, 'missing'));
  await expect(cachedGitFetcher(f.source, f.destination, { ref: f.sha, update: true, strict: true })).resolves.toBe(f.sha);
});
