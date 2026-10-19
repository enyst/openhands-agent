export type EnvLike = Readonly<Record<string, string | undefined>>;
export type TraceMetadataValue = string | boolean | number | readonly string[] | readonly boolean[] | readonly number[];
export type HeaderInjector = (headers: Record<string, string>) => void;
export type SpanType = 'DEFAULT' | 'LLM' | 'TOOL';

export interface ObserveOptions {
  readonly name?: string | null;
  readonly sessionId?: string | null;
  readonly userId?: string | null;
  readonly ignoreInput?: boolean;
  readonly ignoreOutput?: boolean;
  readonly spanType?: SpanType;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
  readonly tags?: readonly string[] | null;
  readonly env?: EnvLike;
  readonly adapter?: ObserveAdapter;
}

export interface ObserveAdapter {
  observe<Args extends unknown[], Result>(options: ObserveOptions, fn: (...args: Args) => Result): (...args: Args) => Result;
}

export interface LaminarInitOptions {
  readonly env?: EnvLike;
  readonly initializer?: () => void;
  readonly isInitialized?: () => boolean;
}

export interface RootSpanOptions {
  readonly sessionId?: string | null;
  readonly userId?: string | null;
  readonly attributes?: Readonly<Record<string, TraceMetadataValue>> | null;
  readonly parentSpanContext?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
  readonly tags?: readonly string[] | null;
  readonly env?: EnvLike;
  readonly spanFactory?: (name: string, options: RootSpanOptions) => RootSpanHandle;
}

export interface RootSpanHandle {
  readonly setAttribute?: (key: string, value: TraceMetadataValue) => void;
  readonly beginChild?: (name: string, tags?: readonly string[] | null) => void;
  readonly end?: () => void;
}

export class RootSpan {
  readonly handle: RootSpanHandle;
  private ended = false;

  constructor(handle: RootSpanHandle) {
    this.handle = handle;
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    try { this.handle.end?.(); } catch { /* Observability is best effort. */ }
  }
}

export const observabilityEnvKeys = [
  'LMNR_PROJECT_API_KEY',
  'OTEL_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
] as const;

let processObservabilityEnabled = false;

export function getEnv(key: string, env: EnvLike = process.env): string | undefined {
  return env[key];
}

export function shouldEnableObservability(env: EnvLike = process.env): boolean {
  if (env === process.env && processObservabilityEnabled) {
    return true;
  }
  const enabled = observabilityEnvKeys.some((key) => Boolean(getEnv(key, env)));
  if (enabled && env === process.env) {
    processObservabilityEnabled = true;
  }
  return enabled;
}

export function maybeInitLaminar(options: LaminarInitOptions = {}): boolean {
  if (!shouldEnableObservability(options.env ?? process.env)) {
    return false;
  }
  // Skip the initializer when the backend already reports as initialized; a
  // second initialize can misconfigure or reset an active tracer.
  if (options.isInitialized?.() === true) {
    return true;
  }
  options.initializer?.();
  return true;
}

export function observe(options: ObserveOptions = {}): <Args extends unknown[], Result>(fn: (...args: Args) => Result) => (...args: Args) => Result {
  return <Args extends unknown[], Result>(fn: (...args: Args) => Result): ((...args: Args) => Result) => {
    if (!shouldEnableObservability(options.env ?? process.env) || options.adapter === undefined) {
      return fn;
    }
    return options.adapter.observe(options, fn);
  };
}

export function startRootSpan(name: string, options: RootSpanOptions = {}): RootSpan | null {
  if (!shouldEnableObservability(options.env ?? process.env) || options.spanFactory === undefined) {
    return null;
  }
  let span: RootSpanHandle | undefined;
  try {
    span = options.spanFactory(name, options);
    if (options.attributes !== undefined && options.attributes !== null) {
      for (const [key, value] of Object.entries(options.attributes)) {
        span.setAttribute?.(key, value);
      }
    }
    return new RootSpan(span);
  } catch {
    try { span?.end?.(); } catch { /* Failed initialization must not leak a root. */ }
    return null;
  }
}

export function endRootSpan(root: RootSpan | null | undefined): void {
  root?.end();
}

export function startChildSpan(root: RootSpan | null | undefined, name: string, tags?: readonly string[] | null): void {
  if (root === null || root === undefined) {
    return;
  }
  try {
    root.handle.beginChild?.(name, tags);
  } catch {
    // Child spans are best-effort observability signals; never let a broken
    // backend abort conversation execution.
  }
}

