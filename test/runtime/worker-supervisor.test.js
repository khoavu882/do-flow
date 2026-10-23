'use strict';

// Feature 081 C.2 (IC-014, IC-017 recorded half, IC-018, IC-020 timer; DEC-010, DEC-022, DEC-028,
// DEC-033, DEC-037, DEC-040): the supervisor in src/runtime/worker/supervisor.ts.
//
// Each case builds a project with plan.md, a started 080 run and an active subagent attempt on A.1
// whose execution worktree is a real git repository, then inserts one `starting` run the way the
// run command will: launchEnv + launchRecord for the reduced fields, the full fake worker block as
// `descriptor`, the prompt as `{ path, sha256, bytes }`. The supervisor runs in process through
// superviseRun(), and once detached through SUPERVISOR_FILE (RK5). Every worker is the fake harness
// CLI linked into a scratch bin/; the child PATH is that bin/ plus the node directory, and the
// caller env sets every DOFLOW_* identity variable explicitly (NFR-002). POSIX only (DEC-008).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.js');
const { linkBin, writeScenario } = require('../helper/fake-harness-cli.js');
const DESCRIPTORS = require('../fixtures/worker/descriptors.json');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const { SUPERVISOR_FILE, OUTPUT_MAX_BYTES, MASK_TAIL, superviseRun, createOutputSink, resultOfRun } = require(path.join(SRC, 'worker', 'supervisor.ts'));
const { cancelRun } = require(path.join(SRC, 'worker', 'cancel.ts'));
const { storeFileFor, newRunId, insertRun, readRuns, transition } = require(path.join(SRC, 'worker', 'run-store.ts'));
const { launchEnv, launchRecord, launchWorker } = require(path.join(SRC, 'worker', 'launch.ts'));
const tree = require(path.join(SRC, 'worker', 'process-tree.ts'));
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const { runKeyFor } = require(path.join(SRC, 'task-run.ts'));
const { stateDir } = require(path.join(SRC, 'context', 'identity.ts'));

const SLUG = 'feat-s';
const POSIX = { skip: process.platform === 'win32' && 'worker process control is unverified on win32 (DEC-008)' };
const PLAN = ['# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js', ''].join('\n');
const SUCCESS = { type: 'result', status: 'success', summary: 'all done' };
/** The git binary this test process resolves, by absolute path. */
const GIT = (process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'git'))
  .find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });

function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return env;
}

