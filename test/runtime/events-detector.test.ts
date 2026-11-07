'use strict';

// Feature 149 A.4 (IC-006): the change detector of `doflow events --follow`. A fake clock drives
// every timer and an injected watch delivers events, so no assertion depends on real timing; one
// test uses the real fs.watch with a generous wait for its first event.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { createDetector, DEBOUNCE_MS, RETRY_MS } = require('../../src/runtime/events/detector.ts');
const { updateTaskState } = require('../../src/runtime/task-state.ts');

/** Lets every queued promise chain and immediate run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) { nextId += 1; timers.set(nextId, { at: now + ms, fn, every: null }); return nextId; },
    clearTimeout(id: number) { timers.delete(id); },
    setInterval(fn: () => void, ms: number) { nextId += 1; timers.set(nextId, { at: now + ms, fn, every: ms }); return nextId; },
    clearInterval(id: number) { timers.delete(id); },
    pending: () => timers.size,
    hasTimeout: () => [...timers.values()].some((timer) => timer.every === null),
    /** Moves time forward to `now + ms`, firing each due timer in order and settling after each. */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        await settle();
        let pick: [number, { at: number; fn: () => void; every: number | null }] | null = null;
        for (const entry of timers) {
          if (entry[1].at <= target && (!pick || entry[1].at < pick[1].at)) pick = entry;
        }
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
  const refuse = new Set<string>();
  const watch: any = (dir: string, options: any, listener: (type: string, name: string | null) => void) => {
    if (refuse.has(dir)) {
      const error: any = new Error(`ENOENT: no such file or directory, watch '${dir}'`);
      error.code = 'ENOENT';
      throw error;
    }
    const handle: any = {
      dir, options, closed: false, errorListener: null,
      close() { handle.closed = true; },
      on(event: string, fn: any) { if (event === 'error') handle.errorListener = fn; return handle; },
      emit(type: string, name: string | null) { if (!handle.closed) listener(type, name); },
      fail(error: any) { handle.errorListener(error); },
    };
    handles.push(handle);
    return handle;
  };
  watch.handles = handles;
  watch.refuse = refuse;
  watch.open = (dir: string) => handles.filter((h) => h.dir === dir && !h.closed);
  return watch;
}

function harness(extra: { onRecompute?: (ch: string, req: any) => any; fsImpl?: any } = {}) {
  const clock = fakeClock();
  const watch = fakeWatch();
  const calls: any[] = [];
  const faults: any[] = [];
  const detector = createDetector({
    clock,
    watch,
    fsImpl: extra.fsImpl,
    onRecompute: (channel: string, request: any) => {
      calls.push({ kind: 'recompute', channel, ...request, at: clock.now() });
      return extra.onRecompute ? extra.onRecompute(channel, request) : undefined;
    },
    onRecordEvent: (channel: string, event: string) => { calls.push({ kind: 'event', channel, event, at: clock.now() }); },
    onFault: (error: any) => { faults.push(error); },
  });
  const take = () => calls.splice(0, calls.length);
  return { clock, watch, calls, faults, detector, take };
}

function writeRecord(file: string, body: any): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
}

