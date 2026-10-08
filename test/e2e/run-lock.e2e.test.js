'use strict';
// run-lock.e2e.test.js — one case per run-lock scenario, through the real bin/doflow.js in a scratch
// HOME. A lock holder is a child process that takes the lock through src/state/run-lock.js and
// keeps it until the test creates a release file, so no case depends on how long a run takes: the
// test waits for the run's own output and then releases the holder. Every wait is bounded.
const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const RUN_LOCK_MODULE = path.join(REPO, 'src', 'state', 'run-lock.js');
const { IS_WIN } = require('../helper-platform');
const { createScratch } = require('../helper/scratch-env');

const CASE_TIMEOUT_MS = 180_000;
const WAIT_LIMIT_MS = 60_000;
const SCRATCHES = [];
after(() => { for (const scratch of SCRATCHES) scratch.remove(); });

function newScratch() {
  const scratch = createScratch('doflow-run-lock-');
  SCRATCHES.push(scratch);
  return scratch;
}

function spawnEnv(scratch) {
  const env = scratch.env({ GIT_CONFIG_GLOBAL: '/dev/null' });
  if (IS_WIN) env.USERPROFILE = scratch.home;
  return env;
}

/** Starts bin/doflow.js with no stdin; `result` settles on exit and `seen()` is the output so far. */
function startDoflow(scratch, args) {
  const child = spawn(process.execPath, [DOFLOW, ...args], { cwd: scratch.dir, env: spawnEnv(scratch), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, result, seen: () => ({ stdout, stderr }) };
}

function runDoflow(scratch, args) {
  return startDoflow(scratch, args).result;
}

function runDoflowSync(scratch, args) {
  return spawnSync(process.execPath, [DOFLOW, ...args], { cwd: scratch.dir, env: spawnEnv(scratch), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `predicate()` is truthy, or fails the case after `limitMs`. */
async function waitUntil(predicate, what, limitMs = WAIT_LIMIT_MS) {
  const deadline = Date.now() + limitMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out after ${limitMs} ms waiting for ${what}`);
    await sleep(10);
  }
}

const installArgs = (targets) => ['install', '-g', '-t', targets, '-f', '--mcp', 'none'];
const ledgerPath = (scratch) => path.join(scratch.home, '.doflow', 'state', 'ledger.json');
const lockPath = (scratch) => path.join(scratch.home, '.doflow', 'state', 'run.lock');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const countLines = (text, pattern) => text.split('\n').filter((line) => pattern.test(line)).length;

/** Ledger rows per harness. */
function rowCounts(scratch) {
  const counts = {};
  for (const resource of readJson(ledgerPath(scratch)).resources) counts[resource.harness] = (counts[resource.harness] ?? 0) + 1;
  return counts;
}

let baselineCounts;
/** Row counts of `install pi` then `install kiro`, run one after the other in a scratch of their own. */
function sequentialBaseline() {
  if (!baselineCounts) {
    const scratch = newScratch();
    for (const target of ['pi', 'kiro']) {
      const r = runDoflowSync(scratch, installArgs(target));
      assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    }
    baselineCounts = rowCounts(scratch);
  }
  return baselineCounts;
}

/**
 * A child that takes the run lock for the scratch home, prints `held`, and keeps it until
 * `releaseFile` exists or `maxHoldMs` has passed, then releases.
 */
async function startHolder(scratch, { maxHoldMs }) {
  const releaseFile = path.join(scratch.dir, 'release-holder');
  const script = `
    const { acquireRunLock } = require(${JSON.stringify(RUN_LOCK_MODULE)});
    const fs = require('node:fs');
    const handle = acquireRunLock({ scopeRoot: ${JSON.stringify(scratch.home)}, scope: 'global', command: 'install' });
    process.stdout.write('held\\n');
    const slice = new Int32Array(new SharedArrayBuffer(4));
    const until = Date.now() + ${Number(maxHoldMs)};
    while (Date.now() < until && !fs.existsSync(${JSON.stringify(releaseFile)})) Atomics.wait(slice, 0, 0, 25);
    handle.release();
  `;
  const child = spawn(process.execPath, ['-e', script], { cwd: scratch.dir, env: spawnEnv(scratch), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('close', (status, signal) => resolve({ status, signal })));
  await Promise.race([
    waitUntil(() => stdout.includes('held'), 'the lock holder to take the lock'),
    exited.then(() => assert.fail(`the lock holder exited before holding the lock: ${stderr}`)),
  ]);
  return {
    release() { fs.writeFileSync(releaseFile, ''); return exited; },
    async stop() { child.kill('SIGKILL'); await exited; },
  };
}

/** The pid of a process that has already exited. */
function deadPid() {
  const finished = spawnSync(process.execPath, ['-e', '']);
  return finished.pid;
}

function plantStaleLock(scratch) {
  fs.mkdirSync(path.dirname(lockPath(scratch)), { recursive: true });
  fs.writeFileSync(lockPath(scratch), `${JSON.stringify({
    version: 1, token: crypto.randomBytes(16).toString('hex'), pid: deadPid(), hostname: os.hostname(), command: 'install',
    scope: 'global', scopeRoot: scratch.home, startedAt: new Date().toISOString(), doflowVersion: '0.0.0',
  })}\n`);
}

for (let rep = 1; rep <= 3; rep += 1) {
  test(`parallel installs of two harnesses both complete and keep every row (repetition ${rep})`, { timeout: CASE_TIMEOUT_MS }, async () => {
    const expected = sequentialBaseline();
    const scratch = newScratch();
    const pi = startDoflow(scratch, installArgs('pi'));
    const kiro = startDoflow(scratch, installArgs('kiro'));
    const [piResult, kiroResult] = await Promise.all([pi.result, kiro.result]);
    assert.strictEqual(piResult.status, 0, piResult.stderr + piResult.stdout);
    assert.strictEqual(kiroResult.status, 0, kiroResult.stderr + kiroResult.stdout);

    assert.deepStrictEqual(rowCounts(scratch), expected);
    const ledger = readJson(ledgerPath(scratch));
    assert.strictEqual(ledger.version, 2);
    const lock = readJson(path.join(scratch.home, '.doflow', 'doflow.lock'));
    assert.strictEqual(lock.version, 1);
    assert.deepStrictEqual(lock.targets.map((target) => target.harness).sort(), ['kiro', 'pi']);
    assert.ok(!fs.existsSync(lockPath(scratch)), 'no run lock is left behind');
  });
}

test('remove after parallel installs retains the shared files and keeps the other harness', { timeout: CASE_TIMEOUT_MS }, async () => {
  const scratch = newScratch();
  const [piResult, kiroResult] = await Promise.all([runDoflow(scratch, installArgs('pi')), runDoflow(scratch, installArgs('kiro'))]);
  assert.strictEqual(piResult.status, 0, piResult.stderr + piResult.stdout);
  assert.strictEqual(kiroResult.status, 0, kiroResult.stderr + kiroResult.stdout);
  const piRows = rowCounts(scratch).pi;
  assert.ok(piRows > 0, 'pi owns rows after the parallel installs');

  const removed = await runDoflow(scratch, ['remove', '-g', '-t', 'kiro', '-f']);
  assert.strictEqual(removed.status, 0, removed.stderr + removed.stdout);
  assert.match(removed.stdout, /retained/);
  assert.strictEqual(rowCounts(scratch).pi, piRows);
  assert.ok(fs.existsSync(path.join(scratch.home, '.doflow', 'runtime')), 'the shared runtime stays');
});

test('a run waits for a live holder, says so once, and proceeds when the holder releases', { timeout: CASE_TIMEOUT_MS }, async () => {
  const scratch = newScratch();
  const holder = await startHolder(scratch, { maxHoldMs: WAIT_LIMIT_MS });
  try {
    const run = startDoflow(scratch, installArgs('pi'));
    await waitUntil(() => /Waiting for another DoFlow run/.test(run.seen().stderr), 'the run to report that it is waiting');
    await holder.release();
    const result = await run.result;
    assert.strictEqual(result.status, 0, result.stderr + result.stdout);
    assert.strictEqual(countLines(result.stderr, /Waiting for another DoFlow run/), 1, result.stderr);
    assert.ok(fs.existsSync(ledgerPath(scratch)), 'the run installed once the lock was free');
  } finally {
    await holder.stop();
  }
});

test('a run that is waiting changes nothing until the holder releases', { timeout: CASE_TIMEOUT_MS }, async () => {
  const scratch = newScratch();
  const first = await runDoflow(scratch, installArgs('pi'));
  assert.strictEqual(first.status, 0, first.stderr + first.stdout);

  const holder = await startHolder(scratch, { maxHoldMs: WAIT_LIMIT_MS });
  try {
    const before = sha256(ledgerPath(scratch));
    const run = startDoflow(scratch, installArgs('kiro'));
    await waitUntil(() => /Waiting for another DoFlow run/.test(run.seen().stderr), 'the run to report that it is waiting');
    await sleep(1000);
    assert.strictEqual(sha256(ledgerPath(scratch)), before, 'the ledger is untouched while the run waits');
    assert.ok(!fs.existsSync(path.join(scratch.home, '.kiro')), 'nothing was installed while the run waits');
    await holder.release();
    const result = await run.result;
    assert.strictEqual(result.status, 0, result.stderr + result.stdout);
    assert.ok(rowCounts(scratch).kiro > 0, 'the run installed after the holder released');
  } finally {
    await holder.stop();
  }
});

test('a run killed with SIGKILL leaves a lock the next run clears and says so', { timeout: CASE_TIMEOUT_MS, skip: IS_WIN || process.getuid?.() === 0 }, async () => {
  // The kill must land while the run still holds its lock; a run that finishes first is not a
  // crash, so that attempt is discarded and a fresh scratch is tried.
  let scratch;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    scratch = newScratch();
    const doomed = startDoflow(scratch, installArgs('kiro'));
    await waitUntil(() => fs.existsSync(lockPath(scratch)) || doomed.seen().stderr.length > 0, 'the run to take its lock');
    doomed.child.kill('SIGKILL');
    const killed = await doomed.result;
    if (killed.signal === 'SIGKILL') break;
    assert.notStrictEqual(attempt, 5, 'the run finished before it could be killed in five attempts');
  }
  assert.ok(fs.existsSync(lockPath(scratch)), 'the killed run left its lock');

  const next = await runDoflow(scratch, installArgs('kiro'));
  assert.strictEqual(next.status, 0, next.stderr + next.stdout);
  const cleared = next.stderr.split('\n').filter((line) => /Cleared a stale DoFlow run lock/.test(line));
  assert.strictEqual(cleared.length, 1, next.stderr);
  assert.match(cleared[0], /that process is not running/);
  assert.ok(!fs.existsSync(lockPath(scratch)));
});

test('two runs that find one stale lock clear it once between them and both finish', { timeout: CASE_TIMEOUT_MS }, async () => {
  const expected = sequentialBaseline();
  const scratch = newScratch();
  plantStaleLock(scratch);
  const [piResult, kiroResult] = await Promise.all([runDoflow(scratch, installArgs('pi')), runDoflow(scratch, installArgs('kiro'))]);
  assert.strictEqual(piResult.status, 0, piResult.stderr + piResult.stdout);
  assert.strictEqual(kiroResult.status, 0, kiroResult.stderr + kiroResult.stdout);
  const clearedLines = countLines(piResult.stderr, /Cleared a stale DoFlow run lock/) + countLines(kiroResult.stderr, /Cleared a stale DoFlow run lock/);
  assert.strictEqual(clearedLines, 1, `${piResult.stderr}\n${kiroResult.stderr}`);
  assert.deepStrictEqual(rowCounts(scratch), expected);
});

test('status, list-backups and a dry run do not wait for a holder', { timeout: CASE_TIMEOUT_MS }, async () => {
  const scratch = newScratch();
  const holder = await startHolder(scratch, { maxHoldMs: WAIT_LIMIT_MS });
  try {
    const readOnly = [['status', '-g'], ['list-backups', '-g'], ['install', '-g', '-t', 'pi', '--dry-run', '--mcp', 'none']];
    for (const args of readOnly) {
      const started = Date.now();
      const result = await runDoflow(scratch, args);
      assert.strictEqual(result.status, 0, `${args.join(' ')}: ${result.stderr}${result.stdout}`);
      assert.ok(Date.now() - started < 10_000, `${args.join(' ')} finished within 10 s`);
      assert.doesNotMatch(result.stdout + result.stderr, /Waiting for another DoFlow run/, args.join(' '));
    }
  } finally {
    await holder.stop();
  }
});

test('an uncontended run prints no run-lock line', { timeout: CASE_TIMEOUT_MS }, async () => {
  const scratch = newScratch();
  const result = await runDoflow(scratch, installArgs('pi'));
  assert.strictEqual(result.status, 0, result.stderr + result.stdout);
  assert.doesNotMatch(result.stdout + result.stderr, /Waiting for another DoFlow run|Cleared a stale DoFlow run lock|run lock/);
});
