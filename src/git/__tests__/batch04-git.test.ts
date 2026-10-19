import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getGitDiff, normalizeGitUrl, runGitCommand } from '../index.js';
import { parseExtensionSource } from '../../extensions/index.js';

describe('Azure clone URLs', () => {
  it.each([
    'https://dev.azure.com/org/project/_git/repo', 'https://org@dev.azure.com/org/Web%20Apps/_git/skills',
    'https://org.visualstudio.com/project/_git/repo', 'https://tfs.example.com/tfs/Collection/project/_git/repo',
  ])('does not append a repository-changing suffix to %s', source => {
    expect(normalizeGitUrl(source)).toBe(source);
    expect(normalizeGitUrl(source + '/')).toBe(source);
    expect(parseExtensionSource(source)).toEqual({ type: 'git', url: source });
  });
  it('checks parsed path rather than a query occurrence', () => {
    expect(normalizeGitUrl('https://example.com/repo?path=/_git/repo')).toBe('https://example.com/repo?path=/_git/repo.git');
    expect(normalizeGitUrl('https://example.com/repo')).toBe('https://example.com/repo.git');
  });
});

describe('Git blob edge whitespace', () => {
  it.each(['  indented line\nbody\n', 'body\n\n\n', '\n\nbody\n', 'one\r\ntwo\r\n', 'one\rtwo\r', 'a\fb\u2028c\n'])('keeps unchanged sides identical for %j', async content => {
    const root = await mkdtemp(join(tmpdir(), 'batch04-git-'));
    try {
      await runGitCommand(['git', 'init'], { cwd: root });
      await runGitCommand(['git', 'config', 'user.name', 'Fixture'], { cwd: root });
      await runGitCommand(['git', 'config', 'user.email', 'fixture@example.invalid'], { cwd: root });
      const path = join(root, 'text.txt'); await writeFile(path, content);
      await runGitCommand(['git', 'add', 'text.txt'], { cwd: root });
      await runGitCommand(['git', 'commit', '-m', 'fixture'], { cwd: root });
      expect(await runGitCommand(['git', 'show', 'HEAD:text.txt'], { cwd: root, strip: false })).toBe(content);
      // Python splitlines deliberately includes these Unicode/control separators.
      // eslint-disable-next-line no-control-regex
      const expected = content.replace(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/gu, '\n').replace(/\n$/u, '');
      const diff = await getGitDiff(path, 'HEAD');
      expect(diff.original).toBe(expected); expect(diff.modified).toBe(expected);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
