import { conversationErrorEventSchema } from '../event/index.js';
import { observabilityHeadersFromEnv, type EnvLike, type HeaderInjector } from '../observability/index.js';

export interface WorkspaceCompletionRegistration {
  registerConversation(conversationId: string): void;
  registerCost(cost: number | null): void;
}
export interface CompletionCallbackRuntime {
  readonly env?: EnvLike;
  readonly fetch?: typeof globalThis.fetch;
  readonly injectHeaders?: HeaderInjector;
}

/** Runtime-only completion callback state; no credentials are persisted or logged. */
export class WorkspaceCompletion implements WorkspaceCompletionRegistration {
  private conversationId: string | null = null;
  private cost: number | null = null;
  private closing: Promise<void> | null = null;
  constructor(private readonly runtime: CompletionCallbackRuntime = {}) {}
  registerConversation(conversationId: string): void { this.conversationId = conversationId; }
  registerCost(cost: number | null): void { this.cost = cost; }
  get accumulatedCost(): number | null { return this.cost; }

  close(error?: unknown): Promise<void> {
    this.closing ??= this.send(error);
    return this.closing;
  }

  private async send(error?: unknown): Promise<void> {
    const env = this.runtime.env ?? process.env;
    const url = env.AUTOMATION_CALLBACK_URL;
    if (!url) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const payload: Record<string, unknown> = { status: (error === undefined || error === null) ? 'COMPLETED' : 'FAILED' };
      if (env.AUTOMATION_RUN_ID) payload.run_id = env.AUTOMATION_RUN_ID;
      if (this.conversationId !== null) payload.conversation_id = this.conversationId;
      if (this.cost !== null) payload.cost = this.cost;
      if (error !== undefined && error !== null) {
        const record = typeof error === 'object' ? error as Record<string, unknown> : {};
        const structured = conversationErrorEventSchema.safeParse(record.conversationError ?? record.conversation_error);
        payload.error = structured.success ? structured.data : conversationErrorEventSchema.parse({ source: 'environment',
          code: error instanceof Error ? error.name : 'Error', detail: error instanceof Error ? error.message : typeof error === 'string' ? error : 'Workspace operation failed' });
      }
      const headers = observabilityHeadersFromEnv(env, this.runtime.injectHeaders);
      headers['Content-Type'] = 'application/json';
      if (env.AUTOMATION_CALLBACK_API_KEY) headers.Authorization = `Bearer ${env.AUTOMATION_CALLBACK_API_KEY}`;
      const controller = new AbortController();
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Completion callback timed out')); }, 10_000);
      });
      const response = await Promise.race([(this.runtime.fetch ?? globalThis.fetch)(url, {
        method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal, redirect: 'error',
      }), expired]);
      void response.body?.cancel().catch(() => undefined);
    } catch { /* Callback failure cannot mask the completed operation or its error. */ }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