test('IC-006: a temp-file rename by updateTaskState gives one recompute 25 ms after the first event', async (t) => {
  const root = tempDir(t, 'doflow-detector-');
  const dir = path.join(root, 'task-attempts');
  const file = path.join(dir, 'feat-a.json');
  updateTaskState({ fsImpl: fs, file, build: () => ({ items: [1] }) });
  const h = harness();
  t.after(() => h.detector.close());
  await h.detector.follow('tasks:feat-a', { directories: [{ path: dir, match: /\.json$/ }], primary: { path: file } });
  assert.deepEqual(h.take().map((c) => [c.kind, c.scope, c.snapshot]), [['recompute', 'all', true]]);

  updateTaskState({ fsImpl: fs, file, build: () => ({ items: [1, 2] }) });
  const [watcher] = h.watch.open(dir);
  // What a directory watch reports for task-state.ts:539: the lock, the temp file, the rename.
  watcher.emit('rename', 'feat-a.json.lock');
  await h.clock.advance(20);
  for (const name of [`feat-a.json.${process.pid}.tmp`, `feat-a.json.${process.pid}.tmp`, 'feat-a.json', 'feat-a.json.lock']) {
    watcher.emit('rename', name);
  }
  await h.clock.advance(DEBOUNCE_MS - 21);
  assert.deepEqual(h.take(), [], 'nothing before the 25 ms debounce ends');
  await h.clock.advance(1);
  assert.deepEqual(h.take().map((c) => [c.channel, c.scope, c.snapshot, c.at]), [['tasks:feat-a', 'all', false, DEBOUNCE_MS]], 'counted from the first mark, not extended by later ones');
  await h.clock.advance(2000);
  assert.deepEqual(h.take(), [], 'the 1 s pass does not recompute a change the recompute already took in');
});

test('IC-006: a watch event with a null file name marks every channel that declared the directory', async (t) => {
  const root = tempDir(t, 'doflow-detector-');
  const shared = path.join(root, 'orchestration');
  const other = path.join(root, 'other');
  fs.mkdirSync(shared);
  fs.mkdirSync(other);
  const h = harness();
  t.after(() => h.detector.close());
  await h.detector.follow('now', { directories: [shared] });
  await h.detector.follow('run:feat-a:A.1', { directories: [shared] });
  await h.detector.follow('tasks:feat-b', { directories: [other] });
  h.take();
  assert.equal(h.watch.handles.length, 2, 'one watch per directory, shared by its channels');
  assert.ok(h.watch.handles.every((w: any) => w.options.recursive === false), 'every watch is non-recursive');
  h.watch.open(shared)[0].emit('change', null);
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepEqual(h.take().map((c) => c.channel).sort(), ['now', 'run:feat-a:A.1']);
});

test('IC-006: files are fingerprinted, never watched', async (t) => {
  const root = tempDir(t, 'doflow-detector-');
  const file = path.join(root, 'rows.json');
  fs.writeFileSync(file, '[]');
  const h = harness();
  t.after(() => h.detector.close());
  await h.detector.follow('now', { files: [file] });
  h.take();
  assert.equal(h.watch.handles.length, 0);
  fs.writeFileSync(file, '[1, 2, 3]');
  await h.clock.advance(1000 + DEBOUNCE_MS);
  assert.deepEqual(h.take().map((c) => [c.channel, c.scope, c.at]), [['now', 'all', 1000 + DEBOUNCE_MS]]);
});

test('IC-006: a watcher error closes the watcher and the 30 s pass attaches it again', async (t) => {
  const root = tempDir(t, 'doflow-detector-');
  const dir = path.join(root, 'orchestration');
  const late = path.join(root, 'late');
  fs.mkdirSync(dir);
  const h = harness();
  t.after(() => h.detector.close());
  h.watch.refuse.add(late);
  await h.detector.follow('now', { directories: [dir, late] });
  const [first] = h.watch.open(dir);
  first.fail(Object.assign(new Error('EMFILE'), { code: 'EMFILE' }));
  assert.equal(first.closed, true, 'the failed watcher is closed');
  assert.equal(h.watch.open(late).length, 0, 'a directory that cannot be watched has no watcher');
  h.watch.refuse.delete(late);
  await h.clock.advance(29000);
  assert.equal(h.watch.open(dir).length, 0, 'not attached again before the 30 s pass');
  assert.equal(h.watch.open(late).length, 0);
  await h.clock.advance(1000);
  assert.equal(h.watch.open(dir).length, 1, 'attached again by the 30 s pass');
  assert.equal(h.watch.open(late).length, 1, 'the refused directory is attached by the 30 s pass');
  h.take();
  h.watch.open(dir)[0].emit('rename', 'x.json');
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepEqual(h.take().map((c) => c.channel), ['now'], 'the new watcher marks the channel');
});

