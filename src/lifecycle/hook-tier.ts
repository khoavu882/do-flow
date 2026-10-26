'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// Hook tiers (maint-hooks). Content (guidance, skills, agents, MCP) goes to every harness; DoFlow's
// enforcement (hooks, gates, the bridge) goes only to the harnesses the `hooks.harnesses` setting
// names. A harness outside that list is planned against a registry copy in which its `hooks`
// capability is unavailable, so the same seams that already handle a harness without hooks drop
// its hook assets, render its lifecycle policies as guidance fallbacks and skip its bespoke hook
// config; the removal of what an earlier install wrote is planned from the ledger, as an uninstall
// of those resources alone.

const HOOKS_KEY = 'hooks.harnesses';
const TIER_REASON = `not in ${HOOKS_KEY}`;
const WORKERS_KEY = 'workers.enabled';

/** The harness ids that get DoFlow's hooks: the person's `hooks.harnesses` (user layer only), else the
 * registry default. A settings fault keeps the default; only an unusable settings registry throws.
 * With no user settings file the default is read from the registry alone, so an install that has
 * nothing to resolve loads no settings module (the 086 hot-path budget). */
function resolveHookHarnesses(options: { env?: Record<string, string | undefined>; loadSettings?: any } = {}): string[] {
  return resolveHookTier(options).harnesses;
}

/** The hook tier plus the worker harnesses the person configured (`workers.enabled` set in a settings
 * file; null when it is the shipped default), for the run's warnings (maint-hooks R-4). */
function resolveHookTier({ env = process.env, loadSettings }: { env?: Record<string, string | undefined>; loadSettings?: any } = {}): { harnesses: string[]; workers: string[] | null } {
  if (!loadSettings) {
    const fs = require('node:fs');
    const path = require('node:path');
    const { configHome } = require('../runtime/config-home.ts');
    const dir = configHome(env).dir;
    if (!dir || !fs.existsSync(path.join(dir, 'settings.json'))) {
      const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'registry', 'settings.json'), 'utf8'));
      return { harnesses: [...registry.keys[HOOKS_KEY].default], workers: null };
    }
  }
  const load = loadSettings ?? require('../runtime/settings/resolve.ts').loadSettings;
  const view = load({ global: true, env: { ...env }, only: [HOOKS_KEY, WORKERS_KEY] });
  const resolution = view.get(HOOKS_KEY, 'global');
  const workers = view.get(WORKERS_KEY, 'global');
  const configured = Array.isArray(workers?.value) && workers?.origin?.layer && workers.origin.layer !== 'default';
  return {
    harnesses: Array.isArray(resolution?.value) ? [...resolution.value] : [],
    workers: configured ? workers.value.filter((id: any) => typeof id === 'string' && id !== 'primary').map((id: string) => id.split(/[:/]/)[0]) : null,
  };
}

/** One WARN line per planned harness that gets no hooks although it is the primary session (claude)
 * or a worker the person configured: there it runs without DoFlow's destructive-command guard. */
function hookTierWarnings(registry: any, targets: string[], tier: { harnesses: string[]; workers: string[] | null }): string[] {
  const warnings: string[] = [];
  for (const harness of registry.harnesses) {
    if (!targets.includes(harness.id) || tier.harnesses.includes(harness.id) || !getsHooks(registry, harness)) continue;
    const role = harness.id === 'claude' ? 'the primary session' : tier.workers?.includes(harness.id) ? `a worker in ${WORKERS_KEY}` : null;
    if (role) warnings.push(`${harness.id} is ${role} but not in ${HOOKS_KEY}: it runs without DoFlow's hooks, gates or destructive-command guard`);
  }
  return warnings;
}

/** Whether a harness is outside the hook tier. `hookHarnesses` undefined means no tier was resolved
 * (an in-process caller): every harness keeps its hooks, as before the setting existed. */
function outsideHookTier(harnessId: string, hookHarnesses?: string[] | null): boolean {
  return Array.isArray(hookHarnesses) && !hookHarnesses.includes(harnessId);
}

/** Whether DoFlow installs any hook for a harness: its hooks are supported, or a hook asset applies
 * to it (Pi's guard extension). OpenCode and Copilot get none, so the tier leaves them as they are. */
function getsHooks(registry: any, harness: any): boolean {
  const hooks = harness.capabilities?.hooks;
  if (!hooks || hooks.status === 'unavailable') return false;
  if (hooks.status === 'supported') return true;
  const { selectAssets } = require('../registry/index.ts');
  return selectAssets(registry, { harness: harness.id, capability: 'hooks' }).length > 0;
}

/** The registry a harness outside the tier is planned against: the same object graph, with that
 * harness's `hooks` capability unavailable. A harness DoFlow installs no hook for, or that is in the
 * tier, is returned unchanged. */
function tieredRegistry(registry: any, hookHarnesses?: string[] | null): any {
  if (!Array.isArray(hookHarnesses)) return registry;
  let changed = false;
  const harnesses = registry.harnesses.map((harness: any) => {
    const hooks = harness.capabilities?.hooks;
    if (!outsideHookTier(harness.id, hookHarnesses) || !getsHooks(registry, harness)) return harness;
    changed = true;
    return { ...harness, capabilities: { ...harness.capabilities, hooks: { ...hooks, status: 'unavailable', reason: TIER_REASON, tiered: true } } };
  });
  return changed ? { ...registry, harnesses } : registry;
}

