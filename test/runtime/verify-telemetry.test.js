'use strict';

// 088 C.1 (IC-006, IC-001; FR-006, FR-002; NFR-005, NFR-007; DD-4): the verify.run, verify.tier and
// verify.check lines. The verify verb writes one verify.run, one verify.tier per report tier and one
// verify.check per check, carrying only the keys core/registry/telemetry.json declares for P2; the
// dispatch runner (082) writes one verify.run with `source: dispatch`. Timing travels in the
// runner's `metrics` WeakMap beside the report, never in it, so `verify --json` is byte-identical
// with telemetry on, off and faulted.
//
// The verb cases spawn `doflow verify` in scratch projects that hold a `.doflow/state/runs` store,
// with a fixed Date.now preloaded so two runs print the same report. Every spawn uses the scratch
// HOME, and telemetry is switched on explicitly (scratch-env defaults it off).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir, tempDir } = require('../helper/tmp');
const { createScratch } = require('../helper/scratch-env');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/telemetry.json'), 'utf8'));
const VERIFY_FIXTURE = path.join(REPO, 'test/fixtures/telemetry/verify.jsonl');
const { emitVerifyTelemetry, buildVerifyRecords } = require('../../src/runtime/verification/telemetry-emit.ts');
const { VerificationEngine } = require('../../src/runtime/verification/engine.ts');
const { VerificationContractRunner } = require('../../src/runtime/verification/contract-runner.ts');
const { runVerification } = require('../../src/runtime/dispatch/verify-run.ts');

const scratch = createScratch('doflow-verify-telemetry-');
after(() => scratch.remove());

const KINDS = ['verify.run', 'verify.tier', 'verify.check'];
const COMMON = ['timestamp', 'kind', 'run', 'lineage', 'attempt'];
/** IC-006, P3 column (FR-016). P5 keys arrive with G.1..G.4. */
const P3 = {
  'verify.run': ['verify_id', 'source', 'task', 'dispatch_run', 'risk', 'status', 'exit_code', 'duration_ms', 'checks_run'],
  'verify.tier': ['verify_id', 'tier', 'status', 'selection_basis', 'selected', 'total', 'fallback', 'duration_ms'],
  'verify.check': ['verify_id', 'tier', 'status', 'exit_code', 'duration_ms', 'tests', 'tests_failed', 'cpu_ms', 'resource_basis', 'check_key', 'shared'],
};
const P2 = P3;
const HEX16 = /^[0-9a-f]{16}$/;

// Canaries: each names one kind of content no record may carry (NFR-004). The output canary is
// assembled at run time, so it is in the check's output and not in its command text.
const CANARY = {
  path: 'cnry-path-8d1e',
  file: 'cnry-file-3b7a',
  argv: 'cnry-argv-5c2f',
  env: 'cnry-env-9a4d',
  output: 'cnry-output-6e0b',
};
const OUTPUT_EXPR = "['cnry','output','6e0b'].join('-')";

/** Fixed Date.now (same report twice); the clock-fault preload also breaks the monotonic clock. */
const PRELOAD_DIR = suiteTempDir('doflow-verify-telemetry-preload-');
const FIXED_CLOCK = path.join(PRELOAD_DIR, 'fixed-clock.js');
const CLOCK_FAULT = path.join(PRELOAD_DIR, 'clock-fault.js');
fs.writeFileSync(FIXED_CLOCK, 'Date.now = () => 1792000000000;\n');
fs.writeFileSync(CLOCK_FAULT, "Date.now = () => 1792000000000;\nprocess.hrtime.bigint = () => { throw new Error('088 injected clock fault'); };\n");

function git(cwd, ...args) {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8', env: scratch.env() });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
}

/**
 * A scratch git project with a `.doflow/state/runs` store, a plan override naming every command,
 * and a LOW contract whose targeted tier falls back to the broad command (selection keys present).
 * `fail` makes the test command exit 1.
 */
