'use strict';
// `doflow update` — incremental refresh: diff the pinned/selected state against what is on disk
// and apply only what changed. Never re-prompts for MCP (reuses each harness's recorded selection).
const os = require('node:os');
const path = require('node:path');
const { resolveTargets, toolDirs } = require('../../install/targets');
const { resolveContext, printContext } = require('../../install/context');
const { DEFAULT_BACKUP_RETENTION, createFileBackup, applyRetention, retentionNote } = require('../../install/backup');
const { backupSetFromPlan } = require('../../install/backup-set');
const { backupStep, reportBackup, printBackupDryRun, applyBackupRetention } = require('./install');
const { writeManifest, readInstallManifest } = require('../../install/manifest');
const { confirm } = require('../../helper/prompt');
const { sourceCommit } = require('../../helper/git');
const { chmodHooksExecutable } = require('../../helper/settings-scope');
const { resolveMcpSelections } = require('../../install/mcp');
const { loadRegistry } = require('../../registry');
const { applyLifecycle, recordMcpOwnership } = require('../../lifecycle');
const {
  codexScope, registryLifecycleView, printRegistryLifecycle, printPlanNotices, assertSafeRegistryPlan,
  lockDocument, lockDelta, recordLock,
} = require('../../lifecycle/view');
const {
  REPO_ROOT, SCRIPT_DIR, pkg, scopeOf, installPaths, reportRetiredMcp, scopeSelectionState, printMcpSelection, plannedMcpSelections,
  printRecordedMcpOwnership, buildAdapterRegistry, holdRunLock, checkpointRunLock,
} = require('../shared');

