import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteWorkspace } from '../index.js';

afterEach(() => vi.unstubAllGlobals());
describe('RemoteWorkspace.stopCommand (upstream #5348)', () => {
  it.each([null, '00000000-0000-0000-0000-000000000001'])('posts one authenticated command stop in scope %s', async runtimeConversationId => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    const workspace = new RemoteWorkspace({ host: 'https://agent.test', apiKey: 'session-key', runtimeConversationId });
    await workspace.stopCommand('command/one');
    const prefix = runtimeConversationId === null ? '/api' : `/api/conversations/${runtimeConversationId}`;
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://agent.test${prefix}/bash/bash_commands/command%2Fone/stop`);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('X-Session-API-Key')).toBe('session-key');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([200, 404])('treats finished or unknown commands as a no-op (%s)', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
    await expect(new RemoteWorkspace({ host: 'https://agent.test' }).stopCommand('unknown')).resolves.toBeUndefined();
  });
  it('propagates non404 errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    await expect(new RemoteWorkspace({ host: 'https://agent.test' }).stopCommand('denied')).rejects.toThrow(/403/u);
  });
});
