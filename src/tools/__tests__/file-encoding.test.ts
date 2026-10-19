import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileEditorExecutor, fileEditorActionSchema } from '../index.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const temporaryDirectories: string[] = [];
async function fixture(bytes: Uint8Array): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openhands-encoding-'));
  temporaryDirectories.push(root);
  const path = join(root, 'text.txt');
  await writeFile(path, bytes);
  return path;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const russianText = 'Привет мир, это тест\n';
const russianBytes = Buffer.from('cff0e8e2e5f220ece8f02c20fdf2ee20f2e5f1f20a', 'hex');
const frenchText = 'Café résumé\n';
const frenchBytes = Buffer.from('436166e92072e973756de90a', 'hex');
const view = (editor: FileEditorExecutor, path: string) => editor.execute(fileEditorActionSchema.parse({ command: 'view', path }));
const edit = (editor: FileEditorExecutor, path: string, old_str: string, new_str: string) => editor.execute(fileEditorActionSchema.parse({ command: 'str_replace', path, old_str, new_str }));
const undo = (editor: FileEditorExecutor, path: string) => editor.execute(fileEditorActionSchema.parse({ command: 'undo_edit', path }));

describe('file editor encoding recovery', () => {
  // Upstream e1e8950 test_validate_short_non_utf8_text_file, with actual text
  // assertions rather than only checking that a decoder returned something.
  it.each([
    ['Latin-1', frenchText, frenchBytes],
    ['CP1251', russianText, russianBytes],
    ['CP1251 second sample', 'До свидания\n', Buffer.from('c4ee20f1e2e8e4e0ede8ff0a', 'hex')],
    ['CP1252 punctuation', '“Résumé” costs €5.\r\n', Buffer.from('9352e973756de99420636f7374732080352e0d0a', 'hex')],
    ['UTF-8', '日本語: café 🐾\n', Buffer.from('日本語: café 🐾\n')],
  ])('automatically reads %s without replacement characters', async (_name, text, bytes) => {
    const result = await view(new FileEditorExecutor(), await fixture(bytes));
    expect(result.is_error).toBe(false);
    expect(result.text).toContain(text.trimEnd());
    expect(result.text).not.toContain('\ufffd');
  });

  it.each(['Windows_1251', 'windows-1251', 'cp1251'])('tries a low-confidence trusted %s guess before CP1252', async (encoding) => {
    const detector = vi.fn(() => ({ encoding, confidence: 0.3 }));
    const editor = new FileEditorExecutor({ encodingDetector: detector });
    expect((await view(editor, await fixture(russianBytes))).text).toContain(russianText.trimEnd());
    expect(detector).toHaveBeenCalled();
  });

  it.each(['cp1006', null])('ignores an untrusted recovery guess %s and tries CP1252 before Latin-1', async (encoding) => {
    const bytes = Buffer.from('9352e973756de99420636f7374732080352e0d0a', 'hex');
    const editor = new FileEditorExecutor({ encodingDetector: () => ({ encoding, confidence: 0.5 }) });
    expect((await view(editor, await fixture(bytes))).text).toContain('“Résumé” costs €5.');
  });

  it.each(['ISO_8859_1', 'iso-8859-15', 'latin-1'])('recognizes the recovery alias %s as byte-preserving Latin-1', async (encoding) => {
    const editor = new FileEditorExecutor({ encodingDetector: () => ({ encoding, confidence: 0.5 }) });
    const path = await fixture(Buffer.from([0xa4, 0x81, 0xe9, 0x0a]));
    expect((await view(editor, path)).text).toContain('¤\u0081é');
    expect((await edit(editor, path, 'é', 'è')).is_error).toBe(false);
    expect(await readFile(path)).toEqual(Buffer.from([0xa4, 0x81, 0xe8, 0x0a]));
  });

  it('rejects undefined CP1252 bytes and falls back to Latin-1', async () => {
    const editor = new FileEditorExecutor({ encodingDetector: () => null });
    const bytes = Buffer.from([0x81, 0x8d, 0x8f, 0x90, 0x9d, 0xe9, 0x0a]);
    const path = await fixture(bytes);
    expect((await view(editor, path)).text).toContain('\u0081\u008d\u008f\u0090\u009dé');
    expect((await edit(editor, path, 'é', 'è')).is_error).toBe(false);
    expect(await readFile(path)).toEqual(Buffer.from([0x81, 0x8d, 0x8f, 0x90, 0x9d, 0xe8, 0x0a]));
  });

  it('rejects undefined CP1251 bytes before trying the remaining recovery candidates', async () => {
    const editor = new FileEditorExecutor({ encodingDetector: () => ({ encoding: 'windows-1251', confidence: 0.5 }) });
    expect((await view(editor, await fixture(Buffer.from([0x98, 0xe9, 0x0a])))).text).toContain('˜é');
  });

  it.each([0.9, 0.9001])('uses the strict upstream confidence threshold for %s', async (confidence) => {
    const editor = new FileEditorExecutor({ encodingDetector: () => ({ encoding: 'cp1251', confidence }) });
    const path = await fixture(Buffer.from([0x98, 0xe9, 0x0a]));
    const result = await view(editor, path);
    expect(result.is_error).toBe(confidence > 0.9);
    if (confidence === 0.9) expect(result.text).toContain('˜é');
  });

  it('reports an unsupported confident codec instead of silently decoding it as another codec', async () => {
    const editor = new FileEditorExecutor({ encodingDetector: () => ({ encoding: 'cp1006', confidence: 1 }) });
    const path = await fixture(frenchBytes);
    expect(await view(editor, path)).toMatchObject({ is_error: true, text: expect.stringContaining('Unsupported detected text encoding: cp1006') });
    expect((await edit(editor, path, 'Café', 'Cafe')).is_error).toBe(true);
    expect(await readFile(path)).toEqual(frenchBytes);
  });

  // Differential evidence at pinned Python 229b2b92: charset_normalizer resolves
  // these to KOI8-R/windows-1253 at confidence 1 and reads the original text.
  // Native chardet resolves KOI8-R/.27 and ISO-8859-7/.18; until those codecs
  // have roundtrip support, reject instead of choosing clean CP1252 mojibake.
  it.each([
    ['KOI8-R', 'Это русский текст. Проверка кодировки файла.\n', 'fcd4cf20d2d5d3d3cbc9ca20d4c5cbd3d42e20f0d2cfd7c5d2cbc120cbcfc4c9d2cfd7cbc920c6c1caccc12e0a'],
    ['ISO-8859-7', 'Αυτό είναι ένα ελληνικό κείμενο.\n', 'c1f5f4fc20e5dfede1e920ddede120e5ebebe7ede9eafc20eae5dfece5edef2e0a'],
  ])('fails closed on the recognized unsupported %s differential fixture', async (encoding, originalText, hex) => {
    const original = Buffer.from(hex, 'hex');
    const path = await fixture(original);
    const editor = new FileEditorExecutor();
    expect(await view(editor, path)).toMatchObject({ is_error: true, text: expect.stringContaining(`Unsupported detected text encoding: ${encoding}`) });
    expect((await edit(editor, path, originalText, 'replacement')).is_error).toBe(true);
    expect(await readFile(path)).toEqual(original);
    expect((await undo(editor, path)).is_error).toBe(true);
  });

  it.each(['KOI8-R', 'ISO-8859-7'])('accepts strict UTF-8 despite an uncertain unsupported %s guess', async (encoding) => {
    const editor = new FileEditorExecutor({ encodingDetector: () => ({ encoding, confidence: 0.3 }) });
    const path = await fixture(Buffer.from('日本語: café 🐾\n'));
    expect((await view(editor, path)).text).toContain('日本語: café 🐾');
    expect((await edit(editor, path, 'café', 'caffè')).is_error).toBe(false);
    expect(await readFile(path)).toEqual(Buffer.from('日本語: caffè 🐾\n'));
  });

  it.each([0, 1, 8, 14, 31, 127])('rejects binary control byte %i without changing the file', async (control) => {
    const original = Buffer.from([0x61, control, 0x62, 0x0a]);
    const path = await fixture(original);
    const editor = new FileEditorExecutor();
    expect((await view(editor, path)).is_error).toBe(true);
    expect((await edit(editor, path, 'a', 'c')).is_error).toBe(true);
    expect((await editor.execute(fileEditorActionSchema.parse({ command: 'insert', path, insert_line: 0, new_str: 'c' }))).is_error).toBe(true);
    expect(await readFile(path)).toEqual(original);
    expect((await undo(editor, path)).is_error).toBe(true);
  });

  it('allows text whitespace and a textual PDF header', async () => {
    const text = '%PDF-1.4\nThis is a fake PDF file for testing\t\v\f\r\n';
    const result = await view(new FileEditorExecutor(), await fixture(Buffer.from(text)));
    expect(result.is_error).toBe(false);
    expect(result.text).toContain('This is a fake PDF file for testing');
  });

  it('checks the whole file even though detection samples at most one MiB', async () => {
    const detector = vi.fn(() => ({ encoding: 'utf-8', confidence: 1 }));
    const path = await fixture(Buffer.concat([Buffer.alloc(1024 * 1024, 0x61), Buffer.from([0])]));
    expect((await view(new FileEditorExecutor({ encodingDetector: detector }), path)).is_error).toBe(true);
    expect(detector).toHaveBeenCalled();
    for (const call of detector.mock.calls as unknown as [Uint8Array][]) expect(call[0].length).toBe(1024 * 1024);
  });
});

