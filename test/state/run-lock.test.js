'use strict';
// The scope run lock (src/state/run-lock.js): owner record, stale rule, takeover and release under
// claims, checkpoint, reentrancy, and exclusion between real processes. Each case uses its own
// temporary scope root; timing paths use small injected limits, exclusion uses child processes.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  acquireRunLock, RunLockTimeoutError, RunLockLostError, runLockPath, formatRunLockMessage,
} = require('../../src/state/run-lock');

const MODULE = path.resolve(__dirname, '../../src/state/run-lock.js');
const PKG_VERSION = require('../../package.json').version;
const ELEVEN_MINUTES_AGO = () => (Date.now() - 11 * 60 * 1000) / 1000;
const NO_KILL_SEMANTICS = process.platform === 'win32' || process.getuid?.() === 0;

const roots = [];
const children = [];
after(() => {
  for (const child of children) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function scopeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-run-lock-'));
  roots.push(root);
  return root;
}

const stateDir = (root) => path.join(root, '.doflow', 'state');
const target = (root) => ({ scopeRoot: root, scope: 'project', command: 'install' });

function plant(root, content, { mtime } = {}) {
  fs.mkdirSync(stateDir(root), { recursive: true });
  const file = runLockPath(root);
  fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content)}\n`);
  if (mtime !== undefined) fs.utimesSync(file, mtime, mtime);
  return file;
}

function record({ pid = deadPid(), ...overrides } = {}) {
  return {
    version: 1, token: 'a'.repeat(32), pid, hostname: os.hostname(), command: 'update',
    scope: 'project', scopeRoot: '/somewhere', startedAt: '2026-10-08T00:00:00.000Z', doflowVersion: '1.20.0',
    ...overrides,
  };
}

/** A pid that existed and has exited. */
function deadPid() {
  const result = spawnSync(process.execPath, ['-e', '']);
  return result.pid;
}

function liveChild() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

function collector() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

const listState = (root) => fs.readdirSync(stateDir(root)).sort();

test('acquire writes the owner record to run.lock and leaves no temp file', () => {
  const root = scopeRoot();
  const hold = acquireRunLock(target(root));
  try {
    const raw = fs.readFileSync(runLockPath(root), 'utf8');
    assert.ok(raw.endsWith('}\n'));
    const owner = JSON.parse(raw);
    assert.equal(owner.version, 1);
    assert.match(owner.token, /^[0-9a-f]{32}$/);
    assert.equal(owner.token, hold.token);
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.hostname, os.hostname());
    assert.equal(owner.command, 'install');
    assert.equal(owner.scope, 'project');
    assert.equal(owner.scopeRoot, path.resolve(root));
    assert.equal(new Date(owner.startedAt).toISOString(), owner.startedAt);
    assert.equal(owner.doflowVersion, PKG_VERSION);
    assert.deepEqual(listState(root), ['run.lock']);
    assert.equal(hold.lockPath, runLockPath(root));
    assert.deepEqual(hold.cleared, []);
  } finally {
    hold.release();
  }
});

test('release removes the lock and the directories acquisition created', () => {
  const root = scopeRoot();
  acquireRunLock(target(root)).release();
  assert.equal(fs.existsSync(path.join(root, '.doflow')), false);
});

test('release leaves a .doflow/state that existed before acquisition', () => {
  const root = scopeRoot();
  fs.mkdirSync(stateDir(root), { recursive: true });
  acquireRunLock(target(root)).release();
  assert.deepEqual(listState(root), []);
});

test('a live holder on this host makes the run wait, say so once, and time out without touching anything', () => {
  const root = scopeRoot();
  const child = liveChild();
  const file = plant(root, record({ pid: child.pid }));
  const before = fs.readFileSync(file);
  const { lines, log } = collector();
  assert.throws(
    () => acquireRunLock(target(root), { waitMs: 400, pollMs: 50, log }),
    (err) => err instanceof RunLockTimeoutError && err.message.includes(`pid ${child.pid}, update`)
      && err.message.startsWith('[ERROR] Another DoFlow run in project ') && err.holder.pid === child.pid,
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[INFO\] {2}Waiting for another DoFlow run in project .+ \(pid \d+, update, started .+\); up to 0\.4s$/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(listState(root), ['run.lock']);
});

test('a lock whose process is not running is cleared with that reason', () => {
  const root = scopeRoot();
  const pid = deadPid();
  plant(root, record({ pid }));
  const { lines, log } = collector();
  const hold = acquireRunLock(target(root), { log });
  try {
    assert.deepEqual(hold.cleared, [{ pid, command: 'update', startedAt: '2026-10-08T00:00:00.000Z', reason: 'not-running' }]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[WARN\] {2}Cleared a stale DoFlow run lock in project .+ \(pid \d+, update, started .+\): that process is not running$/);
    assert.equal(JSON.parse(fs.readFileSync(runLockPath(root), 'utf8')).token, hold.token);
    assert.deepEqual(listState(root), ['run.lock']);
  } finally {
    hold.release();
  }
});

test("a lock with this process's pid and another token was left by an earlier process and is cleared", () => {
  const root = scopeRoot();
  plant(root, record({ pid: process.pid }));
  const hold = acquireRunLock(target(root), { log: () => {} });
  try {
    assert.equal(hold.cleared[0].reason, 'not-running');
  } finally {
    hold.release();
  }
});

test('a fresh lock from another host is waited for', () => {
  const root = scopeRoot();
  plant(root, record({ hostname: 'elsewhere.example' }));
  assert.throws(() => acquireRunLock(target(root), { waitMs: 300, pollMs: 50, log: () => {} }), RunLockTimeoutError);
});

test('a lock from another host older than the stale age is cleared as expired', () => {
  const root = scopeRoot();
  plant(root, record({ hostname: 'elsewhere.example' }), { mtime: ELEVEN_MINUTES_AGO() });
  const { lines, log } = collector();
  const hold = acquireRunLock(target(root), { log });
  try {
    assert.equal(hold.cleared[0].reason, 'expired');
    assert.match(lines[0], /: it is older than 10 minutes$/);
  } finally {
    hold.release();
  }
});

test('an unparsable lock is waited for while young and cleared once older than the stale age', () => {
  const root = scopeRoot();
  plant(root, 'not json');
  const { lines, log } = collector();
  assert.throws(() => acquireRunLock(target(root), { waitMs: 300, pollMs: 50, log }), (err) => err instanceof RunLockTimeoutError && err.holder === null);
  assert.match(lines[0], /\(holder unknown\)/);
  fs.utimesSync(runLockPath(root), ELEVEN_MINUTES_AGO(), ELEVEN_MINUTES_AGO());
  const hold = acquireRunLock(target(root), { log: () => {} });
  try {
    assert.deepEqual(hold.cleared, [{ pid: null, command: null, startedAt: null, reason: 'expired' }]);
  } finally {
    hold.release();
  }
});

test('a live claim on the stale instance makes takeover abort and the run wait', () => {
  const root = scopeRoot();
  const child = liveChild();
  const stale = record();
  const file = plant(root, stale);
  const claim = path.join(stateDir(root), `run.lock.claim.${stale.token}`);
  fs.writeFileSync(claim, `${JSON.stringify({ version: 1, token: 'b'.repeat(32), pid: child.pid, hostname: os.hostname(), at: new Date().toISOString(), target: stale.token })}\n`);
  assert.throws(() => acquireRunLock(target(root), { waitMs: 300, pollMs: 50, log: () => {} }), RunLockTimeoutError);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, stale.token);
  assert.deepEqual(listState(root), ['run.lock', `run.lock.claim.${stale.token}`]);
});

test('a claim whose process is not running is removed and takeover proceeds', () => {
  const root = scopeRoot();
  const stale = record();
  plant(root, stale);
  const claim = path.join(stateDir(root), `run.lock.claim.${stale.token}`);
  fs.writeFileSync(claim, `${JSON.stringify({ version: 1, token: 'b'.repeat(32), pid: deadPid(), hostname: os.hostname(), at: new Date().toISOString(), target: stale.token })}\n`);
  const hold = acquireRunLock(target(root), { log: () => {} });
  try {
    assert.equal(hold.cleared[0].reason, 'not-running');
    assert.deepEqual(listState(root), ['run.lock']);
  } finally {
    hold.release();
  }
});

test('release leaves run.lock in place while another run holds the claim on it', () => {
  const root = scopeRoot();
  const hold = acquireRunLock(target(root));
  const claim = path.join(stateDir(root), `run.lock.claim.${hold.token}`);
  fs.writeFileSync(claim, '{}\n');
  hold.release();
  assert.equal(JSON.parse(fs.readFileSync(runLockPath(root), 'utf8')).token, hold.token);
  assert.equal(fs.existsSync(claim), true);
});

test('checkpoint renews the mtime, and reports a lock taken over by another run', () => {
  const root = scopeRoot();
  const hold = acquireRunLock(target(root));
  try {
    const file = runLockPath(root);
    fs.utimesSync(file, ELEVEN_MINUTES_AGO(), ELEVEN_MINUTES_AGO());
    hold.checkpoint();
    assert.ok(Date.now() - fs.statSync(file).mtimeMs < 60_000);
    fs.unlinkSync(file);
    plant(root, record({ token: 'c'.repeat(32), pid: process.pid }));
    assert.throws(() => hold.checkpoint(), (err) => err instanceof RunLockLostError
      && err.message === formatRunLockMessage('lost', { scope: 'project', scopeRoot: path.resolve(root) }));
  } finally {
    hold.release();
  }
  assert.equal(JSON.parse(fs.readFileSync(runLockPath(root), 'utf8')).token, 'c'.repeat(32));
});

test('checkpoint reports the lock lost while another run holds the claim on it', () => {
  const root = scopeRoot();
  const hold = acquireRunLock(target(root));
  try {
    fs.writeFileSync(path.join(stateDir(root), `run.lock.claim.${hold.token}`), '{}\n');
    assert.throws(() => hold.checkpoint(), RunLockLostError);
  } finally {
    hold.release();
  }
});

test('a takeover does not remove a lock its holder renewed after the taker judged it expired', () => {
  const root = scopeRoot();
  const holder = acquireRunLock(target(root));
  try {
    fs.utimesSync(runLockPath(root), ELEVEN_MINUTES_AGO(), ELEVEN_MINUTES_AGO());
    // The taker reaches the same lock through another spelling, so this process's own hold does not
    // make its acquisition reentrant, and judges by age as a run on another host would.
    const alias = path.join(scopeRoot(), 'alias');
    fs.symlinkSync(root, alias);
    let renewed = false;
    const fsImpl = {
      ...fs,
      writeFileSync(file, data, options) {
        if (!renewed && String(file).includes('run.lock.claim.')) { renewed = true; holder.checkpoint(); }
        return fs.writeFileSync(file, data, options);
      },
    };
    assert.throws(() => acquireRunLock(target(alias), { hostname: 'elsewhere.example', waitMs: 300, pollMs: 50, log: () => {}, fsImpl }), RunLockTimeoutError);
    assert.equal(renewed, true);
    assert.equal(JSON.parse(fs.readFileSync(runLockPath(root), 'utf8')).token, holder.token);
    holder.checkpoint();
  } finally {
    holder.release();
  }
});

test('acquisition survives another run removing the state directory between its mkdir and its temp write', () => {
  const root = scopeRoot();
  fs.mkdirSync(stateDir(root), { recursive: true });
  let removed = false;
  const fsImpl = {
    ...fs,
    writeFileSync(file, data, options) {
      if (!removed && String(file).endsWith('.tmp')) { removed = true; fs.rmdirSync(stateDir(root)); }
      return fs.writeFileSync(file, data, options);
    },
  };
  const hold = acquireRunLock(target(root), { fsImpl });
  try {
    assert.equal(removed, true);
    assert.equal(JSON.parse(fs.readFileSync(runLockPath(root), 'utf8')).token, hold.token);
  } finally {
    hold.release();
  }
});

test('acquisition removes owner temp files left by runs that died while waiting, and keeps a live waiter\'s', () => {
  const root = scopeRoot();
  fs.mkdirSync(stateDir(root), { recursive: true });
  const temp = (token) => path.join(stateDir(root), `.run.lock.${token}.tmp`);
  const child = liveChild();
  fs.writeFileSync(temp('1'.repeat(32)), `${JSON.stringify(record({ token: '1'.repeat(32) }))}\n`);
  fs.writeFileSync(temp('2'.repeat(32)), `${JSON.stringify(record({ token: '2'.repeat(32), pid: child.pid }))}\n`);
  fs.writeFileSync(temp('3'.repeat(32)), '');
  fs.writeFileSync(temp('4'.repeat(32)), '');
  fs.utimesSync(temp('4'.repeat(32)), ELEVEN_MINUTES_AGO(), ELEVEN_MINUTES_AGO());
  const hold = acquireRunLock(target(root));
  try {
    assert.deepEqual(listState(root), [`.run.lock.${'2'.repeat(32)}.tmp`, `.run.lock.${'3'.repeat(32)}.tmp`, 'run.lock']);
  } finally {
    hold.release();
  }
});

test('a second acquisition in one process returns the same hold, and the lock outlives the inner release', () => {
  const root = scopeRoot();
  const outer = acquireRunLock(target(root));
  const inner = acquireRunLock(target(root));
  assert.equal(inner, outer);
  inner.release();
  assert.equal(fs.existsSync(runLockPath(root)), true);
  outer.release();
  assert.equal(fs.existsSync(runLockPath(root)), false);
});

test('a process that exits while holding leaves no lock', () => {
  const root = scopeRoot();
  const script = `const { acquireRunLock } = require(${JSON.stringify(MODULE)});
