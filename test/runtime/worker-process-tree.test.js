'use strict';

// Feature 081 task A.3: process identity, liveness, bounded group spawn and kill escalation
// (IC-022, IC-021 step 3; DEC-023, DEC-043, DEC-050). Real-process cases run on darwin and linux
// only. Every spawn resolves to a stand-in worker linked into a scratch bin/, and the child PATH is
// that bin/ plus the directory of process.execPath (NFR-002).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tempDir } = require('../helper/tmp.js');

const MODULE = path.join(__dirname, '..', '..', 'src', 'runtime', 'worker', 'process-tree.ts');
const tree = require(MODULE);

const REAL = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (DEC-008)' };
const IDENTITY_VARS = ['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE'];

// Steps, one argv entry each: `spawnChild` or `spawnChild:newGroup` (a sleeping child, its pid
// printed as `child <pid>`), `ignoreTerm`, `recordStart` (prints `start <lstart>` through the module
// under test), `print:<text>`, `exit:<code>`, then `ready`. Without `exit` it sleeps until signalled.
const STAND_IN = `#!/usr/bin/env node
'use strict';
const { spawn } = require('node:child_process');
const steps = process.argv.slice(2);
if (steps[0] === 'sleep') { setInterval(() => {}, 1000); return; }
for (const step of steps) {
  if (step.startsWith('spawnChild')) {
    const child = spawn(process.execPath, [__filename, 'sleep'], { detached: step === 'spawnChild:newGroup', stdio: 'ignore' });
    process.stdout.write('child ' + child.pid + '\\n');
  } else if (step === 'ignoreTerm') {
    process.on('SIGTERM', () => {});
  } else if (step === 'recordStart') {
    const { procStart } = require(process.env.PROCESS_TREE_MODULE);
    process.stdout.write('start ' + procStart(process.pid) + '\\n');
  } else if (step.startsWith('print:')) {
    process.stdout.write(step.slice(6));
  } else if (step.startsWith('exit:')) {
    process.exit(Number(step.slice(5)));
  }
}
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`;

function scratch(t) {
  const dir = tempDir(t, 'doflow-proctree-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const worker = path.join(bin, 'fake-worker');
  fs.writeFileSync(worker, STAND_IN, { mode: 0o755 });
  return { dir, worker };
}

function childEnv(dir, extra = {}) {
  const env = { ...process.env, PATH: [path.join(dir, 'bin'), path.dirname(process.execPath)].join(path.delimiter) };
  for (const name of IDENTITY_VARS) delete env[name];
  return { ...env, PROCESS_TREE_MODULE: MODULE, ...extra };
}

/** Starts the stand-in in its own group and resolves once it printed `ready`. */
function startWorker(t, { dir, worker }, steps, extraEnv) {
  const child = spawn(worker, steps, { cwd: dir, env: childEnv(dir, extraEnv), detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already ended */ }
  });
  return new Promise((resolve, reject) => {
    let text = '';
    child.on('error', reject);
    child.stdout.on('data', (chunk) => {
      text += chunk;
      if (!/^ready$/m.test(text)) return;
      child.stdout.destroy();
      const children = [...text.matchAll(/^child (\d+)$/gm)].map((m) => Number(m[1]));
      const start = (/^start (.+)$/m.exec(text) || [])[1] || null;
      resolve({ child, children, start });
    });
  });
}

const recorded = (pid) => ({ pid, pgid: pid, start: tree.procStart(pid) });

function killAfter(t, pids) {
  t.after(() => {
    for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* already ended */ }
  });
}

// ── Parsing ────────────────────────────────────────────────────────────────────────────────────

test('parseListing reads the leading fields and keeps the rest of the line as the start', () => {
  const rows = tree.parseListing('  42     1    42 Ss   Fri Oct  2 20:44:36 2026    \nnot a row\n', ['pid', 'ppid', 'pgid', 'stat']);
  assert.deepEqual(rows, [{ pid: 42, ppid: 1, pgid: 42, stat: 'Ss', start: 'Fri Oct 2 20:44:36 2026' }]);
  assert.equal(tree.startMs('Fri Oct  2 20:44:36 2026'), Date.UTC(2026, 9, 2, 20, 44, 36));
  assert.equal(tree.startMs('Fr Okt 2 20:44:36 2026'), null);
});

