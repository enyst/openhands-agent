/** A paid completion must not be retried merely because its usage could not be saved. */
export class LLMUsagePersistenceError extends Error {
  constructor(cause: unknown) {
    super('Unable to persist LLM usage. The conversation has stopped to avoid repeating a paid request.', { cause });
    this.name = 'LLMUsagePersistenceError';
  }
}
