import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { MetaProfileLimitExceeded, MetaProfileStore, MetaProfileStoreTimeoutError, metaProfileSchema } from '../index.js';

// PORT: dcf401af tests/sdk/llm/test_meta_profile_store.py.
const profile = { classifier_model: 'classifier', classes: [{ description: 'tests', model: 'careful' }] };
const roots: string[] = [];
async function directory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'meta-profile-test-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('MetaProfile schemas and storage', () => {
  test('default directory honors OH_PERSISTENCE_DIR', async () => {
    const root = await directory();
    vi.stubEnv('OH_PERSISTENCE_DIR', root);
    expect(new MetaProfileStore().baseDir).toBe(path.join(root, 'meta-profiles'));
  });

  test('round trips UTF-8, accepts one .json suffix and reads external overwrites freshly', async () => {
    const root = await directory();
    const store = new MetaProfileStore(root);
    await store.save('balanced.json', { ...profile, classes: [{ description: 'Läs tester 🐾', model: 'careful' }] });
    expect((await store.load('balanced')).classes[0]?.description).toBe('Läs tester 🐾');
    await writeFile(path.join(root, 'balanced.json'), JSON.stringify({ ...profile, classifier_model: 'new-classifier' }));
    expect((await store.load('balanced')).classifier_model).toBe('new-classifier');
    expect(JSON.parse(await readFile(path.join(root, 'balanced.json'), 'utf8')).classes).toEqual(profile.classes);
  });

  test('lists sorted valid names, independently of file creation order', async () => {
    const root = await directory();
    const store = new MetaProfileStore(root);
    await store.save('z-last', profile);
    await store.save('a-first', profile);
    await writeFile(path.join(root, '.hidden.json'), '{}');
    await writeFile(path.join(root, 'invalid name.json'), '{}');
    await writeFile(path.join(root, 'staging.tmp'), '{}');
    expect(await store.list()).toEqual(['a-first', 'z-last']);
  });

  test.each(['../escape', '/absolute', '.hidden', '', 'a'.repeat(65), 'bad name'])('rejects invalid name %j', async name => {
    const store = new MetaProfileStore(await directory());
    await expect(store.save(name, profile)).rejects.toThrow(/Invalid meta-profile name/);
    await expect(store.load(name)).rejects.toThrow(/Invalid meta-profile name/);
    await expect(store.delete(name)).rejects.toThrow(/Invalid meta-profile name/);
  });

  test('missing load has ENOENT; corrupted JSON and invalid schemas remain errors', async () => {
    const root = await directory();
    const store = new MetaProfileStore(root);
    await expect(store.load('missing')).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path.join(root, 'broken.json'), '{');
    await writeFile(path.join(root, 'invalid.json'), JSON.stringify({ classes: [] }));
    await expect(store.load('broken')).rejects.toThrow(/Failed to load/);
    await expect(store.load('invalid')).rejects.toThrow(/Failed to load/);
  });

  test('direct prompts require instance_text and prohibit structured classes', async () => {
    expect(() => metaProfileSchema.parse({ ...profile, prompt_template: 'route this' })).toThrow(/instance_text/);
    expect(() => metaProfileSchema.parse({ ...profile, prompt_template: '{{ instance_text }}' })).toThrow(/classes/);
    expect(metaProfileSchema.parse({ classifier_model: 'classifier' }).classes).toEqual([]);
    const direct = { classifier_model: 'classifier', prompt_template: '{{ model_table }}\n{{instance_text}}', model_table: '- careful' };
    const store = new MetaProfileStore(await directory());
    await store.save('direct', direct);
    expect(await store.load('direct')).toEqual({ ...direct, classes: [] });
  });

  test('concurrent creators across instances respect the limit; overwrites remain allowed', async () => {
    const root = await directory();
    const stores = [new MetaProfileStore(root), new MetaProfileStore(root)];
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
      stores[index % 2]!.save(`profile-${index}`, profile, { maxProfiles: 3 })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3);
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(MetaProfileLimitExceeded);
    const names = await stores[0]!.list();
    expect(names).toHaveLength(3);
    await stores[1]!.save(names[0]!, { ...profile, classifier_model: 'updated' }, { maxProfiles: 3 });
    expect((await stores[0]!.load(names[0]!)).classifier_model).toBe('updated');
    expect((await readdir(root)).filter(name => !name.endsWith('.json'))).toEqual([]);
  });

  test('independent processes serialize create-and-count against the same limit', async () => {
    const root = await directory();
    const script = `
      import { MetaProfileStore, MetaProfileLimitExceeded } from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)};
      process.once('message', async ({ directory, name }) => {
        try {
          await new MetaProfileStore(directory).save(name, { classifier_model: 'classifier' }, { maxProfiles: 1 });
          console.log('saved');
        } catch (error) {
          if (!(error instanceof MetaProfileLimitExceeded)) throw error;
          console.log('limit');
        } finally { process.disconnect(); }
      });
      process.send('ready');
    `;
    const writers = ['one', 'two'].map(name => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let output = '';
      let errors = '';
      child.stdout!.on('data', chunk => { output += String(chunk); });
      child.stderr!.on('data', chunk => { errors += String(chunk); });
      const ready = new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('error', reject);
        child.once('exit', code => { if (code !== 0) reject(new Error(errors)); });
      });
      const done = new Promise<string>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(errors)));
      });
      return { child, ready, done, name };
    });
    try {
      await Promise.all(writers.map(writer => writer.ready));
      for (const writer of writers) writer.child.send({ directory: root, name: writer.name });
      expect((await Promise.all(writers.map(writer => writer.done))).sort()).toEqual(['limit', 'saved']);
      expect(await new MetaProfileStore(root).list()).toHaveLength(1);
    } finally {
      for (const writer of writers) if (writer.child.exitCode === null) writer.child.kill();
    }
  });

  test('delete is idempotent and releases lock after failed writes', async () => {
    const root = await directory();
    const store = new MetaProfileStore(root);
    await store.delete('missing');
    await store.save('first', profile, { maxProfiles: 1 });
    await expect(store.save('second', profile, { maxProfiles: 1 })).rejects.toBeInstanceOf(MetaProfileLimitExceeded);
    await store.delete('first');
    await store.save('second', profile, { maxProfiles: 1 });
    expect(await store.list()).toEqual(['second']);
  });

  test('failed atomic replacement cleans up temporary files and leaves the previous destination intact', async () => {
    const root = await directory();
    const store = new MetaProfileStore(root);
    await mkdir(path.join(root, 'occupied.json'));
    await expect(store.save('occupied', profile)).rejects.toThrow();
    expect(await readdir(root)).toEqual(['occupied.json']);
    await store.save('valid', profile);
    expect((await store.load('valid')).classifier_model).toBe('classifier');
  });

  test('lock timeout has an explicit typed error and does not remove another writer lock', async () => {
    const root = await directory();
    const store = new MetaProfileStore(root, { lockTimeoutSeconds: 0 });
    const lock = path.join(root, '.meta-profiles.lock');
    const contents = `${process.pid}\n${new Date().toISOString()}\n`;
    await writeFile(lock, contents);
    await expect(store.save('blocked', profile)).rejects.toBeInstanceOf(MetaProfileStoreTimeoutError);
    expect(await readFile(lock, 'utf8')).toBe(contents);
    await rm(lock);
    await store.save('ready', profile);
  });

  test.each(['999999999\n', 'malformed\n'])('never reaps an abandoned lock while concurrent stores may replace it (%j)', async contents => {
    const root = await directory();
    const lock = path.join(root, '.meta-profiles.lock');
    await writeFile(lock, contents);
    const oldTime = new Date(Date.now() - 10_000);
    await utimes(lock, oldTime, oldTime);
    const stores = [new MetaProfileStore(root, { lockTimeoutSeconds: 0.1 }), new MetaProfileStore(root, { lockTimeoutSeconds: 0.1 })];
    const attempts = await Promise.allSettled(stores.map((store, index) => store.save(`blocked-${index}`, profile, { maxProfiles: 1 })));
    expect(attempts.every(result => result.status === 'rejected' && result.reason instanceof MetaProfileStoreTimeoutError)).toBe(true);
    expect(await readFile(lock, 'utf8')).toBe(contents);
    expect(await stores[0]!.list()).toEqual([]);
    // Recovery is explicit and only safe once all writers have stopped.
    await rm(lock);
    const recovered = await Promise.allSettled(stores.map((store, index) => store.save(`ready-${index}`, profile, { maxProfiles: 1 })));
    expect(recovered.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await stores[0]!.list()).toHaveLength(1);
  });

  test('summaries skip corrupt/non-object files without requiring complete schema validation', async () => {
    const root = await directory();
    const store = new MetaProfileStore(root);
    await store.save('good', profile);
    await writeFile(path.join(root, 'broken.json'), '{');
    await writeFile(path.join(root, 'array.json'), '[]');
    await writeFile(path.join(root, 'partial.json'), '{"classes": "not-an-array"}');
    expect(await store.listSummaries()).toEqual([
      { name: 'good', classifier_model: 'classifier', num_classes: 1 },
      { name: 'partial', classifier_model: null, num_classes: 0 },
    ]);
  });
});
