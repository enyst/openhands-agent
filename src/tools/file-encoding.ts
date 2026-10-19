import { createHash, randomUUID } from 'node:crypto';
import { chmod, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { analyse } from 'chardet';

/** Detector confidence is a fraction in [0, 1], matching the upstream boundary. */
export interface FileEncodingGuess {
  readonly encoding: string | null;
  readonly confidence: number | null;
}
export type FileEncodingDetector = (sample: Uint8Array) => FileEncodingGuess | null | Promise<FileEncodingGuess | null>;
export type FileTextEncoding = 'utf-8' | 'utf-8-sig' | 'cp1252' | 'latin-1' | 'cp1251';
export interface EncodedTextFile {
  readonly text: string;
  readonly bytes: Buffer;
  readonly encoding: FileTextEncoding;
}

const TEXT_DECODE_CANDIDATES: readonly FileTextEncoding[] = ['utf-8', 'cp1252', 'latin-1', 'cp1251'];
const TEXT_DECODE_ALIASES: Readonly<Record<string, FileTextEncoding>> = {
  'windows-1251': 'cp1251',
  'windows-1252': 'cp1252',
  'iso-8859-1': 'latin-1',
  'iso-8859-15': 'latin-1',
};
// Python's recovery permits tab, LF, vertical tab, form feed, and CR, but not
// these C0 controls or DEL. C1 code points are intentionally not excluded.
// eslint-disable-next-line no-control-regex
const BINARY_CONTROL_CHARS = /[\x00-\x08\x0e-\x1f\x7f]/u;
const MAX_SAMPLE_BYTES = 1024 * 1024;
const MAX_CACHE_ENTRIES = 1000;

/** Native detector adapter; its heuristics are not charset_normalizer's. */
export const detectFileEncoding: FileEncodingDetector = (sample) => {
  const best = analyse(sample)[0];
  return best ? { encoding: best.name, confidence: best.confidence / 100 } : null;
};

function normalizeName(encoding: string): string { return encoding.toLowerCase().replaceAll('_', '-'); }
function recoveryGuess(encoding: string | null | undefined): FileTextEncoding | null {
  if (!encoding) return null;
  const normalized = normalizeName(encoding);
  return TEXT_DECODE_ALIASES[normalized] ?? (TEXT_DECODE_CANDIDATES.includes(normalized as FileTextEncoding) ? normalized as FileTextEncoding : null);
}

function primaryEncoding(encoding: string): FileTextEncoding {
  const normalized = normalizeName(encoding);
  if (normalized === 'ascii' || normalized === 'utf8') return 'utf-8';
  // The ISO-8859-15 => Latin-1 substitution is only an upstream *recovery*
  // alias. A confident ISO-8859-15 result must not reinterpret its euro sign.
  const supported = normalized === 'iso-8859-15' ? null : recoveryGuess(normalized);
  if (!supported) throw new Error(`Unsupported detected text encoding: ${encoding}`);
  return supported;
}

function recognizedUnsupportedEncoding(encoding: string | null | undefined): boolean {
  if (!encoding || recoveryGuess(encoding)) return false;
  const normalized = normalizeName(encoding);
  if (normalized === 'ascii' || normalized === 'utf8') return false;
  // Native decoding support identifies a real codec, but is not enough to
  // promise a byte-preserving encoder. Do not turn that known gap into a
  // successful CP1252 read. Unknown exotic guesses keep source recovery rules.
  try { new TextDecoder(encoding); return true; }
  catch { return false; }
}

function invalidByte(encoding: FileTextEncoding, byte: number): boolean {
  return encoding === 'cp1251' ? byte === 0x98 : encoding === 'cp1252' && [0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(byte);
}

function decode(bytes: Uint8Array, encoding: FileTextEncoding): string {
  // WHATWG latin1 is an alias of Windows-1252, unlike Python's Latin-1.
  if (encoding === 'latin-1') return Buffer.from(bytes).toString('latin1');
  if (encoding !== 'utf-8' && encoding !== 'utf-8-sig') {
    for (const byte of bytes) if (invalidByte(encoding, byte)) throw new Error(`Invalid byte for ${encoding}`);
  }
  // UTF-8-sig strips the marker on reads and reinstates it on writes.
  return new TextDecoder(encoding.startsWith('utf-8') ? 'utf-8' : encoding === 'cp1251' ? 'windows-1251' : 'windows-1252', { fatal: true, ignoreBOM: encoding !== 'utf-8-sig' }).decode(bytes);
}

const encodingTables = new Map<FileTextEncoding, ReadonlyMap<string, number>>();
function encodingTable(encoding: Exclude<FileTextEncoding, 'utf-8' | 'utf-8-sig'>): ReadonlyMap<string, number> {
  const cached = encodingTables.get(encoding);
  if (cached) return cached;
  const table = new Map<string, number>();
  for (let byte = 0; byte <= 255; byte++) {
    if (!invalidByte(encoding, byte)) table.set(decode(Uint8Array.of(byte), encoding), byte);
  }
  encodingTables.set(encoding, table);
  return table;
}

function encode(text: string, encoding: FileTextEncoding): Buffer | null {
  if (encoding === 'utf-8') return Buffer.from(text, 'utf8');
  if (encoding === 'utf-8-sig') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  const table = encodingTable(encoding);
  const bytes: number[] = [];
  for (const character of text) {
    const byte = table.get(character);
    if (byte === undefined) return null;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

function fingerprint(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function assertWellFormed(text: string): void {
  // Node replaces lone UTF-16 surrogates when encoding UTF-8; Python rejects them.
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(text)) throw new Error('Text contains an unpaired Unicode surrogate');
}
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }

/** Strict whole-file recovery and bounded detection cache for the file editor. */
export class FileEncodingManager {
  private readonly cache = new Map<string, { readonly fingerprint: string; readonly encoding: FileTextEncoding }>();
  constructor(private readonly detector: FileEncodingDetector = detectFileEncoding) {}

  async read(path: string): Promise<EncodedTextFile> {
    const key = resolve(path);
    const bytes = await readFile(key);
    const digest = fingerprint(bytes);
    const cached = this.cache.get(key);
    let encoding: FileTextEncoding;
    if (cached?.fingerprint === digest) {
      encoding = cached.encoding;
    } else {
      const sample = bytes.subarray(0, MAX_SAMPLE_BYTES);
      let guess: FileEncodingGuess | null = null;
      if (sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) encoding = 'utf-8-sig';
      else {
        try { decode(sample, 'utf-8'); encoding = 'utf-8'; }
        catch {
          guess = await this.detector(sample);
          encoding = guess?.encoding && (guess.confidence ?? 0) > 0.9 ? primaryEncoding(guess.encoding) : 'utf-8';
        }
      }
      if (encoding === 'utf-8') {
        let cleanUtf8 = false;
        try { cleanUtf8 = !BINARY_CONTROL_CHARS.test(decode(bytes, 'utf-8')); }
        catch { /* Recovery below considers the whole file. */ }
        if (!cleanUtf8 && guess === null) guess = await this.detector(sample);
        if (recognizedUnsupportedEncoding(guess?.encoding)) {
          try { decode(bytes, 'utf-8'); }
          catch { throw new Error(`Unsupported detected text encoding: ${guess!.encoding}`); }
        }
        const candidates = new Set(['utf-8' as const, recoveryGuess(guess?.encoding), ...TEXT_DECODE_CANDIDATES]);
        for (const candidate of candidates) {
          if (candidate === null) continue;
          try {
            if (!BINARY_CONTROL_CHARS.test(decode(bytes, candidate))) {
              encoding = candidate;
              break;
            }
          } catch { /* A strict decode failed; try the next upstream candidate. */ }
        }
      }
    }
    let text: string;
    try { text = decode(bytes, encoding); }
    catch { throw new Error(`File is binary or cannot be decoded as clean text: ${path}`); }
    if (BINARY_CONTROL_CHARS.test(text)) throw new Error(`File contains binary control characters: ${path}`);
    this.remember(key, bytes, encoding, digest);
    return { bytes, encoding, text };
  }

  async create(path: string, text: string): Promise<void> {
    assertWellFormed(text);
    const bytes = Buffer.from(text, 'utf8');
    await writeFile(path, bytes, { flag: 'wx' });
    this.remember(resolve(path), bytes, 'utf-8');
  }

  async write(path: string, text: string, previous: EncodedTextFile): Promise<void> {
    assertWellFormed(text);
    let encoding = previous.encoding;
    let bytes = encode(text, encoding);
    if (bytes === null) {
      encoding = 'utf-8';
      bytes = encode(text, encoding)!;
    }
    await atomicWrite(path, bytes);
    this.remember(resolve(path), bytes, encoding);
  }

  async restore(path: string, previous: EncodedTextFile): Promise<void> {
    await atomicWrite(path, previous.bytes);
    this.remember(resolve(path), previous.bytes, previous.encoding);
  }

  private remember(path: string, bytes: Uint8Array, encoding: FileTextEncoding, digest = fingerprint(bytes)): void {
    this.cache.delete(path);
    this.cache.set(path, { fingerprint: digest, encoding });
    if (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
  }
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  // Preserve the native editor's existing symlink-following behavior.
  const destination = await realpath(path).catch((error: unknown) => {
    if (isMissing(error)) return path;
    throw error;
  });
  const mode = await stat(destination).then((info) => info.mode & 0o7777).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); }
    finally { await handle.close(); }
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
