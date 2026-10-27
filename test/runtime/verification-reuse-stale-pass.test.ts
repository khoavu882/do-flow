'use strict';

// 089 review fixes C-1..C-5 (WP-1): "a stored PASS is wrong". Every case runs the REAL
// VerificationContractRunner (or VerificationEngine) with a REAL shell: no exec spy replaces the
// check, so a stale reused PASS is told apart from a fresh FAIL by what the command actually does.
// Reuse is injected as `reuse: true` (never read from settings); the config home lives outside the
// fixture repository unless a case says otherwise. "ran" means the report is not labelled `reused`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { bashPath } = require('../helper/bash-locator.ts');
const { loadVerificationRegistry } = require('../../src/runtime/verification/registry.ts');
const CR = require('../../src/runtime/verification/contract-runner.ts');
const { VerificationEngine } = require('../../src/runtime/verification/engine.ts');
const { checkKeyV2 } = require('../../src/runtime/verification/check-key.ts');

const REGISTRY = loadVerificationRegistry();
const SH = '#!/bin/sh\n';

/** The checks here are POSIX shell commands (printf, test, cat, chmod, /dev/null). The runner hands them to `shell: true`, which on
 * win32 is cmd.exe, so win32 runs the same command text through Git Bash instead: still a real shell, never a spy. */
function shellRun(command: any, options: any = {}) {
  if (process.platform !== 'win32') return spawnSync(command, options);
  const { shell: _shell, ...rest } = options;
  return spawnSync(bashPath({ quiet: true }), ['-c', command], rest);
}
const SHELL_EXEC: any = process.platform === 'win32'
  ? (command: any, argsOrOptions: any, options: any) => (Array.isArray(argsOrOptions) ? spawnSync(command, argsOrOptions, options) : shellRun(command, argsOrOptions))
  : undefined;

function git(cwd: any, ...args: any[]) {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function put(root: any, name: any, text: any, mode?: any) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, mode ? { mode } : undefined);
  if (mode) fs.chmodSync(file, mode);
  return file;
}

/**
 * A committed git repository holding `files`, plus `links` ({ name: target }) committed as symlinks.
 * `ctx.env` has a PATH that starts with a stub directory holding `node`, `npm` and `mytool` (all exit 0),
 * and a HOME of its own. The config home is outside the repository unless `inRepoConfig` is set.
 */
function scene(t: any, { files = {}, links = {}, inRepoConfig = false }: any = {}) {
  const root = tempDir(t, 'doflow-stale-pass-');
  put(root, 'README.md', 'fixture\n'); // every fixture has a first commit, even with no other file
  for (const [name, text] of Object.entries(files)) put(root, name, text);
  for (const [name, target] of Object.entries(links)) fs.symlinkSync(target, path.join(root, name));
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const stubDir = tempDir(t, 'doflow-stale-pass-bin-');
  for (const name of ['node', 'npm', 'mytool']) put(stubDir, name, `${SH}exit 0\n`, 0o755);
  const home = tempDir(t, 'doflow-stale-pass-home-');
  const configDir = inRepoConfig ? path.join(root, '.doflow') : path.join(tempDir(t, 'doflow-stale-pass-cfg-'), '.doflow');
  return {
    root, configDir, stubDir, home,
    env: { PATH: `${stubDir}${path.delimiter}${process.env.PATH}`, HOME: home, DOFLOW_TELEMETRY: 'off', ...(process.platform === 'win32' ? { USERPROFILE: home, SystemRoot: process.env.SystemRoot } : {}) },
  };
}

function newRunner(ctx: any, { reuse = true, risk = 'MEDIUM', exec }: any = {}) {
  return new CR.VerificationContractRunner({
    cwd: ctx.root, env: ctx.env, logDir: path.join(ctx.configDir, 'logs'), ...((exec || SHELL_EXEC) ? { exec: exec || SHELL_EXEC } : {}),
    context: { v0: false, reuse, registry: REGISTRY, riskLevel: risk, configDir: ctx.configDir },
  });
}

