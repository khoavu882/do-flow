'use strict';

// Feature 161 T5 (IC-004, IC-005, IC-001, DEC-012; AC-7): the `file:<pk>:<fk>` and `transcript:<pk>:<ak>`
// lanes of `doflow events --follow`, and `events --kinds`. Scratch HOME and config home, scratch git
// projects, hand-written Claude transcripts; the in-process cases inject the clock and the watch, so the
// 250 ms log pass, the debounce and the 30 s pass run on a fake clock. The one process case runs the
// events verb under an fs and child-process probe of its own and compares the scratch tree before and after.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');
const { sha16 } = require('../../src/runtime/scaffold/fingerprint.ts');
const { maskBody } = require('../../src/runtime/mask.ts');
const { handleEventsCommand } = require('../../src/runtime/events/command.ts');
const { createProjectsIndex } = require('../../src/runtime/events/projects-index.ts');
const { createEnvelopeWriter, LOG_ID, LINE_CAP_BYTES } = require('../../src/runtime/events/envelope.ts');
const { LOG_PASS_MS, DEBOUNCE_MS, FULL_TICKS, PASS_MS } = require('../../src/runtime/events/detector.ts');
const { createFileLane } = require('../../src/runtime/events/files.ts');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const WIN = process.platform === 'win32';
const SCRATCH = 'scratch.noindex'; // not in any fixture path, so the scratch projects are listed
const GH = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const PASS = LOG_PASS_MS + DEBOUNCE_MS;
const NO_KEYS = '0'.repeat(16);

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A fake clock that starts at the real time, so the files the test writes are "recent" on it. */
function fakeClock() {
  let now = Math.floor(Date.now() / 1000) * 1000;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) { nextId += 1; timers.set(nextId, { at: now + ms, fn, every: null }); return nextId; },
    clearTimeout(id: number) { timers.delete(id); },
    setInterval(fn: () => void, ms: number) { nextId += 1; timers.set(nextId, { at: now + ms, fn, every: ms }); return nextId; },
    clearInterval(id: number) { timers.delete(id); },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        await settle();
        let pick: [number, { at: number; fn: () => void; every: number | null }] | null = null;
        for (const entry of timers) if (entry[1].at <= target && (!pick || entry[1].at < pick[1].at)) pick = entry;
        if (!pick) break;
        const [id, timer] = pick;
        now = timer.at;
        if (timer.every !== null) timer.at += timer.every; else timers.delete(id);
        timer.fn();
      }
      now = target;
      await settle();
    },
  };
}

function fakeWatch() {
  const handles: any[] = [];
  const watch: any = (dir: string, _options: any, listener: (type: string, name: string | null) => void) => {
    const handle: any = { dir, closed: false, close() { handle.closed = true; }, on() { return handle; }, emit(type: string, name: string | null) { if (!handle.closed) listener(type, name); } };
    handles.push(handle);
    return handle;
  };
  return watch;
}

function fakeStdin() {
  const stdin: any = new EventEmitter();
  stdin.pause = () => {};
  stdin.destroy = () => {};
  stdin.json = (op: string, ch: string) => stdin.emit('data', Buffer.from(`${JSON.stringify({ op, ch })}\n`, 'utf8'));
  return stdin;
}

function sink() {
  const s: any = { text: '', write(chunk: string) { s.text += chunk; return true; } };
  s.frames = () => s.text.split('\n').filter((l: string) => l !== '').map((l: string) => JSON.parse(l));
  return s;
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV },
  });
  assert.equal(r.status, 0, r.stderr);
}

function fixture(t: any) {
  const root = fs.realpathSync(tempDir(t, 'doflow-events-lanes-'));
  const f: any = { root, home: path.join(root, 'home'), config: path.join(root, 'config') };
  f.store = path.join(f.config, 'doflow', 'session-env');
  f.sessions = path.join(f.store, 'sessions');
  fs.mkdirSync(path.join(f.home, '.doflow', 'state'), { recursive: true });
  fs.mkdirSync(f.sessions, { recursive: true });
  f.env = {
    HOME: f.home, USERPROFILE: f.home, XDG_CONFIG_HOME: f.config, TMPDIR: process.env.TMPDIR,
    PATH: process.env.PATH, ...(WIN ? { SystemRoot: process.env.SystemRoot } : {}),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, DOFLOW_TELEMETRY: 'off',
    DOFLOW_FAILURE_CAPTURE: 'off', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', COPILOT_HOME: '', PI_CODING_AGENT_SESSION_DIR: '',
  };
  return f;
}

/** A DoFlow project (a git repository with `.doflow/state`), registered in `upkeep-roots`. */
function project(f: any, name: string, base: string = f.root): string {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, '.doflow', 'state', 'orchestration'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.appendFileSync(path.join(f.home, '.doflow', 'state', 'upkeep-roots'), `${dir}\n`);
  return dir;
}

function indexFor(f: any, cwd: string, now: () => number = Date.now) {
  return createProjectsIndex({ env: f.env, cwd, now, tempRoots: [], scratchName: SCRATCH });
}

function auditLine(event: string, sessionId: string, agentId: string): string {
  return `${JSON.stringify({ timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), session_id: sessionId, event, agent_type: 'Explore', agent_id: agentId })}\n`;
}

