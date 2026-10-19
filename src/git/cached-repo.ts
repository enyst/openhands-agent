import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { LocalFileStore } from '../io/index.js';

const execute = promisify(execFile);
export interface CachedGitOptions { readonly ref: string | null; readonly update: boolean; readonly strict?: boolean }

export async function isCachedGitPinned(directory: string): Promise<boolean> {
  try { await execute('git', ['-C', directory, 'symbolic-ref', '--quiet', 'HEAD']); return false; }
  catch { await execute('git', ['-C', directory, 'rev-parse', '--verify', 'HEAD']); return true; }
}

/** For disposable SDK cache directories only: branch updates reset cached files. */
export async function cachedGitFetcher(url: string, destination: string, options: CachedGitOptions): Promise<string> {
  if (options.ref?.startsWith('-')) throw new Error('Git cache ref must not be an option');
  await mkdir(dirname(destination), { recursive: true });
  const lockStore = new LocalFileStore(dirname(destination));
  return lockStore.lockAsync(`.${basename(destination)}.git-cache.lock`, async () => {
    const git = async (...args: string[]): Promise<string> => {
      try {
        const { stdout } = await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', destination, ...args], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        return stdout.trim();
      } catch { throw new Error(`Git cache ${args[0] ?? 'operation'} failed`); }
    };
    const branch = async (): Promise<string | null> => { try { return await git('symbolic-ref', '--quiet', '--short', 'HEAD'); } catch { return null; } };
    const resetBranch = async (): Promise<void> => { const current = await branch(); if (current) { try { await git('reset', '--hard', `origin/${current}`); } catch { /* Source tolerates a local-only branch. */ } } };
    const checkout = async (ref: string): Promise<void> => { await git('checkout', ref); await resetBranch(); };
    if (!existsSync(join(destination, '.git'))) {
      try { await execute('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--', url, destination], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); }
      catch { throw new Error('Git cache clone failed'); }
      if (options.ref) await checkout(options.ref);
      return git('rev-parse', 'HEAD');
    }
    if (!options.update) { if (options.ref) await checkout(options.ref); return git('rev-parse', 'HEAD'); }
    if (options.ref) {
      try { await git('checkout', options.ref); if (await branch() === null) return git('rev-parse', 'HEAD'); }
      catch { /* A missing local ref may become available after fetch. */ }
    }
    try { await git('fetch', 'origin', '--tags'); }
    catch (error) { if (options.strict) throw error; return git('rev-parse', 'HEAD'); }
    if (options.ref) {
      try { await checkout(options.ref); } catch (error) { if (options.strict) throw error; }
    } else if (await branch()) await resetBranch();
    else {
      try { const originHead = await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD'); await checkout(originHead.replace(/^origin\//u, '')); }
      catch { /* Source preserves a detached cached checkout if recovery fails. */ }
    }
    return git('rev-parse', 'HEAD');
  }, { recoverStaleLocks: false, timeoutSeconds: 65 });
}
