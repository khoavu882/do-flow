'use strict';

// FU-31dyvs: the slot lock is the task-state lock (src/runtime/task-state.ts) with an owner-aware stale
// rule. Each test names the defect of the 115 slot lock it replays (red on 694ec9ba) or the behaviour
// of the 115 lock it keeps. SLOTS_MODULE points the tests at another copy of slots.ts (a negative
// control or an older runtime); LEGACY_SLOT_LOCK_MODULE points the "older runtime" side of the mixed
// tests at another lock than the frozen copy in test/helper/legacy-slot-lock.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MODULE = process.env.SLOTS_MODULE || path.join(__dirname, '..', '..', 'src', 'runtime', 'slots.ts');
const { acquireSlotLock, releaseSlot } = require(MODULE);
const { procStart, alive } = require('../../src/runtime/worker/process-tree.ts');
const { suiteTempDir } = require('../helper/tmp');

const ACTOR = path.join(__dirname, '..', 'helper', 'slot-lock-actor.js');
const DEAD = 2_000_000_000; // a pid no process has
const hex = (text) => Buffer.from(text, 'utf8').toString('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lockFile(prefix = 'doflow-slot-lock-') {
  const dir = suiteTempDir(prefix);
  return { dir, file: path.join(dir, 'slot.json'), lockDir: path.join(dir, 'slot.json.lock') };
}
function age(target, seconds) {
  const t = (Date.now() - seconds * 1000) / 1000;
  fs.utimesSync(target, t, t);
}
function fakeDeps(extra = {}) {
  return { pid: process.pid, procStart: () => 'test-start', alive: (proc) => proc.pid !== DEAD, fsImpl: fs, ...extra };
}
/** fs whose methods `hooks` wraps: hooks[name](original, ...args). */
function hookedFs(hooks) {
  const wrapped = { ...fs };
  for (const [name, hook] of Object.entries(hooks)) wrapped[name] = (...args) => hook(fs[name].bind(fs), ...args);
  return wrapped;
}

// ── Competing reclaimers (C-9: both renamed the judged lock aside by name, so both held) ───────────

for (const [seed, prepare] of [
  ['an empty lock older than 10 s', (lockDir) => { fs.mkdirSync(lockDir); age(lockDir, 60); }],
  ['an older runtime\'s lock whose owner is dead', (lockDir) => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: DEAD, start: null }));
  }],
  ['a lock whose entry\'s owner is dead, older than 10 s', (lockDir) => {
    fs.mkdirSync(lockDir);
    fs.mkdirSync(path.join(lockDir, `owner-${DEAD}-x-0123456789ab`));
    age(lockDir, 60);
  }],
]) {
  test(`two reclaimers of ${seed}: the second holds only after the first released`, () => {
    const { file, lockDir } = lockFile();
    prepare(lockDir);
    let first = null;
    let firstReleased = false;
    let judgedSeen = false;
    let looks = 0;
    // The second reclaimer has judged the lock; before it acts, the first reclaims it and holds.
    const act = (original, target, ...rest) => {
      if (!judgedSeen && target !== lockDir) { judgedSeen = true; first = acquireSlotLock(fs, file, fakeDeps()); }
      return original(target, ...rest);
    };
    const secondFs = hookedFs({
      mkdirSync: act,
      renameSync: (original, from, to) => {
        if (!judgedSeen && from === lockDir) { judgedSeen = true; first = acquireSlotLock(fs, file, fakeDeps()); }
        return original(from, to);
      },
      readdirSync: (original, ...args) => {
        if (first && !firstReleased && (looks += 1) === 3) { first(); firstReleased = true; }
        return original(...args);
      },
    });
    const second = acquireSlotLock(secondFs, file, fakeDeps({ fsImpl: secondFs }));
    assert.equal(typeof first, 'function', 'the first reclaimer took the lock');
    assert.equal(firstReleased, true, 'the second reclaimer held the lock while the first still held it');
    assert.equal(second.held(), true);
    second();
    assert.equal(fs.existsSync(lockDir), false);
  });
}

// ── The publication window (C-1 class: the owner token was written by path after the mkdir) ───────

test('a holder paused between its mkdir and its entry never holds beside the process that reclaimed meanwhile', () => {
  const { file, lockDir } = lockFile();
  const realNow = Date.now;
  let other = null;
  let otherReleased = false;
  let looks = 0;
  const pausedFs = hookedFs({
    mkdirSync: (original, target, ...rest) => {
      const result = original(target, ...rest);
      if (target === lockDir && !other) {
        // Paused past 10 s right after making the lock: another process judges it stale and holds.
        age(lockDir, 60);
        other = acquireSlotLock(fs, file, fakeDeps());
        Date.now = () => realNow() + 11_000;
      }
      return result;
    },
    readdirSync: (original, ...args) => {
      if (other && !otherReleased && (looks += 1) === 3) { other(); otherReleased = true; }
      return original(...args);
    },
  });
  let paused;
  try {
    paused = acquireSlotLock(pausedFs, file, fakeDeps({ fsImpl: pausedFs }));
  } finally {
    Date.now = realNow;
  }
  assert.equal(typeof other, 'function', 'the other process reclaimed the lock');
  assert.equal(otherReleased, true, 'the paused process held the lock while the other still held it');
  assert.equal(paused.held(), true);
  paused();
});