/** A hook session as the hooks leave it: a model observation at the checkout and a session directory with its git context. */
function session(f: any, rawId: string, cwd: string): void {
  const dir = path.join(f.store, 'primary', cwdHash(cwd), 'claude');
  fs.mkdirSync(dir, { recursive: true });
  const observedAt = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(path.join(dir, `${sha16(rawId)}.json`), JSON.stringify({ schema: 1, harness: 'claude', model: 'claude-fixture-1', event: 'SessionStart', observedAt, session: sha16(rawId) }));
  const sdir = path.join(f.sessions, rawId);
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'git-context.json'), JSON.stringify({ cwd, captured_at: observedAt, branch: 'main' }));
}

/** One Claude transcript record: a reply (or a record the reader skips) of the session. */
function reply(rawId: string, cwd: string, text: string, n: number): string {
  return `${JSON.stringify({
    type: 'assistant', timestamp: new Date(Date.UTC(2026, 10, 15, 9, 0, n)).toISOString(), sessionId: rawId, cwd, uuid: `u-${n}`,
    message: { id: `msg-${n}`, role: 'assistant', model: 'claude-fixture-1', content: [{ type: 'text', text }] },
  })}\n`;
}

function transcriptFile(f: any, rawId: string): string {
  return path.join(f.home, '.claude', 'projects', '-lanes', `${rawId}.jsonl`);
}

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const fileKeyOf = (checkout: string, rel: string) => sha16(`${checkout}\0${rel}`);
const inoOf = (file: string) => String(fs.statSync(file, { bigint: true }).ino);

/** One in-process `--control stdin` run on a scratch project, with a real project index on the fake clock. */
function start(t: any, f: any, cwd: string, clock: any = fakeClock()) {
  const saved = process.exitCode;
  t.after(() => { process.exitCode = saved; });
  const stdin = fakeStdin();
  const stdout = sink();
  const stderr = sink();
  const done = handleEventsCommand({
    follow: true, control: 'stdin', json: true, flags: ['--follow', '--control', '--json'], positional: [], cwd, env: f.env,
    stdin, stdout, stderr, clock, watch: fakeWatch(), signals: new EventEmitter(), epoch: '0a1b2c3d',
    projectsIndex: indexFor(f, cwd, () => clock.now()),
  });
  let ended = false;
  const end = async (): Promise<number> => { if (!ended) { ended = true; stdin.emit('end'); } return done; };
  t.after(end);
  const of = (ch: string) => stdout.frames().filter((x: any) => x.ch === ch);
  return { clock, stdin, stdout, stderr, done, end, of };
}

const shape = (frames: any[]) => frames.map((x: any) => [x.type, x.data]);
/** The text a lane's pieces rebuild: each piece is a line without its newline. */
const rebuilt = (frames: any[]) => frames.filter((x: any) => x.type === 'snapshot' || x.type === 'append').flatMap((x: any) => x.data.pieces).map((p: any) => `${p.text}\n`).join('');

// ── file: ────────────────────────────────────────────────────────────────────────────────────────────

const REL = 'agent-docs/doflow/161-x/exec/task-3-brief.md';

test('161 T5 IC-004: a brief grown in three writes gives snapshot then appends whose pieces concatenate to the masked file; a rename-over gives reset replaced then snapshot; a fileKey not in the index gives gone', async (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-a');
  const pk = cwdHash(a);
  const ch = `file:${pk}:${fileKeyOf(a, REL)}`;
  const file = write(path.join(a, ...REL.split('/')), '# Task 3\n');
  const h = start(t, f, a);

  h.stdin.json('sub', ch);
  h.stdin.json('sub', `file:${pk}:${NO_KEYS}`);
  await settle();
  assert.deepEqual(shape(h.of(ch)), [['snapshot', { log: 'open', ino: inoOf(file), from: 0, to: 9, pieces: [{ at: 0, text: '# Task 3' }], phase: null, end: null }]]);
  assert.deepEqual(shape(h.of(`file:${pk}:${NO_KEYS}`)), [['gone', {}]], 'a fileKey the index does not list');

  fs.appendFileSync(file, 'goal one\n');
  await h.clock.advance(PASS);
  fs.appendFileSync(file, `token ${GH} and more\n`);
  await h.clock.advance(PASS);
  const frames = h.of(ch);
  assert.deepEqual(frames.map((x: any) => x.type), ['snapshot', 'append', 'append']);
  assert.deepEqual(frames[1].data, { from: 9, to: 18, pieces: [{ at: 9, text: 'goal one' }], phase: null, end: null });
  assert.equal(frames[2].data.from, 18);
  assert.equal(frames[2].data.to, fs.statSync(file).size);
  for (const x of frames) {
    assert.match(x.id, LOG_ID);
    const [ino, offset] = x.id.split(':');
    assert.equal(ino, inoOf(file));
    assert.equal(Number(offset), x.data.to);
  }
  assert.equal(rebuilt(frames), maskBody(fs.readFileSync(file, 'utf8')).text, 'the pieces are the masked file');
  assert.ok(!h.stdout.text.includes(GH), 'the secret never leaves masked');

  // A rename-over is a new inode: reset replaced, then a snapshot of the new file.
  const swap = `${file}.tmp`;
  fs.writeFileSync(swap, 'rewritten\n');
  fs.renameSync(swap, file);
  await h.clock.advance(PASS);
  assert.deepEqual(h.of(ch).slice(3).map((x: any) => [x.type, x.data.reason ?? x.data.ino]), [['reset', 'replaced'], ['snapshot', inoOf(file)]]);
  assert.deepEqual(h.of(ch).at(-1).data.pieces, [{ at: 0, text: 'rewritten' }]);

  // The same inode with fewer bytes than the cursor is also a reset.
  fs.appendFileSync(file, 'grown a bit\n');
  await h.clock.advance(PASS);
  fs.writeFileSync(file, 'x\n');
  await h.clock.advance(PASS);
  assert.deepEqual(h.of(ch).slice(-2).map((x: any) => x.type), ['reset', 'snapshot']);
  assert.deepEqual(h.of(ch).at(-1).data.pieces, [{ at: 0, text: 'x' }]);

  // A file that leaves the index is gone, and nothing more is printed for it.
  fs.unlinkSync(file);
  await h.clock.advance(PASS);
  assert.deepEqual(shape(h.of(ch).slice(-1)), [['gone', {}]]);
  const count = h.stdout.frames().length;
  await h.clock.advance(2 * PASS);
  assert.equal(h.stdout.frames().length, count);
  assert.equal(await h.end(), 0);
  assert.equal(h.stderr.text, '');
  assert.ok(!h.stdout.text.includes(f.root), 'no path leaves the core');
});

