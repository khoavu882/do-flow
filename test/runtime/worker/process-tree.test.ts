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
const { tempDir } = require('../../helper/tmp.ts');

const MODULE = path.join(__dirname, '..', '..', '..', 'src', 'runtime', 'worker', 'process-tree.ts');
const tree = require(MODULE);

const REAL: any = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (DEC-008)' };
const IDENTITY_VARS: any = ['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE'];

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

function scratch(t: any) {
  const dir = tempDir(t, 'doflow-proctree-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const worker = path.join(bin, 'fake-worker');
  fs.writeFileSync(worker, STAND_IN, { mode: 0o755 });
  return { dir, worker };
}

function childEnv(dir: any, extra: any = {}) {
  const env: any = { ...process.env, PATH: [path.join(dir, 'bin'), path.dirname(process.execPath)].join(path.delimiter) };
  for (const name of IDENTITY_VARS) delete env[name];
  return { ...env, PROCESS_TREE_MODULE: MODULE, ...extra };
}

/** Starts the stand-in in its own group and resolves once it printed `ready`. */
function startWorker(t: any, { dir, worker }: any, steps: any, extraEnv?: any) {
  const child = spawn(worker, steps, { cwd: dir, env: childEnv(dir, extraEnv), detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already ended */ }
  });
  return new Promise((resolve, reject) => {
    let text = '';
    child.on('error', reject);
    child.stdout.on('data', (chunk: any) => {
      text += chunk;
      if (!/^ready$/m.test(text)) return;
      child.stdout.destroy();
      const children = [...text.matchAll(/^child (\d+)$/gm)].map((m) => Number(m[1]));
      const start = (/^start (.+)$/m.exec(text) || [])[1] || null;
      resolve({ child, children, start });
    });
  });
}

const recorded = (pid: any) => ({ pid, pgid: pid, start: tree.procStart(pid) });

