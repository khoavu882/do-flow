'use strict';

// Feature 081 C.3 (IC-011, IC-017 view, IC-019, IC-025; DEC-005, DEC-025, DEC-032, DEC-036,
// DEC-038, DEC-042, DEC-054): the worker command in src/runtime/worker/command.ts.
//
// Each case builds a project with plan.md, a started 080 run and an active attempt on A.1 whose
// execution worktree is its own git repository, and calls the command in process with the fake
// worker descriptors injected (DEC-036). Every spawned binary is the fake harness CLI linked into a
// scratch bin/; the child PATH is that bin/ plus the node directory and git, and the caller env sets
// every DOFLOW_* identity variable explicitly (NFR-002). Process cases are POSIX only (DEC-008).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.js');
const { linkBin, writeScenario } = require('../helper/fake-harness-cli.js');
const DESCRIPTORS = require('../fixtures/worker/descriptors.json');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const { executeWorkerCommand, handleWorkerCommand, ACTIONS } = require(path.join(SRC, 'worker', 'command.ts'));
const { storeFileFor, newRunId, insertRun, readRuns, transition } = require(path.join(SRC, 'worker', 'run-store.ts'));
const { launchEnv, launchRecord } = require(path.join(SRC, 'worker', 'launch.ts'));
const readiness = require(path.join(SRC, 'worker', 'readiness.ts'));
const tree = require(path.join(SRC, 'worker', 'process-tree.ts'));
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const { runKeyFor } = require(path.join(SRC, 'task-run.ts'));

const SLUG = 'feat-c';
const POSIX = { skip: process.platform === 'win32' && 'worker process control is unverified on win32 (DEC-008)' };
const PLAN = ['# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js', ''].join('\n');
const SUCCESS = { type: 'result', status: 'success', summary: 'all done' };
const FAKES = { claude: DESCRIPTORS.claude, gemini: DESCRIPTORS.gemini };
const GIT = (process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'git'))
  .find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });

function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return env;
}

function gitRepo(t) {
  const dir = tempDir(t, 'doflow-worker-cmd-wt-');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, env: gitEnv(), stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'readme\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(dir, '.doflow', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.doflow', 'state', '.gitignore'), '*\n');
  return dir;
}

/**
 * A project with an active attempt on A.1. `mode` is the claim's mode; `execWorktree` 'own' is a
 * separate git repository, 'self' the project itself, 'plain' a directory outside any work tree.
 */
function project(t, { scenario = {}, mode = 'subagent', execWorktree: where = 'own' } = {}) {
  const dir = fs.realpathSync(tempDir(t, 'doflow-worker-cmd-'));
  fs.mkdirSync(path.join(dir, '.git'));
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, PLAN);
  fs.mkdirSync(path.join(dir, 'config'));
  let execWorktree = dir;
  if (where === 'own') execWorktree = fs.realpathSync(gitRepo(t));
  if (where === 'plain') execWorktree = fs.realpathSync(tempDir(t, 'doflow-worker-cmd-plain-'));
  const childPath = linkBin(path.join(dir, 'bin'), ['fake-claude', 'fake-gemini']);
  fs.symlinkSync(GIT, path.join(dir, 'bin', 'git'));
  const env = {
    PATH: childPath,
    HOME: dir,
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    TMPDIR: process.env.TMPDIR || '/tmp',
    FAKE_HARNESS_SCENARIO: writeScenario(dir, scenario),
    DOFLOW_RUN_ID: 'r1',
    DOFLOW_LINEAGE_ID: 'main',
    DOFLOW_SESSION_ROLE: 'main',
    DOFLOW_WORKTREE: dir,
  };
  delete env.DOFLOW_ATTEMPT;
  const key = runKeyFor(env, dir);
  const ledger = attempts.storeFile(dir, SLUG);
  const common = { file: ledger, fsImpl: fs, roots: [dir], slug: SLUG, env, cwd: dir };
  assert.equal(attempts.start({ ...common, by: 'main' }).disposition, 'started');
  const claimed = attempts.claim({ ...common, task: 'A.1', owner: 'core-implementer', mode, epoch: 1, execWorktree });
  assert.equal(claimed.disposition, 'claimed', JSON.stringify(claimed));
  const store = storeFileFor(dir, SLUG);
  const promptFile = path.join(dir, 'prompt.md');
  fs.writeFileSync(promptFile, 'do the task');
  const token = claimed.token;
  const withSlug = (options) => (['run', 'status', 'cancel'].includes(options.action) ? { slug: SLUG, ...options } : options);
  const cmd = (options) => executeWorkerCommand({ descriptors: FAKES, env, cwd: dir, ...withSlug(options) });
  const run = (options = {}) => cmd({ action: 'run', harness: 'claude', task: 'A.1', token, promptFile, timeoutSeconds: 60, ...options });
  const probe = async () => {
    const probed = await readiness.probe({ descriptors: FAKES, env, cwd: dir });
    assert.equal(probed.disposition, 'probed');
  };
  const ledgerBytes = () => fs.readFileSync(ledger);
  const attempt = () => JSON.parse(fs.readFileSync(ledger, 'utf8')).tasks['A.1'].attempts.find((a) => a.token === token);
  return { dir, env, key, ledger, store, token, execWorktree, promptFile, cmd, run, probe, ledgerBytes, attempt };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A process that has exited, as `{ pid, pgid, start }`. */