// ── A write after the lock was reclaimed (C-9: no `held()`, so updateTaskState skipped the check) ──

function slotEnv() {
  const home = suiteTempDir('doflow-slot-lock-home-');
  const file = path.join(home, '.doflow', 'state', 'slots', 'lost.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: process.env.PATH }, file };
}
const waiter = (pid) => ({ pid, start: null, label: `w${pid}`, since: '2026-10-23T10:00:00.000Z', cwd: '/w' });
const holder = { pid: DEAD, start: null, childPid: null, childStart: null, label: 'dead', since: '2026-10-23T09:00:00.000Z', cwd: '/h' };

for (const [what, waiters, expected] of [
  ['its write', [waiter(4101)], [4101, 4102]],
  ['its delete of an emptied slot file', [], [4102]],
]) {
  test(`a slot change whose lock was reclaimed before ${what} changes nothing, then runs again on the fresh file`, async () => {
    const { env, file } = slotEnv();
    fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 1, name: 'lost', holder, waiters, lastRelease: null }));
    let reclaimed = false;
    const deps = {
      procStart: () => null,
      alive: (proc) => {
        if (!reclaimed) {
          // Inside the critical section: another process reclaims the lock, records a waiter, releases.
          reclaimed = true;
          fs.rmSync(`${file}.lock`, { recursive: true, force: true });
          fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 2, name: 'lost', holder, waiters: [...waiters, waiter(4102)], lastRelease: null }));
        }
        return proc.pid !== DEAD;
      },
    };
    const result = await releaseSlot({ name: 'lost', by: 'tester', reason: 'dead holder', env, deps });
    assert.equal(result.disposition, 'released');
    assert.ok(fs.existsSync(file), 'the reclaimer\'s record was deleted');
    const final = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(final.waiters.map((w) => w.pid), expected, 'the reclaimer\'s waiter survives');
    assert.equal(final.holder, null);
    assert.equal(final.lastRelease.by, 'tester');
    assert.equal(fs.existsSync(`${file}.lock`), false);
  });
}

// ── Liveness: kept from the 115 lock (C-4), now read from the entry name ─────────────────────────

test('an older runtime\'s lock whose owner is alive is not reclaimed however old; its release frees it', () => {
  const { file, lockDir } = lockFile();
  fs.mkdirSync(lockDir);
  const token = path.join(lockDir, 'owner.json');
  fs.writeFileSync(token, JSON.stringify({ pid: process.pid, start: procStart(process.pid) }));
  age(lockDir, 60);
  let looks = 0;
  let tokenKeptWhileWaiting = true;
  const waitingFs = hookedFs({
    readdirSync: (original, ...args) => {
      looks += 1;
      if (looks <= 5 && !fs.existsSync(token)) tokenKeptWhileWaiting = false;
      if (looks === 5) { fs.unlinkSync(token); fs.rmdirSync(lockDir); } // the older runtime's release
      return original(...args);
    },
  });
  const release = acquireSlotLock(waitingFs, file, { pid: process.pid, procStart, alive, fsImpl: waitingFs });
  assert.equal(tokenKeptWhileWaiting, true, 'a live owner\'s token was removed');
  assert.ok(looks >= 5, 'the lock was taken before its live owner released it');
  release();
});

test('an older runtime\'s lock whose owner is dead is reclaimed at once, its token removed in place', () => {
  const { file, lockDir } = lockFile();
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: DEAD, start: null }));
  const started = Date.now();
  const release = acquireSlotLock(fs, file, { pid: process.pid, procStart, alive, fsImpl: fs });
  assert.ok(Date.now() - started < 2000);
  const entries = fs.readdirSync(lockDir);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^owner-\d+-[0-9a-f]+-[0-9a-f]{12}$/);
  release();
  assert.equal(fs.existsSync(lockDir), false);
});

test('an entry names its owner\'s pid and start, so a reused pid is judged dead', () => {
  const { file, lockDir } = lockFile();
  const deps = { pid: process.pid, procStart, alive, fsImpl: fs };
  const release = acquireSlotLock(fs, file, deps);
  const [entry] = fs.readdirSync(lockDir);
  const match = /^owner-(\d+)-([0-9a-f]+)-[0-9a-f]{12}$/.exec(entry);
  assert.ok(match, entry);
  assert.equal(Number(match[1]), process.pid);
  assert.equal(Buffer.from(match[2], 'hex').toString('utf8'), procStart(process.pid));
  release();
  // This live pid with another start (the pid was reused by this process): dead, reclaimed at once.
  fs.mkdirSync(lockDir);
  fs.mkdirSync(path.join(lockDir, `owner-${process.pid}-${hex('Mon Jan  1 00:00:00 2001')}-0123456789ab`));
  const started = Date.now();
  const again = acquireSlotLock(fs, file, deps);
  assert.ok(Date.now() - started < 2000, 'an entry of a reused pid was waited on');
  again();
});