acquireRunLock({ scopeRoot: ${JSON.stringify(root)}, scope: 'project', command: 'install' });
process.exit(3);`;
  const result = spawnSync(process.execPath, ['-e', script], { timeout: 30_000 });
  assert.equal(result.status, 3);
  assert.equal(fs.existsSync(runLockPath(root)), false);
});

test('a lock left by a killed process is cleared as not running', { skip: NO_KILL_SEMANTICS && 'SIGKILL and pid liveness differ as root and on Windows' }, async () => {
  const root = scopeRoot();
  const script = `const { acquireRunLock } = require(${JSON.stringify(MODULE)});
acquireRunLock({ scopeRoot: ${JSON.stringify(root)}, scope: 'project', command: 'install' });
process.stdout.write('held\\n');
setTimeout(() => {}, 30000);`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('held')) resolve(); });
    child.on('exit', () => reject(new Error('holder exited before holding')));
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  assert.equal(fs.existsSync(runLockPath(root)), true);
  const hold = acquireRunLock(target(root), { log: () => {} });
  try {
    assert.equal(hold.cleared.length, 1);
    assert.equal(hold.cleared[0].pid, child.pid);
    assert.equal(hold.cleared[0].reason, 'not-running');
  } finally {
    hold.release();
  }
});

function runContender(root, journal) {
  const script = `const fs = require('node:fs');