test('IC-006: the 1 s fingerprint pass catches a change no watch event reported, by matching names only', async (t) => {
  const root = tempDir(t, 'doflow-detector-');
  const dir = path.join(root, 'orchestration');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'run-1.json'), '{}');
  const h = harness();
  t.after(() => h.detector.close());
  await h.detector.follow('now', { directories: [{ path: dir, match: /\.json$/ }] });
  h.take();
  fs.writeFileSync(path.join(dir, 'run-1.json.123.tmp'), 'partial');
  fs.mkdirSync(path.join(dir, 'run-1.json.lock'));
  await h.clock.advance(1000 + DEBOUNCE_MS);
  assert.deepEqual(h.take(), [], 'a name the match excludes changes no fingerprint');
  fs.writeFileSync(path.join(dir, 'run-2.json'), '{}');
  await h.clock.advance(1000);
  const after = h.take();
  assert.deepEqual(after.map((c) => [c.channel, c.scope, c.snapshot, c.at]), [['now', 'all', false, 2000 + DEBOUNCE_MS]]);
});

test('IC-006: the 5 s pass recomputes only derived sections, of channels that have them', async (t) => {
  const root = tempDir(t, 'doflow-detector-');
  const h = harness();
  t.after(() => h.detector.close());
  await h.detector.follow('now', { directories: [root], derived: ['observed', 'slots'] });
  await h.detector.follow('run:feat-a:A.1', { directories: [root] });
  h.take();
  await h.clock.advance(4999);
  assert.deepEqual(h.take(), []);
  await h.clock.advance(1);
  assert.deepEqual(h.take().map((c) => [c.channel, c.scope, c.sections, c.at]), [['now', 'derived', ['observed', 'slots'], 5000]]);
  await h.clock.advance(5000);
  assert.deepEqual(h.take().map((c) => [c.channel, c.at]), [['now', 10000]]);
});

test('IC-006: the 30 s pass recomputes every section of every followed channel', async (t) => {
  const root = tempDir(t, 'doflow-detector-');
  const h = harness();
  t.after(() => h.detector.close());
  await h.detector.follow('now', { directories: [root], derived: ['observed'] });
  await h.detector.follow('run:feat-a:A.1', { directories: [root] });
  await h.clock.advance(29999);
  h.take();
  await h.clock.advance(1);
  assert.deepEqual(h.take().map((c) => [c.channel, c.scope, c.snapshot, c.at]), [
    ['now', 'all', false, 30000],
    ['run:feat-a:A.1', 'all', false, 30000],
  ], 'the 30 s pass replaces the 5 s pass that falls on the same tick');
});

test('IC-006: passes never overlap; a pass still running when the next is due skips that tick', async (t) => {
  const root = tempDir(t, 'doflow-detector-');
  const dir = path.join(root, 'orchestration');
  fs.mkdirSync(dir);
  let release: () => void = () => {};
  let block = false;
  let readdirs = 0;
  const countingFs = { ...fs, readdirSync: (...args: any[]) => { readdirs += 1; return fs.readdirSync(...args); } };
  const h = harness({
    fsImpl: countingFs,
    onRecompute: (_ch: string, req: any) => (block && req.scope === 'derived' ? new Promise<void>((resolve) => { release = resolve; }) : undefined),
  });
  t.after(() => h.detector.close());
  await h.detector.follow('now', { directories: [dir], derived: ['observed'] });
  block = true;
  await h.clock.advance(5000);
  block = false;
  h.take();
  const before = readdirs;
  fs.writeFileSync(path.join(dir, 'run-1.json'), '{}');
  await h.clock.advance(3000);
  assert.equal(readdirs, before, 'no fingerprint pass runs while the 5 s pass is still running');
  assert.deepEqual(h.take(), []);
  release();
  await h.clock.advance(1000 + DEBOUNCE_MS);
  assert.ok(readdirs > before, 'the next tick after the slow pass ends runs');
  assert.deepEqual(h.take().map((c) => [c.channel, c.scope, c.at]), [['now', 'all', 9000 + DEBOUNCE_MS]]);
});

