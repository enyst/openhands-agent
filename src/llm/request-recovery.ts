import { isLLMAuthenticationError, isTransientProviderError } from './exceptions.js';

export type ApiKeyRefreshHook = () => string | null | Promise<string | null>;

export interface LLMRetryOptions {
  /** Total attempts, including the first request. Default: 5 (pinned Python). */
  readonly maxAttempts?: number;
  readonly minWaitMs?: number;
  readonly maxWaitMs?: number;
  readonly multiplierMs?: number;
}

/** Runtime-only hooks: neither callbacks nor credentials belong in a profile. */
export interface LLMRequestOptions {
  readonly apiKeyRefreshHook?: ApiKeyRefreshHook;
  readonly retry?: LLMRetryOptions;
}

/** Only wrap transport + HTTP rejection, never response parsing or emitted SSE. */
export async function requestWithRecovery<T>(
  apiKey: string,
  options: LLMRequestOptions,
  request: (key: string, refreshed: boolean) => Promise<T>,
  allowAuthRefresh = true,
): Promise<T> {
  const attempts = nonnegative(options.retry?.maxAttempts, 5, true);
  const min = nonnegative(options.retry?.minWaitMs, 8_000);
  const max = nonnegative(options.retry?.maxWaitMs, 64_000);
  const multiplier = nonnegative(options.retry?.multiplierMs, 8_000);
  let key = apiKey;
  let refreshed = false;
  let attempt = 1;
  while (true) {
    try { return await request(key, refreshed); }
    catch (error) {
      if (allowAuthRefresh && !refreshed && options.apiKeyRefreshHook && isLLMAuthenticationError(error)) {
        let replacement: string | null = null;
        try { replacement = await options.apiKeyRefreshHook(); } catch { /* Keep the original authentication failure. */ }
        if (typeof replacement === 'string' && replacement.length > 0 && replacement !== key) {
          key = replacement;
          refreshed = true;
          attempt = 1;
          continue;
        }
      }
      if (attempt >= Math.max(1, attempts) || !isTransientProviderError(error)) throw error;
      const delay = Math.min(max, Math.max(min, multiplier * 2 ** (attempt - 1)));
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      attempt += 1;
    }
  }
}

function nonnegative(value: number | undefined, fallback: number, integer = false): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0 || integer && !Number.isInteger(resolved)) throw new Error('Invalid LLM retry configuration');
  return resolved;
}

/** Replace a rejected credential without mutating caller-owned header defaults. */
export function replaceCredentialHeader(headers: Readonly<Record<string, string>>, name: string, value: string): Readonly<Record<string, string>> {
  return { ...Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== name)), [name]: value };
}
