'use strict';
// `doflow reconcile` — converge observed state onto the doflow.lock pin: report drift, then heal
// it on confirmation. Never re-prompts for MCP; selections ride exactly as pinned.
// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.
const path = require('node:path');
const { toolDirs } = require('../../install/targets.ts');
const { resolveContext, printContext } = require('../../install/context.ts');
const { writeManifest } = require('../../install/manifest.ts');
const { DEFAULT_BACKUP_RETENTION, createFileBackup } = require('../../install/backup.ts');
const { backupSetFromPlan, backupSetFromPaths } = require('../../install/backup-set.ts');
const { ledgerPath } = require('../../state/index.ts');
const { backupStep, reportBackup, applyBackupRetention } = require('./install.ts');
const { confirm } = require('../../helper/prompt.ts');
const { sourceCommit } = require('../../helper/git.ts');
const { loadRegistry, retiredFor } = require('../../registry/index.ts');
const { applyLifecycle, recordMcpOwnership } = require('../../lifecycle/index.ts');
const { formatRetiredPlans, retiredReleaseKeys } = require('../../lifecycle/retired-harnesses.ts');
const {
  registryLifecycleView, assertSafeRegistryPlan,
} = require('../../lifecycle/view.ts');
const { recordedMcpSelections } = require('../../install/mcp.ts');
const {
  REPO_ROOT, SCRIPT_DIR, pkg, scopeOf, installPaths, scopeSelectionState, printRecordedMcpOwnership, buildAdapterRegistry,
  refuseHomeRootedProject, holdRunLock, checkpointRunLock,
} = require('../shared.ts');

/** Classify desired-vs-observed drift for one lifecycle view. The plan IS the diff: its changes
 * are the operations needed to converge, its conflicts and prerequisites are the drift that must
 * not be silently healed. */
function reconcileReport(view: any): any {
  const drifts = [];
  const perHarness = new Map();
  for (const target of view.plan.targets) {
    if (target.skipped) continue;
    const entry: any = { create: 0, update: 0, remove: 0 };
    for (const change of target.changes) {
      if (entry[change.operation] !== undefined) entry[change.operation] += 1;
      drifts.push({ harness: target.harness, operation: change.operation, assetId: change.assetId, target: change.target });
    }
    perHarness.set(target.harness, entry);
  }
  // A retired harness's rows (row 127 IC-003) are drift too: converging means releasing them.
  for (const change of (view.plan.retiredHarnesses ?? []).flatMap((item: any) => item.changes)) {
    drifts.push({ harness: change.harness, operation: change.operation, assetId: change.assetId, target: change.target, retired: true });
  }
  return {
    drifts,
    conflicts: view.plan.conflicts,
    prerequisites: view.plan.prerequisites,
    perHarness: Object.fromEntries(perHarness),
    clean: drifts.length === 0 && view.plan.conflicts.length === 0,
  };
}

function printReconcileReport(report: any, lock: any, retiredLines: string[] = []): void {
  console.log(`[INFO] Reconciling against doflow.lock (sourceVersion ${lock.sourceVersion ?? 'unknown'})`);
  for (const [harness, counts] of Object.entries<any>(report.perHarness)) {
    const total = counts.create + counts.update + counts.remove;
    console.log(`[INFO] ${harness}: ${total === 0 ? 'clean' : `${total} drift(s) (${counts.create} create, ${counts.update} update, ${counts.remove} remove)`}`);
  }
  for (const line of retiredLines) console.log(line);
  for (const conflict of report.conflicts) console.log(`[CONFLICT] ${conflict.harness}: ${conflict.reason}`);
  for (const prerequisite of report.prerequisites) console.log(`[PENDING-TRUST] ${prerequisite.harness}: ${prerequisite.prerequisite}`);
  if (report.clean) console.log('[OK] Observed state matches doflow.lock.');
}

/** The backup a retirement sweep takes (row 127 FR-4): the set install and update take, files and
 * ledger. A sweep that only gives up rows (release, drop, keep) touches no file, so that set is empty;
 * the ledger alone is then what a rollback needs to bring the rows and the target entry back. */
function retirementBackupSet(view: any, paths: any, scope: any): any {
  const ledger = ledgerPath(view.stateRoot);
  const args = { scope: scope.global ? 'global' : 'project', scopeRoot: paths.scopeRoot, records: [ledger],
    exclude: [paths.backupRoot, view.stateRoot, paths.manifestPath, path.join(paths.doflowRoot, 'doflow.lock')] };
  const set = backupSetFromPlan({ plan: view.plan, ...args });
  return set.count ? set : backupSetFromPaths({ items: [{ path: ledger, harnesses: [] }], ...args });
}

