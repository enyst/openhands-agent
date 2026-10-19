import { expect, it } from 'vitest';
import { HookDefinition, HookExecutor, hookEventSchema } from '../index.js';
import { LLMCallContext, withLLMCallContext } from '../../llm/call-context.js';
import { llmProfileSchema, messageSchema } from '../../llm/index.js';

// Upstream tests/sdk/hooks/test_executor.py: explicit context survives invocation outside run().
it('passes the owning context to prompt hooks while lazily resolving the current LLM', async () => {
  const own = new LLMCallContext({ sessionId: 'own', promptCacheKey: 'cache' });
  const wrong = new LLMCallContext({ sessionId: 'another' });
  const seen: unknown[] = [];
  const llm = { profile: llmProfileSchema.parse({ profileId: 'new', providerId: 'openai', model: 'gpt-6' }),
    complete: async (_messages: unknown, _tools: unknown, options: { callContext?: LLMCallContext | null } | undefined) => {
      seen.push(options?.callContext);
      return { usage: null, message: messageSchema.parse({ role: 'assistant', content: '{"decision":"allow"}' }) };
    } };
  const executor = new HookExecutor({ llmGetter: () => llm, callContext: own });
  const result = await withLLMCallContext(wrong, () => executor.execute(new HookDefinition({ type: 'prompt', prompt: 'Review' }), hookEventSchema.parse({ event_type: 'PreToolUse' })));
  expect(result.success).toBe(true);
  expect(seen).toEqual([own]);
});
