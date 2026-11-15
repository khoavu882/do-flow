'use strict';
// The run lock's claims (src/state/run-lock.ts): a claim, a lock and a moved-aside file are removed only
// when the bytes moved are the ones judged or the remover's own. Each case forces one interleaving
// through an injected fsImpl (a hook runs the other runs' steps at the exact call), and asserts that no
// run deletes or overwrites a file another run owns. Leaked claims and aside files are swept.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { acquireRunLock, RunLockTimeoutError, RunLockLostError, runLockPath } = require('../../src/state/run-lock.ts');
const { tempDir } = require('../helper/tmp.ts');

const ELEVEN_MINUTES_AGO = () => (Date.now() - 11 * 60 * 1000) / 1000;
const SIXTY_SECONDS_AGO = () => (Date.now() - 60 * 1000) / 1000;

const children: any = [];
after(() => {
  for (const child of children) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
});

const scopeRoot = (t: any) => tempDir(t, 'doflow-run-lock-claims-');
const stateDir = (root: any) => path.join(root, '.doflow', 'state');
const target = (root: any) => ({ scopeRoot: root, scope: 'project', command: 'install' });
const claimFor = (root: any, key: string) => path.join(stateDir(root), `run.lock.claim.${key}`);
const listState = (root: any) => fs.readdirSync(stateDir(root)).sort();
const tokenAt = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')).token;
const asides = (root: any) => listState(root).filter((name: string) => name.startsWith('run.lock.claim.aside.'));

function deadPid() { return spawnSync(process.execPath, ['-e', '']).pid; }

function liveChild() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });
  // A failed spawn (EAGAIN, EMFILE under load) emits 'error' with no pid: fail the case that asked for it, with the reason.
  let spawnError: any = null;
  child.on('error', (error: any) => { spawnError = error; });
  if (typeof child.pid !== 'number') throw new Error(`could not start a child process: ${spawnError?.message ?? 'no pid'}`);
  children.push(child);
  return child;
}

/** A stale lock instance: its process is gone, on this host. */
function plantStaleLock(root: any, overrides: any = {}) {
  const token = 'a'.repeat(32);
  fs.mkdirSync(stateDir(root), { recursive: true });
  const file = runLockPath(root);
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1, token, pid: deadPid(), hostname: os.hostname(), command: 'update', scope: 'project',
    scopeRoot: '/somewhere', startedAt: '2026-10-08T00:00:00.000Z', doflowVersion: '1.20.0', ...overrides,
  })}\n`);
  return { file, token };
}

function writeClaim(file: string, { token, pid, hostname = os.hostname(), mtime, processStart }: any) {
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, token, pid, hostname, ...(processStart ? { processStart } : {}), at: new Date().toISOString(), target: 'x' })}\n`);
  if (mtime !== undefined) fs.utimesSync(file, mtime, mtime);
}

/** Runs `action` once, the first time `fsImpl[op]` is called with a path accepted by `when`, before the call goes through. */
function hooked(overrides: Record<string, { when: (...args: any[]) => boolean, action: () => void }>) {
  const fired = new Set<string>();
  const fsImpl: any = { ...fs };
  for (const [op, { when, action }] of Object.entries(overrides)) {
    fsImpl[op] = (...args: any[]) => {
      if (!fired.has(op) && when(...args)) { fired.add(op); action(); }
      return (fs as any)[op](...args);
    };
  }
  return { fsImpl, fired };
}

test('an orphan claim displaced by a fresh one is never deleted: both claims survive and the run backs off', (t) => {
  const root = scopeRoot(t);
  const stale = plantStaleLock(root);
  const claim = claimFor(root, stale.token);
  const c1 = liveChild();
  const c3 = liveChild();
  writeClaim(claim, { token: 'c0'.repeat(16), pid: deadPid() });
  const { fsImpl, fired } = hooked({
    // The run judged C0 orphan; before it moves the claim aside, another run removes C0 and creates C1.
    renameSync: { when: (from: any) => from === claim, action: () => { fs.unlinkSync(claim); writeClaim(claim, { token: '11'.repeat(16), pid: c1.pid }); } },
    // C1 is aside and the claim name is free: a third run creates C3 before the link-back.
    linkSync: { when: (from: any, to: any) => to === claim && String(from).includes('run.lock.claim.aside.'), action: () => { writeClaim(claim, { token: '33'.repeat(16), pid: c3.pid }); } },
  });
  assert.throws(() => acquireRunLock(target(root), { fsImpl, waitMs: 300, pollMs: 20, log: () => {} }), RunLockTimeoutError);
  assert.equal(fired.size, 2);
  assert.equal(tokenAt(claim), '33'.repeat(16));
  const kept = asides(root).map((name: string) => tokenAt(path.join(stateDir(root), name)));
  assert.deepEqual(kept, ['11'.repeat(16)]);
  assert.equal(tokenAt(runLockPath(root)), stale.token);
});

