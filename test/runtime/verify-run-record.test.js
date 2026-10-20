'use strict';

// 108 B.2 (IC-007): every report gets a best-effort, head-bound local run record. The record
// writer must not change the report's existing JSON bytes or exit code, and a dirty checkout is
// recorded as dirty rather than being inferred clean from the successful verification.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { createScratch } = require('../helper/scratch-env');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const scratch = createScratch('doflow-verify-run-record-');
after(() => scratch.remove());

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], {
    cwd, encoding: 'utf8', env: scratch.env(),
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function project(t) {
  const root = tempDir(t, 'doflow-verify-run-record-project-');
  const plan = path.join(root, 'plan.md');
  fs.mkdirSync(path.join(root, '.doflow', 'state', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '.doflow/\n');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  const override = {
    parse: null,
    build: 'node -e 0',
    typecheck: null,
    lint: 'node -e 0',
    test: 'node -e 0',
    testTargeted: 'node -e 0 {pattern}',
  };
  fs.writeFileSync(plan, '# Plan\n\n```doflow-verification\n' + JSON.stringify(override) + '\n```\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return { root, plan };
}

function fixedClock(t) {
  const dir = tempDir(t, 'doflow-verify-run-record-preload-');
  const file = path.join(dir, 'fixed-clock.js');
  fs.writeFileSync(file, 'Date.now = () => 1792000000000;\n');
  return file;
}

function verify(p, preloads = []) {
  const args = preloads.flatMap((file) => ['--require', file]);
  args.push(DOFLOW, 'verify', '--action', 'report', '--task-id', 'T-1', '--risk', 'LOW', '--plan-path', p.plan,
    '--scope', 'src/a.js', '--json');
  return spawnSync(process.execPath, args, {
    cwd: p.root,
    encoding: 'utf8',
    env: scratch.env({
      DOFLOW_TELEMETRY: 'off',
      DOFLOW_RUN_ID: undefined,
      DOFLOW_LINEAGE_ID: undefined,
      DOFLOW_ATTEMPT: undefined,
      DOFLOW_CONFIG_DIR: undefined,
    }),
  });
}

function readRecords(root) {
  const file = path.join(root, '.doflow', 'state', 'verification', 'runs', 'T-1.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function recordHash(stdout) {
  const reportJson = JSON.stringify(JSON.parse(stdout), null, 2);
  return `sha256:${crypto.createHash('sha256').update(reportJson, 'utf8').digest('hex')}`;
}

test('verify report appends one head-bound record per run without changing JSON output or exit', (t) => {
  const p = project(t);
  const clock = fixedClock(t);
  const first = verify(p, [clock]);
  const second = verify(p, [clock]);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, first.status, second.stderr);
  assert.equal(second.stdout, first.stdout, 'appending a run record leaves verify --json bytes unchanged');
  assert.equal(JSON.parse(first.stdout).status, 'PASS');
  assert.equal(JSON.parse(first.stdout).counts.checksReused, undefined, 'with reuse off counts.checksReused is omitted');

  const records = readRecords(p.root);
  assert.equal(records.length, 2, 'two reports append two JSONL lines');
  const head = git(p.root, 'rev-parse', 'HEAD');
  for (const record of records) {
    assert.deepEqual(Object.keys(record), ['schema', 'taskId', 'head', 'clean', 'verdict', 'at', 'reportSha256']);
    assert.equal(record.schema, 1);
    assert.equal(record.taskId, 'T-1');
    assert.equal(record.head, head);
    assert.match(record.head, /^[0-9a-f]{40}$/);
    assert.equal(record.clean, true);
    assert.equal(record.verdict, 'PASS');
    assert.match(record.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(record.reportSha256, recordHash(first.stdout));
  }
});

// 089 IC-006: with verify.reuse on for the run, `reused` (the count of report checks carrying the
// label) sits immediately before `reportSha256`; the case above keeps reuse off and its pin.
test('with verify.reuse on the record carries the reused count before reportSha256', (t) => {
  const reuseScratch = createScratch('doflow-verify-run-record-reuse-');
  t.after(() => reuseScratch.remove());
  fs.writeFileSync(path.join(reuseScratch.xdg, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'verify.reuse': 'on' }));
  const p = project(t);
  const clock = fixedClock(t);
  const run = () => spawnSync(process.execPath, ['--require', clock, DOFLOW, 'verify', '--action', 'report', '--task-id', 'T-1',
    '--risk', 'LOW', '--plan-path', p.plan, '--scope', 'src/a.js', '--json'], {
    cwd: p.root, encoding: 'utf8',
    env: reuseScratch.env({ DOFLOW_TELEMETRY: 'off', DOFLOW_RUN_ID: undefined, DOFLOW_LINEAGE_ID: undefined,
      DOFLOW_ATTEMPT: undefined, DOFLOW_CONFIG_DIR: undefined, DOFLOW_VERIFY_REUSE: undefined }),
  });
  const first = run();
  const second = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const carrying = (stdout) => JSON.parse(stdout).tiers.flatMap((tier) => tier.checks).filter((check) => check.reused).length;
  assert.equal(carrying(first.stdout), 0, 'the first run executes every check');
  assert.equal(JSON.parse(first.stdout).counts.checksReused, 0, 'first run counts.checksReused is 0');
  assert.ok(carrying(second.stdout) > 0, 'the second run reuses the recorded PASSes');
  assert.equal(JSON.parse(second.stdout).counts.checksReused, carrying(second.stdout), 'second run counts.checksReused matches reused count');

  const records = readRecords(p.root);
  assert.equal(records.length, 2);
  for (const [record, out] of [[records[0], first.stdout], [records[1], second.stdout]]) {
    assert.deepEqual(Object.keys(record), ['schema', 'taskId', 'head', 'clean', 'verdict', 'at', 'reused', 'reportSha256']);
    assert.equal(record.schema, 1);
    assert.equal(record.verdict, 'PASS');
    assert.equal(record.reused, carrying(out));
    assert.equal(record.reportSha256, recordHash(out));
  }
});

test('a dirty working tree is recorded with clean:false', (t) => {
  const p = project(t);
  fs.writeFileSync(path.join(p.root, 'src', 'a.js'), 'module.exports = 2;\n');
  const result = verify(p, [fixedClock(t)]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'PASS');
  const [record] = readRecords(p.root);
  assert.ok(record, 'the report produced a run record');
  assert.equal(record.clean, false, 'a changed tracked file must not be reported clean');
  assert.equal(record.head, git(p.root, 'rev-parse', 'HEAD'));
});

test('an unwritable run-record directory does not change the report or exit', (t) => {
  const p = project(t);
  const clock = fixedClock(t);
  const first = verify(p, [clock]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readRecords(p.root).length, 1);

  const dir = path.join(p.root, '.doflow', 'state', 'verification', 'runs');
  const preloadDir = tempDir(t, 'doflow-verify-run-record-fault-');
  const fault = path.join(preloadDir, 'unwritable-runs.js');
  fs.writeFileSync(fault, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const blocked = ' + JSON.stringify(dir) + ';',
    'const mkdir = fs.mkdirSync;',
    'fs.mkdirSync = function (target, ...args) {',
    "  if (typeof target === 'string' && path.resolve(target) === blocked) throw Object.assign(new Error('EACCES: simulated unwritable run-record directory'), { code: 'EACCES' });",
    '  return mkdir.call(this, target, ...args);',
    '};',
    '',
  ].join('\n'));
  const faulted = verify(p, [clock, fault]);

  assert.equal(faulted.status, first.status, faulted.stderr);
  assert.equal(faulted.stdout, first.stdout, 'record I/O failure leaves verify --json bytes unchanged');
  assert.equal(readRecords(p.root).length, 1, 'failed append leaves the prior line intact');
});