test('IC-006: a parse failure is read again after 50 ms; a good second read recomputes, a bad one is store-unreadable', async (t) => {
  const root = tempDir(t, 'doflow-detector-');
  const file = path.join(root, 'task-attempts', 'feat-a.json');
  writeRecord(file, { version: 1, revision: 1 });
  const reads: string[] = [];
  const torn = { remaining: 0 };
  const flakyFs = {
    ...fs,
    readFileSync: (p: string, opts: any) => {
      assert.equal(opts.flag, 'r', 'records are opened read-only');
      reads.push(p);
      if (torn.remaining > 0) { torn.remaining -= 1; return '{"version": 1, "rev'; }
      return fs.readFileSync(p, opts);
    },
  };
  const h = harness({ fsImpl: flakyFs });
  t.after(() => h.detector.close());
  torn.remaining = 1;
  const following = h.detector.follow('tasks:feat-a', { directories: [path.dirname(file)], primary: { path: file } });
  await settle();
  assert.deepEqual(h.take(), [], 'nothing is decided before the retry');
  await h.clock.advance(RETRY_MS);
  await following;
  assert.deepEqual(h.take().map((c) => [c.kind, c.snapshot, c.at]), [['recompute', true, RETRY_MS]], 'the good second read recomputes');

  torn.remaining = 2;
  writeRecord(file, { version: 1, revision: 2 });
  h.watch.open(path.dirname(file))[0].emit('rename', 'feat-a.json');
  await h.clock.advance(DEBOUNCE_MS + RETRY_MS);
  assert.deepEqual(h.take().map((c) => [c.kind, c.event]), [['event', 'store-unreadable']]);
  assert.deepEqual(h.detector.followed(), ['tasks:feat-a'], 'the channel stays followed');

  writeRecord(file, { version: 1, revision: 3, items: [1] });
  await h.clock.advance(1000);
  assert.deepEqual(h.take().map((c) => [c.kind, c.scope, c.snapshot]), [['recompute', 'all', true]], 'the next good read is a snapshot');
});

test('IC-006: a version other than 1 is unsupported-version for that channel only', async (t) => {
  const root = tempDir(t, 'doflow-detector-');
  const dir = path.join(root, 'task-attempts');
  writeRecord(path.join(dir, 'feat-a.json'), { version: 2, revision: 1 });
  writeRecord(path.join(dir, 'feat-b.json'), { version: 1, revision: 1 });
  const h = harness();
  t.after(() => h.detector.close());
  await h.detector.follow('tasks:feat-a', { directories: [{ path: dir, match: /^feat-a\.json$/ }], primary: { path: path.join(dir, 'feat-a.json') } });
  await h.detector.follow('tasks:feat-b', { directories: [{ path: dir, match: /^feat-b\.json$/ }], primary: { path: path.join(dir, 'feat-b.json') } });
  assert.deepEqual(h.take().map((c) => [c.channel, c.kind, c.event ?? c.snapshot]), [
    ['tasks:feat-a', 'event', 'unsupported-version'],
    ['tasks:feat-b', 'recompute', true],
  ]);
  h.watch.open(dir)[0].emit('change', 'feat-b.json');
  await h.clock.advance(DEBOUNCE_MS);
  assert.deepEqual(h.take().map((c) => [c.channel, c.kind]), [['tasks:feat-b', 'recompute']], 'the error is sent once; the other channel goes on');
  writeRecord(path.join(dir, 'feat-a.json'), { version: 1, revision: 2 });
  await h.clock.advance(1000);
  assert.deepEqual(h.take().map((c) => [c.channel, c.kind, c.snapshot]), [['tasks:feat-a', 'recompute', true]]);
});

