// Python 69eb3152: ignored events still count as stream activity; terminal output wins.
import { afterEach, expect, it, vi } from 'vitest';
import { readSubscriptionResponse } from '../auth/stream.js';
import { llmProfileSchema } from '../index.js';
import { withAttemptDeadline } from '../request-deadlines.js';
import type { FetchResponseLike } from '../client.js';

afterEach(() => vi.useRealTimers());

it('keeps an ignored-event stream alive beyond its idle limit and uses the completed wrapper', async () => {
  vi.useFakeTimers();
  const final = { id: 'final', output: [{ type: 'message', content: [{ type: 'output_text', text: 'authoritative' }] }] };
  const frames = [
    { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'partial' }] } },
    ...Array.from({ length: 6 }, () => ({ type: 'response.in_progress' })),
    { type: 'response.completed', response: final },
  ];
  let index = 0;
  const cancel = vi.fn(async () => {});
  const response: FetchResponseLike = { ok: true, status: 200, json: async () => null, text: async () => '', body: { getReader: () => ({
    cancel,
    read: () => new Promise(resolve => setTimeout(() => resolve({ done: false, value: new TextEncoder().encode(`data: ${JSON.stringify(frames[index++])}\n\n`) }), 10)),
  }) } };
  const profile = llmProfileSchema.parse({ profileId: 'stream', providerId: 'openai', model: 'gpt-6-sol', timeoutSeconds: null, streamIdleTimeoutSeconds: 0.02 });
  const pending = withAttemptDeadline(profile, deadline => readSubscriptionResponse(response, undefined, deadline));
  await vi.advanceTimersByTimeAsync(80);
  expect(await pending).toEqual(final);
  expect(index).toBe(8);
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