function deadProc() {
  const done = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  return { pid: done.pid, pgid: done.pid, start: 'Thu Jan  1 00:00:00 1970' };
}

/** Inserts a hand-built run on the project's claim, then applies `edit` by transition. */
function seedRun(p, edit) {
  const runId = newRunId();
  const descriptor = DESCRIPTORS.claude;
  const { identity } = launchEnv({ env: p.env, runKey: p.key.runKey, token: p.token, execWorktree: p.execWorktree, runId });
  const record = {
    runId, task: 'A.1', token: p.token, harness: 'claude', phase: 'starting', execWorktree: p.execWorktree,
    createdAt: new Date().toISOString(), timeoutSeconds: 60,
    caller: { cwd: p.dir, runKey: p.key.runKey, run: 'r1', lineage: 'main', attempt: null, role: 'main', lineageKind: p.key.identity.lineageKind },
    ...launchRecord(descriptor, identity, 'do the task'),
    descriptor,
    prompt: { path: p.promptFile, sha256: crypto.createHash('sha256').update('do the task').digest('hex'), bytes: 11 },
    needs: [],
  };
  assert.equal(insertRun(p.store, record).applied, true);
  if (edit) assert.equal(transition(p.store, runId, ['starting'], edit).applied, true);
  return runId;
}

async function waitEnded(p, runId, ms = 15000) {
  const until = Date.now() + ms;
  let run = readRuns(p.store)[runId];
  while (run && run.phase !== 'ended' && Date.now() < until) {
    await sleep(100);
    run = readRuns(p.store)[runId];
  }
  return run;
}

// ── IC-011: refusals in step order, each writing nothing ──────────────────────────────────────

test('every IC-011 refusal comes in step order, exits 1 and writes nothing', POSIX, async (t) => {
  const p = project(t);
  await p.probe();
  const before = p.ledgerBytes();
  const cases = [
    ['worker-session', { env: { ...p.env, DOFLOW_SESSION_ROLE: 'worker' } }],
    ['identity-solo', { env: { ...p.env, DOFLOW_LINEAGE_ID: '!solo' } }],
    ['no-active-attempt', { slug: 'feat-none' }],
    ['no-active-attempt', { task: 'A.2' }],
    ['token-mismatch', { token: p.token + 1 }],
    ['foreign-run', { env: { ...p.env, DOFLOW_RUN_ID: 'r2' } }],
    ['identity-collision', { env: { ...p.env, DOFLOW_ATTEMPT: String(p.token) } }],
    ['harness-ineligible', { harness: 'gemini' }],
  ];
  for (const [reason, options] of cases) {
    const { exit, body } = await p.run(options);
    assert.equal(exit, 1, reason);
    assert.equal(body.disposition, 'refused', JSON.stringify(body));
    assert.equal(body.reason, reason, JSON.stringify(body));
    assert.equal(fs.existsSync(p.store), false, `${reason} wrote no run store`);
    assert.deepEqual(p.ledgerBytes(), before, `${reason} left the ledger as it was`);
  }
  const mismatch = await p.run({ token: p.token + 1 });
  assert.equal(mismatch.body.activeToken, p.token);
  const ineligible = await p.run({ harness: 'gemini' });
  assert.ok(ineligible.body.gaps.some((gap) => gap.requirement === 'read-only'), JSON.stringify(ineligible.body.gaps));
});

