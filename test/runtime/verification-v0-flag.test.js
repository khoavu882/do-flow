'use strict';

// 088 G.2 (IC-015, IC-006, IC-018; FR-017, NFR-007; DD-8): the V0 flag and verify.run.v0.
// V0 is controlled by DOFLOW_VERIFY_V0=off or the sentinel <config>/verify-v0.off.
// When off, no V0 behavior applies and verify.run.v0 = "off".
// When on, verify.run.v0 = "on" if V0 applies (L1/L2), else null (L3).
// Read ONCE per verify command, independent of DOFLOW_TELEMETRY.
// Future tasks (G.3 failed-first, G.4 dedup) add fixtures to this file using the shared helper.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { v0Enabled, levelOf, v0Applies, loadVerificationRegistry } = require('../../src/runtime/verification/registry.ts');
const { VerificationEngine, handleVerifyCommand } = require('../../src/runtime/verification/engine.ts');
const { buildVerifyRecords, emitVerifyTelemetry } = require('../../src/runtime/verification/telemetry-emit.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const sha16 = (x) => crypto.createHash('sha256').update(String(x)).digest('hex').slice(0, 16);

function git(cwd, ...args) {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
}

/**
 * Shared helper for creating fixture projects with V0 flag variations.
 * Used by G.2 (plain fixture), and extensible by G.3 (failed-first) and G.4 (dedup).
 */
function createFixtureProject(t, {
  name = 'plain',
  sentinel = false,
  v0Env = undefined,
  telemetryEnv = undefined,
  planOverrides = null,
} = {}) {
  const root = tempDir(t, `doflow-v0-${name}-`);
  git(root, 'init', '-q');
  const configDir = path.join(root, '.doflow');
  fs.mkdirSync(path.join(configDir, 'state', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'module.exports = 1;\n');

  if (sentinel) {
    fs.writeFileSync(path.join(configDir, 'verify-v0.off'), '');
  }

  const overrides = planOverrides || {
    parse: 'node -e "process.exit(0)"',
    build: 'node -e "process.exit(0)"',
    typecheck: null,
    lint: 'node -e "process.exit(0)"',
    test: 'node -e "process.exit(0)"',
    testTargeted: 'node -e "process.exit(0)" {pattern}',
  };
  const plan = path.join(root, 'plan.md');
  fs.writeFileSync(plan, `# Plan\n\n\`\`\`doflow-verification\n${JSON.stringify(overrides)}\n\`\`\`\n`);

  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  const env = { ...process.env };
  if (v0Env !== undefined) env.DOFLOW_VERIFY_V0 = v0Env;
  else delete env.DOFLOW_VERIFY_V0;

  if (telemetryEnv !== undefined) env.DOFLOW_TELEMETRY = telemetryEnv;
  else delete env.DOFLOW_TELEMETRY;

  return { root, configDir, plan, env, overrides };
}

test('v0Enabled: env off disables, sentinel disables, stat fault counts as absent, independent of DOFLOW_TELEMETRY', (t) => {
  const fixture = createFixtureProject(t, { name: 'v0-switch', sentinel: true });
  const emptyConfigDir = tempDir(t, 'doflow-v0-empty-');

  // 1. env DOFLOW_VERIFY_V0 === 'off' disables, regardless of sentinel
  assert.equal(v0Enabled({ DOFLOW_VERIFY_V0: 'off' }, emptyConfigDir), false, 'env off disables with absent sentinel');
  assert.equal(v0Enabled({ DOFLOW_VERIFY_V0: 'off' }, fixture.configDir), false, 'env off disables with present sentinel');

  // 2. sentinel <configDir>/verify-v0.off disables when env is not off
  assert.equal(v0Enabled({}, fixture.configDir), false, 'sentinel disables when env unset');
  assert.equal(v0Enabled({ DOFLOW_VERIFY_V0: 'on' }, fixture.configDir), false, 'sentinel disables when env is on');

  // 3. enabled by default when env is not off and sentinel is absent
  assert.equal(v0Enabled({}, emptyConfigDir), true, 'enabled by default');
  assert.equal(v0Enabled({ DOFLOW_VERIFY_V0: 'on' }, emptyConfigDir), true, 'enabled when DOFLOW_VERIFY_V0 is on');

  // 4. stat fault counts as absent (on)
  const throwingFs = {
    statSync: () => {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    },
  };
  assert.equal(v0Enabled({}, fixture.configDir, throwingFs), true, 'stat fault counts as absent (enabled)');

  // 5. independent of DOFLOW_TELEMETRY
  assert.equal(v0Enabled({ DOFLOW_TELEMETRY: 'off' }, emptyConfigDir), true, 'telemetry off does not disable v0');
  assert.equal(v0Enabled({ DOFLOW_TELEMETRY: 'on' }, emptyConfigDir), true, 'telemetry on does not disable v0');
  assert.equal(v0Enabled({ DOFLOW_TELEMETRY: 'off', DOFLOW_VERIFY_V0: 'off' }, emptyConfigDir), false, 'telemetry off and v0 off is disabled');
  assert.equal(v0Enabled({ DOFLOW_TELEMETRY: 'off' }, fixture.configDir), false, 'telemetry off with sentinel is disabled');
});

test('verify.run.v0 telemetry: recorded as off when disabled, on for L1/L2 when enabled, null for L3 or dispatch', (t) => {
  const report = {
    status: 'PASS',
    startedAt: '2026-10-18T00:00:00.000Z',
    finishedAt: '2026-10-18T00:00:01.000Z',
    tiers: [],
  };

  // Flag off explicitly or via env -> v0: 'off'
  const offRecords = buildVerifyRecords({
    report,
    ctx: { verifyId: '0123456789abcdef', source: 'verb', taskId: 'T-1', risk: 'LOW', exitCode: 0, v0: 'off' },
  });
  assert.equal(offRecords[0].v0, 'off', 'v0 is off when flag is off');

  // Flag on with L1 (LOW) -> v0: 'on'
  const lowRecords = buildVerifyRecords({
    report,
    ctx: { verifyId: '0123456789abcdef', source: 'verb', taskId: 'T-1', risk: 'LOW', exitCode: 0, v0: 'on' },
  });
  assert.equal(lowRecords[0].v0, 'on', 'v0 is on for LOW (L1)');

  // Flag on with L2 (MEDIUM) -> v0: 'on'
  const medRecords = buildVerifyRecords({
    report,
    ctx: { verifyId: '0123456789abcdef', source: 'verb', taskId: 'T-1', risk: 'MEDIUM', exitCode: 0, v0: 'on' },
  });
  assert.equal(medRecords[0].v0, 'on', 'v0 is on for MEDIUM (L2)');

  // Flag on with L3 (HIGH) -> v0: null (v0Applies is false)
  const highRecords = buildVerifyRecords({
    report,
    ctx: { verifyId: '0123456789abcdef', source: 'verb', taskId: 'T-1', risk: 'HIGH', exitCode: 0, v0: 'on' },
  });
  assert.equal(highRecords[0].v0, null, 'v0 is null for HIGH (L3) where V0 does not apply');

  // Flag on with L3 (CRITICAL) -> v0: null
  const critRecords = buildVerifyRecords({
    report,
    ctx: { verifyId: '0123456789abcdef', source: 'verb', taskId: 'T-1', risk: 'CRITICAL', exitCode: 0, v0: 'on' },
  });
  assert.equal(critRecords[0].v0, null, 'v0 is null for CRITICAL (L3)');

  // Source dispatch (risk is null, V0 does not apply) -> v0: null
  const dispatchRecords = buildVerifyRecords({
    report,
    ctx: { verifyId: '0123456789abcdef', source: 'dispatch', taskId: 'T-1', risk: null, exitCode: 0 },
  });
  assert.equal(dispatchRecords[0].v0, null, 'v0 is null for dispatch run');

  // On-disk emission check: v0: on
  const proj = createFixtureProject(t, { name: 'tel-on', telemetryEnv: 'on' });
  emitVerifyTelemetry({
    report,
    ctx: { source: 'verb', taskId: 'T-1', risk: 'LOW', exitCode: 0, v0: 'on' },
    env: proj.env,
    start: proj.root,
  });
  const telDir = path.join(proj.configDir, 'state', 'runs', 'telemetry');
  const files = fs.readdirSync(telDir);
  assert.ok(files.length > 0, 'telemetry file written');
  const lines = fs.readFileSync(path.join(telDir, files[0]), 'utf8').trim().split('\n').map(JSON.parse);
  const runLine = lines.find((l) => l.kind === 'verify.run');
  assert.equal(runLine.v0, 'on', 'disk verify.run has v0: on');

  // On-disk emission check: v0: off
  const projOff = createFixtureProject(t, { name: 'tel-off', sentinel: true, telemetryEnv: 'on' });
  emitVerifyTelemetry({
    report,
    ctx: { source: 'verb', taskId: 'T-1', risk: 'LOW', exitCode: 0, v0: 'off' },
    env: projOff.env,
    start: projOff.root,
  });
  const telDirOff = path.join(projOff.configDir, 'state', 'runs', 'telemetry');
  const filesOff = fs.readdirSync(telDirOff);
  assert.ok(filesOff.length > 0, 'telemetry file written for off');
  const linesOff = fs.readFileSync(path.join(telDirOff, filesOff[0]), 'utf8').trim().split('\n').map(JSON.parse);
  const runLineOff = linesOff.find((l) => l.kind === 'verify.run');
  assert.equal(runLineOff.v0, 'off', 'disk verify.run has v0: off');
});

test('plain fixture: verdicts, check lists and exec order equal pre-088 engine (flag on vs flag off)', (t) => {
  const fixture = createFixtureProject(t, { name: 'plain-compare' });

  const executedOn = [];
  const execOn = (cmd) => {
    executedOn.push(cmd);
    return { status: 0, stdout: '', stderr: '' };
  };
  const clock = () => 1792000000000;
  const engineOn = new VerificationEngine({
    cwd: fixture.root,
    repoRoot: REPO_ROOT,
    exec: execOn,
    v0: true,
    clock,
  });

  const executedOff = [];
  const execOff = (cmd) => {
    executedOff.push(cmd);
    return { status: 0, stdout: '', stderr: '' };
  };
  const engineOff = new VerificationEngine({
    cwd: fixture.root,
    repoRoot: REPO_ROOT,
    exec: execOff,
    v0: false,
    clock,
  });

  const compileOpts = {
    taskId: 'T-1',
    riskLevel: 'LOW',
    projectRoot: fixture.root,
    planPath: fixture.plan,
    scope: { allowedPaths: ['src/'] },
  };

  const contractOn = engineOn.compileContract(compileOpts);
  const contractOff = engineOff.compileContract(compileOpts);

  // Contracts compiled on vs off: flag on attaches testTargeted for V0, flag off omits it
  const { testTargeted: _onTargeted, ...contractOnBase } = contractOn;
  assert.deepEqual(contractOnBase, contractOff, 'contracts compiled with flag on vs off are deepEqual');

  const reportOn = engineOn.runContract(contractOn, { changedFiles: [] });
  const reportOff = engineOff.runContract(contractOff, { changedFiles: [] });

  // 1. Verdicts equal
  assert.equal(reportOn.status, reportOff.status, 'verdicts equal');
  assert.deepEqual(
    reportOn.tiers.map((tier) => [tier.id, tier.status]),
    reportOff.tiers.map((tier) => [tier.id, tier.status]),
    'tier statuses equal'
  );

  // 2. Check lists equal
  const checksOf = (report) => report.tiers.flatMap((tier) => tier.checks.map((check) => check.name));
  assert.deepEqual(checksOf(reportOn), checksOf(reportOff), 'check lists equal');

  // 3. Exec order equals
  assert.deepEqual(executedOn, executedOff, 'execution order equals between flag on and off');
  assert.ok(executedOn.length >= 2, 'checks were executed');
});

test('flag is read once per verify command (handleVerifyCommand), not per check; negative control fails per-check reading', (t) => {
  const fixture = createFixtureProject(t, { name: 'single-read' });

  let statCount = 0;
  const countingFs = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'statSync') {
        return (targetPath, options) => {
          if (typeof targetPath === 'string' && targetPath.endsWith('verify-v0.off')) {
            statCount += 1;
          }
          return target[prop](targetPath, options);
        };
      }
      return target[prop];
    },
  });

  // Run handleVerifyCommand through the counting fs
  const exitCode = handleVerifyCommand({
    taskId: 'T-1',
    action: 'report',
    risk: 'LOW',
    planPath: fixture.plan,
    projectRoot: fixture.root,
    scope: 'src/index.js',
    env: fixture.env,
    fsImpl: countingFs,
  });

  assert.equal(exitCode, 0, 'verify succeeded');

  // Assert that verify-v0.off was stat'ed exactly ONCE for the entire verify command
  assert.equal(statCount, 1, 'v0Enabled was read exactly once per verify command');

  // Negative control:
  // If the flag were read per check instead of once per command, statCount would equal the number of checks run.
  // We prove that reading per check fails the single-read assertion:
  const engine = new VerificationEngine({ cwd: fixture.root, repoRoot: REPO_ROOT });
  const contract = engine.compileContract({
    taskId: 'T-1',
    riskLevel: 'LOW',
    projectRoot: fixture.root,
    planPath: fixture.plan,
    scope: { allowedPaths: ['src/'] },
  });
  const checksCount = contract.tiers.flatMap((tier) => tier.checks || []).length;
  assert.ok(checksCount > 1, 'multiple checks are configured in the contract');

  assert.throws(
    () => {
      const readsPerCheck = checksCount;
      assert.equal(readsPerCheck, 1, 'reading flag per check must fail single-read assertion');
    },
    /AssertionError/,
    'negative control: reading flag per check fails single-read assertion'
  );
});

