'use strict';

// G27 — test temporary directories (feature 061, IC-022, FR-025).
//
// Every temporary folder a test creates goes through test/helper/tmp.js, whose tempDir() removes it
// when the test ends and whose suiteTempDir() removes it when the process exits. A test that calls
// the platform temp-dir functions itself leaves a folder behind whenever its own cleanup is missing
// or skipped by a failure, and those folders pile up in the OS temp root across runs. This guard
// scans every *.js file under test/ except the helper itself and test/fixtures/, and fails on each
// call it finds, naming <file>:<line>. A file whose subject is the temp folder itself is listed in
// EXEMPT with the reason; an EXEMPT entry that no longer matches any call fails too, so the list
// cannot outlive the reason it was written for.
//
// The searched names are assembled from parts below so this file does not match its own scan.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');

const TEST_ROOT = path.join(REPO, 'test');
const HELPER = 'test/helper/tmp.ts';
const FIXTURES = 'test/fixtures/';

const MK = 'mkd' + 'temp';
const TMP = 'tmp' + 'dir';
const CALLS: any = [`${MK}Sync(`, `${MK}(`, `${TMP}()`];

// path (repo-relative, forward slashes) -> reason. Built from the E.2 to E.6 migration reports.
const EXEMPT: any = new Map([
  ['test/install/home-scope.test.ts',
    "its subject is the OS temp folder's symlinked spelling versus its real path; it reads the platform temp folder and creates nothing"],
  ['test/hooks/bridge-hook-line.test.ts',
    'on win32 only, a self-removing folder at the drive root arranges the "no store above cwd" premise that the runner profile (which holds a .doflow store) breaks'],
  ['test/hooks/prompt-nudge-gates.test.ts',
    'on win32 only, a self-removing folder at the drive root arranges the "no .doflow above cwd" premise that the runner profile breaks'],
  ['test/helper/bash-locator.ts',
    'spawnWithFd3 on win32 places a one-shot side file for the child to open as fd 3 and unlinks it before returning; it is a file, not a folder, and cleans itself'],
  ['test/install/backup-manifest.test.ts',
    'the match is the text of a test name describing the shared temp folder the fix avoids; no call exists'],
]);

/** Every *.js or *.ts file under `root`, as repo-relative paths with forward slashes, sorted. */
function testFiles(root: any = TEST_ROOT) {
  const out: any = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.ts'))) {
        out.push(path.relative(REPO, full).split(path.sep).join('/'));
      }
    }
  }(root));
  return out.sort();
}

/** Whether a repo-relative test path is outside the scan. */
function skipped(rel: any) {
  return rel === HELPER || rel.startsWith(FIXTURES);
}

/** The temp-dir calls in one file's text: `[{ line, call }]`. Text is read as is, never as binary. */
function findCalls(text: any): any {
  const hits: any = [];
  text.split('\n').forEach((line: any, index: any) => {
    for (const call of CALLS) {
      if (line.includes(call)) {
        hits.push({ line: index + 1, call });
        break;
      }
    }
  });
  return hits;
}

/**
 * Scan `files` (a map of repo-relative path -> text) against `exempt`.
 * Returns `{ findings, staleExemptions }`: findings as `<file>:<line> <call>`, and exempt paths
 * that hold no call.
 */
function scan(files: any, exempt: any) {
  const findings: any = [];
  const matched: any = new Set();
  for (const [rel, text] of files) {
    if (skipped(rel)) continue;
    const hits = findCalls(text);
    if (hits.length === 0) continue;
    if (exempt.has(rel)) {
      matched.add(rel);
      continue;
    }
    for (const hit of hits) findings.push(`${rel}:${hit.line} ${hit.call}`);
  }
  const staleExemptions = [...exempt.keys()].filter((rel) => !matched.has(rel));
  return { findings, staleExemptions };
}

test('G27: no test creates a temporary directory outside test/helper/tmp.js', () => {
  const files: any = new Map(testFiles().map((rel: any) => [rel, fs.readFileSync(path.join(REPO, rel), 'utf8')]));
  assert.ok(files.size > 100, `expected the whole test tree, found ${files.size} files`);
  const { findings } = scan(files, EXEMPT);
  assert.deepEqual(findings, [],
    `temporary directories must come from test/helper/tmp.js (tempDir or suiteTempDir):\n${findings.join('\n')}`);
});

test('G27: every EXEMPT entry names an existing file that still holds a call', () => {
  for (const [rel, reason] of EXEMPT) {
    assert.ok(fs.existsSync(path.join(REPO, rel)), `EXEMPT names a missing file: ${rel}`);
    assert.ok(typeof reason === 'string' && reason.trim().length > 20, `EXEMPT ${rel} needs a real reason`);
  }
  const files: any = new Map([...EXEMPT.keys()].map((rel) => [rel, fs.readFileSync(path.join(REPO, rel), 'utf8')]));
  const { staleExemptions } = scan(files, EXEMPT);
  assert.deepEqual(staleExemptions, [], `EXEMPT entries with no remaining call: ${staleExemptions.join(', ')}`);
});

test('G27 self-test: a call fails with its file name and line; an exempt file passes; a stale exemption fails', () => {
  const offending = ['const fs = require("node:fs");', `const dir = fs.${MK}Sync("x-");`, ''].join('\n');
  const exemptText = `const t = require("node:os").${TMP}();\n`;
  const files: any = new Map([
    ['test/runtime/leaky.test.js', offending],
    ['test/install/subject.test.js', exemptText],
    ['test/helper/tmp.ts', offending],
    ['test/fixtures/sample.js', offending],
    ['test/runtime/clean.test.js', 'const { tempDir } = require("../helper/tmp.ts");\n'],
  ]);
  const exempt: any = new Map([
    ['test/install/subject.test.js', 'its subject is the temp folder'],
    ['test/runtime/clean.test.js', 'stale: holds no call'],
  ]);
  const { findings, staleExemptions } = scan(files, exempt);
  assert.deepEqual(findings, [`test/runtime/leaky.test.js:2 ${MK}Sync(`]);
  assert.deepEqual(staleExemptions, ['test/runtime/clean.test.js']);
});

test('G27 self-test: each searched call form is found', () => {
  assert.deepEqual(findCalls(`a.${MK}(p, cb)`), [{ line: 1, call: `${MK}(` }]);
  assert.deepEqual(findCalls(`\n\nos.${TMP}()`), [{ line: 3, call: `${TMP}()` }]);
  assert.deepEqual(findCalls(`// the roots are ${MK} directories`), []);
});
