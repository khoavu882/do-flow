'use strict';

// Row 170 T5 (design D4, D5, D6, D8, IC-001, section 7; owner ruling R-4): the verbs `worker --action send | steer | stop`.
// The live tests run the real supervisor against the fake channel harness (test/helper/fake-channel-harness.ts, run by
// absolute path through node); the refusal tests seed a record with no process at all, since every refusal comes before
// the one spool write. A "supervisor" that is only a few lines in the test answers the spool where a test needs a
// particular ledger outcome. No real harness CLI can run. Every process group a test starts is ended in its `after`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');

const REPO = path.join(__dirname, '..', '..');
const SRC = path.join(REPO, 'src', 'runtime');
const spool = require(path.join(SRC, 'worker', 'channel-spool.ts'));
const { superviseRun, SUPERVISOR_FILE } = require(path.join(SRC, 'worker', 'supervisor.ts'));
const { storeFileFor, newRunId, insertRun, readRuns, transition } = require(path.join(SRC, 'worker', 'run-store.ts'));
const { writePrompt } = require(path.join(SRC, 'worker', 'session-prompt.ts'));
const { mainLaunchRecord, launchChannelSession } = require(path.join(SRC, 'worker', 'launch.ts'));
const { executeWorkerCommand, handleWorkerCommand } = require(path.join(SRC, 'worker', 'command.ts'));
const { CHANNEL_LIMITS } = require(path.join(SRC, 'worker', 'channel.ts'));
const tree = require(path.join(SRC, 'worker', 'process-tree.ts'));
const { cwdHash } = require(path.join(SRC, 'context', 'identity.ts'));
const { listCheckouts } = require(path.join(SRC, 'checkouts.ts'));
const { workerCatalogue } = require(path.join(SRC, 'worker', 'catalogue.ts'));
const { loadRegistry } = require(path.join(REPO, 'src', 'registry', 'index.ts'));
const FAKE = path.join(REPO, 'test', 'helper', 'fake-channel-harness.ts');