/** One check through a fresh runner (one contract of one check). */
function runnerDriver(ctx: any, command: any, { reuse = true, risk = 'MEDIUM', timeoutMs = 60000, exec }: any = {}) {
  const runner: any = newRunner(ctx, { reuse, risk, exec });
  const result = runner.runCheck('unit', command, timeoutMs);
  return { ran: result.reused === undefined, status: result.status, result, metrics: runner.metrics.get(result) };
}

/** The same check through a fresh VerificationEngine, as the verify verb runs it. */
function engineDriver(ctx: any, command: any, { reuse = true, risk = 'MEDIUM', timeoutMs = 60000, exec }: any = {}) {
  const engine: any = new VerificationEngine({ cwd: ctx.root, configDir: ctx.configDir, v0: false, reuse, ...((exec || SHELL_EXEC) ? { exec: exec || SHELL_EXEC } : {}) });
  engine.runner.env = ctx.env;
  const report = engine.runContract({ version: 1, taskId: 'stale-pass', riskLevel: risk, tiers: [{
    id: 'broad-tests', name: 'Broad tests', kind: 'behavioral', required: true, resolution: 'RESOLVED',
    checks: [{ name: 'unit', command, timeoutMs }],
  }] });
  const result = report.tiers[0].checks[0];
  return { ran: result.reused === undefined, status: result.status, result };
}

const DRIVERS: any = [['runner', runnerDriver], ['engine', engineDriver]];

function storedRecords(ctx: any) {
  const found: any = [];
  (function walk(dir) {
    let entries: any = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^reuse-[0-9a-f]{16}\.json$/.test(entry.name)) found.push(full);
    }
  })(ctx.configDir);
  return found;
}

// ── C-1: the tree is read once per contract; a check that changes it must not be stored ───────────

test('C-1 real shell: a PASS recorded after an earlier check changed the tree is stored under the tree it ran on', (t) => {
  const ctx = scene(t, { files: { 'flag.txt': '0', 'a.txt': 'x\n' } });
  const A = 'printf 1 > flag.txt';
  const B = 'test "$(cat flag.txt)" = 1';

  const runner = newRunner(ctx);
  const a = runner.runCheck('A', A, 60000);
  const b = runner.runCheck('B', B, 60000);
  assert.deepEqual([a.status, a.reused, b.status, b.reused], ['PASS', undefined, 'PASS', undefined]);

  // B's key is the key of the tree A left behind, not of the tree the contract started on.
  const postA = checkKeyV2({ command: B, timeoutMs: 60000, cwd: ctx.root, configDir: ctx.configDir, env: ctx.env });
  assert.equal(runner.metrics.get(b).checkKey, postA.key, 'B is keyed on the post-A tree');
  const records = storedRecords(ctx).map((file: any) => path.basename(file));
  assert.deepEqual(records, [`reuse-${postA.key}.json`], 'A changed its own inputs and is not stored; B is stored under the post-A key');

  // Restore the file: the tree is the one the contract started on. [B] alone must fail, as it does with reuse off.
  fs.writeFileSync(path.join(ctx.root, 'flag.txt'), '0');
  const off = runnerDriver(ctx, B, { reuse: false });
  assert.deepEqual([off.ran, off.status], [true, 'FAIL'], 'control: reuse off fails');
  const second = runnerDriver(ctx, B);
  assert.deepEqual([second.ran, second.status], [true, 'FAIL'], 'a stale PASS must not be reused');
});

test('C-1 real shell: a check that changes its own inputs is never stored', (t) => {
  const ctx = scene(t, { files: { 'flag.txt': '0' } });
  const A = 'printf 1 > flag.txt';
  assert.equal(runnerDriver(ctx, A).ran, true);
  assert.deepEqual(storedRecords(ctx), [], 'no record: the inputs moved during the run');
  fs.writeFileSync(path.join(ctx.root, 'flag.txt'), '0');
  assert.equal(runnerDriver(ctx, A).ran, true, 'and the next identical run executes');
});

