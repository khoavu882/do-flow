'use strict';

// 089 B.1 (IC-004, IC-005, IC-006, IC-007; FR-001, FR-006, FR-007, FR-008): a recorded PASS is
// reused by a later run on the same check key. The runner consults the reuse store after the in-run
// dedupe cache and the key, before in-flight sharing or execution; stores every executed PASS while
// reuse is on (L3 included, store-only); looks up only at the levels `policy.reuse.levels` lists.
// Every case injects the `reuse` boolean, so no test depends on the user's settings, and runs on a
// fixture git repository in a temp directory with an exec spy (the style of
// verification-inflight.test.js). Negative controls run mutated modules in memory.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { createSettingsEnv } = require('../helper/settings-fixtures.ts');
const { loadVerificationRegistry } = require('../../src/runtime/verification/registry.ts');
const CR = require('../../src/runtime/verification/contract-runner.ts');
const { VerificationEngine, readVerifyReuse } = require('../../src/runtime/verification/engine.ts');
const { buildVerifyRecords } = require('../../src/runtime/verification/telemetry-emit.ts');

const REPO = path.resolve(__dirname, '../..');
const REGISTRY = loadVerificationRegistry();
const ENV: any = { PATH: process.env.PATH, DOFLOW_TELEMETRY: 'off' };
const PASS_OUT = '# tests 4\n# fail 0\n';
const HEX32 = /^[0-9a-f]{32}$/;

function git(cwd: any, ...args: any[]) {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function fixture(t: any) {
  const root = tempDir(t, 'doflow-reuse-runner-');
  fs.writeFileSync(path.join(root, '.gitignore'), '.doflow/\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return { root, configDir: path.join(root, '.doflow') };
}

/** The reuse store a fixture's runs write to: every `reuse-*.json` under its config dir. */
function storedRecords(fx: any) {
  const found: any = [];
  (function walk(dir) {
    let entries: any = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^reuse-[0-9a-f]{16}\.json$/.test(entry.name)) found.push(full);
    }
  })(fx.configDir);
  return found;
}

/** An fs that records every path touched under a reuse store, without changing behaviour. */
function spyFs(): any {
  const touched: any = [];
  const io: any = new Proxy(fs, { get(target, prop) {
    const value = target[prop];
    if (typeof value !== 'function') return value;
    return (...args: any[]) => {
      if (typeof args[0] === 'string' && /verification[\\/]reuse|reuse-[0-9a-f]{16}/.test(args[0])) touched.push([prop, args[0]]);
      return value.apply(target, args);
    };
  } });
  return { io, touched };
}

function makeRunner(fx: any, { mod = CR, reuse = true, v0 = false, risk = 'MEDIUM', env = ENV, fsImpl, result = () => ({ status: 0, stdout: PASS_OUT, stderr: '' }) }: any = {}): any {
  const calls: any = [];
  const runner: any = new mod.VerificationContractRunner({
    cwd: fx.root, env, fsImpl, logDir: path.join(fx.configDir, 'logs'),
    exec: (command: any, options: any) => { calls.push({ command, options }); return result(command, options); },
    context: { v0, reuse, registry: REGISTRY, riskLevel: risk, configDir: fx.configDir },
  });
  return { runner, calls };
}

// ── IC-004: the hit ────────────────────────────────────────────────────────────────────────────

test('a second MEDIUM run on the same key executes nothing and carries the reused label and metrics', (t) => {
  const fx = fixture(t);
  const first = makeRunner(fx);
  const executed = first.runner.runCheck('unit', 'npm test', 60000);
  assert.equal(first.calls.length, 1);
  assert.equal(executed.status, 'PASS');
  assert.equal(executed.reused, undefined, 'an executed check carries no reused label');
  assert.equal(first.runner.metrics.get(executed).shared, 'none');
  assert.equal(storedRecords(fx).length, 1, 'the executed PASS is stored');

  const second = makeRunner(fx);
  const reused = second.runner.runCheck('unit-again', 'npm test', 60000);
  assert.equal(second.calls.length, 0, 'a reused check spawns no command');
  assert.equal(reused.name, 'unit-again');
  assert.equal(reused.command, 'npm test');
  assert.equal(reused.status, 'PASS');
  assert.equal(reused.exitCode, 0);
  assert.equal(reused.stdout, executed.stdout, 'the reused excerpt is the excerpt the executed report carried');
  assert.equal(reused.stderr, executed.stderr);
  assert.deepEqual(Object.keys(reused.reused), ['ref', 'recordedAt']);
  assert.match(reused.reused.ref, HEX32);
  assert.ok(Number.isSafeInteger(reused.reused.recordedAt));
  const metric = second.runner.metrics.get(reused);
  assert.equal(metric.shared, 'reused');
  assert.equal(metric.sharedRef, reused.reused.ref);
  assert.equal(metric.cpuMs, null);
  assert.equal(metric.resourceBasis, null);
  assert.deepEqual([metric.tests, metric.testsFailed], [4, 0]);
  assert.ok(metric.durationMs >= 0, 'durationMs is the lookup time');
  assert.equal(metric.checkKey, first.runner.metrics.get(executed).checkKey);
});

