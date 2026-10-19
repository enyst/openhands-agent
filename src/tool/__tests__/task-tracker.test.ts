import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskTrackerExecutor, TaskTrackerTool } from '../task-tracker.js';

describe('task tracker source persistence contract', () => {
  it('plans a full list, writes JSON, restores defaults and renders source icons', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-tracker-'));
    try {
      const tracker = new TaskTrackerExecutor({ saveDir: dir });
      await tracker.execute({ command: 'plan', task_list: [{ title: 'Build', notes: 'First' }, { title: 'Test', status: 'done' }] });
      expect(JSON.parse(await readFile(join(dir, 'TASKS.json'), 'utf8'))).toEqual([{ title: 'Build', notes: 'First', status: 'todo' }, { title: 'Test', notes: '', status: 'done' }]);
      const restored = await new TaskTrackerExecutor({ saveDir: dir }).execute({ command: 'view' });
      expect(restored.text).toBe('# Task List\n\n1. ⏳ Build\n   First\n\n2. ✅ Test');
      expect(restored.task_list).toHaveLength(2);
      await tracker.execute({ command: 'plan', task_list: [] });
      expect((await tracker.execute({ command: 'view' })).task_list).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('tolerates invalid persistence and write failures but rejects invalid actions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-tracker-'));
    try {
      await writeFile(join(dir, 'TASKS.json'), '{invalid');
      expect((await new TaskTrackerExecutor({ saveDir: dir }).execute({})).task_list).toEqual([]);
      const file = join(dir, 'file'); await writeFile(file, 'blocked');
      const tracker = new TaskTrackerExecutor({ saveDir: file });
      await expect(tracker.execute({ command: 'plan', task_list: [{ title: 'Safe' }] })).resolves.toMatchObject({ is_error: false });
      expect((await tracker.execute({})).task_list[0]?.title).toBe('Safe');
      await expect(TaskTrackerTool.create().execute({ command: 'delete' })).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