test('C-1 control: a non-mutating PASS is still stored and hits, through the runner and the engine', (t) => {
  for (const [name, drive] of DRIVERS) {
    const ctx = scene(t, { files: { 'flag.txt': '0' } });
    const command = 'test "$(cat flag.txt)" = 0';
    assert.deepEqual([drive(ctx, command).ran, drive(ctx, command).ran], [true, false], `${name}: second run reuses`);
    assert.equal(storedRecords(ctx).length, 1);
  }
});

test('C-1 control: with reuse off the runner spawns nothing beyond the check itself (no extra git read)', (t): any => {
  const ctx = scene(t, { files: { 'flag.txt': '0' } });
  const calls: any = [];
  const exec = (command: any, options: any) => { calls.push(command); return shellRun(command, options); };
  const env: any = { ...ctx.env };
  delete env.DOFLOW_TELEMETRY; // telemetry on: the key is still computed, from one tree read
  const runner: any = new CR.VerificationContractRunner({ cwd: ctx.root, env, exec,
    context: { v0: false, reuse: false, registry: REGISTRY, riskLevel: 'MEDIUM', configDir: ctx.configDir } });
  const result = runner.runCheck('A', 'true', 60000);
  assert.equal(result.status, 'PASS');
  assert.deepEqual(calls, ['true']);
  assert.equal(storedRecords(ctx).length, 0, 'the store is untouched while reuse is off');
  assert.equal(runner._treeContext.links, 'skipped', 'reuse off: the tracked-symlink read is skipped');
});

// ── C-2: an executed non-PASS evicts the stored PASS, at every level ─────────────────────────────

const markerCommand = (marker: any) => `test ! -e "${marker}"`;

