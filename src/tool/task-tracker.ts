import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { registerBuiltinResolver, ToolDefinition, toolAnnotationsSchema } from './index.js';
import { NATIVE_TOOL_MODULE_QUALNAMES } from './module-qualnames.js';
import { TASK_TRACKER_DESCRIPTION } from './task-tracker-description.js';

export const taskItemSchema = z.object({ title: z.string(), notes: z.string().default(''), status: z.enum(['todo', 'in_progress', 'done']).default('todo') });
export const taskTrackerActionSchema = z.object({ command: z.enum(['view', 'plan']).default('view'), task_list: z.array(taskItemSchema).default([]) }).strict();
export const taskTrackerObservationSchema = z.object({ text: z.string(), is_error: z.boolean().default(false), command: z.enum(['view', 'plan']), task_list: z.array(taskItemSchema).default([]) }).strict();
export type TaskItem = z.infer<typeof taskItemSchema>;
export type TaskTrackerAction = z.input<typeof taskTrackerActionSchema>;
export type TaskTrackerObservation = z.infer<typeof taskTrackerObservationSchema>;

export class TaskTrackerExecutor {
  private taskList: TaskItem[] = [];
  private readonly saveDir: string | null;
  private ready: Promise<void>;
  constructor(options: { readonly saveDir?: string | null } = {}) {
    this.saveDir = options.saveDir ?? null;
    this.ready = this.loadTasks();
  }
  execute(action: TaskTrackerAction): Promise<TaskTrackerObservation> {
    const parsed = taskTrackerActionSchema.parse(action);
    const result = this.ready.then(async () => {
      if (parsed.command === 'plan') {
        this.taskList = parsed.task_list;
        await this.saveTasks();
      }
      return { text: parsed.command === 'plan' ? `Task list has been updated with ${this.taskList.length} item(s).`
        : this.taskList.length === 0 ? 'No task list found. Use the "plan" command to create one.' : formatTasks(this.taskList),
      is_error: false, command: parsed.command, task_list: this.taskList.map(task => ({ ...task })) };
    });
    this.ready = result.then(() => undefined, () => undefined);
    return result;
  }
  private async loadTasks(): Promise<void> {
    if (this.saveDir === null) return;
    try { this.taskList = z.array(taskItemSchema).parse(JSON.parse(await readFile(join(this.saveDir, 'TASKS.json'), 'utf8'))); }
    catch { this.taskList = []; }
  }
  private async saveTasks(): Promise<void> {
    if (this.saveDir === null) return;
    try {
      await mkdir(this.saveDir, { recursive: true });
      await writeFile(join(this.saveDir, 'TASKS.json'), JSON.stringify(this.taskList, null, 2), 'utf8');
    } catch { /* Like upstream, persistence failure does not discard the in-memory plan. */ }
  }
}
export class TaskTrackerTool {
  static create(options: { readonly saveDir?: string | null } = {}): ToolDefinition<typeof taskTrackerActionSchema, typeof taskTrackerObservationSchema> {
    const executor = new TaskTrackerExecutor(options);
    return new ToolDefinition({ name: 'task_tracker', description: TASK_TRACKER_DESCRIPTION,
      inputSchema: taskTrackerActionSchema, outputSchema: taskTrackerObservationSchema,
      annotations: toolAnnotationsSchema.parse({ title: 'task_tracker', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
      executor: action => executor.execute(action) });
  }
}
function formatTasks(tasks: readonly TaskItem[]): string {
  return ('# Task List\n\n' + tasks.map((task, index) => `${index + 1}. ${{ todo: '⏳', in_progress: '🔄', done: '✅' }[task.status]} ${task.title}\n${task.notes ? `   ${task.notes}\n` : ''}\n`).join('')).trim();
}
registerBuiltinResolver('task_tracker', (params, context) => {
  if (Object.keys(params).length > 0) throw new Error('TaskTrackerTool does not accept parameters.');
  const persistenceDir = typeof context === 'object' && context !== null && 'persistenceDir' in context && typeof context.persistenceDir === 'string' ? context.persistenceDir : null;
  return [TaskTrackerTool.create({ saveDir: persistenceDir })];
}, { canonicalName: 'task_tracker', catalogDescription: 'Keep a running task list to organise multi-step work.', moduleQualname: NATIVE_TOOL_MODULE_QUALNAMES.task_tracker });
