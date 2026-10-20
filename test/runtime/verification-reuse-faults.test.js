'use strict';

// 089 B.2 (IC-001, IC-003, IC-004, IC-005; FR-010): the fault-injection suite for reuse. After one
// stored PASS, each of the eight inputs the check key must see is changed ALONE and the next run
// must execute; the sibling control run, with nothing changed, must reuse. Every case runs through
// the contract runner and through the VerificationEngine (the verify engine's path), on a fixture
// git repository in a temp directory with an exec spy, so nothing real is spawned. Reuse is injected
// as the boolean `reuse: true` (never read from the user's settings). Negative controls run a
// check-key.ts with one payload entry removed, in memory, and show the matching case go red.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { loadVerificationRegistry } = require('../../src/runtime/verification/registry.ts');
const CR = require('../../src/runtime/verification/contract-runner.ts');
const { VerificationEngine } = require('../../src/runtime/verification/engine.ts');

const REPO = path.resolve(__dirname, '../..');
const KEY_FILE = path.join(REPO, 'src/runtime/verification/check-key.ts');
const REGISTRY = loadVerificationRegistry();
const PASS_OUT = '# tests 4\n# fail 0\n';
const FAIL_OUT = '# tests 4\n# fail 1\n';

function git(cwd, ...args) {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

/**
 * One fixture repository per case: a committed `src/a.js`, a `.gitignore` that ignores `.env`,
 * `node_modules/` and `dist/`, and the ignored files the cases change. `ctx.env` is the environment
 * the key hashes; its PATH starts with a directory holding a stub `node`, so the tool identity of
 * `node` is a file the case can change.
 */
function scene(t) {
  const root = tempDir(t, 'doflow-reuse-faults-');
  fs.writeFileSync(path.join(root, '.gitignore'), '.doflow/\nnode_modules/\ndist/\n.env\n.env.local\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  // Ignored files, created after the commit: a declared input (.env, node_modules/.package-lock.json)
  // and one the registry does not declare (dist/out.js).
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=one\n');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', '.package-lock.json'), '{"lockfileVersion":3}\n');
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'out.js'), 'built-one\n');
  const stubDir = tempDir(t, 'doflow-reuse-faults-path-');
  const stub = path.join(stubDir, 'node');
  fs.writeFileSync(stub, 'stub\n', { mode: 0o755 });
  return {
    fx: { root, configDir: path.join(root, '.doflow') },
    stub,
    command: 'npm test',
    env: { PATH: `${stubDir}${path.delimiter}${process.env.PATH}`, DOFLOW_TELEMETRY: 'off', REUSE_MARK: 'one' },
  };
}

/** The reuse records a fixture's runs wrote: every `reuse-*.json` under its config dir. */
function storedRecords(fx) {
  const found = [];
  (function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^reuse-[0-9a-f]{16}\.json$/.test(entry.name)) found.push(full);
    }
  })(fx.configDir);
  return found;
}

const passing = () => ({ status: 0, stdout: PASS_OUT, stderr: '' });

/** One check through a fresh contract runner: how many commands ran and whether the report says `reused`. */
function runnerDriver(ctx, { mod = CR, risk = 'MEDIUM', result = passing } = {}) {
  const calls = [];
  const runner = new mod.VerificationContractRunner({
    cwd: ctx.fx.root, env: ctx.env, logDir: path.join(ctx.fx.configDir, 'logs'),
    exec: (command, options) => { calls.push({ command, options }); return result(command, options); },
    context: { v0: false, reuse: true, registry: REGISTRY, riskLevel: risk, configDir: ctx.fx.configDir },
  });
  const report = runner.runCheck('unit', ctx.command, 60000);
  return { ran: calls.length, reused: report.reused !== undefined, status: report.status, report };
}

/** The same check through a fresh VerificationEngine, as the verify verb runs it. */
function engineDriver(ctx, { risk = 'MEDIUM', result = passing } = {}) {
  const calls = [];
  const engine = new VerificationEngine({ cwd: ctx.fx.root, configDir: ctx.fx.configDir, v0: false, reuse: true,
    exec: (command, options) => { calls.push(command); return result(command, options); } });
  engine.runner.env = ctx.env;
  const report = engine.runContract({ version: 1, taskId: 'reuse-faults', riskLevel: risk, tiers: [{
    id: 'broad-tests', name: 'Broad tests', kind: 'behavioral', required: true, resolution: 'RESOLVED',
    checks: [{ name: 'test:all', command: ctx.command, timeoutMs: 60000 }],
  }] });
  const check = report.tiers[0].checks[0];
  return { ran: calls.length, reused: check.reused !== undefined, status: check.status, report };
}

