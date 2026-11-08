'use strict';

// Feature 150 A.6 (IC-006, IC-007, IC-008; FR-010, FR-011, FR-012, NFR-001, NFR-008): the log
// channels `worker:<runId>:out` and `:err` of `doflow events --follow`, in process, on a real
// project directory with an injected clock and watch: a late file is waited for, a partial line is
// held until its newline or the final read, an inode change and a shorter file give `reset` then
// `snapshot`, a version 2 store errors that run's channels while `now` goes on, a pruned file is
// `gone`, a run without output is `none`, a capped run says so at its end, one recompute makes at
// most two appends, ids are rising byte cursors, the 250 ms pass delivers with the watch disabled,
// no process is started per append, and `<runId>.last.log` is never opened.

// Every child-process entry point is counted before any source module takes a reference to it.
const childProcess = require('node:child_process');
const spawned: string[] = [];
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const original = childProcess[name];
  childProcess[name] = function counted(this: any, ...args: any[]) {
    spawned.push(`${name} ${String(args[0])}`);
    return original.apply(this, args);
  };
}

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { handleEventsCommand } = require('../../src/runtime/events/command.ts');
const { LOG_ID, ENVELOPE_ID } = require('../../src/runtime/events/envelope.ts');
const { LOG_PASS_MS, PASS_MS, DEBOUNCE_MS, GONE_MS } = require('../../src/runtime/events/detector.ts');
const { CATCHUP_FRAMES } = require('../../src/runtime/events/logs.ts');
const { PAGE_BYTES } = require('../../src/runtime/worker/log-read.ts');

const RUN = 'w-0a1b2c3d4e5f';
const OUT = `worker:${RUN}:out`;
const ERR = `worker:${RUN}:err`;
const SLUG = 'feat-a';