test('IC-006: a lower revision on the same path is reset replaced, then a snapshot', async (t) => {
  const root = tempDir(t, 'doflow-detector-');
  const file = path.join(root, 'task-attempts', 'feat-a.json');
  writeRecord(file, { version: 1, revision: 7 });
  const h = harness();
  t.after(() => h.detector.close());
  await h.detector.follow('tasks:feat-a', { directories: [path.dirname(file)], primary: { path: file } });
  h.take();
  writeRecord(file, { version: 1, revision: 8 });
  await h.clock.advance(1000 + DEBOUNCE_MS);
  assert.deepEqual(h.take().map((c) => [c.kind, c.snapshot]), [['recompute', false]], 'a higher revision is an ordinary recompute');
  writeRecord(file, { version: 1, revision: 1 });
  await h.clock.advance(1000);
  assert.deepEqual(h.take().map((c) => [c.kind, c.event ?? c.scope, c.snapshot]), [
    ['event', 'replaced', undefined],
    ['recompute', 'all', true],
  ]);
});

test('IC-006: a seen record missing for 2 s is gone; missing for less emits nothing', async (t) => {
  const root = tempDir(t, 'doflow-detector-');
  const dir = path.join(root, 'orchestration');
  const file = path.join(dir, 'A.1.json');
  writeRecord(file, { version: 1, revision: 1 });
  const h = harness();
  t.after(() => h.detector.close());
  await h.detector.follow('run:feat-a:A.1', { directories: [dir], primary: { path: file } });
  h.take();

  fs.rmSync(file);
  await h.clock.advance(1000); // seen missing at 1 s
  await h.clock.advance(1000); // still missing at 2 s: 1 s so far
  writeRecord(file, { version: 1, revision: 2 });
  await h.clock.advance(1000 + DEBOUNCE_MS);
  assert.deepEqual(h.take().map((c) => [c.kind, c.snapshot]), [['recompute', false]], 'back within 2 s: no event, one recompute');

  fs.rmSync(file);
  h.watch.open(dir)[0].emit('rename', 'A.1.json');
  await h.clock.advance(DEBOUNCE_MS); // seen missing at 3.05 s
  await h.clock.advance(1000 - DEBOUNCE_MS); // 4 s: missing for 0.95 s
  await h.clock.advance(1000); // 5 s: missing for 1.95 s
  assert.deepEqual(h.take(), [], 'missing for less than 2 s emits nothing');
  await h.clock.advance(1000); // 6 s: missing for 2.95 s
  assert.deepEqual(h.take().map((c) => [c.kind, c.event]), [['event', 'gone']]);
  assert.deepEqual(h.detector.followed(), [], 'a gone channel is no longer followed');
  assert.equal(h.watch.open(dir).length, 0, 'its watcher is closed');
});

test('IC-006: a worker run seq change marks its channel even when the fingerprint matches', async (t) => {
  const root = tempDir(t, 'doflow-detector-');
  const dir = path.join(root, 'worker-runs');
  const file = path.join(dir, 'feat-a.json');
  const runId = 'w-0123456789ab';
  writeRecord(file, { slug: 'feat-a', runs: { [runId]: { runId, phase: 'running', seq: 1 }, 'w-ffffffffffff': { seq: 4 } }, version: 1, revision: 3 });
  // Same ino, size and mtime whatever the bytes: only the record probe can see the change.
  const frozenFs = { ...fs, statSync: () => ({ ino: 1, size: 100, mtimeMs: 5 }) };
  const h = harness({ fsImpl: frozenFs });
  t.after(() => h.detector.close());
  await h.detector.follow(`worker:${runId}`, { directories: [dir], derived: ['status'], primary: { path: file, pick: (doc: any) => doc.runs?.[runId] } });
  h.take();
  writeRecord(file, { slug: 'feat-a', runs: { [runId]: { runId, phase: 'running', seq: 1 }, 'w-ffffffffffff': { seq: 5 } }, version: 1, revision: 3 });
  await h.clock.advance(1000 + DEBOUNCE_MS);
  assert.deepEqual(h.take(), [], "another run's seq is not this channel's change");
  writeRecord(file, { slug: 'feat-a', runs: { [runId]: { runId, phase: 'ended', seq: 2 }, 'w-ffffffffffff': { seq: 5 } }, version: 1, revision: 3 });
  await h.clock.advance(1000);
  assert.deepEqual(h.take().map((c) => [c.channel, c.scope, c.at]), [[`worker:${runId}`, 'all', 2000 + DEBOUNCE_MS]]);
});