function cmdReconcile(o: any): void {
  refuseHomeRootedProject(o, 'reconcile');
  const scope = scopeOf(o);
  const hold = holdRunLock(o, scope, 'reconcile');
  try {
    const dirs = toolDirs(scope);
    const lifecyclePaths = installPaths(scope);
    const { lock, ledger, manifestServers } = scopeSelectionState(scope);
    // Read only when there is a pin or a row to classify, as before this check existed.
    const registry = lock?.targets?.length || ledger?.resources?.length ? loadRegistry({ repoRoot: REPO_ROOT }) : null;
    const retired = (harness: string) => (registry ? retiredFor(registry, harness) : null);
    // A retired pin (row 127 IC-004) names a harness with no adapter: dropped, said, and the rest
    // converge. Its ledger rows are released by this run's plan, like install's and update's.
    for (const entry of lock?.targets ?? []) {
      const record = retired(entry.harness);
      if (record) console.log(`[WARN] ${entry.harness}: retired (use ${record.replacement}); dropped from the pinned targets`);
    }
    const livePins = (lock?.targets ?? []).filter((entry: any) => !retired(entry.harness));
    // A harness the ledger holds but the lock does not pin is installed and outside reconcile's reach.
    // Said, not converged: the lock records choices, and reconcile has no choice to record for it.
    const pinned = new Set(livePins.map((entry: any) => entry.harness));
    const unpinned = [...new Set((ledger?.resources ?? []).map((resource: any) => resource.harness))]
      .filter((harness: any) => !pinned.has(harness) && !retired(harness)).sort();
    for (const harness of unpinned) {
      const count = ledger.resources.filter((resource: any) => resource.harness === harness).length;
      console.log(`[WARN] ${harness}: installed (ledger holds ${count} resource(s)) but absent from doflow.lock; reconcile does not converge it.`);
    }
    if (!lock || !livePins.length) {
      // Reconcile converges onto what install pinned; with no pin there is no desired state to
      // converge to, and guessing one from the registry would silently adopt targets the user
      // never chose.
      console.log('[INFO] No doflow.lock in this scope — nothing pinned to reconcile against. Run `doflow install` first.');
      return;
    }
    const targets = livePins.map((entry: any) => entry.harness);
    printContext(resolveContext({ repoRoot: REPO_ROOT, targets, dirs, sourceCommit: sourceCommit(SCRIPT_DIR), ...scope }));
    // Each harness converges onto its own pinned selection — reconcile never re-prompts and never
    // lends one harness's servers to another.
    const recorded = recordedMcpSelections({ registry, lock, ledger, targets, manifestServers });
    const lifecycleView = registryLifecycleView({ registry, repoRoot: REPO_ROOT, scope, dirs, targets,
      mcpSelections: recorded.selections, mcpAdoptable: recorded.adoptable, retainedMcpIds: [], force: true });
    if (!lifecycleView.plan.safe) { assertSafeRegistryPlan(lifecycleView); return; }

    const report = reconcileReport(lifecycleView);
    printReconcileReport(report, lock, formatRetiredPlans(lifecycleView.plan.retiredHarnesses ?? []));
    if (o.json) console.log(JSON.stringify({ scope: lock.scope, sourceVersion: lock.sourceVersion, targets, unpinned, ...report }, null, 2));
    if (o.dryRun) {
      console.log('[DRY] Reconcile plan complete — no changes written');
      if (!report.clean) process.exitCode = 1; // CI-friendly: drifted check must fail loudly.
      return;
    }
    if (report.clean) {
      // Converged already; an entry the plan finds DoFlow's without writing it still needs its row.
      const owned = recordMcpOwnership({ plan: lifecycleView.plan, registry: lifecycleView.registry, adapters: lifecycleView.adapters,
        stateRoot: lifecycleView.stateRoot, ledger: lifecycleView.ledger });
      printRecordedMcpOwnership(owned.recorded);
      return;
    }

    if (!confirm(`Reconcile ${targets.join(', ')} by applying ${report.drifts.length} change(s)?`, o.force)) {
      console.error('[INFO]  Aborted.');
      process.exit(1);
    }
    checkpointRunLock(hold);
    // A run that changes a retired harness's rows backs the retirement up first, as install and
    // update do, so `doflow rollback` restores it (row 127 FR-4). Any other reconcile takes none.
    let bid = '';
    const retiring = retiredReleaseKeys(lifecycleView.plan.retiredHarnesses ?? []).size > 0;
    if (retiring && o.noBackup) {
      console.error('[WARN]  Skipping backup (--no-backup)');
    } else if (retiring) {
      const commit = sourceCommit(SCRIPT_DIR);
      bid = reportBackup(backupStep(() => createFileBackup({ operation: 'reconcile', set: retirementBackupSet(lifecycleView, lifecyclePaths, scope),
        backupRoot: lifecyclePaths.backupRoot, repoRoot: SCRIPT_DIR, sourceCommit: commit, version: pkg.version, date: new Date() })));
    }
    applyLifecycle({ plan: lifecycleView.plan, registry: lifecycleView.registry,
      adapters: buildAdapterRegistry(),
      stateRoot: lifecycleView.stateRoot, ledger: lifecycleView.ledger });
    writeManifest({ scopeRoot: lifecyclePaths.scopeRoot, scriptVersion: pkg.version, operation: 'update', repoRoot: SCRIPT_DIR, sourceCommit: sourceCommit(SCRIPT_DIR), backupId: bid, tools: targets, date: new Date() });
    if (bid) applyBackupRetention({ backupRoot: lifecyclePaths.backupRoot, prune: o.prune, keep: o.prune ?? DEFAULT_BACKUP_RETENTION, bid });
    console.log('[OK] Reconciliation complete — state converged onto doflow.lock.');
  } finally {
    hold?.release();
  }
}

module.exports = cmdReconcile;