function project({ fail = false } = {}) {
  const root = path.join(suiteTempDir('doflow-verify-telemetry-'), `proj-${CANARY.path}`);
  fs.mkdirSync(path.join(root, '.doflow', 'state', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'pkg'));
  git(root, 'init', '-q');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  const source = `src/${CANARY.file}.js`;
  const plan = `plan-${CANARY.file}.md`;
  fs.writeFileSync(path.join(root, source), 'module.exports = 1;\n');
  const testCommand = `node -e "console.log(${OUTPUT_EXPR}); process.exit(${fail ? 1 : 0})" ${CANARY.argv}`;
  const override = { parse: null, build: 'node -e 0', typecheck: null, lint: 'node -e 0', test: testCommand, testTargeted: 'node -e 0 {pattern}' };
  fs.writeFileSync(path.join(root, plan), `# Plan\n\n\`\`\`doflow-verification\n${JSON.stringify(override)}\n\`\`\`\n`);
  return { root, plan: path.join(root, plan), scope: `${source},${plan}` };
}

/** Telemetry on (scratch-env defaults it off), no inherited run identity, an env canary. */
function env(extra = {}) {
  return scratch.env({
    DOFLOW_TELEMETRY: 'on', DOFLOW_RUN_ID: undefined, DOFLOW_LINEAGE_ID: undefined, DOFLOW_ATTEMPT: undefined,
    DOFLOW_CONFIG_DIR: undefined, CANARY_SECRET: CANARY.env, ...extra,
  });
}

function verify(p, { cwd = p.root, preload = FIXED_CLOCK, extraEnv = {} } = {}) {
  return spawnSync(process.execPath, ['--require', preload, DOFLOW, 'verify', '--task-id', 'T-1', '--risk', 'LOW',
    '--plan-path', p.plan, '--scope', p.scope, '--json'], { cwd, env: env(extraEnv), encoding: 'utf8' });
}

const telemetryDir = (root) => path.join(root, '.doflow', 'state', 'runs', 'telemetry');

