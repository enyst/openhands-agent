import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolDefinition, ToolRegistry, isConversationLocalTool } from '../index.js';
import { TaskTrackerTool } from '../task-tracker.js';

describe('conversation-local tool capability', () => {
  it('marks the tracker runtime instance and builtin without exposing the flag on the wire', () => {
    const tracker = TaskTrackerTool.create();
    expect(tracker.conversationLocal).toBe(true);
    expect(isConversationLocalTool('task_tracker')).toBe(true);
    expect(isConversationLocalTool('unknown')).toBe(false);
    expect(JSON.stringify(tracker)).not.toContain('conversationLocal');
    expect(JSON.stringify(tracker.toMcpTool())).not.toMatch(/conversation.?local/iu);
  });

  it('uses actual registration metadata and never inherits a shadowed builtin capability', () => {
    const registry = new ToolRegistry();
    expect(registry.isConversationLocalTool('task_tracker')).toBe(true);
    const factory = vi.fn(() => [TaskTrackerTool.create()]);
    registry.registerFactory('task_tracker', factory);
    expect(registry.isConversationLocalTool('task_tracker')).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    registry.registerFactory('task_tracker', factory, { conversationLocal: true });
    expect(registry.isConversationLocalTool('task_tracker')).toBe(true);
    registry.sealToolCatalog();
    registry.registerFactory('task_tracker', factory, { conversationLocal: false });
    expect(registry.isConversationLocalTool('task_tracker')).toBe(false);
  });

  it('accepts the registered instance capability but defaults every ordinary tool to false', () => {
    const registry = new ToolRegistry();
    const normal = new ToolDefinition({ name: 'normal', description: '', inputSchema: z.object({}) });
    expect(normal.conversationLocal).toBe(false);
    registry.register('custom_tracker', TaskTrackerTool.create());
    registry.register('normal', normal);
    expect(registry.isConversationLocalTool('custom_tracker')).toBe(true);
    expect(registry.isConversationLocalTool('normal')).toBe(false);
  });
});

describe('source task status names', () => {
  it.each([
    ['pending', 'todo'], ['To Do', 'todo'], ['TODO', 'todo'], ['in-progress', 'in_progress'],
    ['In Progress', 'in_progress'], ['completed', 'done'], ['Complete', 'done'], [' done ', 'done'],
  ])('normalizes %s to %s', async (status, expected) => {
    const result = await TaskTrackerTool.create().execute({ command: 'plan', task_list: [{ title: 'Review', status }] });
    expect(result.task_list[0]?.status).toBe(expected);
  });
  it.each(['blocked', 'cancelled', '', 'in  progress', 1, null])('rejects unsupported status %j', async status => {
    await expect(TaskTrackerTool.create().execute({ command: 'plan', task_list: [{ title: 'Review', status }] })).rejects.toThrow();
  });
});
