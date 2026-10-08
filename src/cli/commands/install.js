'use strict';
// `doflow install` — plan the full lifecycle across the requested targets, back up, apply, and
// pin what was chosen in doflow.lock. Supports --dry-run previews and MCP selection.
const os = require('node:os');
const path = require('node:path');
const { resolveTargets, toolDirs } = require('../../install/targets');
const { resolveContext, printContext } = require('../../install/context');
const {
  BackupError, DEFAULT_BACKUP_RETENTION, createFileBackup, applyRetention, formatBytes, retentionNote,
} = require('../../install/backup');
const { backupSetFromPlan } = require('../../install/backup-set');
const { writeManifest, readInstallManifest } = require('../../install/manifest');
const { confirm } = require('../../helper/prompt');
const { sourceCommit } = require('../../helper/git');
const { chmodHooksExecutable } = require('../../helper/settings-scope');
const { promptMcpCheckbox, resolveMcpSelections } = require('../../install/mcp');
const { loadRegistry } = require('../../registry');
const { applyLifecycle, applyMcpIndex, recordMcpOwnership } = require('../../lifecycle');
const {
  codexScope, registryLifecycleView, printRegistryLifecycle, printPlanNotices, assertSafeRegistryPlan,
  lockDocument, recordLock,
} = require('../../lifecycle/view');
const {
  REPO_ROOT, SCRIPT_DIR, pkg, scopeOf, installPaths, reportRetiredMcp, scopeSelectionState, printMcpSelection, plannedMcpSelections,
  printRecordedMcpOwnership, buildAdapterRegistry, refuseHomeRootedProject, holdRunLock, checkpointRunLock,
} = require('../shared');

