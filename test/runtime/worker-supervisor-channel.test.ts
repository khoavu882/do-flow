'use strict';

// Row 170 T4 (design D3, §5.1-§5.3, IC-002, IC-003; owner rulings R-4, R-9, R-10): the channel spool, the channel
// launch and the supervisor's channel branch. Every harness here is the fake channel harness
// (test/helper/fake-channel-harness.ts), run by absolute path through node; no real harness CLI can run. Every process
// group a test starts is ended in its `after`, and the tests that kill a supervisor assert the harness group is gone.

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
const { mainLaunchRecord } = require(path.join(SRC, 'worker', 'launch.ts'));
const { executeWorkerCommand } = require(path.join(SRC, 'worker', 'command.ts'));
const tree = require(path.join(SRC, 'worker', 'process-tree.ts'));
const { channelsBody } = require(path.join(SRC, 'events', 'session-channels.ts'));
const { workerCatalogue } = require(path.join(SRC, 'worker', 'catalogue.ts'));
const { loadRegistry } = require(path.join(REPO, 'src', 'registry', 'index.ts'));
const FAKE = path.join(REPO, 'test', 'helper', 'fake-channel-harness.ts');

const POSIX: any = { skip: process.platform === 'win32' && 'worker process control and O_NOFOLLOW are not run on win32 (R-10)' };
const RUN = 'w-0123456789ab';
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const at = () => new Date().toISOString();

// ── The spool (IC-003, R-10) ────────────────────────────────────────────────────────────────────

test('spool: a 0700 directory, 0600 files named <ms>-<8 hex>.json, taken oldest first and deleted on take', POSIX, (t: any) => {
  const root = tempDir(t, 'doflow-spool-');
  const dir = spool.createSpool(root, RUN);
  assert.equal(dir, path.join(root, '.doflow', 'state', 'channel-spool', RUN));
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(path.dirname(dir)), 0o700);
  const first = spool.dropMessage(root, RUN, { kind: 'follow-up', requestId: 'rAAAAAAAAAAAAAAAAAAAAA', by: 'console', at: at(), text: 'one' });
  const second = spool.dropMessage(root, RUN, { kind: 'stop', requestId: null, by: 'manual', at: at() });
  assert.match(first.name, /^[0-9]+-[0-9a-f]{8}\.json$/);
  assert.equal(mode(path.join(dir, first.name)), 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter((n: string) => n.endsWith('.tmp')), [], 'no temporary file is left');
  assert.deepEqual(spool.waitingNames(root, RUN).length, 2);
  // An older name written later is still taken first: the order is the name's milliseconds, then its hex.
  fs.writeFileSync(path.join(dir, '1-ffffffff.json'), JSON.stringify({ v: 1, kind: 'steer', requestId: null, by: 'console', at: at(), text: 'old' }), { mode: 0o600 });
  const taken = spool.takeMessages(root, RUN);
  const byAge = [first.name, second.name].sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]) || (a < b ? -1 : 1));
  assert.deepEqual(taken.map((t: any) => t.name), ['1-ffffffff.json', ...byAge], 'oldest name first');
  assert.deepEqual(taken.map((t: any) => [t.ok, t.message.kind]).sort(), [[true, 'follow-up'], [true, 'steer'], [true, 'stop']]);
  assert.equal(taken.find((t: any) => t.message.kind === 'follow-up').message.text, 'one');
  assert.deepEqual(fs.readdirSync(dir), [], 'every taken file is gone');
  assert.deepEqual(spool.takeMessages(root, RUN), []);
  spool.removeSpool(root, RUN);
  assert.equal(fs.existsSync(dir), false);
  spool.removeSpool(root, RUN);
});