/** Every telemetry file's bytes, and its lines parsed. */
function readTelemetry(root) {
  const dir = telemetryDir(root);
  if (!fs.existsSync(dir)) return { bytes: '', lines: [] };
  const bytes = fs.readdirSync(dir).sort().map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('');
  return { bytes, lines: bytes.split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
}

const expectedKeys = (kind) => [...COMMON, ...P2[kind]];

/** The pass and fail fixtures, each run once with telemetry on, shared by the cases below. */
const runs = {};
function fixtureRun(name) {
  if (!runs[name]) {
    const p = project({ fail: name === 'fail' });
    const res = verify(p);
    runs[name] = { p, res, report: JSON.parse(res.stdout), telemetry: readTelemetry(p.root) };
  }
  return runs[name];
}

test('the registry declares exactly the IC-006 P2 and P3 keys for the three verify kinds', () => {
  for (const kind of KINDS) {
    const fields = REGISTRY.kinds[kind].fields;
    assert.deepEqual(Object.keys(fields), P3[kind], kind);
    for (const [key, field] of Object.entries(fields)) assert.ok(['P2', 'P3'].includes(field.phase), `${kind}.${key}`);
  }
});

for (const name of ['pass', 'fail']) {
  test(`${name} fixture: one verify.run, one verify.tier per tier, one verify.check per check, P3 keys`, () => {
    const { res, report, telemetry } = fixtureRun(name);
    assert.equal(res.status, name === 'pass' ? 0 : 1, res.stderr);
    assert.equal(report.status, name === 'pass' ? 'PASS' : 'FAIL');
    const { lines } = telemetry;
    assert.ok(lines.length > 0, 'telemetry was written');
    assert.deepEqual([...new Set(lines.map((line) => line.kind))].sort(), [...KINDS].sort());
    for (const line of lines) assert.deepEqual(Object.keys(line), expectedKeys(line.kind), `${line.kind} keys`);

    const [run, ...rest] = lines;
    assert.equal(run.kind, 'verify.run', 'the run line comes first');
    assert.match(run.verify_id, HEX16);
    assert.deepEqual({ source: run.source, task: run.task, risk: run.risk, status: run.status },
      { source: 'verb', task: 'T-1', risk: 'LOW', status: report.status });
    assert.equal(run.timestamp, report.startedAt);
    assert.deepEqual([run.run, run.lineage, run.attempt], [null, null, null]);
    assert.equal(run.exit_code, name === 'pass' ? 0 : 1);
    assert.ok(typeof run.duration_ms === 'number' && run.duration_ms >= 0);
    assert.ok(typeof run.checks_run === 'number' && run.checks_run > 0);
    for (const line of rest) assert.equal(line.verify_id, run.verify_id, 'one verify id per run');

    const tiers = lines.filter((line) => line.kind === 'verify.tier');
    assert.deepEqual(tiers.map((line) => [line.tier, line.status]), report.tiers.map((tier) => [tier.id, tier.status]));
    const targeted = tiers.find((line) => line.tier === 'targeted-tests');
    assert.deepEqual([targeted.selection_basis, targeted.selected, targeted.total, targeted.fallback], ['none', null, null, 'not-scopable']);
    assert.ok(typeof targeted.duration_ms === 'number' && targeted.duration_ms >= 0);
    const build = tiers.find((line) => line.tier === 'build');
    assert.deepEqual([build.selection_basis, build.selected, build.total, build.fallback], [null, null, null, null]);

    const checks = lines.filter((line) => line.kind === 'verify.check');
    const reportChecks = report.tiers.flatMap((tier) => tier.checks.map((check) => [tier.id, check.status]));
    assert.deepEqual(checks.map((line) => [line.tier, line.status]), reportChecks);
    if (name === 'fail') assert.ok(checks.some((line) => line.tier === 'targeted-tests' && line.status === 'FAIL'));
    for (const check of checks) {
      assert.ok(['none', 'in-run'].includes(check.shared), `check.shared ${check.shared}`);
      if (check.status !== 'NOT_RUN') {
        assert.ok(typeof check.duration_ms === 'number', 'duration_ms is number');
      }
    }
  });
}

test('the committed verify fixture lines carry the keys a real verify run writes, per kind (G45.1 input)', () => {
  const fixture = fs.readFileSync(VERIFY_FIXTURE, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(fixture.map((line) => line.kind), KINDS);
  const written = fixtureRun('pass').telemetry.lines;
  for (const line of fixture) {
    const writtenKeys = Object.keys(written.find((w) => w.kind === line.kind));
    for (const key of Object.keys(line)) {
      assert.ok(writtenKeys.includes(key), `${line.kind} missing ${key}`);
    }
  }
});

test('no record carries a command, an output, a path, a file name or an env value (canaries)', () => {
  for (const name of ['pass', 'fail']) {
    const { p, telemetry } = fixtureRun(name);
    assert.ok(telemetry.bytes.length > 0);
    // The canaries really were reachable: the path is the project's, the output was produced.
    assert.ok(p.root.includes(CANARY.path) && p.plan.includes(CANARY.file));
    for (const [kind, canary] of Object.entries(CANARY)) {
      assert.equal(telemetry.bytes.includes(canary), false, `${name}: the ${kind} canary reached a record`);
    }
    assert.equal(telemetry.bytes.includes('node -e'), false, `${name}: command text reached a record`);
  }
  const log = fs.readdirSync(path.join(fixtureRun('fail').p.root, '.doflow', 'state', 'verification', 'logs'))
    .map((file) => fs.readFileSync(path.join(fixtureRun('fail').p.root, '.doflow', 'state', 'verification', 'logs', file), 'utf8')).join('');
  assert.ok(log.includes(CANARY.output), 'the output canary was in the check output the run saw');
});

test('verify --json, stderr and exit are byte-equal with telemetry on, off, writer-faulted and clock-faulted', () => {
  for (const fail of [false, true]) {
    const p = project({ fail });
    const on = verify(p);
    assert.ok(readTelemetry(p.root).lines.length > 0, 'telemetry on wrote lines');
    fs.rmSync(telemetryDir(p.root), { recursive: true, force: true });
    const off = verify(p, { extraEnv: { DOFLOW_TELEMETRY: 'off' } });
    assert.equal(fs.existsSync(telemetryDir(p.root)), false, 'off created nothing');
    fs.writeFileSync(telemetryDir(p.root), 'a file where the telemetry directory belongs\n');
    const writerFault = verify(p);
    fs.rmSync(telemetryDir(p.root), { force: true });
    const clockFault = verify(p, { preload: CLOCK_FAULT });
    for (const [label, other] of [['off', off], ['writer fault', writerFault], ['clock fault', clockFault]]) {
      assert.equal(other.stdout, on.stdout, `${fail ? 'fail' : 'pass'}: stdout on vs ${label}`);
      assert.equal(other.stderr, on.stderr, `${fail ? 'fail' : 'pass'}: stderr on vs ${label}`);
      assert.equal(other.status, on.status, `${fail ? 'fail' : 'pass'}: exit on vs ${label}`);
    }
    assert.equal(on.status, fail ? 1 : 0);
    assert.equal('durationMs' in JSON.parse(on.stdout).tiers.flatMap((tier) => tier.checks)[0], false, 'no timing field in the report');
  }
});

test('telemetry off writes nothing, creates no directory and touches no file system call', (t) => {
  const p = project();
  const res = verify(p, { extraEnv: { DOFLOW_TELEMETRY: 'off' } });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.existsSync(telemetryDir(p.root)), false);

  const calls = [];
  const spy = new Proxy({}, { get: (_, name) => (...args) => { calls.push(name); return fs[name](...args); } });
  emitVerifyTelemetry({
    report: { status: 'PASS', startedAt: '2026-10-17T00:00:00.000Z', finishedAt: '2026-10-17T00:00:01.000Z', tiers: [] },
    ctx: { source: 'verb', taskId: 'T-1', risk: 'LOW', exitCode: 0 },
    env: { DOFLOW_TELEMETRY: 'off' }, start: tempDir(t, 'doflow-verify-telemetry-off-'), fsImpl: spy,
  });
  assert.deepEqual(calls, []);
});

test('check durations are monotonic, timestamps never go backwards, and a tier duration is the sum of its checks', (t) => {
  const root = tempDir(t, 'doflow-verify-telemetry-engine-');
  const busy = (ms) => { const end = Date.now() + ms; while (Date.now() < end); };
  const exec = (command) => { busy(command.includes('slow') ? 25 : 8); return { status: 0, stdout: '', stderr: '' }; };
  const engine = new VerificationEngine({ cwd: root, repoRoot: REPO, exec });
  const planText = `\`\`\`doflow-verification\n${JSON.stringify({ parse: null, build: 'build slow', typecheck: 'typecheck', lint: 'lint', test: 'test' })}\n\`\`\`\n`;
  const contract = engine.compileContract({ taskId: 'T-1', riskLevel: 'MEDIUM', projectRoot: root, planText, scope: { allowedPaths: ['src/'] } });
  const report = engine.runContract(contract, { changedFiles: [] });
  const records = buildVerifyRecords({ report, metrics: engine.runner.metrics, ctx: { verifyId: 'a'.repeat(16), source: 'verb', taskId: 'T-1', risk: 'MEDIUM', exitCode: 1 } });

  const checks = records.filter((r) => r.kind === 'verify.check');
  assert.ok(checks.length >= 3, 'build, static-analysis and broad-tests ran');
  for (const check of checks) {
    assert.ok(Number.isInteger(check.duration_ms) && check.duration_ms >= 7, `${check.tier} measured ${check.duration_ms}`);
  }
  assert.ok(checks.find((c) => c.tier === 'build').duration_ms >= 24, 'the slow check measured its own time');
  const stamps = records.map((r) => Date.parse(r.timestamp));
  for (let i = 1; i < stamps.length; i += 1) assert.ok(stamps[i] >= stamps[i - 1], `timestamp ${i} went backwards`);
  for (const tier of records.filter((r) => r.kind === 'verify.tier')) {
    const own = checks.filter((c) => c.tier === tier.tier);
    assert.equal(tier.duration_ms, own.length ? own.reduce((sum, c) => sum + c.duration_ms, 0) : null, tier.tier);
  }
  const run = records[0];
  assert.equal(run.checks_run, checks.length);
  assert.ok(run.duration_ms >= 0);
  assert.deepEqual([run.level, run.v0, run.exit_code], [null, null, 1]);
  for (const check of checks) assert.deepEqual([check.check_key, check.shared], [null, 'none']);
});

test('the runner times an executed check in its metrics map and leaves an in-run duplicate unmeasured', () => {
  const runner = new VerificationContractRunner({ cwd: REPO, exec: () => ({ status: 0, stdout: '', stderr: '' }) });
  const cache = new Map();
  const first = runner.runCheck('a', 'same', 1000, cache);
  const second = runner.runCheck('b', 'same', 1000, cache);
  const missing = runner.runCheck('c', '', 1000, cache);
  assert.equal(second.deduplicated, true);
  const timing = runner.metrics.get(first);
  assert.ok(Number.isFinite(timing.startedAt) && timing.durationMs >= 0, JSON.stringify(timing));
  assert.deepEqual(Object.keys(first).sort(), ['command', 'exitCode', 'name', 'status', 'stderr', 'stdout'], 'no timing in the result');
  assert.equal(runner.metrics.has(second), false);
  assert.equal(runner.metrics.has(missing), false);

  const report = { status: 'PASS', startedAt: '2026-10-17T00:00:00.000Z', finishedAt: '2026-10-17T00:00:01.000Z', tiers: [{ id: 'broad-tests', status: 'PASS', checks: [first, second] }] };
  const records = buildVerifyRecords({ report, metrics: runner.metrics, ctx: { verifyId: 'b'.repeat(16), source: 'verb', taskId: 'T-1', risk: 'LOW', exitCode: 0 } });
  const [, tier, executed, duplicate] = records;
  assert.equal(duplicate.duration_ms, 0, 'an in-run duplicate costs nothing');
  assert.equal(tier.duration_ms, executed.duration_ms + duplicate.duration_ms);
  assert.equal(records[0].checks_run, 1, 'checks_run counts executed checks only');

  const broken = new VerificationContractRunner({ cwd: REPO, exec: () => ({ status: 0, stdout: '', stderr: '' }) });
  const saved = process.hrtime.bigint;
  process.hrtime.bigint = () => { throw new Error('clock fault'); };
  let result;
  try { result = broken.runCheck('a', 'cmd'); } finally { process.hrtime.bigint = saved; }
  assert.equal(result.status, 'PASS', 'a clock fault changes no verdict');
  assert.equal(broken.metrics.get(result).durationMs, null);
});

test('a dispatch verification writes one verify.run with source dispatch and no content', { skip: process.platform === 'win32' && 'POSIX process groups' }, async (t) => {
  const root = tempDir(t, `doflow-verify-telemetry-dispatch-${CANARY.path}-`);
  const worktree = path.join(root, 'integration');
  fs.mkdirSync(worktree);
  fs.mkdirSync(path.join(root, '.doflow', 'state', 'runs'), { recursive: true });
  const base = { PATH: path.join(root, 'bin'), HOME: root, CANARY_SECRET: CANARY.env, DOFLOW_RUN_ID: 'p-0123456789ab', DOFLOW_LINEAGE_ID: 'lin-verify', DOFLOW_ATTEMPT: '1' };
  const argv = (code) => [process.execPath, '-e', `console.log(${OUTPUT_EXPR}); process.exit(${code}) // ${CANARY.argv}`];
  const pass = await runVerification({ root, slug: 'feat-v', taskId: 'A.1', worktree, argv: argv(0), seconds: 30, env: base });
  const fail = await runVerification({ root, slug: 'feat-v', taskId: 'A.1', worktree, argv: argv(3), seconds: 30, env: base });
  assert.deepEqual([pass.exitCode, fail.exitCode], [0, 3]);

  const { bytes, lines } = readTelemetry(root);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.deepEqual(Object.keys(line), expectedKeys('verify.run'));
  assert.deepEqual(lines.map((line) => [line.source, line.task, line.risk, line.status]), [['dispatch', 'A.1', null, 'PASS'], ['dispatch', 'A.1', null, 'FAIL']]);
  assert.deepEqual(lines.map((line) => line.dispatch_run), [null, null]);
  assert.deepEqual([lines[0].run, lines[0].lineage, lines[0].attempt], ['p-0123456789ab', 'lin-verify', 1]);
  assert.notEqual(lines[0].verify_id, lines[1].verify_id);
  for (const [kind, canary] of Object.entries(CANARY)) assert.equal(bytes.includes(canary), false, `the ${kind} canary reached a record`);

  const withId = await runVerification({ root, slug: 'feat-v', taskId: 'A.1', worktree, argv: argv(0), seconds: 30, env: base, dispatchRunId: 'p-f0ad33b51b70' });
  assert.equal(withId.exitCode, 0);
  const updatedLines = readTelemetry(root).lines;
  assert.equal(updatedLines.length, 3);
  assert.equal(updatedLines[2].dispatch_run, 'p-f0ad33b51b70');

  const off = await runVerification({ root, slug: 'feat-v', taskId: 'A.1', worktree, argv: argv(0), seconds: 30, env: { ...base, DOFLOW_TELEMETRY: 'off' } });
  assert.equal(off.exitCode, 0);
  assert.equal(readTelemetry(root).lines.length, 3, 'off wrote nothing');
});

test('a fault anywhere in the emit never throws and writes nothing for the part it touches', (t) => {
  const root = tempDir(t, 'doflow-verify-telemetry-fault-');
  fs.mkdirSync(path.join(root, '.doflow', 'state', 'runs'), { recursive: true });
  const report = { status: 'PASS', startedAt: '2026-10-17T00:00:00.000Z', finishedAt: '2026-10-17T00:00:01.000Z', tiers: [{ id: 'build', status: 'PASS', checks: [{ status: 'PASS', exitCode: 0 }] }] };
  const ctx = { source: 'verb', taskId: 'T-1', risk: 'LOW', exitCode: 0 };
  const throwing = new Proxy({}, { get: () => () => { throw new Error('fs fault'); } });
  const hostile = new Proxy({}, { get: () => { throw new Error('hostile report'); } });
  const cases = [
    { report, ctx, env: {}, start: root, fsImpl: throwing },
    { report, ctx, env: {}, start: root, now: () => { throw new Error('clock fault'); } },
    { report: hostile, ctx, env: {}, start: root },
    { report: null, ctx: null, env: {}, start: root },
    { report, ctx, env: {}, start: root, metrics: { get: () => { throw new Error('metrics fault'); } } },
    { report: { ...report, startedAt: 'not a time', tiers: [{ id: 'x y', status: 'WEIRD', checks: [null] }] }, ctx, env: {}, start: root },
  ];
  for (const options of cases) assert.doesNotThrow(() => emitVerifyTelemetry(options));
  const { lines } = readTelemetry(root);
  for (const line of lines) assert.deepEqual(Object.keys(line), expectedKeys(line.kind));
  const odd = lines.filter((line) => line.kind === 'verify.tier' && line.tier === null);
  assert.equal(odd.length, 1, 'a value failing its type is written as null, never echoed');
  assert.equal(odd[0].status, null);
});

test('a failing verify inside a subdirectory writes to the store found by walk-up, also once its log fragment exists', () => {
  const p = project({ fail: true });
  const cwd = path.join(p.root, 'pkg');
  const first = verify(p, { cwd });
  assert.equal(first.status, 1, first.stderr);
  // Since 088 D.1-fix the failing check's log goes to the resolved store, so no fragment forms (round 3
  // §1 row 4b, verify-state-root.test.js); one left by an older runtime must not stop telemetry either.
  assert.equal(fs.existsSync(path.join(cwd, '.doflow')), false, 'the failing check made no cwd-rooted fragment');
  fs.mkdirSync(path.join(cwd, '.doflow', 'state', 'verification', 'logs'), { recursive: true });
  const second = verify(p, { cwd });
  assert.equal(second.status, 1, second.stderr);
  assert.equal(second.stdout.length > 0, true);
  const runLines = readTelemetry(p.root).lines.filter((line) => line.kind === 'verify.run');
  assert.equal(runLines.length, 2, 'both runs reached the project store');
  assert.equal(fs.existsSync(path.join(cwd, '.doflow', 'state', 'runs')), false, 'nothing was written under the fragment');
});

test('outside any project store the verify verb writes nothing (no global fallback)', (t) => {
  const p = project();
  fs.rmSync(path.join(p.root, '.doflow', 'state', 'runs'), { recursive: true });
  const home = path.join(scratch.home, '.doflow', 'state', 'runs');
  fs.mkdirSync(home, { recursive: true });
  t.after(() => fs.rmSync(path.join(scratch.home, '.doflow'), { recursive: true, force: true }));
  const res = verify(p);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.existsSync(path.join(home, 'telemetry')), false, 'the global store stays empty');
  assert.equal(fs.existsSync(telemetryDir(p.root)), false);
});

