import { z } from 'zod';

export * from './defaults.js';
export * from './module-qualnames.js';

export type JsonObject = Record<string, unknown>;
export type ToolExecutor<TAction = unknown, TObservation = unknown> = (
  action: TAction,
  context?: unknown,
) => TObservation | Promise<TObservation>;
export type ToolFactory = (params: Readonly<Record<string, unknown>>, context?: unknown) => readonly ToolDefinition[];

export const toolAnnotationsSchema = z
  .object({
    title: z.string().nullable().default(null),
    readOnlyHint: z.boolean().default(false),
    destructiveHint: z.boolean().default(true),
    idempotentHint: z.boolean().default(false),
    openWorldHint: z.boolean().default(true),
  })
  .strict();

export const toolSpecSchema = z
  .object({
    name: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type ToolAnnotations = z.infer<typeof toolAnnotationsSchema>;
export type ToolSpec = z.infer<typeof toolSpecSchema>;

export interface ToolDefinitionOptions<TInputSchema extends z.ZodType = z.ZodType, TOutputSchema extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TInputSchema;
  readonly outputSchema?: TOutputSchema;
  readonly executor?: ToolExecutor<z.infer<TInputSchema>, z.infer<TOutputSchema>>;
  readonly annotations?: ToolAnnotations;
  readonly meta?: JsonObject;
  readonly usable?: boolean;
  /** Runtime prompt text; excluded from tool wire schemas and JSON persistence. */
  readonly promptGuidance?: string | null;
}

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly annotations?: ToolAnnotations;
  readonly _meta?: JsonObject;
}

export interface ResponsesTool {
  readonly type: 'function';
  readonly name: string;
  readonly description?: string;
  readonly strict: false;
  readonly parameters: JsonObject;
}

export class ToolDefinition<TInputSchema extends z.ZodType = z.ZodType, TOutputSchema extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TInputSchema;
  readonly outputSchema: TOutputSchema | undefined;
  readonly executor: ToolExecutor<z.infer<TInputSchema>, z.infer<TOutputSchema>> | undefined;
  readonly annotations: ToolAnnotations | undefined;
  readonly meta: JsonObject | undefined;
  readonly usable: boolean;
  declare readonly promptGuidance: string | null;

  constructor(options: ToolDefinitionOptions<TInputSchema, TOutputSchema>) {
    this.name = options.name;
    this.description = options.description;
    this.inputSchema = options.inputSchema;
    this.outputSchema = options.outputSchema;
    this.executor = options.executor;
    this.annotations = options.annotations;
    this.meta = options.meta;
    this.usable = options.usable ?? true;
    Object.defineProperty(this, 'promptGuidance', { value: options.promptGuidance ?? null, enumerable: false });
  }

  async execute(input: unknown, context?: unknown): Promise<z.infer<TOutputSchema>> {
    if (this.executor === undefined) {
      throw new Error(`Tool '${this.name}' has no executor`);
    }

    const action = this.inputSchema.parse(input);
    const result = await this.executor(action, context);
    if (this.outputSchema === undefined) {
      return result;
    }
    return this.outputSchema.parse(result);
  }

  toMcpTool(inputSchema?: JsonObject, outputSchema?: JsonObject): McpTool {
    const tool: {
      name: string;
      description: string;
      inputSchema: JsonObject;
      outputSchema?: JsonObject;
      annotations?: ToolAnnotations;
      _meta?: JsonObject;
    } = {
      name: this.name,
      description: this.description,
      inputSchema: inputSchema ?? schemaToJsonObject(this.inputSchema),
    };

    const derivedOutputSchema = outputSchema ?? (this.outputSchema === undefined ? undefined : schemaToJsonObject(this.outputSchema));
    if (derivedOutputSchema !== undefined) {
      tool.outputSchema = derivedOutputSchema;
    }
    if (this.annotations !== undefined) {
      tool.annotations = this.annotations;
    }
    if (this.meta !== undefined) {
      tool._meta = this.meta;
    }
    return tool;
  }

  toResponsesTool(): ResponsesTool {
    return {
      type: 'function',
      name: this.name,
      description: this.description,
      strict: false,
      parameters: schemaToJsonObject(this.inputSchema),
    };
  }
}