for (const [name, drive] of DRIVERS) {
  test(`C-2 real shell (${name}): PASS at MEDIUM, same-key FAIL at HIGH, then MEDIUM executes`, (t) => {
    const ctx = scene(t);
    const marker = path.join(tempDir(t, 'doflow-stale-pass-marker-'), 'fail');
    const command = markerCommand(marker);
    assert.deepEqual([drive(ctx, command).ran, drive(ctx, command).ran], [true, false], 'PASS stored, then reused');
    fs.writeFileSync(marker, '');
    const high = drive(ctx, command, { risk: 'HIGH' });
    assert.deepEqual([high.ran, high.status], [true, 'FAIL'], 'L3 executes and fails');
    assert.deepEqual(storedRecords(ctx), [], 'the failure removed the stored PASS');
    fs.rmSync(marker);
    const medium = drive(ctx, command);
    assert.deepEqual([medium.ran, medium.status], [true, 'PASS'], 'MEDIUM executes: nothing is left to reuse');
  });

  test(`C-2 real shell (${name}): a FAIL by timeout evicts the stored PASS`, (t) => {
    const ctx = scene(t);
    const marker = path.join(tempDir(t, 'doflow-stale-pass-marker-'), 'slow');
    const command = `if [ -e "${marker}" ]; then exec sleep 5; fi`;
    const options: any = { timeoutMs: 800 };
    assert.deepEqual([drive(ctx, command, options).ran, drive(ctx, command, options).ran], [true, false]);
    fs.writeFileSync(marker, '');
    const high = drive(ctx, command, { ...options, risk: 'HIGH' });
    assert.equal(high.status, 'FAIL');
    assert.equal(high.result.error, 'TimeoutExpired');
    assert.deepEqual(storedRecords(ctx), []);
    fs.rmSync(marker);
    assert.equal(drive(ctx, command, options).ran, true);
  });

  test(`C-2 real shell (${name}): FAIL by a spawn error and by a spawn throw evict the stored PASS`, (t) => {
    for (const mode of ['error', 'throw']) {
      const ctx = scene(t);
      const command = 'true';
      const gate: any = { mode: 'real' };
      // Delegates to the real shell until the case flips the gate; then it faults like an unspawnable command.
      const exec = (cmd: any, options: any) => {
        if (gate.mode === 'throw') throw new Error('spawn boom');
        if (gate.mode === 'error') return { error: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }), status: null, stdout: '', stderr: '' };
        return shellRun(cmd, options);
      };
      assert.deepEqual([drive(ctx, command, { exec }).ran, drive(ctx, command, { exec }).ran], [true, false], `${mode}: stored`);
      gate.mode = mode;
      const high = drive(ctx, command, { exec, risk: 'HIGH' });
      assert.deepEqual([high.ran, high.status], [true, 'FAIL'], `${mode}: the faulty run is a FAIL`);
      assert.deepEqual(storedRecords(ctx), [], `${mode}: evicted`);
      gate.mode = 'real';
      assert.deepEqual([drive(ctx, command, { exec }).ran], [true], `${mode}: MEDIUM executes again`);
    }
  });

  test(`C-2 control (${name}): PASS at MEDIUM then PASS at HIGH keeps the record, MEDIUM still hits`, (t) => {
    const ctx = scene(t);
    const command = 'true';
    assert.equal(drive(ctx, command).ran, true);
    assert.equal(drive(ctx, command, { risk: 'HIGH' }).ran, true);
    assert.equal(storedRecords(ctx).length, 1);
    assert.equal(drive(ctx, command).ran, false);
  });

  // 089 re-review S-1: eviction cannot remove a record from a store the process cannot write, so a
  // process that cannot evict must not reuse either.
  test(`S-1 real shell (${name}): a store the process cannot write is never reused, so an unevictable FAIL is not followed by a reused PASS`, (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('needs POSIX permissions and a non-root user'); return; }
    const ctx = scene(t);
    const marker = path.join(tempDir(t, 'doflow-stale-pass-marker-'), 'fail');
    const command = markerCommand(marker);
    assert.deepEqual([drive(ctx, command).ran, drive(ctx, command).ran], [true, false], 'PASS stored, then reused');
    const [record] = storedRecords(ctx);
    const dir = path.dirname(record);
    fs.chmodSync(dir, 0o555);
    t.after(() => { try { fs.chmodSync(dir, 0o700); } catch { /* already removed */ } });
    fs.writeFileSync(marker, '');
    const high = drive(ctx, command, { risk: 'HIGH' });
    assert.deepEqual([high.ran, high.status], [true, 'FAIL'], 'L3 executes and fails');
    assert.deepEqual(storedRecords(ctx), [record], 'the read-only store kept the PASS: eviction could not run');
    const medium = drive(ctx, command);
    assert.deepEqual([medium.ran, medium.status], [true, 'FAIL'], 'MEDIUM executes: an unwritable store is not trusted');
    // Negative control: the same record in a writable store is still reused, so the refusal above is
    // the store's writability and not a key or record change.
    fs.chmodSync(dir, 0o700);
    fs.rmSync(marker);
    assert.deepEqual(storedRecords(ctx), [record]);
    assert.equal(drive(ctx, command).ran, false, 'writable store: the stored PASS hits');
  });
}

test('C-2 control: with reuse off an executed FAIL does not touch the store', (t) => {
  const ctx = scene(t);
  assert.equal(runnerDriver(ctx, 'true').ran, true);
  const [record] = storedRecords(ctx);
  const before = fs.readFileSync(record, 'utf8');
  const off = runnerDriver(ctx, 'true; false', { reuse: false });
  assert.equal(off.status, 'FAIL');
  const same = runnerDriver(ctx, 'false', { reuse: false });
  assert.equal(same.status, 'FAIL');
  assert.equal(fs.readFileSync(record, 'utf8'), before);
});