test('every ps call runs under LC_ALL=C and TZ=UTC', () => {
  const env = tree.psEnv();
  assert.equal(env.LC_ALL, 'C');
  assert.equal(env.TZ, 'UTC');
});

// ── Identity and liveness ────────────────────────────────────────────────────────────────────────

test('a recorded start that differs reads not alive', REAL, () => {
  const self = recorded(process.pid);
  assert.ok(self.start, 'ps reports this process start');
  assert.equal(tree.alive(self), true);
  assert.equal(tree.alive({ ...self, start: 'Mon Jan  1 00:00:00 2001' }), false);
  assert.equal(tree.alive({ ...self, start: null }), 'unknown');
  const esrch = () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); };
  assert.equal(tree.alive(self, { kill: esrch }), false);
  assert.equal(tree.alive(self, { run: () => null }), 'unknown');
});

/** An injected `ps` answering each listing form from one table of `[pid, ppid, pgid, stat, start]`. */
function fakePs(rows) {
  return (args) => {
    const form = args[args.indexOf('-o') + 1];
    return rows.map(([pid, ppid, pgid, stat, start]) => (form.startsWith('pid=,ppid=')
      ? `${pid} ${ppid} ${pgid} ${stat} ${start}`
      : `${pid} ${pgid} ${stat} ${start}`)).join('\n') + '\n';
  };
}

test('injected listings: a foreign leader of the same pgid and a Z member give groupAlive false', async () => {
  const leaderStart = 'Mon Oct 12 10:00:00 2026';
  const foreign = fakePs([[500, 1, 500, 'Ss', 'Tue Oct 13 09:00:00 2026'], [502, 500, 500, 'S', 'Tue Oct 13 09:00:01 2026']]);
  const foreignGroup = tree.groupMembers(500, leaderStart, { run: foreign });
  assert.equal(foreignGroup.foreignLeader, true);
  assert.equal(tree.groupAlive(500, leaderStart, { run: foreign, platform: 'linux' }), false);

  const signals = [];
  const foreignOutcome = await tree.escalate({
    proc: { pid: 500, pgid: 500, start: leaderStart }, platform: 'linux',
    run: foreign, kill: (pid, name) => signals.push([pid, name]), sleep: async () => {},
  });
  assert.deepEqual(signals, [], 'a group id and a pid naming other processes are never signalled');
  assert.equal(foreignOutcome.status, 'verified');

  const zombie = fakePs([[501, 1, 500, 'Z', 'Mon Oct 12 10:00:01 2026']]);
  const zombieGroup = tree.groupMembers(500, leaderStart, { run: zombie });
  assert.deepEqual(zombieGroup.live, []);
  assert.deepEqual(zombieGroup.zombies.map((row) => row.pid), [501]);
  assert.equal(tree.groupAlive(500, leaderStart, { run: zombie, platform: 'linux' }), false);

  const outcome = await tree.escalate({
    proc: { pid: 500, pgid: 500, start: leaderStart }, platform: 'linux',
    run: zombie, kill: () => {}, sleep: async () => {},
  });
  assert.deepEqual(outcome, { status: 'verified', reason: null, survivors: [], zombies: [501] });
});

test('injected platform win32: kill on the pid only and cleanup unknown', async () => {
  const signals = [];
  const outcome = await tree.escalate({ proc: { pid: 4242, pgid: 4242, start: null }, platform: 'win32', kill: (pid, name) => signals.push([pid, name]) });
  assert.deepEqual(outcome, { status: 'unknown', reason: 'win32', survivors: [], zombies: [] });
  assert.deepEqual(signals, [[4242, 'SIGTERM']]);
  assert.equal(tree.groupAlive(4242, null, { platform: 'win32' }), 'unknown');
  assert.equal(tree.alive({ pid: 4242, pgid: 4242, start: null }, { platform: 'win32', kill: () => true }), 'unknown');
});

test('a failed ps reports cleanup unknown', async () => {
  const outcome = await tree.escalate({
    proc: { pid: 600, pgid: 600, start: 'Mon Oct 12 10:00:00 2026' }, platform: 'linux',
    run: () => null, kill: () => {}, sleep: async () => {}, graceMs: 0, finalMs: 0,
  });
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.reason, 'ps-failed');
});

// ── Real trees ───────────────────────────────────────────────────────────────────────────────────