/** Lets every queued promise chain and immediate run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function fakeClock() {
  let now = Date.UTC(2026, 10, 8);
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

/** A watch that reports only when told to; `broken` makes every attach fail, as with no watch support. */
function fakeWatch(broken = false) {
  const handles: any[] = [];
  const watch: any = (dir: string, _options: any, listener: (type: string, name: string | null) => void) => {
    if (broken) { const error: any = new Error('watch unsupported'); error.code = 'ENOSYS'; throw error; }
    const handle: any = { dir, closed: false, close() { handle.closed = true; }, on() { return handle; }, emit(type: string, name: string | null) { if (!handle.closed) listener(type, name); } };
    handles.push(handle);
    return handle;
  };
  watch.emit = (dir: string) => { for (const handle of handles) if (handle.dir === dir) handle.emit('change', null); };
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

/** A project with a worker run store; the run's record and its files are written as the supervisor would. */
function project(t: any) {
  const root = tempDir(t, 'doflow-log-channels-');
  const state = path.join(root, '.doflow', 'state');
  const p: any = {
    root,
    state,
    store: path.join(state, 'worker-runs', `${SLUG}.json`),
    outputDir: path.join(state, 'worker-output'),
    out: path.join(state, 'worker-output', `${RUN}.out.log`),
    err: path.join(state, 'worker-output', `${RUN}.err.log`),
    last: path.join(state, 'worker-output', `${RUN}.last.log`),
    nowDir: path.join(root, 'now-source'),
    revision: 0,
  };
  fs.mkdirSync(path.dirname(p.store), { recursive: true });
  fs.mkdirSync(p.nowDir);
  /** Writes the store by temp file and rename, with `revision` and the run's `seq` rising. */
  p.writeRun = (fields: Record<string, unknown>, version = 1) => {
    p.revision += 1;
    const run = { runId: RUN, task: 'A.1', token: 1, phase: 'running', seq: p.revision, ...fields };
    const tmp = `${p.store}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version, revision: p.revision, slug: SLUG, runs: { [RUN]: run } }));
    fs.renameSync(tmp, p.store);
  };
  p.ended = (output: Record<string, unknown>) => p.writeRun({ phase: 'ended', end: { state: 'exited', at: '2026-11-08T05:03:00.000Z' }, output });
  p.ino = (file: string) => String(fs.statSync(file, { bigint: true }).ino);
  return p;
}

/** One in-process `--control stdin` run on the project; `now` comes from a fake catalogue entry. */
function run(t: any, p: any, extra: { brokenWatch?: boolean } = {}) {
  const saved = process.exitCode;
  t.after(() => { process.exitCode = saved; });
  const clock = fakeClock();
  const watch = fakeWatch(extra.brokenWatch === true);
  const stdin = fakeStdin();
  const stdout = sink();
  const stderr = sink();
  const signals = new EventEmitter();
  const values: Record<string, any> = { now: { a: 1 } };
  const specFor = (channel: any) => ({
    sources: () => ({ directories: [p.nowDir], files: [], derived: [], primary: null }),
    compute: async () => ({ sections: { s: { exit: 0, json: values[channel.name] ?? null } } }),
  });
  const done = handleEventsCommand({
    follow: true, control: 'stdin', json: true, flags: ['--follow', '--control', '--json'], positional: [], cwd: p.root, env: {},
    stdin, stdout, stderr, clock, watch, signals, epoch: '0a1b2c3d', specFor,
  });
  t.after(async () => { stdin.emit('end'); await done; });
  const of = (ch: string) => stdout.frames().filter((f: any) => f.ch === ch);
  return { clock, watch, stdin, stdout, stderr, values, done, of };
}

const idParts = (frame: any) => frame.id.split(':');

test('IC-008 constants: a 250 ms log pass beside the 1 s pass, two appends per recompute', () => {
  assert.equal(LOG_PASS_MS, 250);
  assert.equal(PASS_MS, 1000);
  assert.equal(CATCHUP_FRAMES, 2);
  assert.equal(GONE_MS, 2000);
});

test('late file is waited for, a partial line is held until its newline, ids are rising byte cursors', async (t) => {
  const p = project(t);
  p.writeRun({ phase: 'running' });
  const h = run(t, p);
  h.stdin.json('sub', OUT);
  await settle();
  assert.deepEqual(h.of(OUT).map((f: any) => [f.type, f.data]), [['snapshot', { log: 'waiting', ino: null, from: 0, to: 0, pieces: [], phase: 'running', end: null }]]);

  await h.clock.advance(10 * GONE_MS); // no file and no end: the wait has no limit
  assert.equal(h.of(OUT).length, 1, 'nothing while the file is missing');

  fs.mkdirSync(p.outputDir);
  fs.writeFileSync(p.out, 'partial');
  await h.clock.advance(LOG_PASS_MS + DEBOUNCE_MS);
  const ino = p.ino(p.out);
  assert.deepEqual(h.of(OUT).at(-1).data, { log: 'open', ino, from: 0, to: 0, pieces: [], phase: 'running', end: null }, 'present: an open snapshot, the partial line held');

  fs.appendFileSync(p.out, ' line\nnext');
  await h.clock.advance(LOG_PASS_MS);
  assert.deepEqual(h.of(OUT).at(-1), { ...h.of(OUT).at(-1), type: 'append', data: { from: 0, to: 13, pieces: [{ at: 0, text: 'partial line' }], phase: 'running', end: null } });

  fs.appendFileSync(p.out, '\n');
  await h.clock.advance(LOG_PASS_MS);
  assert.deepEqual(h.of(OUT).at(-1).data, { from: 13, to: 18, pieces: [{ at: 13, text: 'next' }], phase: 'running', end: null });

  const frames = h.of(OUT);
  assert.deepEqual(frames.map((f: any) => f.type), ['snapshot', 'snapshot', 'append', 'append']);
  let previous = 0;
  for (const frame of frames) {
    assert.match(frame.id, LOG_ID);
    assert.doesNotMatch(frame.id, ENVELOPE_ID);
    const [frameIno, offset, n, ms] = idParts(frame);
    assert.equal(frameIno, frame.data.log === 'waiting' ? '0' : ino);
    assert.equal(Number(offset), frame.data.to);
    assert.ok(Number(n) > previous, 'n rises');
    previous = Number(n);
    assert.equal(new Date(Number(ms)).toISOString(), frame.at);
  }
  assert.equal(h.stderr.text, '');
});

test('the final read sends a last line without a newline before end; a capped run and a run without output say so', async (t) => {
  const p = project(t);
  p.writeRun({ phase: 'running' });
  fs.mkdirSync(p.outputDir);
  fs.writeFileSync(p.out, 'one\ntail');
  const h = run(t, p);
  h.stdin.json('sub', OUT);
  h.stdin.json('sub', ERR);
  await settle();
  assert.deepEqual(h.of(OUT)[0].data, { log: 'open', ino: p.ino(p.out), from: 0, to: 4, pieces: [{ at: 0, text: 'one' }], phase: 'running', end: null });
  assert.equal(h.of(ERR)[0].data.log, 'waiting');

  // The supervisor ends the run with an stdout pointer and none for stderr (the sink never wrote it).
  p.ended({ stdout: { path: `worker-output/${RUN}.out.log`, bytes: 8, truncated: false } });
  h.watch.emit(path.dirname(p.store));
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepEqual(h.of(OUT).slice(1).map((f: any) => [f.type, f.data]), [
    ['append', { from: 4, to: 8, pieces: [{ at: 4, text: 'tail' }], phase: 'ended', end: { capped: false } }],
  ]);
  assert.deepEqual(h.of(ERR).slice(1).map((f: any) => [f.type, f.data]), [
    ['snapshot', { log: 'none', ino: null, from: 0, to: 0, pieces: [], phase: 'ended', end: { capped: null } }],
  ]);

  // A capped run: the end carries `capped: true` from its own snapshot.
  const q = project(t);
  q.ended({ stdout: { path: `worker-output/${RUN}.out.log`, bytes: 6, truncated: true } });
  fs.mkdirSync(q.outputDir);
  fs.writeFileSync(q.out, 'capped');
  const k = run(t, q);
  k.stdin.json('sub', OUT);
  await settle();
  assert.deepEqual(k.of(OUT)[0].data, { log: 'open', ino: q.ino(q.out), from: 0, to: 6, pieces: [{ at: 0, text: 'capped' }], phase: 'ended', end: { capped: true } });
});

test('an inode change and a shorter file each give reset replaced, then a snapshot', async (t) => {
  const p = project(t);
  p.writeRun({ phase: 'running' });
  fs.mkdirSync(p.outputDir);
  fs.writeFileSync(p.out, 'aaa\nbbb\n');
  const h = run(t, p);
  h.stdin.json('sub', OUT);
  await settle();
  const firstIno = p.ino(p.out);
  assert.equal(h.of(OUT)[0].data.to, 8);

  const tmp = `${p.out}.new`;
  fs.writeFileSync(tmp, 'ccc\n');
  fs.renameSync(tmp, p.out);
  const secondIno = p.ino(p.out);
  assert.notEqual(secondIno, firstIno);
  await h.clock.advance(LOG_PASS_MS + DEBOUNCE_MS);
  let tail = h.of(OUT).slice(1);
  assert.deepEqual(tail.map((f: any) => [f.type, f.data]), [
    ['reset', { reason: 'replaced' }],
    ['snapshot', { log: 'open', ino: secondIno, from: 0, to: 4, pieces: [{ at: 0, text: 'ccc' }], phase: 'running', end: null }],
  ]);
  assert.deepEqual(idParts(tail[0]).slice(0, 2), [firstIno, '8'], 'the reset carries the last ino and to');

  fs.writeFileSync(p.out, 'd\n'); // same inode, below the cursor
  assert.equal(p.ino(p.out), secondIno);
  await h.clock.advance(LOG_PASS_MS);
  tail = h.of(OUT).slice(3);
  assert.deepEqual(tail.map((f: any) => [f.type, f.data]), [
    ['reset', { reason: 'replaced' }],
    ['snapshot', { log: 'open', ino: secondIno, from: 0, to: 2, pieces: [{ at: 0, text: 'd' }], phase: 'running', end: null }],
  ]);
});

test('a version 2 store errors that run\'s channels only; now goes on; version 1 again snapshots', async (t) => {
  const p = project(t);
  p.writeRun({ phase: 'running' });
  fs.mkdirSync(p.outputDir);
  fs.writeFileSync(p.out, 'a\n');
  const h = run(t, p);
  h.stdin.json('sub', 'now');
  h.stdin.json('sub', OUT);
  h.stdin.json('sub', ERR);
  await settle();
  assert.deepEqual(h.stdout.frames().map((f: any) => [f.ch, f.type]), [['now', 'snapshot'], [OUT, 'snapshot'], [ERR, 'snapshot']]);

  p.writeRun({ phase: 'running' }, 2);
  await h.clock.advance(PASS_MS + DEBOUNCE_MS);
  assert.deepEqual(h.of(OUT).slice(1).map((f: any) => [f.type, f.data]), [['error', { code: 'unsupported-version' }]]);
  assert.deepEqual(h.of(ERR).slice(1).map((f: any) => [f.type, f.data]), [['error', { code: 'unsupported-version' }]]);

  fs.appendFileSync(p.out, 'b\n');
  h.values.now = { a: 2 };
  h.watch.emit(p.nowDir);
  await h.clock.advance(PASS_MS);
  assert.deepEqual(h.of('now').slice(1).map((f: any) => [f.type, f.data]), [['patch', { sections: { s: { exit: 0, json: { a: 2 } } } }]]);
  assert.equal(h.of(OUT).length, 2, 'no log frame while the store is version 2');

  p.writeRun({ phase: 'running' }, 1);
  await h.clock.advance(PASS_MS + DEBOUNCE_MS);
  assert.deepEqual(h.of(OUT).slice(2).map((f: any) => [f.type, f.data]), [
    ['snapshot', { log: 'open', ino: p.ino(p.out), from: 0, to: 4, pieces: [{ at: 0, text: 'a' }, { at: 2, text: 'b' }], phase: 'running', end: null }],
  ]);
  assert.equal(h.of(ERR).at(-1).data.log, 'waiting');
});

test('a pruned file is gone after GONE_MS while running, at once once ended with a pointer', async (t) => {
  const p = project(t);
  p.writeRun({ phase: 'running' });
  fs.mkdirSync(p.outputDir);
  fs.writeFileSync(p.out, 'x\n');
  const h = run(t, p);
  h.stdin.json('sub', OUT);
  await settle();
  const ino = p.ino(p.out);
  fs.rmSync(p.out);
  await h.clock.advance(PASS_MS + DEBOUNCE_MS);
  assert.equal(h.of(OUT).length, 1, 'absent for less than GONE_MS: nothing yet');
  await h.clock.advance(GONE_MS);
  const gone = h.of(OUT).at(-1);
  assert.deepEqual([gone.type, gone.data], ['gone', {}]);
  assert.deepEqual(idParts(gone).slice(0, 2), [ino, '2']);
  fs.writeFileSync(p.out, 'back\n');
  await h.clock.advance(2 * PASS_MS);
  assert.equal(h.of(OUT).length, 2, 'the producer stopped following the channel');

  const q = project(t);
  q.ended({ stdout: { path: `worker-output/${RUN}.out.log`, bytes: 10, truncated: false } });
  const k = run(t, q);
  k.stdin.json('sub', OUT);
  await settle();
  assert.deepEqual(k.of(OUT).map((f: any) => [f.type, f.data]), [['gone', {}]], 'ended with a pointer and no file: pruned');
});

test('one recompute makes at most two appends and marks the channel again until the end is read; only the last carries the end', async (t) => {
  const p = project(t);
  p.writeRun({ phase: 'running' });
  fs.mkdirSync(p.outputDir);
  fs.writeFileSync(p.out, 'start\n');
  const h = run(t, p);
  h.stdin.json('sub', OUT);
  await settle();
  const line = `${'x'.repeat(1023)}\n`;
  fs.appendFileSync(p.out, line.repeat((5 * PAGE_BYTES) / line.length));
  const size = fs.statSync(p.out).size;
  // The run ends while five pages are still unread.
  p.ended({ stdout: { path: `worker-output/${RUN}.out.log`, bytes: size, truncated: false } });

  await h.clock.advance(LOG_PASS_MS + DEBOUNCE_MS);
  assert.equal(h.of(OUT).length - 1, CATCHUP_FRAMES, 'the first recompute stops at two appends');
  await h.clock.advance(DEBOUNCE_MS);
  assert.equal(h.of(OUT).length - 1, 2 * CATCHUP_FRAMES, 'the re-mark brings two more after the debounce');
  await h.clock.advance(4 * DEBOUNCE_MS);
  const appends = h.of(OUT).slice(1);
  assert.ok(appends.every((f: any) => f.type === 'append'));
  assert.equal(appends.at(-1).data.to, size, 'the rest follows');
  assert.deepEqual([appends.at(-1).data.phase, appends.at(-1).data.end], ['ended', { capped: false }]);
  assert.ok(appends.slice(0, -1).every((f: any) => f.data.phase === 'running' && f.data.end === null), 'the end is sent after the last bytes');
  let cursor = 6;
  for (const frame of appends) {
    assert.equal(frame.data.from, cursor, 'each from is the previous to');
    assert.ok(frame.data.to - frame.data.from <= PAGE_BYTES);
    cursor = frame.data.to;
  }
});

test('the 250 ms pass delivers an append with the watch disabled; after the end the 1 s pass does', async (t) => {
  const p = project(t);
  p.writeRun({ phase: 'running' });
  fs.mkdirSync(p.outputDir);
  fs.writeFileSync(p.out, 'a\n');
  const h = run(t, p, { brokenWatch: true });
  h.stdin.json('sub', OUT);
  h.stdin.json('sub', ERR);
  await settle();
  const before = spawned.length;

  // Each line is written 25 ms after a pass, so the next pass and its debounce end the 250 ms step.
  await h.clock.advance(DEBOUNCE_MS);
  for (let i = 0; i < 5; i += 1) {
    fs.appendFileSync(p.out, `line ${i}\n`);
    const written = h.clock.now();
    await h.clock.advance(LOG_PASS_MS);
    const last = h.of(OUT).at(-1);
    assert.equal(last.type, 'append', `line ${i} arrived within one log pass`);
    assert.ok(Number(idParts(last)[3]) - written <= LOG_PASS_MS && Number(idParts(last)[3]) - written < PASS_MS);
  }
  const appends = h.of(OUT).filter((f: any) => f.type === 'append');
  assert.equal(appends.length, 5, 'one append per 250 ms pass, with no watch event');
  assert.deepEqual(appends.map((f: any) => f.data.pieces[0].text), ['line 0', 'line 1', 'line 2', 'line 3', 'line 4']);
  assert.equal(spawned.length, before, `no process per append: ${spawned.slice(before).join(', ')}`);

  p.ended({ stdout: { path: `worker-output/${RUN}.out.log`, bytes: 37, truncated: false } });
  await h.clock.advance(PASS_MS);
  assert.deepEqual(h.of(OUT).at(-1).data, { from: 37, to: 37, pieces: [], phase: 'ended', end: { capped: false } }, 'a phase change with no bytes: one empty append');
  const count = h.of(OUT).length;
  fs.appendFileSync(p.out, 'late\n');
  await h.clock.advance(2 * LOG_PASS_MS); // two log-pass periods that hold no 1 s tick
  assert.equal(h.of(OUT).length, count, 'no 250 ms pass once ended');
  await h.clock.advance(PASS_MS);
  assert.deepEqual(h.of(OUT).at(-1).data.pieces, [{ at: 37, text: 'late' }], 'the 1 s pass still reads');
  assert.equal(spawned.length, before);
});

test('FR-012: a .last.log next to the out file is never opened, and a :last channel opens nothing', async (t) => {
  const marker = 'LAST-MESSAGE-MARKER-150';
  const p = project(t);
  p.writeRun({ phase: 'running', output: { lastMessage: { path: `worker-output/${RUN}.last.log`, bytes: marker.length } } });
  fs.mkdirSync(p.outputDir);
  fs.writeFileSync(p.out, 'o\n');
  fs.writeFileSync(p.last, `${marker}\n`);
  const touched: string[] = [];
  const originals: Record<string, any> = {};
  for (const name of ['openSync', 'readFileSync', 'statSync', 'lstatSync', 'existsSync', 'createReadStream']) {
    originals[name] = fs[name];
    t.mock.method(fs, name, function spied(this: any, ...args: any[]) {
      if (typeof args[0] === 'string') touched.push(args[0]);
      return originals[name].apply(this, args);
    });
  }
  const promiseOpen = fs.promises.open;
  t.mock.method(fs.promises, 'open', function spied(this: any, ...args: any[]) {
    if (typeof args[0] === 'string') touched.push(args[0]);
    return promiseOpen.apply(this, args);
  });

  const h = run(t, p);
  h.stdin.json('sub', OUT);
  h.stdin.json('sub', ERR);
  await settle();
  fs.appendFileSync(p.out, 'more\n');
  fs.writeFileSync(p.err, 'e\n');
  await h.clock.advance(LOG_PASS_MS + DEBOUNCE_MS);
  p.ended({ stdout: { path: `worker-output/${RUN}.out.log`, bytes: 7, truncated: false }, stderr: { path: `worker-output/${RUN}.err.log`, bytes: 2, truncated: false }, lastMessage: { path: `worker-output/${RUN}.last.log`, bytes: marker.length } });
  await h.clock.advance(PASS_MS + DEBOUNCE_MS);
  assert.ok(h.of(OUT).some((f: any) => f.type === 'append'), 'the out channel was followed');
  assert.ok(h.of(ERR).some((f: any) => f.data.log === 'open'), 'the err channel was followed');
  assert.ok(touched.some((file) => file === p.out), 'the spy sees the out file being read');
  assert.deepEqual(touched.filter((file) => file.endsWith('.last.log')), [], 'no .last.log was opened or stat-ed');
  assert.ok(!h.stdout.text.includes(marker), 'the marker reaches no frame');

  // A :last channel is a usage error before anything is made: no path is touched.
  const q = project(t);
  const k = run(t, q);
  const seen = touched.length;
  k.stdin.json('sub', `worker:${RUN}:last`);
  assert.equal(await k.done, 2);
  assert.equal(k.stdout.text, '');
  assert.match(k.stderr.text, /only out and err are worker output channels/);
  assert.deepEqual(touched.slice(seen), []);

  // The vacuity control: a reader that opens the .last.log is caught by the same spy.
  fs.readFileSync(p.last, 'utf8');
  assert.ok(touched.some((file) => file.endsWith('.last.log')));
});