/** A real git repository with one commit, the run's execution worktree. */
function gitRepo(t) {
  const dir = tempDir(t, 'doflow-worker-sup-wt-');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, env: gitEnv(), stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'readme\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'init');
  // IC-015: the worker's own DoFlow state is outside the check because `.doflow/state/.gitignore`
  // is `*`, as storage upkeep writes it in a DoFlow project; the launch emission writes there.
  fs.mkdirSync(path.join(dir, '.doflow', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.doflow', 'state', '.gitignore'), '*\n');
  return dir;
}

/** A project, an active subagent attempt, a scratch bin/ and a caller env with every identity variable set. */
function project(t, scenario = {}) {
  const dir = tempDir(t, 'doflow-worker-sup-');
  fs.mkdirSync(path.join(dir, '.git'));
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, PLAN);
  fs.mkdirSync(path.join(dir, 'config'));
  const execWorktree = gitRepo(t);
  const childPath = linkBin(path.join(dir, 'bin'), ['fake-claude']);
  // The supervisor's read-only snapshot runs git from its inherited PATH; git is linked into the
  // scratch bin/ so the PATH stays that bin/ plus the node directory (NFR-002).
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
    DOFLOW_ROLE: 'main',
    DOFLOW_WORKTREE: dir,
  };
  delete env.DOFLOW_ATTEMPT;
  const key = runKeyFor(env, dir);
  const ledger = attempts.storeFile(dir, SLUG);
  const common = { file: ledger, fsImpl: fs, roots: [dir], slug: SLUG, env, cwd: dir };
  assert.equal(attempts.start({ ...common, by: 'main' }).disposition, 'started');
  const claimed = attempts.claim({ ...common, task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1, execWorktree });
  assert.equal(claimed.disposition, 'claimed');
  const store = storeFileFor(dir, SLUG);
  const token = claimed.token;

  /** Inserts a `starting` run on the claim; `edit(descriptor)` and `fields` change it first. */
  const seed = ({ edit, timeoutSeconds = 60, prompt = 'do the task', fields = {} } = {}) => {
    const runId = newRunId();
    const descriptor = JSON.parse(JSON.stringify(DESCRIPTORS.claude));
    if (edit) edit(descriptor);
    const { identity } = launchEnv({ env, runKey: key.runKey, token, execWorktree, runId });
    const promptFile = path.join(dir, `prompt-${runId}.md`);
    fs.writeFileSync(promptFile, prompt);
    const record = {
      runId, task: 'A.1', token, harness: 'claude', phase: 'starting', execWorktree,
      createdAt: new Date().toISOString(), timeoutSeconds,
      caller: { cwd: dir, runKey: key.runKey, run: key.identity.run, lineage: key.identity.lineage, attempt: null, role: 'main', lineageKind: key.identity.lineageKind },
      ...launchRecord(descriptor, identity, prompt),
      descriptor,
      prompt: { path: promptFile, sha256: crypto.createHash('sha256').update(prompt).digest('hex'), bytes: Buffer.byteLength(prompt) },
      needs: [],
      ...fields,
    };
    assert.equal(insertRun(store, record).applied, true);
    return { runId, promptFile, identity };
  };
  const supervise = (runId, extra = {}) => superviseRun({ file: store, runId, env, cwd: dir, ...extra });
  const attempt = () => JSON.parse(fs.readFileSync(ledger, 'utf8')).tasks['A.1'].attempts.find((a) => a.token === token);
  const killAfter = (run) => t.after(() => { try { process.kill(-run.worker.pid, 'SIGKILL'); } catch { /* ended */ } });
  return { dir, env, key, ledger, store, token, execWorktree, seed, supervise, attempt, killAfter, run: (id) => readRuns(store)[id] };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Exits and the three outcomes ──────────────────────────────────────────────────────────────

test('exit 0 with a success report ends exited with resultOffered computed true', POSIX, async (t) => {
  const p = project(t, { run: [{ emit: SUCCESS }] });
  const { runId } = p.seed();
  const run = await p.supervise(runId);
  assert.equal(run.phase, 'ended');
  assert.deepEqual(run.end && run.end.state, 'exited');
  assert.equal(run.process.kind, 'exited');
  assert.equal(run.process.code, 0);
  assert.equal(run.readOnly.status, 'clean');
  assert.equal(run.report.status, 'success');
  assert.equal(run.report.summary, 'all done');
  assert.ok(run.launchingAt && run.startedAt && run.deadline);
  assert.equal(Date.parse(run.deadline) - Date.parse(run.startedAt), 60000);
  assert.equal(run.worker.pid, run.worker.pgid);
  assert.deepEqual(resultOfRun(run), { resultOffered: true, withheld: [] });
  assert.equal(Object.hasOwn(run, 'resultOffered'), false, 'resultOffered is never stored');
  assert.equal(p.attempt().state, 'active', 'the supervisor never finishes the attempt (DEC-010)');
});

test('a worker that writes a file ends with read-only-violation withheld', POSIX, async (t) => {
  const p = project(t, { run: [{ write: { path: 'touched.txt', content: 'x' } }, { emit: SUCCESS }] });
  const { runId } = p.seed();
  const run = await p.supervise(runId);
  assert.equal(run.end.state, 'exited');
  assert.equal(run.readOnly.status, 'violated');
  assert.deepEqual(run.readOnly.changes, [{ path: 'touched.txt', change: 'added' }]);
  assert.deepEqual(resultOfRun(run), { resultOffered: false, withheld: ['read-only-violation'] });
});

test('a soft denial with exit 0 is report-denied', POSIX, async (t) => {
  const p = project(t, { run: [{ emit: [{ type: 'permission-denied', action: 'write', detail: 'a.js' }, SUCCESS] }, { exit: 0 }] });
  const { runId } = p.seed();
  const run = await p.supervise(runId);
  assert.equal(run.process.code, 0);
  assert.equal(run.report.status, 'denied');
  assert.equal(run.report.deniedCount, 1);
  assert.deepEqual(resultOfRun(run), { resultOffered: false, withheld: ['report-denied'] });
});

test('launchObserved follows the unit binding', POSIX, async (t) => {
  const bound = project(t, { run: [{ emit: SUCCESS }] });
  const a = bound.seed();
  const unit = `L.${a.identity.run}.${a.identity.lineage}.${bound.token}`;
  const binding = path.join(stateDir(bound.env), 'sessions', unit, 'bound');
  fs.mkdirSync(path.dirname(binding), { recursive: true });
  fs.writeFileSync(binding, 'session-1\n');
  assert.equal((await bound.supervise(a.runId)).launchObserved, 'yes');

  const unbound = project(t, { run: [{ emit: SUCCESS }] });
  const b = unbound.seed();
  assert.equal((await unbound.supervise(b.runId)).launchObserved, 'no');
});

// ── Runs that never start ─────────────────────────────────────────────────────────────────────

test('a changed prompt file and an inactive attempt end not-started with nothing launched', POSIX, async (t) => {
  const changed = project(t, { run: [{ emit: SUCCESS }] });
  const c = changed.seed();
  fs.writeFileSync(c.promptFile, 'a different brief');
  const run = await changed.supervise(c.runId);
  assert.deepEqual([run.phase, run.end.state, run.process.kind, run.process.reason], ['ended', 'exited', 'not-started', 'prompt-changed']);
  assert.equal(run.launchingAt, undefined);
  assert.equal(run.worker, undefined);

  const inactive = project(t, { run: [{ emit: SUCCESS }] });
  const i = inactive.seed();
  attempts.cancel({ file: inactive.ledger, fsImpl: fs, roots: [inactive.dir], slug: SLUG, task: 'A.1', token: inactive.token, by: 'main', reason: 'gone', env: inactive.env, cwd: inactive.dir });
  const ended = await inactive.supervise(i.runId);
  assert.deepEqual([ended.process.kind, ended.process.reason], ['not-started', 'attempt-not-active']);
  assert.equal(ended.launchingAt, undefined);
  assert.deepEqual(resultOfRun(ended).withheld, ['not-exited', 'read-only-unverifiable', 'report-unparsed']);
});

test('an emitContext throw and ENOENT end not-started with the code', POSIX, async (t) => {
  const usage = project(t, { run: [{ emit: SUCCESS }] });
  // A default `local` run is not a launched identity, so the launch emission refuses it.
  const u = usage.seed({ fields: { identity: { run: 'local', lineage: 'main', attempt: '1', runSource: 'claim' } } });
  const run = await usage.supervise(u.runId);
  assert.deepEqual([run.process.kind, run.process.reason], ['not-started', 'USAGE_ERROR']);
  assert.ok(run.launchingAt, 'the launch began');
  assert.equal(run.worker, undefined);

  const absent = project(t);
  const a = absent.seed({ edit: (d) => { d.cli.binary = 'fake-absent'; } });
  const missing = await absent.supervise(a.runId);
  assert.deepEqual([missing.phase, missing.end.state, missing.process.kind, missing.process.reason], ['ended', 'exited', 'not-started', 'ENOENT']);
  assert.equal(missing.worker, undefined);
});

// ── Timeout, output and refused transitions ───────────────────────────────────────────────────

test('a 1-second timeout ends timed-out with the tree gone', POSIX, async (t) => {
  const p = project(t, { run: [{ spawnChild: { pidFile: 'child.pid' } }, { sleep: 8000 }] });
  const { runId } = p.seed({ timeoutSeconds: 1 });
  // The launch takes longer than the timeout: the deadline is counted from `running`, not before.
  const slowLaunch = async (options) => { await sleep(1500); return launchWorker(options); };
  const started = Date.now();
  const run = await p.supervise(runId, { launch: slowLaunch });
  t.diagnostic(`timeout case took ${Date.now() - started} ms`);
  assert.equal(run.phase, 'ended');
  assert.equal(run.end.state, 'timed-out');
  assert.ok(run.worker, 'the worker was recorded at running');
  assert.ok(Date.parse(run.end.at) - Date.parse(run.startedAt) >= 1000, 'the timer ran from running');
  assert.deepEqual(run.cancel && [run.cancel.by, run.cancel.reason, run.cancel.source], ['doflow-worker', 'timeout after 1s', 'timeout']);
  assert.equal(run.cleanup.status, 'verified');
  assert.equal(tree.alive(run.worker), false);
  assert.equal(tree.groupAlive(run.worker.pgid, run.worker.start), false, 'the tree is gone');
  assert.equal(p.attempt().state, 'cancelled');
  assert.equal(p.attempt().cancel.reason, 'timeout after 1s');
  assert.equal(resultOfRun(run).resultOffered, false);
  // S-1 (DEC-056): the step-6 fields are added to the ended run, and the end stays the canceller's.
  assert.equal(run.process && run.process.kind, 'exited', JSON.stringify(run.process ?? null));
  assert.equal(run.output && run.output.stdout.path, `worker-output/${runId}.out.log`);
  assert.ok(run.report, 'report recorded');
  assert.ok(run.readOnly, 'readOnly recorded');
  assert.ok(run.launchObserved, 'launchObserved recorded');
});

/**
 * `launchWorker` whose child delivers its exit only after `gate()` resolves, so the order of the
 * supervisor's step 6 and the canceller's step 5 is chosen by the test and not by the machine's load.
 */
function holdExit(gate) {
  return async (options) => {
    const launched = await launchWorker(options);
    const child = launched.child;
    const held = Object.create(child);
    Object.defineProperty(held, 'exitCode', { value: null });
    Object.defineProperty(held, 'signalCode', { value: null });
    held.once = (event, listener) => {
      if (event !== 'exit') { child.once(event, listener); return held; }
      child.once('exit', (code, signal) => { gate().then(() => listener(code, signal)); });
      return held;
    };
    return { ...launched, child: held };
  };
}

// The supervisor resolves the record as it stood when it was done (IC-014) and a user cancel's end is
// the canceller's write (step 7 awaits only a timeout's), so each order below reads the settled record
// from the store. Which of the two writes comes first depends on load; both orders are pinned here.
for (const order of ['canceller first', 'supervisor first']) {
  test(`a user cancel of a running supervised worker keeps the step-6 fields, ${order} (S-1, DEC-056)`, POSIX, async (t) => {
    const p = project(t, { run: [{ print: 'working' }, { sleep: 30000 }] });
    const { runId } = p.seed();
    const endWritten = async () => {
      const until = Date.now() + 60000;
      while (p.run(runId).phase !== 'ended' && Date.now() < until) await sleep(10);
    };
    let supervisorDone = false;
    const supervised = p.supervise(runId, order === 'canceller first' ? { launch: holdExit(endWritten) } : {})
      .finally(() => { supervisorDone = true; });
    const until = Date.now() + 60000;
    while (p.run(runId).phase !== 'running') {
      assert.ok(Date.now() < until, 'the run reached running');
      await sleep(20);
    }
    p.killAfter(p.run(runId));
    // Supervisor first: the canceller's step 5 waits for the supervisor to be done.
    const escalate = order === 'supervisor first'
      ? async (options) => {
        const outcome = await tree.escalate(options);
        while (!supervisorDone && Date.now() < until + 60000) await sleep(10);
        return outcome;
      }
      : tree.escalate;
    const answer = await cancelRun({ file: p.store, runId, by: 'main', reason: 'stop', env: p.env, cwd: p.dir, escalate });
    assert.equal(answer.disposition, 'cancelled');
    await supervised;
    const run = p.run(runId);
    assert.equal(run.phase, 'ended');
    assert.equal(run.end.state, 'cancelled');
    assert.equal(run.process && run.process.kind, 'exited', JSON.stringify(run.process ?? null));
    assert.equal(run.output && run.output.stdout.path, `worker-output/${runId}.out.log`);
    assert.ok(run.report && run.readOnly && run.launchObserved, 'report, readOnly and launchObserved recorded');
    assert.equal(run.cleanup.status, 'verified');
  });
}

test('a permission-denied event over 64 KiB still makes the report denied (S-2, DEC-057)', POSIX, async (t) => {
  const denial = { type: 'permission-denied', action: 'write', detail: 'd'.repeat(70000) };
  const p = project(t, { run: [{ emit: [denial, SUCCESS] }] });
  const { runId } = p.seed();
  const run = await p.supervise(runId);
  assert.equal(run.report.status, 'denied');
  assert.equal(run.report.deniedCount, 1);
  assert.ok(resultOfRun(run).withheld.includes('report-denied'));
});

test('a same-group child left after a clean exit is ended and recorded as process.leftover (S-4, DEC-058)', POSIX, async (t) => {
  const pidFile = path.join(tempDir(t, 'doflow-worker-sup-pid-'), 'child.pid');
  const p = project(t, { run: [{ spawnChild: { pidFile } }, { emit: SUCCESS }] });
  t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* ended */ } });
  const { runId } = p.seed();
  const run = await p.supervise(runId);
  const child = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(run.end.state, 'exited');
  assert.ok(run.process.leftover, 'process.leftover recorded');
  assert.equal(run.process.leftover.status, 'verified');
  assert.throws(() => process.kill(child, 0), { code: 'ESRCH' }, 'the leftover child was ended');
  assert.equal(tree.groupAlive(run.worker.pgid, run.worker.start), false);
  assert.deepEqual(resultOfRun(run), { resultOffered: true, withheld: [] });
});