/** The harness ids whose hooks a removal must take: those the ledger records hook resources for. A
 * removal plans what an install wrote, so a harness installed outside the tier (no hook rows) plans
 * no hook removal, and never claims a shared hook file another harness still owns. */
function hookHoldersFromLedger(registry: any, ledger: any): string[] {
  const { selectAssets } = require('../registry/index.ts');
  const rows = ledger?.resources ?? [];
  return registry.harnesses.filter((harness: any) => {
    const hookIds = new Set<string>(selectAssets(registry, { harness: harness.id, capability: 'hooks' }).map((asset: any) => asset.id));
    return rows.some((row: any) => row?.harness === harness.id && isHookResource(row, hookIds));
  }).map((harness: any) => harness.id);
}

/** Whether a (possibly tiered) harness declaration had its hooks switched off by the tier. */
function hooksTieredOff(harness: any): boolean {
  return harness?.capabilities?.hooks?.tiered === true;
}

/** The context keys that hand an adapter a bespoke hook source (Codex hooks.json). A harness outside the tier is planned without them, and with `hooksOff` set for the
 * adapters whose hooks ride a non-hook asset (Claude's settings.json). */
const HOOK_SOURCE_KEYS = ['codexHooksSourceFile', 'codexHooksSourceDir'];

function withoutHookSources(context: any): any {
  const next: any = { ...context, hooksOff: true };
  for (const key of HOOK_SOURCE_KEYS) delete next[key];
  return next;
}

/** Renderers and resource kinds that only ever carry hook state, whatever asset id they ride on
 * (Codex files its bespoke hook resources under a guidance asset id). */
const HOOK_RENDERERS = new Set(['codex-hooks', 'antigravity-hooks', 'pi-guard-extension']);
const HOOK_KINDS = new Set(['hooks-file', 'hooks-script']);

function isHookResource(item: any, hookIds: Set<string>): boolean {
  return hookIds.has(item?.assetId) || item?.nativeComponent === 'hooks' || HOOK_KINDS.has(item?.kind)
    || HOOK_RENDERERS.has(item?.projection?.renderer);
}

/**
 * Add to a harness's content plan the removal of the hooks an earlier install wrote for it, planned by
 * the adapter's own remove path against the full registry and kept to hook changes only. Nothing is
 * planned when the ledger holds no hook row for the harness. The removals carry `hookTier: true`, so
 * applyLifecycle runs them through `adapter.remove` with `hookTierInput`.
 */
function planHookTierRemovals({ target, registry, adapter, harness, scope, scopeRoot, ledger, context, normalizeChange, adapterConflicts }: any): any {
  const { selectAssets } = require('../registry/index.ts');
  const { projectAdapterInput } = require('../adapters/index.ts');
  const { renderPolicies } = require('./policies.ts');
  if (harness.capabilities?.hooks?.status === 'unavailable') return target;
  const hookIds = new Set<string>(selectAssets(registry, { harness: harness.id, capability: 'hooks' }).map((asset: any) => asset.id));
  const rows = (ledger?.resources ?? []).filter((row: any) => row?.harness === harness.id && isHookResource(row, hookIds));
  if (!rows.length) return target;
  const assets = selectAssets(registry, { harness: harness.id });
  const policies = renderPolicies(registry, { harness: harness.id });
  const input = projectAdapterInput({ registry, harness, scope, scopeRoot, assets, mcp: [], mcpAdoptable: [], policies,
    context: { ...context, operation: 'remove' } });
  const discovery = adapter.discover({ ...input, registry, ledger });
  const result = adapter.plan({ ...input, registry, ledger, discovery });
  // A removal the content plan already carries (an adapter that plans its own hooks off) is not planned twice.
  const planned = new Set(target.changes.map((change: any) => `${change.ownershipIdentity}\0${change.target}`));
  const removals = (result.changes || []).filter((change: any) => isHookResource(change, hookIds)
    && !planned.has(`${change.ownershipIdentity ?? change.ownership}\0${change.target}`))
    .map((change: any) => Object.freeze({ ...normalizeChange(change, { harness, assets }), hookTier: true }));
  const conflicts = adapterConflicts(result, harness).filter((reason: any) => /hook/i.test(String(reason)));
  if (!removals.length && !conflicts.length) return target;
  const used = new Set(removals.map((change: any) => change.assetId));
  const extraAssets = assets.filter((asset: any) => used.has(asset.id) && !target.assets.some((own: any) => own.id === asset.id));
  const changes = [...target.changes, ...removals];
  const requiredNativeResources = target.requiredNativeResources === target.changes ? changes : [...target.requiredNativeResources, ...removals];
  return {
    ...target, assets: [...target.assets, ...extraAssets], changes, requiredNativeResources,
    conflicts: [...target.conflicts, ...conflicts],
    notices: [...target.notices, `removing ${harness.id} hooks: ${TIER_REASON} (content stays)`],
    hookTierInput: input,
  };
}

module.exports = { HOOKS_KEY, TIER_REASON, resolveHookHarnesses, resolveHookTier, hookTierWarnings, outsideHookTier, tieredRegistry, hookHoldersFromLedger, hooksTieredOff, withoutHookSources, isHookResource, planHookTierRemovals };
