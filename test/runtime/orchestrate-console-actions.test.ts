'use strict';

// 162 IC-004: what the Console and a paired device need from `orchestrate decide-gate` and `close`: a revision
// precondition (`--expect-revision`), a relay label recorded as the history entry's `by` (`--via`), and a
// refusal that is data on stdout under `--json` (`{v:1, ok:false, error, current}`). The stderr line and
// exit 1 of a refusal are unchanged, and nothing is written by a refused call.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { clearCheckoutCache } = require('../../src/runtime/checkouts.ts');
const { handleOrchestrateCommand, WorkflowOrchestrator, RunRefusal } = require('../../src/runtime/workflow-orchestrator.ts');
const { runStoreDir } = require('../../src/runtime/implementation-gate.ts');

const REPO = path.resolve(__dirname, '..', '..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const STORE = path.join('.doflow', 'state', 'orchestration');
const DEVICE = 'device.d-0a1b2c3d4e5f';

function project(t: any) {
  const root = tempDir(t, 'doflow-console-actions-');
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 1;\n');
  const git = (...args: any[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('branch', '-M', 'main');
  return root;
}

/** The CLI with a scratch HOME and XDG_CONFIG_HOME, never the real ones, as a main session unless `extraEnv` says otherwise. */
function runCli(cwd: any, args: any, extraEnv: Record<string, string> = {}) {
  const home = path.join(cwd, '.test-home');
  const config = path.join(cwd, '.test-config');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  const env: any = { ...process.env, DOFLOW_TELEMETRY: 'off', DOFLOW_UPKEEP: 'off', HOME: home, XDG_CONFIG_HOME: config };
  delete env.DOFLOW_SESSION_ROLE;
  Object.assign(env, extraEnv);
  const result = spawnSync(process.execPath, [DOFLOW, 'orchestrate', ...args], { cwd, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function ok(cwd: any, args: any) {
  const result = runCli(cwd, [...args, '--json']);
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

const runFile = (root: any, slug: string, id: string) => path.join(root, STORE, slug, `${id}.json`);
const readRun = (root: any, slug: string, id: string) => JSON.parse(fs.readFileSync(runFile(root, slug, id), 'utf8'));

/** A feature run, parked at gate-0 (AWAITING_GATE). */
function gateRun(root: any, id = 't1', slug = 'feat-a') {
  ok(root, ['--action', 'start', '--task-id', id, '--task-class', 'feature', '--slug', slug]);
  return ok(root, ['--action', 'complete-stage', '--task-id', id, '--stage', 'discovery', '--slug', slug]);
}

const decideArgs = (extra: string[], id = 't1', slug = 'feat-a') =>
  ['--action', 'decide-gate', '--task-id', id, '--gate', 'gate-0', '--decision', 'approve', '--slug', slug, ...extra];

test('a stale --expect-revision is refused as data on stdout, exit 1, and the run file is byte-identical', (t) => {
  const root = project(t);
  const awaiting = gateRun(root);
  assert.equal(awaiting.state, 'AWAITING_GATE');
  const before = fs.readFileSync(runFile(root, 'feat-a', 't1'));
  const result = runCli(root, [...decideArgs(['--expect-revision', String(awaiting.revision - 1), '--via', DEVICE]), '--json']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout.trimEnd().split('\n').length, 1, 'one JSON object on one line');
  const body = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(body), ['v', 'ok', 'error', 'current']);
  assert.equal(body.v, 1);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'stale-revision');
  assert.equal(body.current.state, 'AWAITING_GATE');
  assert.equal(body.current.revision, awaiting.revision);
  assert.equal(body.current.taskId, 't1');
  assert.match(result.stderr, /^\[ERROR\] orchestrate: /m);
  assert.ok(fs.readFileSync(runFile(root, 'feat-a', 't1')).equals(before), 'a refused call wrote nothing');
});

test('without --json a refusal prints no stdout, only the unchanged stderr line, exit 1', (t) => {
  const root = project(t);
  const awaiting = gateRun(root);
  const result = runCli(root, decideArgs(['--expect-revision', String(awaiting.revision + 1)]));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /\[ERROR\] orchestrate: Run 't1' is at revision \d+, not the expected \d+/);
});

test('a matching --expect-revision applies the decision and records the relay label as by', (t) => {
  const root = project(t);
  const awaiting = gateRun(root);
  const snapshot = ok(root, decideArgs(['--expect-revision', String(awaiting.revision), '--via', DEVICE]));
  assert.equal(snapshot.state, 'RUNNING');
  assert.equal(snapshot.revision, awaiting.revision + 1);
  const entry = readRun(root, 'feat-a', 't1').history.filter((e: any) => e.action === 'decide-gate').at(-1);
  assert.equal(entry.by, DEVICE);
  assert.equal(entry.detail, 'approve');
  const timeline = ok(root, ['--action', 'timeline', '--task-id', 't1', '--slug', 'feat-a']);
  assert.equal(timeline.events.filter((e: any) => e.action === 'decide-gate').at(-1).by, DEVICE);
});

test('--expect-revision 0 is a value, not an absent flag: a run at revision 1 or more is stale against it', (t) => {
  const root = project(t);
  gateRun(root);
  const result = runCli(root, [...decideArgs(['--expect-revision', '0']), '--json']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error, 'stale-revision');
});

test('decide-gate without --via still records manual, and with --via console records console', (t) => {
  const root = project(t);
  gateRun(root, 'm1');
  ok(root, decideArgs([], 'm1'));
  assert.equal(readRun(root, 'feat-a', 'm1').history.filter((e: any) => e.action === 'decide-gate').at(-1).by, 'manual');
  gateRun(root, 'm2');
  ok(root, decideArgs(['--via', 'console'], 'm2'));
  assert.equal(readRun(root, 'feat-a', 'm2').history.filter((e: any) => e.action === 'decide-gate').at(-1).by, 'console');
});

test('--via outside the grammar, or with --policy, or --by, is usage (exit 2) and writes nothing', (t) => {
  const root = project(t);
  gateRun(root);
  const before = fs.readFileSync(runFile(root, 'feat-a', 't1'));
  for (const via of ['device:d-0a1b2c3d4e5f', 'person', 'manual', 'autopilot', 'device.d-0a1b2c3d4e5', 'device.d-0A1B2C3D4E5F', 'console2', 'Console', 'device.d-0a1b2c3d4e5f0']) {
    const result = runCli(root, [...decideArgs(['--via', via]), '--json']);
    assert.equal(result.status, 2, `--via ${via}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout + result.stderr, /--via/);
  }
  const withPolicy = runCli(root, ['--action', 'decide-gate', '--task-id', 't1', '--gate', 'gate-0', '--policy', 'gate-0', '--via', 'console', '--slug', 'feat-a', '--json']);
  assert.equal(withPolicy.status, 2, withPolicy.stdout + withPolicy.stderr);
  const withBy = runCli(root, [...decideArgs(['--via', 'console', '--by', 'console']), '--json']);
  assert.equal(withBy.status, 2);
  assert.match(withBy.stdout + withBy.stderr, /--by is not accepted/);
  const noValue = runCli(root, [...decideArgs(['--via']), '--json']);
  assert.equal(noValue.status, 2);
  assert.ok(fs.readFileSync(runFile(root, 'feat-a', 't1')).equals(before));
});

test('--expect-revision and --via are usage on every action that does not read them', (t) => {
  const root = project(t);
  gateRun(root);
  const before = fs.readFileSync(runFile(root, 'feat-a', 't1'));
  const slug = ['--task-id', 't1', '--slug', 'feat-a'];
  const cases: string[][] = [
    ['--action', 'complete-stage', ...slug, '--stage', 'discovery'],
    ['--action', 'skip-stage', ...slug, '--stage', 'discovery'],
    ['--action', 'annotate', ...slug, '--node', 'discovery', '--note', 'n'],
    ['--action', 'status', ...slug],
    ['--action', 'timeline', ...slug],
    ['--action', 'list'],
    ['--action', 'start', '--task-id', 'x1', '--task-class', 'bug'],
    ['--action', 'catch-up', ...slug, '--task-class', 'feature', '--stage', 'discovery'],
    ['--action', 'decide-gate', ...slug, '--gate', 'gate-0', '--policy', 'gate-0'],
  ];
  for (const args of cases) {
    for (const flag of [['--expect-revision', '1'], ['--via', 'console']]) {
      const result = runCli(root, [...args, ...flag, '--json']);
      assert.equal(result.status, 2, `${args.slice(0, 2).join(' ')} ${flag[0]}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout + result.stderr, new RegExp(`'${flag[0]}' has no effect`));
    }
  }
  assert.ok(fs.readFileSync(runFile(root, 'feat-a', 't1')).equals(before));
  assert.equal(fs.existsSync(path.join(root, STORE, 'x1.json')), false, 'start with a flag it ignores started nothing');
});

test('--expect-revision takes a non-negative integer only', (t) => {
  const root = project(t);
  gateRun(root);
  for (const value of ['-1', '1.5', 'abc', '']) {
    const result = runCli(root, [...decideArgs(['--expect-revision', value]), '--json']);
    assert.equal(result.status, 2, `${JSON.stringify(value)}: ${result.stdout}${result.stderr}`);
  }
});

test('close --via console records by console on its close-run entry; without --via it records manual', (t) => {
  const root = project(t);
  ok(root, ['--action', 'start', '--task-id', 'c1', '--task-class', 'bug', '--slug', 'feat-c']);
  ok(root, ['--action', 'start', '--task-id', 'c2', '--task-class', 'bug', '--slug', 'feat-c']);
  const rev = ok(root, ['--action', 'status', '--task-id', 'c1', '--slug', 'feat-c']).revision;
  const closed = ok(root, ['--action', 'close', '--task-id', 'c1', '--slug', 'feat-c', '--note', 'shipped by hand', '--expect-revision', String(rev), '--via', 'console']);
  assert.equal(closed.state, 'CLOSED');
  assert.equal(readRun(root, 'feat-c', 'c1').history.at(-1).action, 'close-run');
  assert.equal(readRun(root, 'feat-c', 'c1').history.at(-1).by, 'console');
  assert.equal(ok(root, ['--action', 'timeline', '--task-id', 'c1', '--slug', 'feat-c']).events.at(-1).by, 'console');
  ok(root, ['--action', 'close', '--task-id', 'c2', '--slug', 'feat-c', '--note', 'dropped']);
  assert.equal(readRun(root, 'feat-c', 'c2').history.at(-1).by, 'manual');
});

test('close with a stale --expect-revision or a bad --via writes nothing', (t) => {
  const root = project(t);
  ok(root, ['--action', 'start', '--task-id', 'c3', '--task-class', 'bug', '--slug', 'feat-c']);
  const before = fs.readFileSync(runFile(root, 'feat-c', 'c3'));
  const stale = runCli(root, ['--action', 'close', '--task-id', 'c3', '--slug', 'feat-c', '--note', 'n', '--expect-revision', '9', '--json']);
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stdout).error, 'stale-revision');
  assert.equal(JSON.parse(stale.stdout).current.state, 'RUNNING');
  const bad = runCli(root, ['--action', 'close', '--task-id', 'c3', '--slug', 'feat-c', '--note', 'n', '--via', 'person', '--json']);
  assert.equal(bad.status, 2);
  assert.ok(fs.readFileSync(runFile(root, 'feat-c', 'c3')).equals(before));
});

// One case per IC-004 refusal id. Reachable from the CLI: no-run, not-awaiting-gate, gate-mismatch, run-terminal,
// stale-revision, ambiguous-run, other-feature. concurrent-update and lock-lost need a second writer or a stalled
// lock between the read and the write, so they are covered in-process below.
function refusal(root: any, args: string[]) {
  const result = runCli(root, [...args, '--json']);
  assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /\[ERROR\] orchestrate: /);
  return JSON.parse(result.stdout);
}

