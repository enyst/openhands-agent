import { PROMPT_CACHE_KEY_BEDROCK as source } from './prompt-cache-models.js';

const regions: ReadonlySet<string> = new Set(source.regions);
const crossRegions: ReadonlySet<string> = new Set(source.cross_regions);
const converseModels: ReadonlySet<string> = new Set(source.converse_models);
const providers: ReadonlySet<string> = new Set(source.invoke_providers);
const routeCapabilities: Readonly<Record<string, boolean | null>> = source.route_capabilities;
const invokeCapabilities: Readonly<Record<string, boolean | null>> = source.invoke_capabilities;

// These transformations are bound to reviewed locked source methods by the
// generator. Prefix stripping is one ordered pass, not a fixed-point rewrite.
function stripPrefixes(model: string): string {
  for (const prefix of source.strip_prefixes) {
    if (model.startsWith(prefix)) model = model.slice(prefix.length);
  }
  return model;
}

function baseModel(model: string): string {
  let stripped = model;
  for (const prefix of source.nova_strip_prefixes) {
    if (stripped.startsWith(prefix)) { stripped = stripped.slice(prefix.length); break; }
  }
  for (const [prefix, name] of Object.entries(source.nova_models)) {
    if (stripped.startsWith(prefix)) return name;
  }
  model = stripPrefixes(model);
  // Upstream detects any case-insensitive occurrence, not a strict ARN grammar.
  if (model.toLowerCase().includes('arn')) model = model.split('/').at(-1)!;
  // Python's Unicode \d and \w; preserve the two substitutions' order.
  model = model.replace(/(:\p{Nd}+):\p{Nd}+k$/u, '$1').replace(/\[[\p{L}\p{N}_]+\]$/u, '');
  const dot = model.indexOf('.');
  if (crossRegions.has(dot < 0 ? model : model.slice(0, dot))) {
    // Python raises IndexError rather than falling through to another hint.
    if (dot < 0) throw new RangeError('Invalid Bedrock model normalization.');
    return model.slice(dot + 1);
  }
  const slash = model.indexOf('/');
  if (slash >= 0 && regions.has(model.slice(0, slash))) return model.slice(slash + 1);
  return model;
}

function route(model: string): string {
  for (const [prefix, name] of source.routes) {
    if (model.startsWith(prefix) || model.includes(`/${prefix}`)) return name;
  }
  const withoutBedrock = model.replace('bedrock/', '');
  if (Object.keys(source.nova_models).some(prefix => withoutBedrock.startsWith(prefix))) return 'converse';
  if (model.includes(':application-inference-profile/')) return 'converse';
  return converseModels.has(baseModel(model)) || converseModels.has(stripPrefixes(model)) ? 'converse' : 'invoke';
}

function invokeProvider(model: string): string | undefined {
  if (model.startsWith('invoke/')) model = model.slice('invoke/'.length);
  if (model.toLowerCase().includes('nova') && providers.has('nova')) return 'nova';
  const dotProvider = model.split('.')[0]!;
  if (providers.has(dotProvider)) return dotProvider;
  const pathProvider = model.split('/')[0]!;
  if (providers.has(pathProvider)) return pathProvider;
  return source.invoke_providers.find(provider => model.includes(provider));
}

/** Cache capability only: this does not select a native transport or endpoint. */
export function bedrockCacheKeyResolution(model: string): boolean | null {
  const selectedRoute = route(model);
  const provider = invokeProvider(model);
  // The source eagerly normalizes even for explicit routes and empty handlers.
  baseModel(model);
  if (Object.hasOwn(routeCapabilities, selectedRoute)) return routeCapabilities[selectedRoute]!;
  return provider === undefined ? source.default_capability : invokeCapabilities[provider]!;
}
