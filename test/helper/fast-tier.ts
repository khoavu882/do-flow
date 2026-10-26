'use strict';

// `npm run test:fast`: the unit and guard tier of the suite, for day-to-day feature work. `npm test`
// stays the full gate and runs every file this tier runs.
//
// The tier is computed from the files, so it has no list to keep current:
//   - every file under test/guards/ runs (the structural guards are cheap and must never be skipped);
//   - test/e2e/ and test/bench/ never run (they drive the installed CLI or the paid-model harness);
//   - any other file runs unless its text starts a child process (child_process, process.execPath,
//     bin/doflow), the one cost that makes a test slow enough to leave out of the inner loop.
// Extra arguments go to `node --test`, e.g. `npm run test:fast -- --test-reporter=spec`.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const ALWAYS = 'test/guards/';
const NEVER = ['test/e2e/', 'test/bench/'];
const SPAWNS = /child_process|process\.execPath|bin\/doflow/;

function testFiles(dir: string = path.join(REPO, 'test')): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'fixtures') out.push(...testFiles(full));
    } else if (entry.name.endsWith('.test.ts')) {
      out.push(path.relative(REPO, full).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

/** The repo-relative test files the fast tier runs. */
function fastFiles(files: string[] = testFiles()): string[] {
  return files.filter((rel) => {
    if (rel.startsWith(ALWAYS)) return true;
    if (NEVER.some((prefix) => rel.startsWith(prefix))) return false;
    return !SPAWNS.test(fs.readFileSync(path.join(REPO, rel), 'utf8'));
  });
}

if (require.main === module) {
  const files = fastFiles();
  const run = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: REPO, stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

module.exports = { fastFiles, testFiles };