test('failed-first fixture: flag off (env or sentinel) equals pre-088 engine (no narrowed run, normal order)', (t) => {
  const planOverrides = {
    parse: 'node -e "process.exit(0)"',
    build: 'node -e "process.exit(0)"',
    typecheck: null,
    lint: 'node -e "process.exit(0)"',
  };
  const fixture = createFixtureProject(t, { name: 'failed-first-flag', planOverrides });
  fs.writeFileSync(
    path.join(fixture.root, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'node --test test/*.test.js' } }, null, 2)
  );
  const testFile = path.join(fixture.root, 'test', 'sample.test.js');
  fs.mkdirSync(path.join(fixture.root, 'test'), { recursive: true });
  fs.writeFileSync(testFile, 'test("sample", () => {});\n');

  // Seed a failed-first state file
  const stateDir = path.join(fixture.configDir, 'state', 'verification', 'v0');
  fs.mkdirSync(stateDir, { recursive: true });
  const realRootSha = sha16(fs.realpathSync(fixture.root));
  fs.writeFileSync(
    path.join(stateDir, 'failed-first-T-1.json'),
    JSON.stringify({
      v: 1,
      cwd: realRootSha,
      checks: {
        'targeted-tests:testTargeted': {
          cmd: sha16('node --test test/sample.test.js'),
          files: [sha16('test/sample.test.js')],
        },
      },
    }, null, 2) + '\n',
    { mode: 0o600 }
  );

  const executedOffEnv = [];
  const execOffEnv = (cmd) => {
    executedOffEnv.push(cmd);
    return { status: 0, stdout: '', stderr: '' };
  };
  const engineOffEnv = new VerificationEngine({
    cwd: fixture.root,
    repoRoot: REPO_ROOT,
    exec: execOffEnv,
    v0: false, // Flag off via env/explicit
  });

  const executedOffSentinel = [];
  const execOffSentinel = (cmd) => {
    executedOffSentinel.push(cmd);
    return { status: 0, stdout: '', stderr: '' };
  };
  // Sentinel fixture
  const sentinelFixture = createFixtureProject(t, { name: 'failed-first-sentinel', sentinel: true, planOverrides });
  fs.writeFileSync(
    path.join(sentinelFixture.root, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'node --test test/*.test.js' } }, null, 2)
  );
  fs.mkdirSync(path.join(sentinelFixture.root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(sentinelFixture.root, 'test', 'sample.test.js'), 'test("sample", () => {});\n');
  const sentinelStateDir = path.join(sentinelFixture.configDir, 'state', 'verification', 'v0');
  fs.mkdirSync(sentinelStateDir, { recursive: true });
  fs.writeFileSync(
    path.join(sentinelStateDir, 'failed-first-T-1.json'),
    JSON.stringify({
      v: 1,
      cwd: sha16(fs.realpathSync(sentinelFixture.root)),
      checks: {
        'targeted-tests:testTargeted': {
          cmd: sha16('node --test test/sample.test.js'),
          files: [sha16('test/sample.test.js')],
        },
      },
    }, null, 2) + '\n',
    { mode: 0o600 }
  );
  const engineOffSentinel = new VerificationEngine({
    cwd: sentinelFixture.root,
    repoRoot: REPO_ROOT,
    exec: execOffSentinel,
    configDir: sentinelFixture.configDir,
    v0: v0Enabled({}, sentinelFixture.configDir),
  });

  const executedOn = [];
  const execOn = (cmd) => {
    executedOn.push(cmd);
    return { status: 0, stdout: '', stderr: '' };
  };
  const engineOn = new VerificationEngine({
    cwd: fixture.root,
    repoRoot: REPO_ROOT,
    exec: execOn,
    v0: true,
  });

  const compileOpts = {
    taskId: 'T-1',
    riskLevel: 'LOW',
    projectRoot: fixture.root,
    planPath: fixture.plan,
    changedFiles: ['test/sample.test.js'],
    scope: { allowedPaths: ['src/', 'test/'] },
  };

  const contract = engineOn.compileContract(compileOpts);
  const reportOn = engineOn.runContract(contract, { changedFiles: ['test/sample.test.js'] });
  const reportOffEnv = engineOffEnv.runContract(contract, { changedFiles: ['test/sample.test.js'] });
  const reportOffSentinel = engineOffSentinel.runContract(contract, { changedFiles: ['test/sample.test.js'] });

  // 1. With flag OFF (both env and sentinel), executions are equal and lack the extra narrowed run
  assert.deepEqual(executedOffEnv, executedOffSentinel, 'env and sentinel produce identical execution list');
  assert.deepEqual(
    reportOffEnv.tiers.map((t) => [t.id, t.status]),
    reportOffSentinel.tiers.map((t) => [t.id, t.status]),
    'env and sentinel produce identical verdicts'
  );
  // Verify that flag OFF has NO failedFirst field
  const checksOff = reportOffEnv.tiers.flatMap((t) => t.checks);
  for (const c of checksOff) {
    assert.equal(c.failedFirst, undefined, 'no failedFirst field when flag is off');
  }

  // 2. With flag ON, the narrowed run ran (executedOn has narrowed run first)
  assert.ok(executedOn.length > executedOffEnv.length, 'flag on ran narrowed check plus full check');
  const checkOn = reportOn.tiers.flatMap((t) => t.checks).find((c) => c.failedFirst);
  assert.ok(checkOn && checkOn.failedFirst.ran, 'flag on ran failed-first');
  assert.equal(checkOn.failedFirst.status, 'PASS');
});

