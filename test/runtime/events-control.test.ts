'use strict';

// Feature 149 A.6 (IC-001, IC-003, IC-005, DEC-054): `doflow events --follow --control stdin` and
// the handler's usage, fault and stop paths. In-process cases inject stdin, stdout, stderr, the
// clock, the watch, the signal source and the channel catalogue, so nothing depends on real
// timing; one spawned case runs the CLI on a real project with a generous deadline.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { handleEventsCommand, CONTROL_LINE_BYTES } = require('../../src/runtime/events/command.ts');
const { CHANNEL_LIMIT } = require('../../src/runtime/events/channels.ts');
const { ENVELOPE_ID } = require('../../src/runtime/events/envelope.ts');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const SPAWN_DEADLINE_MS = 20000;

/** Lets every queued promise chain and immediate run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function fakeClock() {
  let now = Date.UTC(2026, 10, 7);
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) { nextId += 1; timers.set(nextId, { at: now + ms, fn, every: null }); return nextId; },
    clearTimeout(id: number) { timers.delete(id); },
    setInterval(fn: () => void, ms: number) { nextId += 1; timers.set(nextId, { at: now + ms, fn, every: ms }); return nextId; },
    clearInterval(id: number) { timers.delete(id); },
    pending: () => timers.size,
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
  watch.handles = handles;
  return watch;
}

function fakeStdin() {
  const stdin: any = new EventEmitter();
  stdin.paused = false;
  stdin.destroyed = false;
  stdin.pause = () => { stdin.paused = true; };
  stdin.destroy = () => { stdin.destroyed = true; };
  stdin.line = (text: string) => stdin.emit('data', Buffer.from(`${text}\n`, 'utf8'));
  stdin.json = (op: string, ch: string) => stdin.line(JSON.stringify({ op, ch }));
  return stdin;
}

function sink() {
  const s: any = { text: '', write(chunk: string) { s.text += chunk; return true; } };
  s.lines = () => s.text.split('\n').filter((l: string) => l !== '');
  s.frames = () => s.lines().map((l: string) => JSON.parse(l));
  return s;
}

/**
 * A catalogue whose sections are `values[ch]`, with no declared source unless `dir` is given; every
 * `specFor` call is counted, so a refused channel is shown to have opened nothing.
 */
function catalogue(dir?: string) {
  const values: Record<string, any> = {};
  const made: string[] = [];
  const failing = new Set<string>();
  const specFor = (channel: any) => {
    made.push(channel.name);
    return {
      sources: () => ({ directories: dir ? [dir] : [], files: [], derived: [], primary: null }),
      compute: async () => {
        if (failing.has(channel.name)) throw new Error('producer broke');
        return { sections: { s: { exit: 0, json: values[channel.name] ?? null } } };
      },
    };
  };
  return { values, made, failing, specFor };
}

/** One in-process handler run with every seam injected. */
function run(t: any, extra: any = {}) {
  const saved = process.exitCode; // the handler sets it, as the CLI relies on; restored so this file's own exit stays clean
  t.after(() => { process.exitCode = saved; });
  const clock = fakeClock();
  const watch = fakeWatch();
  const stdin = fakeStdin();
  const stdout = sink();
  const stderr = sink();
  const signals = new EventEmitter();
  const cat = extra.catalogue ?? catalogue(extra.dir);
  let exit: number | null = null;
  const done = handleEventsCommand({
    follow: true, control: 'stdin', json: true, flags: ['--follow', '--control', '--json'], positional: [], cwd: REPO, env: {},
    stdin, stdout, stderr, clock, watch, signals, epoch: '0a1b2c3d', specFor: cat.specFor, ...extra.options,
  }).then((code: number) => { exit = code; return code; });
  return { clock, watch, stdin, stdout, stderr, signals, cat, done, exit: () => exit };
}

const n = (frame: any): number => Number(frame.id.split('-')[1]);

