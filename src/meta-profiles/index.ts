import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { LocalFileStore } from '../io/index.js';
import { LLM_PROFILE_ID_PATTERN, llmProfileSchema } from '../llm/index.js';
import { getUserPersistenceDir } from '../utils/index.js';

/** Each model reference is a saved profile name, never an unconfigured model ID. */
export const metaProfileClassSchema = z.object({
  description: z.string(),
  model: z.string(),
}).strict();

export const metaProfileSchema = z.object({
  classifier_model: z.string(),
  classes: z.array(metaProfileClassSchema).default([]),
  prompt_template: z.string().nullable().default(null),
  model_table: z.string().nullable().default(null),
}).strict().superRefine((profile, context) => {
  if (profile.prompt_template === null) return;
  if (!/\{\{\s*instance_text\s*\}\}/u.test(profile.prompt_template)) {
    context.addIssue({ code: 'custom', path: ['prompt_template'], message: 'Direct-routing meta-profiles must include {{ instance_text }} in prompt_template.' });
  }
  if (profile.classes.length > 0) {
    context.addIssue({ code: 'custom', path: ['classes'], message: 'Direct-routing meta-profiles cannot also define classes.' });
  }
});

/** Inline/cloud profiles retain the native profile and SecretStore boundary. */
export const metaProfileLlmsSchema = z.record(z.string(), llmProfileSchema);
export type MetaProfileClass = z.infer<typeof metaProfileClassSchema>;
export type MetaProfile = z.infer<typeof metaProfileSchema>;
export type MetaProfileInput = z.input<typeof metaProfileSchema>;

export interface MetaProfileSummary {
  readonly name: string;
  /** Summaries deliberately do not require the complete stored schema to validate. */
  readonly classifier_model: unknown;
  readonly num_classes: number;
}

export class MetaProfileLimitExceeded extends Error {
  constructor(maxProfiles: number) {
    super(`Meta-profile limit reached (${maxProfiles}).`);
    this.name = 'MetaProfileLimitExceeded';
  }
}

export class MetaProfileStoreTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(timeoutSeconds: number, cause: unknown) {
    super(`Meta-profile store lock acquisition timed out after ${timeoutSeconds}s`, { cause });
    this.name = 'MetaProfileStoreTimeoutError';
  }
}

export function defaultMetaProfileDir(): string {
  return path.join(getUserPersistenceDir(), 'meta-profiles');
}

/** Fresh UTF-8 reads and atomic replacement; mutation limits are checked under a process-shared lock. */
export class MetaProfileStore {
  readonly baseDir: string;
  private readonly lockStore: LocalFileStore;
  private readonly lockTimeoutSeconds: number;
  private mutationTail: Promise<unknown> = Promise.resolve();

  constructor(baseDir: string = defaultMetaProfileDir(), options: { readonly lockTimeoutSeconds?: number } = {}) {
    this.lockStore = new LocalFileStore(baseDir);
    this.baseDir = this.lockStore.root;
    this.lockTimeoutSeconds = options.lockTimeoutSeconds ?? 30;
  }

  async list(): Promise<string[]> {
    return (await readdir(this.baseDir))
      .filter(name => name.endsWith('.json') && LLM_PROFILE_ID_PATTERN.test(name.slice(0, -5)))
      .map(name => name.slice(0, -5)).sort();
  }

  async load(name: string): Promise<MetaProfile> {
    const filePath = this.filePath(name);
    let contents: string;
    try {
      // LocalFileStore.read caches values; external edits must remain authoritative here.
      contents = await readFile(filePath, 'utf8');
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      throw Object.assign(new Error(`Meta-profile '${name}' not found. Available meta-profiles: ${(await this.list()).join(', ') || 'none'}`), { code: 'ENOENT' });
    }
    try {
      return metaProfileSchema.parse(JSON.parse(contents) as unknown);
    } catch {
      // Do not include arbitrary stored JSON in an error that can become a durable tool observation.
      throw new Error(`Failed to load meta-profile '${name}': invalid JSON or meta-profile schema.`);
    }
  }

  async save(name: string, profile: unknown, options: { readonly maxProfiles?: number | null } = {}): Promise<void> {
    const filePath = this.filePath(name);
    const parsed = metaProfileSchema.parse(profile);
    const limit = options.maxProfiles;
    if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || limit < 0)) {
      throw new RangeError('maxProfiles must be a non-negative integer.');
    }
    await this.mutate(async () => {
      if (limit !== undefined && limit !== null && !await exists(filePath) && (await this.list()).length >= limit) {
        throw new MetaProfileLimitExceeded(limit);
      }
      const temporary = path.join(this.baseDir, `.meta-profile-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, filePath);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  async delete(name: string): Promise<void> {
    const filePath = this.filePath(name);
    await this.mutate(() => rm(filePath, { force: true }));
  }

  async listSummaries(): Promise<MetaProfileSummary[]> {
    const summaries: MetaProfileSummary[] = [];
    for (const name of await this.list()) {
      let data: unknown;
      try { data = JSON.parse(await readFile(this.filePath(name), 'utf8')) as unknown; }
      catch { continue; }
      if (typeof data !== 'object' || data === null || Array.isArray(data)) continue;
      const fields = data as Record<string, unknown>;
      summaries.push({ name, classifier_model: fields.classifier_model ?? null,
        num_classes: Array.isArray(fields.classes) ? fields.classes.length : 0 });
    }
    return summaries;
  }

  private filePath(name: string): string {
    const clean = name.endsWith('.json') ? name.slice(0, -5) : name;
    if (!LLM_PROFILE_ID_PATTERN.test(clean)) {
      throw new Error(`Invalid meta-profile name: '${name}'. Names must be 1-64 characters, start with a letter or digit, and contain only letters, digits, '.', '_', or '-'.`);
    }
    return path.join(this.baseDir, `${clean}.json`);
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    // FileStore rejects reentrant use on one instance. Queue same-instance calls;
    // its lock file still arbitrates independent stores/processes.
    const result = this.mutationTail.then(async () => {
      let entered = false;
      try {
        return await this.lockStore.lockAsync('.meta-profiles.lock', () => {
          entered = true;
          return operation();
        // Portable read/check/unlink cannot atomically verify lock ownership.
        // Never reap a stale lock here: another writer may already have replaced
        // it. Clear abandoned locks only after stopping all store writers.
        }, { timeoutSeconds: this.lockTimeoutSeconds, recoverStaleLocks: false });
      } catch (error) {
        if (!entered && hasCode(error, 'EEXIST')) throw new MetaProfileStoreTimeoutError(this.lockTimeoutSeconds, error);
        throw error;
      }
    });
    this.mutationTail = result.catch(() => undefined);
    return result;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function exists(filePath: string): Promise<boolean> {
  try { await stat(filePath); return true; }
  catch (error) { if (hasCode(error, 'ENOENT')) return false; throw error; }
}