test('an orphan claim replaced by a live one while the run judged it is put back, and the run waits', (t) => {
  const root = scopeRoot(t);
  const stale = plantStaleLock(root);
  const claim = claimFor(root, stale.token);
  const live = liveChild();
  writeClaim(claim, { token: 'c0'.repeat(16), pid: deadPid() });
  const { fsImpl, fired } = hooked({
    renameSync: { when: (from: any) => from === claim, action: () => { fs.unlinkSync(claim); writeClaim(claim, { token: '11'.repeat(16), pid: live.pid }); } },
  });
  assert.throws(() => acquireRunLock(target(root), { fsImpl, waitMs: 300, pollMs: 20, log: () => {} }), RunLockTimeoutError);
  assert.equal(fired.size, 1);
  assert.equal(tokenAt(claim), '11'.repeat(16));
  assert.deepEqual(asides(root), []);
  assert.equal(tokenAt(runLockPath(root)), stale.token);
});

test('a claim another run took over while this run held it is not deleted, and the lock is not removed under it', (t) => {
  const root = scopeRoot(t);
  const stale = plantStaleLock(root);
  const claim = claimFor(root, stale.token);
  const live = liveChild();
  let opens = 0;
  const { fsImpl, fired } = hooked({
    // Opens of run.lock: the first is the acquisition's read, the second is the re-read under the claim.
    openSync: { when: (file: any) => file === runLockPath(root) && (opens += 1) === 2, action: () => { fs.unlinkSync(claim); writeClaim(claim, { token: '22'.repeat(16), pid: live.pid }); } },
  });
  assert.throws(() => acquireRunLock(target(root), { fsImpl, waitMs: 300, pollMs: 20, log: () => {} }), RunLockTimeoutError);
  assert.equal(fired.size, 1);
  assert.equal(tokenAt(runLockPath(root)), stale.token);
  assert.equal(tokenAt(claim), '22'.repeat(16));
});

test('a takeover that loses its claim after the lock is cleared leaves the other run\'s claim in place', (t) => {
  const root = scopeRoot(t);
  const stale = plantStaleLock(root);
  const claim = claimFor(root, stale.token);
  const live = liveChild();
  const { fsImpl, fired } = hooked({
    renameSync: { when: (from: any) => from === runLockPath(root), action: () => { fs.unlinkSync(claim); writeClaim(claim, { token: '22'.repeat(16), pid: live.pid }); } },
  });
  const hold = acquireRunLock(target(root), { fsImpl, log: () => {} });
  try {
    assert.equal(fired.size, 1);
    assert.equal(tokenAt(claim), '22'.repeat(16));
  } finally {
    hold.release();
  }
});

test('a live claimant on this host keeps its claim at any age', (t) => {
  const root = scopeRoot(t);
  const stale = plantStaleLock(root);
  const claim = claimFor(root, stale.token);
  writeClaim(claim, { token: '11'.repeat(16), pid: liveChild().pid, mtime: SIXTY_SECONDS_AGO() });
  assert.throws(() => acquireRunLock(target(root), { waitMs: 300, pollMs: 20, log: () => {} }), RunLockTimeoutError);
  assert.equal(tokenAt(claim), '11'.repeat(16));
  assert.equal(tokenAt(runLockPath(root)), stale.token);
});

test('a live pid with no recorded start time is told from a reused one by age: kept below staleMs, orphan above it', (t) => {
  const live = liveChild();
  for (const [mtime, cleared] of [[SIXTY_SECONDS_AGO(), false], [ELEVEN_MINUTES_AGO(), true]] as const) {
    const root = scopeRoot(t);
    const stale = plantStaleLock(root);
    const claim = claimFor(root, stale.token);
    writeClaim(claim, { token: '11'.repeat(16), pid: live.pid, mtime });
    if (!cleared) {
      assert.throws(() => acquireRunLock(target(root), { waitMs: 200, pollMs: 20, log: () => {} }), RunLockTimeoutError);
      assert.equal(tokenAt(claim), '11'.repeat(16));
    } else {
      const hold = acquireRunLock(target(root), { log: () => {} });
      hold.release();
    }
  }
});

