import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalWorkspace, RemoteWorkspace } from '../index.js';
const env = { AUTOMATION_CALLBACK_URL: 'https://callback.test/run', AUTOMATION_CALLBACK_API_KEY: 'callback-key', AUTOMATION_RUN_ID: 'run-1', OPENHANDS_OBSERVABILITY_METADATA: '{"automation.id":"auto-1"}', OPENHANDS_OBSERVABILITY_PARENT_SPAN_CONTEXT: 'parent' };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('workspace callback and request propagation', () => {
  it.each([LocalWorkspace, RemoteWorkspace])('sends a bounded authenticated completion callback with registered identity/cost on close (%s)', async Workspace => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const ws = new Workspace({ host: 'https://agent.test', completionCallback: { env, fetch: fetcher } });
    ws.registerConversation('conversation-one'); ws.registerCost(1.25);
    await ws.close(); await ws.close();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(env.AUTOMATION_CALLBACK_URL);
    expect(JSON.parse(init.body as string)).toEqual({ status: 'COMPLETED', run_id: 'run-1', conversation_id: 'conversation-one', cost: 1.25 });
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer callback-key');
    expect(new Headers(init.headers).get('X-OpenHands-Observability-Parent-Span-Context')).toBe('parent');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it('preserves structured errors and is best effort for callback failure', async () => {
    const fetcher = vi.fn(async () => { throw new Error('network unavailable'); });
    const error = { kind: 'ConversationErrorEvent', id: 'error-one', timestamp: '2026-10-01', source: 'environment', code: 'Test', detail: 'synthetic' };
    const ws = new LocalWorkspace({ completionCallback: { env, fetch: fetcher } });
    await expect(ws.close({ conversationError: error })).resolves.toBeUndefined();
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ status: 'FAILED', error });
  });
  it('does not call a callback when no URL is configured', async () => {
    const fetcher = vi.fn(); const ws = new LocalWorkspace({ completionCallback: { env: {}, fetch: fetcher } });
    await ws.close(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('adds generic context to normal remote requests while retaining session auth', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })); vi.stubGlobal('fetch', fetcher);
    const ws = new RemoteWorkspace({ host: 'https://agent.test', apiKey: 'session-key', observability: { env, injectHeaders: headers => { headers.traceparent = 'trace'; } } });
    await ws.getServerInfo();
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('X-Session-API-Key')).toBe('session-key');
    expect(headers.get('X-OpenHands-Observability-Parent-Span-Context')).toBe('parent');
    expect(headers.get('traceparent')).toBe('trace');
  });
  it('settles at the deadline even when an injected transport ignores cancellation', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
    const ws = new LocalWorkspace({ completionCallback: { env, fetch: fetcher } });
    const pending = ws.close();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBeUndefined();
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

});
