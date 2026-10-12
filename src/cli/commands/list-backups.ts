'use strict';
// `doflow list-backups` — the backup table for this scope. Takes no project-path positional
// (rollback's one positional slot is the backup id); scope is -g/--global vs cwd-rooted project.
// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.
const { listBackups } = require('../../install/backup.ts');
const { installPaths, printBackupTable } = require('../shared.ts');

function cmdListBackups(o: any): void {
  // rollback/list-backups don't take a project-path positional (their one positional slot is the
  // backup id for rollback) — scope is -g/--global vs default project rooted at cwd.
  const scope = { global: o.global, projectRoot: '.' };
  const lifecyclePaths = installPaths(scope);
  const rows = listBackups(lifecyclePaths.backupRoot);
  // listBackups now reads the canonical root AND the legacy pre-.doflow one, so the footer must name
  // the roots the rows actually came from: reporting restore points as living in a directory that
  // does not exist on this machine sends a user looking for recovery material to the wrong place.
  const roots = [...new Set(rows.map((r: any) => r.backupRoot))];
  printBackupTable(rows, roots.length ? roots.join(', ') : lifecyclePaths.backupRoot);
}

module.exports = cmdListBackups;
