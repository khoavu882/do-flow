'use strict';
// verification-diagnostics.test.js — review A2: the verification contract truncated TAP output to
// 2,000 characters, keeping the final failure count but dropping the failing test names from the
// middle of the stream — recovering them took a second raw run of the same command, which the
// contract itself had also already run twice. Three fixes, each pinned here: the full log is
// persisted with its path in the check record, failing test identifiers are extracted from the
// full stream before truncation, and a repeated command inside one evaluation runs once.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  VerificationContractRunner, extractFailedTests, MAX_FAILED_TESTS,
} = require('../../src/runtime/verification/contract-runner');

function workdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-verify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake TAP stream long enough to force truncation, with the failures mid-stream. */
function tapStream() {
  const lines = ['TAP version 13'];
  for (let i = 1; i <= 60; i += 1) lines.push(`ok ${i} - passing case number ${i} with padding padding padding`);
  lines.push('not ok 61 - the first real failure');
  lines.push('not ok 62 - the second real failure');
  lines.push('not ok 63 - skipped anyway # SKIP not on this platform');
  for (let i = 64; i <= 120; i += 1) lines.push(`ok ${i} - more passing padding padding padding padding`);
  lines.push('# fail 2');
  return lines.join('\n');
}

test('A2: a failing check persists its full log and names the failing tests', (t) => {
  const cwd = workdir(t);
  const stream = tapStream();
  const exec = () => ({ status: 1, stdout: stream, stderr: '' });
  const runner = new VerificationContractRunner({ cwd, exec });

  const result = runner.runCheck('unit_tests', 'npm test');
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(result.failedTests, ['the first real failure', 'the second real failure'],
    'identifiers come from the full stream, before truncation, and SKIP directives are not failures');

  assert.ok(result.logPath, 'a failing check must return where its full log lives');
  const log = fs.readFileSync(result.logPath, 'utf8');
  assert.match(log, /# command: npm test/);
  assert.ok(log.includes('not ok 61 - the first real failure'), 'the log holds the complete stream');
  assert.ok(result.stdout.length < stream.length, 'the inline excerpt stays bounded');
  assert.match(result.stdout, /characters elided/);
});

test('A2: a passing check with small output records no log — the excerpt is the whole story', (t) => {
  const cwd = workdir(t);
  const runner = new VerificationContractRunner({ cwd, exec: () => ({ status: 0, stdout: 'ok 1\n# pass 1', stderr: '' }) });
  const result = runner.runCheck('unit_tests', 'npm test');
  assert.equal(result.status, 'PASS');
  assert.equal(result.logPath, undefined);
  assert.equal(result.failedTests, undefined);
});

test('A2: an unwritable log directory costs the pointer, never the verdict', (t) => {
  const cwd = workdir(t);
  const logDir = path.join(cwd, 'blocked');
  fs.writeFileSync(logDir, 'a file where the directory should be');
  const runner = new VerificationContractRunner({ cwd, logDir, exec: () => ({ status: 1, stdout: 'not ok 1 - x', stderr: '' }) });
  const result = runner.runCheck('unit_tests', 'npm test');
  assert.equal(result.status, 'FAIL');
  assert.equal(result.logPath, null);
  assert.deepEqual(result.failedTests, ['x']);
});

test('A2: the same command in one contract evaluation runs once', (t) => {
  const cwd = workdir(t);
  let runs = 0;
  const exec = () => { runs += 1; return { status: 1, stdout: 'not ok 1 - broken', stderr: '' }; };
  const runner = new VerificationContractRunner({ cwd, exec });

  const report = runner.evaluateContract([
    { name: 'targeted_tests', command: 'npm test' },
    { name: 'broad_tests', command: 'npm test' },
  ]);
  assert.equal(runs, 1, 'the second declaration reuses the first execution');
  assert.equal(report.status, 'FAIL');
  assert.deepEqual(report.failedChecks, ['targeted_tests', 'broad_tests'],
    'both checks still report — deduplication is about execution, not about hiding a verdict');
  assert.equal(report.checks[1].deduplicated, true);
  assert.equal(report.checks[1].name, 'broad_tests', 'the reused result carries its own check name');
});

test('A2: deduplication never crosses evaluations — a retry observes live behaviour', (t) => {
  const cwd = workdir(t);
  let runs = 0;
  const exec = () => { runs += 1; return { status: runs === 1 ? 1 : 0, stdout: 'x', stderr: '' }; };
  const runner = new VerificationContractRunner({ cwd, exec });
  assert.equal(runner.evaluateContract([{ name: 'unit', command: 'npm test' }]).status, 'FAIL');
  assert.equal(runner.evaluateContract([{ name: 'unit', command: 'npm test' }]).status, 'PASS',
    'the second evaluation re-runs the command and sees the fix');
  assert.equal(runs, 2);
});

test('A2: extraction is bounded and deduplicated', () => {
  const lines = [];
  for (let i = 1; i <= 80; i += 1) lines.push(`not ok ${i} - failure ${i}`);
  lines.push('not ok 81 - failure 1'); // node --test repeats failures in its summary block
  const failed = extractFailedTests(lines.join('\n'));
  assert.equal(failed.length, MAX_FAILED_TESTS);
  assert.equal(new Set(failed).size, failed.length);
});
