'use strict';
// `doflow rollback` — restore from a backup (interactive pick when the id is omitted). Works out the
// whole restore first, then snapshots exactly the files it will overwrite (regardless of
// --no-backup), then restores. A per-file backup restores every file it holds unless --target
// narrows it; a backup from an earlier DoFlow restores per tool, as it always did.
const path = require('node:path');
const { resolveTargets, toolDirs } = require('../../install/targets');
const { resolveContext, printContext } = require('../../install/context');
const {
  BackupError, createFileBackup, planRestore, executeRestore, listBackups, formatBytes,
} = require('../../install/backup');
const { backupSetFromPaths } = require('../../install/backup-set');
const { writeManifest } = require('../../install/manifest');
const { stateRoot } = require('../../state');
const { confirm, promptLine } = require('../../helper/prompt');
const { sourceCommit } = require('../../helper/git');
const { captureCaught } = require('../../runtime/cli-result');
const {
  REPO_ROOT, SCRIPT_DIR, pkg, installPaths, printBackupTable, holdRunLock, checkpointRunLock,
} = require('../shared');

const LISTED_ABSENT = 10;

function fail(error) {
  captureCaught(error, 'rollback', 1);
  console.error(`[ERROR] ${error.message}`);
  console.error('[ERROR] Use --list-backups to see available backups');
  process.exit(1);
}

function cmdRollback(o) {
  const targets = resolveTargets(o.targets);
  const dirs = toolDirs({ global: o.global, projectRoot: '.' });
  const scope = { global: o.global, projectRoot: '.' };
  const hold = holdRunLock(o, scope, 'rollback');
  try {
    const scopeName = o.global ? 'global' : 'project';
    const lifecyclePaths = installPaths(scope);
    const backupRoot = lifecyclePaths.backupRoot;
    const commit = sourceCommit(SCRIPT_DIR);
    const explicitTargets = o.targets.length > 0;

    let bid = o.positional[0] || '';
    if (!bid) {
      printBackupTable(listBackups(backupRoot), backupRoot);
      bid = promptLine('Enter backup ID to restore (or press Enter to cancel): ');
      if (!bid) { console.error('[INFO]  Aborted.'); process.exit(1); }
    }

    // Worked out before anything is written. Reads only, so a bad id fails here, before the prompt.
    let plan;
    try {
      plan = planRestore({ bid, backupRoot, scope: scopeName, scopeRoot: lifecyclePaths.scopeRoot, targets, explicitTargets, dirs });
    } catch (error) {
      fail(error);
    }
    // A per-file backup restores the harnesses it holds (only those in --target when given), so the
    // banner and the install manifest name those, not the default target.
    const restoredTools = plan.format === 2
      ? [...new Set(plan.restore.flatMap((item) => item.harnesses))].filter((h) => !explicitTargets || targets.includes(h)).sort()
      : targets;
    printContext(resolveContext({ repoRoot: REPO_ROOT, targets: restoredTools, dirs, sourceCommit: commit, global: o.global, projectRoot: '.' }));

    // PARITY-with-UX: install/update skip the confirm prompt entirely under --dry-run (nothing
    // destructive happens, so there's nothing to confirm) — rollback used to prompt regardless of
    // --dry-run, which meant a non-interactive `doflow rollback <id> --dry-run` (no --force) would
    // block on stdin instead of just previewing. Match install/update's convention here.
    if (!o.dryRun && !confirm(`Restore from '${bid}'? This overwrites your current config.`, o.force)) {
      // Exit 1, not 0: a declined prompt is a decision, and it must not share an exit code with a
      // completed run. With no stdin the prompt auto-declines, so `doflow install <path>` in a script
      // or CI step printed "Aborted.", wrote zero files, and reported success. It also silently
      // corrupted a set of install-timing measurements during the D.4 sweep, which is how it surfaced.
      console.error('[INFO]  Aborted.');
      process.exit(1);
    }
    checkpointRunLock(hold);

    if (plan.format === 1 && plan.type === 'full') {
      for (const { tool, dstDir } of plan.v1.tools) {
        console.error(`[INFO]  ${bid} is a whole-home archive from an earlier DoFlow; restoring ${tool}.tar.gz into ${dstDir}`);
      }
    }

    snapshotBeforeRestore({ o, plan, bid, backupRoot, lifecyclePaths, scopeName, commit });

    let result;
    try {
      result = executeRestore(plan, { backupRoot, dryRun: o.dryRun });
    } catch (error) {
      fail(error);
    }

    const writeRollbackManifest = () => writeManifest({ scopeRoot: lifecyclePaths.scopeRoot, scriptVersion: pkg.version, operation: 'rollback',
      repoRoot: SCRIPT_DIR, sourceCommit: commit, backupId: bid, tools: restoredTools, date: new Date(), dryRun: o.dryRun });
    if (result.legacy) {
      writeRollbackManifest();
      console.log(o.dryRun ? '[DRY] Dry run complete' : `[OK] Rollback to '${bid}' complete!`);
      return;
    }

    if (result.untargeted > 0) console.error(`[INFO]  Skipped ${result.untargeted} file(s) of harnesses not in --target`);
    const left = result.absent.length;
    if (left > 0) {
      console.error(`[INFO]  Left in place ${left} file(s) that did not exist when the backup was taken:`);
      for (const file of result.absent.slice(0, LISTED_ABSENT)) console.error(`        ${file}`);
      if (left > LISTED_ABSENT) {
        console.error(`        ... and ${left - LISTED_ABSENT} more (listed with "existed": false in ${path.join(plan.bkDir, '.manifest.json')})`);
      }
    }
    const problems = [...result.refused, ...result.failed];
    for (const problem of problems) console.error(`[ERROR] Could not restore ${problem.path}: ${problem.reason}`);
    const restored = result.restored.length;

    if (o.dryRun) {
      console.log(`[DRY]  Would restore ${restored} file(s), leave ${left} in place, could not restore ${problems.length}`);
      console.log('[DRY] Dry run complete');
      return;
    }
    if (problems.length > 0) {
      console.error(`[ERROR] Rollback to '${bid}' incomplete: restored ${restored}, could not restore ${problems.length}`);
      process.exit(1);
    }
    writeRollbackManifest();
    console.log(`[OK] Rollback to '${bid}' complete: restored ${restored} file(s)${left > 0 ? `, left ${left} in place` : ''}`);
  } finally {
    hold?.release();
  }
}