test('an unprobed harness is harness-ineligible with its gaps', POSIX, async (t) => {
  const p = project(t);
  const { exit, body } = await p.run();
  assert.equal(exit, 1);
  assert.equal(body.reason, 'harness-ineligible');
  assert.deepEqual(body.gaps.find((gap) => gap.requirement === 'installed'), { requirement: 'installed', result: 'unknown', reason: 'not-probed' });
  assert.equal(fs.existsSync(p.store), false);
});

test('token-out-of-range refuses a token above 9999', POSIX, async (t) => {
  const p = project(t);
  await p.probe();
  const data = JSON.parse(fs.readFileSync(p.ledger, 'utf8'));
  data.tasks['A.1'].attempts[0].token = 10000;
  fs.writeFileSync(p.ledger, JSON.stringify(data));
  const before = p.ledgerBytes();
  const { exit, body } = await p.run({ token: 10000 });
  assert.equal(exit, 1);
  assert.equal(body.reason, 'token-out-of-range');
  assert.equal(fs.existsSync(p.store), false);
  assert.deepEqual(p.ledgerBytes(), before);
});

test('mode-mismatch comes before harness eligibility for a sequential claim', POSIX, async (t) => {
  const p = project(t, { mode: 'sequential' });
  // gemini is ineligible (readOnly unknown); the mode check must still answer first.
  const { exit, body } = await p.run({ harness: 'gemini' });
  assert.equal(exit, 1);
  assert.deepEqual([body.reason, body.mode], ['mode-mismatch', 'sequential']);
  assert.equal(fs.existsSync(p.store), false);
});

test('the execution worktree must exist, be a work tree and not be the caller\'s own', POSIX, async (t) => {
  const missing = project(t);
  await missing.probe();
  fs.rmSync(missing.execWorktree, { recursive: true, force: true });
  assert.equal((await missing.run()).body.reason, 'exec-worktree-missing');

  const plain = project(t, { execWorktree: 'plain' });
  await plain.probe();
  assert.equal((await plain.run()).body.reason, 'exec-worktree-unverifiable');

  const shared = project(t, { execWorktree: 'self' });
  await shared.probe();
  const { exit, body } = await shared.run();
  assert.equal(exit, 1);
  assert.deepEqual([body.reason, body.execWorktree], ['exec-worktree-shared', shared.dir]);
  for (const p of [missing, plain, shared]) assert.equal(fs.existsSync(p.store), false);
});

// ── IC-025: malformed values and misplaced flags are exit 2 ───────────────────────────────────

test('malformed --task, --token, --timeout-seconds and --worker-run values are exit 2 usage', async (t) => {
  const p = project(t);
  const bad = [
    { action: 'run', harness: 'claude', task: 'A1', token: p.token, promptFile: p.promptFile },
    { action: 'run', harness: 'claude', task: 'A.1', token: '1x', promptFile: p.promptFile },
    { action: 'run', harness: 'claude', task: 'A.1', token: p.token, promptFile: p.promptFile, timeoutSeconds: '0' },
    { action: 'run', harness: 'claude', task: 'A.1', token: p.token, promptFile: p.promptFile, timeoutSeconds: '14401' },
    { action: 'run', harness: 'claude', task: 'A.1', token: p.token, promptFile: p.promptFile, timeoutSeconds: '5s' },
    { action: 'status', workerRun: 'w-XYZ' },
    { action: 'cancel', workerRun: 'w-0000000000', by: 'main', reason: 'stop' },
    { action: 'run', harness: 'claude', task: 'A.1', token: p.token, promptFile: path.join(p.dir, 'absent.md') },
    { action: 'run', harness: 'nope', task: 'A.1', token: p.token, promptFile: p.promptFile },
    { action: 'run', harness: 'claude', task: 'A.1', token: p.token, promptFile: p.promptFile, need: 'bogus' },
    { action: 'status', wait: true, workerRun: 'w-000000000000' },
    { action: 'discover', harness: 'claude' },
    { action: 'describe', task: 'A.1' },
    { action: 'select', promptFile: p.promptFile },
    { action: 'cancel', workerRun: 'w-000000000000', by: 'main' },
    { action: 'status' },
    { action: 'bogus' },
    {},
  ];
  for (const options of bad) {
    const { exit, body } = await p.cmd(options);
    assert.equal(exit, 2, JSON.stringify(options));
    assert.deepEqual([body.ok, body.error], [false, 'usage'], JSON.stringify({ options, body }));
  }
  assert.equal(fs.existsSync(p.store), false);
});

