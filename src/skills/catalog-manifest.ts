import { z } from 'zod';

// Validation-only projection of pinned Marketplace JSON. These fields determine
// whether catalog filtering is valid; none installs or executes a plugin.
const optionalText = z.string().nullish();
const author = z.union([z.string(), z.object({ name: z.string().optional(), email: optionalText, url: optionalText })]).nullish();
const source = z.object({ source: z.string(), repo: optionalText, url: optionalText, ref: optionalText, path: optionalText })
  .refine(value => value.source !== 'github' || Boolean(value.repo))
  .refine(value => value.source !== 'url' || Boolean(value.url));
const entry = z.object({
  name: z.string(), source: z.string(), description: optionalText, version: optionalText,
  author, category: optionalText, homepage: optionalText,
});
const stringOrStrings = z.union([z.string(), z.array(z.string())]).nullish();
const object = z.record(z.string(), z.unknown());
const serverMap = z.record(z.string(), object).nullish();
const pythonBoolean = z.preprocess(value => {
  if (value === 0 || value === 1) return Boolean(value);
  if (typeof value === 'string') {
    if (['0', 'off', 'f', 'false', 'n', 'no'].includes(value.toLowerCase())) return false;
    if (['1', 'on', 't', 'true', 'y', 'yes'].includes(value.toLowerCase())) return true;
  }
  return value;
}, z.boolean());
const plugin = entry.extend({
  source: z.union([z.string(), source]), entry_command: optionalText, strict: pythonBoolean.optional(),
  commands: stringOrStrings, agents: stringOrStrings, hooks: z.union([z.string(), object]).nullish(),
  mcpServers: serverMap, lspServers: serverMap, license: optionalText, repository: optionalText,
  keywords: z.array(z.string()).optional(), tags: z.array(z.string()).optional(),
});
const marketplace = z.object({
  name: z.string(), owner: z.object({ name: z.string(), email: optionalText }), description: optionalText,
  plugins: z.array(z.preprocess(value => {
    // Pydantic populate_by_name accepts either form and the alias wins.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const data = value as Record<string, unknown>;
      return { ...data, mcpServers: 'mcpServers' in data ? data.mcpServers : data.mcp_config,
        lspServers: 'lspServers' in data ? data.lspServers : data.lsp_servers };
    }
    return value;
  }, plugin)).default([]),
  skills: z.array(entry).default([]), metadata: z.object({ description: optionalText, version: optionalText }).nullish(),
  // The source overwrites path with the actual repository path before validation.
});

export type SkillsMarketplace = z.infer<typeof marketplace>;

/** Parse catalog metadata only; source resolution and installation belong to hosts. */
export function parseSkillsMarketplace(value: unknown): SkillsMarketplace {
  return marketplace.parse(value);
}

export function parseCatalogSkillNames(value: unknown): Set<string> {
  return new Set(parseSkillsMarketplace(value).plugins.map(plugin => plugin.name));
}
