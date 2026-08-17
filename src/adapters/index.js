'use strict';

const path = require('node:path');

// Harness adapters own native formats and paths. This module intentionally only
// validates and resolves that boundary; it never reads or writes harness files.
const ADAPTER_METHODS = Object.freeze(['discover', 'render', 'plan', 'apply', 'remove', 'verify']);

function resolveRegistrySource(registry, source, label) {
  if (typeof registry.repoRoot !== 'string' || !registry.repoRoot) throw new Error(`Registry repoRoot is required for ${label}`);
  if (typeof source !== 'string' || !source) throw new Error(`Registry ${label} source is required`);
  const root = path.resolve(registry.repoRoot);
  const resolved = path.resolve(root, source);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Registry ${label} source escapes repository: ${source}`);
  return resolved;
}

/** Normalize the validated Codex registry declaration into its adapter's named
 * input. Source paths always come from the registry; runtime overrides only
 * affect an explicitly safe trust acknowledgement. */
function nativeProjectionFor(registry, harness, mcp, context) {
  if (!harness.nativeProjection) return {};
  if (harness.adapter !== 'codex') throw new Error(`No native projection normalizer is registered for '${harness.adapter}'`);
  const declaration = harness.nativeProjection;
  const override = context.projectionOverrides?.[harness.id] ?? {};
  if (!override || typeof override !== 'object' || Array.isArray(override)) throw new Error(`Projection override for '${harness.id}' must be an object`);
  const trusted = override.hooks?.trusted;
  if (trusted !== undefined && typeof trusted !== 'boolean') throw new Error(`Projection override '${harness.id}.hooks.trusted' must be boolean`);
  return Object.freeze({
    configResources: Object.freeze((declaration.config?.resources || []).map((resource) => Object.freeze({ ...resource }))),
    mcp: Object.freeze({ catalog: Object.freeze(mcp.map((server) => Object.freeze({ ...server }))), selected: Object.freeze(mcp.map((server) => server.id)) }),
    agents: Object.freeze({ sourceDir: resolveRegistrySource(registry, declaration.agents?.source, `${harness.id} agents`) }),
    hooks: Object.freeze({
      sourceFile: resolveRegistrySource(registry, declaration.hooks?.configSource, `${harness.id} hooks config`),
      sourceHooksDir: resolveRegistrySource(registry, declaration.hooks?.scriptsSource, `${harness.id} hooks scripts`),
      trusted: trusted ?? declaration.hooks?.trusted,
    }),
  });
}

/**
 * Convert validated registry declarations into the only generic payload an
 * adapter receives. Native serializers may add adapter-specific fields, but
 * cannot infer applicability from a missing projection.
 */
function projectAdapterInput({ registry, harness, scope, scopeRoot, assets = [], mcp = [], policies = [], context = {} }) {
  if (!registry || !harness) throw new Error('registry and harness are required for adapter projection');
  const projectAsset = (asset) => {
    const projection = asset?.projection?.[harness.id];
    if (!projection || typeof projection.renderer !== 'string' || typeof projection.capability !== 'string') {
      throw new Error(`Asset '${asset?.id ?? '?'}' lacks a projection for '${harness.id}'`);
    }
    const capability = harness.capabilities?.[projection.capability];
    if (!capability || capability.status === 'unavailable') {
      throw new Error(`Asset '${asset.id}' cannot project unavailable '${harness.id}' capability '${projection.capability}'`);
    }
    return Object.freeze({
      id: asset.id, kind: asset.kind, source: asset.source, ownership: asset.ownership,
      renderer: projection.renderer, capability: projection.capability,
      capabilityStatus: capability.status, nativeTarget: harness.nativeTargets?.[projection.capability] ?? null,
      nativeDir: asset.nativeDir?.[harness.id] ?? null,
      // Optional destination shape for copy-tree assets. Null for every projection that mirrors
      // source paths, which is all of them except Antigravity's directory-per-agent requirement.
      layout: projection.layout ?? null,
      prerequisites: [...(capability.prerequisites || [])],
    });
  };
  if (mcp.length && (!harness.capabilities?.mcp || harness.capabilities.mcp.status === 'unavailable')) {
    throw new Error(`Selected MCP servers cannot project to unavailable '${harness.id}' MCP capability`);
  }
  const projection = nativeProjectionFor(registry, harness, mcp, context);
  return Object.freeze({
    harness, scope, scopeRoot, context,
    assets: Object.freeze(assets.map(projectAsset)),
    mcp: Object.freeze(mcp.map((server) => Object.freeze({ ...server }))),
    policies: Object.freeze(policies.map((policy) => Object.freeze({ ...policy }))),
    nativeTargets: Object.freeze({ ...harness.nativeTargets }),
    projection: Object.freeze({ ...projection }),
  });
}

function assertAdapter(adapter, name = 'adapter') {
  if (!adapter || typeof adapter !== 'object') throw new Error(`${name} must be an object`);
  for (const method of ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') throw new Error(`${name} must implement ${method}()`);
  }
  return adapter;
}

function createAdapterRegistry(adapters = {}) {
  const entries = adapters instanceof Map ? [...adapters.entries()] : Object.entries(adapters);
  const resolved = new Map();
  for (const [name, adapter] of entries) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Adapter names must be non-empty strings');
    resolved.set(name, assertAdapter(adapter, `Adapter '${name}'`));
  }
  return Object.freeze({
    names: () => [...resolved.keys()],
    has: (name) => resolved.has(name),
    get(name) {
      const adapter = resolved.get(name);
      if (!adapter) throw new Error(`No registered adapter '${name}'`);
      return adapter;
    },
  });
}

function resolveAdapter(adapterRegistry, harness) {
  if (!adapterRegistry || typeof adapterRegistry.get !== 'function') throw new Error('adapterRegistry must expose get(name)');
  if (!harness || typeof harness.adapter !== 'string') throw new Error('Harness must declare an adapter');
  return adapterRegistry.get(harness.adapter);
}

module.exports = { ADAPTER_METHODS, assertAdapter, createAdapterRegistry, resolveAdapter, resolveRegistrySource, nativeProjectionFor, projectAdapterInput };