test('161 T5 IC-004: a project the index does not know and an unlisted worker .last.log give gone; a symbolic link is never followed', async (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-a');
  const pk = cwdHash(a);
  const output = path.join(a, '.doflow', 'state', 'worker-output');
  write(path.join(output, 'w-0123456789ab.last.log'), 'final words\n');
  const outside = write(path.join(f.root, 'outside.md'), 'OUTSIDE-SECRET\n');
  const exec = path.join(a, 'agent-docs', 'doflow', '161-x', 'exec');
  fs.mkdirSync(exec, { recursive: true });
  fs.symlinkSync(outside, path.join(exec, 'task-9-brief.md'));
  const h = start(t, f, a);
  const lanes = [
    `file:${'f'.repeat(16)}:${NO_KEYS}`,
    `file:${pk}:${fileKeyOf(a, '.doflow/state/worker-output/w-0123456789ab.last.log')}`,
    `file:${pk}:${fileKeyOf(a, 'agent-docs/doflow/161-x/exec/task-9-brief.md')}`,
  ];
  for (const ch of lanes) h.stdin.json('sub', ch);
  await settle();
  for (const ch of lanes) assert.deepEqual(shape(h.of(ch)), [['gone', {}]], ch);
  assert.ok(!h.stdout.text.includes('OUTSIDE-SECRET') && !h.stdout.text.includes('final words'));
  assert.equal(await h.end(), 0);
});

/** A file lane made directly on `root` (one checkout), with a fake index and clock, as the review's reproducer runs it. */
function directLane(root: string, rel: string, fsImpl?: any) {
  const pk = 'a'.repeat(16);
  const index = { lookup: (k: string) => (k === pk ? { projectKey: pk, main: root, checkouts: [root] } : null) };
  const clock = { t: 1_000_000 };
  const writer = createEnvelopeWriter({ clock: () => clock.t });
  const lane = createFileLane({ channel: { kind: 'file', name: `file:${pk}:${fileKeyOf(root, rel)}`, projectKey: pk, fileKey: fileKeyOf(root, rel) }, ctx: { cwd: root, index }, writer, now: () => clock.t, ...(fsImpl ? { fsImpl } : {}) });
  lane.sources();
  const step = (ms = 0) => { clock.t += ms; return lane.recompute(false).lines.map((l: string) => JSON.parse(l)); };
  return { lane, step };
}

test('161 review 1: a followed brief swapped for a link inside the 25 s listing window streams nothing from outside and is gone', (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-a');
  const brief = write(path.join(a, ...REL.split('/')), '# brief\n');
  const outside = write(path.join(f.root, 'OUTSIDE-SECRET.txt'), 'contents of a file outside the artifact set\n');
  const { step } = directLane(a, REL);
  assert.deepEqual(step().map((x: any) => x.type), ['snapshot']);
  const tmp = `${brief}.tmp`;
  fs.symlinkSync(outside, tmp);
  fs.renameSync(tmp, brief);
  const after = [...step(1000), ...step(25000)];
  assert.ok(!JSON.stringify(after).includes('outside the artifact set'), JSON.stringify(after));
  assert.deepEqual(after.map((x: any) => x.type), ['gone']);
});

test('161 review 1: a directory on the way to the brief swapped for a link between the check and the open is refused by its inode', (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-a');
  write(path.join(a, ...REL.split('/')), '# brief\n');
  const elsewhere = path.join(f.root, 'elsewhere');
  write(path.join(elsewhere, 'task-3-brief.md'), 'OUTSIDE body\n');
  const exec = path.dirname(path.join(a, ...REL.split('/')));
  let armed = false;
  const fsImpl = {
    ...fs,
    openSync(file: any, flags: any, mode?: any) {
      if (armed && typeof file === 'string' && file.startsWith(exec)) { // the swap lands after every lstat of this read
        armed = false;
        fs.renameSync(exec, `${exec}.moved`);
        fs.symlinkSync(elsewhere, exec);
      }
      return fs.openSync(file, flags, mode);
    },
  };
  const { step } = directLane(a, REL, fsImpl);
  assert.deepEqual(step().map((x: any) => x.type), ['snapshot']);
  fs.appendFileSync(path.join(a, ...REL.split('/')), 'more\n');
  armed = true;
  const after = step(1000);
  assert.ok(!JSON.stringify(after).includes('OUTSIDE'), JSON.stringify(after));
});

