'use strict';

const path = require('node:path');

const DOFLOW_DIR_NAME = '.doflow';
const BACKUP_DIR_NAME = 'backups';
const INSTALL_MANIFEST_FILE_NAME = '.install-manifest.json';

/** Resolve DoFlow-owned lifecycle metadata without anchoring it to a harness directory. */
function doflowPaths({ scopeRoot }) {
  if (typeof scopeRoot !== 'string' || !scopeRoot) throw new Error('scopeRoot is required');
  const root = path.resolve(scopeRoot);
  const doflowRoot = path.join(root, DOFLOW_DIR_NAME);
  return {
    scopeRoot: root,
    doflowRoot,
    backupRoot: path.join(doflowRoot, BACKUP_DIR_NAME),
    manifestPath: path.join(doflowRoot, INSTALL_MANIFEST_FILE_NAME),
  };
}

module.exports = {
  DOFLOW_DIR_NAME,
  BACKUP_DIR_NAME,
  INSTALL_MANIFEST_FILE_NAME,
  doflowPaths,
};