test('IC-005: sub snapshots, a change patches, unsub stops the channel, re-sub snapshots afresh, EOF exits 0', async (t) => {
  const h = run(t);
  h.cat.values.now = { a: 1 };
  h.cat.values['tasks:feat-a'] = { b: 1 };
  h.stdin.json('sub', 'now');
  h.stdin.json('sub', 'tasks:feat-a');
  await settle();
  let frames = h.stdout.frames();
  assert.deepEqual(frames.map((f: any) => [f.ch, f.type]), [['now', 'snapshot'], ['tasks:feat-a', 'snapshot']]);
  for (const f of frames) {
    assert.equal(f.v, 1);
    assert.match(f.id, ENVELOPE_ID);
    assert.equal(f.id.split('-')[0], '0a1b2c3d');
  }
  assert.deepEqual(frames[0].data, { sections: { s: { exit: 0, json: { a: 1 } } } });

  // A change is a patch of the changed section, with a greater id; an unchanged channel prints nothing.
  h.cat.values.now = { a: 2 };
  await h.clock.advance(30000); // the 30 s pass recomputes every followed channel
  frames = h.stdout.frames().slice(2);
  assert.deepEqual(frames.map((f: any) => [f.ch, f.type]), [['now', 'patch']]);
  assert.deepEqual(frames[0].data, { sections: { s: { exit: 0, json: { a: 2 } } } });
  assert.ok(n(frames[0]) > n(h.stdout.frames()[0]));

  // unsub: nothing is emitted for it, then or later; the other channel goes on.
  const before = h.stdout.lines().length;
  h.stdin.json('unsub', 'now');
  h.stdin.json('unsub', 'worker:w-0123456789ab'); // not followed: nothing
  await settle();
  assert.equal(h.stdout.lines().length, before);
  h.cat.values.now = { a: 3 };
  h.cat.values['tasks:feat-a'] = { b: 2 };
  await h.clock.advance(30000);
  frames = h.stdout.frames().slice(before);
  assert.deepEqual(frames.map((f: any) => [f.ch, f.type]), [['tasks:feat-a', 'patch']]);

  // Re-sub of a followed channel: a fresh snapshot, numbered after the channel's earlier frames.
  const mark = h.stdout.lines().length;
  h.stdin.json('sub', 'tasks:feat-a');
  await settle();
  frames = h.stdout.frames().slice(mark);
  assert.deepEqual(frames.map((f: any) => [f.ch, f.type]), [['tasks:feat-a', 'snapshot']]);
  assert.deepEqual(frames[0].data.sections.s.json, { b: 2 });
  assert.equal(n(frames[0]), 3);

  h.stdin.emit('end');
  assert.equal(await h.done, 0);
  assert.equal(h.stderr.text, '');
  assert.equal(h.clock.pending(), 0, 'every detector timer is cleared');
  assert.ok(h.stdin.destroyed);
});

test('IC-003: the 65th sub gets error too-many-channels and is not followed', async (t) => {
  const h = run(t);
  for (let i = 1; i <= CHANNEL_LIMIT; i += 1) h.stdin.json('sub', `tasks:f${i}`);
  await settle();
  assert.equal(h.stdout.frames().filter((f: any) => f.type === 'snapshot').length, CHANNEL_LIMIT);
  h.stdin.json('sub', 'tasks:f65');
  await settle();
  const last = h.stdout.frames().at(-1);
  assert.deepEqual([last.ch, last.type, last.data], ['tasks:f65', 'error', { code: 'too-many-channels' }]);
  assert.ok(!h.cat.made.includes('tasks:f65'), 'the 65th channel is never opened');
  // Not followed: a full pass recomputes the 64 and never the 65th.
  for (let i = 1; i <= 65; i += 1) h.cat.values[`tasks:f${i}`] = { changed: i };
  const mark = h.stdout.lines().length;
  await h.clock.advance(30000);
  const later = h.stdout.frames().slice(mark);
  assert.equal(later.length, CHANNEL_LIMIT);
  assert.ok(later.every((f: any) => f.type === 'patch' && f.ch !== 'tasks:f65'));
  // A re-sub of a followed channel is still answered at the bound.
  h.stdin.json('sub', 'tasks:f1');
  await settle();
  assert.deepEqual([h.stdout.frames().at(-1).ch, h.stdout.frames().at(-1).type], ['tasks:f1', 'snapshot']);
  h.stdin.emit('end');
  assert.equal(await h.done, 0);
});

