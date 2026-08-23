'use strict';
// `doflow reconcile` — converge observed state onto the doflow.lock pin: report drift, then heal
// it on confirmation. Never re-prompts for MCP; selections ride exactly as pinned.
const os = require('node:os');
const path = require('node:path');
const { toolDirs } = require('../../install/targets');
const { resolveContext, printContext } = require('../../install/context');
const { writeManifest } = require('../../install/manifest');
const { confirm } = require('../../helper/prompt');
const { sourceCommit } = require('../../helper/git');
const { loadRegistry } = require('../../registry');
const { applyLifecycle } = require('../../lifecycle');
const {
  codexScope, registryLifecycleView, assertSafeRegistryPlan, lockDocument, recordLock,
} = require('../../lifecycle/view');
const { readLock } = require('../../state/lockfile');
const { REPO_ROOT, SCRIPT_DIR, pkg, scopeOf, buildAdapterRegistry } = require('../shared');

/** Classify desired-vs-observed drift for one lifecycle view. The plan IS the diff: its changes
 * are the operations needed to converge, its conflicts and prerequisites are the drift that must
 * not be silently healed. */
function reconcileReport(view) {
  const drifts = [];
  const perHarness = new Map();
  for (const target of view.plan.targets) {
    if (target.skipped) continue;
    const entry = { create: 0, update: 0, remove: 0 };
    for (const change of target.changes) {
      if (entry[change.operation] !== undefined) entry[change.operation] += 1;
      drifts.push({ harness: target.harness, operation: change.operation, assetId: change.assetId, target: change.target });
    }
    perHarness.set(target.harness, entry);
  }
  return {
    drifts,
    conflicts: view.plan.conflicts,
    prerequisites: view.plan.prerequisites,
    perHarness: Object.fromEntries(perHarness),
    clean: drifts.length === 0 && view.plan.conflicts.length === 0,
  };
}

function printReconcileReport(report, lock) {
  console.log(`[INFO] Reconciling against doflow.lock (sourceVersion ${lock.sourceVersion ?? 'unknown'})`);
  for (const [harness, counts] of Object.entries(report.perHarness)) {
    const total = counts.create + counts.update + counts.remove;
    console.log(`[INFO] ${harness}: ${total === 0 ? 'clean' : `${total} drift(s) (${counts.create} create, ${counts.update} update, ${counts.remove} remove)`}`);
  }
  for (const conflict of report.conflicts) console.log(`[CONFLICT] ${conflict.harness}: ${conflict.reason}`);
  for (const prerequisite of report.prerequisites) console.log(`[PENDING-TRUST] ${prerequisite.harness}: ${prerequisite.prerequisite}`);
  if (report.clean) console.log('[OK] Observed state matches doflow.lock.');
}

function cmdReconcile(o) {
  const scope = scopeOf(o);
  const dirs = toolDirs(scope);
  const lockArgs = scope.global ? { scope: 'global', homeDir: os.homedir() } : { scope: 'project', projectRoot: path.resolve(scope.projectRoot) };
  const lock = readLock(lockArgs);
  if (!lock || !lock.targets.length) {
    // Reconcile converges onto what install pinned; with no pin there is no desired state to
    // converge to, and guessing one from the registry would silently adopt targets the user
    // never chose.
    console.log('[INFO] No doflow.lock in this scope — nothing pinned to reconcile against. Run `doflow install` first.');
    return;
  }
  const targets = lock.targets.map((entry) => entry.harness);
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  printContext(resolveContext({ repoRoot: REPO_ROOT, targets, dirs, sourceCommit: sourceCommit(SCRIPT_DIR), ...scope }));
  // MCP selections ride exactly as pinned — reconcile never re-prompts and never widens them.
  const mcpIds = [...new Set(Object.entries(lock.mcpSelections ?? {}).flatMap(([harness, ids]) => (targets.includes(harness) ? ids : [])))];
  const lifecycleView = registryLifecycleView({ registry, repoRoot: REPO_ROOT, scope, dirs, targets, mcpIds, force: true });
  if (!lifecycleView.plan.safe) { assertSafeRegistryPlan(lifecycleView); return; }

  const report = reconcileReport(lifecycleView);
  printReconcileReport(report, lock);
  if (o.json) console.log(JSON.stringify({ scope: lock.scope, sourceVersion: lock.sourceVersion, targets, ...report }, null, 2));
  if (o.dryRun) {
    console.log('[DRY] Reconcile plan complete — no changes written');
    if (!report.clean) process.exitCode = 1; // CI-friendly: drifted check must fail loudly.
    return;
  }
  if (report.clean) return;

  if (!confirm(`Reconcile ${targets.join(', ')} by applying ${report.drifts.length} change(s)?`, o.force)) {
    console.error('[INFO]  Aborted.');
    process.exit(1);
  }
  applyLifecycle({ plan: lifecycleView.plan, registry: lifecycleView.registry,
    adapters: buildAdapterRegistry(),
    stateRoot: lifecycleView.stateRoot, ledger: lifecycleView.ledger });
  writeManifest({ claudeDir: dirs.claude, scriptVersion: pkg.version, operation: 'update', repoRoot: SCRIPT_DIR, sourceCommit: sourceCommit(SCRIPT_DIR), backupId: '', tools: targets, date: new Date(), mcpServers: mcpIds });
  console.log('[OK] Reconciliation complete — state converged onto doflow.lock.');
}

module.exports = cmdReconcile;