test('no-run: decide-gate and close on an unknown run say no-run with current null', (t) => {
  const root = project(t);
  for (const args of [decideArgs([], 'ghost'), ['--action', 'close', '--task-id', 'ghost', '--slug', 'feat-a', '--note', 'n']]) {
    assert.deepEqual(refusal(root, args), { v: 1, ok: false, error: 'no-run', current: null });
  }
});

test('not-awaiting-gate and gate-mismatch carry the run as it stands', (t) => {
  const root = project(t);
  ok(root, ['--action', 'start', '--task-id', 'g1', '--task-class', 'feature', '--slug', 'feat-g']);
  const running = refusal(root, decideArgs([], 'g1', 'feat-g'));
  assert.equal(running.error, 'not-awaiting-gate');
  assert.equal(running.current.state, 'RUNNING');
  gateRun(root, 'g2', 'feat-g');
  const mismatch = refusal(root, ['--action', 'decide-gate', '--task-id', 'g2', '--gate', 'gate-a', '--decision', 'approve', '--slug', 'feat-g']);
  assert.equal(mismatch.error, 'gate-mismatch');
  assert.equal(mismatch.current.state, 'AWAITING_GATE');
  assert.equal(mismatch.current.awaitingGate.gateId, 'gate-0');
});

test('run-terminal: close of an already closed run carries the terminal state', (t) => {
  const root = project(t);
  ok(root, ['--action', 'start', '--task-id', 'e1', '--task-class', 'bug', '--slug', 'feat-e']);
  ok(root, ['--action', 'close', '--task-id', 'e1', '--slug', 'feat-e', '--note', 'done']);
  const again = refusal(root, ['--action', 'close', '--task-id', 'e1', '--slug', 'feat-e', '--note', 'twice', '--via', 'console']);
  assert.equal(again.error, 'run-terminal');
  assert.equal(again.current.state, 'CLOSED');
});

