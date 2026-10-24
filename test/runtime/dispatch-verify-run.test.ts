'use strict';

// Feature 082 A.6 (IC-019, IC-032 endVerification; DEC-006, DEC-024, DEC-047): the verification
// runner in src/runtime/dispatch/verify-run.ts.
//
// Every verification argv starts with the absolute process.execPath (DEC-056). The caller env's
// PATH is one empty scratch bin/ (no node directory, so no harness binary can resolve; NFR-002) and
// every DOFLOW_* identity variable is set explicitly. The worktree is a plain temp directory: git is
// not on that PATH, so the recorded head is null, which the runner allows. POSIX only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tempDir } = require('../helper/tmp.ts');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const { runVerification, endVerification, argvDigest } = require(path.join(SRC, 'dispatch', 'verify-run.ts'));
const tree = require(path.join(SRC, 'worker', 'process-tree.ts'));
const { EvidenceLedger } = require(path.join(SRC, 'evidence-ledger.ts'));

const SLUG = 'feat-v';
const POSIX: any = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
/** Present in every argv below and in no output, so finding it anywhere is an argv leak. */
const MARKER = 'argv-marker-7f3c';

function project(t: any) {
  const root = tempDir(t, 'doflow-verify-run-');
  const worktree = path.join(root, 'integration');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(worktree);
  fs.mkdirSync(bin);
  const env: any = {
    PATH: bin,
    HOME: root,
    DOFLOW_RUN_ID: 'p-0123456789ab',
    DOFLOW_LINEAGE_ID: 'lin-verify',
    DOFLOW_ATTEMPT: '1',
    DOFLOW_SESSION_ROLE: 'main',
    DOFLOW_WORKTREE: worktree,
  };
  return { root, worktree, env };
}

/** An argv running `script` under this node, the marker carried as a trailing comment. */
const nodeArgv = (script: any) => [process.execPath, '-e', `${script} // ${MARKER}`];

function run(p: any, argv: any, extra: any = {}) {
  return runVerification({ root: p.root, slug: SLUG, taskId: 'A.1', worktree: p.worktree, argv, seconds: 30, env: p.env, ...extra });
}

function evidenceOf(p: any, taskId: any, id: any) {
  const ledger: any = new EvidenceLedger({ repoRoot: p.root, slug: SLUG });
  ledger.load(taskId);
  return ledger.getEvidence(id);
}

const outputFile = (p: any, outputId: any, stream: any = 'out') => path.join(p.root, '.doflow', 'state', 'worker-output', `${outputId}.${stream}.log`);

/** Every file under `dir`, recursively. */
function filesUnder(dir: any): any {
  const found: any = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full));
    else found.push(full);
  }
  return found;
}

test('exit 0 passes, with test-result evidence carrying exitCode 0', POSIX, async (t) => {
  const p = project(t);
  const argv = nodeArgv("process.stdout.write('ok\\n')");
  const result = await run(p, argv);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, null);
  assert.equal(result.cleanup, null);
  assert.match(result.outputId, /^w-[0-9a-f]{12}$/);
  assert.equal(result.argvSha256, argvDigest(argv));
  const item = evidenceOf(p, 'A.1', result.evidenceId);
  assert.equal(item.kind, 'test-result');
  assert.equal(item.provenance, 'extracted');
  assert.deepEqual(item.source, { provider: 'doflow-dispatch', capability: 'verify' });
  assert.equal(item.taskId, 'A.1');
  assert.deepEqual(item.observation, { command: `verify sha256:${argvDigest(argv)} argc:3`, exitCode: 0 });
  assert.deepEqual(item.locator, { path: `worker-output/${result.outputId}.out.log` });
  assert.deepEqual(item.establishes, []);
  assert.equal(fs.readFileSync(outputFile(p, result.outputId), 'utf8'), 'ok\n');
});

test('exit 3 fails with exit code 3; the final run saves under the slug', POSIX, async (t) => {
  const p = project(t);
  const result = await run(p, nodeArgv('process.exit(3)'), { taskId: SLUG });
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
  assert.equal(evidenceOf(p, SLUG, result.evidenceId).observation.exitCode, 3);
});

test('a missing argv[0] gives error ENOENT and exitCode null', POSIX, async (t) => {
  const p = project(t);
  const result = await run(p, [path.join(p.root, 'no-such-binary'), MARKER]);
  assert.equal(result.error, 'ENOENT');
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.equal(evidenceOf(p, 'A.1', result.evidenceId).observation.exitCode, null);
});

