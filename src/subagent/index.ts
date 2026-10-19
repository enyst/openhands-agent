import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, posix, sep } from 'node:path';
import { parseDocument } from 'yaml';

import { getUserPersistenceDir } from '../utils/index.js';

// Retain permission_mode as passive definition metadata; no confirmation policy
// is instantiated or enforced by native discovery.
const knownAgentFields = new Set([
  'name',
  'description',
  'model',
  'color',
  'tools',
  'skills',
  'max_iteration_per_run',
  'max_budget_per_run',
  'hooks',
  'profile_store_dir',
  'mcp_config',
  'mcp_servers',
  'permission_mode',
  'condenser',
]);

const agentDirectories = ['.agents/agents', '.openhands/agents'] as const;
const skipFiles = new Set(['README.md', 'readme.md']);

export type AgentDefinitionLevel = 'project' | 'user' | 'builtin' | 'plugin' | 'programmatic';

export interface AgentDefinitionOptions {
  readonly name: string;
  readonly description?: string;
  readonly model?: string;
  readonly color?: string | null;
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
  readonly system_prompt?: string;
  readonly source?: string | null;
  readonly when_to_use_examples?: readonly string[];
  readonly hooks?: unknown;
  readonly max_iteration_per_run?: number | null;
  readonly max_budget_per_run?: number | null;
  readonly mcp_servers?: Record<string, unknown> | null;
  readonly mcp_config?: Record<string, unknown> | null;
  /** Metadata only; native confirmation execution remains disabled. */
  readonly permission_mode?: string | null;
  readonly profile_store_dir?: string | null;
  readonly condenser?: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly level?: AgentDefinitionLevel | null;
}

export class AgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly color: string | null;
  readonly tools: string[];
  readonly skills: string[];
  readonly system_prompt: string;
  readonly source: string | null;
  readonly when_to_use_examples: string[];
  readonly hooks: unknown;
  readonly max_iteration_per_run: number | null;
  readonly max_budget_per_run: number | null;
  readonly mcp_config: Record<string, unknown> | null;
  readonly permission_mode: string | null;
  readonly profile_store_dir: string | null;
  readonly condenser: unknown;
  readonly metadata: Record<string, unknown>;
  readonly level: AgentDefinitionLevel | null;

  constructor(options: AgentDefinitionOptions) {
    this.name = options.name;
    this.description = options.description ?? '';
    this.model = options.model ?? 'inherit';
    this.color = options.color ?? null;
    this.tools = [...(options.tools ?? [])];
    this.skills = [...(options.skills ?? [])];
    this.system_prompt = options.system_prompt ?? '';
    this.source = options.source ?? null;
    this.when_to_use_examples = [...(options.when_to_use_examples ?? [])];
    this.hooks = options.hooks ?? null;
    this.max_iteration_per_run = positiveNumberOrNull(options.max_iteration_per_run ?? null, 'max_iteration_per_run');
    this.max_budget_per_run = positiveNumberOrNull(options.max_budget_per_run ?? null, 'max_budget_per_run');
    this.mcp_config = normalizeMcpConfig(Object.hasOwn(options, 'mcp_config') ? options.mcp_config : options.mcp_servers);
    this.permission_mode = permissionMode(options.permission_mode);
    this.profile_store_dir = options.profile_store_dir ?? null;
    this.condenser = options.condenser ?? null;
    this.metadata = { ...(options.metadata ?? {}) };
    this.level = options.level ?? null;
  }

  /** Deprecated read alias; canonical JSON carries mcp_config only. */
  get mcp_servers(): Record<string, unknown> | null { return this.mcp_config; }

  static async load(agentPath: string): Promise<AgentDefinition> {
    const fileContent = await readFile(agentPath, 'utf8');
    const parsed = parseFrontmatter(fileContent);
    const metadata = parsed.metadata;
    const name = stringField(metadata.name, basename(agentPath, extname(agentPath)));
    const description = stringField(metadata.description, '');

    return new AgentDefinition({
      name,
      description,
      model: stringField(metadata.model, 'inherit'),
      color: nullableString(metadata.color),
      tools: stringList(metadata.tools, false),
      skills: stringList(metadata.skills, true),
      max_iteration_per_run: optionalNumber(metadata.max_iteration_per_run),
      max_budget_per_run: optionalNumber(metadata.max_budget_per_run),
      mcp_config: recordOrNull(Object.hasOwn(metadata, 'mcp_config') ? metadata.mcp_config : metadata.mcp_servers, 'mcp_config'),
      permission_mode: nullableString(metadata.permission_mode),
      profile_store_dir: nullableString(metadata.profile_store_dir),
      hooks: metadata.hooks,
      condenser: condenserMetadata(metadata.condenser),
      system_prompt: parsed.content.trim(),
      source: toPosixPath(agentPath),
      when_to_use_examples: examplesFrom(description),
      metadata: Object.fromEntries(Object.entries(metadata).filter(([key]) => !knownAgentFields.has(key))),
    });
  }
}