test('ambiguous-run: close without --slug of an id held under two features names ambiguous-run', (t) => {
  const root = project(t);
  ok(root, ['--action', 'start', '--task-id', 'dup', '--task-class', 'bug', '--slug', 'feat-x']);
  ok(root, ['--action', 'start', '--task-id', 'dup', '--task-class', 'bug', '--slug', 'feat-y']);
  const body = refusal(root, ['--action', 'close', '--task-id', 'dup', '--note', 'n']);
  assert.deepEqual(body, { v: 1, ok: false, error: 'ambiguous-run', current: null });
});

test('other-feature: close without --slug of a run of another feature than the checkout resolves names other-feature', (t) => {
  const root = project(t);
  ok(root, ['--action', 'start', '--task-id', 'of1', '--task-class', 'bug', '--slug', 'feat-a']);
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'feat/feat-b'], { stdio: 'ignore' });
  const before = fs.readFileSync(runFile(root, 'feat-a', 'of1'));
  const body = refusal(root, ['--action', 'close', '--task-id', 'of1', '--note', 'n']);
  assert.deepEqual(body, { v: 1, ok: false, error: 'other-feature', current: null });
  assert.ok(fs.readFileSync(runFile(root, 'feat-a', 'of1')).equals(before));
});

test('refusals of other actions and non-refusal errors print no JSON: only decide-gate and close under --json do', (t) => {
  const root = project(t);
  gateRun(root);
  const stage = runCli(root, ['--action', 'complete-stage', '--task-id', 'nope', '--stage', 'discovery', '--slug', 'feat-a', '--json']);
  assert.equal(stage.status, 1);
  assert.equal(stage.stdout, '');
  const forced = runCli(root, [...decideArgs(['--forced']), '--json']);
  assert.equal(forced.status, 1);
  assert.equal(forced.stdout, '', 'a forced decision with no reason is a plain error, not a run refusal');
});

