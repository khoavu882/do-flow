'use strict';
// `doflow list-backups` — the backup table for this scope. Takes no project-path positional
// (rollback's one positional slot is the backup id); scope is -g/--global vs cwd-rooted project.
const path = require('node:path');
const { toolDirs } = require('../../install/targets');
const { listBackups } = require('../../install/backup');
const { printBackupTable } = require('../shared');

function cmdListBackups(o) {
  // rollback/list-backups don't take a project-path positional (their one positional slot is the
  // backup id for rollback) — scope is -g/--global vs default project rooted at cwd.
  const dirs = toolDirs({ global: o.global, projectRoot: '.' });
  const backupRoot = path.join(dirs.claude, 'backups');
  printBackupTable(listBackups(backupRoot), backupRoot);
}

module.exports = cmdListBackups;