// 089 re-review N-a: a git status read that faults after one check must not leave a null tree cached
// for the rest of the contract, or every later FAIL carries no key and evicts nothing.
test('N-a real shell: after a faulted re-read the next check reads the tree again, so its FAIL evicts the stored PASS', (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('needs POSIX permissions and a non-root user'); return; }
  const ctx = scene(t);
  const marker = path.join(tempDir(t, 'doflow-stale-pass-marker-'), 'fail');
  const B = markerCommand(marker);
  assert.deepEqual([runnerDriver(ctx, B).ran, runnerDriver(ctx, B).ran], [true, false], 'PASS stored, then reused');
  const [record] = storedRecords(ctx);
  const index = path.join(ctx.root, '.git', 'index');
  t.after(() => { try { fs.chmodSync(index, 0o644); } catch { /* fixture gone */ } });
  const runner = newRunner(ctx, { risk: 'HIGH' });
  runner.runCheck('A', `chmod 000 "${index}"`, 60000); // the read after A faults
  fs.chmodSync(index, 0o644); // the fault clears before the next check starts
  fs.writeFileSync(marker, '');
  const b = runner.runCheck('B', B, 60000);
  assert.equal(b.status, 'FAIL');
  assert.equal(typeof runner.metrics.get(b)?.checkKey, 'string', 'B is keyed on a fresh read');
  assert.equal(fs.existsSync(record), false, 'B\'s FAIL evicted the stored PASS');
  const after = runnerDriver(ctx, B);
  assert.deepEqual([after.ran, after.status], [true, 'FAIL'], 'the next MEDIUM run executes');
});

test('N-a control: with the tree readable throughout, the same contract keys B and evicts', (t) => {
  const ctx = scene(t);
  const marker = path.join(tempDir(t, 'doflow-stale-pass-marker-'), 'fail');
  const B = markerCommand(marker);
  assert.equal(runnerDriver(ctx, B).ran, true);
  const [record] = storedRecords(ctx);
  const runner = newRunner(ctx, { risk: 'HIGH' });
  runner.runCheck('A', 'true', 60000);
  fs.writeFileSync(marker, '');
  const b = runner.runCheck('B', B, 60000);
  assert.equal(typeof runner.metrics.get(b)?.checkKey, 'string');
  assert.equal(fs.existsSync(record), false);
});

// FU-kerery: the key read BEFORE a check faulted (null), so the check's FAIL had no key to evict by.
// The post-run read succeeds and keys the tree the check ran on; that key evicts the stored PASS.
test('FU-kerery real shell: a FAIL whose pre-run key read faulted evicts the stored PASS by the post-run key', (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('needs POSIX permissions and a non-root user'); return; }
  const ctx = scene(t);
  const marker = path.join(tempDir(t, 'doflow-stale-pass-marker-'), 'fail');
  const index = path.join(ctx.root, '.git', 'index');
  t.after(() => { try { fs.chmodSync(index, 0o644); } catch { /* fixture gone */ } });
  // B repairs the index first, so the post-run read works, then fails on the marker.
  const B = `chmod 644 "${index}"; ${markerCommand(marker)}`;
  assert.deepEqual([runnerDriver(ctx, B).ran, runnerDriver(ctx, B).ran], [true, false], 'PASS stored, then reused');
  const [record] = storedRecords(ctx);

  fs.chmodSync(index, 0o000); // git status faults when B's key is read
  fs.writeFileSync(marker, '');
  const runner = newRunner(ctx, { risk: 'HIGH' });
  const b = runner.runCheck('B', B, 60000);
  assert.equal(b.status, 'FAIL');
  assert.equal(runner.metrics.get(b)?.checkKey ?? null, null, 'precondition: the pre-run key was null');
  assert.equal(fs.existsSync(record), false, 'the FAIL evicted the stored PASS by the post-run key');
  const after = runnerDriver(ctx, B);
  assert.deepEqual([after.ran, after.status], [true, 'FAIL'], 'the next MEDIUM run executes');
});

