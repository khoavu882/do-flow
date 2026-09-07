'use strict';

// Codex's native-projection normalizer, moved here from the common adapter module (review A3:
// `nativeProjectionFor` in src/adapters/index.js contained this Codex-specific shape inline, so
// per-harness knowledge lived on the shared side of the adapter boundary). The common module now
// only dispatches by adapter name; the shape below — configResources / mcp catalog / agents dir /
// hooks trust — is Codex's own and belongs to its adapter directory.

const { resolveRegistrySource } = require('../resolve-source');

/** Normalize the validated Codex registry declaration into its adapter's named
 * input. Source paths always come from the registry; runtime overrides only
 * affect an explicitly safe trust acknowledgement. */
function normalizeNativeProjection(registry, harness, mcp, context) {
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

module.exports = { normalizeNativeProjection };