const POSIX: any = { skip: process.platform === 'win32' && 'worker process control and O_NOFOLLOW are not run on win32 (R-10)' };
const REGISTRY = loadRegistry({ repoRoot: REPO });
const PI = workerCatalogue({ registry: REGISTRY }).find((entry: any) => entry.id === 'pi').worker;
const CHANNEL = Object.freeze({
  status: 'supported', evidence: ['test'], verification: 'v', verifiedOn: '2026-11-17',
  argv: ['--mode', 'rpc', '--no-approve'], framing: 'jsonl-lf', parser: 'pi-json-v1', commandPrefix: '/',
  messages: {
    followUp: { type: 'prompt', message: '{text}', streamingBehavior: 'followUp', id: '{id}' },
    steer: { type: 'steer', message: '{text}', id: '{id}' },
    stop: { type: 'abort', id: '{id}' },
  },
  turn: { working: [{ path: ['type'], equals: 'agent_start' }], settled: [{ path: ['type'], equals: 'agent_end' }] },
  answer: {
    id: ['id'],
    accepted: [{ path: ['type'], equals: 'response' }, { path: ['success'], equals: true }],
    refused: [{ path: ['type'], equals: 'response' }, { path: ['success'], equals: false }],
  },
  close: { stdinEof: 'exits', graceSeconds: 3 },
  unverified: ['declared for the tests only'],
});
const rid = () => `r${crypto.randomBytes(16).toString('base64url').slice(1)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (ms = Date.now()) => new Date(ms).toISOString();

async function until<T>(read: () => T, what: string, ms = 10000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV },
  });
  assert.equal(r.status, 0, r.stderr);
}

/** A scratch project (a git repo), a bin/ with `fake-pi` and `node` links, a scratch HOME; ends every recorded group after the test. */
function fixture(t: any) {
  let f: any = null;
  t.after(async () => {
    if (!f) return;
    for (const n of [1, 2, 3, 4, 5]) { try { fs.writeFileSync(`${f.gate}-${n}`, ''); } catch { /* gone */ } }
    let runs: any = {};
    try { runs = readRuns(f.file); } catch { runs = {}; }
    for (const run of Object.values(runs) as any[]) {
      for (const proc of [run.worker, run.supervisor]) {
        if (proc && Number.isInteger(proc.pid) && proc.pid !== process.pid) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }
    for (const done of f.supervising) await Promise.race([done.catch(() => null), sleep(5000)]);
  });
  const dir = fs.realpathSync(tempDir(t, 'doflow-steer-'));
  f = { dir, root: path.join(dir, 'proj'), bin: path.join(dir, 'bin'), log: path.join(dir, 'fake.log'), gate: path.join(dir, 'gate'), supervising: [] as Promise<any>[] };
  fs.mkdirSync(f.root);
  git(f.root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.doflow/\n');
  git(f.root, 'add', '-A');
  git(f.root, 'commit', '-q', '-m', 'first');
  fs.mkdirSync(path.join(f.root, '.doflow', 'state'), { recursive: true });
  fs.mkdirSync(f.bin);
  fs.symlinkSync(FAKE, path.join(f.bin, 'fake-pi'));
  fs.symlinkSync(process.execPath, path.join(f.bin, 'node'));
  fs.mkdirSync(path.join(dir, 'home', '.doflow', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  f.env = {
    HOME: path.join(dir, 'home'), XDG_CONFIG_HOME: path.join(dir, 'config'), TMPDIR: process.env.TMPDIR, PATH: f.bin,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
    DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_TELEMETRY: 'off', FAKE_CHANNEL_LOG: f.log,
  };
  f.file = storeFileFor(f.root, 'started-sessions');
  f.projectKey = cwdHash(listCheckouts({ cwd: f.root }).main);
  return f;
}

/** A `starting` channel session as start-session records it. `descriptor` replaces the channel descriptor's entry when given. */
function seed(f: any, { sent = 'first prompt', controlChannel = structuredClone(CHANNEL) }: any = {}) {
  const runId = newRunId();
  const descriptor: any = { ...structuredClone(PI), cli: { binary: path.join(f.bin, 'fake-pi') } };
  if (controlChannel !== null) descriptor.controlChannel = controlChannel; else delete descriptor.controlChannel;
  writePrompt(f.root, runId, sent, { isEnded: () => false });
  const r = insertRun(f.file, {
    runId, kind: 'main-session', task: 'main-session', token: 1, request: rid(), childOf: null, harness: 'pi', phase: 'starting',
    createdAt: new Date().toISOString(), timeoutSeconds: 600, startedBy: 'console', project: { projectKey: f.projectKey, worktreeKey: 'b'.repeat(16) },
    execWorktree: f.root, entry: 'none', binding: null,
    prompt: { store: 'session-prompts', name: `${runId}.prompt.txt`, sha256: crypto.createHash('sha256').update(sent, 'utf8').digest('hex'), bytes: Buffer.byteLength(sent) },
    ...mainLaunchRecord(descriptor, sent, null, controlChannel?.status === 'supported'),
    descriptor,
  });
  assert.equal(r.applied, true);
  return runId;
}

/** A process-free open channel session: the record as the supervisor keeps it, and its spool. */
function seedOpen(f: any, { turn = { observed: true, state: 'working', since: iso(), seq: 1 }, ledger = [] as any[], stamps = {} as any, state = 'open', closedReason = null as any, controlChannel = structuredClone(CHANNEL) }: any = {}) {
  const runId = seed(f, { controlChannel });
  transition(f.file, runId, ['starting'], (run: any) => {
    run.channel = { v: 1, state, closedReason, turn, sent: { count: 0, bytes: 0, lastAt: null }, ledger, stamps };
  });
  spool.createSpool(f.root, runId);
  return runId;
}

const runOf = (f: any, runId: string) => readRuns(f.file)[runId];
const ledgerOf = (f: any, runId: string) => runOf(f, runId)?.channel?.ledger ?? [];
const logLines = (f: any): string[] => (fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').split(/(?<=\n)/).filter(Boolean) : []);
const record = (template: any, text: string, id: string) => `${JSON.stringify({ ...template, message: text, id })}\n`;
const waiting = (f: any, runId: string) => spool.waitingNames(f.root, runId);
const gone = (proc: any) => tree.alive(proc) === false && tree.groupAlive(proc.pgid, proc.start) === false;
const projectsOf = (f: any) => () => ({ ok: true, body: { projects: [{ projectKey: f.projectKey }] } });

/** One verb call. `virtual` runs the wait on a virtual clock (25 ms per sleep), so a wait that ends `pending` costs no real time. */
function verb(f: any, runId: string, action: string, { text = 'a message', requestId = rid(), via = 'console', env = f.env, virtual = false, extra = {} as any } = {}) {
  let at = Date.now();
  return executeWorkerCommand({
    action, projectKey: f.projectKey, workerRun: runId, requestId, via, stdin: action !== 'stop', readStdin: () => text,
    env, cwd: f.root, registry: REGISTRY, projects: projectsOf(f),
    ...(virtual ? { now: () => new Date(at), sleep: async (ms: number) => { at += ms; } } : {}), ...extra,
  });
}

/** Answers the next spool file the way the supervisor does, with the given outcome. */
async function answerNext(f: any, runId: string, outcome: any, answerAfterMs: number | null = null) {
  await until(() => waiting(f, runId).length > 0, 'a spool file');
  const [taken] = spool.takeMessages(f.root, runId);
  assert.equal(taken.ok, true);
  const m = taken.message;
  transition(f.file, runId, ['starting', 'running', 'cancelling'], (run: any) => {
    const c = run.channel;
    const seq = c.ledger.length + 1;
    c.ledger.push({ seq, kind: m.kind, by: m.by, requestId: m.requestId, at: iso(), bytes: typeof m.text === 'string' ? Buffer.byteLength(m.text) : 0, outcome: 'written', reason: null, answer: null, ...outcome });
  });
  if (answerAfterMs !== null) {
    await sleep(answerAfterMs);
    transition(f.file, runId, ['starting', 'running', 'cancelling'], (run: any) => { run.channel.ledger[run.channel.ledger.length - 1].answer = 'accepted'; });
  }
  return m;
}

// ── The live verbs ───────────────────────────────────────────────────────────────────────────────

test('send, steer and stop reach a running session byte-exact; the reply is IC-001, a replay by request id writes nothing, and exit codes are 0', POSIX, async (t: any) => {
  const f = fixture(t);
  const runId = seed(f, { sent: 'first words' });
  f.supervising.push(superviseRun({ file: f.file, runId, env: { ...f.env, FAKE_CHANNEL_GATE: f.gate }, cwd: f.root, channel: { pollMs: 20 } }));
  await until(() => runOf(f, runId)?.channel?.state === 'open' && runOf(f, runId).channel.turn.state === 'working', 'the turn working');
  fs.writeFileSync(`${f.gate}-1`, '');
  await until(() => runOf(f, runId).channel.turn.state === 'waiting', 'the turn waiting');

  const text = 'second "quoted"\nline café {text}';
  const id = rid();
  const sent = await verb(f, runId, 'send', { text, requestId: id });
  assert.equal(sent.exit, 0, JSON.stringify(sent.body));
  assert.deepEqual([sent.body.ok, sent.body.replayed, sent.body.channel], [true, false, 'open']);
  assert.deepEqual([sent.body.message.seq, sent.body.message.kind, sent.body.message.state, sent.body.message.answer, sent.body.message.bytes], [2, 'follow-up', 'written', 'accepted', Buffer.byteLength(text)]);
  assert.match(sent.body.message.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(logLines(f)[1], record(CHANNEL.messages.followUp, text, 'd-2'), 'the record is framed byte-exact with the ledger id');
  assert.equal(sent.body.turn.observed, true);
  assert.equal(ledgerOf(f, runId).find((e: any) => e.requestId === id).by, 'console');

  // A replay with the same request id returns the recorded final state and writes nothing.
  const lines = logLines(f).length;
  const entries = ledgerOf(f, runId).length;
  const again = await verb(f, runId, 'send', { text: 'a different text', requestId: id });
  assert.deepEqual([again.exit, again.body.ok, again.body.replayed, again.body.message.seq, again.body.message.state, again.body.message.answer], [0, true, true, 2, 'written', 'accepted']);
  assert.deepEqual(waiting(f, runId), []);
  await sleep(150);
  assert.equal(logLines(f).length, lines, 'a replay reaches no harness');
  assert.equal(ledgerOf(f, runId).length, entries, 'a replay writes no ledger entry');

  // Record 2 made the turn working again (the gate holds it): a steer is accepted, then a stop.
  await until(() => runOf(f, runId).channel.turn.state === 'working', 'working again');
  const steered = await verb(f, runId, 'steer', { text: 'change course' });
  assert.deepEqual([steered.exit, steered.body.ok, steered.body.message.kind, steered.body.message.state], [0, true, 'steer', 'written']);
  assert.equal(logLines(f)[2], record(CHANNEL.messages.steer, 'change course', 'd-3'));
  const stopped = await verb(f, runId, 'stop');
  assert.deepEqual([stopped.exit, stopped.body.ok, stopped.body.message.kind, stopped.body.message.state, stopped.body.message.bytes], [0, true, 'stop', 'written', 0]);
  assert.equal(logLines(f)[3], `${JSON.stringify({ type: 'abort', id: 'd-4' })}\n`);

  // The store holds counts, never a message text.
  for (const word of ['second', 'change course', 'a different text']) assert.ok(!fs.readFileSync(f.file, 'utf8').includes(word), `no text in the store: ${word}`);
});

test('a killed supervisor reads channel-closed, supervisor-gone, naming the cancel that ends the session; nothing is written', POSIX, async (t: any) => {
  const f = fixture(t);
  const runId = seed(f, { sent: 'kill me' });
  const child = spawn(process.execPath, [SUPERVISOR_FILE, f.file, runId], { detached: true, stdio: 'ignore', cwd: f.root, env: { ...f.env, FAKE_CHANNEL_MODE: 'ignore-eof' } });
  child.unref();
  const supervisor = { pid: child.pid, pgid: child.pid, start: tree.procStart(child.pid) };
  transition(f.file, runId, ['starting', 'running', 'cancelling'], (run: any) => { run.supervisor = supervisor; });
  await until(() => runOf(f, runId)?.channel?.state === 'open' && runOf(f, runId).channel.turn.state === 'working', 'the channel open');
  const worker = runOf(f, runId).worker;
  process.kill(supervisor.pid, 'SIGKILL');
  await until(() => tree.alive(supervisor) === false, 'the supervisor gone');

  const lines = logLines(f).length;
  const refused = await verb(f, runId, 'send', { text: 'is anyone there' });
  assert.deepEqual([refused.exit, refused.body.ok, refused.body.code], [1, false, 'channel-closed']);
  assert.equal(refused.body.current.reason, 'supervisor-gone');
  assert.ok(refused.body.message.includes(`doflow worker --action cancel --slug started-sessions --worker-run ${runId} --operator --via console --reason ended`), refused.body.message);
  assert.deepEqual(waiting(f, runId), [], 'nothing was dropped');
  assert.equal(logLines(f).length, lines);
  const stop = await verb(f, runId, 'stop');
  assert.deepEqual([stop.body.code, stop.body.current.reason], ['channel-closed', 'supervisor-gone']);
  const cancel = await executeWorkerCommand({ action: 'cancel', slug: 'started-sessions', workerRun: runId, operator: true, via: 'console', reason: 'ended', env: f.env, cwd: f.root });
  assert.equal(cancel.body.disposition, 'cancelled', JSON.stringify(cancel.body));
  await until(() => gone(worker), 'the harness group gone', 5000);
});

test('A-02: a retry dropped while the first write is stalled is written once; its answer is the first message\'s entry', POSIX, async (t: any) => {
  const f = fixture(t);
  const runId = seed(f, { sent: 'first words' });
  // The real launch, with stdin writes held while `held` is set: a harness not reading its stdin (the drain-stall seam).
  const gate: any = { held: false, queue: [] as Array<() => void> };
  const launch = async (o: any) => {
    const r = await launchChannelSession(o);
    const stdin = r.child.stdin;
    const write = stdin.write.bind(stdin);
    stdin.write = (chunk: any, cb: any) => {
      if (!gate.held) return write(chunk, cb);
      gate.queue.push(() => write(chunk, cb));
      return true;
    };
    return r;
  };
  f.supervising.push(superviseRun({ file: f.file, runId, env: f.env, cwd: f.root, launchChannel: launch, channel: { pollMs: 20 } }));
  await until(() => runOf(f, runId)?.channel?.state === 'open' && runOf(f, runId).channel.turn.state === 'waiting', 'the turn waiting');

  const id = rid();
  gate.held = true;
  const first = verb(f, runId, 'send', { requestId: id, text: 'say it once' });
  await until(() => gate.queue.length === 1, 'the first write held');
  // The first file is taken and its write is stalled: no ledger entry and no spool file name the id, so the retry drops.
  const retry = verb(f, runId, 'send', { requestId: id, text: 'say it once' });
  await until(() => waiting(f, runId).length === 1, 'the retry dropped');
  gate.held = false;
  for (const go of gate.queue.splice(0)) go();
  const [a, b] = await Promise.all([first, retry]);
  await sleep(300);
  assert.equal(logLines(f).filter((line) => line.includes('say it once')).length, 1, 'the harness received the message once');
  assert.deepEqual(ledgerOf(f, runId).filter((e: any) => e.requestId === id).map((e: any) => [e.seq, e.outcome]), [[2, 'written']], 'one ledger entry for the id');
  assert.deepEqual(waiting(f, runId), [], 'the retry file was taken and skipped');
  assert.deepEqual([a.body.ok, a.body.message.seq, a.body.message.state], [true, 2, 'written']);
  assert.deepEqual([b.exit, b.body.ok, b.body.message.seq, b.body.message.state, b.body.message.at], [0, true, 2, 'written', a.body.message.at], 'the retry answers with the first message\'s entry');
  const later = await verb(f, runId, 'send', { requestId: id, text: 'say it once' });
  assert.deepEqual([later.body.replayed, later.body.message.seq], [true, 2], 'a later retry is the recorded replay');
});

// ── IC-001's checks, in order, each before any write ─────────────────────────────────────────────

test('check 1: nested-send inside a started session (before any flag is read) and sender-in-run inside a run or worker session', async (t: any) => {
  const f = fixture(t);
  const runId = seedOpen(f);
  const nested = await executeWorkerCommand({ action: 'send', env: { ...f.env, DOFLOW_STARTED_RUN: 'w-aaaaaaaaaaaa' }, cwd: f.root, registry: REGISTRY });
  assert.deepEqual([nested.exit, nested.body.ok, nested.body.code, nested.body.current.runId], [1, false, 'nested-send', 'w-aaaaaaaaaaaa'], 'no flag at all, still nested-send');
  for (const action of ['send', 'steer', 'stop']) {
    const r = await verb(f, runId, action, { env: { ...f.env, DOFLOW_STARTED_RUN: runId } });
    assert.deepEqual([r.exit, r.body.code], [1, 'nested-send'], action);
  }
  for (const [label, env] of [['inside a run', { ...f.env, DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main' }], ['a worker session', { ...f.env, DOFLOW_SESSION_ROLE: 'worker' }]] as any[]) {
    const r = await verb(f, runId, 'send', { env });
    assert.deepEqual([r.exit, r.body.ok, r.body.code], [1, false, 'sender-in-run'], label);
  }
  assert.deepEqual(waiting(f, runId), []);
});

test('check 2: usage is exit 2; no flag carries the text, and the options never hold it', async (t: any) => {
  const f = fixture(t);
  const runId = seedOpen(f);
  const base = { projectKey: f.projectKey, workerRun: runId, requestId: rid(), via: 'console', stdin: true, readStdin: () => 'x', env: f.env, cwd: f.root, registry: REGISTRY, projects: projectsOf(f) };
  const bad: any[] = [
    { projectKey: undefined }, { projectKey: 'ABC' }, { workerRun: undefined }, { workerRun: 'w-xyz' }, { requestId: undefined }, { requestId: 'short' },
    { via: 'person' }, { stdin: false }, { text: 'hello' }, { slug: 'x' }, { harness: 'pi' },
  ];
  for (const change of bad) {
    const { exit, body } = await executeWorkerCommand({ action: 'send', ...base, ...change });
    assert.equal(exit, 2, JSON.stringify(change));
    assert.deepEqual([body.ok, body.error], [false, 'usage'], JSON.stringify({ change, body }));
  }
  const textFlag = await executeWorkerCommand({ action: 'steer', ...base, text: 'hello' });
  assert.match(textFlag.body.message, /--text does not apply/);
  const stopWithStdin = await executeWorkerCommand({ action: 'stop', ...base });
  assert.equal(stopWithStdin.exit, 2, 'stop takes no --stdin');
  assert.match(stopWithStdin.body.message, /--stdin does not apply to --action stop/);
  assert.deepEqual(waiting(f, runId), [], 'no usage case wrote');
});

test('check 3 and 4: project-mismatch, project-not-indexed, unknown-run, not-a-session, run-ended', async (t: any) => {
  const f = fixture(t);
  const runId = seedOpen(f);
  const wrongKey = await verb(f, runId, 'send', { extra: { projectKey: 'f'.repeat(16) } });
  assert.deepEqual([wrongKey.exit, wrongKey.body.code], [1, 'project-mismatch']);
  const unindexed = await verb(f, runId, 'send', { extra: { projects: () => ({ ok: true, body: { projects: [] } }) } });
  assert.deepEqual([unindexed.exit, unindexed.body.code], [1, 'project-not-indexed']);
  const unknown = await verb(f, 'w-000000000000', 'send');
  assert.deepEqual([unknown.exit, unknown.body.code], [1, 'unknown-run']);
  const other = seedOpen(f);
  transition(f.file, other, ['starting'], (run: any) => { run.kind = 'worker'; });
  assert.equal((await verb(f, other, 'steer')).body.code, 'not-a-session');
  const ended = seedOpen(f);
  transition(f.file, ended, ['starting'], (run: any) => { run.end = { state: 'exited', at: iso() }; run.phase = 'ended'; });
  const r = await verb(f, ended, 'stop');
  assert.deepEqual([r.exit, r.body.code, r.body.current.runId], [1, 'run-ended', ended]);
  assert.deepEqual(waiting(f, runId), []);
});

test('check 5: a replay answers from the ledger before any later refusal, and a message still waiting in the spool is pending, not a second write', async (t: any) => {
  const f = fixture(t);
  const id = rid();
  const runId = seedOpen(f, { ledger: [{ seq: 2, kind: 'follow-up', by: 'console', requestId: id, at: iso(), bytes: 7, outcome: 'written', reason: null, answer: 'accepted' }] });
  transition(f.file, runId, ['starting'], (run: any) => { run.channel.turn = { observed: true, state: 'waiting', since: iso(), seq: 2 }; });
  // A steer would be refused not-working, and empty text would be prompt-empty, but the request id was already recorded.
  const replay = await verb(f, runId, 'steer', { requestId: id, text: '   ' });
  assert.deepEqual([replay.exit, replay.body.ok, replay.body.replayed, replay.body.message.kind, replay.body.message.state], [0, true, true, 'follow-up', 'written']);

  const mine = rid();
  spool.dropMessage(f.root, runId, { kind: 'follow-up', requestId: mine, by: 'console', at: iso(), text: 'queued words' });
  const pending = await verb(f, runId, 'send', { requestId: mine, text: 'queued words' });
  assert.deepEqual([pending.body.ok, pending.body.replayed, pending.body.message.state, pending.body.message.seq, pending.body.message.bytes], [true, true, 'pending', null, 12]);
  assert.equal(waiting(f, runId).length, 1, 'still one file');
});

test('check 6: no-channel carries the descriptor reason, started-without-channel an older record, no-steer a descriptor without a steer record', async (t: any) => {
  const f = fixture(t);
  const none = seed(f, { controlChannel: { status: 'unsupported', reason: 'the harness has no stdin protocol DoFlow can drive' } });
  const noChannel = await verb(f, none, 'send');
  assert.deepEqual([noChannel.exit, noChannel.body.code], [1, 'no-channel']);
  assert.ok(noChannel.body.message.includes('the harness has no stdin protocol DoFlow can drive'), noChannel.body.message);
  assert.equal((await verb(f, none, 'stop')).body.code, 'no-channel');
  const older = seed(f, { controlChannel: null });
  const old = await verb(f, older, 'steer');
  assert.deepEqual([old.exit, old.body.code], [1, 'started-without-channel']);
  const steerless = structuredClone(CHANNEL) as any;
  delete steerless.messages.steer;
  const noSteer = seedOpen(f, { controlChannel: steerless });
  const r = await verb(f, noSteer, 'steer', { text: '' });
  assert.deepEqual([r.exit, r.body.code], [1, 'no-steer'], 'no-steer is checked before the text');
  for (const id of [none, older, noSteer]) assert.deepEqual(waiting(f, id), [], 'a refusal wrote nothing');
  assert.equal((await verb(f, noSteer, 'send', { virtual: true })).body.code === 'no-steer', false, 'send is not a steer');
});

test('check 7: prompt-empty, prompt-too-long (code points and bytes) and command-not-allowed (R-4, after leading whitespace) refuse before any write', async (t: any) => {
  const f = fixture(t);
  const runId = seedOpen(f);
  const cases: Array<[string, string]> = [
    ['', 'prompt-empty'], ['  \n\t ', 'prompt-empty'],
    ['a'.repeat(CHANNEL_LIMITS.textCodePoints + 1), 'prompt-too-long'], ['é'.repeat(Math.floor(CHANNEL_LIMITS.textBytes / 2) + 1), 'prompt-too-long'],
    ['/help', 'command-not-allowed'], ['  \n/compact now', 'command-not-allowed'],
  ];
  for (const action of ['send', 'steer']) {
    for (const [text, code] of cases) {
      const r = await verb(f, runId, action, { text });
      assert.deepEqual([r.exit, r.body.ok, r.body.code], [1, false, code], `${action}: ${text.slice(0, 12)}`);
    }
  }
  const fine = await verb(f, runId, 'stop', { virtual: true });
  assert.equal(fine.body.code === 'prompt-empty', false, 'stop carries no text');
  assert.deepEqual(waiting(f, runId).length, 1, 'only the stop was written');
});

test('check 8: a closed channel is channel-closed (naming the cancel), before the turn rule', async (t: any) => {
  const f = fixture(t);
  const runId = seedOpen(f, { state: 'closed', closedReason: 'unused-timeout', turn: { observed: true, state: 'waiting', since: iso(), seq: 1 } });
  for (const action of ['send', 'steer', 'stop']) {
    const r = await verb(f, runId, action);
    assert.deepEqual([r.exit, r.body.code, r.body.current.reason], [1, 'channel-closed', 'unused-timeout'], action);
    assert.ok(r.body.message.includes(`--worker-run ${runId} --operator --via console --reason ended`));
  }
  assert.deepEqual(waiting(f, runId), []);
  const unopened = seed(f);
  const noSpool = await verb(f, unopened, 'send');
  assert.equal(noSpool.body.code, 'no-channel', 'a channel that never opened is no-channel, not a write');
});

test('check 9: steer and stop are not-working while the turn is observed waiting; a send is allowed, and so is a turn not observed', async (t: any) => {
  const f = fixture(t);
  const runId = seedOpen(f, { turn: { observed: true, state: 'waiting', since: iso(), seq: 3 } });
  for (const action of ['steer', 'stop']) {
    const r = await verb(f, runId, action);
    assert.deepEqual([r.exit, r.body.code, r.body.current.turn.state], [1, 'not-working', 'waiting'], action);
  }
  assert.deepEqual(waiting(f, runId), []);
  const send = verb(f, runId, 'send', { virtual: true });
  assert.equal((await send).body.code === 'not-working', false);
  const unobserved = seedOpen(f, { turn: { observed: false, reason: 'no-event-yet', since: null } });
  assert.equal((await verb(f, unobserved, 'stop', { virtual: true })).body.code === 'not-working', false, 'only an observed waiting refuses');
});

test('checks 10 and 11: channel-busy at four waiting (never for stop), actor-rate-limited with retryAfterSeconds', async (t: any) => {
  const f = fixture(t);
  const runId = seedOpen(f);
  for (let i = 0; i < CHANNEL_LIMITS.waiting; i += 1) spool.dropMessage(f.root, runId, { kind: 'follow-up', requestId: rid(), by: 'console', at: iso(), text: `w${i}` });
  for (const action of ['send', 'steer']) {
    const r = await verb(f, runId, action);
    assert.deepEqual([r.exit, r.body.code], [1, 'channel-busy'], action);
  }
  assert.equal(waiting(f, runId).length, 4, 'a refusal wrote nothing');
  const stop = await verb(f, runId, 'stop', { virtual: true });
  assert.deepEqual([stop.body.ok, stop.body.message.state], [true, 'pending'], 'a stop is never busy');
  assert.equal(waiting(f, runId).length, 5);

  // Six follow-ups by this actor in the last minute: the seventh waits. Another actor is not limited.
  const now = Date.now();
  const ledger = Array.from({ length: 6 }, (_, i) => ({ seq: i + 2, kind: 'follow-up', by: 'console', requestId: rid(), at: iso(now - 50_000 + i * 1000), bytes: 3, outcome: 'written', reason: null, answer: 'accepted' }));
  const stamps = { console: { messages: ledger.map((e) => Date.parse(e.at)), stops: [] } };
  const limited = seedOpen(f, { ledger, stamps });
  // The count is the stamps', not the displayed ledger's (review A-01): an empty ledger with 60 stamps in the hour still limits.
  const hourly = seedOpen(f, { stamps: { console: { messages: Array.from({ length: 60 }, (_, i) => now - 3_500_000 + i * 1000), stops: [] } } });
  const capped = await verb(f, hourly, 'send');
  assert.deepEqual([capped.exit, capped.body.code], [1, 'actor-rate-limited']);
  assert.ok(capped.body.current.retryAfterSeconds >= 99 && capped.body.current.retryAfterSeconds <= 101, JSON.stringify(capped.body));
  const r = await verb(f, limited, 'send');
  assert.deepEqual([r.exit, r.body.code], [1, 'actor-rate-limited']);
  assert.ok(Number.isInteger(r.body.current.retryAfterSeconds) && r.body.current.retryAfterSeconds >= 1 && r.body.current.retryAfterSeconds <= 60, JSON.stringify(r.body));
  assert.deepEqual(waiting(f, limited), []);
  const other = await verb(f, limited, 'send', { via: 'device.d-0a1b2c3d4e5f', virtual: true });
  assert.equal(other.body.code === 'actor-rate-limited', false, 'the limit is per actor');
});

// ── What comes back from the supervisor ──────────────────────────────────────────────────────────

test('a pending reply carries the text\'s UTF-8 byte size, on the call that wrote the file and on its replay, 0 for a stop', async (t: any) => {
  const f = fixture(t);
  const runId = seedOpen(f);
  const id = rid();
  const text = 'h\u00e9llo \u4e16\u754c';
  const size = Buffer.byteLength(text, 'utf8');
  assert.notEqual(size, text.length);
  const first = await verb(f, runId, 'send', { requestId: id, text, virtual: true });
  assert.deepEqual([first.body.ok, first.body.replayed, first.body.message.state, first.body.message.bytes], [true, false, 'pending', size]);
  const again = await verb(f, runId, 'send', { requestId: id });
  assert.deepEqual([again.body.replayed, again.body.message.state, again.body.message.bytes], [true, 'pending', size]);
  spool.takeMessages(f.root, runId);
  const stop = await verb(f, runId, 'stop', { virtual: true });
  assert.deepEqual([stop.body.message.state, stop.body.message.bytes], ['pending', 0]);
});

test('a supervisor-side refusal or failure comes back ok:false with its own code, and a replay of it answers the same; a wait that ends is pending', async (t: any) => {
  const f = fixture(t);
  const runId = seedOpen(f);
  const refusedId = rid();
  const answering = answerNext(f, runId, { outcome: 'refused', reason: 'not-working' });
  const refused = await verb(f, runId, 'send', { requestId: refusedId, text: 'raced' });
  await answering;
  assert.deepEqual([refused.exit, refused.body.ok, refused.body.code], [1, false, 'not-working']);
  const replay = await verb(f, runId, 'send', { requestId: refusedId });
  assert.deepEqual([replay.exit, replay.body.code], [1, 'not-working'], 'a replay answers the recorded final state');

  const failed = answerNext(f, runId, { outcome: 'failed', reason: 'stdin-stalled' });
  const stalled = await verb(f, runId, 'send', { text: 'stalls' });
  await failed;
  assert.deepEqual([stalled.exit, stalled.body.code], [1, 'stdin-stalled']);

  const unanswered = await verb(f, runId, 'send', { text: 'nobody takes this', virtual: true });
  assert.deepEqual([unanswered.exit, unanswered.body.ok, unanswered.body.message.state, unanswered.body.message.seq, unanswered.body.message.answer], [0, true, 'pending', null, null]);
  assert.equal(waiting(f, runId).length, 1);
  spool.takeMessages(f.root, runId);

  // An accepted answer that has not arrived yet (the harness declares answers) is waited for, inside the 2 s.
  const lateId = rid();
  const late = answerNext(f, runId, {}, 200);
  const written = await verb(f, runId, 'send', { requestId: lateId, text: 'late answer' });
  await late;
  assert.deepEqual([written.body.ok, written.body.message.state, written.body.message.answer], [true, 'written', 'accepted']);
  const never = answerNext(f, runId, {});
  const silent = await verb(f, runId, 'send', { text: 'no answer comes' });
  await never;
  assert.deepEqual([silent.body.ok, silent.body.message.state, silent.body.message.answer], [true, 'written', null], 'a harness that has not answered inside the grace leaves answer null');
});

// ── The same through the handler's printed output ────────────────────────────────────────────────

test('handleWorkerCommand prints one summary line per outcome and sets the exit code: 0 written, 1 refused', async (t: any) => {
  const f = fixture(t);
  const runId = seedOpen(f);
  const logs: string[] = [];
  t.mock.method(console, 'log', (line: any) => logs.push(String(line)));
  t.mock.method(console, 'error', (line: any) => logs.push(String(line)));
  const saved = process.exitCode;
  t.after(() => { process.exitCode = saved; });
  const answering = answerNext(f, runId, {});
  const ok = await handleWorkerCommand({ action: 'send', projectKey: f.projectKey, workerRun: runId, requestId: rid(), via: 'console', stdin: true, readStdin: () => 'hello', env: f.env, cwd: f.root, registry: REGISTRY, projects: projectsOf(f) });
  await answering;
  assert.equal(ok, 0);
  assert.deepEqual(logs.splice(0), ['follow-up written']);
  const refused = await handleWorkerCommand({ action: 'steer', projectKey: f.projectKey, workerRun: runId, requestId: rid(), stdin: true, readStdin: () => '/help', env: f.env, cwd: f.root, registry: REGISTRY, projects: projectsOf(f) });
  assert.equal(refused, 1);
  assert.deepEqual(logs.splice(0), ['refused command-not-allowed']);
  const usage = await handleWorkerCommand({ action: 'stop', projectKey: f.projectKey, workerRun: 'bad', requestId: rid(), env: f.env, cwd: f.root, registry: REGISTRY, projects: projectsOf(f) });
  assert.equal(usage, 2);
  process.exitCode = saved;
});
