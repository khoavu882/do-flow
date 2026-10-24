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
const { REPO } = require('./_shared.ts');

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