test('a leftover the escalation cannot end withholds the result as group-survived (S-4, DEC-058)', POSIX, async (t) => {
  const pidFile = path.join(tempDir(t, 'doflow-worker-sup-pid-'), 'child.pid');
  const p = project(t, { run: [{ spawnChild: { pidFile } }, { emit: SUCCESS }] });
  t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* ended */ } });
  const { runId } = p.seed();
  const unkillable = (options) => tree.escalate({ ...options, kill: () => {}, graceMs: 0, finalMs: 0 });
  const run = await p.supervise(runId, { escalate: unkillable });
  const child = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(run.process.leftover && run.process.leftover.status, 'survivors');
  assert.deepEqual(run.process.leftover.survivors, [child]);
  assert.ok(resultOfRun(run).withheld.includes('group-survived'), JSON.stringify(resultOfRun(run)));
  assert.equal(resultOfRun(run).resultOffered, false);
});

test('output over 4 MiB is truncated with counted bytes and every line masked', POSIX, async (t) => {
  const line = (i) => `line ${String(i).padStart(6, '0')} password=hunter2secret9 lorem ipsum dolor sit amet consectetur adipiscing elit sed do`;
  const big = Array.from({ length: 50000 }, (_, i) => line(i)).join('\n');
  const p = project(t, { run: [{ print: big }, { emit: SUCCESS }] });
  const { runId } = p.seed();
  const run = await p.supervise(runId);
  const stdout = run.output.stdout;
  const raw = Buffer.byteLength(`${big}\n`) + Buffer.byteLength(`${JSON.stringify(SUCCESS)}\n`);
  assert.ok(raw > OUTPUT_MAX_BYTES);
  assert.equal(stdout.path, `worker-output/${runId}.out.log`);
  assert.equal(stdout.bytes, raw, 'every byte is counted');
  assert.equal(stdout.written, OUTPUT_MAX_BYTES);
  assert.equal(stdout.truncated, true);
  const file = path.join(p.dir, '.doflow', 'state', stdout.path);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(fs.statSync(file).size, OUTPUT_MAX_BYTES);
  assert.equal(text.includes('hunter2secret9'), false, 'no line keeps the secret');
  const lines = text.split('\n');
  for (const kept of lines.slice(0, -1)) assert.ok(kept.startsWith('line ') && kept.includes('password='), 'each kept line is a masked worker line');
  assert.equal(run.report.status, 'success', 'lines past the cap are still parsed');
  assert.deepEqual(run.output.stderr, { path: `worker-output/${runId}.err.log`, bytes: 0, written: 0, truncated: false });
});