describe('encoding-preserving edits', () => {
  it('preserves CP1251 through replace, insert, and two byte-exact undos', async () => {
    const path = await fixture(russianBytes);
    const editor = new FileEditorExecutor();
    const result = await edit(editor, path, 'Привет', 'До свидания');
    expect(result).toMatchObject({ is_error: false, old_content: russianText, new_content: 'До свидания мир, это тест\n' });
    const replaced = Buffer.from('c4ee20f1e2e8e4e0ede8ff20ece8f02c20fdf2ee20f2e5f1f20a', 'hex');
    expect(await readFile(path)).toEqual(replaced);
    expect((await editor.execute(fileEditorActionSchema.parse({ command: 'insert', path, insert_line: 0, new_str: 'Тест строки' }))).is_error).toBe(false);
    expect(await readFile(path)).toEqual(Buffer.concat([Buffer.from('d2e5f1f220f1f2f0eeeae80a', 'hex'), replaced]));
    expect((await undo(editor, path)).is_error).toBe(false);
    expect(await readFile(path)).toEqual(replaced);
    expect((await undo(editor, path)).is_error).toBe(false);
    expect(await readFile(path)).toEqual(russianBytes);
  });

  it('preserves CP1252 punctuation, CRLF bytes, and permissions through replace and undo', async () => {
    const original = Buffer.from('9352e973756de99420636f7374732080352e0d0a', 'hex');
    const path = await fixture(original);
    const editor = new FileEditorExecutor({ encodingDetector: () => ({ encoding: 'windows-1252', confidence: 0.6 }) });
    await filesystem.chmod(path, 0o751);
    const mode = (await stat(path)).mode;
    expect((await edit(editor, path, '€5', '€6')).is_error).toBe(false);
    expect(await readFile(path)).toEqual(Buffer.from('9352e973756de99420636f7374732080362e0d0a', 'hex'));
    expect((await stat(path)).mode).toBe(mode);
    expect((await undo(editor, path)).is_error).toBe(false);
    expect(await readFile(path)).toEqual(original);
  });

  it('upgrades the whole file to UTF-8 only when an edit cannot be encoded, then restores original bytes', async () => {
    const path = await fixture(frenchBytes);
    const editor = new FileEditorExecutor({ encodingDetector: () => ({ encoding: 'latin-1', confidence: 0.5 }) });
    expect((await edit(editor, path, 'résumé', 'résumé 🐾')).is_error).toBe(false);
    expect(await readFile(path)).toEqual(Buffer.from('Café résumé 🐾\n'));
    // The remembered encoding must follow a successful write, not an old detector guess.
    expect((await view(editor, path)).text).toContain('Café résumé 🐾');
    expect((await undo(editor, path)).is_error).toBe(false);
    expect(await readFile(path)).toEqual(frenchBytes);
    expect((await view(editor, path)).text).toContain('Café résumé');
  });

  it('preserves a UTF-8 BOM through edits and undo', async () => {
    const bytes = Buffer.from('\ufeffcafé\r\n');
    const path = await fixture(bytes);
    const editor = new FileEditorExecutor();
    expect((await edit(editor, path, 'café', 'caffè')).is_error).toBe(false);
    expect(await readFile(path)).toEqual(Buffer.from('\ufeffcaffè\r\n'));
    expect((await undo(editor, path)).is_error).toBe(false);
    expect(await readFile(path)).toEqual(bytes);
  });

  it('continues to follow symlinks when replacing and restoring encoded files', async () => {
    const path = await fixture(frenchBytes);
    const link = join(path, '..', 'linked.txt');
    await filesystem.symlink(path, link);
    const editor = new FileEditorExecutor();
    expect((await edit(editor, link, 'Café', 'Cafe')).is_error).toBe(false);
    expect((await filesystem.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(path)).toEqual(Buffer.from('436166652072e973756de90a', 'hex'));
    expect((await undo(editor, link)).is_error).toBe(false);
    expect(await readFile(path)).toEqual(frenchBytes);
    expect((await filesystem.lstat(link)).isSymbolicLink()).toBe(true);
  });

  it('reuses a cached encoding but redetects external changes even when size and mtime match', async () => {
    const path = await fixture(Buffer.from([0xe9]));
    const detector = vi.fn((bytes: Uint8Array) => ({ encoding: bytes[0] === 0xe9 ? 'latin-1' : 'cp1251', confidence: 0.6 }));
    const editor = new FileEditorExecutor({ encodingDetector: detector });
    expect((await view(editor, path)).text).toContain('é');
    const callsAfterFirstRead = detector.mock.calls.length;
    expect((await view(editor, path)).text).toContain('é');
    expect(detector).toHaveBeenCalledTimes(callsAfterFirstRead);
    const info = await stat(path);
    await writeFile(path, Buffer.from([0xdf]));
    await utimes(path, info.atime, info.mtime);
    expect((await view(editor, path)).text).toContain('Я');
    expect(detector.mock.calls.length).toBeGreaterThan(callsAfterFirstRead);
  });

  it('leaves original bytes and history intact when an atomic edit fails', async () => {
    const path = await fixture(frenchBytes);
    const editor = new FileEditorExecutor();
    vi.mocked(filesystem.rename).mockRejectedValueOnce(new Error('replace failed'));
    expect(await edit(editor, path, 'Café', 'Cafe')).toMatchObject({ is_error: true, text: 'replace failed' });
    expect(await readFile(path)).toEqual(frenchBytes);
    expect(await filesystem.readdir(temporaryDirectories.at(-1)!)).toEqual(['text.txt']);
    expect((await undo(editor, path)).is_error).toBe(true);
  });

  it('keeps the undo entry available when restoration fails', async () => {
    const path = await fixture(russianBytes);
    const editor = new FileEditorExecutor();
    expect((await edit(editor, path, 'Привет', 'До свидания')).is_error).toBe(false);
    const editedBytes = await readFile(path);
    vi.mocked(filesystem.rename).mockRejectedValueOnce(new Error('undo replace failed'));
    expect((await undo(editor, path)).is_error).toBe(true);
    expect(await readFile(path)).toEqual(editedBytes);
    expect((await undo(editor, path)).is_error).toBe(false);
    expect(await readFile(path)).toEqual(russianBytes);
  });

  it('rejects unpaired surrogate edits before writing replacement bytes', async () => {
    const path = await fixture(frenchBytes);
    const editor = new FileEditorExecutor();
    expect((await edit(editor, path, 'Café', '\ud800')).is_error).toBe(true);
    expect(await readFile(path)).toEqual(frenchBytes);
    expect((await undo(editor, path)).is_error).toBe(true);
  });

  it('creates UTF-8 files and rejects unpaired surrogates before creating a file', async () => {
    const existing = await fixture(Buffer.from('existing'));
    const path = join(existing, '..', 'new.txt');
    const invalidPath = join(existing, '..', 'invalid.txt');
    const editor = new FileEditorExecutor();
    expect((await editor.execute(fileEditorActionSchema.parse({ command: 'create', path, file_text: '日本語 🐾' }))).is_error).toBe(false);
    expect(await readFile(path)).toEqual(Buffer.from('日本語 🐾'));
    expect((await editor.execute(fileEditorActionSchema.parse({ command: 'create', path: invalidPath, file_text: '\udc00' }))).is_error).toBe(true);
    await expect(stat(invalidPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
