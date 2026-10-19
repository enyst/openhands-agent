import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { InstallationMetadata, getCachePath } from '../extensions/index.js';
import { cachedGitFetcher, isCachedGitPinned } from '../git/cached-repo.js';
import { getUserPersistenceDir } from '../utils/index.js';
import { Skill } from './index.js';
import { parseCatalogSkillNames } from './catalog-manifest.js';

export const PUBLIC_SKILLS_REPO = 'https://github.com/OpenHands/extensions';
export const DEFAULT_MARKETPLACE_PATH = 'marketplaces/default.json';
type CatalogRepository = { readonly path: string; readonly pinned: boolean };
export interface PublicSkillsOptions {
  readonly repoUrl?: string;
  readonly ref?: string;
  readonly cacheDirectory?: string;
  readonly marketplacePath?: string | null;
  readonly fetchRepository?: (url: string, ref: string, options: { readonly strict: boolean }) => Promise<CatalogRepository>;
}
const publicCache = new Map<string, { readonly until: number; readonly skills: readonly Skill[] }>();
export function invalidatePublicSkillsCache(): void { publicCache.clear(); }

function localPublicPath(url: string): string | null {
  const local = process.env.EXTENSIONS_PATH;
  return url === PUBLIC_SKILLS_REPO && local ? resolve(local.startsWith('~/') ? join(homedir(), local.slice(2)) : local) : null;
}
async function repository(options: PublicSkillsOptions, strict: boolean): Promise<CatalogRepository> {
  const url = options.repoUrl ?? PUBLIC_SKILLS_REPO; const ref = options.ref ?? process.env.EXTENSIONS_REF ?? 'main';
  const local = localPublicPath(url); if (local !== null) return { path: local, pinned: false };
  if (options.fetchRepository) return options.fetchRepository(url, ref, { strict });
  const destination = getCachePath(url, options.cacheDirectory ?? join(getUserPersistenceDir(), 'skills', '.cache'));
  await cachedGitFetcher(url, destination, { ref, update: true, strict });
  return { path: destination, pinned: await isCachedGitPinned(destination) };
}

/** Force an actual update; preserve the working catalog cache on failure. */
export async function syncPublicSkills(options: PublicSkillsOptions = {}): Promise<void> {
  await repository(options, true);
  invalidatePublicSkillsCache();
}

/** Public catalog load is best-effort; sync is the strict error-reporting boundary. */
export async function loadPublicSkills(options: PublicSkillsOptions = {}): Promise<Skill[]> {
  const url = options.repoUrl ?? PUBLIC_SKILLS_REPO;
  const marketplace = options.marketplacePath === undefined ? DEFAULT_MARKETPLACE_PATH : options.marketplacePath;
  const key = JSON.stringify([localPublicPath(url) ?? url, options.ref ?? process.env.EXTENSIONS_REF ?? 'main', marketplace, options.cacheDirectory ?? null]);
  const cached = publicCache.get(key); if (cached && performance.now() < cached.until) return [...cached.skills];
  try {
    const repo = await repository(options, false);
    let selected: Set<string> | null = null;
    if (marketplace !== null) {
      const manifest = resolve(repo.path, marketplace);
      if (!within(resolve(repo.path), manifest)) return [];
      try {
        selected = parseCatalogSkillNames(JSON.parse(await readFile(manifest, 'utf8')));
      } catch { if (marketplace !== DEFAULT_MARKETPLACE_PATH) return []; }
    }
    const skills: Skill[] = [];
    if (selected === null) skills.push(...await scanSkills(join(repo.path, 'skills'), [], repo.path));
    else for (const name of selected) {
      const directory = resolve(repo.path, 'skills');
      const candidate = resolve(directory, name);
      if (!within(directory, candidate)) continue;
      for (const file of [join(candidate, 'SKILL.md'), `${candidate}.md`]) {
        try {
          if (!(await stat(file)).isFile()) continue;
          skills.push(await Skill.load(file, repo.path)); break;
        } catch { /* Missing catalog files are no-ops. */ }
      }
    }
    if (skills.length) publicCache.set(key, { until: repo.pinned ? Infinity : performance.now() + 60_000, skills });
    return [...skills];
  } catch { return []; }
}

export interface UserSkillsOptions {
  readonly directories?: readonly string[];
  readonly installedDirectory?: string;
  /** The owning installed-skill service supplies only enabled entries. */
  readonly loadInstalled?: () => Promise<readonly Skill[]>;
}
export async function loadUserSkills(options: UserSkillsOptions = {}): Promise<Skill[]> {
  const base = getUserPersistenceDir();
  const installed = options.installedDirectory ?? join(base, 'skills', 'installed');
  const directories = options.directories ?? [join(homedir(), '.agents', 'skills'), join(base, 'skills'), join(base, 'microagents')];
  const selected = new Map<string, Skill>();
  for (const dir of directories) for (const skill of await scanSkills(dir, [installed])) if (!selected.has(skill.name)) selected.set(skill.name, skill);
  try {
    const enabled = options.loadInstalled ? await options.loadInstalled() : await loadInstalledSkills(installed);
    for (const skill of enabled) if (!selected.has(skill.name)) selected.set(skill.name, skill);
  } catch { /* Installed failures must not erase independently loaded user skills. */ }
  return [...selected.values()];
}
async function loadInstalledSkills(directory: string): Promise<Skill[]> {
  const metadata = await InstallationMetadata.loadFromDir(directory); const skills: Skill[] = [];
  for (const info of metadata.validateTracked(directory)) if (info.enabled) skills.push(...await scanSkills(join(directory, info.name)));
  return skills;
}

/** Traverse catalog sources without following cycles or parsing a skill's resource files as skills. */
async function scanSkills(root: string, excluded: readonly string[] = [], baseDirectory = root): Promise<Skill[]> {
  const skills: Skill[] = []; const visited = new Set<string>();
  const blocked = await Promise.all(excluded.map(async path => { try { return await realpath(path); } catch { return resolve(path); } }));
  const walk = async (directory: string): Promise<void> => {
    let physical: string;
    try { physical = await realpath(directory); } catch { return; }
    if (visited.has(physical) || blocked.some(path => within(path, physical))) return;
    visited.add(physical);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    const skillFile = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === 'skill.md');
    if (skillFile) {
      try { skills.push(await Skill.load(join(directory, skillFile.name), baseDirectory)); } catch { /* Skip one invalid skill. */ }
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      try {
        const info = entry.isSymbolicLink() ? await stat(path) : entry;
        if (info.isDirectory()) await walk(path);
        else if (info.isFile() && entry.name !== 'README.md' && entry.name.toLowerCase().endsWith('.md')) skills.push(await Skill.load(path, baseDirectory));
      } catch { /* Skip broken symlinks and malformed individual files. */ }
    }
  };
  await walk(root); return skills;
}
function within(root: string, path: string): boolean { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep); }
