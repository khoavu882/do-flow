'use strict';

// Feature 115 A.2: slot core (IC-008, IC-009, IC-010). Every test works in a scratch HOME.
// SLOTS_MODULE lets a negative control point the same tests at a mutated copy of the module.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn: realSpawn } = require('node:child_process');

const MODULE = process.env.SLOTS_MODULE || path.join(__dirname, '..', '..', 'src', 'runtime', 'slots.ts');
const { runSlot, listSlots, releaseSlot } = require(MODULE);
const { procStart } = require('../../src/runtime/worker/process-tree.ts');

const { suiteTempDir } = require('../helper/tmp.ts');

function scratchDir(prefix = 'doflow-slots-') {
  return suiteTempDir(prefix);
}

function scratchEnv() {
  const home = scratchDir();
  return { env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: process.env.PATH }, home };
}
const slotFile = (home, name) => path.join(home, '.doflow', 'state', 'slots', `${name}.json`);
const readSlot = (home, name) => JSON.parse(fs.readFileSync(slotFile(home, name), 'utf8'));
function writeSlot(home, name, patch) {
  fs.mkdirSync(path.dirname(slotFile(home, name)), { recursive: true });
  fs.writeFileSync(slotFile(home, name), JSON.stringify({
    version: 1, revision: 1, name, holder: null, waiters: [], lastRelease: null, ...patch,
  }, null, 2));
}
const holderRecord = (pid, extra = {}) => ({
  pid, start: null, childPid: null, childStart: null, label: 'holder-label', since: '2026-10-19T10:00:00.000Z', cwd: '/work/a', ...extra,
});
const waiterRecord = (pid, label, cwd) => ({ pid, start: null, label, since: '2026-10-19T10:00:01.000Z', cwd });

/** A fake child: emits `exit` after `ticks` event-loop turns, optionally running `onExit` first. */
function fakeChild(pid, { code = 0, signal = null, ticks = 2, onExit } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = [];
  child.kill = (sig) => { child.killed.push(sig); };
  let left = ticks;
  const turn = () => {
    if (left-- > 0) return setImmediate(turn);
    if (onExit) onExit();
    return child.emit('exit', code, signal);
  };
  setImmediate(turn);
  return child;
}

function baseDeps(overrides = {}) {
  let t = Date.UTC(2026, 9, 19, 12, 0, 0);
  const lines = [];
  return {
    lines,
    clock: () => t,
    deps: {
      alive: () => true,
      procStart: () => null,
      now: () => { t += 10; return t; },
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
      stderr: (line) => lines.push(line),
      pollMs: 1,
      ...overrides,
    },
  };
}

