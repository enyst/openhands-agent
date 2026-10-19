import { LLMTimeoutError } from './exceptions.js';
import type { LLMProfile } from './index.js';

/** Internal marker: a received body/stream failure must not trigger a paid replay. */
export class ResponseReadFailure extends Error {
  constructor(readonly original: unknown) { super('LLM response read failed'); }
}

export interface AttemptDeadline {
  readonly signal: AbortSignal;
  /** Body collection is bounded, but only this attempt's own timeout is retryable. */
  collect<T>(read: () => Promise<T>): Promise<T>;
  /** Each next chunk gets a fresh idle budget; the hard budget remains shared. */
  next<T>(read: () => Promise<T>): Promise<T>;
}

/** Timers cover one attempt, including body reads, never retry backoff. */
export async function withAttemptDeadline<T>(profile: LLMProfile, work: (deadline: AttemptDeadline) => Promise<T>): Promise<T> {
  const hard = profile.timeoutSeconds;
  const idle = profile.streamIdleTimeoutSeconds === undefined ? hard : profile.streamIdleTimeoutSeconds;
  const controller = new AbortController();
  let timeout: LLMTimeoutError | undefined;
  let rejectExpired!: (error: LLMTimeoutError) => void;
  const expired = new Promise<never>((_resolve, reject) => { rejectExpired = reject; });
  const expire = (kind: 'hard' | 'idle') => {
    if (timeout) return;
    timeout = new LLMTimeoutError(kind);
    // Select our error before abort causes fetch/read to reject with AbortError.
    rejectExpired(timeout);
    controller.abort(timeout);
  };
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline: AttemptDeadline = {
    signal: controller.signal,
    async collect(read) {
      try { return await Promise.race([Promise.resolve().then(read), expired]); }
      catch (error) { if (timeout) throw timeout; throw new ResponseReadFailure(error); }
    },
    async next(read) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (idle === 0) expire('idle');
        else if (idle !== null) idleTimer = setTimeout(() => expire('idle'), idle * 1000);
        return await Promise.race([Promise.resolve().then(read), expired]);
      } finally { if (idleTimer !== undefined) clearTimeout(idleTimer); }
    },
  };
  try {
    if (hard === 0) expire('hard');
    else if (hard !== null) hardTimer = setTimeout(() => expire('hard'), hard * 1000);
    return await Promise.race([Promise.resolve().then(() => { if (timeout) throw timeout; return work(deadline); }), expired]);
  } finally { if (hardTimer !== undefined) clearTimeout(hardTimer); }
}