function killAfter(t: any, pids: any) {
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
function fakePs(rows: any) {
  return (args: any) => {
    const form = args[args.indexOf('-o') + 1];
    return rows.map(([pid, ppid, pgid, stat, start]: any) => (form.startsWith('pid=,ppid=')
      ? `${pid} ${ppid} ${pgid} ${stat} ${start}`
      : `${pid} ${pgid} ${stat} ${start}`)).join('\n') + '\n';
  };
}

test('injected listings: a foreign leader of the same pgid and a Z member give groupAlive false', async (): Promise<any> => {
  const leaderStart = 'Mon Oct 12 10:00:00 2026';
  const foreign = fakePs([[500, 1, 500, 'Ss', 'Tue Oct 13 09:00:00 2026'], [502, 500, 500, 'S', 'Tue Oct 13 09:00:01 2026']]);
  const foreignGroup = tree.groupMembers(500, leaderStart, { run: foreign });
  assert.equal(foreignGroup.foreignLeader, true);
  assert.equal(tree.groupAlive(500, leaderStart, { run: foreign, platform: 'linux' }), false);

  const signals: any = [];
  const foreignOutcome = await tree.escalate({
    proc: { pid: 500, pgid: 500, start: leaderStart }, platform: 'linux',
    run: foreign, kill: (pid: any, name: any) => signals.push([pid, name]), sleep: async () => {},
  });
  assert.deepEqual(signals, [], 'a group id and a pid naming other processes are never signalled');
  assert.equal(foreignOutcome.status, 'verified');

  const zombie = fakePs([[501, 1, 500, 'Z', 'Mon Oct 12 10:00:01 2026']]);
  const zombieGroup = tree.groupMembers(500, leaderStart, { run: zombie });
  assert.deepEqual(zombieGroup.live, []);
  assert.deepEqual(zombieGroup.zombies.map((row: any) => row.pid), [501]);
  assert.equal(tree.groupAlive(500, leaderStart, { run: zombie, platform: 'linux' }), false);

  const outcome = await tree.escalate({
    proc: { pid: 500, pgid: 500, start: leaderStart }, platform: 'linux',
    run: zombie, kill: () => {}, sleep: async () => {},
  });
  assert.deepEqual(outcome, { status: 'verified', reason: null, survivors: [], zombies: [501] });
});

test('injected platform win32: kill on the pid only and cleanup unknown', async (): Promise<any> => {
  const signals: any = [];
  const outcome = await tree.escalate({ proc: { pid: 4242, pgid: 4242, start: null }, platform: 'win32', kill: (pid: any, name: any) => signals.push([pid, name]) });
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

test('no snapshot or no leader start: no group is signalled, the pid only once alive() is true (S-10, DEC-060)', async (): Promise<any> => {
  const start = 'Mon Oct 12 10:00:00 2026';
  const base: any = { platform: 'linux', sleep: async () => {}, graceMs: 0, finalMs: 0 };

  // Every ps fails: alive() is unknown, so nothing at all is signalled.
  const blind: any = [];
  const failed = await tree.escalate({ ...base, proc: { pid: 700, pgid: 700, start }, run: () => null, kill: (pid: any, name: any) => blind.push([pid, name]) });
  assert.deepEqual(blind.filter(([, name]: any) => name !== 0), [], 'no signal without a live identity');
  assert.deepEqual([failed.status, failed.reason], ['unknown', 'ps-failed']);

  // The listing fails but `ps -p` confirms the recorded start: only the pid is signalled.
  const confirmed: any = [];
  const pOnly = (args: any) => (args.includes('-A') ? null : `S ${start}\n`);
  const outcome = await tree.escalate({ ...base, proc: { pid: 701, pgid: 701, start }, run: pOnly, kill: (pid: any, name: any) => confirmed.push([pid, name]) });
  const sent = confirmed.filter(([, name]: any) => name !== 0);
  assert.ok(sent.length > 0 && sent.every(([pid]: any) => pid === 701), JSON.stringify(sent));
  assert.equal(outcome.status, 'unknown');

  // A null leader start with a working listing: no group signal and no pid signal.
  const nullStart: any = [];
  const listing = fakePs([[702, 1, 702, 'S', start], [703, 702, 702, 'S', start]]);
  const unstarted = await tree.escalate({ ...base, proc: { pid: 702, pgid: 702, start: null }, run: listing, kill: (pid: any, name: any) => nullStart.push([pid, name]) });
  assert.deepEqual(nullStart.filter(([, name]: any) => name !== 0), []);
  assert.deepEqual([unstarted.status, unstarted.reason], ['unknown', 'no-leader-start']);
});

// ── Real trees ───────────────────────────────────────────────────────────────────────────────────

test('a group with a grandchild ends with no survivors', REAL, async (t) => {
  const s = scratch(t);
  const { child, children }: any = await startWorker(t, s, ['spawnChild']);
  killAfter(t, children);
  const worker = recorded(child.pid);
  const grandchild: any = { pid: children[0], start: tree.procStart(children[0]) };
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
  const { child }: any = await startWorker(t, s, ['ignoreTerm']);
  const worker = recorded(child.pid);
  const began = Date.now();
  const outcome = await tree.escalate({ proc: worker });
  const elapsed = Date.now() - began;
  assert.equal(outcome.status, 'verified');
  assert.deepEqual(outcome.survivors, []);
  assert.ok(elapsed >= tree.KILL_GRACE_MS - 200, `SIGKILL followed the grace wait (${elapsed} ms)`);
  assert.equal(child.signalCode ?? (await new Promise((resolve) => child.once('exit', (_code: any, sig: any) => resolve(sig)))), 'SIGKILL');
});

test('a grandchild moved to a new group is still found by the ppid walk', REAL, async (t) => {
  const s = scratch(t);
  const { child, children }: any = await startWorker(t, s, ['spawnChild:newGroup']);
  killAfter(t, children);
  const worker = recorded(child.pid);
  const grandchild: any = { pid: children[0], start: tree.procStart(children[0]) };

  const snapshot = tree.snapshotTree(worker);
  const found = snapshot.members.find((row: any) => row.pid === grandchild.pid);
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
  const { child, start }: any = await startWorker(t, s, ['recordStart'], { TZ: 'America/New_York', LC_ALL: 'de_DE.UTF-8' });
  assert.ok(start && start !== 'null', 'the child recorded its start');
  const worker: any = { pid: child.pid, pgid: child.pid, start };
  assert.equal(tree.alive(worker), true);
  assert.equal(tree.groupAlive(worker.pgid, worker.start), true);
  const outcome = await tree.escalate({ proc: worker });
  assert.equal(outcome.status, 'verified');
});

// 165 review A-1: the listing a started run's liveness is decided from; a failure is null (unknown), never an empty list.
test('processTexts: darwin reads one ps -wwAE listing; linux reads this user\'s /proc entries; a failure or another platform is null', () => {
  const calls: any[] = [];
  const run = (args: string[], opts: any) => { calls.push([args, opts]); return 'node supervisor.ts w-aaaabbbbcccc\n\nsleep 5 HOME=/h\n'; };
  assert.deepEqual(tree.processTexts({ platform: 'darwin', run }), ['node supervisor.ts w-aaaabbbbcccc', 'sleep 5 HOME=/h']);
  assert.deepEqual(calls[0][0], ['-wwAE', '-o', 'command=']);
  assert.ok(calls[0][1].maxBuffer > 1024 * 1024, 'the listing is read with a bound larger than the default');
  assert.equal(tree.processTexts({ platform: 'darwin', run: () => null }), null);
  assert.equal(tree.processTexts({ platform: 'win32', run }), null);
  assert.equal(tree.processTexts({ platform: 'freebsd', run }), null);
  const files: any = { '/proc/1/cmdline': 'init\0', '/proc/1/environ': '', '/proc/7/cmdline': 'fake\0-p\0', '/proc/7/environ': 'DOFLOW_STARTED_RUN=w-aaaabbbbcccc\0' };
  const proc = (owner: any, readable = true, code = 'EACCES') => ({
    readdirSync: () => ['1', '7', 'self', '9'],
    statSync: (p: string) => ({ uid: p === '/proc/1' ? 0 : owner }),
    readFileSync: (p: string) => {
      if (p.startsWith('/proc/9/')) { const e: any = new Error('gone'); e.code = 'ENOENT'; throw e; }
      if (!readable) { const e: any = new Error('denied'); e.code = code; throw e; }
      return Buffer.from(files[p]);
    },
  });
  assert.deepEqual(tree.processTexts({ platform: 'linux', fsImpl: proc(501), uid: 501 }), ['fake -p  DOFLOW_STARTED_RUN=w-aaaabbbbcccc ']);
  assert.equal(tree.processTexts({ platform: 'linux', fsImpl: proc(501, false), uid: 501 }), null, 'an unreadable entry of this user is unknown');
  assert.equal(tree.processTexts({ platform: 'linux', fsImpl: proc(501), uid: null }), null);
  // A zombie answers EACCES for its environ and has nothing to name a run with: it is skipped; a live entry that denies is unknown.
  const withStat = (state: string, threads = 1, tasks: any = {}, code = 'EACCES') => ({
    ...proc(501, false, code),
    readdirSync: (p: string) => (p === '/proc/7/task' ? ['7', ...Object.keys(tasks)] : proc(501, false, code).readdirSync()),
    readFileSync: (p: string) => {
      if (p === '/proc/7/stat') return Buffer.from(`7 (fake) ${state} 1 1 1`);
      if (p === '/proc/7/status') return Buffer.from(`Name:\tfake\nState:\t${state}\nThreads:\t${threads}\n`);
      const task = /^\/proc\/7\/task\/(\d+)\/(cmdline|environ)$/.exec(p);
      if (task && tasks[task[1]]) return Buffer.from(tasks[task[1]][task[2]]);
      return proc(501, false, code).readFileSync(p);
    },
  });
  assert.deepEqual(tree.processTexts({ platform: 'linux', fsImpl: withStat('Z'), uid: 501 }), []);
  assert.equal(tree.processTexts({ platform: 'linux', fsImpl: withStat('S'), uid: 501 }), null);
  // Seat A: a process whose main thread exited shows Z while its other threads run. It is read through a live thread, so a
  // run it names stays open; with no thread that reads, the listing is unknown, never a dead reading.
  const live = { cmdline: 'fake\0-p\0', environ: 'DOFLOW_STARTED_RUN=w-aaaabbbbcccc\0' };
  assert.deepEqual(tree.processTexts({ platform: 'linux', fsImpl: withStat('Z', 2, { 8: live }), uid: 501 }), ['fake -p  DOFLOW_STARTED_RUN=w-aaaabbbbcccc ']);
  assert.equal(tree.processTexts({ platform: 'linux', fsImpl: withStat('Z', 2), uid: 501 }), null, 'no live thread reads: unknown');
  const noStatus = { ...withStat('Z'), readFileSync: (p: string) => { if (p === '/proc/7/status') { const e: any = new Error('denied'); e.code = 'EACCES'; throw e; } return withStat('Z').readFileSync(p); } };
  assert.equal(tree.processTexts({ platform: 'linux', fsImpl: noStatus, uid: 501 }), null, 'a thread count that cannot be read is unknown');
  // Seat B: a kernel may answer ESRCH, not EACCES, for that process; it takes the same path, so a live one is never read as gone.
  // ESRCH from an entry that is not a zombie is a process that ended between the listing and the read: gone.
  assert.deepEqual(tree.processTexts({ platform: 'linux', fsImpl: withStat('Z', 2, { 8: live }, 'ESRCH'), uid: 501 }), ['fake -p  DOFLOW_STARTED_RUN=w-aaaabbbbcccc ']);
  assert.equal(tree.processTexts({ platform: 'linux', fsImpl: withStat('Z', 2, {}, 'ESRCH'), uid: 501 }), null, 'ESRCH and no live thread reads: unknown');
  assert.deepEqual(tree.processTexts({ platform: 'linux', fsImpl: withStat('Z', 1, {}, 'ESRCH'), uid: 501 }), [], 'an ESRCH zombie with one thread is skipped');
  assert.deepEqual(tree.processTexts({ platform: 'linux', fsImpl: withStat('S', 1, {}, 'ESRCH'), uid: 501 }), [], 'ESRCH from an entry that is not a zombie is gone');
  // The A-1 diagnosis: a listing that cannot be read names its first blocker; a readable one names none.
  const blocker = (options: any) => tree.readProcessTexts({ platform: 'linux', uid: 501, ...options });
  assert.deepEqual(blocker({ fsImpl: proc(501) }), { texts: ['fake -p  DOFLOW_STARTED_RUN=w-aaaabbbbcccc '], unreadable: null, skipped: [] });
  assert.deepEqual(blocker({ fsImpl: withStat('S') }), { texts: null, unreadable: { reason: 'proc-entry', pid: 7, file: '/proc/7/cmdline', errno: 'EACCES', state: 'S', threads: 1, command: null }, skipped: [] });
  assert.deepEqual(blocker({ fsImpl: withStat('Z', 2) }), { texts: null, unreadable: { reason: 'proc-entry', pid: 7, file: '/proc/7/cmdline', errno: 'EACCES', state: 'Z', threads: 2, command: null }, skipped: [] });
  assert.deepEqual(blocker({ fsImpl: proc(501, false, 'EIO') }).unreadable, { reason: 'proc-entry', pid: 7, file: '/proc/7/cmdline', errno: 'EIO', state: null, threads: null, command: null }, 'a stat and status that do not read are null');
  assert.deepEqual(blocker({ fsImpl: { readdirSync: () => { const e: any = new Error('x'); e.code = 'EACCES'; throw e; } } }).unreadable, { reason: 'proc-list', pid: null, file: '/proc', errno: 'EACCES' });
  assert.deepEqual(blocker({ fsImpl: proc(501), uid: null }).unreadable, { reason: 'no-uid', pid: null, file: null, errno: null });
  assert.deepEqual(tree.readProcessTexts({ platform: 'darwin', run: () => null }).unreadable, { reason: 'ps-failed', pid: null, file: null, errno: null });
  // A-1 root cause (CI runs 45556190256, 45589845673): a live process of this user whose environ answers EACCES although the
  // entry is ours. Two mechanisms, one rule: non-dumpable (ssh-agent, setuid: files owned by root) and a capability superset
  // (systemd --user: files ours, the ptrace access check denies). Skipped when its cmdline names no harness; otherwise unknown.
  const uninspectable = ({ cmdline = 'ssh-agent\0-s\0', environOwner = 0, cmdlineReadable = true, stat = '7 (x) S 1 1 1' } = {}) => ({
    readdirSync: () => ['7'],
    statSync: (p: string) => ({ uid: p === '/proc/7/environ' ? environOwner : 501 }),
    readFileSync: (p: string) => {
      const denied = () => { const e: any = new Error('denied'); e.code = 'EACCES'; throw e; };
      if (p === '/proc/7/cmdline') return cmdlineReadable ? Buffer.from(cmdline) : denied();
      if (p === '/proc/7/environ') return denied();
      if (p === '/proc/7/stat') return Buffer.from(stat);
      if (p === '/proc/7/status') return Buffer.from('Name:\tx\nUid:\t501\t501\t501\t501\nThreads:\t1\n');
      throw new Error(`unexpected read ${p}`);
    },
  });
  // The two known mechanisms as their own entries: files owned by root, and files ours.
  const nonDumpable = (options: any = {}) => uninspectable({ environOwner: 0, ...options });
  const capabilitySuperset = (options: any = {}) => uninspectable({ cmdline: '/usr/lib/systemd/systemd\0--user\0', environOwner: 501, ...options });
  const binaries = ['claude', 'codex', 'kiro-cli'];
  for (const [label, make] of [['non-dumpable (files owned by root)', nonDumpable], ['capability superset (files ours)', capabilitySuperset]] as const) {
    const skippedAs = (command: string) => [{ pgid: 1, sid: 1, unreadable: { reason: 'proc-entry', pid: 7, file: '/proc/7/environ', errno: 'EACCES', state: 'S', threads: 1, command } }];
    assert.deepEqual(blocker({ fsImpl: make(), binaries }), { texts: [], unreadable: null, skipped: skippedAs(label.startsWith('non') ? 'ssh-agent' : 'systemd') },
      `${label}: a non-harness is skipped, kept with its group and session and the blocker it is for a run that led them`);
    assert.deepEqual(blocker({ fsImpl: make({ stat: '7 (x) S 1' }), binaries }).unreadable?.file, '/proc/7/environ', `${label}: a group that cannot be read: unknown`);
    assert.deepEqual(blocker({ fsImpl: make({ cmdline: '/usr/bin/codex\0exec\0' }), binaries }).unreadable,
      { reason: 'proc-entry', pid: 7, file: '/proc/7/environ', errno: 'EACCES', state: 'S', threads: 1, command: 'codex' }, `${label}: argv[0] names a harness: unknown`);
    assert.deepEqual(blocker({ fsImpl: make({ cmdline: '/usr/bin/node\0/opt/lib/claude\0-p\0' }), binaries }).unreadable?.command, 'node',
      `${label}: argv[1] names a harness (node .../claude): unknown`);
    assert.deepEqual(blocker({ fsImpl: make({ cmdline: '/usr/bin/timeout\x0030\x00claude\x00-p\x00' }), binaries }).unreadable,
      { reason: 'proc-entry', pid: 7, file: '/proc/7/environ', errno: 'EACCES', state: 'S', threads: 1, command: 'timeout' }, `${label}: a later argv element names a harness (timeout 30 claude): unknown`);
    assert.deepEqual(blocker({ fsImpl: make({ cmdlineReadable: false }), binaries }).unreadable,
      { reason: 'proc-entry', pid: 7, file: '/proc/7/cmdline', errno: 'EACCES', state: 'S', threads: 1, command: null }, `${label}: an unreadable cmdline: unknown`);
    assert.equal(blocker({ fsImpl: make({ cmdline: '' }), binaries }).texts, null, `${label}: an empty cmdline: unknown`);
    assert.equal(blocker({ fsImpl: make(), binaries: null }).texts, null, `${label}: a registry that cannot be read: unknown`);
    assert.deepEqual(blocker({ fsImpl: make() }).texts, [], `${label}: by default the binaries come from core/registry/harnesses.json`);
    assert.equal(blocker({ fsImpl: make({ cmdline: '/usr/local/bin/claude\0' }) }).texts, null, `${label}: a registry harness binary by default: unknown`);
  }
});