// The ceiling bounds a hang; the wait ends as soon as the predicate holds. A child process that has to
// start node and compile the TypeScript runtime can take far longer than 5 s on a loaded machine.
function waitFor(predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('condition was not met before the deadline'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function gatedFakeChild(pid) {
  const child = new EventEmitter();
  const gate = new EventEmitter();
  gate.closed = false;
  gate.data = undefined;
  gate.end = (data) => { gate.closed = true; gate.data = data; };
  gate.destroy = () => { gate.closed = true; };
  child.pid = pid;
  child.killed = [];
  child.stdio = [null, null, null, gate];
  child.kill = (signal) => { child.killed.push(signal); };
  return child;
}

test('eight concurrent runSlot calls: one holder at a time, grants in arrival order', async () => {
  const { env, home } = scratchEnv();
  const events = [];
  let holders = 0;
  let maxHolders = 0;
  const { deps } = baseDeps({
    spawn: (command, args) => {
      const commandArgs = command === 'sh' ? args.slice(3) : args;
      const id = Number(command === 'sh' ? commandArgs[1] : commandArgs[0]);
      events.push(`enter ${id}`);
      holders += 1;
      maxHolders = Math.max(maxHolders, holders);
      return fakeChild(5000 + id, { onExit: () => { events.push(`exit ${id}`); holders -= 1; } });
    },
  });
  const codes = await Promise.all(Array.from({ length: 8 }, (_, i) => runSlot({
    name: 'race', command: ['work', String(i)], env, cwd: '/work/a', deps: { ...deps, pid: 1000 + i },
  })));
  assert.deepEqual(codes, Array(8).fill(0));
  assert.equal(maxHolders, 1);
  assert.deepEqual(events, Array.from({ length: 8 }, (_, i) => [`enter ${i}`, `exit ${i}`]).flat());
  assert.equal(fs.existsSync(slotFile(home, 'race')), false, 'nobody holds or waits: the file is gone');
});

test('real processes: eight runSlot callers never overlap', async () => {
  const { env, home } = scratchEnv();
  const dir = scratchDir();
  const log = path.join(dir, 'log.txt');
  const runner = path.join(dir, 'runner.js');
  const script = "const fs=require('fs');fs.appendFileSync(process.argv[1],'enter '+process.pid+'\\n');"
    + "setTimeout(()=>fs.appendFileSync(process.argv[1],'exit '+process.pid+'\\n'),100)";
  fs.writeFileSync(runner, `
    const { runSlot } = require(${JSON.stringify(MODULE)});
    runSlot({ name: 'real-race', command: [process.execPath, '-e', ${JSON.stringify(script)}, ${JSON.stringify(log)}], deps: { pollMs: 30 } })
      .then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = 99; });
  `);
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
    const child = realSpawn(process.execPath, [runner], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => resolve({ code, stderr }));
  })));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 16);
  let open = null;
  const pids = new Set();
  for (const line of lines) {
    const [kind, pid] = line.split(' ');
    if (kind === 'enter') { assert.equal(open, null, `two enters without an exit: ${lines.join(' | ')}`); open = pid; pids.add(pid); }
    else { assert.equal(open, pid); open = null; }
  }
  assert.equal(pids.size, 8);
  assert.equal(fs.existsSync(slotFile(home, 'real-race')), false);
});

test('child exit code and death by signal are passed through; spawn gets DOFLOW_SLOT and the cwd', async () => {
  const { env } = scratchEnv();
  let seen;
  const run = (child) => {
    const { deps } = baseDeps({ spawn: (command, args, options) => { seen = { command, args, options }; return child(); } });
    return runSlot({ name: 'codes', command: ['tool', '-x', 'y'], env, cwd: '/work/a', deps });
  };
  assert.equal(await run(() => fakeChild(6001, { code: 3 })), 3);
  assert.equal(await run(() => fakeChild(6002, { code: null, signal: 'SIGKILL' })), 137);
  assert.equal(await run(() => fakeChild(6003, { code: null, signal: 'SIGTERM' })), 143);
  if (process.platform !== 'win32') {
    assert.equal(seen.command, 'sh');
    assert.deepEqual(seen.args, ['-c', 'read _ <&3 || exit 125; exec 3<&-; exec "$@"', 'doflow-slot', 'tool', '-x', 'y']);
    assert.deepEqual(seen.options.stdio, ['inherit', 'inherit', 'inherit', 'pipe']);
  } else {
    assert.equal(seen.command, 'tool');
    assert.deepEqual(seen.args, ['-x', 'y']);
    assert.equal(seen.options.stdio, 'inherit');
  }
  assert.equal(seen.options.env.DOFLOW_SLOT, 'codes');
  assert.equal(seen.options.cwd, '/work/a');
});

