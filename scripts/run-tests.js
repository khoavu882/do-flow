'use strict';

// Scoped test discovery + runner. `npm test` must execute exactly the *.test.js files under
// test/ — nothing more (a captured artifact under bench/runs/ must never execute in the default
// suite) and nothing less. A shell glob cannot express that portably: cmd.exe and pwsh do not
// expand globs, and Node's built-in glob support in --test arrived after the 18/20 lines this
// package still supports. So discovery lives here, and the found files are handed to
// `node --test` in chunks small enough for Windows' command-line length limit.

const { readdirSync, statSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEST_ROOT = path.join(__dirname, '..', 'test');
const CHUNK = 120; // files per invocation; ~120 paths stay far below every platform's argv cap

function collectTestFiles(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

const files = collectTestFiles(TEST_ROOT);
if (!files.length) {
  console.error('run-tests: no *.test.js files found under test/');
  process.exit(1);
}

let failed = 0;
for (let i = 0; i < files.length; i += CHUNK) {
  const chunk = files.slice(i, i + CHUNK);
  // stdio inherits so the default TAP/spec output streams live, exactly like `node --test`.
  const result = spawnSync(process.execPath, ['--test', ...chunk], { stdio: 'inherit' });
  if (result.status !== 0) failed += 1;
}

process.exit(failed ? 1 : 0);
