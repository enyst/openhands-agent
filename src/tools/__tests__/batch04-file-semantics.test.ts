import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileEditorExecutor, fileEditorActionSchema } from '../index.js';
import { FileEncodingManager } from '../file-encoding.js';

const roots: string[] = [];
async function file(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'batch04-editor-')); roots.push(root);
  const path = join(root, 'text.txt'); await writeFile(path, content); return path;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('UTF8 wins over statistical guesses', () => {
  it.each(['windows-1251', 'windows-1252', 'iso-8859-1'])('reads and edits valid UTF8 despite confident %s', async encoding => {
    const path = await file('{"title": "用户研究"}');
    const manager = new FileEncodingManager(() => ({ encoding, confidence: 1 }));
    const original = await manager.read(path);
    expect(original).toMatchObject({ encoding: 'utf-8', text: '{"title": "用户研究"}' });
    await manager.write(path, '{"title": "用户研究 🐾"}', original);
    expect(await readFile(path, 'utf8')).toBe('{"title": "用户研究 🐾"}');
  });
  it('treats BOM as encoding metadata and preserves it through edits and undo', async () => {
    const path = await file('\ufeffcafé\n');
    const manager = new FileEncodingManager(() => ({ encoding: 'windows-1251', confidence: 1 }));
    const original = await manager.read(path);
    expect(original).toMatchObject({ encoding: 'utf-8-sig', text: 'café\n' });
    await manager.write(path, 'caffè\n', original);
    expect(await readFile(path)).toEqual(Buffer.from('\ufeffcaffè\n'));
    await manager.restore(path, original);
    expect(await readFile(path)).toEqual(Buffer.from('\ufeffcafé\n'));
  });
});

describe('LF-only file editor lines', () => {
  it.each([
    ['', ''], ['hello', '1\thello'], ['hello\n', '1\thello'], ['hello\n\n', '1\thello\n2\t'],
    ['a\fb\nc\n', '1\ta\fb\n2\tc'], ['const s = "a\u2028b";\ngamma\n', '1\tconst s = "a\u2028b";\n2\tgamma'],
  ])('numbers %j without inventing lines', async (content, expected) => {
    const path = await file(content);
    const result = await new FileEditorExecutor().execute(fileEditorActionSchema.parse({ command: 'view', path }));
    expect(result).toMatchObject({ is_error: false, text: expected });
  });
  it.each(['a\nb', 'a\nb\n', 'a\nb\n\n', 'a\n\n', '\n'])('ranged view preserves final line in %j', async content => {
    const path = await file(content); const editor = new FileEditorExecutor();
    const lines = content.split('\n'); if (lines.at(-1) === '') lines.pop();
    const view = (range?: number[]) => editor.execute(fileEditorActionSchema.parse({ command: 'view', path, view_range: range }));
    const full = await view();
    expect((await view([1, lines.length])).text).toBe(full.text);
    expect((await view([lines.length, lines.length])).text).toBe(`${lines.length}\t${lines.at(-1)}`);
  });
  it('inserts after the line shown despite form feeds inside it', async () => {
    const path = await file('int a;\fint b;\nint c;\n');
    const editor = new FileEditorExecutor();
    const viewed = await editor.execute(fileEditorActionSchema.parse({ command: 'view', path }));
    expect(viewed.text).toBe('1\tint a;\fint b;\n2\tint c;');
    expect((await editor.execute(fileEditorActionSchema.parse({ command: 'insert', path, insert_line: 2, new_str: 'int NEW;' }))).is_error).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('int a;\fint b;\nint c;\nint NEW;\n');
  });
});