const DRIVERS = [['runner', runnerDriver], ['engine', engineDriver]];

// ── FR-010: the eight inputs, each changed alone ───────────────────────────────────────────────

const ENV_FILE = (ctx) => path.join(ctx.fx.root, '.env');
const LOCK_FILE = (ctx) => path.join(ctx.fx.root, 'node_modules', '.package-lock.json');

/**
 * `payload` names the check-key payload line whose removal must make the case red (the negative
 * control). `changes` run one after another; before each, the unchanged control must reuse.
 */
const INPUTS = [
  { name: 'a gitignored .env (declared input): edited, then a new line added', payload: '    inputsDig,\n', changes: [
    (ctx) => fs.writeFileSync(ENV_FILE(ctx), 'TOKEN=two\n'),
    (ctx) => fs.appendFileSync(ENV_FILE(ctx), 'EXTRA=1\n'),
  ] },
  { name: 'the size of the PATH node stub', payload: '    toolDig,\n', changes: [
    (ctx) => fs.writeFileSync(ctx.stub, 'stub, now a longer file\n'),
  ] },
  { name: 'node_modules/.package-lock.json (ignored by .gitignore, declared input)', payload: '    inputsDig,\n', changes: [
    (ctx) => fs.writeFileSync(LOCK_FILE(ctx), '{"lockfileVersion":3,"packages":{"x":1}}\n'),
  ] },
  { name: 'a new untracked file', payload: '    tree,\n', changes: [
    (ctx) => fs.writeFileSync(path.join(ctx.fx.root, 'src', 'new.js'), 'module.exports = 3;\n'),
  ] },
  { name: 'an edit of a tracked file', payload: '    tree,\n', changes: [
    (ctx) => fs.writeFileSync(path.join(ctx.fx.root, 'src', 'a.js'), 'module.exports = 2;\n'),
  ] },
  { name: 'a new commit (HEAD moves, the tree stays clean)', payload: '    head,\n', changes: [
    (ctx) => git(ctx.fx.root, 'commit', '--allow-empty', '-q', '-m', 'second'),
  ] },
  { name: 'an environment variable of the check environment', payload: '    envDig,\n', changes: [
    (ctx) => { ctx.env = { ...ctx.env, REUSE_MARK: 'two' }; },
  ] },
  { name: 'the command string', payload: '    command,\n', changes: [
    (ctx) => { ctx.command = 'npm test -- --changed'; },
  ] },
];

/**
 * A stored PASS, then per change: the control (nothing changed) reuses and spawns nothing, the
 * changed run executes and carries no `reused` label.
 */
function assertForcesExecution(input, driver, options = {}) {
  return (t) => {
    const ctx = scene(t);
    const seed = driver(ctx, options);
    assert.equal(seed.ran, 1, 'the seed run executes');
    assert.equal(seed.reused, false);
    assert.equal(seed.status, 'PASS');
    assert.equal(storedRecords(ctx.fx).length, 1, 'the executed PASS is stored');
    input.changes.forEach((change, n) => {
      const control = driver(ctx, options);
      assert.equal(control.ran, 0, `${input.name}, change ${n + 1}: the unchanged control spawns nothing`);
      assert.equal(control.reused, true, `${input.name}, change ${n + 1}: the unchanged control carries reused`);
      change(ctx);
      const changed = driver(ctx, options);
      assert.equal(changed.ran, 1, `${input.name}, change ${n + 1}: the changed run executes`);
      assert.equal(changed.reused, false, `${input.name}, change ${n + 1}: the changed run carries no reused label`);
      assert.equal(changed.status, 'PASS');
    });
    const last = driver(ctx, options);
    assert.equal(last.ran, 0, 'the changed run stored its own PASS: an unchanged rerun reuses it');
  };
}

for (const input of INPUTS) {
  for (const [label, driver] of DRIVERS) {
    test(`${label}: ${input.name} changed alone forces execution; its unchanged control reuses`,
      (t) => assertForcesExecution(input, driver)(t));
  }
}

// ── never reused ───────────────────────────────────────────────────────────────────────────────

