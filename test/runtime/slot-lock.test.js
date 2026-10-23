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
const { updateTaskState } = require('../../src/runtime/task-state.ts');
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
  // quietMs 0: these tests are about the protocol, not the wait after a risky reclaim (tested below).
  return { pid: process.pid, procStart: () => 'test-start', alive: (proc) => proc.pid !== DEAD, fsImpl: fs, quietMs: 0, ...extra };
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

test('an older runtime\'s lock whose owner is dead is reclaimed in place, and held once it was quiet 10 s', () => {
  const { file, lockDir } = lockFile();
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: DEAD, start: null }));
  // While it waits, the lock is kept young, so an older runtime never judges it stale by its age (C-2).
  let oldest = 0;
  const watchFs = hookedFs({
    existsSync: (original, ...args) => {
      try { oldest = Math.max(oldest, Date.now() - fs.statSync(lockDir).mtimeMs); } catch { /* not there */ }
      return original(...args);
    },
  });
  const started = Date.now();
  const release = acquireSlotLock(watchFs, file, { pid: process.pid, procStart, alive, fsImpl: watchFs });
  const took = Date.now() - started;
  assert.ok(took >= 10_000 && took < 15_000, `held after ${took} ms`);
  assert.ok(oldest < 10_000, `the lock was ${oldest} ms old while it waited`);
  assert.ok(Date.now() - fs.statSync(lockDir).mtimeMs < 1000, 'the lock was handed over old');
  const entries = fs.readdirSync(lockDir);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^owner-\d+-[0-9a-f]+-[0-9a-f]{12}$/);
  release();
  assert.equal(fs.existsSync(lockDir), false);
});

test('an entry names its owner\'s pid and start, so a reused pid is judged dead without waiting out the 10 s age', () => {
  const { file, lockDir } = lockFile();
  // quietMs 0: the judgement is under test; the quiet hold after every reclaim is tested above.
  const deps = { pid: process.pid, procStart, alive, fsImpl: fs, quietMs: 0 };
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
  assert.ok(Date.now() - started < 2000, 'an entry of a reused pid was judged by the 10 s age rule');
  again();
});

// ── Older runtimes judging the dead token this process reclaims (review C-1, C-2) ─────────────

const liveToken = () => JSON.stringify({ pid: process.pid, start: procStart(process.pid) });

test('C-1: a dead token is not unlinked once an older runtime moved the lock aside and put its own token in a new one', () => {
  const { file, lockDir } = lockFile();
  fs.mkdirSync(lockDir);
  const token = path.join(lockDir, 'owner.json');
  fs.writeFileSync(token, JSON.stringify({ pid: DEAD, start: null }));
  let entered = false;
  let swapped = false;
  let released = false;
  let tokenKept = true;
  let looks = 0;
  const reclaimerFs = hookedFs({
    mkdirSync: (original, target, ...rest) => {
      const result = original(target, ...rest);
      if (target.startsWith(lockDir + path.sep)) entered = true;
      return result;
    },
    statSync: (original, target, ...rest) => {
      const result = original(target, ...rest);
      if (entered && !swapped && target === lockDir) {
        // Right after this process's identity check: an older waiter that judged the same dead token
        // moves the lock aside and makes its own, with a live token (the 115 acquire).
        swapped = true;
        fs.renameSync(lockDir, `${lockDir}.stale-older`);
        fs.mkdirSync(lockDir);
        fs.writeFileSync(token, liveToken());
      }
      return result;
    },
    readdirSync: (original, ...args) => {
      if (swapped && !released) {
        if (!fs.existsSync(token) || fs.readFileSync(token, 'utf8') !== liveToken()) tokenKept = false;
        if ((looks += 1) === 5) { fs.unlinkSync(token); fs.rmdirSync(lockDir); released = true; } // its release
      }
      return original(...args);
    },
  });
  const release = acquireSlotLock(reclaimerFs, file, { pid: process.pid, procStart, alive, fsImpl: reclaimerFs, quietMs: 0 });
  assert.equal(swapped, true);
  assert.equal(tokenKept, true, 'the older runtime\'s live token was removed');
  assert.equal(released, true, 'the lock was held before the older runtime released it');
  release();
});

