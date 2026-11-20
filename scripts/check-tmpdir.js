'use strict';

// `pretest` guard: refuses to start the suite when the OS temp directory, or any ancestor of it, holds a
// `.doflow` folder. Tests build their projects under the temp directory and the runtime finds a project by
// walking up to the nearest `.doflow`, so a stray one there captures every test project's state.
// Exit 0 clean; exit 1 with one line naming the offending path.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** The `.doflow` path found at `tmp` or the nearest ancestor of it, or null when none exists. */
function findDoflowFolder(tmp) {
  let dir = path.resolve(tmp);
  for (;;) {
    const candidate = path.join(dir, '.doflow');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `{ ok, line }`: `line` is the one refusal line when a `.doflow` folder is found. */
function checkTmpdir(tmp = os.tmpdir()) {
  const found = findDoflowFolder(tmp);
  if (!found) return { ok: true, line: '' };
  return { ok: false, line: `npm test refused: ${found} exists at or above the temp directory ${path.resolve(tmp)}; remove it and run again` };
}

if (require.main === module) {
  const result = checkTmpdir();
  if (!result.ok) {
    process.stderr.write(`${result.line}\n`);
    process.exit(1);
  }
}

module.exports = { findDoflowFolder, checkTmpdir };