test('spool: a symlink, an oversize file, a FIFO and a malformed file are refused and deleted; the link target is untouched', POSIX, (t: any) => {
  const root = tempDir(t, 'doflow-spool-');
  const dir = spool.createSpool(root, RUN);
  const target = path.join(root, 'outside.json');
  fs.writeFileSync(target, JSON.stringify({ v: 1, kind: 'follow-up', requestId: null, by: 'console', at: at(), text: 'from a link' }));
  fs.symlinkSync(target, path.join(dir, '1-00000001.json'));
  fs.writeFileSync(path.join(dir, '2-00000002.json'), 'x'.repeat(spool.FILE_MAX + 1));
  const fifo = spawnSync('mkfifo', [path.join(dir, '3-00000003.json')]);
  fs.writeFileSync(path.join(dir, '4-00000004.json'), '{"v":1,"kind":"bash"}');
  fs.writeFileSync(path.join(dir, 'not-a-message.txt'), 'ignored');
  const taken = spool.takeMessages(root, RUN);
  const expected: any[] = [['1-00000001.json', 'symlink'], ['2-00000002.json', 'too-large'], ['4-00000004.json', 'malformed']];
  if (fifo.status === 0) expected.splice(2, 0, ['3-00000003.json', 'not-a-file']);
  assert.deepEqual(taken.map((t: any) => [t.name, t.ok ? 'taken' : t.reason]), expected);
  assert.deepEqual(fs.readdirSync(dir), ['not-a-message.txt'], 'refused files are deleted, other names are not read');
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).text, 'from a link', 'the link target is neither read into the channel nor removed');
});

test('spool: a linked spool directory is refused and removing it removes the link only; drops need an open spool and fit 64 KiB', POSIX, (t: any) => {
  const root = tempDir(t, 'doflow-spool-');
  const store = path.join(root, '.doflow', 'state', 'channel-spool');
  fs.mkdirSync(store, { recursive: true });
  const elsewhere = tempDir(t, 'doflow-spool-elsewhere-');
  fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'keep');
  fs.symlinkSync(elsewhere, path.join(store, RUN));
  assert.throws(() => spool.takeMessages(root, RUN), { code: 'spool-unsafe' });
  assert.throws(() => spool.dropMessage(root, RUN, { kind: 'stop', requestId: null, by: 'console', at: at() }), { code: 'spool-unsafe' });
  spool.removeSpool(root, RUN);
  assert.equal(fs.existsSync(path.join(store, RUN)), false);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'keep.txt'), 'utf8'), 'keep');
  assert.throws(() => spool.dropMessage(root, RUN, { kind: 'stop', requestId: null, by: 'console', at: at() }), { code: 'spool-missing' });
  spool.createSpool(root, RUN);
  assert.throws(() => spool.dropMessage(root, RUN, { kind: 'follow-up', requestId: null, by: 'console', at: at(), text: 'x'.repeat(spool.FILE_MAX) }), { code: 'message-too-large' });
  assert.throws(() => spool.dropMessage(root, RUN, { kind: 'bash', requestId: null, by: 'console', at: at() }), { code: 'usage' });
  assert.throws(() => spool.spoolDir(root, '../x'), { code: 'usage' });
});

// ── The channel session (§5.1, §5.2, IC-002; R-4, R-9) ──────────────────────────────────────────────────────────────