test('createOutputSink hands a line over 65536 bytes whole to the parser and the masker (S-2, S-3, DEC-057)', async (t) => {
  const stateRoot = tempDir(t, 'doflow-worker-sink-');
  const runId = 'w-00000000000a';
  const lines = [];
  const sink = createOutputSink({ stateRoot, runId, stream: 'stderr', onLine: (text) => lines.push(text) });
  sink.write(`${'a '.repeat(40000)}\ntoken=abc123secret\n`);
  const summary = await sink.end();
  assert.deepEqual(lines.map((l) => l.length), [80000, 'token=abc123secret'.length]);
  const text = fs.readFileSync(path.join(stateRoot, summary.path), 'utf8');
  assert.equal(text.includes('abc123secret'), false);
  assert.equal(summary.truncated, false);
});

// In a worker thread so a regression (quadratic masking of the line) is terminated at the deadline
// instead of blocking the test process for minutes.
test('a 1 MiB dotless eyJ line is masked and end() resolves within 5 s (RR-1, DEC-069)', { timeout: 15000 }, async (t) => {
  const { Worker } = require('node:worker_threads');
  const stateRoot = tempDir(t, 'doflow-worker-sink-');
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { createOutputSink } = require(${JSON.stringify(path.join(SRC, 'worker', 'supervisor.ts'))});
    const sink = createOutputSink({ stateRoot: workerData.stateRoot, runId: 'w-00000000000e', stream: 'stdout', onLine: () => {} });
    const start = performance.now();
    sink.write('eyJ'.repeat(350000));
    sink.write('\\n');
    sink.end().then((summary) => parentPort.postMessage({ ms: performance.now() - start, summary }));`;
  const worker = new Worker(source, { eval: true, workerData: { stateRoot } });
  let timer;
  const result = await Promise.race([
    new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), 12000); }),
  ]);
  clearTimeout(timer);
  await worker.terminate();
  assert.ok(result, 'end() did not resolve within 12000 ms');
  assert.ok(result.ms < 5000, `end() resolved after ${Math.round(result.ms)} ms`);
  assert.equal(result.summary.truncated, false);
  assert.equal(result.summary.written, 350000 * 3 + 1);
});

test('a secret straddling the 64 KiB mark is masked in the file (S-3, DEC-057)', async (t) => {
  const stateRoot = tempDir(t, 'doflow-worker-sink-');
  const sink = createOutputSink({ stateRoot, runId: 'w-00000000000b', stream: 'stdout', onLine: () => {} });
  const token = `ghp_${'Z9'.repeat(18)}`;
  const line = `${'a'.repeat(65526)} ${token}\n`;
  for (let i = 0; i < line.length; i += 4096) sink.write(line.slice(i, i + 4096));
  const summary = await sink.end();
  const text = fs.readFileSync(path.join(stateRoot, summary.path), 'utf8');
  assert.equal(text.includes('ghp_'), false, 'no part of the token is written');
  assert.ok(text.includes('<masked>'));
});

test('a line over 4 MiB is one oversize event, masked and cut by MASK_TAIL before writing (S-2, S-3, DEC-057)', async (t) => {
  assert.ok(Number.isInteger(MASK_TAIL) && MASK_TAIL >= 1024);
  const stateRoot = tempDir(t, 'doflow-worker-sink-');
  const lines = [];
  const oversize = [];
  const sink = createOutputSink({
    stateRoot, runId: 'w-00000000000c', stream: 'stdout',
    onLine: (text) => lines.push(text), onOversize: (looksJson) => oversize.push(looksJson),
  });
  // The token starts 10 bytes before the 4 MiB cut, so the buffered prefix ends in an unmaskable piece of it.
  const filler = ` ${'b '.repeat((OUTPUT_MAX_BYTES - 12) / 2)}`;
  const big = `{${filler}ghp_${'A'.repeat(36)}${' tail'.repeat(1000)}\nafter\n`;
  assert.equal(Buffer.byteLength(`{${filler}`), OUTPUT_MAX_BYTES - 10);
  for (let i = 0; i < big.length; i += 65536) sink.write(big.slice(i, i + 65536));
  const summary = await sink.end();
  assert.deepEqual(oversize, [true]);
  assert.deepEqual(lines, ['after'], 'the oversize line never reaches onLine');
  const text = fs.readFileSync(path.join(stateRoot, summary.path), 'utf8');
  assert.equal(text.includes('ghp_'), false, 'the cut-off token prefix is dropped');
  assert.ok(text.endsWith('\nafter\n'));
  assert.ok(summary.written <= OUTPUT_MAX_BYTES);
  assert.equal(summary.truncated, true);
});

test('an output file write error marks the sink failed and end() still resolves (S-12, DEC-065)', POSIX, async (t) => {
  const stateRoot = tempDir(t, 'doflow-worker-sink-');
  const dir = path.join(stateRoot, 'worker-output');
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o500); // tempDir's cleanup restores owner write before removing it
  const lines = [];
  const sink = createOutputSink({ stateRoot, runId: 'w-00000000000d', stream: 'stdout', onLine: (text) => lines.push(text) });
  sink.write('one\n');
  await sleep(50);
  sink.write('two\n');
  const summary = await sink.end();
  assert.equal(summary.failed, 'EACCES');
  assert.equal(summary.truncated, true);
  assert.deepEqual(lines, ['one', 'two'], 'the parser is still fed');
});

test('a refused transition after spawn kills the worker and records supervisorCleanup', POSIX, async (t) => {
  const p = project(t, { run: [{ spawnChild: { pidFile: 'child.pid' } }, { sleep: 30000 }] });
  const { runId } = p.seed();
  let worker = null;
  const cancelDuringLaunch = async (options) => {
    const launched = await launchWorker(options);
    worker = { pid: launched.child.pid, pgid: launched.child.pid, start: tree.procStart(launched.child.pid) };
    t.after(() => { try { process.kill(-worker.pid, 'SIGKILL'); } catch { /* ended */ } });
    const taken = transition(p.store, runId, ['starting'], (run) => {
      run.phase = 'cancelling';
      run.cancel = { requestedAt: new Date().toISOString(), by: 'other', reason: 'stop', source: 'user' };
    });
    assert.equal(taken.applied, true);
    return launched;
  };
  const run = await p.supervise(runId, { launch: cancelDuringLaunch });
  assert.equal(run.phase, 'cancelling', 'the canceller owns the end');
  assert.equal(run.worker, undefined, 'running was refused');
  assert.equal(run.supervisorCleanup.worker.pid, worker.pid);
  assert.deepEqual(run.supervisorCleanup.survivors, []);
  assert.equal(tree.alive(worker), false);
  assert.equal(tree.groupAlive(worker.pgid, worker.start), false);
});

test('a supervisorCleanup on an ended run resolves an unknown cleanup', POSIX, async (t) => {
  const p = project(t, { run: [{ sleep: 30000 }] });
  const { runId } = p.seed();
  const endDuringLaunch = async (options) => {
    const launched = await launchWorker(options);
    t.after(() => { try { process.kill(-launched.child.pid, 'SIGKILL'); } catch { /* ended */ } });
    transition(p.store, runId, ['starting'], (run) => {
      const at = new Date().toISOString();
      run.cancel = { requestedAt: at, by: 'other', reason: 'stop', source: 'user' };
      run.cleanup = { status: 'unknown', reason: 'worker-unrecorded', survivors: [], zombies: [] };
      run.end = { state: 'cancelled', at };
      run.phase = 'ended';
    });
    return launched;
  };
  const run = await p.supervise(runId, { launch: endDuringLaunch });
  assert.equal(run.phase, 'ended');
  assert.ok(run.supervisorCleanup);
  assert.equal(run.cleanup.status, 'verified');
});

// ── Detached, as the run command spawns it ────────────────────────────────────────────────────

test('detached through SUPERVISOR_FILE the run ends exited with a success report', POSIX, async (t) => {
  const p = project(t, { run: [{ emit: SUCCESS }] });
  const { runId } = p.seed();
  const child = spawn(process.execPath, [...process.execArgv, SUPERVISOR_FILE, p.store, runId], {
    detached: true, stdio: 'ignore', cwd: p.dir, env: p.env,
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.unref();
  t.diagnostic(`supervisor execArgv: ${JSON.stringify(process.execArgv)}`);
  const until = Date.now() + 60000;
  let run = p.run(runId);
  while (run.phase !== 'ended' && Date.now() < until) {
    await sleep(100);
    run = p.run(runId);
  }
  assert.deepEqual(await exited, { code: 0, signal: null }, 'the supervisor exits 0');
  run = p.run(runId);
  assert.equal(run.phase, 'ended', JSON.stringify({ process: run.process, end: run.end }));
  assert.equal(run.end.state, 'exited', JSON.stringify(run.process ?? null));
  assert.equal(run.process.kind, 'exited', JSON.stringify(run.process ?? null));
  assert.equal(run.report.status, 'success');
  assert.equal(resultOfRun(run).resultOffered, true);
});