function cmdInstall(o) {
  refuseHomeRootedProject(o, 'install');
  const targets = resolveTargets(o.targets);
  const scope = scopeOf(o);
  const hold = holdRunLock(o, scope, 'install');
  try {
    const dirs = toolDirs(scope);
    const lifecyclePaths = installPaths(scope);
    const backupRoot = lifecyclePaths.backupRoot;
    // Resolved once per invocation and threaded into resolveContext/createFileBackup/writeManifest below
    // — those three used to each spawn their own `git rev-parse` for the identical value.
    const commit = sourceCommit(SCRIPT_DIR);

    printContext(resolveContext({ repoRoot: REPO_ROOT, targets, dirs, sourceCommit: commit, ...scope }));

    const registry = loadRegistry({ repoRoot: REPO_ROOT });
    const existingManifest = readInstallManifest({ scopeRoot: lifecyclePaths.scopeRoot });
    const { lock, ledger } = scopeSelectionState(scope);
    // Each MCP-capable target gets its own selection; a real terminal is asked once for all of them.
    const selection = resolveMcpSelections({
      cmd: 'install', requested: o.mcp, targets, registry, lock, ledger, manifestServers: existingManifest?.mcpServers ?? null,
      interactive: !o.dryRun && !o.force && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY),
      promptFn: promptMcpCheckbox, onStale: reportRetiredMcp,
    });
    // One lifecycle view across every requested target — computed unconditionally (not only under
    // --dry-run) so its safety gate and its plan are the exact same object the real apply below uses.
    const lifecycleView = registryLifecycleView({ registry, repoRoot: REPO_ROOT, scope, dirs, targets,
      mcpSelections: selection.selections, mcpAdoptable: selection.adoptable, retainedMcpIds: selection.retainedMcpIds,
      force: o.force, adopt: o.adopt === true, permissions: o.permissions === true, statusline: o.statusline === true });
    if (!lifecycleView.plan.safe) { assertSafeRegistryPlan(lifecycleView); return; }

    printMcpSelection(lifecycleView, selection.sources, { requested: o.mcp, prefix: o.dryRun ? '[DRY]' : '[INFO]' });
    // Safe-by-default surfaced, not silent: a first-ever non-interactive install selects zero MCP
    // servers. Anyone scripting installs must opt in explicitly; interactive users never see this
    // because the checkbox is the discovery path.
    if (!o.mcp && !o.dryRun && !process.stdin.isTTY && Object.values(selection.sources).includes('default')) {
      console.log('[INFO] MCP: none selected by default in non-interactive mode — pass --mcp all or --mcp <names> to include servers.');
    }

    // The files this run's apply can overwrite or delete; DoFlow's own records are never among them.
    const buildBackupSet = () => backupSetFromPlan({
      plan: lifecycleView.plan, scope: scope.global ? 'global' : 'project', scopeRoot: lifecyclePaths.scopeRoot,
      exclude: [backupRoot, lifecycleView.stateRoot, lifecyclePaths.manifestPath, path.join(lifecyclePaths.doflowRoot, 'doflow.lock')],
    });
    const keep = o.prune ?? DEFAULT_BACKUP_RETENTION;

    if (o.dryRun) {
      console.log(`[INFO] Install targets: ${targets.join(' ')}`);
      printRegistryLifecycle(lifecycleView, '[DRY]');
      const set = o.noBackup ? null : backupStep(buildBackupSet);
      if (set) printBackupDryRun(set, `${backupRoot}/install_<timestamp>`);
      const retention = applyRetention({ backupRoot, keep, dryRun: true, reserve: set?.count ? 1 : 0 });
      console.log(`[DRY]  Backups: would keep ${retention.kept}, would remove ${retention.wouldRemove.length} (${retentionNote(o.prune, keep)})`);
      console.log(`[DRY]  Would write manifest: ${lifecyclePaths.manifestPath}`);
      console.log('[DRY] Dry run complete — no changes written');
      return;
    }

    if (!confirm(`Install configs to: ${targets.join(' ')}?`, o.force)) {
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
      const backup = backupStep(() => createFileBackup({ operation: 'install', set: buildBackupSet(), backupRoot, repoRoot: SCRIPT_DIR,
        sourceCommit: commit, version: pkg.version, date: new Date() }));
      bid = reportBackup(backup);
    } else {
      console.error('[WARN]  Skipping backup (--no-backup)');
    }

    // The ledger the lock is pinned against: the one this run leaves.
    let ledgerAfter = lifecycleView.ledger;
    if (lifecycleView.plan.changes.length) {
      const result = applyLifecycle({ plan: lifecycleView.plan, registry: lifecycleView.registry,
        adapters: buildAdapterRegistry(),
        stateRoot: lifecycleView.stateRoot, ledger: lifecycleView.ledger });
      for (const target of lifecycleView.plan.targets) {
        if (target.skipped || !target.changes.length) continue;
        const owned = result.ledger.resources.filter((resource) => resource.harness === target.harness).length;
        console.log(`[INFO] ${target.harness}: lifecycle verified (${owned} owned resource(s))`);
      }
      ledgerAfter = result.ledger;
    } else {
      // MCP_INDEX.md is generated, not a tracked resource, so it never appears in plan.changes and
      // applyLifecycle — which owns the only call that writes it — is skipped entirely when nothing
      // else changed. Without this branch the index is rewritten only as a side effect of some
      // unrelated asset changing, so a change to the renderer, to a server's `doc`/`shortFlag`, or
      // to the resolved selection silently does nothing whenever the rest of the tree is current.
      applyMcpIndex({ scopeRoot: lifecycleView.plan.scopeRoot, selectedMcp: lifecycleView.plan.mcp, mode: 'apply' });
      const owned = recordMcpOwnership({ plan: lifecycleView.plan, registry: lifecycleView.registry, adapters: lifecycleView.adapters,
        stateRoot: lifecycleView.stateRoot, ledger: lifecycleView.ledger });
      printRecordedMcpOwnership(owned.recorded);
      ledgerAfter = owned.ledger;
    }
    printPlanNotices(lifecycleView);

    if (targets.includes('claude')) {
      // A npm-packaged tarball does not reliably preserve the executable bit on arbitrary files
      // (unlike git checkouts, which usually do) — copy-tree's mode-preserving copy only carries
      // over whatever bit the source file actually has on this machine, so this runs after
      // applyLifecycle (once the hook scripts are actually on disk) as a final, unconditional +x.
      chmodHooksExecutable(dirs.claude);
    }

    writeManifest({ scopeRoot: lifecyclePaths.scopeRoot, scriptVersion: pkg.version, operation: 'install', repoRoot: SCRIPT_DIR, sourceCommit: commit, backupId: bid, tools: targets, date: new Date() });

    // Pin what this install CHOSE, beside what earlier runs pinned. The ledger owns ownership; the
    // lock owns selection — together they make the next update's delta a reviewable fact instead of a
    // surprise.
    const lockResult = recordLock(
      scope.global ? { scope: 'global', homeDir: os.homedir() } : { scope: 'project', projectRoot: path.resolve(scope.projectRoot) },
      lockDocument({
        registry, scope: codexScope(scope), scopeRoot: scope.global ? os.homedir() : path.resolve(scope.projectRoot),
        previous: lock, ledger: ledgerAfter, plannedTargets: targets, mcpSelections: plannedMcpSelections(lifecycleView),
      }),
    );
    console.log(`[INFO] doflow.lock: ${lockResult.summary}`);

    applyBackupRetention({ backupRoot, prune: o.prune, keep, bid });

    console.log('[OK] Installation complete!');
  } finally {
    hold?.release();
  }
}