test('IC-005: every invalid control line writes one stderr line and exits 2', async (t) => {
  const cases: Array<[string, Buffer]> = [
    ['not JSON', Buffer.from('sub now\n')],
    ['not an object', Buffer.from('["sub","now"]\n')],
    ['an extra key', Buffer.from('{"op":"sub","ch":"now","x":1}\n')],
    ['a missing key', Buffer.from('{"op":"sub"}\n')],
    ['an unknown op', Buffer.from('{"op":"pub","ch":"now"}\n')],
    ['a refused channel', Buffer.from('{"op":"sub","ch":"transcript:x"}\n')],
    ['a worker output channel', Buffer.from('{"op":"sub","ch":"worker:w-0123456789ab:out"}\n')],
    ['a malformed channel', Buffer.from('{"op":"sub","ch":"run:only-slug"}\n')],
    ['a line over 1024 bytes', Buffer.from(`{"op":"sub","ch":"now","pad":"${'x'.repeat(CONTROL_LINE_BYTES)}"}\n`)],
    ['an unterminated line over 1024 bytes', Buffer.from('y'.repeat(CONTROL_LINE_BYTES + 1))],
  ];
  for (const [name, bytes] of cases) {
    await t.test(name, async (st: any) => {
      const h = run(st);
      h.stdin.emit('data', bytes);
      assert.equal(await h.done, 2);
      assert.equal(h.stdout.text, '', 'no envelope');
      const lines = h.stderr.lines();
      assert.equal(lines.length, 1, h.stderr.text);
      assert.match(lines[0], /^doflow events: invalid control line: /);
      assert.ok(!lines[0].includes('[ERROR]'), 'a usage error carries no [ERROR] marker');
      assert.deepEqual(h.cat.made, [], 'no channel was opened');
      assert.equal(h.clock.pending(), 0);
    });
  }

  await t.test('a line of exactly 1024 bytes is accepted', async (st: any) => {
    const h = run(st);
    const base = '{"op":"sub","ch":"now"}';
    const padded = `${base}${' '.repeat(CONTROL_LINE_BYTES - base.length)}`;
    assert.equal(Buffer.byteLength(padded), CONTROL_LINE_BYTES);
    h.stdin.emit('data', Buffer.from(`${padded}\n`));
    await settle();
    assert.deepEqual(h.stdout.frames().map((f: any) => f.type), ['snapshot']);
    h.stdin.emit('end');
    assert.equal(await h.done, 0);
  });

  await t.test('lines split across chunks, and a valid line before an invalid one, keep their order', async (st: any) => {
    const h = run(st);
    const text = '{"op":"sub","ch":"now"}\n{"op":"nope","ch":"now"}\n';
    for (const piece of [text.slice(0, 7), text.slice(7, 30), text.slice(30)]) h.stdin.emit('data', Buffer.from(piece));
    assert.equal(await h.done, 2);
    assert.deepEqual(h.stdout.frames().map((f: any) => [f.ch, f.type]), [['now', 'snapshot']]);
    assert.equal(h.stderr.lines().length, 1);
  });
});

test('IC-005: stdin EOF with nothing followed exits 0 and prints nothing', async (t) => {
  const h = run(t);
  h.stdin.emit('end');
  assert.equal(await h.done, 0);
  assert.equal(h.stdout.text, '');
  assert.equal(h.stderr.text, '');
  assert.equal(h.clock.pending(), 0);
});