export async function loadProjectAgents(projectDir: string): Promise<AgentDefinition[]> {
  return loadAgentsFromDirs(agentDirectories.map((dir) => join(projectDir, dir)));
}

export async function loadUserAgents(): Promise<AgentDefinition[]> {
  return loadAgentsFromDirs(agentDirectories.map((dir) => userAgentsDir(dir)));
}

function userAgentsDir(relative: string): string {
  // Map a file-based agents dir onto its user-level base: `.openhands/agents`
  // goes under the persistence dir (which replaces the `~/.openhands` base);
  // every other entry stays home-relative.
  const [base, ...rest] = relative.split('/');
  if (base === '.openhands') {
    return join(getUserPersistenceDir(), rest.join('/'));
  }
  return join(homedir(), relative);
}

export interface DiscoverAgentsOptions {
  readonly projectDir?: string | null;
  readonly includeProject?: boolean;
  readonly includeUser?: boolean;
}

export async function discoverAgents(options: DiscoverAgentsOptions = {}): Promise<AgentDefinition[]> {
  const includeProject = options.includeProject ?? true;
  const includeUser = options.includeUser ?? true;

  const discovered: AgentDefinition[] = [];
  if (includeProject && options.projectDir !== null && options.projectDir !== undefined) {
    for (const definition of await loadProjectAgents(options.projectDir)) {
      discovered.push(new AgentDefinition({ ...definition, level: 'project' }));
    }
  }
  if (includeUser) {
    for (const definition of await loadUserAgents()) {
      discovered.push(new AgentDefinition({ ...definition, level: 'user' }));
    }
  }

  // Project wins over user on name collision; first wins.
  const seen = new Set<string>();
  const result: AgentDefinition[] = [];
  for (const definition of discovered) {
    if (!seen.has(definition.name)) {
      seen.add(definition.name);
      result.push(definition);
    }
  }
  return result;
}

export async function loadAgentsFromDirs(directories: readonly string[]): Promise<AgentDefinition[]> {
  const seen = new Set<string>();
  const result: AgentDefinition[] = [];
  for (const directory of directories) {
    for (const definition of await loadAgentsFromDir(directory)) {
      if (!seen.has(definition.name)) {
        seen.add(definition.name);
        result.push(definition);
      }
    }
  }
  return result;
}

export async function loadAgentsFromDir(agentsDir: string): Promise<AgentDefinition[]> {
  if (!(await isDirectory(agentsDir))) {
    return [];
  }
  const definitions: AgentDefinition[] = [];
  for (const entry of (await readdir(agentsDir)).sort()) {
    const path = join(agentsDir, entry);
    if (skipFiles.has(entry) || extname(entry).toLowerCase() !== '.md' || await isDirectory(path)) {
      continue;
    }
    try {
      definitions.push(await AgentDefinition.load(path));
    } catch {
      // Match Python behavior: skip invalid individual agent files.
    }
  }
  return definitions;
}

export type AgentFactoryFunction = (llm: unknown) => unknown;
export interface AgentFactory {
  readonly factoryFunc: AgentFactoryFunction;
  readonly definition: AgentDefinition;
}

const agentFactories = new Map<string, AgentFactory>();

export function registerAgent(name: string, factoryFunc: AgentFactoryFunction, description: string | AgentDefinition): void {
  if (agentFactories.has(name)) {
    throw new Error(`Agent '${name}' already registered`);
  }
  agentFactories.set(name, { factoryFunc, definition: resolveAgentDefinition(name, description) });
}

export function registerAgentIfAbsent(name: string, factoryFunc: AgentFactoryFunction, description: string | AgentDefinition): boolean {
  if (agentFactories.has(name)) {
    return false;
  }
  agentFactories.set(name, { factoryFunc, definition: resolveAgentDefinition(name, description) });
  return true;
}

