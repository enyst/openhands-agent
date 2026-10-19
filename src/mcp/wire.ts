const toolKeys: Readonly<Record<string, string>> = { input_schema: 'inputSchema', output_schema: 'outputSchema', meta: '_meta' };
const nestedKeys: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  annotations: { read_only_hint: 'readOnlyHint', destructive_hint: 'destructiveHint', idempotent_hint: 'idempotentHint', open_world_hint: 'openWorldHint' },
  execution: { task_support: 'taskSupport' },
  icons: { mime_type: 'mimeType' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renameFields(value: Record<string, unknown>, keys: Readonly<Record<string, string>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [Object.hasOwn(keys, key) ? keys[key]! : key, item]));
}

/** MCP 1/2 persistence compatibility. Only protocol fields are renamed; JSON Schema and metadata are opaque. */
export function normalizeMcpToolWire(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result = renameFields(value, toolKeys);
  for (const [field, renames] of Object.entries(nestedKeys)) {
    const item = result[field];
    if (isRecord(item)) result[field] = renameFields(item, renames);
    else if (Array.isArray(item)) result[field] = item.map((entry: unknown) => isRecord(entry) ? renameFields(entry, renames) : entry);
  }
  return result;
}

/** System prompt records may contain native tools as well as serialized MCP definitions. */
export function normalizePersistedMcpTool(tool: Record<string, unknown>): Record<string, unknown> {
  return Object.hasOwn(tool, 'mcp_tool') ? { ...tool, mcp_tool: normalizeMcpToolWire(tool.mcp_tool) } : tool;
}

function omitKnownNulls(value: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => item !== null || !fields.includes(key)));
}

/** Match exclude_none on typed MCP fields without modifying opaque JSON data. */
export function serializeMcpToolWire(value: unknown): unknown {
  const normalized = normalizeMcpToolWire(value);
  if (!isRecord(normalized)) return normalized;
  const result = omitKnownNulls(normalized, ['title', 'description', 'outputSchema', 'annotations', 'icons', 'execution', '_meta']);
  if (isRecord(result.annotations)) result.annotations = omitKnownNulls(result.annotations, ['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']);
  if (isRecord(result.execution)) result.execution = omitKnownNulls(result.execution, ['taskSupport']);
  if (Array.isArray(result.icons)) result.icons = result.icons.map((icon: unknown) => isRecord(icon) ? omitKnownNulls(icon, ['mimeType', 'sizes', 'theme']) : icon);
  return result;
}
