import { AsyncLocalStorage } from 'node:async_hooks';

/** Immutable runtime identity owned by a conversation, never by a shared client. */
export class LLMCallContext {
  readonly sessionId: string | null;
  readonly promptCacheKey: string | null;

  constructor(options: { readonly sessionId?: string | null; readonly promptCacheKey?: string | null } = {}) {
    this.sessionId = options.sessionId ?? null;
    this.promptCacheKey = options.promptCacheKey ?? null;
    Object.freeze(this);
  }

  forConversation(id: string, options: { readonly promptCacheKey?: string | null } = {}): LLMCallContext {
    return new LLMCallContext({ sessionId: id, promptCacheKey: options.promptCacheKey || id });
  }

  static forConversation(id: string, options: { readonly promptCacheKey?: string | null } = {}): LLMCallContext {
    return new LLMCallContext().forConversation(id, options);
  }
}

const scope = new AsyncLocalStorage<LLMCallContext>();
const emptyContext = new LLMCallContext();

/** Explicit empty contexts suppress the scope; null/undefined inherit it. */
export function getLLMCallContext(explicit?: LLMCallContext | null): LLMCallContext {
  return explicit ?? scope.getStore() ?? emptyContext;
}

export function withLLMCallContext<T>(context: LLMCallContext, operation: () => T): T {
  return scope.run(context, operation);
}

/** Fresh headers, with case-insensitive replacement of stale session identity. */
export function applyLLMCallContextHeaders(headers: Readonly<Record<string, string>>, context: LLMCallContext): Readonly<Record<string, string>> {
  if (!context.sessionId) return { ...headers };
  return { ...Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'x-litellm-session-id')), 'x-litellm-session-id': context.sessionId };
}
