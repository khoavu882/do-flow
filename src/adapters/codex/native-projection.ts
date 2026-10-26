'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// Codex's native-projection normalizer, moved here from the common adapter module (review A3:
// `nativeProjectionFor` in src/adapters/index.ts contained this Codex-specific shape inline, so
// per-harness knowledge lived on the shared side of the adapter boundary). The common module now
// only dispatches by adapter name; the shape below — configResources / mcp catalog / agents dir /
// hooks trust — is Codex's own and belongs to its adapter directory.

const { resolveRegistrySource } = require('../resolve-source.ts');

/** Normalize the validated Codex registry declaration into its adapter's named
 * input. Source paths always come from the registry; runtime overrides only
 * affect an explicitly safe trust acknowledgement. */
function normalizeNativeProjection(registry: any, harness: any, mcp: any[], context: any): any {
  const declaration = harness.nativeProjection;
  const override = context.projectionOverrides?.[harness.id] ?? {};
  if (!override || typeof override !== 'object' || Array.isArray(override)) throw new Error(`Projection override for '${harness.id}' must be an object`);
  const trusted = override.hooks?.trusted;
  if (trusted !== undefined && typeof trusted !== 'boolean') throw new Error(`Projection override '${harness.id}.hooks.trusted' must be boolean`);
  // Hook tiers (maint-hooks): Codex outside `hooks.harnesses` gets no hooks.json, no hook scripts and no
  // `features.hooks` entry; the lifecycle removes what an earlier install wrote through the remove path.
  const hooksOff = harness.capabilities?.hooks?.tiered === true;
  const configResources = (declaration.config?.resources || []).filter((resource: any) => !(hooksOff && resource.identity === 'features.hooks'));
  return Object.freeze({
    configResources: Object.freeze(configResources.map((resource: any) => Object.freeze({ ...resource }))),
    mcp: Object.freeze({ catalog: Object.freeze(mcp.map((server: any) => Object.freeze({ ...server }))), selected: Object.freeze(mcp.map((server: any) => server.id)) }),
    agents: Object.freeze({ sourceDir: resolveRegistrySource(registry, declaration.agents?.source, `${harness.id} agents`) }),
    hooks: hooksOff ? Object.freeze({}) : Object.freeze({
      sourceFile: resolveRegistrySource(registry, declaration.hooks?.configSource, `${harness.id} hooks config`),
      sourceHooksDir: resolveRegistrySource(registry, declaration.hooks?.scriptsSource, `${harness.id} hooks scripts`),
      trusted: trusted ?? declaration.hooks?.trusted,
    }),
  });
}

module.exports = { normalizeNativeProjection };