test('a torn run store is exit 2 store-unreadable', async (t) => {
  const p = project(t);
  fs.mkdirSync(path.dirname(p.store), { recursive: true });
  fs.writeFileSync(p.store, '{ torn');
  const { exit, body } = await p.cmd({ action: 'status', workerRun: 'w-000000000000' });
  assert.equal(exit, 2);
  assert.equal(body.error, 'store-unreadable');
});

test('handleWorkerCommand maps dispositions to exits 0, 1 and 2', async (t) => {
  const p = project(t);
  const logs = [];
  t.mock.method(console, 'log', (line) => logs.push(line));
  t.mock.method(console, 'error', (line) => logs.push(line));
  const saved = process.exitCode;
  t.after(() => { process.exitCode = saved; });
  const base = { descriptors: FAKES, env: p.env, cwd: p.dir, slug: SLUG, json: true };
  assert.equal(await handleWorkerCommand({ ...base, slug: null, action: 'discover' }), 0);
  assert.equal(JSON.parse(logs.pop()).disposition, 'discovered');
  assert.equal(await handleWorkerCommand({ ...base, slug: null, action: 'select' }), 1);
  assert.equal(JSON.parse(logs.pop()).disposition, 'none-eligible');
  assert.equal(await handleWorkerCommand({ ...base, action: 'status', workerRun: 'w-000000000000' }), 1);
  assert.deepEqual(JSON.parse(logs.pop()), { disposition: 'refused', reason: 'unknown-run', runId: 'w-000000000000' });
  assert.equal(await handleWorkerCommand({ ...base, action: 'status', wait: true }), 2);
  assert.equal(JSON.parse(logs.pop()).error, 'usage');
  assert.equal(await handleWorkerCommand({ ...base, action: 'status', task: 'A.1', token: p.token, json: false }), 0);
  assert.match(logs.pop(), /^status task A\.1 token \d+ no run$/);
  process.exitCode = saved;
  assert.deepEqual(ACTIONS, ['discover', 'probe', 'describe', 'select', 'run', 'status', 'cancel']);
});

// ── Started runs, run-exists, status and cancel ───────────────────────────────────────────────

test('a started run returns started with its deadline; a second run on the token is run-exists', POSIX, async (t) => {
  const p = project(t, { scenario: { run: [{ sleep: 30000 }] } });
  await p.probe();
  const before = p.ledgerBytes();
  const started = Date.now();
  const { exit, body } = await p.run();
  t.diagnostic(`run returned in ${Date.now() - started} ms`);
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(body.disposition, 'started');
  assert.equal(body.phase, 'running');
  assert.match(body.runId, /^w-[0-9a-f]{12}$/);
  assert.deepEqual([body.task, body.token, body.harness, body.execWorktree], ['A.1', p.token, 'claude', p.execWorktree]);
  const record = readRuns(p.store)[body.runId];
  t.after(() => { try { process.kill(-record.worker.pid, 'SIGKILL'); } catch { /* ended */ } });
  assert.equal(body.deadline, record.deadline);
  assert.equal(Date.parse(record.deadline) - Date.parse(record.startedAt), 60000);
  // DEC-054: what the insert wrote.
  assert.deepEqual(record.descriptor, DESCRIPTORS.claude);
  assert.equal(record.timeoutSeconds, 60);
  assert.deepEqual(record.prompt, { path: p.promptFile, sha256: crypto.createHash('sha256').update('do the task').digest('hex'), bytes: 11 });
  assert.equal(record.recipe.binary, 'fake-claude');
  assert.equal(record.envInherited, true);
  assert.equal(record.envSet.length, 5);
  assert.deepEqual(record.identity, { run: 'r1', lineage: 'main', attempt: String(p.token), runSource: 'claim' });
  assert.deepEqual(record.caller, { cwd: p.dir, runKey: p.key.runKey, run: 'r1', lineage: 'main', attempt: null, role: 'main', lineageKind: p.key.identity.lineageKind });
  assert.ok(record.supervisor && record.supervisor.pid, 'the supervisor pid is recorded');
  assert.ok(record.needs.some((n) => n.requirement === 'installed' && n.at));

  const again = await p.run();
  assert.equal(again.exit, 1);
  assert.deepEqual([again.body.reason, again.body.runId, again.body.phase], ['run-exists', body.runId, 'running']);

  const status = await p.cmd({ action: 'status', workerRun: body.runId });
  assert.equal(status.exit, 0);
  assert.equal(status.body.state, 'running');
  assert.equal(status.body.attemptActive, true);
  assert.equal(status.body.verified, null);
  assert.equal(status.body.resultOffered, false);
  assert.deepEqual(p.ledgerBytes(), before, 'run and status leave the ledger byte-identical');

  const foreign = await p.cmd({ action: 'cancel', workerRun: body.runId, by: 'other', reason: 'stop', env: { ...p.env, DOFLOW_RUN_ID: 'r2' } });
  assert.deepEqual([foreign.exit, foreign.body.reason], [1, 'foreign-run']);
  const cancelled = await p.cmd({ action: 'cancel', task: 'A.1', token: p.token, by: 'main', reason: 'stop now' });
  assert.equal(cancelled.exit, 0, JSON.stringify(cancelled.body));
  assert.deepEqual([cancelled.body.disposition, cancelled.body.endState, cancelled.body.attemptCancelled], ['cancelled', 'cancelled', true]);
  assert.equal(cancelled.body.cleanup.status, 'verified');
  assert.equal(p.attempt().state, 'cancelled');
  const after = await p.cmd({ action: 'status', task: 'A.1', token: p.token });
  assert.equal(after.body.state, 'cancelled');
  assert.equal(after.body.attemptActive, false);
  assert.deepEqual(after.body.verified, { state: 'cancelled', result: null, evidenceId: null });
  assert.equal(tree.groupAlive(record.worker.pgid, record.worker.start), false);
  await waitEnded(p, body.runId);
});