test('DEC-054: an internal fault before any envelope is exit 1 with one [ERROR] stderr line and no stdout', async (t) => {
  await t.test('control mode: the catalogue fails on the first sub', async (st: any) => {
    const broken = { values: {}, made: [] as string[], failing: new Set(), specFor: () => { throw new Error('catalogue broke'); } };
    const h = run(st, { catalogue: broken });
    h.stdin.json('sub', 'now');
    h.stdin.json('sub', 'tasks:feat-a'); // nothing after the fault
    assert.equal(await h.done, 1);
    assert.equal(h.stdout.text, '');
    const lines = h.stderr.lines();
    assert.equal(lines.length, 1, h.stderr.text);
    assert.match(lines[0], /\[ERROR\]/);
    assert.equal(h.clock.pending(), 0);
  });

  await t.test('channels mode: the detector cannot be made', async (st: any) => {
    const h = run(st, { options: { control: undefined, channels: 'now', flags: ['--follow', '--channels', '--json'], detectorFactory: () => { throw new Error('detector broke'); } } });
    assert.equal(await h.done, 1);
    assert.equal(h.stdout.text, '');
    assert.equal(h.stderr.lines().length, 1);
    assert.match(h.stderr.text, /\[ERROR\]/);
  });

  await t.test('after envelopes: a detector fault stops the stream with one [ERROR] line', async (st: any) => {
    let fault: any = null;
    const h = run(st, {
      options: {
        detectorFactory: (opts: any) => {
          fault = opts.onFault;
          return { follow: async (ch: string) => { await opts.onRecompute(ch, { scope: 'all', snapshot: true }); }, unfollow() {}, followed: () => [], close() {} };
        },
      },
    });
    h.stdin.json('sub', 'now');
    await settle();
    assert.equal(h.stdout.lines().length, 1);
    fault(new Error('pass broke'));
    h.stdin.json('sub', 'tasks:feat-a');
    assert.equal(await h.done, 1);
    await settle();
    assert.equal(h.stdout.lines().length, 1, 'nothing more is printed');
    assert.equal(h.stderr.lines().length, 1);
    assert.match(h.stderr.text, /\[ERROR\] doflow events: pass broke/);
  });
});

test('IC-002: a producer fault is error producer-failed once, and the next good read is a snapshot', async (t) => {
  const h = run(t);
  h.cat.failing.add('now');
  h.stdin.json('sub', 'now');
  await settle();
  assert.deepEqual(h.stdout.frames().map((f: any) => [f.type, f.data]), [['error', { code: 'producer-failed' }]]);
  await h.clock.advance(30000); // still failing: no second error frame
  assert.equal(h.stdout.lines().length, 1);
  h.cat.failing.delete('now');
  h.cat.values.now = { ok: true };
  await h.clock.advance(30000);
  const frames = h.stdout.frames();
  assert.deepEqual(frames.map((f: any) => f.type), ['error', 'snapshot']);
  assert.ok(n(frames[1]) > n(frames[0]));
  h.stdin.emit('end');
  assert.equal(await h.done, 0);
});

test('IC-001: SIGINT and SIGTERM exit 0 with every watcher and timer closed', async (t) => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    await t.test(signal, async (st: any) => {
      const dir = tempDir(st, 'doflow-events-control-');
      const h = run(st, { dir, options: { control: undefined, channels: 'now,tasks:feat-a', flags: ['--follow', '--channels'] } });
      await settle();
      assert.deepEqual(h.stdout.frames().map((f: any) => [f.ch, f.type]), [['now', 'snapshot'], ['tasks:feat-a', 'snapshot']]);
      assert.ok(h.watch.handles.length > 0 && h.watch.handles.some((w: any) => !w.closed));
      h.signals.emit(signal);
      assert.equal(await h.done, 0);
      assert.ok(h.watch.handles.every((w: any) => w.closed), 'every watcher is closed');
      assert.equal(h.clock.pending(), 0, 'every timer is cleared');
      assert.equal(h.signals.listenerCount('SIGINT') + h.signals.listenerCount('SIGTERM'), 0);
      assert.equal(h.stderr.text, '');
    });
  }
});

