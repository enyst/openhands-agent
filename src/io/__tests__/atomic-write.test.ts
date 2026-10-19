import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalFileStore } from '../index.js';
import { atomicWriteText, isTempFile } from '../../utils/files.js';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof fs>() }));

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function root(): string { const value = fs.mkdtempSync(join(tmpdir(), 'sdk-atomic-')); roots.push(value); return value; }

it('identifies only final .tmp suffixes, including non-atomic writers', () => {
  for (const name of ['.state.json.abc.tmp', 'other.tmp', 'path/a.tmp']) expect(isTempFile(name)).toBe(true);
  for (const name of ['.env.template', '.cache.metadata', 'a.tmp.json', '.tmp', 'ordinary.json']) expect(isTempFile(name)).toBe(false);
});

it('publishes text by rename from an owner-only sibling .tmp file', () => {
  const dir = root(); const target = join(dir, 'state.json'); fs.writeFileSync(target, 'old');
  const rename = fs.renameSync;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    expect(String(from)).toMatch(/\/\.state\.json\..+\.tmp$/u);
    expect(fs.statSync(from).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
    expect(fs.readFileSync(from, 'utf8')).toBe('new α');
    rename(from, to);
  });
  atomicWriteText(target, 'new α');
  expect(spy).toHaveBeenCalledOnce(); expect(fs.readdirSync(dir)).toEqual(['state.json']);
  expect(fs.readFileSync(target, 'utf8')).toBe('new α');
});

it('preserves both file and FileStore cache when replacement fails and cleans its temporary file', () => {
  const dir = root(); const store = new LocalFileStore(dir); store.write('state.json', 'old');
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('replacement failed'); });
  expect(() => store.write('state.json', 'new')).toThrow('replacement failed');
  expect(store.read('state.json')).toBe('old');
  expect(fs.readFileSync(join(dir, 'state.json'), 'utf8')).toBe('old');
  expect(fs.readdirSync(dir)).toEqual(['state.json']);
});