/** A backup of exactly the files the restore will overwrite, taken regardless of --no-backup:
 * rollback is destructive enough that skipping it is not offered. Skipped when the restore
 * overwrites nothing, so an empty snapshot never pushes a real restore point out of retention. */
function snapshotBeforeRestore({ o, plan, bid, backupRoot, lifecyclePaths, scopeName, commit }) {
  if (o.dryRun) {
    console.log(`[DRY]  Would snapshot ${plan.snapshot.length} file(s) before restoring`);
    return;
  }
  const nothing = '[INFO]  Pre-rollback snapshot: nothing to snapshot (the restore overwrites no file)';
  if (plan.snapshot.length === 0) {
    console.error(nothing);
    return;
  }
  console.error('[INFO]  Creating pre-rollback safety snapshot...');
  let snapshot;
  try {
    const set = backupSetFromPaths({
      items: plan.snapshot, scope: scopeName, scopeRoot: lifecyclePaths.scopeRoot,
      exclude: [backupRoot, stateRoot({ scope: scopeName, projectRoot: lifecyclePaths.scopeRoot, homeDir: lifecyclePaths.scopeRoot }),
        lifecyclePaths.manifestPath, path.join(lifecyclePaths.doflowRoot, 'doflow.lock')],
    });
    snapshot = createFileBackup({ operation: 'pre-rollback', set, backupRoot, repoRoot: SCRIPT_DIR, sourceCommit: commit,
      version: pkg.version, date: new Date(), restores: bid });
  } catch (error) {
    if (!(error instanceof BackupError)) throw error;
    console.error(`[ERROR] Pre-rollback snapshot failed, nothing was restored: ${error.message}`);
    process.exit(1);
  }
  if (!snapshot) {
    console.error(nothing);
    return;
  }
  console.error(`[INFO]  Pre-rollback snapshot: ${snapshot.id} (${snapshot.files} file(s), ${formatBytes(snapshot.bytes)})`);
}

module.exports = cmdRollback;
