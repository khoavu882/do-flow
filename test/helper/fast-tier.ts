'use strict';

// `npm run test:fast`: the unit and guard tier of the suite, for day-to-day feature work. `npm test`
// stays the full gate and runs every file this tier runs.
//
// The tier is computed from the files, so it has no list to keep current:
//   - every file under test/guards/ runs (the structural guards are cheap and must never be skipped);
//   - test/e2e/ and test/bench/ never run (they drive the installed CLI or the paid-model harness);
//   - any other file runs unless it, or a test helper it requires (followed through test/ only), starts
//     a child process (requires child_process or names process.execPath): the one cost that makes a test
//     slow enough to leave out of the inner loop.
// Extra arguments go to `node --test`, e.g. `npm run test:fast -- --test-reporter=spec`.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const ALWAYS = 'test/guards/';
const NEVER = ['test/e2e/', 'test/bench/'];
const SPAWNS = /require\(\s*['"](?:node:)?child_process['"]\s*\)|process\.execPath/;

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

const TEST_ROOT = path.join(REPO, 'test') + path.sep;
const REQUIRE = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

/** Whether `file`, or a file under test/ it requires (transitively), starts a child process. */
function spawns(file: string, seen: Set<string> = new Set()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  const text = fs.readFileSync(file, 'utf8');
  if (SPAWNS.test(text)) return true;
  for (const [, spec] of text.matchAll(REQUIRE)) {
    const target = path.resolve(path.dirname(file), spec);
    if (target.startsWith(TEST_ROOT) && fs.existsSync(target) && spawns(target, seen)) return true;
  }
  return false;
}

/** The repo-relative test files the fast tier runs. */
function fastFiles(files: string[] = testFiles()): string[] {
  return files.filter((rel) => {
    if (rel.startsWith(ALWAYS)) return true;
    if (NEVER.some((prefix) => rel.startsWith(prefix))) return false;
    return !spawns(path.join(REPO, rel));
  });
}

if (require.main === module) {
  const files = fastFiles();
  const run = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: REPO, stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

module.exports = { fastFiles, testFiles };