// N-4: each half of the C-1 check on its own. In the moves above both halves see the change; here
// each case changes only what one half looks at (the token half is defence in depth: an older runtime
// writes `owner.json` only into a lock it made).
function tokenRace(t, change) {
  const { file, lockDir } = lockFile();
  fs.mkdirSync(lockDir);
  const token = path.join(lockDir, 'owner.json');
  const dead = JSON.stringify({ pid: DEAD, start: null });
  fs.writeFileSync(token, dead);
  const state = { entered: false, changed: false, rejudged: false, wrongUnlink: false, looks: 0, released: false };
  const reclaimerFs = hookedFs({
    mkdirSync: (original, target, ...rest) => {
      const result = original(target, ...rest);
      if (target.startsWith(lockDir + path.sep)) state.entered = true;
      return result;
    },
    statSync: (original, target, ...rest) => {
      const result = original(target, ...rest);
      if (state.entered && !state.changed && target === lockDir) { state.changed = true; change({ lockDir, token, dead }); }
      return result;
    },
    readdirSync: (original, ...args) => {
      if (state.changed) { state.rejudged = true; state.looks += 1; }
      if (state.changed && !state.released && state.looks === 5 && fs.existsSync(token) && fs.readFileSync(token, 'utf8') !== dead) {
        fs.unlinkSync(token); // the live owner's release (the 115 release: token, then the directory)
        try { fs.rmdirSync(lockDir); } catch { /* another entry is in it */ }
        state.released = true;
      }
      return original(...args);
    },
    unlinkSync: (original, target) => {
      if (target === token && state.changed && (!state.rejudged || fs.readFileSync(token, 'utf8') !== dead)) state.wrongUnlink = true;
      return original(target);
    },
  });
  const release = acquireSlotLock(reclaimerFs, file, { pid: process.pid, procStart, alive, fsImpl: reclaimerFs, quietMs: 0 });
  release();
  return state;
}

test('N-4: the C-1 check refuses a token in a lock that no longer holds this process\'s entry, even when the token reads the same', (t) => {
  const state = tokenRace(t, ({ lockDir, token, dead }) => {
    fs.renameSync(lockDir, `${lockDir}.stale-older`);
    fs.mkdirSync(lockDir);
    fs.writeFileSync(token, dead);
  });
  assert.equal(state.changed, true);
  assert.equal(state.wrongUnlink, false, 'a token was unlinked in a lock this process had not judged');
});

test('N-4: the C-1 check refuses a token that changed in the lock that still holds this process\'s entry', (t) => {
  const state = tokenRace(t, ({ token }) => { fs.writeFileSync(token, liveToken()); });
  assert.equal(state.changed, true);
  assert.equal(state.wrongUnlink, false, 'a live token was unlinked');
  assert.equal(state.released, true);
});

for (const [seed, prepare] of [
  ['the dead token', (lockDir) => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: DEAD, start: null }));
  }],
  ['a lock older than 10 s', (lockDir) => { fs.mkdirSync(lockDir); age(lockDir, 60); }],
]) {
  test(`C-2: an older runtime that judged ${seed} before this reclaim moves the lock while nobody holds it, and both writes are kept`, () => {
    const { file, lockDir } = lockFile();
    prepare(lockDir);
    const token = path.join(lockDir, 'owner.json');
    let reclaimedAt = 0;
    let moved = false;
    let ageAtCommit = null;
    // The older waiter judged the lock before this process reclaimed it; its move lands at the worst
    // moment within 10 s of that: just before this process commits, or at its last look before 10 s.
    const olderMoves = () => {
      moved = true;
      fs.renameSync(lockDir, `${lockDir}.stale-older`);
      fs.mkdirSync(lockDir);
      fs.writeFileSync(token, liveToken());
      let disk = null;
      try { disk = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no file yet */ }
      fs.writeFileSync(file, JSON.stringify({ writes: [...(disk?.writes || []), 'older'] }));
      fs.unlinkSync(token);
      fs.rmdirSync(lockDir);
    };
    const hooks = {};
    for (const name of ['statSync', 'existsSync', 'readdirSync', 'readFileSync', 'writeFileSync', 'mkdirSync', 'rmdirSync', 'utimesSync', 'renameSync', 'unlinkSync']) {
      hooks[name] = (original, ...args) => {
        const committing = name === 'renameSync' && args[1] === file;
        if (committing && moved) ageAtCommit = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (reclaimedAt && !moved && (committing || Date.now() - reclaimedAt >= 9_000)) olderMoves();
        const result = original(...args);
        if (name === 'mkdirSync' && !reclaimedAt && args[0].startsWith(lockDir + path.sep)) reclaimedAt = Date.now();
        return result;
      };
    }
    const reclaimerFs = hookedFs(hooks);
    const deps = { pid: process.pid, procStart, alive, fsImpl: reclaimerFs };
    updateTaskState({
      fsImpl: reclaimerFs,
      file,
      acquire: (lockFs, target) => acquireSlotLock(lockFs, target, deps),
      build: (disk) => ({ writes: [...(disk?.writes || []), 'current'] }),
    });
    assert.equal(moved, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).writes, ['older', 'current']);
    assert.ok(ageAtCommit !== null && ageAtCommit < 10_000, `the lock looked ${ageAtCommit} ms old to an older runtime at commit`);
  });
}

