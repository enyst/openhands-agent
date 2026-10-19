import { mkdir, mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { Agent } from '../../agent/index.js';
import { EventLog } from '../../conversation/event-log.js';
import { LocalConversation } from '../../conversation/local-conversation.js';
import { llmProfileSchema, textContent } from '../../llm/index.js';
import type { LLMClient } from '../../llm/client.js';
import { messageEventSchema } from '../../event/index.js';
import { InMemoryFileStore, LocalFileStore, type FileStore } from '../index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function localStore(): Promise<LocalFileStore> {
  const root = await mkdtemp(join(tmpdir(), 'sdk-async-ownership-')); roots.push(root);
  return new LocalFileStore(root);
}
const constructors: Array<[string, () => Promise<FileStore>]> = [
  ['local', localStore], ['memory', async () => new InMemoryFileStore()],
];
const options = { timeoutSeconds: 1, pollIntervalMs: 1 };

describe.each(constructors)('%s async lock ownership', (_name, createStore) => {
  it('waits for an independent owner without entering either callback twice', async () => {
    const store = await createStore(); const entered = gate(); const finish = gate();
    const calls: string[] = [];
    const first = store.lockAsync('shared.lock', async () => { calls.push('first'); entered.release(); await finish.promise; return 1; }, options);
    await entered.promise;
    const second = store.lockAsync('shared.lock', () => { calls.push('second'); return 2; }, options);
    const observed = second.then(value => ({ value }), error => ({ error: String(error) }));
    await delay(5);
    expect(calls).toEqual(['first']);
    finish.release();
    expect(await first).toBe(1);
    expect(await observed).toEqual({ value: 2 });
    expect(calls).toEqual(['first', 'second']);
  });

  it('rejects true recursion after await while permitting other locks', async () => {
    const store = await createStore();
    await store.lockAsync('shared.lock', async () => {
      await Promise.resolve();
      await expect(store.lockAsync('shared.lock', () => undefined, options)).rejects.toThrow(/Deadlock detected/u);
      expect(() => store.lock('shared.lock', () => undefined)).toThrow(/Deadlock detected/u);
      await expect(store.lockAsync('other.lock', () => 'other', options)).resolves.toBe('other');
    }, options);
    await expect(store.lockAsync('shared.lock', () => 'released', options)).resolves.toBe('released');
  });

  it('times out an independent waiter without running it or releasing its owner', async () => {
    const store = await createStore(); const entered = gate(); const finish = gate(); let called = false;
    const first = store.lockAsync('shared.lock', async () => { entered.release(); await finish.promise; }, options);
    await entered.promise;
    const failure = await store.lockAsync('shared.lock', () => { called = true; }, { timeoutSeconds: 0.01, pollIntervalMs: 1 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/Deadlock detected/u);
    expect(called).toBe(false);
    expect(() => store.lock('shared.lock', () => undefined)).toThrow(/Deadlock detected/u);
    finish.release(); await first;
    await expect(store.lockAsync('shared.lock', () => 'released', options)).resolves.toBe('released');
  });

  it('releases after callback failure without replay and admits the waiting caller', async () => {
    const store = await createStore(); const entered = gate(); const finish = gate(); const failure = new Error('callback failed'); let calls = 0;
    const first = store.lockAsync('shared.lock', async () => { calls++; entered.release(); await finish.promise; throw failure; }, options).catch((error: unknown) => error);
    await entered.promise;
    const second = store.lockAsync('shared.lock', () => 'next', options).catch((error: unknown) => error);
    finish.release();
    expect(await first).toBe(failure); expect(await second).toBe('next'); expect(calls).toBe(1);
  });

  it('allows an inherited async context to acquire again after its old ownership ends', async () => {
    const store = await createStore(); const resume = gate(); let later!: Promise<string>;
    await store.lockAsync('shared.lock', () => {
      later = resume.promise.then(() => store.lockAsync('shared.lock', () => 'later', options));
    }, options);
    resume.release();
    await expect(later).resolves.toBe('later');
  });

  it('persists two independent EventLog appends across the first write/cleanup boundary', async () => {
    const store = await createStore(); const log = new EventLog(store); const written = gate();
    const originalWrite = store.write.bind(store);
    store.write = (filePath, contents) => { originalWrite(filePath, contents); if (filePath.includes('event-00000-')) written.release(); };
    const event = (id: string) => messageEventSchema.parse({ id, source: 'user', llm_message: { role: 'user', content: [{ type: 'text', text: id }] } });
    const firstEvent = event('00000000-0000-4000-8000-000000000001'); const secondEvent = event('00000000-0000-4000-8000-000000000002');
    const first = log.appendAsync(firstEvent);
    await written.promise;
    const second = log.appendAsync(secondEvent).catch((error: unknown) => error);
    await first;
    expect(await second).toBeUndefined();
    expect(log.toArray().map(item => item.id)).toEqual([firstEvent.id, secondEvent.id]);
    expect(new EventLog(store).toArray().map(item => item.id)).toEqual([firstEvent.id, secondEvent.id]);
  });
});

it('coordinates independent LocalFileStore instances through the same exclusive file', async () => {
  const firstStore = await localStore(); const secondStore = new LocalFileStore(firstStore.root);
  const entered = gate(); const finish = gate(); const calls: string[] = [];
  const first = firstStore.lockAsync('shared.lock', async () => { calls.push('first'); entered.release(); await finish.promise; }, options);
  await entered.promise;
  const second = secondStore.lockAsync('shared.lock', () => { calls.push('second'); }, options);
  await delay(5); expect(calls).toEqual(['first']); finish.release();
  await Promise.all([first, second]); expect(calls).toEqual(['first', 'second']);
});

it('does not replay a completed callback when unlink fails, and clears local ownership', async () => {
  const store = await localStore(); let calls = 0;
  const result = store.lockAsync('shared.lock', async () => {
    calls++; store.write('persisted.txt', 'once');
    await unlink(store.getFullPath('shared.lock')); await mkdir(store.getFullPath('shared.lock'));
  }, options);
  await expect(result).rejects.toMatchObject({ code: expect.stringMatching(/EISDIR|EPERM/u) });
  expect(calls).toBe(1); expect(store.read('persisted.txt')).toBe('once');
  await rm(store.getFullPath('shared.lock'), { recursive: true });
  await expect(store.lockAsync('shared.lock', () => 'next', options)).resolves.toBe('next');
});


it('persists a paid Agent response while an independent LocalConversation user append owns the log', async () => {
  const store = await localStore(); const modelEntered = gate(); const responseReady = gate();
  const appendEntered = gate(); const finishAppend = gate(); const agentWaiting = gate();
  let calls = 0; let holdNext = false; let userOwnsLock = false;
  const lockAsync = store.lockAsync.bind(store);
  store.lockAsync = async function<T>(filePath: string, callback: () => T | Promise<T>, lockOptions?: Parameters<typeof lockAsync>[2]): Promise<T> {
    if (userOwnsLock) agentWaiting.release();
    const hold = holdNext; holdNext = false;
    return lockAsync(filePath, async () => {
      const result = callback();
      if (hold) { userOwnsLock = true; appendEntered.release(); await finishAppend.promise; userOwnsLock = false; }
      return result;
    }, lockOptions);
  };
  const llm: LLMClient = {
    profile: llmProfileSchema.parse({ profileId: 'test', providerId: 'openai', model: 'test' }),
    complete: async () => {
      calls++; modelEntered.release(); await responseReady.promise;
      return { message: { role: 'assistant', content: [textContent('done')] }, usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } };
    },
  };
  const conversation = new LocalConversation({ agent: new Agent({ llm, tools: [], systemPrompt: 'test' }), fileStore: store, conversationId: 'ownership-test' });
  await conversation.sendMessageAsync('first');
  const run = conversation.run().then(() => ({ ok: true }), (error: unknown) => ({ error }));
  try {
    await modelEntered.promise;
    holdNext = true;
    const queued = conversation.sendMessageAsync('queued');
    await appendEntered.promise;
    responseReady.release();
    await agentWaiting.promise;
    finishAppend.release();
    await queued;
    expect(await run).toEqual({ ok: true });
    expect(calls).toBe(1);
    expect(conversation.state.executionStatus).toBe('finished');
    const events = conversation.state.events;
    expect(events.filter(event => event.kind === 'MessageEvent' && event.source === 'user').map(event => event.llm_message.content)).toEqual([[textContent('first')], [textContent('queued')]]);
    expect(events.filter(event => event.kind === 'MessageEvent' && event.source === 'agent')).toHaveLength(1);
    expect(events.filter(event => event.kind === 'ConversationStateUpdateEvent' && event.key === 'llm_usage')).toHaveLength(1);
    const restored = new LocalConversation({ agent: new Agent({ llm, tools: [], systemPrompt: 'test' }), fileStore: new LocalFileStore(store.root), conversationId: 'ownership-test' });
    expect(restored.state.events).toEqual(events);
    restored.close();
  } finally { finishAppend.release(); responseReady.release(); await run; conversation.close(); }
});