/** Run a backup step; a BackupError stops the command before anything is changed. */
function backupStep(step) {
  try {
    return step();
  } catch (error) {
    if (!(error instanceof BackupError)) throw error;
    console.error(`[ERROR] Backup failed, nothing was changed: ${error.message}`);
    process.exit(1);
  }
}

/** Print what a backup step wrote and return its id ('' when there was nothing to back up). */
function reportBackup(backup) {
  if (!backup) {
    console.error('[INFO]  Backup: nothing to back up (no file changes)');
    return '';
  }
  console.error(`[INFO]  Backup created: ${backup.id} (${backup.files} file(s), ${formatBytes(backup.bytes)}; ${backup.absent} not present before the run)`);
  return backup.id;
}

/** The dry-run backup lines for a set the real run would back up. */
function printBackupDryRun(set, destination) {
  if (set.count === 0) {
    console.log('[DRY]  Backup: nothing to back up (no file changes)');
  } else {
    console.log(`[DRY]  Would back up ${set.count} file(s), ${formatBytes(set.bytes)} (${set.bytes} bytes; ${set.absent} not present yet) to ${destination}`);
  }
  const mcpOnly = set.excluded.filter((item) => item.reason === 'mcp-entries-only').length;
  if (mcpOnly > 0) console.log(`[DRY]  Not backed up: ${mcpOnly} file(s) holding only MCP entries`);
}

/** Keep the newest backups after a run that changed files; never changes the exit code. */
function applyBackupRetention({ backupRoot, prune, keep, bid }) {
  let retention;
  try {
    retention = applyRetention({ backupRoot, keep, protect: bid ? [bid] : [] });
  } catch (error) {
    console.error(`[WARN]  Backups: could not apply retention: ${error.message}`);
    return;
  }
  for (const failure of retention.failed) console.error(`[WARN]  Backups: could not remove ${failure.id}: ${failure.error}`);
  console.error(`[INFO]  Backups: kept ${retention.kept}, removed ${retention.removed.length} (${retentionNote(prune, keep)})`);
}

module.exports = cmdInstall;
module.exports.backupStep = backupStep;
module.exports.reportBackup = reportBackup;
module.exports.printBackupDryRun = printBackupDryRun;
module.exports.applyBackupRetention = applyBackupRetention;
