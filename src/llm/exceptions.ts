/** Provider-agnostic LLM error classification for recovery control flow.

Background: upstream `software-agent-sdk` distinguishes content-policy blocks
from generic bad requests so the sequential/reasoning agent loop can recover
softly (emit a user nudge and continue) instead of hard-erroring. A content-policy
block is deterministic for a fixed (messages, model): a bare retry trips the same
filter, so recovery requires changing the request, not re-sending it.

In this transpilation no LiteLLM exception layer exists; provider clients own
their error mapping. This module supplies the shared classification predicate and
exception type that provider clients raise and the agent loop catches.
 */

const CONTENT_POLICY_PATTERNS: readonly string[] = [
  'content_policy',
  'content filtering policy',
  'output blocked by content filtering',
];

export class LLMBadRequestError extends Error {
  constructor(message = 'Provider rejected the LLM request') {
    super(message);
    this.name = 'LLMBadRequestError';
  }
}

/** Sanitized HTTP failure at the native provider boundary. */
export class LLMHttpError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'LLMHttpError';
  }
}

export class LLMAuthenticationError extends LLMHttpError {
  constructor(message = 'The LLM API key is invalid or lacks permission. Check the selected profile credentials.', statusCode = 401) {
    super(message, statusCode);
    this.name = 'LLMAuthenticationError';
  }
}

export class LLMRateLimitError extends LLMHttpError {
  constructor(message = 'The LLM provider rate limit was reached.', readonly quotaExhausted = false) {
    super(message, 429);
    this.name = 'LLMRateLimitError';
  }
}

export class LLMBudgetExceededError extends LLMRateLimitError {
  constructor() {
    super('The LLM budget has been exceeded. Increase the budget or wait for it to reset.', true);
    this.name = 'LLMBudgetExceededError';
  }
}

export class LLMConnectionError extends Error {
  constructor() {
    super('The LLM provider connection failed.');
    this.name = 'LLMConnectionError';
  }
}

export function isLLMAuthenticationError(error: unknown): boolean {
  return hasCause(error, value => value instanceof LLMAuthenticationError);
}

/** Only typed provider failures qualify; ordinary application errors do not. */
export function isTransientProviderError(error: unknown): boolean {
  return hasCause(error, value => value instanceof LLMConnectionError
    || value instanceof LLMHttpError && !(value instanceof LLMRateLimitError && value.quotaExhausted)
      && ([408, 409, 429].includes(value.statusCode) || value.statusCode >= 500 && value.statusCode < 600));
}

export class LLMContextWindowExceedError extends LLMBadRequestError {
  constructor(message = 'LLM context window exceeded') {
    super(message);
    this.name = 'LLMContextWindowExceedError';
  }
}

export class LLMMalformedConversationHistoryError extends LLMBadRequestError {
  constructor(message = 'Provider rejected malformed conversation history') {
    super(message);
    this.name = 'LLMMalformedConversationHistoryError';
  }
}

export class LLMContentPolicyViolationError extends LLMBadRequestError {
  constructor(message = 'Output blocked by content filtering policy') {
    super(message);
    this.name = 'LLMContentPolicyViolationError';
  }
}

/** True when the provider blocked the request/response via its content filter. */
export function isContentPolicyViolation(error: unknown): boolean {
  if (hasCause(error, value => value instanceof LLMContentPolicyViolationError)) {
    return true;
  }
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();
  const typeName = error instanceof Error ? error.name.toLowerCase() : '';
  return CONTENT_POLICY_PATTERNS.some((pattern) => normalized.includes(pattern) || typeName.includes(pattern));
}

// PORT: sdk/llm/exceptions/classifier.py. The native adapters replace LiteLLM's
// typed exception boundary: arbitrary application errors never match by text.
const LONG_PROMPT_PATTERNS = [
  'contextwindowexceedederror', 'prompt is too long',
  'input length and `max_tokens` exceed context limit',
  'please reduce the length of', 'exceeds the available context size',
  'context length exceeded', 'input exceeds the context window',
  'context window exceeds limit', 'maximum context length',
];
const MALFORMED_HISTORY_PATTERNS = [
  'tool_use ids were found without `tool_result` blocks immediately after',
  '`tool_use` ids were found without `tool_result` blocks immediately after',
  'each `tool_use` block must have a corresponding `tool_result` block in the next message',
  'each tool_use must have a single result', 'found multiple `tool_result` blocks with id:',
  'unexpected `tool_use_id` found in `tool_result` blocks',
  'each `tool_result` block must have a corresponding `tool_use` block in the previous message',
  "must be followed by tool messages responding to each 'tool_call_id'",
  'failed to parse tool call arguments as json',
];
const CONTEXT_CODES = new Set(['context_length_exceeded', 'context_window_exceeded', 'input_context_length_exceeded']);