/** A channel shaped like Pi's RPC mode (design 4.3); every shipped harness says `unknown`, so the tests declare one. */
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
const PI = workerCatalogue({ registry: loadRegistry({ repoRoot: REPO }) }).find((entry: any) => entry.id === 'pi').worker;
const requestId = () => `r${crypto.randomBytes(16).toString('base64url').slice(1)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * A scratch project (a git repo, so an operator cancel resolves its root), a bin/ holding `fake-pi` (a link to the fake
 * channel harness, named by absolute path in the descriptor) beside a `node` link, and a scratch HOME and config home.
 * Its `after` (registered before tempDir's removal) ends every process group the store recorded.
 */
function fixture(t: any) {
  let f: any = null;
  t.after(async () => {
    if (!f) return;
    for (const n of [1, 2, 3, 4]) { try { fs.writeFileSync(`${f.gate}-${n}`, ''); } catch { /* gone */ } }
    let runs: any = {};
    try { runs = readRuns(f.file); } catch { runs = {}; }
    for (const run of Object.values(runs) as any[]) {
      for (const proc of [run.worker, run.supervisor]) {
        if (proc && Number.isInteger(proc.pid) && proc.pid !== process.pid) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }
    for (const done of f.supervising) await Promise.race([done.catch(() => null), sleep(5000)]);
  });
  const dir = fs.realpathSync(tempDir(t, 'doflow-channel-'));
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
  return f;
}

/** A `starting` channel session as start-session records it: the prompt in its store, the launch record, the descriptor. */
function seed(f: any, sent: string) {
  const runId = newRunId();
  const descriptor = { ...structuredClone(PI), cli: { binary: path.join(f.bin, 'fake-pi') }, controlChannel: structuredClone(CHANNEL) };
  writePrompt(f.root, runId, sent, { isEnded: () => false });
  const r = insertRun(f.file, {
    runId, kind: 'main-session', task: 'main-session', token: 1, request: requestId(), childOf: null, harness: 'pi', phase: 'starting',
    createdAt: new Date().toISOString(), timeoutSeconds: 600, startedBy: 'console', project: { projectKey: 'a'.repeat(16), worktreeKey: 'b'.repeat(16) },
    execWorktree: f.root, entry: 'none', binding: null,
    prompt: { store: 'session-prompts', name: `${runId}.prompt.txt`, sha256: crypto.createHash('sha256').update(sent, 'utf8').digest('hex'), bytes: Buffer.byteLength(sent) },
    ...mainLaunchRecord(descriptor, sent, null, true),
    descriptor,
  });
  assert.equal(r.applied, true);
  return runId;
}

const runOf = (f: any, runId: string) => readRuns(f.file)[runId];
const logLines = (f: any): string[] => (fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').split(/(?<=\n)/).filter(Boolean) : []);
const ledgerOf = (f: any, runId: string) => runOf(f, runId)?.channel?.ledger ?? [];
const drop = (f: any, runId: string, kind: string, text?: string, by = 'console') => spool.dropMessage(f.root, runId, { kind, requestId: requestId(), by, at: at(), ...(text === undefined ? {} : { text }) });
const record = (template: any, text: string, id: string) => `${JSON.stringify({ ...template, message: text, id })}\n`;

/** The supervisor of `runId` as `worker --action start-session` spawns it: detached, its pid recorded by compare-and-set. */
function detachedSupervisor(f: any, runId: string, env: any) {
  const child = spawn(process.execPath, [SUPERVISOR_FILE, f.file, runId], { detached: true, stdio: 'ignore', cwd: f.root, env });
  child.unref();
  const supervisor = { pid: child.pid, pgid: child.pid, start: tree.procStart(child.pid) };
  transition(f.file, runId, ['starting', 'running', 'cancelling'], (run: any) => { run.supervisor = supervisor; });
  return supervisor;
}

const gone = (proc: any) => tree.alive(proc) === false && tree.groupAlive(proc.pgid, proc.start) === false;

test('channel: the first prompt is the framed follow-up, a spool message arrives byte-exact and leaves the spool, the turn goes working then waiting, the ledger holds bytes but no text, and 30 idle minutes close it', POSIX, async (t: any) => {
  const f = fixture(t);
  const first = 'first words for the session';
  const second = 'second "quoted"\nline   café {text} \\ end';
  const runId = seed(f, first);
  let clock = Date.now();
  const done = superviseRun({ file: f.file, runId, env: { ...f.env, FAKE_CHANNEL_GATE: f.gate }, cwd: f.root, channel: { now: () => clock, pollMs: 20 } });
  f.supervising.push(done);

  await until(() => logLines(f).length >= 1, 'the first record');
  assert.equal(logLines(f)[0], record(CHANNEL.messages.followUp, first, 'd-1'), 'the stored prompt as the framed follow-up, id d-1');
  await until(() => runOf(f, runId)?.channel?.state === 'open' && runOf(f, runId).channel.turn.state === 'working', 'the turn working');
  assert.equal(runOf(f, runId).recipe.promptVia, 'channel');

  drop(f, runId, 'follow-up', second);
  await until(() => logLines(f).length >= 2, 'the spool message');
  assert.equal(logLines(f)[1], record(CHANNEL.messages.followUp, second, 'd-2'), 'byte-exact, id d-2');
  const dir = spool.spoolDir(f.root, runId);
  assert.deepEqual(fs.readdirSync(dir), [], 'a taken message is gone from the spool');

  // R-4 at the supervisor, and a planted link: neither reaches the harness.
  drop(f, runId, 'follow-up', '/help');
  const outside = path.join(f.dir, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ v: 1, kind: 'follow-up', requestId: null, by: 'console', at: at(), text: 'from a link' }));
  fs.symlinkSync(outside, path.join(dir, `${Date.now()}-0000000a.json`));
  await until(() => ledgerOf(f, runId).some((e: any) => e.reason === 'command-not-allowed'), 'the command refusal');
  await until(() => fs.readdirSync(dir).length === 0, 'the link taken');
  await sleep(100);
  assert.equal(logLines(f).length, 2, 'the command and the link never reach the harness');
  assert.ok(fs.existsSync(outside), 'the link target is left alone');

  for (const n of [1, 2]) fs.writeFileSync(`${f.gate}-${n}`, '');
  await until(() => {
    const ch = runOf(f, runId).channel;
    return ch.turn.state === 'waiting' && ch.ledger.find((e: any) => e.seq === 2)?.answer === 'accepted';
  }, 'the turn waiting');
  drop(f, runId, 'steer', 'steer while waiting');
  await until(() => ledgerOf(f, runId).some((e: any) => e.kind === 'steer'), 'the steer entry');

  const ch = runOf(f, runId).channel;
  assert.deepEqual(ch.ledger.map((e: any) => [e.seq, e.kind, e.by, e.bytes, e.outcome, e.reason, e.answer]), [
    [1, 'first', 'console', Buffer.byteLength(first), 'written', null, 'accepted'],
    [2, 'follow-up', 'console', Buffer.byteLength(second), 'written', null, 'accepted'],
    [3, 'follow-up', 'console', 5, 'refused', 'command-not-allowed', null],
    [4, 'steer', 'console', Buffer.byteLength('steer while waiting'), 'refused', 'not-working', null],
  ]);
  assert.deepEqual([ch.sent.count, ch.sent.bytes], [2, Buffer.byteLength(first) + Buffer.byteLength(second)]);
  const stored = fs.readFileSync(f.file, 'utf8');
  for (const text of [first, 'second', '/help', 'steer while waiting', 'from a link']) assert.ok(!stored.includes(text), `the store holds no text: ${text}`);
  assert.deepEqual(fs.readdirSync(dir), [], 'the spool holds no text');

  // The idle close reads the injected clock: 29 minutes is not idle, 30 is.
  clock += 29 * 60 * 1000;
  await sleep(150);
  assert.equal(runOf(f, runId).channel.state, 'open');
  clock += 60 * 1000;
  const run = await done;
  assert.deepEqual([run.phase, run.channel.state, run.channel.closedReason, run.process.code], ['ended', 'closed', 'idle', 0]);
  assert.equal(fs.existsSync(dir), false, 'the spool is removed at the end');
  assert.equal(logLines(f).length, 2);
});

test('channel: a harness that refuses the first record leaves the turn not observed, message-refused; its exit closes the channel', POSIX, async (t: any) => {
  const f = fixture(t);
  const runId = seed(f, 'please refuse this');
  const done = superviseRun({ file: f.file, runId, env: { ...f.env, FAKE_CHANNEL_MODE: 'refuse' }, cwd: f.root, channel: { pollMs: 20 } });
  f.supervising.push(done);
  await until(() => ledgerOf(f, runId)[0]?.answer === 'refused' && runOf(f, runId).channel.turn.reason === 'message-refused', 'the refusal');
  assert.equal(runOf(f, runId).channel.turn.observed, false);
  process.kill(-runOf(f, runId).worker.pid, 'SIGKILL');
  const run = await done;
  assert.deepEqual([run.phase, run.channel.closedReason], ['ended', 'harness-exited']);
  assert.equal(fs.existsSync(spool.spoolDir(f.root, runId)), false);
});

test('no orphan: SIGKILL of the supervisor closes the harness stdin, so the harness and its group are gone within graceSeconds + 2 s and the spool holds no text', POSIX, async (t: any) => {
  const f = fixture(t);
  const first = 'kill test first prompt';
  const runId = seed(f, first);
  const supervisor = detachedSupervisor(f, runId, f.env);
  await until(() => runOf(f, runId)?.channel?.state === 'open' && logLines(f).length >= 1, 'the channel open');
  drop(f, runId, 'follow-up', 'kill test follow-up');
  await until(() => logLines(f).length >= 2, 'the follow-up');
  const worker = runOf(f, runId).worker;
  assert.equal(tree.alive(worker), true, 'the harness runs before the kill');
  assert.equal(logLines(f)[0], record(CHANNEL.messages.followUp, first, 'd-1'));

  process.kill(supervisor.pid, 'SIGKILL');
  await until(() => gone(worker), 'the harness group gone', (CHANNEL.close.graceSeconds + 2) * 1000);
  assert.equal(tree.alive(supervisor), false);
  const dir = spool.spoolDir(f.root, runId);
  const left = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.deepEqual(left, [], 'the spool holds no message text');
  assert.ok(!fs.readFileSync(f.file, 'utf8').includes('kill test'), 'nor does the store');
  // The run never ended: a reader says why, and an operator cancel ends it and removes the spool.
  const [item] = channelsBody({ root: f.root, now: Date.now(), cache: new Map() }).items;
  assert.deepEqual([item.runId, item.turn.reason], [runId, 'supervisor-gone']);
  const cancel = await executeWorkerCommand({ action: 'cancel', slug: 'started-sessions', workerRun: runId, operator: true, via: 'console', reason: 'supervisor killed', env: f.env, cwd: f.root });
  assert.equal(cancel.body.disposition, 'cancelled', JSON.stringify(cancel.body));
  assert.equal(fs.existsSync(dir), false);
});

test('R-9: a harness that ignores its closed stdin outlives the killed supervisor, reads supervisor-gone, and an operator cancel ends its group and removes the spool', POSIX, async (t: any) => {
  const f = fixture(t);
  const runId = seed(f, 'stubborn first prompt');
  const supervisor = detachedSupervisor(f, runId, { ...f.env, FAKE_CHANNEL_MODE: 'ignore-eof' });
  await until(() => runOf(f, runId)?.channel?.state === 'open' && runOf(f, runId).channel.turn.state === 'waiting', 'the turn waiting');
  const worker = runOf(f, runId).worker;
  process.kill(supervisor.pid, 'SIGKILL');
  await until(() => tree.alive(supervisor) === false, 'the supervisor gone');
  await sleep(1000);
  assert.equal(tree.alive(worker), true, 'the stubborn harness survives its supervisor');
  const dir = spool.spoolDir(f.root, runId);
  assert.ok(fs.existsSync(dir), 'no supervisor removed the spool');
  const [item] = channelsBody({ root: f.root, now: Date.now(), cache: new Map() }).items;
  assert.deepEqual([item.channel, item.turn], ['open', { observed: false, reason: 'supervisor-gone', since: null }]);

  const cancel = await executeWorkerCommand({ action: 'cancel', slug: 'started-sessions', workerRun: runId, operator: true, via: 'console', reason: 'stubborn harness', env: f.env, cwd: f.root });
  assert.equal(cancel.body.disposition, 'cancelled', JSON.stringify(cancel.body));
  await until(() => gone(worker), 'the stubborn group gone', 5000);
  assert.equal(fs.existsSync(dir), false, 'the cancel removed the spool');
  assert.equal(runOf(f, runId).phase, 'ended');
});