test('checkKey: equal inputs give equal check_key', () => {
  const { checkKey } = require('../../src/runtime/verification/check-key.ts');
  const input = {
    command: 'npm test',
    timeoutMs: 60000,
    cwd: REPO,
    head: '0123456789abcdef0123456789abcdef01234567',
    tree: 'fedcba9876543210fedcba9876543210fedcba98',
    env: { PATH: '/bin:/usr/bin', NODE_ENV: 'test' },
  };
  const key1 = checkKey(input);
  const key2 = checkKey({ ...input });
  assert.ok(typeof key1 === 'string' && key1.length === 16);
  assert.equal(key1, key2);
});

test('checkKey: a dirty file or a NODE_OPTIONS change gives a different key', () => {
  const { checkKey } = require('../../src/runtime/verification/check-key.ts');
  const base = {
    command: 'npm test',
    timeoutMs: 60000,
    cwd: REPO,
    head: '0123456789abcdef0123456789abcdef01234567',
    tree: 'fedcba9876543210fedcba9876543210fedcba98',
    env: { PATH: '/bin:/usr/bin', NODE_ENV: 'test' },
  };
  const baseKey = checkKey(base);
  const dirtyTreeKey = checkKey({ ...base, tree: 'dirtytree9876543210fedcba9876543210fedcba' });
  assert.notEqual(baseKey, dirtyTreeKey, 'different treeDigest gives different key');

  const nodeOptionsKey = checkKey({ ...base, env: { ...base.env, NODE_OPTIONS: '--max-old-space-size=4096' } });
  assert.notEqual(baseKey, nodeOptionsKey, 'NODE_OPTIONS change gives different key');
});