test('a spawn failure releases the slot and reports 127', async () => {
  const { env, home } = scratchEnv();
  const { deps, lines } = baseDeps({
    spawn: () => { const child = new EventEmitter(); child.kill = () => {}; setImmediate(() => child.emit('error', Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' }))); return child; },
  });
  assert.equal(await runSlot({ name: 'nope', command: ['nope'], env, cwd: '/work/a', deps }), 127);
  assert.equal(fs.existsSync(slotFile(home, 'nope')), false);
  assert.ok(lines.some((line) => line.startsWith('doflow slot: nope: cannot run nope')), lines.join('\n'));
});

test('SIGINT, SIGTERM and SIGHUP delivered to runSlot are forwarded to the child', async () => {
  const { env } = scratchEnv();
  const proc = new EventEmitter();
  let child;
  const { deps } = baseDeps({
    proc,
    spawn: () => { child = fakeChild(7001, { ticks: 6, code: null, signal: 'SIGTERM' }); return child; },
  });
  const pending = runSlot({ name: 'sig', command: ['tool'], env, cwd: '/work/a', deps });
  await new Promise((resolve) => setImmediate(resolve));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) proc.emit(signal);
  assert.equal(await pending, 143);
  assert.deepEqual(child.killed, ['SIGINT', 'SIGTERM', 'SIGHUP']);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(proc.listenerCount(signal), 0, 'listeners removed');
});

test('real process: SIGTERM sent to the runSlot process reaches the child (exit 143)', async () => {
  const { env } = scratchEnv();
  const dir = scratchDir();
  const ready = path.join(dir, 'ready');
  const runner = path.join(dir, 'runner.js');
  const script = `require('fs').writeFileSync(process.argv[1],'x');setInterval(()=>{},1000)`;
  fs.writeFileSync(runner, `
    const { runSlot } = require(${JSON.stringify(MODULE)});
    runSlot({ name: 'sig-real', command: [process.execPath, '-e', ${JSON.stringify(script)}, ${JSON.stringify(ready)}] })
      .then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = 99; });
  `);
  const child = realSpawn(process.execPath, [runner], { env, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(fs.existsSync(ready), 'the command started');
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 143, signal: null });
});

test('a dead holder is reclaimed; an unknown or half-alive holder is not', async () => {
  const { env, home } = scratchEnv();
  writeSlot(home, 'dead', { holder: holderRecord(9999) });
  let spawned = 0;
  const spawnFake = () => { spawned += 1; return fakeChild(8001); };
  const dead = baseDeps({ alive: (proc) => (proc.pid === 9999 ? false : true), spawn: spawnFake });
  assert.equal(await runSlot({ name: 'dead', command: ['tool'], env, cwd: '/work/a', deps: dead.deps }), 0);
  assert.equal(spawned, 1);

  writeSlot(home, 'unknown', { holder: holderRecord(9998) });
  const unknown = baseDeps({ alive: () => 'unknown', spawn: spawnFake });
  assert.equal(await runSlot({ name: 'unknown', command: ['tool'], env, cwd: '/work/a', noWait: true, deps: unknown.deps }), 75);
  assert.equal(spawned, 1, 'unknown liveness counts as alive');

  writeSlot(home, 'half', { holder: holderRecord(9997, { childPid: 9996 }) });
  const half = baseDeps({ alive: (proc) => proc.pid !== 9997, spawn: spawnFake });
  assert.equal(await runSlot({ name: 'half', command: ['tool'], env, cwd: '/work/a', noWait: true, deps: half.deps }), 75);
  assert.equal(readSlot(home, 'half').holder.pid, 9997, 'the live child keeps the slot held');
});

test('a dead waiter ahead is dropped under the lock', async () => {
  const { env, home } = scratchEnv();
  writeSlot(home, 'ghost', { waiters: [waiterRecord(9990, 'ghost', '/x')] });
  const { deps } = baseDeps({ alive: (proc) => proc.pid !== 9990, spawn: () => fakeChild(8002) });
  assert.equal(await runSlot({ name: 'ghost', command: ['tool'], env, cwd: '/work/a', deps }), 0);
});

test('noWait and timeout give 75, leave no waiter record, and print the IC-008 lines', async () => {
  const { env, home } = scratchEnv();
  writeSlot(home, 'busy', { holder: holderRecord(4242) });
  const noWait = baseDeps({ spawn: () => assert.fail('must not spawn') });
  assert.equal(await runSlot({ name: 'busy', command: ['tool'], env, cwd: '/work/a', noWait: true, deps: noWait.deps }), 75);
  assert.deepEqual(noWait.lines, ['doflow slot: busy busy; held by 4242 (holder-label) since 2026-10-19T10:00:00.000Z']);
  assert.deepEqual(readSlot(home, 'busy').waiters, []);

  let clock = Date.UTC(2026, 9, 19, 12, 0, 0);
  const timed = baseDeps({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    pollMs: 1000,
    spawn: () => assert.fail('must not spawn'),
  });
  assert.equal(await runSlot({ name: 'busy', command: ['tool'], env, cwd: '/work/a', timeoutSeconds: 3, deps: timed.deps }), 75);
  assert.deepEqual(timed.lines, ['doflow slot: busy timed out after 3 s; held by 4242 (holder-label)']);
  assert.deepEqual(readSlot(home, 'busy').waiters, []);
  assert.equal(readSlot(home, 'busy').holder.pid, 4242);
});

test('noWait refuses when only another live waiter is ahead', async () => {
  const { env, home } = scratchEnv();
  writeSlot(home, 'queue', { waiters: [waiterRecord(4300, 'first', '/x')] });
  const { deps, lines } = baseDeps({ spawn: () => assert.fail('must not spawn') });
  assert.equal(await runSlot({ name: 'queue', command: ['tool'], env, cwd: '/work/a', noWait: true, deps }), 75);
  assert.deepEqual(lines, ['doflow slot: queue busy; held by 4300 (first) since 2026-10-19T10:00:01.000Z']);
  assert.equal(readSlot(home, 'queue').waiters.length, 1);
});

test('the grant line carries the waited seconds and the label', async () => {
  const { env, home } = scratchEnv();
  writeSlot(home, 'grant', { holder: holderRecord(4242) });
  let clock = Date.UTC(2026, 9, 19, 12, 0, 0);
  let polls = 0;
  const { deps, lines } = baseDeps({
    now: () => clock,
    sleep: async (ms) => { clock += ms; polls += 1; },
    pollMs: 1000,
    alive: (proc) => !(proc.pid === 4242 && polls >= 3),
    spawn: () => fakeChild(8003),
  });
  assert.equal(await runSlot({ name: 'grant', command: ['tool'], label: 'mylabel', env, cwd: '/work/a', deps }), 0);
  assert.deepEqual(lines, ['doflow slot: grant granted after 3 s (mylabel)']);
});

test('the holder record carries the label (default and 80 cap), the child pid and cwd', async () => {
  const { env, home } = scratchEnv();
  const seen = [];
  const { deps } = baseDeps({
    spawn: () => fakeChild(8004, { onExit: () => seen.push(readSlot(home, 'rec').holder) }),
  });
  await runSlot({ name: 'rec', command: ['/usr/bin/some-tool', 'a'], env, cwd: '/work/project-x', deps });
  await runSlot({ name: 'rec', command: ['tool'], label: 'L'.repeat(200), env, cwd: '/work/project-x', deps });
  assert.equal(seen[0].label, 'some-tool@project-x');
  assert.equal(seen[0].childPid, 8004);
  assert.equal(seen[0].cwd, '/work/project-x');
  assert.equal(seen[0].pid, process.pid);
  assert.equal(seen[1].label.length, 80);
});

test('an empty slot file is deleted, including one that holds only a dead waiter', async () => {
  const { env, home } = scratchEnv();
  writeSlot(home, 'only-dead', { waiters: [waiterRecord(9990, 'ghost', '/x')] });
  const { deps } = baseDeps({ alive: () => false });
  const result = await listSlots({ env, deps });
  assert.deepEqual(result.slots, []);
  assert.equal(fs.existsSync(slotFile(home, 'only-dead')), false);
});

test('releaseSlot: refuses a live holder, frees a dead one, reports free, never signals', async () => {
  const { env, home } = scratchEnv();
  const kills = [];
  const kill = (pid, signal) => { kills.push(signal); return process.kill(pid, signal); };
  const deps = {
    kill,
    alive: (proc) => {
      try { kill(proc.pid, 0); return proc.pid === process.pid; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    },
    stderr: () => {},
    now: () => Date.UTC(2026, 9, 19, 12, 0, 0),
  };

  assert.deepEqual(await releaseSlot({ name: 'rel', by: 'kai', reason: 'x', env, deps }), { ok: true, disposition: 'free' });

  const liveHolder = holderRecord(process.pid, { start: procStart(process.pid) });
  writeSlot(home, 'rel', { holder: liveHolder, waiters: [waiterRecord(process.pid, 'w', '/x')] });
  const before = fs.readFileSync(slotFile(home, 'rel'), 'utf8');
  const refused = await releaseSlot({ name: 'rel', by: 'kai', reason: 'x', env, deps });
  assert.deepEqual(refused, { ok: false, disposition: 'holder-alive', holder: liveHolder });
  assert.equal(fs.readFileSync(slotFile(home, 'rel'), 'utf8'), before, 'no change');

  const gone = realSpawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => gone.on('exit', resolve));
  const deadHolder = holderRecord(gone.pid, { start: null });
  writeSlot(home, 'rel', { holder: deadHolder, waiters: [waiterRecord(process.pid, 'w', '/x')] });
  const released = await releaseSlot({ name: 'rel', by: 'kai', reason: 'stuck build', env, deps });
  assert.deepEqual(released, { ok: true, disposition: 'released', holder: deadHolder });
  const after = readSlot(home, 'rel');
  assert.equal(after.holder, null);
  assert.deepEqual(after.lastRelease, { by: 'kai', reason: 'stuck build', at: '2026-10-19T12:00:00.000Z', holder: deadHolder });
  assert.equal(after.waiters.length, 1);

  assert.ok(kills.length > 0 && kills.every((signal) => signal === 0), `only signal 0, got ${kills}`);
});

test('releaseSlot without waiters leaves no file behind', async () => {
  const { env, home } = scratchEnv();
  writeSlot(home, 'solo', { holder: holderRecord(9999) });
  const result = await releaseSlot({ name: 'solo', by: 'kai', reason: 'r', env, deps: { alive: () => false } });
  assert.equal(result.disposition, 'released');
  assert.equal(fs.existsSync(slotFile(home, 'solo')), false);
});

test('listSlots: text and JSON forms, sorted by name, waiters in arrival order', async () => {
  const { env, home } = scratchEnv();
  const text = await listSlots({ env, deps: { alive: () => true } });
  assert.equal(text.output, 'no slots held');
  assert.equal(JSON.stringify(JSON.parse((await listSlots({ env, json: true, deps: { alive: () => true } })).output)), '{"ok":true,"slots":[]}');

  const waiters = [waiterRecord(201, 'build@proj-b', '/work/b'), waiterRecord(202, 'test@proj-c', '/work/c')];
  writeSlot(home, 'zeta', { holder: holderRecord(100, { label: 'build@proj-a', cwd: '/work/a' }), waiters });
  writeSlot(home, 'alpha', { waiters: [waiterRecord(300, 'w', '/work/d')] });
  const deps = { alive: () => true };
  const result = await listSlots({ env, deps });
  assert.equal(result.output, [
    'alpha  free; 1 waiting',
    'zeta  held by 100 (build@proj-a) since 2026-10-19T10:00:00.000Z; 2 waiting',
  ].join('\n'));
  const json = JSON.parse((await listSlots({ env, json: true, deps })).output);
  assert.equal(json.ok, true);
  assert.deepEqual(json.slots.map((slot) => slot.name), ['alpha', 'zeta']);
  assert.equal(json.slots[1].holder.cwd, '/work/a');
  assert.deepEqual(json.slots[1].waiters.map((w) => [w.pid, w.cwd]), [[201, '/work/b'], [202, '/work/c']]);
  assert.equal(json.slots[0].holder, null);
});

test('two identical list calls are byte-equal and do not rewrite an unchanged file', async () => {
  const { env, home } = scratchEnv();
  writeSlot(home, 'det', { holder: holderRecord(100), waiters: [waiterRecord(201, 'w', '/work/b')] });
  const deps = { alive: () => true };
  const first = await listSlots({ env, deps });
  const revision = readSlot(home, 'det').revision;
  const second = await listSlots({ env, deps });
  assert.equal(first.output, second.output);
  assert.equal(readSlot(home, 'det').revision, revision);
  const firstJson = await listSlots({ env, json: true, deps });
  assert.equal(firstJson.output, (await listSlots({ env, json: true, deps })).output);
});

test('invalid names and empty commands are usage errors; a missing HOME is its own error', async () => {
  const { env } = scratchEnv();
  const { deps } = baseDeps({ spawn: () => assert.fail('must not spawn') });
  for (const name of ['', 'Bad', '-x', 'a/b', '../x', 'a'.repeat(65), undefined]) {
    await assert.rejects(runSlot({ name, command: ['tool'], env, deps }), { code: 'usage' }, String(name));
    await assert.rejects(releaseSlot({ name, by: 'k', reason: 'r', env, deps }), { code: 'usage' }, String(name));
  }
  await runSlot({ name: 'a'.repeat(64), command: ['tool'], env, cwd: '/w', deps: { ...deps, spawn: () => fakeChild(1) } });
  await assert.rejects(runSlot({ name: 'ok', command: [], env, deps }), { code: 'usage' });
  await assert.rejects(runSlot({ name: 'ok', command: [''], env, deps }), { code: 'usage' });
  await assert.rejects(releaseSlot({ name: 'ok', by: '', reason: 'r', env, deps }), { code: 'usage' });
  await assert.rejects(releaseSlot({ name: 'ok', by: 'k', reason: '', env, deps }), { code: 'usage' });
  await assert.rejects(runSlot({ name: 'ok', command: ['tool'], env: {}, deps }), { code: 'no-home' });
  await assert.rejects(runSlot({ name: 'ok', command: ['tool'], env: { HOME: 'relative' }, deps }), { code: 'no-home' });
  await assert.rejects(listSlots({ env: {}, deps }), { code: 'no-home' });
});

test('a live slot lock is not stolen after ten seconds while its owner is paused inside locked()', async (t) => {
  const { env } = scratchEnv();
  const dir = scratchDir();
  const pauseFile = path.join(dir, 'paused');
  const eventsFile = path.join(dir, 'events');
  const runner = path.join(dir, 'runner.cjs');
  const childScript = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(eventsFile)},process.env.RUNNER_LABEL+'-start\\n');setTimeout(()=>fs.appendFileSync(${JSON.stringify(eventsFile)},process.env.RUNNER_LABEL+'-end\\n'),3000)`;
  fs.writeFileSync(runner, `
    const fs = require('node:fs');
    const { runSlot } = require(${JSON.stringify(MODULE)});
    let calls = 0;
    const pauseMs = Number(process.env.PAUSE_MS || 0);
    const now = () => {
      calls += 1;
      if (calls === 2 && pauseMs) {
        fs.writeFileSync(process.env.PAUSE_FILE, 'inside locked');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs);
      }
      return Date.now();
    };
    runSlot({ name: 'paused-owner', command: [process.execPath, '-e', ${JSON.stringify(childScript)}], env: process.env,
      deps: {
        now,
        pollMs: 10,
        procStart: (pid) => 'test-' + pid,
        alive: (proc) => { try { process.kill(proc.pid, 0); return true; } catch (error) { return error.code === 'ESRCH' ? false : 'unknown'; } },
      } })
      .then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = 99; });
  `);
  const run = (label, pauseMs = 0) => {
    const child = realSpawn(process.execPath, [runner], {
      env: { ...env, RUNNER_LABEL: label, PAUSE_MS: String(pauseMs), PAUSE_FILE: pauseFile },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, stderr })));
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    return { child, exited };
  };

  const first = run('first', 11500);
  await waitFor(() => fs.existsSync(pauseFile));
  await new Promise((resolve) => setTimeout(resolve, 10200));
  const second = run('second');
  const [firstExit, secondExit] = await Promise.all([first.exited, second.exited]);
  assert.equal(firstExit.code, 0, firstExit.stderr);
  assert.equal(secondExit.code, 0, secondExit.stderr);
  assert.deepEqual(fs.readFileSync(eventsFile, 'utf8').trim().split('\n'), [
    'first-start', 'first-end', 'second-start', 'second-end',
  ]);
});

test('a slot lock with a dead owner token is recovered', async () => {
  const { env, home } = scratchEnv();
  const file = slotFile(home, 'recover-lock');
  const lockDir = `${file}.lock`;
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 98765, start: null }));
  let spawned = 0;
  const { deps } = baseDeps({
    alive: (proc) => proc.pid !== 98765,
    spawn: () => { spawned += 1; return fakeChild(8801); },
    quietMs: 0, // the 10 s wait after reclaiming an older runtime's lock is tested in slot-lock.test.js
  });
  assert.equal(await runSlot({ name: 'recover-lock', command: ['tool'], env, deps }), 0);
  assert.equal(spawned, 1);
  assert.equal(fs.existsSync(lockDir), false);
});

test('a lock release leaves a directory whose owner entry was replaced', async () => {
  // FU-31dyvs: the slot lock is the task-state lock; a reclaimer replaces the holder's entry with its own.
  const { env, home } = scratchEnv();
  const file = slotFile(home, 'foreign-release');
  const lockDir = `${file}.lock`;
  const foreign = 'owner-99999-x-aaaaaaaaaaaa';
  let foreignEntryInstalled = false;
  let removeAttempts = 0;
  const trackedFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'unlinkSync') return (targetPath) => {
        const result = fs.unlinkSync(targetPath);
        if (targetPath === file) {
          for (const name of fs.readdirSync(lockDir)) fs.rmdirSync(path.join(lockDir, name));
          fs.mkdirSync(path.join(lockDir, foreign));
          foreignEntryInstalled = true;
        }
        return result;
      };
      if (property === 'rmdirSync') return (targetPath, ...args) => {
        if (targetPath === lockDir && foreignEntryInstalled) removeAttempts += 1;
        return fs.rmdirSync(targetPath, ...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const { deps } = baseDeps({ fsImpl: trackedFs, spawn: () => fakeChild(8802) });
  assert.equal(await runSlot({ name: 'foreign-release', command: ['tool'], env, deps }), 0);
  assert.equal(foreignEntryInstalled, true);
  assert.equal(removeAttempts, 0, 'a non-owner never attempts to remove the lock directory');
  assert.deepEqual(fs.readdirSync(lockDir), [foreign]);
});

test('a failed child registration keeps the slot until that child exits', async () => {
  const { env, home } = scratchEnv();
  const file = slotFile(home, 'registration-full');
  let stateWrites = 0;
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property === 'writeFileSync') return (targetPath, ...args) => {
        if (String(targetPath).startsWith(file) && String(targetPath).endsWith('.tmp')) {
          stateWrites += 1;
          if (stateWrites === 2) throw Object.assign(new Error('ENOSPC: registration disk full'), { code: 'ENOSPC' });
        }
        return fs.writeFileSync(targetPath, ...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const firstChild = gatedFakeChild(8901);
  let spawnCount = 0;
  const makeDeps = (pid) => ({
    alive: () => true,
    procStart: () => `start-${pid}`,
    fsImpl,
    pid,
    spawn: () => {
      spawnCount += 1;
      if (spawnCount === 1) return firstChild;
      const child = gatedFakeChild(8902);
      setImmediate(() => child.emit('exit', 0, null));
      return child;
    },
    now: () => Date.UTC(2026, 9, 19, 12, 0, 0),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 2)),
    stderr: () => {},
    pollMs: 2,
    platform: 'linux',
  });
  const firstResult = runSlot({ name: 'registration-full', command: ['tool'], env, deps: makeDeps(1001) })
    .then((value) => ({ value }), (error) => ({ error }));
  await waitFor(() => stateWrites >= 2);

  const secondResult = runSlot({ name: 'registration-full', command: ['tool'], env, deps: makeDeps(1002) });
  await waitFor(() => spawnCount > 1 || readSlot(home, 'registration-full').waiters.length === 1);
  assert.equal(spawnCount, 1, 'the queued caller does not spawn beside the unregistered live child');
  assert.equal(readSlot(home, 'registration-full').holder.pid, 1001);
  assert.equal(firstChild.stdio[3].closed, true, 'the failed registration closes the start gate');
  assert.equal(firstChild.stdio[3].data, undefined, 'a failed registration never sends the go token');

  firstChild.emit('exit', 125, null);
  const failed = await firstResult;
  assert.equal(failed.error?.code, 'ENOSPC');
  assert.equal(await secondResult, 0);
  assert.equal(spawnCount, 2);
  assert.equal(fs.existsSync(file), false);
});

test('a slot that first becomes free at the deadline times out without spawning', async () => {
  const { env, home } = scratchEnv();
  writeSlot(home, 'deadline-free', { holder: holderRecord(7777) });
  let clock = Date.UTC(2026, 9, 19, 12, 0, 0);
  let polls = 0;
  let spawned = 0;
  const { deps } = baseDeps({
    now: () => clock,
    sleep: async (ms) => { clock += ms; polls += 1; },
    pollMs: 1000,
    alive: (proc) => proc.pid !== 7777 || polls === 0,
    spawn: () => { spawned += 1; return fakeChild(8803); },
  });
  assert.equal(await runSlot({ name: 'deadline-free', command: ['tool'], timeoutSeconds: 1, env, deps }), 75);
  assert.equal(spawned, 0);
  assert.equal(fs.existsSync(slotFile(home, 'deadline-free')), false, 'the timed out waiter is removed with the empty slot');
});
