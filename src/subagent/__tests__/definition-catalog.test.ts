import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentDefinition, discoverAgents, loadAgentsFromDir } from '../index.js';

describe('canonical definition metadata', () => {
  it('keeps canonical MCP precedence, including explicit null, and accepts the legacy alias', () => {
    const canonical = { canonical: { command: 'one', env: { TOKEN: '${TOKEN}' } } };
    const legacy = { legacy: { command: 'two' } };
    const current = new AgentDefinition({ name: 'test', mcp_config: canonical, mcp_servers: legacy });
    expect(current.mcp_config).toEqual({ canonical: { command: 'one', env: { TOKEN: '${TOKEN}' }, enabled: true } });
    expect(current.mcp_servers).toEqual(current.mcp_config);
    expect(JSON.parse(JSON.stringify(current))).not.toHaveProperty('mcp_servers');
    expect(new AgentDefinition({ name: 'test', mcp_servers: legacy }).mcp_config).toMatchObject(legacy);
    expect(new AgentDefinition({ name: 'test', mcp_config: null, mcp_servers: legacy }).mcp_config).toBeNull();
  });

  it('reads nested source YAML without expanding placeholders or losing declared metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sdk04-definition-'));
    try {
      const file = join(directory, 'full.md');
      await writeFile(file, `---\nname: full\ndescription: >-\n  Fully specified agent.\n  <example>Inspect code</example>\ntools:\n  - TerminalTool\nskills: [one, two]\npermission_mode: confirm_risky\nmax_iteration_per_run: 7\nmcp_config:\n  fetch:\n    command: uvx\n    args:\n      - --with\n      - mcp==1.29.0\n    env:\n      TOKEN: "\${TOKEN:-placeholder}"\ncondenser: none\ncustom_key:\n  nested: true\n---\nPrompt`);
      const definition = await AgentDefinition.load(file);
      expect(definition).toMatchObject({ name: 'full', tools: ['TerminalTool'], skills: ['one', 'two'], permission_mode: 'confirm_risky', max_iteration_per_run: 7, condenser: { kind: 'NoOpCondenser' }, metadata: { custom_key: { nested: true } } });
      expect(definition.mcp_config).toEqual({ fetch: { command: 'uvx', args: ['--with', 'mcp==1.29.0'], env: { TOKEN: '${TOKEN:-placeholder}' }, enabled: true } });
      expect(definition.when_to_use_examples).toEqual(['Inspect code']);
      expect(definition.metadata).not.toHaveProperty('mcp_config');
      await writeFile(join(directory, 'broken.md'), '---\nname: [broken\n---\nbroken');
      expect((await loadAgentsFromDir(directory)).map(value => value.name)).toEqual(['full']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects invalid MCP maps and preserves JSON flow mappings and explicit null frontmatter', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sdk04-definition-null-'));
    try {
      const file = join(directory, 'one.md');
      await writeFile(file, '---\nname: one\nmcp_config: null\nmcp_servers: {legacy: {command: ignored}}\n---\nPrompt');
      expect((await AgentDefinition.load(file)).mcp_config).toBeNull();
      await writeFile(file, '---\nname: one\nmcp_servers: {legacy: {command: local}}\n---\nPrompt');
      expect((await AgentDefinition.load(file)).mcp_config).toEqual({ legacy: { command: 'local', enabled: true } });
      await writeFile(file, '---\nname: one\nmcp_config: [invalid]\n---\nPrompt');
      await expect(AgentDefinition.load(file)).rejects.toThrow(/mapping/u);
      expect(await discoverAgents({ projectDir: directory, includeUser: false })).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('reads ordinary YAML aliases as data and refuses unknown tagged constructors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sdk04-definition-alias-'));
    try {
      const file = join(directory, 'alias.md');
      await writeFile(file, '---\nname: alias\nshared: &server\n  command: fixture\n  env: {TOKEN: "${TOKEN}"}\nmcp_config:\n  first: *server\n  second: *server\n---\nPrompt');
      const definition = await AgentDefinition.load(file);
      expect(definition.mcp_config).toEqual({ first: { command: 'fixture', env: { TOKEN: '${TOKEN}' }, enabled: true }, second: { command: 'fixture', env: { TOKEN: '${TOKEN}' }, enabled: true } });
      await writeFile(file, '---\nname: bad\ncustom: !!python/object:Unsafe {}\n---\nPrompt');
      await expect(AgentDefinition.load(file)).rejects.toThrow('Invalid agent frontmatter');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
