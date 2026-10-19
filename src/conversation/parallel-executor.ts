import { agentErrorEventSchema, type ActionEvent, type AgentErrorEvent, type Event } from '../event/index.js';
import { AGENT_OUTCOME } from '../event/error-classification.js';
import { LLMUsagePersistenceError } from '../llm/usage-persistence.js';
import type { CancellationToken } from './state.js';

export type ToolRunner = (action: ActionEvent) => readonly Event[] | Promise<readonly Event[]>;

export interface ParallelToolExecutorOptions {
  readonly maxConcurrency?: number;
}

export interface ExecuteBatchOptions {
  readonly cancelToken?: CancellationToken | null;
}

export class ParallelToolExecutor {
  readonly maxConcurrency: number;

  constructor(options: ParallelToolExecutorOptions = {}) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 1);
  }

  async executeBatch(
    actions: readonly ActionEvent[],
    runner: ToolRunner,
    options: ExecuteBatchOptions = {},
  ): Promise<readonly (readonly Event[])[]> {
    if (actions.length === 0) {
      return [];
    }

    const results: Event[][] = Array.from({ length: actions.length }, () => []);
    let nextIndex = 0;
    let fatal: LLMUsagePersistenceError | undefined;

    const worker = async (): Promise<void> => {
      while (nextIndex < actions.length && fatal === undefined) {
        const index = nextIndex;
        nextIndex += 1;
        const action = actions[index];
        if (action !== undefined) {
          try { results[index] = await this.runSafe(action, runner, options.cancelToken ?? null); }
          catch (error) {
            if (!(error instanceof LLMUsagePersistenceError)) throw error;
            fatal ??= error;
          }
        }
      }
    };

    // Stop taking queued actions, but let already-started side effects settle
    // before the caller can resume or replace the conversation.
    const settled = await Promise.allSettled(Array.from({ length: Math.min(this.maxConcurrency, actions.length) }, () => worker()));
    if (fatal !== undefined) throw fatal;
    const rejected = settled.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    return results;
  }

  private async runSafe(action: ActionEvent, runner: ToolRunner, cancelToken: CancellationToken | null): Promise<Event[]> {
    if (cancelToken?.isCancelled === true) {
      return [cancelledError(action)];
    }

    try {
      return [...(await runner(action))];
    } catch (error) {
      if (error instanceof LLMUsagePersistenceError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return [
        agentErrorEventSchema.parse({
          error: `Error executing tool '${action.tool_name}': ${message}`,
          tool_name: action.tool_name,
          tool_call_id: action.tool_call_id,
          classification: AGENT_OUTCOME,
        }),
      ];
    }
  }
}

function cancelledError(action: ActionEvent): AgentErrorEvent {
  return agentErrorEventSchema.parse({
    error: 'Tool call cancelled by interrupt.',
    tool_name: action.tool_name,
    tool_call_id: action.tool_call_id,
    classification: AGENT_OUTCOME,
  });
}