export interface ToolCatalogMetadata {
  readonly userSelectable?: boolean;
  readonly catalogDescription?: string;
  readonly isUsable?: () => boolean;
  /** Trusted protocol provenance for this exact implementation; never imported. */
  readonly moduleQualname?: string;
  /** Marks a registration of the actual builtin, rather than a host override. */
  readonly builtinName?: string;
}
export interface BuiltinToolMetadata extends ToolCatalogMetadata {
  readonly canonicalName?: string;
  readonly acceptsParams?: boolean;
}
export interface ToolCatalogEntry {
  readonly name: string;
  readonly user_selectable: boolean;
  readonly usable: boolean;
  readonly description: string;
  readonly in_default_set: boolean;
}
type Registration = { readonly implementation: ToolDefinition | ToolFactory; readonly metadata: ToolCatalogMetadata };
const builtinNames: Readonly<Record<string, string>> = {
  FinishTool: 'finish', finish: 'finish', ThinkTool: 'think', think: 'think',
  SwitchLLMTool: 'switch_llm', switch_llm: 'switch_llm',
  ClassifyAndSwitchLLMTool: 'route_task_to_model', route_task_to_model: 'route_task_to_model',
};
const defaultNames = new Set(['terminal', 'file_editor', 'task_tracker', 'browser_tool_set', 'switch_llm']);

export class ToolRegistry {
  private readonly registrations = new Map<string, Registration>();
  private sealedRegistrations: Map<string, Registration> | null = null;
  private sealedBuiltins: Map<string, BuiltinRegistration> | null = null;

  register(name: string, tool: ToolDefinition, metadata: ToolCatalogMetadata = {}): void {
    this.registrations.set(name, { implementation: tool, metadata: { ...metadata } });
  }
  registerFactory(name: string, factory: ToolFactory, metadata: ToolCatalogMetadata = {}): void {
    this.registrations.set(name, { implementation: factory, metadata: { ...metadata } });
  }
  effectiveBuiltinName(name: string): string | null {
    const canonical = builtinNames[name] ?? builtinToolResolvers.get(name)?.metadata.canonicalName;
    if (canonical === undefined) return null;
    const registered = this.registrations.get(name);
    return registered === undefined || registered.metadata.builtinName === canonical ? canonical : null;
  }
  canonicalToolName(name: string): string {
    const canonical = this.effectiveBuiltinName(name);
    return canonical !== null && this.effectiveBuiltinName(canonical) === canonical ? canonical : name;
  }
  resolve(spec: ToolSpec, context?: unknown): readonly ToolDefinition[] {
    const parsedSpec = toolSpecSchema.parse(spec);
    assertSupportedResponseSchema(parsedSpec.params);
    delete parsedSpec.params.response_schema;
    const registration = this.registrations.get(parsedSpec.name)?.implementation;
    if (registration === undefined) {
      const builtin = builtinToolResolvers.get(parsedSpec.name);
      if (builtin !== undefined) return builtin.resolver(parsedSpec.params, context);
      throw new Error(`Unknown tool: ${parsedSpec.name}`);
    }
    if (registration instanceof ToolDefinition) {
      if (Object.keys(parsedSpec.params).length > 0) throw new Error(`Registered tool instance '${parsedSpec.name}' does not accept params`);
      return [registration];
    }
    return registration(parsedSpec.params, context);
  }
  listRegisteredTools(): readonly string[] { return [...this.registrations.keys()]; }
  /**
   * Snapshot live resolver provenance, independent of the sealed UI catalog.
   * Pass finalized selected names (excluding client tools) for server persistence.
   * A host override without metadata deliberately hides builtin provenance.
   */
  getToolModuleQualnames(names?: readonly string[]): Readonly<Record<string, string>> {
    const selected = new Set(names ?? [...this.registrations.keys(), ...builtinToolResolvers.keys()]);
    const modules: [string, string][] = [];
    for (const name of selected) {
      const registration = this.registrations.get(name);
      const metadata = registration === undefined ? builtinToolResolvers.get(name)?.metadata : registration.metadata;
      if (metadata?.moduleQualname !== undefined) modules.push([name, metadata.moduleQualname]);
    }
    return Object.fromEntries(modules);
  }
  listUsableTools(): readonly string[] {
    return [...this.registrations.keys()].filter(name => this.isToolAvailable(name));
  }
  isToolAvailable(name: string, options: { readonly checkUsable?: boolean } = {}): boolean {
    const registration = this.registrations.get(name);
    const builtin = builtinToolResolvers.get(name);
    if (registration === undefined && builtin === undefined) return false;
    if (options.checkUsable === false) return true;
    if (registration !== undefined) return checkUsable(registration.metadata.isUsable, !(registration.implementation instanceof ToolDefinition) || registration.implementation.usable);
    return checkUsable(builtin?.metadata.isUsable);
  }
  sealToolCatalog(): void {
    this.sealedRegistrations = new Map(this.registrations);
    this.sealedBuiltins = new Map(builtinToolResolvers);
  }
  unsealToolCatalog(): void { this.sealedRegistrations = null; this.sealedBuiltins = null; }
  getToolCatalog(options: { readonly checkUsable?: boolean } = {}): ToolCatalogEntry[] {
    const registrations = this.sealedRegistrations ?? this.registrations;
    const builtins = this.sealedBuiltins ?? builtinToolResolvers;
    const entries = new Map<string, ToolCatalogEntry>();
    for (const [name, registration] of registrations) {
      const builtinName = registration.metadata.builtinName;
      const canonical = builtinName !== undefined && (!registrations.has(builtinName) || registrations.get(builtinName)?.metadata.builtinName === builtinName) ? builtinName : name;
      const usable = options.checkUsable === false || checkUsable(registration.metadata.isUsable, !(registration.implementation instanceof ToolDefinition) || registration.implementation.usable);
      entries.set(canonical, catalogEntry(canonical, registration.metadata, usable));
    }
    for (const [name, builtin] of builtins) {
      const canonical = builtin.metadata.canonicalName ?? builtinNames[name] ?? name;
      if (builtin.metadata.userSelectable === false || registrations.has(canonical) || entries.has(canonical)) continue;
      entries.set(canonical, catalogEntry(canonical, builtin.metadata, options.checkUsable === false || checkUsable(builtin.metadata.isUsable)));
    }
    return [...entries.values()];
  }
}
function checkUsable(probe: (() => boolean) | undefined, fallback = true): boolean {
  try { return probe?.() ?? fallback; } catch { return false; }
}
function catalogEntry(name: string, metadata: ToolCatalogMetadata, usable: boolean): ToolCatalogEntry {
  return { name, user_selectable: metadata.userSelectable ?? true, usable,
    description: metadata.catalogDescription ?? '', in_default_set: defaultNames.has(name) };
}