test('161 review 2: a secret split across two appends of an unfinished line is never sent unmasked; the line is re-sent whole as a snapshot', (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-a');
  const brief = write(path.join(a, ...REL.split('/')), '# brief\ntoken=');
  const { step } = directLane(a, REL);
  const first = step();
  assert.deepEqual(first.map((x: any) => [x.type, x.data.pieces.map((p: any) => p.text)]), [['snapshot', ['# brief', 'token=']]]);
  fs.appendFileSync(brief, 'hunter2');
  const second = step(1000);
  assert.ok(!JSON.stringify(second).includes('hunter2'), JSON.stringify(second));
  assert.deepEqual(second.map((x: any) => [x.type, x.data.from, x.data.pieces.map((p: any) => p.text)]), [['snapshot', 0, ['# brief', maskBody('token=hunter2').text]]]);
  // The line ends: only the newline is new, so the lane appends again from the line's end.
  fs.appendFileSync(brief, '\nnext line\n');
  const third = step(1000);
  assert.ok(!JSON.stringify(third).includes('hunter2'), JSON.stringify(third));
  assert.ok(third.every((x: any) => x.type === 'snapshot' || x.type === 'append'), JSON.stringify(third));
  assert.deepEqual(step(1000), [], 'nothing new');
  fs.appendFileSync(brief, 'tail ');
  step(1000);
  fs.appendFileSync(brief, 'end\n');
  const last = step(1000);
  assert.deepEqual(last.map((x: any) => x.type), ['snapshot'], 'a later unfinished line is re-sent whole as well');
  // While a line is unfinished, a rename-over is still reset replaced before the snapshot.
  fs.appendFileSync(brief, 'open');
  step(1000);
  fs.writeFileSync(`${brief}.tmp`, 'other\n');
  fs.renameSync(`${brief}.tmp`, brief);
  assert.deepEqual(step(1000).map((x: any) => [x.type, x.data.reason ?? x.data.pieces.map((p: any) => p.text)]), [['reset', 'replaced'], ['snapshot', ['other']]]);
});

test('161 T5 IC-004: a worker log artifact holds its unfinished line until the newline, and the lane is followed again by a later sub', async (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-a');
  const pk = cwdHash(a);
  const rel = '.doflow/state/worker-output/w-0123456789ab.out.log';
  const file = write(path.join(a, ...rel.split('/')), 'partial');
  const ch = `file:${pk}:${fileKeyOf(a, rel)}`;
  const h = start(t, f, a);
  h.stdin.json('sub', ch);
  await settle();
  assert.deepEqual(h.of(ch)[0].data, { log: 'open', ino: inoOf(file), from: 0, to: 0, pieces: [], phase: null, end: null }, 'a running log holds the partial line');
  fs.appendFileSync(file, ' line\n');
  await h.clock.advance(PASS);
  assert.deepEqual(h.of(ch).at(-1).data, { from: 0, to: 13, pieces: [{ at: 0, text: 'partial line' }], phase: null, end: null });
  h.stdin.json('unsub', ch);
  h.stdin.json('sub', ch);
  await settle();
  assert.equal(h.of(ch).at(-1).type, 'snapshot');
  assert.equal(await h.end(), 0);
});

// ── transcript: ──────────────────────────────────────────────────────────────────────────────────────

const RAW = 'sess-lanes-claude-1';
const AK = sha16(`claude:${RAW}`);

/** A project with one observed Claude session whose transcript holds two replies. */
function agentWorld(t: any) {
  const f = fixture(t);
  const a = project(f, 'proj-a');
  session(f, RAW, a);
  const file = write(transcriptFile(f, RAW), reply(RAW, a, 'Reading the brief.', 1) + reply(RAW, a, 'Plan is ready.', 2));
  return { f, a, pk: cwdHash(a), file, ch: `transcript:${cwdHash(a)}:${AK}` };
}

const texts = (frames: any[]) => frames.filter((x: any) => x.type === 'snapshot' || x.type === 'append').flatMap((x: any) => x.data.events).filter((e: any) => e.kind === 'reply').map((e: any) => e.text);

test('161 T5 IC-005: a snapshot of the read body, then one append per new line; ids carry the reader cursor; a secret arrives masked; no path', { skip: WIN }, async (t) => {
  const { f, a, file, ch } = agentWorld(t);
  const h = start(t, f, a);
  h.stdin.json('sub', ch);
  await settle();
  const [snap] = h.of(ch);
  assert.equal(snap.type, 'snapshot', h.stdout.text + h.stderr.text);
  assert.deepEqual(Object.keys(snap.data).sort(), ['agentKey', 'cursor', 'eof', 'events', 'harness', 'masked', 'otherRecords', 'reader', 'reset', 'transcript', 'unparsable', 'v', 'warnings']);
  assert.deepEqual([snap.data.v, snap.data.agentKey, snap.data.harness, snap.data.reset, snap.data.eof], [1, AK, 'claude', false, true]);
  assert.deepEqual(snap.data.transcript, { linked: true, reason: null });
  assert.deepEqual(texts([snap]), ['Reading the brief.', 'Plan is ready.']);
  assert.match(snap.id, LOG_ID);
  const [ino, offset] = snap.data.cursor.split(':');
  assert.deepEqual(snap.id.split(':').slice(0, 2), [ino, offset]);
  assert.equal(ino, inoOf(file));

  fs.appendFileSync(file, reply(RAW, a, `Found ${GH} in env.`, 3));
  await h.clock.advance(PASS);
  fs.appendFileSync(file, reply(RAW, a, 'Done.', 4));
  await h.clock.advance(PASS);
  const frames = h.of(ch);
  assert.deepEqual(frames.map((x: any) => x.type), ['snapshot', 'append', 'append']);
  const last = Math.max(...frames[0].data.events.map((e: any) => e.seq));
  assert.deepEqual(frames[1].data.events.filter((e: any) => e.kind === 'reply').map((e: any) => e.seq), [last + 1], 'the next event, not one of the snapshot');
  assert.deepEqual(Object.keys(frames[1].data).sort(), ['cursor', 'eof', 'events', 'masked', 'warnings']);
  assert.equal(frames[1].data.masked, 1);
  assert.equal(frames[2].data.events[0].text, 'Done.');
  assert.deepEqual(frames[2].id.split(':').slice(0, 2), frames[2].data.cursor.split(':').slice(0, 2));
  assert.equal(Number(frames[2].data.cursor.split(':')[1]), fs.statSync(file).size);
  assert.deepEqual(texts(frames).filter((x: string) => x.includes('ghp_')), [], 'masked');
  assert.ok(!h.stdout.text.includes(GH));
  assert.ok(!h.stdout.text.includes(f.root) && !h.stdout.text.includes(RAW), 'no path and no raw session id leave the core');
  assert.equal(await h.end(), 0);
  assert.equal(h.stderr.text, '');
});

