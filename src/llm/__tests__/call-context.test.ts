// PORT: bd33d63 frozen context and explicit/scoped/empty precedence.
import { describe, expect, it } from 'vitest';
import { LLMCallContext, getLLMCallContext, withLLMCallContext } from '../call-context.js';

describe('conversation-owned LLM call context', () => {
  it('is immutable and derives a fresh child identity unless cache sharing is explicit', () => {
    const parent = new LLMCallContext({ sessionId: 'parent', promptCacheKey: 'parent-cache' });
    expect(Object.isFrozen(parent)).toBe(true);
    expect(parent.forConversation('child')).toEqual({ sessionId: 'child', promptCacheKey: 'child' });
    expect(parent.forConversation('child', { promptCacheKey: parent.promptCacheKey })).toEqual({ sessionId: 'child', promptCacheKey: 'parent-cache' });
    expect(parent.sessionId).toBe('parent');
  });

  it('restores nested scopes on rejection and explicit empty context suppresses ambient identity', async () => {
    const outer = new LLMCallContext({ sessionId: 'outer' });
    const inner = new LLMCallContext({ sessionId: 'inner' });
    const empty = new LLMCallContext();
    await withLLMCallContext(outer, async () => {
      expect(getLLMCallContext(null)).toBe(outer);
      expect(getLLMCallContext(empty)).toBe(empty);
      await expect(withLLMCallContext(inner, async () => { await Promise.resolve(); expect(getLLMCallContext()).toBe(inner); throw new Error('expected'); })).rejects.toThrow('expected');
      expect(getLLMCallContext()).toBe(outer);
    });
    expect(getLLMCallContext()).toEqual(empty);
    expect(Object.isFrozen(getLLMCallContext())).toBe(true);
  });

  it('isolates overlapping async scopes with a deterministic barrier', async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const one = new LLMCallContext({ sessionId: 'one' });
    const two = new LLMCallContext({ sessionId: 'two' });
    const pending = withLLMCallContext(one, async () => { await barrier; expect(getLLMCallContext()).toBe(one); });
    await withLLMCallContext(two, async () => { expect(getLLMCallContext()).toBe(two); release(); await pending; expect(getLLMCallContext()).toBe(two); });
    expect(getLLMCallContext().sessionId).toBeNull();
  });
});