test('a reused result is shared with an identical check later in the same evaluation', (t) => {
  const fx = fixture(t);
  makeRunner(fx).runner.runCheck('unit', 'npm test', 60000);
  const { runner, calls } = makeRunner(fx);
  const report = runner.evaluateContract([
    { name: 'a', command: 'npm test', timeoutMs: 60000 },
    { name: 'b', command: 'npm test', timeoutMs: 60000 },
  ]);
  assert.equal(calls.length, 0);
  assert.ok(report.checks[0].reused);
  assert.equal(report.checks[1].deduplicated, true, 'the in-run dedupe cache still answers first');
});

test('the engine passes reuse to the runner: a second MEDIUM contract executes nothing, telemetry says reused', (t) => {
  const fx = fixture(t);
  const contract: any = { version: 1, taskId: 'reuse', riskLevel: 'MEDIUM', tiers: [{
    id: 'broad-tests', name: 'Broad tests', kind: 'behavioral', required: true, resolution: 'RESOLVED',
    checks: [{ name: 'test:all', command: 'npm test', timeoutMs: 60000 }],
  }] };
  const calls: any = [];
  const engineFor = () => {
    const engine: any = new VerificationEngine({ cwd: fx.root, configDir: fx.configDir, v0: false, reuse: true,
      exec: (command: any) => { calls.push(command); return { status: 0, stdout: PASS_OUT, stderr: '' }; } });
    engine.runner.env = ENV;
    return engine;
  };
  const first = engineFor().runContract(contract);
  assert.equal(first.status, 'PASS');
  assert.equal(calls.length, 1);

  const engine = engineFor();
  const report = engine.runContract(contract);
  assert.equal(report.status, 'PASS');
  assert.equal(calls.length, 1, 'the second contract executes no command');
  const check = report.tiers[0].checks[0];
  assert.match(check.reused.ref, HEX32);

  const lines = buildVerifyRecords({ report, metrics: engine.runner.metrics,
    ctx: { verifyId: '0123456789abcdef', source: 'verb', taskId: 'reuse', risk: 'MEDIUM', exitCode: 0, v0: 'off' } });
  const line = lines.find((entry: any) => entry.kind === 'verify.check');
  assert.equal(line.shared, 'reused');
  assert.match(line.shared_ref, HEX32);
  assert.equal(line.shared_ref, check.reused.ref);
  assert.equal(lines.find((entry: any) => entry.kind === 'verify.run').checks_run, 0, 'a reused check is not an executed check');
});

// ── reuse off: today's behaviour ───────────────────────────────────────────────────────────────

test('reuse off: every run executes, no check carries reused, the store is never touched', (t) => {
  const fx = fixture(t);
  const { io, touched } = spyFs();
  const reports: any = [];
  for (let n = 0; n < 2; n++) {
    const { runner, calls }: any = makeRunner(fx, { reuse: false, fsImpl: io });
    reports.push(runner.runCheck('unit', 'npm test', 60000));
    assert.equal(calls.length, 1);
    assert.equal(runner._treeContext, undefined, 'reuse off with telemetry off computes no identity, as today');
    assert.equal(runner.reuseContext, undefined);
  }
  assert.deepEqual(reports[0], reports[1]);
  assert.equal(Object.hasOwn(reports[0], 'reused'), false);
  assert.deepEqual(touched, [], 'reuse off never touches the reuse store');
  assert.equal(storedRecords(fx).length, 0);

  // A stored record from an earlier reuse-on run is never read while reuse is off.
  makeRunner(fx).runner.runCheck('unit', 'npm test', 60000);
  const off: any = makeRunner(fx, { reuse: false, fsImpl: io });
  off.runner.runCheck('unit', 'npm test', 60000);
  assert.equal(off.calls.length, 1);
  assert.deepEqual(touched, []);
});