test('161 T5 IC-005: after a child restart the new snapshot and its appends hold no event twice', { skip: WIN }, async (t) => {
  const { f, a, file, ch } = agentWorld(t);
  const first = start(t, f, a);
  first.stdin.json('sub', ch);
  await settle();
  fs.appendFileSync(file, reply(RAW, a, 'before the restart', 3));
  await first.clock.advance(PASS);
  assert.deepEqual(texts(first.of(ch)), ['Reading the brief.', 'Plan is ready.', 'before the restart']);
  assert.equal(await first.end(), 0);

  const second = start(t, f, a);
  second.stdin.json('sub', ch);
  await settle();
  fs.appendFileSync(file, reply(RAW, a, 'after the restart', 4));
  await second.clock.advance(PASS);
  const seen = texts(second.of(ch));
  assert.deepEqual(seen, ['Reading the brief.', 'Plan is ready.', 'before the restart', 'after the restart']);
  assert.equal(new Set(seen).size, seen.length, 'no duplicate');
  assert.deepEqual(second.of(ch).map((x: any) => x.type), ['snapshot', 'append']);
  assert.equal(await second.end(), 0);
});

test('161 T5 IC-005: a rewritten transcript is reset replaced then a snapshot', { skip: WIN }, async (t) => {
  const { f, a, file, ch } = agentWorld(t);
  const h = start(t, f, a);
  h.stdin.json('sub', ch);
  await settle();
  const swap = `${file}.tmp`;
  fs.writeFileSync(swap, reply(RAW, a, 'rewritten history', 1));
  fs.renameSync(swap, file);
  await h.clock.advance(PASS);
  assert.deepEqual(h.of(ch).map((x: any) => x.type), ['snapshot', 'reset', 'snapshot']);
  assert.equal(h.of(ch)[1].data.reason, 'replaced');
  assert.deepEqual(texts([h.of(ch)[2]]), ['rewritten history']);
  assert.equal(await h.end(), 0);
});

test('161 T5 IC-005: an agent of another project is a snapshot with linked false and the reader reason; an unknown agent is gone; a re-sub follows it afresh', { skip: WIN }, async (t) => {
  const { f, a, pk } = agentWorld(t);
  const other = 'sess-lanes-claude-2';
  session(f, other, a);
  write(transcriptFile(f, other), reply(other, path.join(f.root, 'elsewhere'), 'OTHER-PROJECT-REPLY', 1));
  const strange = `transcript:${pk}:${sha16(`claude:${other}`)}`;
  const unknown = `transcript:${pk}:${NO_KEYS}`;
  const h = start(t, f, a);
  h.stdin.json('sub', strange);
  h.stdin.json('sub', unknown);
  h.stdin.json('sub', `transcript:${'f'.repeat(16)}:${AK}`);
  await settle();
  const [snap] = h.of(strange);
  assert.equal(snap.type, 'snapshot');
  assert.deepEqual([snap.data.transcript, snap.data.events, snap.data.agentKey], [{ linked: false, reason: 'session-not-in-project' }, [], sha16(`claude:${other}`)]);
  assert.match(snap.id, LOG_ID);
  assert.ok(!h.stdout.text.includes('OTHER-PROJECT-REPLY'));
  assert.deepEqual(shape(h.of(unknown)), [['gone', {}]]);
  assert.deepEqual(shape(h.of(`transcript:${'f'.repeat(16)}:${AK}`)), [['gone', {}]], 'an unknown project');
  await h.clock.advance(FULL_TICKS * PASS_MS * 2); // the 30 s pass does not repeat a snapshot that has not changed
  assert.equal(h.of(strange).length, 1);
  assert.equal(await h.end(), 0);
});

test('161 T5 IC-005: an agent that leaves the project tree is gone at the next 30 s pass', { skip: WIN }, async (t) => {
  const { f, a, ch } = agentWorld(t);
  const h = start(t, f, a);
  h.stdin.json('sub', ch);
  await settle();
  assert.equal(h.of(ch)[0].type, 'snapshot');
  fs.rmSync(path.join(f.store, 'primary'), { recursive: true });
  fs.rmSync(path.join(f.sessions, RAW), { recursive: true });
  await h.clock.advance(FULL_TICKS * PASS_MS + 2 * PASS);
  assert.deepEqual(shape(h.of(ch).slice(-1)), [['gone', {}]]);
  assert.equal(await h.end(), 0);
});