/** The handler in-process, with the same options the dispatcher fills. */
function inProcess(stateRoot: any, options: any) {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  const exitCode = process.exitCode;
  console.log = (...args) => { out.push(args.join(' ')); };
  console.error = (...args) => { err.push(args.join(' ')); };
  let status;
  try {
    clearCheckoutCache();
    status = handleOrchestrateCommand({ stateRoot, ...options });
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = exitCode;
  }
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('concurrent-update: a stale writer is refused with the run record and the message unchanged', (t) => {
  const root = project(t);
  gateRun(root);
  const store = runStoreDir(root);
  const make = () => new WorkflowOrchestrator({ repoRoot: REPO, projectRoot: root, stateDir: store, featureSlug: 'feat-a' });
  const stale = make().readRun('t1');
  const winner = make().readRun('t1');
  make().writeRun(winner, new Date());
  assert.throws(() => make().writeRun(stale, new Date()), (error: any) => {
    assert.equal(error.code, 'concurrent-update');
    assert.equal(error.run, stale);
    assert.match(error.message, /Concurrent workflow update for 't1'; reload the run before retrying\. Nothing was written\./);
    return true;
  });
});

test('concurrent-update and lock-lost reach the JSON refusal from the handler catch', (t) => {
  const root = project(t);
  const awaiting = gateRun(root);
  const original = WorkflowOrchestrator.prototype.decideGate;
  t.after(() => { WorkflowOrchestrator.prototype.decideGate = original; });
  for (const code of ['concurrent-update', 'lock-lost']) {
    WorkflowOrchestrator.prototype.decideGate = function () {
      throw code === 'lock-lost' ? Object.assign(new Error(`stalled ${code}`), { code }) : new RunRefusal(code, `stalled ${code}`);
    };
    const result = inProcess(root, { action: 'decide-gate', taskId: 't1', gate: 'gate-0', decision: 'approve', slug: 'feat-a', recordSlug: 'feat-a', json: true });
    assert.equal(result.status, 1, code);
    assert.match(result.stderr, new RegExp(`\\[ERROR\\] orchestrate: stalled ${code}`));
    const body = JSON.parse(result.stdout);
    assert.equal(body.error, code);
    assert.equal(body.current.state, 'AWAITING_GATE');
    assert.equal(body.current.revision, awaiting.revision);
  }
  WorkflowOrchestrator.prototype.decideGate = function () { throw Object.assign(new Error('other'), { code: 'concurrent-update' }); };
  const other = inProcess(root, { action: 'decide-gate', taskId: 't1', gate: 'gate-0', decision: 'approve', slug: 'feat-a', recordSlug: 'feat-a', json: true });
  assert.equal(other.status, 1);
  assert.equal(other.stdout, '', 'a plain error that only borrows a refusal code prints no JSON');
});

test('decide-gate --slug from the main checkout finds a run of a feature worktree', (t) => {
  const main = project(t);
  const linked = `${main}-wt`;
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'feat/feat-wt', linked, 'HEAD'], { stdio: 'ignore' });
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  const awaiting = gateRun(linked, 'w1', 'feat-wt');
  const result = runCli(main, [...decideArgs(['--expect-revision', String(awaiting.revision), '--via', 'console'], 'w1', 'feat-wt'), '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).state, 'RUNNING');
  const file = [main, linked].map((root) => runFile(root, 'feat-wt', 'w1')).find((candidate) => fs.existsSync(candidate));
  assert.ok(file, 'the run file is in one of the two checkouts');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).history.filter((e: any) => e.action === 'decide-gate').at(-1).by, 'console');
});