function hasCause(error: unknown, predicate: (error: unknown) => boolean): boolean {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (predicate(error)) return true;
    error = error.cause;
  }
  return false;
}

/** Includes the typed cause retained by LLMResponseError for failed paid responses. */
export function isContextWindowExceeded(error: unknown): boolean {
  return hasCause(error, value => value instanceof LLMContextWindowExceedError);
}

export function looksLikeMalformedConversationHistoryError(error: unknown): boolean {
  return hasCause(error, value => value instanceof LLMMalformedConversationHistoryError);
}

function errorDetails(body: unknown): string[] {
  if (typeof body === 'string') {
    try { return errorDetails(JSON.parse(body) as unknown); } catch { return [body]; }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return [];
  const object = body as Record<string, unknown>;
  return ['code', 'type', 'message', 'status'].flatMap(key => typeof object[key] === 'string' ? [object[key]] : [])
    .concat(object.error === undefined ? [] : errorDetails(object.error));
}

/** Called only at a provider ingress, never over arbitrary conversation text.
 * No response body is retained in the error (subscription failures may echo input).
 */
export function providerResponseError(provider: string, status: number, body: unknown): Error {
  const message = `${provider} completion failed with HTTP ${status}`;
  const details = errorDetails(body).map(value => value.toLowerCase());
  const text = details.join(' ');
  // Explicit transport authentication is authoritative, including for the
  // opt-in refresh hook, regardless of quota words in the provider's message.
  if ([401, 403].includes(status)) return new LLMAuthenticationError(undefined, status);
  // Python infers budget denials only from rate-limit errors; generic 5xx text
  // must not acquire that type. Hard quota markers are status-independent.
  if (status === 429 && /budget_exceeded|budget has been exceeded/u.test(text)) return new LLMBudgetExceededError();
  if (/usage_limit_reached|insufficient_quota/u.test(text)) return new LLMRateLimitError(message, true);
  // Explicit transport rate limits must never start condensation.
  if (status === 429) return new LLMRateLimitError(message);
  if (CONTENT_POLICY_PATTERNS.some(pattern => text.includes(pattern)))
    return new LLMContentPolicyViolationError();
  if (/invalid api key|unauthorized|missing api key|invalid authentication|access denied|status 40[13]/u.test(text))
    return new LLMAuthenticationError();
  if (/max_(?:output_|completion_)?tokens(?: value)? (?:must be|is too (?:large|high)|cannot exceed)/u.test(text))
    return new LLMBadRequestError(message);
  if ([200, 400, 413, 422, 500, 502, 503].includes(status)) {
    if (details.some(value => CONTEXT_CODES.has(value)) || LONG_PROMPT_PATTERNS.some(pattern => text.includes(pattern))
      || /input token count[^.]*exceeds the maximum number of tokens/u.test(text))
      return new LLMContextWindowExceedError(message);
    if (MALFORMED_HISTORY_PATTERNS.some(pattern => text.includes(pattern)))
      return new LLMMalformedConversationHistoryError(message);
  }
  if ([408, 409].includes(status) || status >= 500 && status < 600) return new LLMHttpError(message, status);
  return status >= 400 && status < 500 ? new LLMBadRequestError(message) : new Error(message);
}

/** Support typed transport wrappers used by advanced/injected provider clients. */
export function mapProviderException(error: unknown): unknown {
  if (error instanceof Error && ['AuthenticationError', 'PermissionDeniedError'].includes(error.name)) return new LLMAuthenticationError(undefined, error.name === 'PermissionDeniedError' ? 403 : 401);
  if (error instanceof Error && error.name === 'BudgetExceededError') return new LLMBudgetExceededError();
  if (error instanceof Error && error.name === 'RateLimitError') return providerResponseError('LLM provider', 429, error.message);
  if (error instanceof Error && ['APIError', 'OpenAIError'].includes(error.name)) {
    const status = 'status_code' in error ? error.status_code : 'status' in error ? error.status : undefined;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600) return providerResponseError('LLM provider', status, error.message);
  }
  if (error instanceof Error && ['BadRequestError', 'OpenAIError', 'APIConnectionError', 'InternalServerError', 'ContextWindowExceededError'].includes(error.name)) {
    if (error.name === 'ContextWindowExceededError') return new LLMContextWindowExceedError();
    const mapped = providerResponseError('LLM provider', error.name === 'BadRequestError' ? 400 : 500, error.message);
    return error.name === 'APIConnectionError' && mapped instanceof LLMHttpError
      && !(mapped instanceof LLMRateLimitError || mapped instanceof LLMAuthenticationError) ? new LLMConnectionError() : mapped;
  }
  // These names originate at fetch, before any response is emitted or parsed.
  if (error instanceof Error && (['TimeoutError', 'APITimeoutError'].includes(error.name) || error instanceof TypeError && /fetch failed|network|failed to fetch|load failed/iu.test(error.message))) return new LLMConnectionError();
  return error;
}