// ── the writer's transcript frames ───────────────────────────────────────────────────────────────────

/** Writes a worker-runs store as the supervisor does (temp file, then rename). */
function workerStore(root: string, runs: Record<string, any>, revision: number): void {
  const file = path.join(root, '.doflow', 'state', 'worker-runs', 'feat-w.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, revision, slug: 'feat-w', runs }));
  fs.renameSync(`${file}.tmp`, file);
}

test('161 review 5: a record-only transcript (a worker run, no linked transcript) shows the run end within the 1 s pass, not the 30 s one', { skip: WIN }, async (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-a');
  const runId = 'w-0123456789ab';
  const run = { runId, task: 'T-1', token: 1, phase: 'ended', seq: 1, harness: 'claude', startedAt: '2026-11-15T09:00:00.000Z' };
  workerStore(a, { [runId]: run }, 1);
  const ch = `transcript:${cwdHash(a)}:${sha16(`worker:${runId}`)}`;
  const h = start(t, f, a);
  h.stdin.json('sub', ch);
  await settle();
  const records = (frames: any[]) => frames.flatMap((x: any) => x.data.events ?? []).filter((e: any) => e.kind === 'record').map((e: any) => e.record.type);
  assert.deepEqual(h.of(ch).map((x: any) => x.type), ['snapshot'], h.stdout.text + h.stderr.text);
  assert.deepEqual(records(h.of(ch)), ['worker-run-start']);
  workerStore(a, { [runId]: { ...run, seq: 2, end: { state: 'exited', at: '2026-11-15T09:05:00.000Z' } } }, 2);
  await h.clock.advance(PASS_MS + DEBOUNCE_MS);
  assert.deepEqual(records(h.of(ch)), ['worker-run-start', 'worker-run-end'], 'the end arrives within one fingerprint pass');
  assert.equal(await h.end(), 0);
});

test('161 review 10: an events-only transcript (a main session with no transcript file) shows a new hook record within the 1 s pass', { skip: WIN }, async (t) => {
  const f = fixture(t);
  const a = project(f, 'proj-a');
  session(f, RAW, a); // no transcript file is written: the session's events are its hook records
  const h = start(t, f, a);
  h.stdin.json('sub', `transcript:${cwdHash(a)}:${AK}`);
  await settle();
  const ch = `transcript:${cwdHash(a)}:${AK}`;
  const hooks = () => h.of(ch).flatMap((x: any) => x.data.events ?? []).filter((e: any) => e.kind === 'record' && e.record.type === 'hook-record').length;
  assert.equal(h.of(ch)[0].type, 'snapshot', h.stdout.text + h.stderr.text);
  const before = hooks();
  const later = new Date(h.clock.now() + 1000);
  const note = path.join(f.sessions, RAW, 'subagent-audit.log');
  fs.appendFileSync(note, auditLine('SubagentStart', RAW, 'agent-1'));
  fs.utimesSync(note, later, later);
  await h.clock.advance(PASS_MS + DEBOUNCE_MS);
  assert.equal(hooks(), before + 1, 'one new hook record within one fingerprint pass');
  assert.equal(await h.end(), 0);
});

test('161 T5 IC-005: the writer drops the oldest events of a snapshot over the line cap and splits an append between events', () => {
  const writer = createEnvelopeWriter({ epoch: '0a1b2c3d', clock: () => 1790000000000 });
  const ch = `transcript:${NO_KEYS}:${'1'.repeat(16)}`;
  const event = (seq: number) => ({ seq, at: null, kind: 'reply', agentKey: '1'.repeat(16), model: null, tool: null, text: 'x'.repeat(4000), args: null, cut: false, tokens: null, record: null });
  const events = Array.from({ length: 200 }, (_, i) => event(i));
  const body = { v: 1, agentKey: '1'.repeat(16), harness: 'claude', reader: { id: 'claude-jsonl', status: 'supported' }, transcript: { linked: true, reason: null }, events, cursor: '7:900:200:5', reset: false, eof: false, otherRecords: 0, unparsable: 0, masked: 2, warnings: ['w'] };
  const [snap] = writer.transcriptSnapshot(ch, body).map((line: string) => ({ line, ...JSON.parse(line) }));
  assert.ok(Buffer.byteLength(snap.line) <= LINE_CAP_BYTES);
  assert.ok(snap.data.events.length < 200 && snap.data.events.at(-1).seq === 199, 'the newest events are kept');
  assert.equal(snap.id.split(':').slice(0, 2).join(':'), '7:900');
  const lines = writer.transcriptAppend(ch, { events, cursor: '7:1500:400:6', eof: true, masked: 2, warnings: ['w'] }).map((line: string) => ({ line, ...JSON.parse(line) }));
  assert.ok(lines.length > 1);
  assert.deepEqual(lines.flatMap((x: any) => x.data.events.map((e: any) => e.seq)), events.map((e) => e.seq), 'every event once, in order');
  for (const x of lines) {
    assert.ok(Buffer.byteLength(x.line) <= LINE_CAP_BYTES);
    assert.equal(x.data.cursor, '7:1500:400:6');
    assert.match(x.id, LOG_ID);
  }
  assert.deepEqual(lines.map((x: any) => x.data.eof), [...lines.slice(1).map(() => false), true], 'only the last frame is at the end');
  assert.throws(() => writer.transcriptAppend(`file:${NO_KEYS}:${'1'.repeat(16)}`, { events: [], cursor: '7:1:1:1', eof: true, masked: 0, warnings: [] }), TypeError);
  const fresh = createEnvelopeWriter({ epoch: '0a1b2c3d' });
  assert.throws(() => fresh.transcriptAppend(ch, { events: [], cursor: '7:1:1:1', eof: true, masked: 0, warnings: [] }), /owes a snapshot/);
});

// ── events --kinds (DEC-012) ─────────────────────────────────────────────────────────────────────────

function cli(t: any, args: string[]) {
  const f = fixture(t);
  return spawnSync(process.execPath, [CLI, 'events', ...args], { cwd: f.root, env: { ...process.env, ...f.env }, encoding: 'utf8', timeout: 20000 });
}

test('161 T5 DEC-012: events --kinds --json prints {v:1, kinds} and exits 0; the text form is one kind per line', (t) => {
  const json = cli(t, ['--kinds', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.equal(json.stdout.trim().split('\n').length, 1);
  assert.deepEqual(Object.keys(body), ['v', 'kinds']);
  assert.equal(body.v, 1);
  for (const kind of ['now', 'run', 'tasks', 'worker', 'machine', 'layers', 'file', 'transcript']) assert.ok(body.kinds.includes(kind), kind);
  assert.equal(new Set(body.kinds).size, body.kinds.length);
  assert.ok(body.kinds.every((kind: unknown) => typeof kind === 'string'));
  const text = cli(t, ['--kinds']);
  assert.equal(text.status, 0, text.stderr);
  assert.deepEqual(text.stdout.trim().split('\n'), body.kinds);
  assert.equal(text.stderr, '');
});

test('161 T5 DEC-012: --kinds with --follow, --channels or --control is a usage error (exit 2) that prints no kinds', (t) => {
  for (const args of [['--kinds', '--follow'], ['--kinds', '--channels', 'now'], ['--kinds', '--control', 'stdin'], ['--kinds', '--follow', '--channels', 'now', '--json'], ['--kinds', '--kinds']]) {
    const r = cli(t, args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
    assert.match(r.stderr, /^doflow events: /, args.join(' '));
  }
});

// ── AC-7: read-only at runtime ───────────────────────────────────────────────────────────────────────

/** Every file and directory under `root` with its size and mtime, so a creation or a write shows. */
function treeOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p, { bigint: true });
      out[path.relative(root, p)] = st.isDirectory() ? 'dir' : `${st.size}:${st.mtimeNs}`;
      if (st.isDirectory()) visit(p);
    }
  };
  visit(root);
  return out;
}