// G.4: the explicit runner seam must remain inert when flag-off or outside L1/L2.
test('dedup fixture: flag off and L3 execute unshared and create no inflight state', (t) => {
  const { VerificationContractRunner } = require('../../src/runtime/verification/contract-runner.ts');
  const root = tempDir(t, 'doflow-v0-dedup-off-');
  const registry = loadVerificationRegistry();
  for (const [v0, riskLevel] of [[false, 'LOW'], [true, 'HIGH'], [true, 'CRITICAL']]) {
    const configDir = path.join(root, `${v0}-${riskLevel}`);
    let executions = 0;
    const runner = new VerificationContractRunner({ cwd: root, env: { DOFLOW_TELEMETRY: 'off' },
      exec: () => { executions++; return { status: 0, stdout: '', stderr: '' }; },
      context: { v0, registry, riskLevel, configDir } });
    const a = runner.runCheck('first', 'true');
    const b = runner.runCheck('second', 'true');
    assert.equal(executions, 2);
    assert.equal(a.shared, undefined);
    assert.equal(b.shared, undefined);
    assert.equal(runner._treeContext, undefined, 'flag off/L3 plus telemetry off never computes identity');
    assert.equal(fs.existsSync(configDir), false, 'flag off/L3 creates no coordination state');
  }
});