export const globalToolRegistry = new ToolRegistry();

export function registerTool(name: string, tool: ToolDefinition, metadata: ToolCatalogMetadata = {}): void {
  globalToolRegistry.register(name, tool, metadata);
}

export function registerToolFactory(name: string, factory: ToolFactory, metadata: ToolCatalogMetadata = {}): void {
  globalToolRegistry.registerFactory(name, factory, metadata);
}

export function resolveTool(spec: ToolSpec, context?: unknown): readonly ToolDefinition[] {
  return globalToolRegistry.resolve(spec, context);
}

export function listRegisteredTools(): readonly string[] {
  return globalToolRegistry.listRegisteredTools();
}

export function getToolModuleQualnames(names?: readonly string[]): Readonly<Record<string, string>> {
  return globalToolRegistry.getToolModuleQualnames(names);
}

export function listUsableTools(): readonly string[] {
  return globalToolRegistry.listUsableTools();
}

function schemaToJsonObject(schema: z.ZodType): JsonObject {
  const jsonSchema = z.toJSONSchema(schema);
  if (!isJsonObject(jsonSchema)) {
    throw new Error('Zod schema did not produce a JSON object schema');
  }
  return jsonSchema;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolver fallbacks do not construct tools while cataloging availability. */
type BuiltInResolver = (params: Readonly<Record<string, unknown>>, context?: unknown) => readonly ToolDefinition[];

type BuiltinRegistration = { readonly resolver: BuiltInResolver; readonly metadata: BuiltinToolMetadata };
const builtinToolResolvers = new Map<string, BuiltinRegistration>();
export function registerBuiltinResolver(name: string, resolver: BuiltInResolver, metadata: BuiltinToolMetadata = {}): void {
  builtinToolResolvers.set(name, { resolver, metadata: { ...metadata } });
}
export function getToolCatalog(options: { readonly checkUsable?: boolean } = {}): ToolCatalogEntry[] { return globalToolRegistry.getToolCatalog(options); }
export function isToolAvailable(name: string, options: { readonly checkUsable?: boolean } = {}): boolean { return globalToolRegistry.isToolAvailable(name, options); }
export function sealToolCatalog(): void { globalToolRegistry.sealToolCatalog(); }
export function unsealToolCatalog(): void { globalToolRegistry.unsealToolCatalog(); }

export function assertSupportedResponseSchema(params: Readonly<Record<string, unknown>>): void {
  if (params.response_schema !== undefined && params.response_schema !== null) {
    throw new Error('response_schema is not supported by the native structured-output protocol.');
  }
}