test('reuse off: the executed command gets no env option unless V0 sharing is on, as today', (t) => {
  const fx = fixture(t);
  const { runner, calls } = makeRunner(fx, { reuse: false });
  runner.runCheck('unit', 'npm test', 60000);
  assert.equal(Object.hasOwn(calls[0].options, 'env'), false);
});

// ── IC-005: eligibility ────────────────────────────────────────────────────────────────────────

function assertHighStoresWithoutLookup(t: any, mod: any = CR) {
  const fx = fixture(t);
  const { io, touched } = spyFs();
  const first: any = makeRunner(fx, { mod, risk: 'HIGH', fsImpl: io });
  first.runner.runCheck('unit', 'npm test', 60000);
  assert.equal(storedRecords(fx).length, 1, 'an L3 PASS is stored');
  assert.equal(touched.some(([call, file]: any) => call === 'lstatSync' && /reuse-[0-9a-f]{16}\.json$/.test(file)), false,
    'L3 never looks a record up');
  const second: any = makeRunner(fx, { mod, risk: 'HIGH', fsImpl: io });
  second.runner.runCheck('unit', 'npm test', 60000);
  assert.equal(second.calls.length, 1, 'L3 always executes');
  // The L3 PASS serves a later L2 lookup on the same key.
  const medium = makeRunner(fx, { mod, risk: 'MEDIUM' });
  const reused = medium.runner.runCheck('unit', 'npm test', 60000);
  assert.equal(medium.calls.length, 0);
  assert.ok(reused.reused);
}

test('HIGH: lookup is never called, the PASS is stored and serves a later MEDIUM lookup', (t) => {
  assertHighStoresWithoutLookup(t);
  for (const risk of ['CRITICAL']) {
    const fx = fixture(t);
    makeRunner(fx, { risk }).runner.runCheck('unit', 'npm test', 60000);
    const again = makeRunner(fx, { risk });
    again.runner.runCheck('unit', 'npm test', 60000);
    assert.equal(again.calls.length, 1, `${risk} always executes`);
  }
});

test('negative control: letting L3 look up turns the HIGH case red', (t) => {
  const mod = mutated('contract-runner.ts', [['reuseApplies(registry, riskLevel)', 'true']]);
  assert.throws(() => assertHighStoresWithoutLookup(t, mod), assert.AssertionError);
});

test('LOW (L1) looks up too; an unknown risk or a missing configDir enables nothing', (t) => {
  const fx = fixture(t);
  makeRunner(fx, { risk: 'LOW' }).runner.runCheck('unit', 'npm test', 60000);
  const low = makeRunner(fx, { risk: 'LOW' });
  low.runner.runCheck('unit', 'npm test', 60000);
  assert.equal(low.calls.length, 0);

  const runner: any = new CR.VerificationContractRunner({ cwd: fx.root, env: ENV, exec: () => ({ status: 0, stdout: '', stderr: '' }) });
  runner.beginContract({ v0: false, reuse: true, registry: REGISTRY, riskLevel: 'NOPE', configDir: fx.configDir });
  assert.equal(runner.reuseContext, undefined);
  runner.beginContract({ v0: false, reuse: true, registry: REGISTRY, riskLevel: 'MEDIUM', configDir: undefined });
  assert.equal(runner.reuseContext, undefined);
  runner.beginContract({ v0: false, reuse: 'on', registry: REGISTRY, riskLevel: 'MEDIUM', configDir: fx.configDir });
  assert.equal(runner.reuseContext, undefined, 'only the boolean true enables reuse');
  runner.beginContract({ v0: false, reuse: true, registry: REGISTRY, riskLevel: 'MEDIUM', configDir: fx.configDir });
  assert.equal(runner.reuseContext.enabled, true);
  assert.equal(runner.reuseContext.level, 'L2');
  assert.equal(runner.reuseContext.maxAgeMs, REGISTRY.policy.reuse.maxAgeMs);
  runner.beginContract({ v0: false, reuse: false, registry: REGISTRY, riskLevel: 'MEDIUM', configDir: fx.configDir });
  assert.equal(runner.reuseContext, undefined, 'a later contract with reuse off clears the context');
});

