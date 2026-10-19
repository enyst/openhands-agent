import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as git from '../index.js';

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sdk-nested-changes-'));
  roots.push(root);
  return root;
}
async function repository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git.runGitCommand(['git', 'init', '-q', '-b', 'main'], { cwd: path });
  await writeFile(join(path, 'README.md'), 'hello\n');
  await git.runGitCommand(['git', 'add', 'README.md'], { cwd: path });
  await git.runGitCommand(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial'], { cwd: path });
}
async function edit(path: string): Promise<void> {
  await writeFile(join(path, 'README.md'), 'hello\nedit\n');
  await writeFile(join(path, 'notes.txt'), 'note\n');
}
async function broken(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, '.git'), 'gitdir: /nonexistent-sdk-fixture-git-directory\n');
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('workspace Git change aggregation (upstream d5995133)', () => {
  it('lists prefixed tracked and untracked changes below a non-repository directory', async () => {
    const root = await fixture();
    await repository(join(root, 'proj')); await edit(join(root, 'proj'));
    expect(await git.getGitChanges(root, 'HEAD')).toEqual([
      { status: 'UPDATED', path: 'proj/README.md' },
      { status: 'ADDED', path: 'proj/notes.txt' },
    ]);
  });

  it('counts a clean nested repository as valid', async () => {
    const root = await fixture(); await repository(join(root, 'clean'));
    expect(await git.getGitChanges(root)).toEqual([]);
  });

  it('preserves the repository error for plain directories and broken markers only', async () => {
    const root = await fixture();
    await expect(git.getGitChanges(join(root, 'missing'))).rejects.toBeInstanceOf(git.GitRepositoryError);
    await expect(git.getGitChanges(root)).rejects.toBeInstanceOf(git.GitRepositoryError);
    await broken(join(root, 'broken'));
    await expect(git.getGitChanges(root)).rejects.toBeInstanceOf(git.GitRepositoryError);
  });

  it('skips broken children when another child is valid', async () => {
    const root = await fixture();
    await broken(join(root, 'broken')); await repository(join(root, 'valid')); await edit(join(root, 'valid'));
    expect((await git.getGitChanges(root, 'HEAD')).map(change => change.path)).toEqual(['valid/README.md', 'valid/notes.txt']);
  });

  it('deduplicates nested paths without hiding similar sibling names', async () => {
    const root = await fixture(); await repository(root);
    await repository(join(root, 'foo')); await edit(join(root, 'foo'));
    await mkdir(join(root, 'foobar')); await writeFile(join(root, 'foobar', 'file.py'), 'sibling\n');
    await writeFile(join(root, 'foo-config.yaml'), 'sibling\n');
    expect(await git.getGitChanges(root, 'HEAD')).toEqual([
      { status: 'ADDED', path: 'foo-config.yaml' },
      { status: 'UPDATED', path: 'foo/README.md' },
      { status: 'ADDED', path: 'foo/notes.txt' },
      { status: 'ADDED', path: 'foobar/file.py' },
    ]);
  });

  it('accepts worktree .git files as immediate repository markers', async () => {
    const root = await fixture(); const owner = join(root, 'owner'); const workspace = join(root, 'workspace');
    await repository(owner); await mkdir(workspace);
    const worktree = join(workspace, 'linked');
    await git.runGitCommand(['git', 'worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: owner });
    await edit(worktree);
    expect((await git.getGitChanges(workspace, 'HEAD')).map(change => change.path)).toEqual(['linked/README.md', 'linked/notes.txt']);
  });

  it('matches one-level non-hidden discovery rather than recursively scanning arbitrary directories', async () => {
    const root = await fixture();
    await repository(join(root, 'level', 'deep')); await edit(join(root, 'level', 'deep'));
    await repository(join(root, '.hidden')); await edit(join(root, '.hidden'));
    await expect(git.getGitChanges(root, 'HEAD')).rejects.toBeInstanceOf(git.GitRepositoryError);
  });

  it('follows an immediate symlinked directory as Python glob does', async () => {
    const root = await fixture(); const owner = join(root, 'owner'); const workspace = join(root, 'workspace');
    await repository(owner); await edit(owner); await mkdir(workspace);
    await symlink(owner, join(workspace, 'alias'), 'dir');
    expect((await git.getGitChanges(workspace, 'HEAD')).map(change => change.path)).toEqual(['alias/README.md', 'alias/notes.txt']);
  });

  it('sorts by Unicode code points instead of locale or UTF-16 code units', async () => {
    const root = await fixture();
    for (const name of ['\u{10000}', '\ue000', 'a', 'Z']) {
      await repository(join(root, name)); await writeFile(join(root, name, 'new.txt'), 'new\n');
    }
    expect((await git.getGitChanges(root, 'HEAD')).map(change => change.path)).toEqual(['Z/new.txt', 'a/new.txt', '\ue000/new.txt', '\u{10000}/new.txt']);
  });

  it('does not swallow a base repository invalid-ref error', async () => {
    const root = await fixture(); await repository(root); await repository(join(root, 'child'));
    await expect(git.getGitChanges(root, 'missing-ref')).rejects.toBeInstanceOf(git.GitCommandError);
  });

  it('forwards refs and skips nested Git failures while retaining the base result', async () => {
    const root = await fixture(); await repository(root); await repository(join(root, 'child'));
    await git.runGitCommand(['git', 'tag', 'parent-only'], { cwd: root });
    await edit(root); await edit(join(root, 'child'));
    expect(await git.getGitChanges(root, 'parent-only')).toEqual([
      { status: 'UPDATED', path: 'README.md' }, { status: 'ADDED', path: 'notes.txt' },
    ]);
  });
});