const { acquireRunLock } = require(${JSON.stringify(MODULE)});
const hold = acquireRunLock({ scopeRoot: ${JSON.stringify(root)}, scope: 'project', command: 'install' }, { waitMs: 20000, pollMs: 25, log: () => {} });
fs.appendFileSync(${JSON.stringify(journal)}, 'start ' + process.pid + ' ' + Date.now() + '\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
fs.appendFileSync(${JSON.stringify(journal)}, 'end ' + process.pid + ' ' + Date.now() + '\\n');
hold.release();`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'inherit'] });
  children.push(child);
  return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
}

test('six processes contending for one stale lock hold it one at a time', { timeout: 300_000 }, async () => {
  for (let round = 0; round < 10; round += 1) {
    const root = scopeRoot();
    plant(root, record());
    const journal = path.join(root, 'journal');
    const codes = await Promise.all(Array.from({ length: 6 }, () => runContender(root, journal)));
    assert.deepEqual(codes, [0, 0, 0, 0, 0, 0], `round ${round}`);
    const intervals = new Map();
    for (const line of fs.readFileSync(journal, 'utf8').trim().split('\n')) {
      const [kind, pid, ms] = line.split(' ');
      intervals.set(pid, { ...intervals.get(pid), [kind]: Number(ms) });
    }
    const sorted = [...intervals.values()].sort((a, b) => a.start - b.start);
    assert.equal(sorted.length, 6, `round ${round}`);
    for (let i = 1; i < sorted.length; i += 1) {
      assert.ok(sorted[i].start >= sorted[i - 1].end, `round ${round}: hold ${i} started before hold ${i - 1} ended`);
    }
    assert.equal(fs.existsSync(runLockPath(root)), false, `round ${round}`);
  }
});