export function extractActionName(actionEvent: unknown): string {
  try {
    if (!isRecord(actionEvent)) {
      return 'agent.execute_action';
    }
    const action = actionEvent.action;
    if (isRecord(action) && typeof action.kind === 'string') {
      return action.kind;
    }
    if (typeof actionEvent.tool_name === 'string') {
      return actionEvent.tool_name;
    }
    if (typeof actionEvent.toolName === 'string') {
      return actionEvent.toolName;
    }
  } catch {
    return 'agent.execute_action';
  }
  return 'agent.execute_action';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ObservabilityRuntime {
  readonly env?: EnvLike;
  readonly spanFactory?: RootSpanOptions['spanFactory'];
  /** Optional host OpenTelemetry propagation adapter; no exporter is installed by the SDK. */
  readonly injectHeaders?: HeaderInjector;
}

export interface ConversationObservabilityOptions {
  readonly userId?: string | null;
  readonly observabilityMetadata?: Readonly<Record<string, unknown>> | null;
  readonly observabilityTags?: readonly string[] | null;
  readonly observabilitySpanName?: string | null;
  readonly observabilityParentSpanContext?: string | null;
  readonly tags?: Readonly<Record<string, string>> | null;
  readonly observability?: ObservabilityRuntime | undefined;
}

function isTraceMetadataValue(value: unknown): value is TraceMetadataValue {
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return true;
  return Array.isArray(value) && (value.every(item => typeof item === 'string')
    || value.every(item => typeof item === 'boolean')
    || value.every(item => typeof item === 'number' && Number.isFinite(item)));
}

export function cleanTraceMetadata(value: unknown): Record<string, TraceMetadataValue> {
  return isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, TraceMetadataValue] => entry[0].length > 0 && isTraceMetadataValue(entry[1]))) : {};
}

export function observabilityMetadataFromEnv(env: EnvLike = process.env): Record<string, TraceMetadataValue> {
  try { return cleanTraceMetadata(JSON.parse(getEnv('OPENHANDS_OBSERVABILITY_METADATA', env) || '{}')); }
  catch { return {}; }
}

export function mergeObservabilityMetadata(metadata?: Readonly<Record<string, unknown>> | null, env: EnvLike = process.env): Record<string, unknown> {
  return { ...observabilityMetadataFromEnv(env), ...metadata };
}

export function observabilityTagsFromEnv(env: EnvLike = process.env): string[] {
  return (getEnv('OPENHANDS_OBSERVABILITY_TAGS', env) ?? '').split(',').map(tag => tag.trim()).filter(Boolean);
}

export function defaultObservabilitySpanNameFromEnv(env: EnvLike = process.env): string | undefined {
  return getEnv('OPENHANDS_OBSERVABILITY_SPAN_NAME', env) || undefined;
}

export function observabilityParentSpanContextFromEnv(env: EnvLike = process.env): string | undefined {
  return getEnv('OPENHANDS_OBSERVABILITY_PARENT_SPAN_CONTEXT', env) || getEnv('LMNR_SPAN_CONTEXT', env) || undefined;
}

export function observabilityHeadersFromEnv(env: EnvLike = process.env, inject?: HeaderInjector): Record<string, string> {
  return observabilityHeaders({ metadata: observabilityMetadataFromEnv(env), tags: observabilityTagsFromEnv(env),
    spanName: defaultObservabilitySpanNameFromEnv(env) ?? null, parentSpanContext: observabilityParentSpanContextFromEnv(env) ?? null }, inject);
}

export function observabilityHeaders(context: { readonly metadata?: Readonly<Record<string, unknown>> | null; readonly tags?: readonly string[] | null;
  readonly spanName?: string | null; readonly parentSpanContext?: string | null }, inject?: HeaderInjector): Record<string, string> {
  const headers: Record<string, string> = {};
  if (context.metadata && Object.keys(context.metadata).length > 0) headers['X-OpenHands-Observability-Metadata'] = JSON.stringify(context.metadata);
  if (context.tags?.length) headers['X-OpenHands-Observability-Tags'] = context.tags.join(',');
  if (context.spanName) headers['X-OpenHands-Observability-Span-Name'] = context.spanName;
  if (context.parentSpanContext) headers['X-OpenHands-Observability-Parent-Span-Context'] = context.parentSpanContext;
  try { inject?.(headers); } catch { /* A broken tracing adapter must not block API calls. */ }
  return headers;
}

export function resolveConversationObservability(options: ConversationObservabilityOptions): ConversationObservabilityOptions {
  const env = options.observability?.env ?? process.env;
  const metadata = mergeObservabilityMetadata(options.observabilityMetadata, env);
  const name = options.observabilitySpanName && options.observabilitySpanName !== 'conversation'
    ? options.observabilitySpanName : defaultObservabilitySpanNameFromEnv(env);
  const parent = options.observabilityParentSpanContext || observabilityParentSpanContextFromEnv(env);
  return { ...options,
    ...(Object.keys(metadata).length > 0 || (options.observabilityMetadata !== undefined && options.observabilityMetadata !== null) ? { observabilityMetadata: metadata } : {}),
    ...(name ? { observabilitySpanName: name } : {}),
    ...(parent ? { observabilityParentSpanContext: parent } : {}),
  };
}

export function startConversationSpan(sessionId: string, options: ConversationObservabilityOptions): RootSpan | null {
  const resolved = resolveConversationObservability(options);
  const metadata = resolved.observabilityMetadata ?? {};
  const attributes = { ...cleanTraceMetadata(metadata), ...Object.fromEntries(Object.entries(resolved.tags ?? {}).map(([key, value]) => [`conversation.tags.${key}`, value])) };
  const root = startRootSpan('conversation', { sessionId, userId: resolved.userId ?? null, metadata, attributes,
    tags: resolved.observabilityTags ?? null, parentSpanContext: resolved.observabilityParentSpanContext ?? null,
    env: resolved.observability?.env ?? process.env, ...(resolved.observability?.spanFactory ? { spanFactory: resolved.observability.spanFactory } : {}) });
  if (resolved.observabilitySpanName && resolved.observabilitySpanName !== 'conversation') startChildSpan(root, resolved.observabilitySpanName, resolved.observabilityTags);
  return root;
}