export function getAgentFactory(name: string | null | undefined): AgentFactory {
  const deprecated: Record<string, string> = { default: 'general-purpose', 'default cli mode': 'general-purpose', explore: 'code-explorer', bash: 'bash-runner' };
  const factoryName = name === null || name === undefined || name.length === 0 ? 'general-purpose' : deprecated[name] ?? name;
  const factory = agentFactories.get(factoryName);
  if (factory === undefined) {
    const available = [...agentFactories.keys()].sort().join(', ') || 'none registered';
    throw new Error(`Unknown agent '${name ?? ''}'. Available types: ${available}. Use registerAgent() to add custom agent types.`);
  }
  return factory;
}

export function getFactoryInfo(include?: (definition: AgentDefinition) => boolean): string {
  const factories = [...agentFactories.entries()].filter(([, factory]) => include?.(factory.definition) ?? true);
  if (factories.length === 0) {
    return '- No user-registered agents yet. Call registerAgent(...) to add custom agents.';
  }
  return factories.sort(([left], [right]) => left.localeCompare(right)).map(([name, factory]) => {
    const tools = factory.definition.tools.length > 0 ? ` (tools: ${factory.definition.tools.join(', ')})` : '';
    return `- **${name}**: ${factory.definition.description}${tools}`;
  }).join('\n');
}

export function getRegisteredAgentDefinitions(): AgentDefinition[] {
  return [...agentFactories.values()].map((factory) => factory.definition);
}

export function resetAgentRegistryForTests(): void {
  agentFactories.clear();
}

function resolveAgentDefinition(name: string, description: string | AgentDefinition): AgentDefinition {
  return description instanceof AgentDefinition ? description : new AgentDefinition({ name, description });
}

function parseFrontmatter(fileContent: string): { metadata: Record<string, unknown>; content: string } {
  const lines = fileContent.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  if (lines[0]?.trim() !== '---') {
    return { metadata: {}, content: fileContent };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) {
    return { metadata: {}, content: fileContent };
  }
  const document = parseDocument(lines.slice(1, end).join('\n'), { version: '1.1', uniqueKeys: false });
  if (document.errors.length || document.warnings.length) throw new Error('Invalid agent frontmatter');
  const metadata: unknown = document.toJS({ maxAliasCount: 100 });
  return { metadata: recordOrNull(metadata, 'frontmatter') ?? {}, content: lines.slice(end + 1).join('\n') };
}

function stringField(value: unknown, fallback: string): string {
  return value === undefined || value === null ? fallback : scalarToString(value);
}

function nullableString(value: unknown): string | null {
  return value === undefined || value === null ? null : scalarToString(value);
}

function scalarToString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  throw new Error('Expected a scalar string-compatible value');
}

function stringList(value: unknown, splitComma: boolean): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === 'string') {
    return splitComma ? value.split(',').map((part) => part.trim()).filter((part) => part.length > 0) : [value];
  }
  return [];
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return Number(value);
  }
  return null;
}

function positiveNumberOrNull(value: number | null, field: string): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be positive`);
  }
  return value;
}

function recordOrNull(value: unknown, field: string): Record<string, unknown> | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${field} must be a mapping`);
}

function normalizeMcpConfig(value: unknown): Record<string, unknown> | null {
  const config = recordOrNull(value, 'mcp_config');
  if (config === null) return null;
  return Object.fromEntries(Object.entries(config).map(([name, item]) => {
    const server = recordOrNull(item, 'MCP server');
    if (server === null) throw new Error('MCP server must be a mapping');
    if (server.enabled !== undefined && typeof server.enabled !== 'boolean') throw new Error('MCP enabled must be boolean');
    return [name, { ...structuredClone(server), enabled: server.enabled ?? true }];
  }));
}

function permissionMode(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const mode = value.trim().toLowerCase();
  if (!['always_confirm', 'never_confirm', 'confirm_risky'].includes(mode)) throw new Error('Invalid permission_mode');
  return mode;
}

function condenserMetadata(value: unknown): unknown {
  if (value === null || value === undefined || value === true) return null;
  if (value === false) return { kind: 'NoOpCondenser' };
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['', 'default', 'inherit'].includes(normalized)) return null;
    if (['none', 'off', 'false', 'no', 'disable', 'disabled'].includes(normalized)) return { kind: 'NoOpCondenser' };
    throw new Error('Invalid condenser metadata');
  }
  return recordOrNull(value, 'condenser');
}

function examplesFrom(description: string): string[] {
  return [...description.matchAll(/<example>(.*?)<\/example>/gis)].map((match) => match[1]?.trim() ?? '').filter((example) => example.length > 0);
}

function toPosixPath(path: string): string {
  return path.split(sep).join(posix.sep);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