for (const [label, driver] of DRIVERS) {
  test(`${label}: a stored FAIL is never reused: FAIL then an identical rerun executes, no record is written`, (t) => {
    const ctx = scene(t);
    const failing = { result: () => ({ status: 1, stdout: FAIL_OUT, stderr: 'boom\n' }) };
    const first = driver(ctx, failing);
    assert.equal(first.status, 'FAIL');
    assert.equal(first.ran, 1);
    assert.deepEqual(storedRecords(ctx.fx), [], 'a FAIL is not stored');
    const again = driver(ctx, failing);
    assert.equal(again.status, 'FAIL');
    assert.equal(again.ran, 1, 'an identical rerun after a FAIL executes');
    assert.equal(again.reused, false);
    assert.deepEqual(storedRecords(ctx.fx), []);
  });

  test(`${label}: HIGH (L3) executes even with a stored PASS on the same key`, (t) => {
    const ctx = scene(t);
    assert.equal(driver(ctx).ran, 1);
    assert.equal(storedRecords(ctx.fx).length, 1);
    const control = driver(ctx);
    assert.equal(control.ran, 0, 'control: MEDIUM reuses the stored PASS');
    assert.equal(control.reused, true);
    const high = driver(ctx, { risk: 'HIGH' });
    assert.equal(high.ran, 1, 'HIGH executes although a PASS is stored for the key');
    assert.equal(high.reused, false);
  });

  test(`${label}: an ignored file NOT in policy.reuse.ignoredInputs changing content does not invalidate (residual risk RK-1)`, (t) => {
    const ctx = scene(t);
    assert.equal(driver(ctx).ran, 1);
    // RK-1, documented not fixed: dist/out.js is ignored and undeclared, so only its NAME is in the
    // key. A content change is invisible to the key and the stored PASS is reused. This test pins
    // that boundary; if a later task widens the key, the assertion below is the one to revisit.
    assert.equal(REGISTRY.policy.reuse.ignoredInputs.includes('dist/out.js'), false);
    fs.writeFileSync(path.join(ctx.fx.root, 'dist', 'out.js'), 'built-two, different bytes\n');
    const after = driver(ctx);
    assert.equal(after.ran, 0, 'RK-1: an undeclared ignored file changing content still reuses');
    assert.equal(after.reused, true);
  });
}

// ── negative controls ──────────────────────────────────────────────────────────────────────────

/**
 * contract-runner.ts as the runner would load it if check-key.ts had one payload entry removed.
 * Executed in memory; no production file is edited. The mutated check-key.ts is swapped into the
 * require cache only while the mutated runner is compiled (it destructures `checkKeyV2` at load).
 */
function runnerWithoutPayloadLine(line) {
  const keyPath = KEY_FILE;
  const runnerPath = path.join(REPO, 'src/runtime/verification/contract-runner.ts');
  const keyMod = loadMutated(KEY_FILE, [[line, '']]);
  const cached = require.cache[keyPath];
  assert.ok(cached, 'check-key.ts is loaded, so its cache entry can be swapped');
  const original = cached.exports;
  cached.exports = keyMod;
  try {
    return loadMutated(runnerPath, []);
  } finally {
    cached.exports = original;
  }
}

function loadMutated(filename, pairs) {
  const Module = require('node:module');
  let source = fs.readFileSync(filename, 'utf8');
  for (const [before, after] of pairs) {
    assert.ok(source.includes(before), `mutation target exists: ${JSON.stringify(before)}`);
    source = source.replace(before, after);
  }
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = module.paths;
  instance._compile(Module.stripTypeScriptTypes(source), filename);
  return instance.exports;
}

test('negative control: the unmutated runner passes every input case (the controls below are not red for another reason)', (t) => {
  assertForcesExecution(INPUTS[2], runnerDriver, { mod: CR })(t);
});

for (const input of INPUTS) {
  test(`negative control: dropping the key's payload entry ${JSON.stringify(input.payload.trim())} turns "${input.name}" red`, (t) => {
    const mod = runnerWithoutPayloadLine(input.payload);
    assert.throws(() => assertForcesExecution(input, runnerDriver, { mod })(t), assert.AssertionError);
  });
}

test('negative control: the .package-lock.json case is the one inputsDig protects (the payload line exists in check-key.ts)', () => {
  const source = fs.readFileSync(KEY_FILE, 'utf8');
  assert.ok(source.includes('    inputsDig,\n    toolDig,'), 'the payload lists inputsDig before toolDig');
  assert.ok(REGISTRY.policy.reuse.ignoredInputs.includes('node_modules/.package-lock.json'));
  assert.ok(REGISTRY.policy.reuse.ignoredInputs.includes('.env'));
});