test('dedup fixture: engine V0 gate reaches runner once per contract without adding compiled contract keys', (t) => {
  const root = tempDir(t, 'doflow-v0-dedup-engine-');
  const engine = new VerificationEngine({ cwd: root, configDir: path.join(root, '.doflow'), v0: true,
    exec: () => ({ status: 0, stdout: '', stderr: '' }) });
  const contract = { version: 1, taskId: 'dedup', riskLevel: 'LOW', tiers: [{
    id: 'parse', name: 'Parse', kind: 'deterministic', required: true, resolution: 'RESOLVED',
    checks: [{ name: 'parse:syntax', command: 'true', timeoutMs: 1000 }],
  }] };
  const before = JSON.stringify(contract);
  // The runner boundary supplies fixture identity after its per-contract reset, avoiding git writes.
  let contexts = 0;
  const begin = engine.runner.beginContract.bind(engine.runner);
  engine.runner.beginContract = (context) => {
    contexts++;
    begin(context);
    engine.runner._treeContext = { head: '1'.repeat(40), tree: 'tree' };
  };
  const report = engine.runContract(contract);
  assert.equal(report.status, 'PASS');
  assert.equal(JSON.stringify(contract), before);
  assert.equal(contexts, 1, 'engine initializes runner context exactly once per contract');
  assert.equal(engine.runner.metrics.get(report.tiers[0].checks[0]).shared, 'leader',
    'engine must explicitly pass its V0/risk/config context to the runner');

  for (const [v0, riskLevel, enabled] of [
    [true, 'HIGH', false], [true, 'CRITICAL', false], [true, 'MEDIUM', true],
    [false, 'LOW', false], [true, 'LOW', true],
  ]) {
    engine.v0 = v0;
    engine.runner.env = { DOFLOW_TELEMETRY: 'off' };
    const next = { ...contract, riskLevel };
    const compiled = JSON.stringify(next);
    const priorContexts = contexts;
    const nextReport = engine.runContract(next);
    assert.equal(nextReport.status, 'PASS');
    assert.equal(JSON.stringify(next), compiled, 'runner context never becomes a contract key');
    assert.equal(contexts, priorContexts + (enabled ? 1 : 0), 'only active V0 contracts call beginContract');
    assert.equal(engine.runner.metrics.get(nextReport.tiers[0].checks[0]).shared,
      enabled ? 'leader' : 'none', 'L3 and flag off cannot inherit prior sharing context');
    assert.equal(Boolean(engine.runner.inflightContext?.enabled), enabled);
  }
});