/**
 * 161 AC-7: a probe the driver installs before it loads the verb. Every fs call that opens, creates, writes,
 * moves, links or deletes is recorded as `<op>\t<flags>\t<path>` (flags as given: a string, a number or `-`), and
 * every child process as `exec\t<GIT_OPTIONAL_LOCKS>\t<command and arguments>`. Its own writes use the functions
 * captured before wrapping.
 */
const OPEN_PROBE = `
const fs = require('node:fs');
const cp = require('node:child_process');
const nodePath = require('node:path');
const out = process.env.AC7_PROBE;
const raw = { openSync: fs.openSync, writeSync: fs.writeSync, closeSync: fs.closeSync };
let busy = false;
const note = (line) => {
  if (busy) return;
  busy = true;
  try { const fd = raw.openSync.call(fs, out, 'a'); try { raw.writeSync.call(fs, fd, line.replace(/[\\r\\n]/g, ' ') + '\\n'); } finally { raw.closeSync.call(fs, fd); } } catch {} finally { busy = false; }
};
const where = (p) => (typeof p === 'string' ? nodePath.resolve(p) : Buffer.isBuffer(p) ? nodePath.resolve(p.toString('utf8')) : p && p.href ? String(p.href) : '#fd');
const flagOf = (f) => (f === undefined || f === null ? '-' : typeof f === 'object' ? flagOf(f.flags ?? f.flag) : String(f));
const wrap = (obj, name, flagsAt) => {
  const fn = obj[name];
  if (typeof fn !== 'function') return;
  obj[name] = function (...args) { note(name + '\\t' + (flagsAt === null ? 'write' : flagOf(args[flagsAt])) + '\\t' + where(args[0])); return fn.apply(this, args); };
};
for (const name of ['openSync', 'open']) wrap(fs, name, 1);
wrap(fs.promises, 'open', 1);
for (const name of ['readFileSync', 'readFile', 'createReadStream']) wrap(fs, name, 1);
wrap(fs.promises, 'readFile', 1);
for (const name of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream', 'mkdirSync', 'mkdir', 'mkdtempSync', 'renameSync', 'rename',
  'unlinkSync', 'unlink', 'rmSync', 'rm', 'rmdirSync', 'rmdir', 'copyFileSync', 'copyFile', 'cpSync', 'cp', 'truncateSync', 'truncate', 'symlinkSync', 'symlink',
  'linkSync', 'link', 'utimesSync', 'utimes', 'chmodSync', 'chmod', 'chownSync', 'chown']) wrap(fs, name, null);
for (const name of ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'cp', 'truncate', 'symlink', 'link', 'utimes', 'chmod', 'chown']) wrap(fs.promises, name, null);
for (const name of ['spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync', 'exec']) {
  const fn = cp[name];
  cp[name] = function (cmd, args, opts) {
    const o = Array.isArray(args) ? opts : args;
    const envOf = (o && o.env) || process.env;
    note('exec\\t' + (envOf.GIT_OPTIONAL_LOCKS ?? '-') + '\\t' + [cmd, ...(Array.isArray(args) ? args : [])].join(' '));
    return fn.apply(this, arguments);
  };
}
require('node:module').syncBuiltinESMExports();
`;