// FU-kerery (review C-2): the same null-pre-run-key scene for the three other FAIL sites, each of which
// evicts by the post-run key: a timeout, a spawn error and a spawn throw. Reverting any one site to the
// pre-run key leaves that mode's stored PASS in place.
for (const mode of ['timeout', 'error', 'throw']) {
  test(`FU-kerery real shell: a FAIL by ${mode} whose pre-run key read faulted evicts the stored PASS by the post-run key`, (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('needs POSIX permissions and a non-root user'); return; }
    const ctx = scene(t);
    const marker = path.join(tempDir(t, 'doflow-stale-pass-marker-'), 'slow');
    const index = path.join(ctx.root, '.git', 'index');
    t.after(() => { try { fs.chmodSync(index, 0o644); } catch { /* fixture gone */ } });
    // The check repairs the index first (the stub does it for the two modes that never reach the shell),
    // so the post-run read works; then it times out, or the spawn fails.
    const command = `chmod 644 "${index}"; if [ -e "${marker}" ]; then exec sleep 5; fi`;
    const gate: any = { mode: 'real' };
    const exec = (cmd: any, options: any) => {
      if (gate.mode === 'throw') { fs.chmodSync(index, 0o644); throw new Error('spawn boom'); }
      if (gate.mode === 'error') {
        fs.chmodSync(index, 0o644);
        return { error: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }), status: null, stdout: '', stderr: '' };
      }
      return shellRun(cmd, options);
    };
    const options: any = { exec, timeoutMs: 800 };
    assert.deepEqual([runnerDriver(ctx, command, options).ran, runnerDriver(ctx, command, options).ran], [true, false], 'PASS stored, then reused');
    const [record] = storedRecords(ctx);

    gate.mode = mode;
    if (mode === 'timeout') fs.writeFileSync(marker, '');
    fs.chmodSync(index, 0o000); // git status faults when the check's key is read
    const runner: any = newRunner(ctx, { risk: 'HIGH', exec });
    const result = runner.runCheck('B', command, 800);
    assert.equal(result.status, 'FAIL');
    if (mode === 'timeout') assert.equal(result.error, 'TimeoutExpired');
    assert.equal(runner.metrics.get(result)?.checkKey ?? null, null, 'precondition: the pre-run key was null');
    assert.equal(fs.existsSync(record), false, `the FAIL by ${mode} evicted the stored PASS by the post-run key`);
    gate.mode = 'real';
    if (mode === 'timeout') fs.rmSync(marker);
    assert.equal(runnerDriver(ctx, command, options).ran, true, 'the next MEDIUM run executes');
  });
}

// ── C-3: the out-of-repo target of a clean tracked symlink ───────────────────────────────────────

test('C-3 real shell: changing only the target of a committed symlink to an outside file executes the check', (t) => {
  const outside = tempDir(t, 'doflow-stale-pass-outside-');
  const target = put(outside, 'value.txt', 'ok\n');
  const ctx = scene(t, { files: { 'a.txt': 'x\n' }, links: { 'cfg.txt': target } });
  const command = 'grep -q ok cfg.txt';
  assert.deepEqual([runnerDriver(ctx, command).ran, runnerDriver(ctx, command).ran], [true, false], 'control: unchanged target hits');
  fs.writeFileSync(target, 'bad\n');
  const changed = runnerDriver(ctx, command);
  assert.deepEqual([changed.ran, changed.status], [true, 'FAIL']);
  fs.writeFileSync(target, 'ok\n');
  assert.equal(runnerDriver(ctx, command).ran, false, 'restored target: the first record is current again');
});

test('C-3 real shell: a symlink to a DIRECTORY outside is reuse-unkeyable (always executes) but keeps a key', (t) => {
  const outsideDir = tempDir(t, 'doflow-stale-pass-outdir-');
  put(outsideDir, 'f.txt', 'one\n');
  const ctx = scene(t, { files: { 'a.txt': 'x\n' }, links: { dirlink: outsideDir } });
  const command = 'ls dirlink > /dev/null';
  const first = runnerDriver(ctx, command);
  const second = runnerDriver(ctx, command);
  assert.deepEqual([first.ran, second.ran], [true, true]);
  assert.match(first.metrics.checkKey, /^[0-9a-f]{16}$/, 'telemetry and in-flight sharing keep the key');
  assert.deepEqual(storedRecords(ctx), [], 'nothing is stored for an unkeyable check');
});