test('--wait returns the ended run with the three outcomes kept apart', POSIX, async (t) => {
  const p = project(t, { scenario: { run: [{ emit: SUCCESS }] } });
  await p.probe();
  const before = p.ledgerBytes();
  const started = Date.now();
  const { exit, body } = await p.run({ wait: true });
  t.diagnostic(`run --wait returned in ${Date.now() - started} ms`);
  assert.equal(exit, 0, JSON.stringify(body));
  assert.equal(body.disposition, 'started');
  assert.equal(body.state, 'exited');
  assert.equal(body.process.kind, 'exited');
  assert.equal(body.report.status, 'success');
  assert.equal(body.readOnly.status, 'clean');
  assert.deepEqual([body.resultOffered, body.withheld], [true, []]);
  assert.equal(body.verified, null, 'a success report changes no task state (DEC-010)');
  assert.equal(body.attemptActive, true);
  assert.equal(body.output.stdout.path, `worker-output/${body.runId}.out.log`);
  assert.equal(Object.hasOwn(readRuns(p.store)[body.runId], 'resultOffered'), false);
  assert.deepEqual(p.ledgerBytes(), before);
  const ended = await p.cmd({ action: 'cancel', workerRun: body.runId, by: 'main', reason: 'late' });
  assert.deepEqual([ended.exit, ended.body.reason], [1, 'run-ended']);
});

// ── IC-019: status derivation ─────────────────────────────────────────────────────────────────

test('status reads lost runs unknown and writes nothing', POSIX, async (t) => {
  const p = project(t);
  const dead = deadProc();
  const lostRunning = seedRun(p, (run) => {
    run.phase = 'running';
    run.supervisor = dead;
    run.worker = dead;
    run.startedAt = new Date(Date.now() - 120000).toISOString();
    run.deadline = new Date(Date.now() - 60000).toISOString();
  });
  const storeBefore = fs.readFileSync(p.store);
  const ledgerBefore = p.ledgerBytes();
  const lost = await p.cmd({ action: 'status', workerRun: lostRunning });
  assert.equal(lost.exit, 0);
  assert.deepEqual([lost.body.state, lost.body.reason], ['unknown', 'process-lost']);
  assert.deepEqual(fs.readFileSync(p.store), storeBefore, 'status writes nothing to the run store');
  assert.deepEqual(p.ledgerBytes(), ledgerBefore);

  const other = project(t);
  const lostStarting = seedRun(other, (run) => { run.supervisor = dead; });
  const starting = await other.cmd({ action: 'status', task: 'A.1', token: other.token });
  assert.deepEqual([starting.body.state, starting.body.reason], ['unknown', 'supervisor-lost']);
  assert.equal(starting.body.runId, lostStarting);

  const none = await other.cmd({ action: 'status', task: 'A.1', token: other.token + 1 });
  assert.deepEqual([none.exit, none.body], [0, { disposition: 'status', run: null, task: 'A.1', token: other.token + 1 }]);
  const unknown = await other.cmd({ action: 'status', workerRun: 'w-000000000000' });
  assert.deepEqual([unknown.exit, unknown.body.reason], [1, 'unknown-run']);
});

