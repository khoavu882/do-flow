'use strict';
// `doflow rollback` — restore from a backup (interactive pick when the id is omitted). Always
// takes a pre-rollback safety snapshot first, regardless of --no-backup.
const path = require('node:path');
const { resolveTargets, toolDirs } = require('../../install/targets');
const { resolveContext, printContext } = require('../../install/context');
const { createBackup, restoreBackup, listBackups } = require('../../install/backup');
const { writeManifest } = require('../../install/manifest');
const { confirm, promptLine } = require('../../helper/prompt');
const { sourceCommit } = require('../../helper/git');
const { REPO_ROOT, SCRIPT_DIR, pkg, printBackupTable } = require('../shared');

function cmdRollback(o) {
  const targets = resolveTargets(o.targets);
  const dirs = toolDirs({ global: o.global, projectRoot: '.' });
  const backupRoot = path.join(dirs.claude, 'backups');
  const commit = sourceCommit(SCRIPT_DIR);
  printContext(resolveContext({ repoRoot: REPO_ROOT, targets, dirs, sourceCommit: commit, global: o.global, projectRoot: '.' }));

  let bid = o.positional[0] || '';
  if (!bid) {
    printBackupTable(listBackups(backupRoot), backupRoot);
    bid = promptLine('Enter backup ID to restore (or press Enter to cancel): ');
    if (!bid) { console.error('[INFO]  Aborted.'); process.exit(1); }
  }

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

  // sync.sh always takes a pre-rollback safety snapshot, regardless of --no-backup — rollback is
  // destructive enough that skipping this specific backup isn't offered.
  console.error('[INFO]  Creating pre-rollback safety snapshot...');
  createBackup({ operation: 'pre-rollback', tools: targets, dirs, backupRoot, repoRoot: SCRIPT_DIR, sourceCommit: commit, date: new Date(), dryRun: o.dryRun });

  // Restore only the tools the snapshot just covered — restoring a tool the safety snapshot
  // didn't include would leave that tool's overwrite with no way back.
  const targetDirs = Object.fromEntries(targets.map((t) => [t, dirs[t]]));
  try {
    restoreBackup({ bid, backupRoot, dirs: targetDirs, dryRun: o.dryRun });
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    console.error('[ERROR] Use --list-backups to see available backups');
    process.exit(1);
  }

  writeManifest({ claudeDir: dirs.claude, scriptVersion: pkg.version, operation: 'rollback', repoRoot: SCRIPT_DIR, sourceCommit: commit, backupId: bid, tools: targets, date: new Date(), dryRun: o.dryRun });

  console.log(o.dryRun ? '[DRY] Dry run complete' : `[OK] Rollback to '${bid}' complete!`);
}

module.exports = cmdRollback;
