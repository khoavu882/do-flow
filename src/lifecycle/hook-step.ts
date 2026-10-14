'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// IC-037 (DEC-034): the shared hooks tree and the hook front doors of every harness that reads it
// move together. An install or update that writes changed bytes into `hooks.shared` also plans the
// front doors of the other harnesses installed in the same scope, so a harness the run does not
// name is never left with doors written for an older tree. The doors ride the same plan, backup
// and ledger write as the run's own targets, and a door edited outside DoFlow refuses the whole plan.
const { selectAssets } = require('../registry/index.ts');
const { resolveAdapter, projectAdapterInput } = require('../adapters/index.ts');
const { renderPolicies } = require('./policies.ts');

const HOOKS_TREE_ASSET = 'hooks.shared';

/** Whether any target of the plan creates or updates a file of the shared hooks tree. */
function hooksTreeChanged(targets: any[]) {
  return targets.some((target: any) => !target.skipped
    && target.changes.some((change: any) => change.assetId === HOOKS_TREE_ASSET && (change.operation === 'create' || change.operation === 'update')));
}

/** The plan entries for the hook front doors of every harness installed in this scope that the run
 * does not name. Only the doors that differ from the current source appear, each with one notice;
 * a door the adapter refuses to overwrite carries the conflict and the command that resolves it.
 * `harnessScope` is the registry's name for the scope. `targetFromResult` is the lifecycle's own
 * conversion of an adapter result into a plan entry. */
function planHookCompanions({ registry, adapters, scope, harnessScope, scopeRoot, ledger, context, targets, targetFromResult }: any) {
  if (!hooksTreeChanged(targets)) return [];
  const named = new Set(targets.map((target: any) => target.harness));
  const installed = new Set((ledger?.resources ?? []).map((resource: any) => resource.harness));
  const run = targets.filter((target: any) => !target.skipped).map((target: any) => target.harness).join(',');
  const companions: any[] = [];
  for (const harness of registry.harnesses) {
    if (named.has(harness.id) || !installed.has(harness.id) || !harness.scopes.includes(harnessScope)) continue;
    if (!harness.capabilities?.hooks || harness.capabilities.hooks.status === 'unavailable') continue;
    const adapter = resolveAdapter(adapters, harness);
    if (typeof adapter.planHookDoors !== 'function') continue;
    const assets = selectAssets(registry, { harness: harness.id });
    const policies = renderPolicies(registry, { harness: harness.id });
    const adapterInput = projectAdapterInput({ registry, harness, scope, scopeRoot, assets, mcp: [], mcpAdoptable: [], policies, context });
    const input = { ...adapterInput, registry, ledger };
    const discovery = adapter.discover(input);
    const target = targetFromResult({ harness, assets, mcp: [], mcpSelected: null, policies, adapterInput, discovery,
      result: adapter.planHookDoors({ ...input, discovery }) });
    if (!target.changes.length && !target.conflicts.length) continue;
    companions.push({
      ...target, hookDoorsOnly: true,
      // The assets that own the doors this run plans, not the harness's whole set.
      assets: target.assets.filter((asset: any) => target.changes.some((change: any) => change.assetId === asset.id)),
      conflicts: target.conflicts.length
        ? [...target.conflicts, `${harness.id} hook front doors must move with the shared hooks tree; run: doflow update -t ${run},${harness.id} (add -f to overwrite edited doors)`]
        : target.conflicts,
      notices: target.changes.length ? [`refreshed ${harness.id} hook front doors to match the shared hooks tree`, ...target.notices] : target.notices,
    });
  }
  return companions;
}

module.exports = { planHookCompanions };