test('a FAIL is never stored: FAIL then PASS on the same key executes both, the third run reuses', (t) => {
  const fx = fixture(t);
  const failing = makeRunner(fx, { result: () => ({ status: 1, stdout: '# tests 4\n# fail 1\n', stderr: 'boom\n' }) });
  assert.equal(failing.runner.runCheck('unit', 'npm test', 60000).status, 'FAIL');
  assert.equal(storedRecords(fx).length, 0);
  const passing = makeRunner(fx);
  assert.equal(passing.runner.runCheck('unit', 'npm test', 60000).status, 'PASS');
  assert.equal(passing.calls.length, 1, 'the PASS after a FAIL executes');
  const third = makeRunner(fx);
  third.runner.runCheck('unit', 'npm test', 60000);
  assert.equal(third.calls.length, 0);
});

test('a changed tracked file, command or timeout misses; an unkeyable directory never stores or reuses', (t) => {
  const fx = fixture(t);
  makeRunner(fx).runner.runCheck('unit', 'npm test', 60000);
  for (const [command, timeout] of [['npm test ', 60000], ['npm test', 60001]]) {
    const other = makeRunner(fx);
    other.runner.runCheck('unit', command, timeout);
    assert.equal(other.calls.length, 1, `${JSON.stringify(command)} ${timeout} executes`);
  }
  fs.writeFileSync(path.join(fx.root, 'src', 'a.js'), 'module.exports = 2;\n');
  const edited = makeRunner(fx);
  edited.runner.runCheck('unit', 'npm test', 60000);
  assert.equal(edited.calls.length, 1, 'an uncommitted edit changes the key');

  const plain: any = { root: tempDir(t, 'doflow-reuse-nogit-') };
  plain.configDir = path.join(plain.root, '.doflow');
  for (let n = 0; n < 2; n++) {
    const { runner, calls } = makeRunner(plain);
    const result = runner.runCheck('unit', 'npm test', 60000);
    assert.equal(calls.length, 1, 'outside a git checkout every run executes');
    assert.equal(runner.metrics.get(result).checkKey, null, 'no treeState means no key, never the unavailable sentinel');
  }
  assert.equal(storedRecords(plain).length, 0);
});

test('a PASS whose output was elided in the report is stored whole and reused with the same excerpt', (t) => {
  const fx = fixture(t);
  const long = 'x'.repeat(5000) + '\n' + PASS_OUT;
  const first = makeRunner(fx, { result: () => ({ status: 0, stdout: long, stderr: '' }) });
  const executed = first.runner.runCheck('unit', 'npm test', 60000);
  assert.ok(executed.stdout.length > 2000, 'the report excerpt carries the elision marker');
  assert.equal(storedRecords(fx).length, 1);
  const second = makeRunner(fx, { result: () => { throw new Error('must not execute'); } });
  const reused = second.runner.runCheck('unit', 'npm test', 60000);
  assert.equal(reused.stdout, executed.stdout);
  assert.ok(reused.reused);
});

test('the stored record holds the report excerpt, its counts and the level, mode 0600', (t) => {
  const fx = fixture(t);
  const first = makeRunner(fx, { result: () => ({ status: 0, stdout: PASS_OUT, stderr: 'warn\n' }) });
  const executed = first.runner.runCheck('unit', 'npm test', 60000);
  const [file] = storedRecords(fx);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(record.level, 'L2');
  assert.equal(record.key, first.runner.metrics.get(executed).checkKey);
  assert.deepEqual(record.result, { status: 'PASS', exitCode: 0, stdout: executed.stdout, stderr: executed.stderr,
    truncated: false, tests: 4, testsFailed: 0 });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

// ── IC-004: environment, order ─────────────────────────────────────────────────────────────────

function assertEnvPassed(t: any, mod: any = CR) {
  const fx = fixture(t);
  const env: any = { ...ENV, REUSE_MARK: 'key-environment' };
  for (const risk of ['MEDIUM', 'HIGH']) {
    const { runner, calls } = makeRunner(fx, { mod, env, risk, result: () => ({ status: 1, stdout: '', stderr: '' }) });
    runner.runCheck('unit', 'npm test', 60000);
    assert.equal(calls[0].options.env, env, `${risk}: the executed command runs in the environment the key hashed`);
  }
}

test('reuse on: the executed command receives the runner environment the key was computed from', (t) => {
  assertEnvPassed(t);
});

test('negative control: omitting env when reuse is on turns the env-mismatch case red', (t) => {
  const mod = mutated('contract-runner.ts', [['this.inflightContext?.enabled || this.reuseStore ? { env: this.env }', 'this.inflightContext?.enabled ? { env: this.env }']]);
  assert.throws(() => assertEnvPassed(t, mod), assert.AssertionError);
});

/** A live V0 leader for the key holds a lock and has published its result: a follower would wait on it. */
function plantLeader(fx: any, key: any) {
  const dir = path.join(fx.configDir, 'state', 'verification', 'v0');
  const token = 'b'.repeat(32);
  const now = Date.now();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `inflight-${key}.lock`), JSON.stringify({ v: 1, token, pid: process.pid, startedAt: now, deadlineAt: now + 600000 }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, `inflight-${key}.${token}.result.json`),
    JSON.stringify({ v: 1, token, finishedAt: now + 60000, result: { status: 0, stdout: PASS_OUT, stderr: '' } }), { mode: 0o600 });
}