/** An open flag that can write: a string flag with `w`, `a` or `+`, or a number with a write, append, create or truncate bit. */
function writes(flags: string): boolean {
  if (flags === 'write') return true;
  if (flags === '-') return false;
  if (/^\d+$/.test(flags)) {
    const c = fs.constants;
    return (Number(flags) & (c.O_WRONLY | c.O_RDWR | c.O_APPEND | c.O_CREAT | c.O_TRUNC)) !== 0;
  }
  return /[wa+]/.test(flags);
}

test('161 T5 AC-7: following machine, layers, file and transcript makes no write-capable open, no lock and no git write, and changes nothing under the scratch tree', { skip: WIN }, async (t) => {
  const { f, a, pk, file, ch } = agentWorld(t);
  const rel = REL;
  write(path.join(a, ...rel.split('/')), '# Task 3\n');
  const driver = path.join(f.root, 'driver.js');
  const probe = path.join(f.root, 'opens.txt');
  const control = path.join(f.root, 'control.txt');
  fs.writeFileSync(probe, '');
  fs.writeFileSync(driver, `${OPEN_PROBE}
// The negative control: one write-capable open with a numeric flag, before the verb loads, which the test must see flagged.
fs.closeSync(fs.openSync(${JSON.stringify(control)}, fs.constants.O_WRONLY | fs.constants.O_CREAT));
const { handleEventsCommand } = require(${JSON.stringify(path.join(REPO, 'src', 'runtime', 'events', 'command.ts'))});
const { createProjectsIndex } = require(${JSON.stringify(path.join(REPO, 'src', 'runtime', 'events', 'projects-index.ts'))});
handleEventsCommand({ follow: true, control: 'stdin', json: true, flags: ['--follow', '--control', '--json'], positional: [], cwd: process.cwd(), env: process.env,
  projectsIndex: createProjectsIndex({ env: process.env, cwd: process.cwd(), tempRoots: [], scratchName: ${JSON.stringify(SCRATCH)} }) }).then((code) => process.exit(code));
`);
  const before = treeOf(f.root);
  const channels = ['machine', `layers:${pk}`, `file:${pk}:${fileKeyOf(a, rel)}`, ch];
  const child = spawn(process.execPath, [driver], { cwd: a, env: { ...process.env, ...f.env, AC7_PROBE: probe }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
  child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code: number | null) => resolve(code)));
  for (const c of channels) child.stdin.write(`${JSON.stringify({ op: 'sub', ch: c })}\n`);
  const deadline = Date.now() + 20000;
  const got = () => new Set(out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x: any) => x.type === 'snapshot').map((x: any) => x.ch));
  while (got().size < channels.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual([...got()].sort(), [...channels].sort(), `every channel snapshots; stdout ${out} stderr ${err}`);
  fs.appendFileSync(file, reply(RAW, a, 'one more', 9)); // and a live append is read too
  await new Promise((resolve) => setTimeout(resolve, 1500));
  child.stdin.end();
  assert.equal(await exited, 0, err);
  assert.equal(err, '');

  const rows = fs.readFileSync(probe, 'utf8').split('\n').filter(Boolean).map((line: string) => line.split('\t'));
  const opens = rows.filter((r: string[]) => r[0] !== 'exec');
  const execs = rows.filter((r: string[]) => r[0] === 'exec');
  const opened = opens.map((r: string[]) => r[2]);
  assert.ok(opened.some((p) => p === file), 'the probe saw the transcript read');
  assert.ok(opened.some((p) => p === path.join(a, ...rel.split('/'))), 'and the brief read');
  // The control open went red in the probe: a numeric write flag is seen as a write.
  assert.deepEqual(opens.filter((r: string[]) => r[2] === control).map((r: string[]) => writes(r[1])), [true], 'the probe flags the control open as write-capable');
  assert.deepEqual(opens.filter((r: string[]) => r[2] !== control && writes(r[1])).map((r: string[]) => r.join(' ')), [], 'no other call opens for writing or writes');
  assert.deepEqual(opened.filter((p) => /(^|[\\/])[^\\/]*\.lock$|[\\/]locks?[\\/]|\.lock[\\/]/i.test(p)), [], 'no lock file or lock directory is opened');
  const stray = opened.filter((p) => p.startsWith(f.config) && !p.startsWith(f.store));
  assert.deepEqual(stray, [], 'nothing under the config home but the hook session store');
  // Every git process the verb starts is read-only and runs with optional locks off, so none refreshes the index.
  const gits = execs.filter((r: string[]) => /^git( |$)/.test(r[2]));
  assert.ok(gits.length > 0, 'the project index ran git');
  assert.deepEqual(gits.filter((r: string[]) => r[1] !== '0').map((r: string[]) => r[2]), [], 'every git call has GIT_OPTIONAL_LOCKS=0');
  assert.deepEqual(gits.filter((r: string[]) => !/ (worktree list --porcelain|rev-parse |log -1 )/.test(r[2])).map((r: string[]) => r[2]), [], 'only worktree list, rev-parse and log');
  const after = treeOf(f.root);
  const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k] && k !== 'opens.txt' && k !== 'control.txt');
  assert.deepEqual(changed.filter((k) => k !== path.relative(f.root, file) && k !== path.relative(f.root, path.dirname(file)) && k !== 'driver.js'), [], 'only the transcript this test appended to changed, .git included');
});