test('a live claimant whose start time matches keeps its claim at any age; a different start time is a reused pid', (t) => {
  const live = liveChild();
  const stable = { startTimeStable: () => true, procStart: () => 'Sat Nov 14 10:00:00 2026', log: () => {} };
  const root = scopeRoot(t);
  const stale = plantStaleLock(root);
  const claim = claimFor(root, stale.token);
  writeClaim(claim, { token: '11'.repeat(16), pid: live.pid, processStart: 'Sat Nov 14 10:00:00 2026', mtime: ELEVEN_MINUTES_AGO() - 3600 });
  assert.throws(() => acquireRunLock(target(root), { ...stable, waitMs: 200, pollMs: 20 }), RunLockTimeoutError);
  assert.equal(tokenAt(claim), '11'.repeat(16));
  writeClaim(claim, { token: '11'.repeat(16), pid: live.pid, processStart: 'Thu Jan  1 00:00:00 1970' });
  acquireRunLock(target(root), { ...stable, waitMs: 2000 }).release();
});

test('where start times are not stable a recorded start is ignored and a live claimant takes the age path', (t) => {
  const live = liveChild();
  const unstable = { startTimeStable: () => false, procStart: () => 'Sat Nov 14 10:00:00 2026', log: () => {} };
  const root = scopeRoot(t);
  const stale = plantStaleLock(root);
  const claim = claimFor(root, stale.token);
  writeClaim(claim, { token: '11'.repeat(16), pid: live.pid, processStart: 'Sat Nov 14 10:00:00 2026', mtime: SIXTY_SECONDS_AGO() });
  assert.throws(() => acquireRunLock(target(root), { ...unstable, waitMs: 200, pollMs: 20 }), RunLockTimeoutError);
  writeClaim(claim, { token: '11'.repeat(16), pid: live.pid, processStart: 'Sat Nov 14 10:00:00 2026', mtime: ELEVEN_MINUTES_AGO() });
  acquireRunLock(target(root), { ...unstable, waitMs: 2000 }).release();
});

test('where liveness cannot be asked, age decides: an old claim from another host or with no owner is cleared, a young one waited for', (t) => {
  for (const [name, plantClaim] of [
    ['another host', (file: string, mtime: number) => writeClaim(file, { token: '11'.repeat(16), pid: process.pid, hostname: 'elsewhere.example', mtime })],
    ['no owner', (file: string, mtime: number) => { fs.writeFileSync(file, ''); fs.utimesSync(file, mtime, mtime); }],
  ] as const) {
    const root = scopeRoot(t);
    const stale = plantStaleLock(root);
    const claim = claimFor(root, stale.token);
    plantClaim(claim, Date.now() / 1000);
    assert.throws(() => acquireRunLock(target(root), { waitMs: 200, pollMs: 20, log: () => {} }), RunLockTimeoutError, `young claim, ${name}`);
    plantClaim(claim, SIXTY_SECONDS_AGO());
    const hold = acquireRunLock(target(root), { log: () => {} });
    try {
      assert.equal(hold.cleared.length, 1, `old claim, ${name}`);
      assert.deepEqual(listState(root), ['run.lock']);
    } finally {
      hold.release();
    }
  }
});

test('a holder stalled in release until its lock was cleared and re-taken leaves the new lock in place', (t) => {
  const root = scopeRoot(t);
  const alias = path.join(scopeRoot(t), 'alias');
  fs.symlinkSync(root, alias);
  const lock = runLockPath(root);
  let reclaimer: any = null;
  const { fsImpl, fired } = hooked({
    // Between the holder's read of its lock and the step that removes it, another run (another host
    // by name, its clock past claimStaleMs) judges the holder's claim orphan and takes the lock.
    renameSync: { when: (from: any) => from === lock, action: () => { reclaimer = acquireRunLock(target(alias), { hostname: 'other', now: () => Date.now() + 31_000, waitMs: 2000, pollMs: 10, log: () => {} }); } },
    unlinkSync: { when: (file: any) => file === lock, action: () => { reclaimer = acquireRunLock(target(alias), { hostname: 'other', now: () => Date.now() + 31_000, waitMs: 2000, pollMs: 10, log: () => {} }); } },
  });
  const holder = acquireRunLock(target(root), { fsImpl, log: () => {} });
  fs.utimesSync(lock, ELEVEN_MINUTES_AGO(), ELEVEN_MINUTES_AGO());
  try {
    holder.release();
    assert.equal(fired.size >= 1, true);
    assert.equal(tokenAt(lock), reclaimer.token);
    reclaimer.checkpoint();
  } finally {
    reclaimer?.release();
  }
});

