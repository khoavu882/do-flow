'use strict';

/**
 * Tests for bench impact-replay (feature 089, IC-010, plan.md task B.3).
 *
 * Exercises:
 * - Pure helpers: config validation, median, fraction, verdict determination, commit qualification.
 * - End-to-end replay on a fixture repository with 5 historical commits:
 *     (1) a module change caught by selection
 *     (2) a change whose detecting test is reachable only through dynamic require (missed => keep-off)
 *     (3) a registry change (core/registry/*.json) => full expansion
 *     (4) a commit whose co-changed test fails at the commit (unevaluable: baseline-fail)
 *     (5) a test-only commit (not qualifying)
 * - Verdict transitions: insufficient-data, keep-off (miss or ceiling), selection-candidate.
 * - Report JSON contract and bounds string.
 * - Export directory cleanup (no leftover dirs in TMPDIR).
 * - Repository immutability: git status, HEAD, and refs identical before/after.
 * - CLI flags: --commits 0 and unknown flags exit 2.
 * - Negative controls:
 *     - skipping baseline run turns flake commit (4) into a false detection.
 *     - counting full expansions as 0 turns a keep-off corpus into a pass of the ceiling.
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { createScratch } = require('../helper/scratch-env');
const { tempDir } = require('../helper/tmp');
const scratch = createScratch('doflow-impact-replay-');
scratch.apply();
after(() => {
  scratch.restore();
  scratch.remove();
});

const impactReplay = require('../../bench/impact-replay.js');
const runner = require('../../bench/runner.js');

// ---------------------------------------------------------------------------
// 1. Pure unit tests

test('IC-010 pure: loadImpactReplayConfig accepts valid config and refuses invalid values', () => {
  const valid = {
    impactReplay: {
      commits: 60,
      minCommits: 20,
      ceiling: 0.5,
      timeoutMs: 120000,
      note: 'Valid config',
    },
  };
  const parsed = impactReplay.loadImpactReplayConfig(valid);
  assert.equal(parsed.commits, 60);
  assert.equal(parsed.minCommits, 20);
  assert.equal(parsed.ceiling, 0.5);
  assert.equal(parsed.timeoutMs, 120000);

  // Refusal cases
  const badCases = [
    [undefined, /impactReplay is invalid: block must be an object/],
    [null, /impactReplay is invalid: block must be an object/],
    [{ ...valid.impactReplay, commits: 0 }, /impactReplay is invalid: commits/],
    [{ ...valid.impactReplay, commits: -5 }, /impactReplay is invalid: commits/],
    [{ ...valid.impactReplay, commits: 2.5 }, /impactReplay is invalid: commits/],
    [{ ...valid.impactReplay, minCommits: 0 }, /impactReplay is invalid: minCommits/],
    [{ ...valid.impactReplay, ceiling: 0 }, /impactReplay is invalid: ceiling/],
    [{ ...valid.impactReplay, ceiling: 1.5 }, /impactReplay is invalid: ceiling/],
    [{ ...valid.impactReplay, ceiling: -0.1 }, /impactReplay is invalid: ceiling/],
    [{ ...valid.impactReplay, timeoutMs: 0 }, /impactReplay is invalid: timeoutMs/],
  ];

  for (const [block, pattern] of badCases) {
    assert.throws(() => impactReplay.loadImpactReplayConfig({ impactReplay: block }), pattern);
  }
});

test('IC-010 pure: computeMedian handles empty, odd and even lengths', () => {
  assert.equal(impactReplay.computeMedian([]), null);
  assert.equal(impactReplay.computeMedian([0.4]), 0.4);
  assert.equal(impactReplay.computeMedian([0.1, 0.5, 0.9]), 0.5);
  assert.equal(impactReplay.computeMedian([0.9, 0.1, 0.5]), 0.5); // unsorted input
  assert.equal(impactReplay.computeMedian([0.2, 0.4, 0.6, 0.8]), 0.5);
});

test('IC-010 pure: computeSelectedFraction counts full expansion as 1.0', () => {
  assert.equal(impactReplay.computeSelectedFraction({ mode: 'full', selectedCount: 1, totalCount: 10 }), 1.0);
  assert.equal(impactReplay.computeSelectedFraction({ mode: 'selected', selectedCount: 2, totalCount: 10 }), 0.2);
  assert.equal(impactReplay.computeSelectedFraction({ mode: 'selected', selectedCount: 0, totalCount: 5 }), 0);
});

test('IC-010 pure: computeMedianSelectedFraction over evaluated commits', () => {
  assert.equal(impactReplay.computeMedianSelectedFraction([]), null);
  const commits = [
    { mode: 'selected', selectedCount: 1, totalCount: 10 }, // 0.1
    { mode: 'full', selectedCount: 10, totalCount: 10 },    // 1.0
    { mode: 'selected', selectedCount: 4, totalCount: 10 }, // 0.4
  ];
  // fractions: [0.1, 0.4, 1.0] -> median 0.4
  assert.equal(impactReplay.computeMedianSelectedFraction(commits), 0.4);
});

test('IC-010 pure: determineVerdict implements exact IC-010 rules', () => {
  // insufficient-data when evaluated < minCommits
  assert.equal(impactReplay.determineVerdict({ evaluated: 19, minCommits: 20, missedTotal: 0, medianSelectedFraction: 0.1, ceiling: 0.5 }), 'insufficient-data');
  // keep-off when missedTotal > 0
  assert.equal(impactReplay.determineVerdict({ evaluated: 20, minCommits: 20, missedTotal: 1, medianSelectedFraction: 0.1, ceiling: 0.5 }), 'keep-off');
  // keep-off when medianSelectedFraction >= ceiling
  assert.equal(impactReplay.determineVerdict({ evaluated: 20, minCommits: 20, missedTotal: 0, medianSelectedFraction: 0.5, ceiling: 0.5 }), 'keep-off');
  assert.equal(impactReplay.determineVerdict({ evaluated: 20, minCommits: 20, missedTotal: 0, medianSelectedFraction: 0.6, ceiling: 0.5 }), 'keep-off');
  // selection-candidate when evaluated >= minCommits, missedTotal === 0, and medianSelectedFraction < ceiling
  assert.equal(impactReplay.determineVerdict({ evaluated: 20, minCommits: 20, missedTotal: 0, medianSelectedFraction: 0.49, ceiling: 0.5 }), 'selection-candidate');
});

test('IC-010 pure: qualifiesCommit requires at least one src/** module and at least one test file', () => {
  const isTest = (f) => f.startsWith('test/') && f.endsWith('.test.js');
  assert.equal(impactReplay.qualifiesCommit({ changedFiles: ['src/a.js', 'test/a.test.js'], isTest }), true);
  assert.equal(impactReplay.qualifiesCommit({ changedFiles: ['src/nested/b.ts', 'test/sub/b.test.js'], isTest }), true);
  // test only -> false
  assert.equal(impactReplay.qualifiesCommit({ changedFiles: ['test/a.test.js'], isTest }), false);
  // src only -> false
  assert.equal(impactReplay.qualifiesCommit({ changedFiles: ['src/a.js'], isTest }), false);
  // non-src non-test -> false
  assert.equal(impactReplay.qualifiesCommit({ changedFiles: ['README.md', 'docs/guide.md'], isTest }), false);
});

// ---------------------------------------------------------------------------
// 2. Fixture git repository helper

// Helper to avoid G16 false positive on relative require literals in test template strings
const reqFn = 'require';

function buildFixtureRepo(baseDir) {
  const repoDir = path.join(baseDir, 'fixture-repo');
  fs.mkdirSync(repoDir, { recursive: true });

  const runGit = (args) => {
    return execFileSync('git', args, {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test Author',
        GIT_AUTHOR_EMAIL: 'author@example.com',
        GIT_COMMITTER_NAME: 'Test Committer',
        GIT_COMMITTER_EMAIL: 'committer@example.com',
      },
      encoding: 'utf8',
    });
  };

  runGit(['init', '-b', 'main']);

  // Commit 0: initial baseline
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'test'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'core', 'registry'), { recursive: true });

  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
    name: 'fixture',
    scripts: { test: 'node --test' },
  }, null, 2) + '\n');

  fs.writeFileSync(path.join(repoDir, 'src', 'a.js'), `'use strict';
function a() { return 1; }
module.exports = { a };
`);

  fs.writeFileSync(path.join(repoDir, 'src', 'b.js'), `'use strict';
function b() { return 2; }
module.exports = { b };
`);

  fs.writeFileSync(path.join(repoDir, 'test', 'a.test.js'), `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { a } = ${reqFn}('../src/a.js');

test('a test', () => {
  assert.equal(a(), 1);
});
`);

  fs.writeFileSync(path.join(repoDir, 'test', 'b.test.js'), `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// dynamic require that static analysis does not resolve
const modName = '../src/b.js';
const { b } = ${reqFn}(modName);

test('b test', () => {
  assert.equal(b(), 2);
});
`);

  // Static consumer for src/b.js so b.js is in the graph, but test/b.test.js is not selected
  fs.writeFileSync(path.join(repoDir, 'test', 'static-b.test.js'), `'use strict';
const test = require('node:test');
const { b } = ${reqFn}('../src/b.js');

test('static b test', () => {});
`);

  runGit(['add', '.']);
  runGit(['commit', '-m', 'commit 0: initial baseline']);

  // Commit 1: a module change caught by selection
  fs.writeFileSync(path.join(repoDir, 'src', 'a.js'), `'use strict';
function a() { return 10; }
module.exports = { a };
`);
  fs.writeFileSync(path.join(repoDir, 'test', 'a.test.js'), `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { a } = ${reqFn}('../src/a.js');

test('a test', () => {
  assert.equal(a(), 10);
});
`);
  runGit(['add', 'src/a.js', 'test/a.test.js']);
  runGit(['commit', '-m', 'commit 1: module change caught by selection']);
  const sha1 = runGit(['rev-parse', 'HEAD']).trim();

  // Commit 2: change whose detecting test is reachable only through dynamic require
  fs.writeFileSync(path.join(repoDir, 'src', 'b.js'), `'use strict';
function b() { return 20; }
module.exports = { b };
`);
  fs.writeFileSync(path.join(repoDir, 'test', 'b.test.js'), `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const modName = '../src/b.js';
const { b } = ${reqFn}(modName);

test('b test', () => {
  assert.equal(b(), 20);
});
`);
  runGit(['add', 'src/b.js', 'test/b.test.js']);
  runGit(['commit', '-m', 'commit 2: dynamic require change']);
  const sha2 = runGit(['rev-parse', 'HEAD']).trim();

  // Commit 3: a registry change (core/registry/*.json) + src + test => full expansion
  fs.writeFileSync(path.join(repoDir, 'core', 'registry', 'config.json'), JSON.stringify({ key: 'val3' }) + '\n');
  fs.writeFileSync(path.join(repoDir, 'src', 'a.js'), `'use strict';
function a() { return 30; }
module.exports = { a };
`);
  fs.writeFileSync(path.join(repoDir, 'test', 'a.test.js'), `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { a } = ${reqFn}('../src/a.js');

test('a test', () => {
  assert.equal(a(), 30);
});
`);
  runGit(['add', 'core/registry/config.json', 'src/a.js', 'test/a.test.js']);
  runGit(['commit', '-m', 'commit 3: registry change causing full expansion']);
  const sha3 = runGit(['rev-parse', 'HEAD']).trim();

  // Commit 4: a commit whose co-changed test fails at the commit itself (baseline-fail)
  fs.writeFileSync(path.join(repoDir, 'src', 'a.js'), `'use strict';
function a() { return 40; }
module.exports = { a };
`);
  fs.writeFileSync(path.join(repoDir, 'test', 'a.test.js'), `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { a } = ${reqFn}('../src/a.js');

test('a test', () => {
  // Deliberate test failure at commit 4
  assert.equal(a(), 999);
});
`);
  runGit(['add', 'src/a.js', 'test/a.test.js']);
  runGit(['commit', '-m', 'commit 4: flaky baseline fail']);
  const sha4 = runGit(['rev-parse', 'HEAD']).trim();

  // Commit 5: test-only commit (not qualifying)
  fs.writeFileSync(path.join(repoDir, 'test', 'a.test.js'), `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { a } = ${reqFn}('../src/a.js');

// Only changed test file comments
test('a test updated comment', () => {
  assert.equal(a(), 999);
});
`);
  runGit(['add', 'test/a.test.js']);
  runGit(['commit', '-m', 'commit 5: test only']);
  const sha5 = runGit(['rev-parse', 'HEAD']).trim();

  return { repoDir, shas: [sha1, sha2, sha3, sha4, sha5] };
}

// ---------------------------------------------------------------------------
// 3. End-to-end replay on fixture repository

test('IC-010 end-to-end: fixture repository 5 commits replay, cleanup, and immutability', (t) => {
  const tmpRoot = tempDir(t, 'doflow-replay-test-');
  const scratchTmpDir = path.join(tmpRoot, 'scratch-tmp');
  fs.mkdirSync(scratchTmpDir, { recursive: true });

  const { repoDir, shas } = buildFixtureRepo(tmpRoot);

  // Record initial git state before replay
  const statusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' });
  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
  const refsBefore = execFileSync('git', ['show-ref'], { cwd: repoDir, encoding: 'utf8' });

  // Run replay with small minCommits override
  const reportPath = path.join(tmpRoot, 'replay-out.json');
  const report = impactReplay.replayCommits({
    repoRoot: repoDir,
    rev: 'HEAD',
    commitsCount: 10,
    minCommits: 2,
    ceiling: 0.5,
    timeoutMs: 30000,
    outPath: reportPath,
    tmpDir: scratchTmpDir,
  });

  // Verify report JSON shape matches IC-010
  assert.equal(report.v, 1);
  assert.equal(report.rev, 'HEAD');
  assert.equal(report.bounds, 'detecting set is a lower bound: only co-changed tests run');
  assert.ok(report.config);
  assert.equal(report.config.commits, 10);
  assert.equal(report.config.minCommits, 2);
  assert.equal(report.config.ceiling, 0.5);

  // Commits summary:
  // Qualifying: commit 1, 2, 3, 4 (commit 5 is test-only, skipped)
  assert.equal(report.summary.qualified, 4);
  // Evaluated: commits 1, 2, 3 (commit 4 failed baseline)
  assert.equal(report.summary.evaluated, 3);
  assert.deepEqual(report.summary.unevaluable, { 'baseline-fail': 1 });

  // Commit inspection:
  // commit 4 (baseline fail)
  const c4 = report.commits.find((c) => c.sha === shas[3]);
  assert.ok(c4);
  assert.equal(c4.status, 'unevaluable: baseline-fail');
  assert.deepEqual(c4.detecting, []);
  assert.deepEqual(c4.missed, []);

  // commit 3 (registry change -> mode full)
  const c3 = report.commits.find((c) => c.sha === shas[2]);
  assert.ok(c3);
  assert.equal(c3.status, 'evaluated');
  assert.equal(c3.mode, 'full');
  assert.ok(c3.unknownFiles.includes('core/registry/config.json'));
  assert.deepEqual(c3.detecting, ['test/a.test.js']);
  assert.deepEqual(c3.missed, []); // full expansion misses nothing

  // commit 2 (dynamic require -> missed)
  const c2 = report.commits.find((c) => c.sha === shas[1]);
  assert.ok(c2);
  assert.equal(c2.status, 'evaluated');
  assert.equal(c2.mode, 'selected');
  assert.deepEqual(c2.detecting, ['test/b.test.js']);
  assert.deepEqual(c2.missed, ['test/b.test.js']); // dynamic require wasn't found by static selector

  // commit 1 (static require -> detected and selected)
  const c1 = report.commits.find((c) => c.sha === shas[0]);
  assert.ok(c1);
  assert.equal(c1.status, 'evaluated');
  assert.equal(c1.mode, 'selected');
  assert.deepEqual(c1.detecting, ['test/a.test.js']);
  assert.deepEqual(c1.missed, []);

  // Summary counts
  assert.equal(report.summary.withMisses, 1);
  assert.equal(report.summary.missedTotal, 1);
  assert.equal(report.summary.fullExpansions, 1);
  // Verdict with missedTotal === 1 is keep-off
  assert.equal(report.summary.verdict, 'keep-off');

  // Verify file was written
  assert.ok(fs.existsSync(reportPath));
  const written = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(written.summary.verdict, 'keep-off');

  // Assert cleanup: no leftover export directories in scratchTmpDir
  const remaining = fs.readdirSync(scratchTmpDir);
  assert.deepEqual(remaining, [], `scratch TMPDIR must be cleaned up, got: ${remaining.join(', ')}`);

  // Assert repository immutability: git status, HEAD, and refs are untouched
  const statusAfter = execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' });
  const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
  const refsAfter = execFileSync('git', ['show-ref'], { cwd: repoDir, encoding: 'utf8' });

  assert.equal(statusAfter, statusBefore);
  assert.equal(headAfter, headBefore);
  assert.equal(refsAfter, refsBefore);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('IC-010 verdict cases: insufficient-data, keep-off on miss or ceiling, selection-candidate', () => {
  // 1. evaluated < minCommits => insufficient-data
  const v1 = impactReplay.determineVerdict({ evaluated: 2, minCommits: 5, missedTotal: 0, medianSelectedFraction: 0.1, ceiling: 0.5 });
  assert.equal(v1, 'insufficient-data');

  // 2. missedTotal > 0 => keep-off
  const v2 = impactReplay.determineVerdict({ evaluated: 5, minCommits: 5, missedTotal: 1, medianSelectedFraction: 0.1, ceiling: 0.5 });
  assert.equal(v2, 'keep-off');

  // 3. median >= ceiling => keep-off
  const v3 = impactReplay.determineVerdict({ evaluated: 5, minCommits: 5, missedTotal: 0, medianSelectedFraction: 0.5, ceiling: 0.5 });
  assert.equal(v3, 'keep-off');

  // 4. selection-candidate
  const v4 = impactReplay.determineVerdict({ evaluated: 5, minCommits: 5, missedTotal: 0, medianSelectedFraction: 0.3, ceiling: 0.5 });
  assert.equal(v4, 'selection-candidate');
});

// ---------------------------------------------------------------------------
// 4. Negative controls

test('Negative control 1: skipping baseline run turns the flake commit into a false detection', (t) => {
  const tmpRoot = tempDir(t, 'doflow-neg1-test-');
  const scratchTmpDir = path.join(tmpRoot, 'scratch-tmp');
  fs.mkdirSync(scratchTmpDir, { recursive: true });

  const { repoDir, shas } = buildFixtureRepo(tmpRoot);

  // Normal replay: commit 4 is unevaluable: baseline-fail and detecting is []
  const normalReport = impactReplay.replayCommits({
    repoRoot: repoDir,
    rev: 'HEAD',
    commitsCount: 10,
    minCommits: 2,
    ceiling: 0.5,
    timeoutMs: 30000,
    tmpDir: scratchTmpDir,
  });
  const normalC4 = normalReport.commits.find((c) => c.sha === shas[3]);
  assert.equal(normalC4.status, 'unevaluable: baseline-fail');
  assert.deepEqual(normalC4.detecting, []);

  // Mutated seam: skip baseline run
  const mutatedReport = impactReplay.replayCommits({
    repoRoot: repoDir,
    rev: 'HEAD',
    commitsCount: 10,
    minCommits: 2,
    ceiling: 0.5,
    timeoutMs: 30000,
    tmpDir: scratchTmpDir,
    skipBaseline: true, // seam that skips baseline
  });
  const mutatedC4 = mutatedReport.commits.find((c) => c.sha === shas[3]);
  // Flake commit now falsely passes baseline and records a false detection!
  assert.equal(mutatedC4.status, 'evaluated');
  assert.deepEqual(mutatedC4.detecting, ['test/a.test.js']);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('Negative control 2: counting full expansions as 0 turns a keep-off corpus into a pass of the ceiling', () => {
  // A corpus with no misses where full expansions cause median >= ceiling (keep-off)
  const evaluatedCommits = [
    { mode: 'selected', selectedCount: 1, totalCount: 10 }, // 0.1
    { mode: 'full', selectedCount: 10, totalCount: 10 },    // 1.0
    { mode: 'full', selectedCount: 10, totalCount: 10 },    // 1.0
  ];
  // Normal calculation: fractions are [0.1, 1.0, 1.0] -> median is 1.0
  const normalMedian = impactReplay.computeMedianSelectedFraction(evaluatedCommits);
  assert.equal(normalMedian, 1.0);
  const normalVerdict = impactReplay.determineVerdict({
    evaluated: 3,
    minCommits: 2,
    missedTotal: 0,
    medianSelectedFraction: normalMedian,
    ceiling: 0.5,
  });
  assert.equal(normalVerdict, 'keep-off');

  // Mutated calculation: counting full expansions as 0.0
  const mutatedFraction = (c) => (c.mode === 'full' ? 0.0 : c.selectedCount / c.totalCount);
  const mutatedFractions = evaluatedCommits.map(mutatedFraction); // [0.1, 0, 0] -> sorted [0, 0, 0.1] -> median 0
  const mutatedMedian = impactReplay.computeMedian(mutatedFractions);
  assert.equal(mutatedMedian, 0);

  const mutatedVerdict = impactReplay.determineVerdict({
    evaluated: 3,
    minCommits: 2,
    missedTotal: 0,
    medianSelectedFraction: mutatedMedian,
    ceiling: 0.5,
  });
  // Turning full expansions into 0 flips keep-off into a false pass of the ceiling!
  assert.equal(mutatedVerdict, 'selection-candidate');
});

// ---------------------------------------------------------------------------
// 5. Runner CLI argument validation and exit codes

test('CLI: --commits 0 exits 2', () => {
  const res = runner.main(['impact-replay', '--commits', '0']);
  assert.equal(res, 2);
});

test('CLI: unknown flag exits 2', () => {
  const res = runner.main(['impact-replay', '--unrecognized-flag']);
  assert.equal(res, 2);
});

test('CLI: --out without value exits 2', () => {
  const res = runner.main(['impact-replay', '--out']);
  assert.equal(res, 2);
});