test('checkKey: /tmp and /private/tmp equal', () => {
  const { checkKey } = require('../../src/runtime/verification/check-key.ts');
  if (process.platform === 'darwin') {
    const inputTmp = {
      command: 'echo 1',
      timeoutMs: 1000,
      cwd: '/tmp',
      head: '0123456789abcdef0123456789abcdef01234567',
      tree: 'fedcba9876543210fedcba9876543210fedcba98',
      env: { PATH: '/bin' },
    };
    const inputPrivateTmp = { ...inputTmp, cwd: '/private/tmp' };
    const keyTmp = checkKey(inputTmp);
    const keyPrivateTmp = checkKey(inputPrivateTmp);
    assert.ok(keyTmp !== null);
    assert.equal(keyTmp, keyPrivateTmp, '/tmp and /private/tmp must resolve to equal check keys');
  }
});

test('checkKey: more than 500 files gives null', (t) => {
  const { treeDigest, checkKey } = require('../../src/runtime/verification/check-key.ts');
  const dir = tempDir(t, 'doflow-check-key-500-');
  git(dir, 'init', '-q');
  const fakeEntries = Array.from({ length: 501 }, (_, i) => `?? file_${i}.txt`).join('\0') + '\0';
  const spawnSyncStub = (cmd, args) => {
    if (args.includes('--porcelain=v1')) {
      return { status: 0, stdout: fakeEntries, stderr: '' };
    }
    return spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' });
  };
  const digest = treeDigest(dir, { spawnSyncImpl: spawnSyncStub });
  assert.equal(digest, null, 'treeDigest returns null for > 500 files');

  const key = checkKey({
    command: 'npm test',
    timeoutMs: 60000,
    cwd: dir,
    head: '0123456789abcdef0123456789abcdef01234567',
    tree: digest,
  });
  assert.equal(key, null, 'checkKey returns null when tree is null');
});