test('IC-001: usage errors exit 2 before any envelope, opening no channel', async (t) => {
  const cases: Array<[string, any]> = [
    ['no --follow', { follow: false, flags: ['--channels'], channels: 'now', control: undefined }],
    ['both --channels and --control', { channels: 'now', flags: ['--follow', '--channels', '--control'] }],
    ['neither', { control: undefined, flags: ['--follow'] }],
    ['--control other than stdin', { control: 'fifo' }],
    ['a repeated flag', { flags: ['--follow', '--control', '--json', '--json'] }],
    ['an unknown flag', { flags: ['--follow', '--control', '--slug'] }],
    ['--follow with a value', { flags: ['--follow=yes', '--control'] }],
    ['a positional argument', { positional: ['/some/project'] }],
    ['a refused kind in --channels', { control: undefined, channels: 'now,fleet:x', flags: ['--follow', '--channels'] }],
    ['a repeated channel', { control: undefined, channels: 'now,now', flags: ['--follow', '--channels'] }],
    ['more than 64 channels', { control: undefined, channels: Array.from({ length: 65 }, (_, i) => `tasks:f${i}`).join(','), flags: ['--follow', '--channels'] }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async (st: any) => {
      const h = run(st, { options });
      assert.equal(await h.done, 2);
      assert.equal(h.stdout.text, '');
      assert.equal(h.stderr.lines().length, 1);
      assert.match(h.stderr.text, /^doflow events: /);
      assert.ok(!h.stderr.text.includes('[ERROR]'));
      assert.deepEqual(h.cat.made, []);
      assert.equal(h.watch.handles.length, 0);
      assert.equal(h.signals.listenerCount('SIGTERM'), 0);
    });
  }
});

function project(t: any) {
  const root = tempDir(t, 'doflow-events-control-cli-');
  const f: any = { root, main: path.join(root, 'proj'), home: path.join(root, 'home'), config: path.join(root, 'config') };
  for (const d of [f.main, f.home, f.config]) fs.mkdirSync(d, { recursive: true });
  const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV };
  for (const args of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'first']]) {
    const r = spawnSync('git', ['-C', f.main, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env: gitEnv });
    assert.equal(r.status, 0, r.stderr);
  }
  f.env = { ...process.env, ...GIT_NO_MAINTENANCE_ENV, HOME: f.home, USERPROFILE: f.home, XDG_CONFIG_HOME: f.config, DOFLOW_UPKEEP: 'off', DOFLOW_TELEMETRY: 'off', DOFLOW_FAILURE_CAPTURE: 'off' };
  return f;
}

test('IC-005 through the CLI: sub prints a snapshot, an unsub and stdin EOF exit 0', async (t) => {
  const f = project(t);
  const child = spawn(process.execPath, [CLI, 'events', '--follow', '--control', 'stdin', '--json'], { cwd: f.main, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
  child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code: number | null) => resolve(code)));
  const deadline = (what: string) => new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; stdout ${out} stderr ${err}`)), SPAWN_DEADLINE_MS); timer.unref(); });
  const firstLine = new Promise<void>((resolve) => { const check = () => { if (out.includes('\n')) resolve(); else child.stdout.once('data', check); }; check(); });
  child.stdin.write(`${JSON.stringify({ op: 'sub', ch: 'run:feat-a:a1' })}\n`);
  await Promise.race([firstLine, deadline('the snapshot')]);
  child.stdin.write(`${JSON.stringify({ op: 'unsub', ch: 'run:feat-a:a1' })}\n`);
  child.stdin.end();
  const code = await Promise.race([exited, deadline('the exit')]);
  assert.equal(code, 0, err);
  const lines = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1, out);
  assert.equal(lines[0].v, 1);
  assert.deepEqual([lines[0].ch, lines[0].type], ['run:feat-a:a1', 'snapshot']);
  assert.deepEqual(lines[0].data.sections.status, { exit: 1, json: null }, 'no such run is the verb\'s exit 1');
  assert.equal(err, '');
});