test('a note that starts with - reaches the journal verbatim', (t) => {
  const root = project(t);
  gateRun(root, 'n1');
  const note = '--rejected: -x looks like a flag';
  ok(root, ['--action', 'decide-gate', '--task-id', 'n1', '--gate', 'gate-0', '--decision', 'approve', '--slug', 'feat-a', '--note', note]);
  assert.equal(readRun(root, 'feat-a', 'n1').history.filter((e: any) => e.action === 'decide-gate').at(-1).note, note);
  ok(root, ['--action', 'start', '--task-id', 'n2', '--task-class', 'bug', '--slug', 'feat-a']);
  ok(root, ['--action', 'close', '--task-id', 'n2', '--slug', 'feat-a', '--note', '-dropped for good', '--via', 'console']);
  assert.equal(readRun(root, 'feat-a', 'n2').history.at(-1).note, '-dropped for good');
});

test('162 review 5: --via from a worker session is refused (exit 1, error worker-session as JSON) on decide-gate and close, and writes nothing; without --via the worker session is as before', (t) => {
  const root = project(t);
  const awaiting = gateRun(root);
  const before = fs.readFileSync(runFile(root, 'feat-a', 't1'));
  for (const role of ['worker', 'subagent']) {
    for (const args of [decideArgs(['--via', DEVICE, '--expect-revision', String(awaiting.revision)]), ['--action', 'close', '--task-id', 't1', '--slug', 'feat-a', '--note', 'n', '--via', 'console']]) {
      const result = runCli(root, [...args, '--json'], { DOFLOW_SESSION_ROLE: role });
      assert.equal(result.status, 1, `${role} ${args.join(' ')}: ${result.stdout}${result.stderr}`);
      const body = JSON.parse(result.stdout);
      assert.deepEqual([body.v, body.ok, body.error, body.current], [1, false, 'worker-session', null]);
      assert.match(result.stderr, /--via/);
      const text = runCli(root, args, { DOFLOW_SESSION_ROLE: role });
      assert.equal(text.status, 1);
      assert.equal(text.stdout, '');
    }
  }
  assert.deepEqual(fs.readFileSync(runFile(root, 'feat-a', 't1')), before, 'nothing was written');
  // A main session (the role unset or main) still relays.
  ok(root, decideArgs(['--via', DEVICE]));
  assert.equal(readRun(root, 'feat-a', 't1').history.filter((e: any) => e.action === 'decide-gate').at(-1).by, DEVICE);
});