test('a reclaimer stalled between its re-read and its removal does not remove the lock a second reclaimer took', (t) => {
  const root = scopeRoot(t);
  const alias = path.join(scopeRoot(t), 'alias');
  fs.symlinkSync(root, alias);
  const stale = plantStaleLock(root, { hostname: 'elsewhere.example' });
  fs.utimesSync(stale.file, ELEVEN_MINUTES_AGO(), ELEVEN_MINUTES_AGO());
  let second: any = null;
  const takeSecond = () => { second = acquireRunLock(target(alias), { hostname: 'hostB', now: () => Date.now() + 31_000, waitMs: 2000, pollMs: 10, log: () => {} }); };
  const { fsImpl, fired } = hooked({
    renameSync: { when: (from: any) => from === runLockPath(root), action: takeSecond },
    unlinkSync: { when: (file: any) => file === runLockPath(root), action: takeSecond },
  });
  try {
    assert.throws(() => acquireRunLock(target(root), { hostname: 'hostA', fsImpl, waitMs: 300, pollMs: 20, log: () => {} }), RunLockTimeoutError);
    assert.equal(fired.size >= 1, true);
    assert.equal(tokenAt(runLockPath(root)), second.token);
    second.checkpoint();
  } finally {
    second?.release();
  }
});

test('a checkpoint stalled until its lock was replaced does not renew the replacement, and the next one reports the loss', (t) => {
  const root = scopeRoot(t);
  const lock = runLockPath(root);
  const other = 'dd'.repeat(16);
  const replace = () => {
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, `${JSON.stringify({ version: 1, token: other, pid: process.pid, hostname: os.hostname(), command: 'x' })}\n`);
    fs.utimesSync(lock, ELEVEN_MINUTES_AGO(), ELEVEN_MINUTES_AGO());
  };
  // The lock is replaced just before the renewal, whether the implementation renews by path or by descriptor.
  const { fsImpl, fired } = hooked({
    utimesSync: { when: (file: any) => file === lock, action: replace },
    futimesSync: { when: () => true, action: replace },
  });
  const hold = acquireRunLock(target(root), { fsImpl, log: () => {} });
  try {
    hold.checkpoint();
    assert.equal(fired.size, 1);
    assert.equal(tokenAt(lock), other);
    assert.ok(Date.now() - fs.statSync(lock).mtimeMs > 10 * 60 * 1000, 'the replacement lock was renewed');
    assert.throws(() => hold.checkpoint(), RunLockLostError);
  } finally {
    hold.release();
  }
  assert.equal(tokenAt(lock), other);
});

test('the sweep removes a claim whose lock is gone and whose claimant is gone, and keeps a live claimant\'s', (t) => {
  const root = scopeRoot(t);
  fs.mkdirSync(stateDir(root), { recursive: true });
  const dead = claimFor(root, 'e'.repeat(32));
  const live = claimFor(root, 'f'.repeat(32));
  writeClaim(dead, { token: '11'.repeat(16), pid: deadPid() });
  writeClaim(live, { token: '22'.repeat(16), pid: liveChild().pid });
  const hold = acquireRunLock(target(root), { log: () => {} });
  try {
    assert.deepEqual(listState(root), ['run.lock', path.basename(live)]);
  } finally {
    hold.release();
  }
  fs.unlinkSync(live);
  assert.deepEqual(listState(root), []);
});

test('the sweep removes moved-aside files older than the stale age, and keeps a recent one', (t) => {
  const root = scopeRoot(t);
  fs.mkdirSync(stateDir(root), { recursive: true });
  const old = `run.lock.claim.aside.4242.beef.${Date.now() - 11 * 60 * 1000}`;
  const recent = `run.lock.claim.aside.4242.f00d.${Date.now()}`;
  fs.writeFileSync(path.join(stateDir(root), old), '{}\n');
  fs.writeFileSync(path.join(stateDir(root), recent), '{}\n');
  const hold = acquireRunLock(target(root), { log: () => {} });
  try {
    assert.deepEqual(listState(root), ['run.lock', recent]);
  } finally {
    hold.release();
  }
});

test('the sweep removes moved-aside files of the v2.5.0 shape by their mtime', (t) => {
  const root = scopeRoot(t);
  fs.mkdirSync(stateDir(root), { recursive: true });
  const old = `run.lock.claim.${'a'.repeat(32)}.${'b'.repeat(32)}.gone`;
  const recent = `run.lock.claim.${'c'.repeat(32)}.${'d'.repeat(32)}.gone`;
  fs.writeFileSync(path.join(stateDir(root), old), '{}\n');
  fs.utimesSync(path.join(stateDir(root), old), ELEVEN_MINUTES_AGO(), ELEVEN_MINUTES_AGO());
  fs.writeFileSync(path.join(stateDir(root), recent), '{}\n');
  const hold = acquireRunLock(target(root), { log: () => {} });
  try {
    assert.deepEqual(listState(root), ['run.lock', recent]);
  } finally {
    hold.release();
  }
});