test('C-3 control: an in-repo symlink is unaffected (hits, and moves when its target is edited)', (t) => {
  const ctx = scene(t, { files: { 'a.txt': 'ok\n' }, links: { 'link.txt': 'a.txt' } });
  const command = 'grep -q ok link.txt';
  assert.deepEqual([runnerDriver(ctx, command).ran, runnerDriver(ctx, command).ran], [true, false]);
  fs.writeFileSync(path.join(ctx.root, 'a.txt'), 'bad\n');
  const changed = runnerDriver(ctx, command);
  assert.deepEqual([changed.ran, changed.status], [true, 'FAIL']);
});

test('C-3 real shell: a dangling out-of-repo symlink is keyed as absent and moves when the target appears', (t) => {
  const outside = tempDir(t, 'doflow-stale-pass-outside-');
  const target = path.join(outside, 'later.txt');
  const ctx = scene(t, { files: { 'a.txt': 'x\n' }, links: { 'cfg.txt': target } });
  const command = '! grep -q ok cfg.txt 2> /dev/null';
  assert.deepEqual([runnerDriver(ctx, command).ran, runnerDriver(ctx, command).ran], [true, false]);
  fs.writeFileSync(target, 'ok\n');
  const changed = runnerDriver(ctx, command);
  assert.deepEqual([changed.ran, changed.status], [true, 'FAIL']);
});

// ── C-4: a first word the parser cannot trust ────────────────────────────────────────────────────

/** A path spelled for a command line that Git Bash runs: a native C:\\x would lose its backslashes to the shell, while C:/x
 * is still a path Node can stat (the reuse key reads the tool's bytes). */
const posix = (p: string) => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p);
/** The MSYS spelling (/c/x), for a colon-separated PATH list where C:/x would read as two entries. */
const msys = (p: string) => (process.platform === 'win32' ? posix(p).replace(/^([A-Za-z]):/, (_m: string, d: string) => `/${d.toLowerCase()}`) : p);

function toolDir(t: any, prefix: any = 'doflow-stale-pass-tool-') {
  const dir = tempDir(t, prefix);
  put(dir, 'tool', `${SH}exit 0\n`, 0o755);
  return dir;
}
const changeTool = (file: any) => put(path.dirname(file), path.basename(file), `${SH}# changed\nexit 1\n`, 0o755);

/** Each case: build the command (and env) over a tool that the stale key cannot see; the case rewrites `tool`. */
const UNPARSEABLE: any = [
  ['a quoted path with a space', (ctx: any, dir: any, t: any) => {
    const spaced = toolDir(t, 'doflow-stale-pass-tool dir-');
    return { command: `"${posix(spaced)}/tool" x`, tool: `${spaced}/tool` };
  }],
  ['an escaped space', (ctx: any, dir: any, t: any) => {
    const spaced = toolDir(t, 'doflow-stale-pass-tool dir-');
    return { command: `${posix(spaced).replace(/ /g, '\\ ')}/tool x`, tool: `${spaced}/tool` };
  }],
  ['a variable path ($DIR/tool)', (ctx: any, dir: any, t: any) => { ctx.env.DIR = posix(dir); return { command: '$DIR/tool x', tool: `${dir}/tool` }; }],
  ['a backtick form', (ctx: any, dir: any, t: any) => ({ command: `\`echo '${posix(dir)}/tool'\` x`, tool: `${dir}/tool` })],
  ['an inline PATH= assignment', (ctx: any, dir: any, t: any) => {
    put(dir, 'mytool', `${SH}exit 0\n`, 0o755);
    return { command: `PATH='${msys(dir)}':$PATH mytool`, tool: `${dir}/mytool` };
  }],
  ['a tilde path (~/tool)', (ctx: any, dir: any, t: any) => {
    const home = tempDir(t, 'doflow-stale-pass-tilde-');
    ctx.env.HOME = home;
    put(home, 'tool', `${SH}exit 0\n`, 0o755);
    return { command: '~/tool x', tool: `${home}/tool` };
  }],
  ['a glob first word', (ctx: any, dir: any, t: any) => ({ command: `${posix(dir)}/to*l x`, tool: `${dir}/tool` })],
];

