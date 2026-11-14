'use strict';

// Run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');

/**
 * Writes `content` to `file` through `<file>.<pid>.tmp` in the same folder and a rename, so a reader
 * sees the old file or the new one. The folder is created when missing. The temp name is the one the
 * storage engine's stale-temp sweep knows (`<name>.json.<pid>.tmp`). A failure removes the temp file
 * and rethrows the original error.
 *
 * `beforeRename` runs after the temp file is written and before the rename; throwing from it keeps
 * the old file (a lock check, or a compare against what the content was built from).
 */
function writeFileAtomic(file: string, content: string, { fsImpl = fs, beforeRename }: { fsImpl?: any; beforeRename?: () => void } = {}): void {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, content, 'utf8');
    if (beforeRename) beforeRename();
    fsImpl.renameSync(tmp, file);
  } catch (error) {
    try { fsImpl.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw error;
  }
}

module.exports = { writeFileAtomic };
