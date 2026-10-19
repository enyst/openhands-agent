import { describe, expect, it } from 'vitest';
import { systemPromptEventSchema } from '../../event/index.js';
import { EventLog } from '../../conversation/event-log.js';
import { InMemoryFileStore } from '../../io/index.js';
import { MCPToolDefinition } from '../index.js';
import { normalizeMcpToolWire } from '../wire.js';

// Adapted from upstream tests/sdk/mcp/test_mcp_wire_compat.py (0c3b613d).
const client = { isConnected: () => true, callTool: async () => ({ content: [] }) };
const schema = { type: 'object', properties: { input_schema: { type: 'string' }, meta: { type: 'null' }, read_only_hint: { type: 'boolean' } } };
const wire = { name: 'search', description: 'Search', inputSchema: schema, outputSchema: schema,
  _meta: { input_schema: 'untouched' }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  execution: { taskSupport: 'optional' }, icons: [{ src: 'icon.png', mimeType: 'image/png' }], title: 'Search tool' };
const historical = { name: 'search', description: 'Search', input_schema: schema, output_schema: schema,
  meta: wire._meta, annotations: { read_only_hint: true, destructive_hint: false, idempotent_hint: true, open_world_hint: false },
  execution: { task_support: 'optional' }, icons: [{ src: 'icon.png', mime_type: 'image/png' }], title: 'Search tool' };

describe('persisted MCP tool wire compatibility', () => {
  it('preserves extension keys that shadow Object prototype properties', () => {
    const spec = JSON.parse('{"name":"extensions","constructor":"opaque","__proto__":{"x":1},"annotations":{"constructor":null,"read_only_hint":true},"icons":[{"mime_type":"image/png","__proto__":"opaque"}]}');
    expect(normalizeMcpToolWire(spec)).toEqual({ ...spec, annotations: { constructor: null, readOnlyHint: true }, icons: [JSON.parse('{"mimeType":"image/png","__proto__":"opaque"}')] });
  });

  it('canonicalizes writes and preserves nulls within opaque MCP data', () => {
    const store = new InMemoryFileStore();
    const event = systemPromptEventSchema.parse({ system_prompt: { type: 'text', text: 'Test' }, tools: [] });
    const input = { type: 'object', properties: { result: { const: null, default: null, enum: [null, 'ok'] } } };
    const rawTool = { name: 'nullable', input_schema: input, meta: { extension: null } };
    event.tools.push({ kind: 'MCPToolDefinition', mcp_tool: rawTool });
    new EventLog(store).append(event);
    const disk = JSON.parse(store.read(`events/event-00000-${event.id}.json`));
    const expected = { name: 'nullable', inputSchema: input, _meta: { extension: null } };
    expect(disk.tools[0].mcp_tool).toEqual(expected);
    expect(new EventLog(store).get(0)).toMatchObject({ tools: [{ mcp_tool: expected }] });
    expect(event.tools[0]?.mcp_tool).toEqual(rawTool);
  });

  it.each([['MCP 2 attribute names', historical], ['MCP 1 meta', { ...wire, _meta: undefined, meta: wire._meta }], ['wire', wire]])('reads %s and writes canonical protocol keys', (_name, spec) => {
    const original = structuredClone(spec);
    const tool = new MCPToolDefinition(spec, client);
    expect(tool.toMcpTool()).toEqual(wire);
    expect(tool.annotations).toEqual(wire.annotations);
    expect(tool.meta).toEqual(wire._meta);
    expect(tool.toOpenAiTool()).toMatchObject({ function: { parameters: schema } });
    expect(spec).toEqual(original);
  });

  it('normalizes historical SystemPromptEvent tools during persisted reload', () => {
    const store = new InMemoryFileStore();
    const id = '11111111-1111-4111-8111-111111111111';
    const event = { id, kind: 'SystemPromptEvent', source: 'agent', system_prompt: { type: 'text', text: 'Test' }, tools: [{ kind: 'MCPToolDefinition', mcp_tool: historical }, { name: 'native', input_schema: schema }] };
    store.write(`events/event-00000-${id}.json`, JSON.stringify(event));
    const loaded = new EventLog(store).get(0);
    expect(loaded).toMatchObject({ tools: [{ mcp_tool: wire }, event.tools[1]] });
    expect(JSON.parse(store.read(`events/event-00000-${id}.json`))).toEqual(event);
    expect(systemPromptEventSchema.parse(event).tools[0]).toEqual({ kind: 'MCPToolDefinition', mcp_tool: wire });
  });

  it('keeps nullable optional fields and user schema data intact', () => {
    const tool = new MCPToolDefinition({ name: 'minimal', input_schema: schema, output_schema: null, annotations: null, meta: null }, client);
    expect(tool.toMcpTool()).toMatchObject({ inputSchema: schema });
    expect(tool.toMcpTool()).not.toHaveProperty('output_schema');
    expect(tool.toMcpTool()).not.toHaveProperty('meta');
    expect(schema.properties.meta).toEqual({ type: 'null' });
  });

  it('retains original optional descriptions in MCP data while projecting a display fallback', () => {
    const minimal = { name: 'minimal', inputSchema: { type: 'object' } };
    expect(new MCPToolDefinition(minimal, client).toMcpTool()).toEqual(minimal);
    expect(new MCPToolDefinition({ ...minimal, description: null }, client).toMcpTool()).toEqual({ ...minimal, description: null });
    expect(new MCPToolDefinition(minimal, client).toOpenAiTool()).toMatchObject({ function: { description: 'No description provided' } });
  });

  it('omits typed optional MCP nulls on disk without dropping opaque extension nulls', () => {
    const store = new InMemoryFileStore();
    const event = systemPromptEventSchema.parse({ system_prompt: { type: 'text', text: 'Test' }, tools: [{ mcp_tool: {
      name: 'minimal', input_schema: { type: 'object', properties: { value: { const: null } } },
      description: null, output_schema: null, execution: null, icons: null, meta: { extension: null },
      annotations: { read_only_hint: null, extension: null }, extension: null,
    } }] });
    new EventLog(store).append(event);
    const disk = JSON.parse(store.read(`events/event-00000-${event.id}.json`));
    expect(disk.tools[0].mcp_tool).toEqual({ name: 'minimal', inputSchema: { type: 'object', properties: { value: { const: null } } }, _meta: { extension: null }, annotations: { extension: null }, extension: null });
  });
});