// ── Liveness (review C-4, C-5) ───────────────────────────────────────────────────────────────

test('C-4: a file in a slot lock keeps it locked and the error names it', () => {
  const { file, lockDir } = lockFile();
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, '.DS_Store'), 'x');
  age(lockDir, 60);
  assert.throws(() => acquireSlotLock(fs, file, { pid: process.pid, procStart, alive, fsImpl: fs, lockBudgetMs: 300 }),
    (error) => /Could not lock .* after 0\.3s/.test(error.message) && error.message.includes("It holds '.DS_Store'"));
  assert.deepEqual(fs.readdirSync(lockDir), ['.DS_Store']);
});

test('C-5: a queued process reclaims the lock when the holder ahead of it dies, without waiting out its budget', () => {
  const { file, lockDir } = lockFile();
  const holderPid = 99_999_998; // sorts after this process's pid; no process has it, so it is dead once looked at
  fs.mkdirSync(lockDir);
  fs.mkdirSync(path.join(lockDir, `owner-${DEAD}-x-0123456789ab`));
  let holder = null;
  const waiterFs = hookedFs({
    mkdirSync: (original, target, ...rest) => {
      if (!holder && target.startsWith(lockDir + path.sep)) {
        holder = acquireSlotLock(fs, file, { pid: holderPid, procStart: () => null, alive, fsImpl: fs, quietMs: 0 });
      }
      return original(target, ...rest);
    },
  });
  const started = Date.now();
  // quietMs 0: the re-judgement is under test; the quiet hold after every reclaim is tested above.
  const release = acquireSlotLock(waiterFs, file, { pid: process.pid, procStart, alive, fsImpl: waiterFs, quietMs: 0 });
  assert.equal(typeof holder, 'function');
  assert.ok(Date.now() - started < 2000, `held after ${Date.now() - started} ms`);
  assert.equal(release.held(), true);
  release();
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
  const stopped = actor(t, { runtime: 'new', mode: 'hold', file, label: 'A', eventsFile, pauseAtAct: true, quietMs: 0 });
  await stopped.paused;
  stopped.child.kill('SIGSTOP');
  const other = actor(t, { runtime: 'new', mode: 'hold', file, label: 'B', eventsFile, goFile, quietMs: 0 });
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

test('mixed runtimes: an old runtime\'s holder killed while holding is reclaimed by a new one after the 10 s quiet wait', async (t) => {
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
  const took = Date.now() - started;
  assert.ok(took >= 10_000 && took < 16_000, `the dead old holder's lock was held after ${took} ms`);
  assert.deepEqual(events(eventsFile), ['old-enter', 'new-enter', 'new-exit']);
  assert.equal(fs.existsSync(lockDir), false);
});

test('N-1: a current process killed in its quiet hold hands on a lock whose next holder quiets too, so an older runtime\'s pending move keeps both writes', async (t) => {
  const { dir, file, lockDir } = lockFile();
  const eventsFile = path.join(dir, 'events');
  const older = actor(t, { runtime: 'old', mode: 'hold', file, label: 'O', eventsFile, goFile: path.join(dir, 'never') });
  await until(() => events(eventsFile).includes('O-enter'));
  older.child.kill('SIGKILL');
  await older.done;
  // W judged the dead token and is preempted 3 s before its move.
  const waiting = actor(t, { runtime: 'old', mode: 'write', file, label: 'W', eventsFile, pauseAtAct: true, pauseAtActMs: 3000 });
  await waiting.paused;
  // A reclaims in place and is killed 600 ms into its quiet hold.
  const quietOne = actor(t, { runtime: 'new', mode: 'hold', file, label: 'A', eventsFile, goFile: path.join(dir, 'never') });
  await until(() => { try { return fs.readdirSync(lockDir).some((name) => name.startsWith(`owner-${quietOne.child.pid}-`)); } catch { return false; } });
  await sleep(600);
  quietOne.child.kill('SIGKILL');
  await quietOne.done;
  // C reclaims A's dead entry and would be preempted 3 s between its pre-write check and its rename.
  const current = actor(t, { runtime: 'new', mode: 'write', file, label: 'C', eventsFile, pauseBeforeCommitMs: 3000 });
  const [w, c] = await Promise.all([waiting.done, current.done]);
  assert.deepEqual([w.kind, c.kind], ['DONE', 'DONE'], JSON.stringify([w, c]));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).writes, ['W', 'C']);
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
