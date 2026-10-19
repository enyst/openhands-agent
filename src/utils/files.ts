import { randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

/** Upstream's temporary-file marker, shared by writers and trajectory readers. */
export function isTempFile(path: string): boolean { return extname(path) === '.tmp'; }

/** Publish a complete UTF-8 file by replacing it with an owner-only sibling. */
export function atomicWriteText(path: string, value: string, mode = 0o600): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', mode);
    fchmodSync(descriptor, mode);
    writeFileSync(descriptor, value, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* Preserve the write error. */ } }
    try { unlinkSync(temporary); } catch { /* The temporary file may not have been created. */ }
    throw error;
  }
}