test('a child past a 1-second bound ends timedOut, cleanup verified and its group gone', POSIX, async (t) => {
  const p = project(t);
  let spawned: any = null;
  // The leader starts a grandchild in its own group, then both sleep well past the bound.
  const script = "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); setTimeout(() => {}, 60000)";
  const began = Date.now();
  const result = await run(p, nodeArgv(script), { seconds: 1, onSpawn: (proc: any) => { spawned = proc; } });
  assert.ok(Date.now() - began < 15000);
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.cleanup, { status: 'verified', reason: null });
  assert.ok(spawned && spawned.pid > 0 && spawned.pgid === spawned.pid && typeof spawned.start === 'string');
  assert.equal(tree.groupAlive(spawned.pgid, spawned.start), false);
  assert.notEqual(evidenceOf(p, 'A.1', result.evidenceId).observation.exitCode, 0);
});

test('a line holding an sk- token is <masked> in the output file', POSIX, async (t) => {
  const p = project(t);
  const token = `sk-${'aB3dE5gH7jK9mN1pQ3sT5vW7'}`;
  const result = await run(p, nodeArgv(`console.log('key ' + 'sk-' + 'aB3dE5gH7jK9mN1pQ3sT5vW7')`));
  const text = fs.readFileSync(outputFile(p, result.outputId), 'utf8');
  assert.match(text, /<masked>/);
  assert.ok(!text.includes(token));
});

test('no evidence item, record or output holds an argv element', POSIX, async (t) => {
  const p = project(t);
  const argv = nodeArgv("console.log('hello'); console.error('warn')");
  const result = await run(p, argv);
  const item = evidenceOf(p, 'A.1', result.evidenceId);
  const texts: any = [JSON.stringify(result), JSON.stringify(item)];
  for (const file of filesUnder(path.join(p.root, '.doflow', 'state'))) texts.push(fs.readFileSync(file, 'utf8'));
  // A flag such as -e is two characters and matches random ids (w-e...); the node path and the script text are what must stay out of every record.
  for (const element of argv.filter((e) => e.length > 2)) {
    for (const text of texts) assert.ok(!text.includes(element), `argv element found: ${element.slice(0, 40)}`);
  }
  assert.ok(texts.every((text: any) => !text.includes(MARKER)));
  assert.equal(item.observation.command, `verify sha256:${crypto.createHash('sha256').update(JSON.stringify(argv)).digest('hex')} argc:${argv.length}`);
});

test('a recorded start of null signals nothing at the bound', POSIX, async (t): Promise<any> => {
  const p = project(t);
  const calls: any = [];
  const signals: any = [];
  const escalate = (args: any) => {
    calls.push(args);
    return tree.escalate({ ...args, kill: (pid: any, name: any) => { signals.push([pid, name]); return process.kill(pid, name); } });
  };
  let spawned: any = null;
  const result = await run(p, nodeArgv('setTimeout(() => {}, 2000)'), {
    seconds: 1, escalate, procStart: () => null, onSpawn: (proc: any) => { spawned = proc; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].proc.start, null);
  assert.equal(spawned.start, null);
  assert.deepEqual(signals.filter(([, name]: any) => name !== 0), []);
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.cleanup, { status: 'unknown', reason: 'no-leader-start' });
  assert.equal(result.exitCode, 0);
});

test('a GIT_DIR in the caller env is absent in the child', POSIX, async (t) => {
  const p = project(t);
  const env: any = { ...p.env, GIT_DIR: path.join(p.root, 'elsewhere.git'), GIT_WORK_TREE: p.root };
  const result = await run(p, nodeArgv("console.log(JSON.stringify([process.env.GIT_DIR ?? null, process.env.GIT_WORK_TREE ?? null, process.env.DOFLOW_RUN_ID]))"), { env });
  assert.equal(fs.readFileSync(outputFile(p, result.outputId), 'utf8').trim(), JSON.stringify([null, null, 'p-0123456789ab']));
});

test('endVerification ends a live recorded group', POSIX, async (t) => {
  const p = project(t);
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { env: p.env, detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
  const proc: any = { pid: child.pid, pgid: child.pid, start: tree.procStart(child.pid) };
  assert.equal(tree.alive(proc), true);
  const outcome = await endVerification(proc);
  assert.equal(outcome.status, 'verified');
  assert.equal(tree.groupAlive(proc.pgid, proc.start), false);
});

test('endVerification ends a recorded group through escalate with its recorded start', POSIX, async (): Promise<any> => {
  const calls: any = [];
  const outcome = await endVerification({ pid: 4242, pgid: 4242, start: null }, { escalate: async (args: any) => { calls.push(args); return { status: 'unknown', reason: 'no-leader-start', survivors: [], zombies: [] }; } });
  assert.deepEqual(calls.map((c: any) => c.proc), [{ pid: 4242, pgid: 4242, start: null }]);
  assert.equal(outcome.reason, 'no-leader-start');
});
