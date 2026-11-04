'use strict';

// G69 — test repo isolation (FU-rvzby1).
//
// Every test must be hermetic and execute within its own repository and scratch directories.
// A test must never read outside its repository (e.g. `REPO_ROOT/..`, `../do-flow`, or sibling
// checkouts), because sibling checkouts are absent in clean CI clones and in isolated release
// rehearsals (`rehearse.ts`). This guard scans every *.js and *.ts file under test/ (excluding
// test/fixtures/ and this guard itself) and verifies that no test navigates or reads above the repo root.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO } = require('./_shared.ts');
const { tempDir } = require('../helper/tmp.ts');
const { linkBin } = require('../helper/fake-harness-cli.ts');

const TEST_ROOT = path.join(REPO, 'test');
const THIS_GUARD = 'test/guards/test-isolation.test.ts';
const FIXTURES = 'test/fixtures/';

// Assembled from parts so this guard file does not trip its own literal checks
const SIBLING_NAME = 'do' + '-flow';
const SIBLING_PATH = '../' + SIBLING_NAME;

const FORBIDDEN_PATTERNS = [
  new RegExp(`(?:'|"|\`)\\.\\./${SIBLING_NAME}`),
  new RegExp(`\\['\\.\\.',\\s*['"]${SIBLING_NAME}['"]\\]`),
  /\bpath\.(?:join|resolve)\([^,\n]+,\s*['"]\.\.['"]\s*,\s*['"](?:\.\.|[a-zA-Z0-9_-]+)['"]\s*,\s*['"][^'"]*agent-docs/,
  /\bpath\.(?:join|resolve)\(\s*REPO_ROOT\s*,\s*['"]\.\.['"]/,
];

function testFiles(root: string = TEST_ROOT): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
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

function findViolations(text: string): Array<{ line: number; match: string }> {
  const lines = text.split(/\r?\n/);
  const violations: Array<{ line: number; match: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment lines
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue;
    for (const pat of FORBIDDEN_PATTERNS) {
      const m = line.match(pat);
      if (m) {
        violations.push({ line: i + 1, match: m[0] });
        break;
      }
    }
  }
  return violations;
}

test('G69: no test references or reads outside its repo root (FU-rvzby1)', () => {
  const files = testFiles().filter((rel) => rel !== THIS_GUARD && !rel.startsWith(FIXTURES));
  const offenders: string[] = [];

  for (const rel of files) {
    const full = path.join(REPO, rel);
    let text = '';
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const violations = findViolations(text);
    for (const v of violations) {
      offenders.push(`${rel}:${v.line} -> ${v.match}`);
    }
  }

  assert.deepEqual(offenders, [],
    'these test files contain references reading outside the repository:\n  ' + offenders.join('\n  '));
});

test('G69 negative control: out-of-repo and sibling reads are detected', () => {
  const sampleSibling = `const p = path.join(__dirname, '${SIBLING_PATH}');`;
  assert.equal(findViolations(sampleSibling).length, 1);

  const sampleRepoEscape = `const p = path.join(REPO_ROOT, '..', 'other-repo');`;
  assert.equal(findViolations(sampleRepoEscape).length, 1);

  const safeInRepo = `const p = path.join(REPO_ROOT, 'test', 'fixtures');`;
  assert.equal(findViolations(safeInRepo).length, 0);
});

// G69b — a worker-launching test never puts the interpreter's install directory on a child PATH (FU-gs7vzm).
// That directory can hold real codex, gemini or claude binaries (081 D.3, NFR-002). A child gets a scratch
// bin holding the fakes plus a `node` link, which is what linkBin and the dispatch sandbox build.
const LAUNCHERS = /fake-harness-cli|dispatch-sandbox/;

/** Lines that build a PATH from dirname(process.execPath): not a comment, not an assertion, not the win32 branch. */
function findInterpreterDirOnPath(text: string): Array<{ line: number; match: string }> {
  const found: Array<{ line: number; match: string }> = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line) || !/dirname\(process\.execPath\)/.test(line)) return;
    if (/assert|win32/.test(line) || !/delimiter|PATH/.test(line)) return;
    found.push({ line: i + 1, match: line.trim() });
  });
  return found;
}

test('G69b: no worker-launching test or helper adds the interpreter install directory to a PATH', () => {
  const offenders: string[] = [];
  for (const rel of testFiles().filter((f) => f !== THIS_GUARD && !f.startsWith(FIXTURES))) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    if (!LAUNCHERS.test(text) && !/helper\/(?:fake-harness-cli|dispatch-sandbox)\.ts$/.test(rel)) continue;
    for (const v of findInterpreterDirOnPath(text)) offenders.push(`${rel}:${v.line} -> ${v.match}`);
  }
  assert.deepEqual(offenders, [], 'these files put dirname(process.execPath) on a child PATH:\n  ' + offenders.join('\n  '));
});

test('G69b negative control: a PATH built from the interpreter directory is detected, assertions and comments are not', () => {
  assert.equal(findInterpreterDirOnPath("const env = { PATH: [bin, path.dirname(process.execPath)].join(path.delimiter) };").length, 1);
  assert.equal(findInterpreterDirOnPath('PATH: `${path.dirname(process.execPath)}:/usr/bin`').length, 1);
  assert.equal(findInterpreterDirOnPath("assert.ok(!entries.includes(path.dirname(process.execPath)), 'never the node directory');").length, 0);
  assert.equal(findInterpreterDirOnPath('// PATH never holds path.dirname(process.execPath)').length, 0);
  assert.equal(findInterpreterDirOnPath("if (process.platform === 'win32') return [dir, path.dirname(process.execPath)].join(path.delimiter);").length, 0);
});

test('G69b control: linkBin gives a PATH where node runs and no neighbouring harness binary is reachable', { skip: process.platform === 'win32' && 'the node link is POSIX only' }, (t: any) => {
  const bin = path.join(tempDir(t, 'doflow-linkbin-'), 'bin');
  const childPath = linkBin(bin, ['fake-claude']);
  const entries = childPath.split(path.delimiter);
  assert.equal(entries.length, 2);
  assert.ok(!entries.includes(path.dirname(process.execPath)), 'the install directory is not an entry');
  assert.deepEqual(fs.readdirSync(entries[1]), ['node'], 'the second entry holds node alone');
  const harnessNames = require('../../core/registry/harnesses.json').harnesses
    .flatMap((h: any) => [h.id, h.worker?.cli?.binary].filter(Boolean));
  for (const name of new Set(harnessNames)) {
    assert.deepEqual(entries.filter((dir: string) => fs.existsSync(path.join(dir, name as string))), [], `${name} is on no PATH entry`);
  }
  const ran = spawnSync('node', ['-e', 'process.stdout.write(String(process.version))'], { env: { PATH: childPath }, encoding: 'utf8' });
  assert.equal(ran.stdout, process.version, 'node still resolves from the scratch PATH');
});