// ── Real processes ─────────────────────────────────────────────────────────────────────────────

function actor(t, config, env = {}) {
  const child = spawn(process.execPath, [ACTOR, JSON.stringify(config)], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  let buffer = '';
  let onPause = null;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (onPause && buffer.includes('R\n')) { const resolve = onPause; onPause = null; resolve(); }
  });
  const paused = new Promise((resolve) => { onPause = resolve; });
  const done = new Promise((resolve) => child.on('close', () => {
    const match = /OUT (.*)\n/.exec(buffer);
    resolve(match ? JSON.parse(match[1]) : { kind: 'NONE' });
  }));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return { child, paused, done };
}
async function until(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met before the deadline');
    await sleep(20);
  }
}
const events = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : []);

test('SIGSTOP: a reclaimer stopped between judging a stale lock and acting on it never holds beside the one that reclaimed meanwhile', async (t) => {
  const { dir, file, lockDir } = lockFile();
  fs.mkdirSync(lockDir);
  age(lockDir, 60);
  const eventsFile = path.join(dir, 'events');
  const goFile = path.join(dir, 'go');
  const stopped = actor(t, { runtime: 'new', mode: 'hold', file, label: 'A', eventsFile, pauseAtAct: true });
  await stopped.paused;
  stopped.child.kill('SIGSTOP');
  const other = actor(t, { runtime: 'new', mode: 'hold', file, label: 'B', eventsFile, goFile });
  await until(() => events(eventsFile).includes('B-enter'));
  stopped.child.kill('SIGCONT');
  await sleep(1500);
  fs.writeFileSync(goFile, 'go');
  const [a, b] = await Promise.all([stopped.done, other.done]);
  assert.deepEqual([a.kind, b.kind], ['DONE', 'DONE'], JSON.stringify([a, b]));
  assert.deepEqual(events(eventsFile), ['B-enter', 'B-exit', 'A-enter', 'A-exit']);
});

for (const [first, second] of [['old', 'new'], ['new', 'old']]) {
  test(`mixed runtimes: the live holder of the ${first} runtime is waited on by the ${second} one`, async (t) => {
    const { dir, file } = lockFile();
    const eventsFile = path.join(dir, 'events');
    const goFile = path.join(dir, 'go');
    const holding = actor(t, { runtime: first, mode: 'hold', file, label: first, eventsFile, goFile });
    await until(() => events(eventsFile).includes(`${first}-enter`));
    const waiting = actor(t, { runtime: second, mode: 'hold', file, label: second, eventsFile });
    await sleep(1500);
    fs.writeFileSync(goFile, 'go');
    const outs = await Promise.all([holding.done, waiting.done]);
    assert.deepEqual(outs.map((o) => o.kind), ['DONE', 'DONE'], JSON.stringify(outs));
    assert.deepEqual(events(eventsFile), [`${first}-enter`, `${first}-exit`, `${second}-enter`, `${second}-exit`]);
  });
}

test('mixed runtimes: an old runtime\'s holder killed while holding is reclaimed at once by a new one', async (t) => {
  const { dir, file, lockDir } = lockFile();
  const eventsFile = path.join(dir, 'events');
  const holding = actor(t, { runtime: 'old', mode: 'hold', file, label: 'old', eventsFile, goFile: path.join(dir, 'never') });
  await until(() => events(eventsFile).includes('old-enter'));
  assert.deepEqual(fs.readdirSync(lockDir), ['owner.json']);
  holding.child.kill('SIGKILL');
  await holding.done;
  const started = Date.now();
  const taking = actor(t, { runtime: 'new', mode: 'hold', file, label: 'new', eventsFile });
  assert.equal((await taking.done).kind, 'DONE');
  assert.ok(Date.now() - started < 5000, 'the dead old holder\'s lock was waited on');
  assert.deepEqual(events(eventsFile), ['old-enter', 'new-enter', 'new-exit']);
  assert.equal(fs.existsSync(lockDir), false);
});

test('mixed runtimes (accepted cost): an old runtime moves a new holder\'s lock aside after 10 s, and the new holder writes nothing', async (t) => {
  const { dir, file } = lockFile();
  const eventsFile = path.join(dir, 'events');
  const newer = actor(t, { runtime: 'new', mode: 'write', file, label: 'new', eventsFile, pauseMs: 11_500 });
  await newer.paused;
  const older = actor(t, { runtime: 'old', mode: 'write', file, label: 'old', eventsFile });
  const [newOut, oldOut] = await Promise.all([newer.done, older.done]);
  assert.equal(oldOut.kind, 'DONE', JSON.stringify(oldOut));
  assert.deepEqual([newOut.kind, newOut.code], ['THREW', 'lock-lost'], JSON.stringify(newOut));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).writes, ['old']);
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('slot.json.lock.stale-')), 'the old runtime leaves its aside directory');
});