test('a group with a grandchild ends with no survivors', REAL, async (t) => {
  const s = scratch(t);
  const { child, children } = await startWorker(t, s, ['spawnChild']);
  killAfter(t, children);
  const worker = recorded(child.pid);
  const grandchild = { pid: children[0], start: tree.procStart(children[0]) };
  assert.equal(tree.groupAlive(worker.pgid, worker.start), true);

  const outcome = await tree.escalate({ proc: worker });
  assert.equal(outcome.status, 'verified');
  assert.deepEqual(outcome.survivors, []);
  assert.equal(tree.alive(worker), false);
  assert.equal(tree.alive(grandchild), false);
  assert.equal(tree.groupAlive(worker.pgid, worker.start), false);
});

test('a worker ignoring SIGTERM is ended by SIGKILL', REAL, async (t) => {
  const s = scratch(t);
  const { child } = await startWorker(t, s, ['ignoreTerm']);
  const worker = recorded(child.pid);
  const began = Date.now();
  const outcome = await tree.escalate({ proc: worker });
  const elapsed = Date.now() - began;
  assert.equal(outcome.status, 'verified');
  assert.deepEqual(outcome.survivors, []);
  assert.ok(elapsed >= tree.KILL_GRACE_MS - 200, `SIGKILL followed the grace wait (${elapsed} ms)`);
  assert.equal(child.signalCode ?? (await new Promise((resolve) => child.once('exit', (_code, sig) => resolve(sig)))), 'SIGKILL');
});

test('a grandchild moved to a new group is still found by the ppid walk', REAL, async (t) => {
  const s = scratch(t);
  const { child, children } = await startWorker(t, s, ['spawnChild:newGroup']);
  killAfter(t, children);
  const worker = recorded(child.pid);
  const grandchild = { pid: children[0], start: tree.procStart(children[0]) };

  const snapshot = tree.snapshotTree(worker);
  const found = snapshot.members.find((row) => row.pid === grandchild.pid);
  assert.ok(found, 'the grandchild is in the snapshot');
  assert.notEqual(found.pgid, worker.pgid, 'the grandchild left the worker group');

  const outcome = await tree.escalate({ proc: worker });
  assert.equal(outcome.status, 'verified');
  assert.equal(tree.alive(grandchild), false);
});

test('spawnBounded returns its output, and past its bound returns timeout and leaves no process', REAL, async (t) => {
  const s = scratch(t);
  const env = childEnv(s.dir);
  const done = await tree.spawnBounded({ binary: s.worker, argv: ['print:hello world', 'exit:3'], cwd: s.dir, env, timeoutMs: 5000, maxStdout: 5 });
  assert.equal(done.status, 'exited');
  assert.equal(done.code, 3);
  assert.equal(done.stdout, 'hello');
  assert.equal(done.truncated, true);

  const missing = await tree.spawnBounded({ binary: path.join(s.dir, 'bin', 'absent'), argv: [], cwd: s.dir, env, timeoutMs: 1000 });
  assert.equal(missing.status, 'error');
  assert.equal(missing.error, 'ENOENT');

  const result = await tree.spawnBounded({ binary: s.worker, argv: ['spawnChild'], cwd: s.dir, env, timeoutMs: 500, maxStdout: 65536 });
  const children = [...result.stdout.matchAll(/^child (\d+)$/gm)].map((m) => Number(m[1]));
  killAfter(t, [result.proc.pid, ...children]);
  assert.equal(result.status, 'timeout');
  assert.equal(result.cleanup.status, 'verified');
  assert.equal(children.length, 1);
  assert.equal(tree.alive(result.proc), false);
  // The grandchild shares the worker group, so a dead group means the grandchild is gone too.
  assert.equal(tree.groupAlive(result.proc.pgid, result.proc.start), false);
});

test('a start recorded under another time zone and locale is read alive under TZ=UTC (IC-022)', REAL, async (t) => {
  const s = scratch(t);
  const savedTz = process.env.TZ;
  process.env.TZ = 'UTC';
  t.after(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });
  const { child, start } = await startWorker(t, s, ['recordStart'], { TZ: 'America/New_York', LC_ALL: 'de_DE.UTF-8' });
  assert.ok(start && start !== 'null', 'the child recorded its start');
  const worker = { pid: child.pid, pgid: child.pid, start };
  assert.equal(tree.alive(worker), true);
  assert.equal(tree.groupAlive(worker.pgid, worker.start), true);
  const outcome = await tree.escalate({ proc: worker });
  assert.equal(outcome.status, 'verified');
});