function cmdUpdate(o) {
  // The refusal of a project run rooted at the home directory belongs here: before the run lock and any output.
  const targets = resolveTargets(o.targets);
  const scope = scopeOf(o);
  const hold = holdRunLock(o, scope, 'update');
  try {
    const dirs = toolDirs(scope);
    const lifecyclePaths = installPaths(scope);
    const backupRoot = lifecyclePaths.backupRoot;
    const commit = sourceCommit(SCRIPT_DIR);
    printContext(resolveContext({ repoRoot: REPO_ROOT, targets, dirs, sourceCommit: commit, ...scope }));

    // Never interactive: update reuses each harness's recorded selection, or applies an explicit --mcp
    // override, without re-prompting.
    const registry = loadRegistry({ repoRoot: REPO_ROOT });
    const existingManifest = readInstallManifest({ scopeRoot: lifecyclePaths.scopeRoot });
    const { lock, ledger } = scopeSelectionState(scope);
    const selection = resolveMcpSelections({
      cmd: 'update', requested: o.mcp, targets, registry, lock, ledger, manifestServers: existingManifest?.mcpServers ?? null,
      interactive: false, onStale: reportRetiredMcp,
    });
    // One lifecycle view across every requested target — computed unconditionally (not only under
    // --dry-run) so its safety gate and its plan are the exact same object the real apply below uses.
    const lifecycleView = registryLifecycleView({ registry, repoRoot: REPO_ROOT, scope, dirs, targets,
      mcpSelections: selection.selections, mcpAdoptable: selection.adoptable, retainedMcpIds: selection.retainedMcpIds,
      force: o.force, permissions: o.permissions === true, statusline: o.statusline === true });
    if (!lifecycleView.plan.safe) { assertSafeRegistryPlan(lifecycleView); return; }
    printMcpSelection(lifecycleView, selection.sources, { requested: o.mcp, prefix: o.dryRun ? '[DRY]' : '[INFO]' });
    const lifecycleChanged = Boolean(lifecycleView.plan.changes.length);
    // A file whose every change is an MCP entry stays out of the backup (backup-set.js says why), so an
    // update that changes only MCP entries backs up nothing.
    const buildBackupSet = () => backupSetFromPlan({
      plan: lifecycleView.plan, scope: scope.global ? 'global' : 'project', scopeRoot: lifecyclePaths.scopeRoot,
      exclude: [backupRoot, lifecycleView.stateRoot, lifecyclePaths.manifestPath, path.join(lifecyclePaths.doflowRoot, 'doflow.lock')],
    });
    const keep = o.prune ?? DEFAULT_BACKUP_RETENTION;

    const lockArgs = scope.global ? { scope: 'global', homeDir: os.homedir() } : { scope: 'project', projectRoot: path.resolve(scope.projectRoot) };
    const nextLock = (ledgerAfter) => lockDocument({
      registry, scope: codexScope(scope), scopeRoot: scope.global ? os.homedir() : path.resolve(scope.projectRoot),
      previous: lock, ledger: ledgerAfter, plannedTargets: targets, mcpSelections: plannedMcpSelections(lifecycleView),
    });

    if (!lifecycleChanged) {
      printPlanNotices(lifecycleView);
      // Nothing native to change can still leave something to record: MCP entries this run finds
      // DoFlow's without writing them, and selections 1.18.0 never wrote. The ledger and the lock alone
      // are written, with no confirm, backup or manifest write, because no installed file changes.
      const owned = recordMcpOwnership({ plan: lifecycleView.plan, registry: lifecycleView.registry, adapters: lifecycleView.adapters,
        stateRoot: lifecycleView.stateRoot, ledger: lifecycleView.ledger, dryRun: o.dryRun });
      printRecordedMcpOwnership(owned.recorded, { dryRun: o.dryRun });
      const pinned = nextLock(owned.ledger);
      const delta = lockDelta(lock, pinned);
      if (!delta.changed) {
        console.log(Object.keys(owned.recorded).length && !o.dryRun
          ? '[OK] Already up to date: no native changes; MCP ownership recorded in the ledger'
          : '[OK] Already up to date — no changes detected');
      } else if (o.dryRun) {
        console.log(`[DRY]  Would update doflow.lock: ${delta.summary}`);
      } else {
        recordLock(lockArgs, pinned);
        console.log(`[INFO] doflow.lock: ${delta.summary}`);
        console.log('[OK] Already up to date: no native changes; selections recorded in doflow.lock');
      }
      return;
    }

    console.log(`[INFO] Found ${lifecycleView.plan.changes.length} native change(s)`);

    if (o.dryRun) {
      printRegistryLifecycle(lifecycleView, '[DRY]');
      const set = o.noBackup ? null : backupStep(buildBackupSet);
      if (set) printBackupDryRun(set, `${backupRoot}/update_<timestamp>`);
      const retention = applyRetention({ backupRoot, keep, dryRun: true, reserve: set?.count ? 1 : 0 });
      console.log(`[DRY]  Backups: would keep ${retention.kept}, would remove ${retention.wouldRemove.length} (${retentionNote(o.prune, keep)})`);
      console.log(`[DRY]  Would write manifest: ${lifecyclePaths.manifestPath}`);
      console.log('[DRY] Dry run complete');
      return;
    }

    if (!confirm(`Update native resources in: ${targets.join(' ')}?`, o.force)) {
      // Exit 1, not 0: a declined prompt is a decision, and it must not share an exit code with a
      // completed run. With no stdin the prompt auto-declines, so `doflow install <path>` in a script
      // or CI step printed "Aborted.", wrote zero files, and reported success. It also silently
      // corrupted a set of install-timing measurements during the D.4 sweep, which is how it surfaced.
      console.error('[INFO]  Aborted.');
      process.exit(1);
    }
    checkpointRunLock(hold);

    let bid = '';
    if (!o.noBackup) {
      const backup = backupStep(() => createFileBackup({ operation: 'update', set: buildBackupSet(), backupRoot, repoRoot: SCRIPT_DIR,
        sourceCommit: commit, version: pkg.version, date: new Date() }));
      bid = reportBackup(backup);
    } else {
      console.error('[WARN]  Skipping backup (--no-backup)');
    }

    const result = applyLifecycle({ plan: lifecycleView.plan, registry: lifecycleView.registry,
      adapters: buildAdapterRegistry(),
      stateRoot: lifecycleView.stateRoot, ledger: lifecycleView.ledger });
    for (const target of lifecycleView.plan.targets) {
      if (target.skipped || !target.changes.length) continue;
      const owned = result.ledger.resources.filter((resource) => resource.harness === target.harness).length;
      console.log(`[INFO] ${target.harness}: lifecycle verified (${owned} owned resource(s))`);
    }
    printPlanNotices(lifecycleView);
    if (targets.includes('claude')) chmodHooksExecutable(dirs.claude);

    writeManifest({ scopeRoot: lifecyclePaths.scopeRoot, scriptVersion: pkg.version, operation: 'update', repoRoot: SCRIPT_DIR, sourceCommit: commit, backupId: bid, tools: targets, date: new Date() });

    const updateLock = recordLock(lockArgs, nextLock(result.ledger));
    console.log(`[INFO] doflow.lock: ${updateLock.summary}`);

    applyBackupRetention({ backupRoot, prune: o.prune, keep, bid });

    console.log('[OK] Update complete!');
  } finally {
    hold?.release();
  }
}

module.exports = cmdUpdate;