for (const [label, build] of UNPARSEABLE) {
  test(`C-4 real shell: ${label} executes after the tool changes content`, (t) => {
    const ctx = scene(t, { files: { 'a.txt': 'x\n' } });
    const dir = toolDir(t);
    const { command, tool } = build(ctx, dir, t);
    const first = runnerDriver(ctx, command);
    assert.deepEqual([first.ran, first.status], [true, 'PASS']);
    assert.match(first.metrics.checkKey, /^[0-9a-f]{16}$/, 'the key is kept');
    changeTool(tool);
    const second = runnerDriver(ctx, command);
    assert.deepEqual([second.ran, second.status], [true, 'FAIL']);
    assert.deepEqual(storedRecords(ctx), [], 'an unparseable first word is never stored');
  });
}

test('C-4 control: LABEL=ok tool, npm test and node --test x stay reusable', (t) => {
  for (const command of ['LABEL=ok mytool', 'npm test', 'node --test x']) {
    const ctx = scene(t, { files: { 'a.txt': 'x\n' } });
    assert.deepEqual([runnerDriver(ctx, command).ran, runnerDriver(ctx, command).ran], [true, false], command);
  }
});

test('C-4 control: a simple unquoted absolute tool path hits when unchanged and executes after a content change', (t) => {
  const ctx = scene(t, { files: { 'a.txt': 'x\n' } });
  const dir = toolDir(t, 'doflow-stale-pass-abs-');
  const command = `${posix(dir)}/tool x`;
  assert.deepEqual([runnerDriver(ctx, command).ran, runnerDriver(ctx, command).ran], [true, false]);
  changeTool(`${dir}/tool`);
  const changed = runnerDriver(ctx, command);
  assert.deepEqual([changed.ran, changed.status], [true, 'FAIL']);
});

// ── C-5: tracked project config under .doflow ────────────────────────────────────────────────────

const CFG_CHECK = 'grep -q ok .doflow/check.cfg';

for (const inRepoConfig of [false, true]) {
  const where = inRepoConfig ? 'the config dir is the repo .doflow' : 'the config dir is outside the repo';
  test(`C-5 real shell: editing a tracked .doflow/check.cfg executes the check (${where})`, (t) => {
    const ctx = scene(t, { files: { '.doflow/check.cfg': 'ok\n', 'a.txt': 'x\n' }, inRepoConfig });
    assert.deepEqual([runnerDriver(ctx, CFG_CHECK).ran, runnerDriver(ctx, CFG_CHECK).ran], [true, false], 'control: hit before the edit');
    fs.writeFileSync(path.join(ctx.root, '.doflow', 'check.cfg'), 'bad\n');
    const changed = runnerDriver(ctx, CFG_CHECK);
    assert.deepEqual([changed.ran, changed.status], [true, 'FAIL']);
  });

  test(`C-5 control: an untracked .doflow file and writes under .doflow/state do not change the key (${where})`, (t) => {
    const ctx = scene(t, { files: { '.doflow/check.cfg': 'ok\n', '.doflow/state/tracked.json': '{}\n', 'a.txt': 'x\n' }, inRepoConfig });
    assert.deepEqual([runnerDriver(ctx, CFG_CHECK).ran, runnerDriver(ctx, CFG_CHECK).ran], [true, false]);
    put(ctx.root, '.doflow/x', 'untracked\n');
    put(ctx.root, '.doflow/state/verification/other/log.txt', 'state write\n');
    put(ctx.root, '.doflow/state/tracked.json', '{"edited":true}\n');
    assert.equal(runnerDriver(ctx, CFG_CHECK).ran, false, 'still hits');
  });
}