function assertLookupBeforeInflight(t: any, mod: any = CR) {
  const fx = fixture(t);
  const first = makeRunner(fx, { mod, v0: true });
  const executed = first.runner.runCheck('unit', 'npm test', 60000);
  plantLeader(fx, first.runner.metrics.get(executed).checkKey);
  const second = makeRunner(fx, { mod, v0: true });
  const result = second.runner.runCheck('unit', 'npm test', 60000);
  assert.equal(second.calls.length, 0);
  assert.equal(second.runner.metrics.get(result).shared, 'reused', 'a stored PASS answers before an in-flight leader is followed');
  assert.ok(result.reused);
  assert.equal(result.shared, undefined);
}

test('lookup runs before in-flight sharing: a stored PASS beats following a live leader', (t) => {
  assertLookupBeforeInflight(t);
});

test('negative control: placing the lookup after runInflight records follower instead of reused', (t) => {
  const lookup = '    const reusedResult = this.lookupReused(checkName, command, checkKeyVal, payloadDigest, startedAt);';
  const mod = mutated('contract-runner.ts', [
    [lookup, '    const reusedResult = null;'],
    ['        res = execute();\n      }', `        res = execute();\n      }\n      if (sharing.shared === 'none') { ${lookup.trim()} if (reusedResult) return reusedResult; }`],
  ]);
  assert.throws(() => assertLookupBeforeInflight(t, mod), assert.AssertionError);
});

// ── IC-005: the setting read ───────────────────────────────────────────────────────────────────

test('verify.reuse: only a valid resolved on gives true; env off, an invalid value, no config home give false', (t) => {
  const w = createSettingsEnv(t);
  const env = (extra: any = {}) => w.env({ DOFLOW_VERIFY_REUSE: undefined, ...extra });
  assert.equal(readVerifyReuse(env()), false, 'default off');
  w.writeUserSettings({ 'verify.reuse': 'on' });
  assert.equal(readVerifyReuse(env()), true, 'a user file saying on gives true');
  assert.equal(readVerifyReuse(env({ DOFLOW_VERIFY_REUSE: 'off' })), false, 'env off over a file on gives false');
  assert.equal(readVerifyReuse(env({ DOFLOW_VERIFY_REUSE: 'on' })), true, 'the env can only narrow');
  w.writeProjectSettings({ 'verify.reuse': 'on' });
  w.writeUserSettings({ 'verify.reuse': 'off' });
  assert.equal(readVerifyReuse(env()), false, 'global-only: a project file cannot turn it on');
  w.writeUserSettings({ 'verify.reuse': 'maybe' });
  assert.equal(readVerifyReuse(env()), false, 'an invalid value gives the fail-safe off');
  w.writeUserSettings({ 'verify.reuse': 'on' });
  assert.equal(readVerifyReuse({ PATH: process.env.PATH }), false, 'no config home gives off');
});

// Execute mutated modules in memory; no production file is edited. Each pair is applied once and
// must exist in the source.
function mutated(file: any, pairs: any) {
  const Module = require('node:module');
  const filename = path.join(REPO, 'src/runtime/verification', file);
  let source = fs.readFileSync(filename, 'utf8');
  for (const [before, after] of pairs) {
    assert.ok(source.includes(before), `mutation target exists: ${before}`);
    source = source.replace(before, after);
  }
  const instance: any = new Module(filename, module);
  instance.filename = filename;
  instance.paths = module.paths;
  instance._compile(Module.stripTypeScriptTypes(source), filename);
  return instance.exports;
}