test('buildVerifyRecords: NOT_RUN gives duration_ms null and checks_run counts executed only', () => {
  const report = {
    status: 'FAIL',
    startedAt: '2026-10-17T00:00:00.000Z',
    finishedAt: '2026-10-17T00:00:02.000Z',
    tiers: [
      {
        id: 'targeted-tests',
        status: 'FAIL',
        checks: [
          { name: 'executed_check', command: 'node test1.js', status: 'FAIL', exitCode: 1 },
          { name: 'not_run_check', command: 'node test2.js', status: 'NOT_RUN' },
          { name: 'dedup_check', command: 'node test1.js', status: 'FAIL', exitCode: 1, deduplicated: true },
        ],
      },
    ],
  };
  const metrics = new WeakMap();
  metrics.set(report.tiers[0].checks[0], {
    startedAt: 1792000000000,
    durationMs: 150.4,
    tests: 10,
    testsFailed: 1,
    cpuMs: null,
    resourceBasis: 'unreached-platform',
    checkKey: '0123456789abcdef',
    shared: 'none',
  });

  const records = buildVerifyRecords({
    report,
    metrics,
    ctx: { verifyId: 'c'.repeat(16), source: 'verb', taskId: 'T-1', risk: 'LOW', exitCode: 1 },
  });

  const runRecord = records.find((r) => r.kind === 'verify.run');
  const checkRecords = records.filter((r) => r.kind === 'verify.check');

  assert.equal(runRecord.checks_run, 1, 'checks_run counts executed only (1 executed, 1 NOT_RUN, 1 dedup)');
  assert.equal(checkRecords[0].status, 'FAIL');
  assert.equal(checkRecords[0].duration_ms, 150);
  assert.equal(checkRecords[0].shared, 'none');
  assert.equal(checkRecords[0].check_key, '0123456789abcdef');

  assert.equal(checkRecords[1].status, 'NOT_RUN');
  assert.equal(checkRecords[1].duration_ms, null, 'NOT_RUN check must have duration_ms null');

  assert.equal(checkRecords[2].status, 'FAIL');
  assert.equal(checkRecords[2].duration_ms, 0, 'deduplicated check has duration_ms 0');
  assert.equal(checkRecords[2].shared, 'in-run');
  assert.equal(checkRecords[2].check_key, '0123456789abcdef', 'deduplicated check gets executed check_key');
});