test('IC-006: a never-seen primary record is waited for, never gone', async (t) => {
  const root = tempDir(t, 'doflow-detector-');
  const dir = path.join(root, 'orchestration');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'A.1.json');
  const h = harness();
  t.after(() => h.detector.close());
  await h.detector.follow('run:feat-a:A.1', { directories: [dir], primary: { path: file } });
  assert.deepEqual(h.take().map((c) => [c.kind, c.scope, c.snapshot]), [['recompute', 'all', true]], 'the sections are what the verbs answer');
  await h.clock.advance(10000);
  assert.deepEqual(h.take(), [], 'no event while it is missing');
  assert.deepEqual(h.detector.followed(), ['run:feat-a:A.1']);
  writeRecord(file, { version: 1, revision: 1 });
  await h.clock.advance(1000 + DEBOUNCE_MS);
  assert.deepEqual(h.take().map((c) => [c.kind, c.snapshot]), [['recompute', false]]);
});

test('IC-006: close() closes every watcher and timer, and no callback runs after it', async (t) => {
  const root = tempDir(t, 'doflow-detector-');
  const file = path.join(root, 'a', 'x.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '{"torn');
  const h = harness();
  const pending = h.detector.follow('tasks:a', { directories: [path.dirname(file), root], derived: ['w'], primary: { path: file } });
  await settle();
  h.watch.open(root)[0].emit('rename', null);
  assert.ok(h.clock.hasTimeout(), 'a debounce and a retry are pending');
  h.detector.close();
  assert.equal(h.clock.pending(), 0, 'no timer is left');
  assert.ok(h.watch.handles.every((w: any) => w.closed), 'every watcher is closed');
  await h.clock.advance(60000);
  void pending;
  assert.deepEqual(h.take(), []);
  assert.throws(() => h.detector.follow('now', {}), /closed/);
});

test('IC-006: the real fs.watch reports a temp-file rename in a followed directory', async (t) => {
  const root = tempDir(t, 'doflow-detector-');
  const dir = path.join(root, 'task-attempts');
  const file = path.join(dir, 'feat-a.json');
  updateTaskState({ fsImpl: fs, file, build: () => ({ items: [] }) });
  const clock = fakeClock();
  const calls: any[] = [];
  const detector = createDetector({
    clock,
    onRecompute: (channel: string, request: any) => { calls.push({ channel, ...request }); },
    onRecordEvent: (channel: string, event: string) => { calls.push({ channel, event }); },
  });
  t.after(() => detector.close());
  await detector.follow('tasks:feat-a', { directories: [{ path: dir, match: /\.json$/ }], primary: { path: file } });
  // Events from the setup writes may still arrive: let them, then flush their debounce.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await clock.advance(DEBOUNCE_MS);
  calls.length = 0;

  updateTaskState({ fsImpl: fs, file, build: () => ({ items: [1] }) });
  const deadline = Date.now() + 10000;
  while (!clock.hasTimeout() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(clock.hasTimeout(), 'fs.watch reported the write within 10 s');
  await new Promise((resolve) => setTimeout(resolve, 200));
  await clock.advance(DEBOUNCE_MS);
  assert.deepEqual(calls, [{ channel: 'tasks:feat-a', scope: 'all', snapshot: false }]);
});