test('a live supervisor with a dead worker reads running, overdue and supervisorLost false', POSIX, async (t) => {
  const p = project(t);
  const me = { pid: process.pid, pgid: process.pid, start: tree.procStart(process.pid) };
  const runId = seedRun(p, (run) => {
    run.phase = 'running';
    run.supervisor = me;
    run.worker = deadProc();
    run.deadline = new Date(Date.now() - 1000).toISOString();
  });
  const { body } = await p.cmd({ action: 'status', workerRun: runId });
  assert.deepEqual([body.state, body.supervisorLost, body.overdue, body.cancel], ['running', false, true, null]);
});

test('settledStatus reads a run ended between its record read and the liveness probe as ended, and a run never ended as lost', POSIX, async (t) => {
  const { settledStatus } = require(path.join(SRC, 'worker', 'command.ts'));
  const ledger = (p) => JSON.parse(fs.readFileSync(p.ledger, 'utf8'));
  const opts = { platform: process.platform, nowMs: Date.now() };
  const seedLost = (p) => {
    const dead = deadProc();
    return seedRun(p, (run) => { Object.assign(run, { phase: 'running', supervisor: dead, worker: dead, deadline: new Date(Date.now() + 60000).toISOString() }); });
  };

  // The supervisor's end lands after the first read and before the probe, then the supervisor exits.
  const p = project(t);
  const runId = seedLost(p);
  let reads = 0;
  const racing = (file) => {
    reads += 1;
    const runs = readRuns(file);
    if (reads === 1) {
      transition(file, runId, ['running'], (r) => { r.end = { state: 'exited', at: new Date().toISOString() }; r.phase = 'ended'; });
    }
    return runs;
  };
  const settled = settledStatus(p.store, runId, ledger(p), opts, racing);
  assert.equal(reads, 2, 'a not-ended record whose processes are gone is read again after the probe');
  assert.deepEqual([settled.run.phase, settled.view.state, settled.view.reason], ['ended', 'exited', null]);

  // A record still not ended after the probe is lost, as before.
  const q = project(t);
  const lostId = seedLost(q);
  const lost = settledStatus(q.store, lostId, ledger(q), opts);
  assert.deepEqual([lost.run.phase, lost.view.state, lost.view.reason], ['running', 'unknown', 'process-lost']);
  assert.equal(settledStatus(q.store, 'w-000000000000', ledger(q), opts).view, null, 'a missing run has no view');
});

test('cancel of an unknown run refuses the caller identity first, then unknown-run', async (t) => {
  const p = project(t);
  const worker = await p.cmd({ action: 'cancel', task: 'A.1', token: p.token, by: 'w', reason: 'x', env: { ...p.env, DOFLOW_SESSION_ROLE: 'worker' } });
  assert.deepEqual([worker.exit, worker.body.reason], [1, 'worker-session']);
  const none = await p.cmd({ action: 'cancel', task: 'A.1', token: p.token, by: 'main', reason: 'x' });
  assert.deepEqual([none.exit, none.body.reason], [1, 'unknown-run']);
  assert.equal(fs.existsSync(p.store), false);
});

test('DEC-063 the supervisor spawn forwards only allowlisted execArgv entries', () => {
  const { allowedExecArgv } = require(path.join(SRC, 'worker', 'command.ts'));
  assert.deepEqual(allowedExecArgv(['-e', 'code', '--inspect', '--experimental-strip-types']), ['--experimental-strip-types']);
  assert.deepEqual(allowedExecArgv([
    '-p', 'x', '--eval=y', '--print', '--watch', '--watch-path=src', '--inspect-brk=9229', '--test', '--test-only', '--require', 'r.js',
    '--experimental-transform-types', '--no-experimental-strip-types', '--no-warnings', '--disable-warning=ExperimentalWarning',
  ]), ['--experimental-transform-types', '--no-experimental-strip-types', '--no-warnings', '--disable-warning=ExperimentalWarning']);
  // `--disable-warning <x>` in two elements is dropped whole: the value would otherwise be read as the script.
  assert.deepEqual(allowedExecArgv(['--disable-warning', 'ExperimentalWarning', '--disable-warning=']), []);
});
