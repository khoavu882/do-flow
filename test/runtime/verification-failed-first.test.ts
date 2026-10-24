'use strict';

// 088 G.3 (IC-007, IC-016, IC-018; plan row 308): failed-first execution order and state.
// INVARIANT: failed-first can only ever change the ORDER and add one cheap early narrowed run;
// the FULL check always runs and alone decides a PASS. A narrowed PASS must never let the full check
// be skipped; a narrowed FAIL ends the behavioural tiers early as FAIL (never as PASS);
// every fault anywhere in the feature falls back to the normal scope. HIGH/CRITICAL (L3) ignore it entirely.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { VerificationEngine } = require('../../src/runtime/verification/engine.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const sha16 = (x: any) => crypto.createHash('sha256').update(String(x)).digest('hex').slice(0, 16);

function mutatedEngine(before: any, after: any) {
  const Module = require('node:module');
  const filename = path.join(REPO_ROOT, 'src/runtime/verification/engine.ts');
  const source = fs.readFileSync(filename, 'utf8');
  assert.ok(source.includes(before), `mutation target exists: ${before}`);
  const instance: any = new Module(filename, module);
  instance.filename = filename;
  instance.paths = module.paths;
  instance._compile(Module.stripTypeScriptTypes(source.replace(before, after)), filename);
  return instance.exports;
}

function git(cwd: any, ...args: any[]) {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
}

const PINNED_TAP_FAIL_ALPHA = (root: any) => `TAP version 13
# Subtest: test alpha
not ok 1 - test alpha
  ---
  duration_ms: 1.5
  location: '${path.join(root, 'test', 'alpha.test.js')}:10:20'
  ...
1..1
# tests 1
# fail 1
`;

const PINNED_SPEC_FAIL_BETA = `✔ test alpha (1.5ms)
✖ test beta (2.1ms)
  Error: assertion failed
✖ failing tests:
test at test/beta.test.js:20:10
ℹ tests 2
ℹ fail 1
`;

const PINNED_SPEC_PASS = `✔ test alpha (1.5ms)
✔ test beta (2.1ms)
ℹ tests 2
ℹ pass 2
`;

function createFixture(t: any, { name = 'ff', planOverrides = null }: any = {}) {
  const root = tempDir(t, `doflow-ff-${name}-`);
  git(root, 'init', '-q');
  const configDir = path.join(root, '.doflow');
  fs.mkdirSync(path.join(configDir, 'state', 'verification', 'v0'), { recursive: true });
  fs.mkdirSync(path.join(configDir, 'state', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'module.exports = 1;\n');

  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test', 'alpha.test.js'), '// alpha\n');
  fs.writeFileSync(path.join(root, 'test', 'beta.test.js'), '// beta\n');

  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture',
        scripts: { test: 'node --test "test/**/*.test.js"' },
      },
      null,
      2
    )
  );

  const overrides = planOverrides || {
    parse: 'node -e "process.exit(0)"',
    build: 'node -e "process.exit(0)"',
    typecheck: null,
    lint: 'node -e "process.exit(0)"',
  };
  const plan = path.join(root, 'plan.md');
  fs.writeFileSync(plan, `# Plan\n\n\`\`\`doflow-verification\n${JSON.stringify(overrides)}\n\`\`\`\n`);

  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');

  return { root, configDir, plan };
}

test('initial run failure writes state file mode 0600 with sha16 cwd and files', (t) => {
  const fixture = createFixture(t, { name: 'init-fail' });
  const executed: any = [];
  const exec = (cmd: any, ...rest: any[]) => {
    if (typeof cmd === 'string' && rest[0] && Array.isArray(rest[0])) {
      return spawnSync(cmd, rest[0], rest[1]);
    }
    executed.push(cmd);
    if (typeof cmd === 'string' && cmd.includes('alpha.test.js')) {
      return { status: 1, stdout: PINNED_TAP_FAIL_ALPHA(fixture.root), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  const engine: any = new VerificationEngine({
    cwd: fixture.root,
    repoRoot: REPO_ROOT,
    exec,
    configDir: fixture.configDir,
    v0: true,
  });

  const contract = engine.compileContract({
    taskId: 'T-G3',
    riskLevel: 'LOW',
    projectRoot: fixture.root,
    planPath: fixture.plan,
    changedFiles: ['test/alpha.test.js'],
    scope: { allowedPaths: ['src/', 'test/'] },
  });

  const report = engine.runContract(contract, { changedFiles: ['test/alpha.test.js'] });
  assert.equal(report.status, 'FAIL');

  const stateFile = path.join(fixture.configDir, 'state', 'verification', 'v0', 'failed-first-T-G3.json');
  assert.ok(fs.existsSync(stateFile), 'state file was created');

  const stat = fs.statSync(stateFile);
  assert.equal(stat.mode & 0o777, 0o600, 'state file has mode 0600');

  const content = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(content.v, 1);
  assert.equal(content.cwd, sha16(fs.realpathSync(fixture.root)));
  const checkEntry = content.checks['targeted-tests:testTargeted'];
  assert.ok(checkEntry, 'check entry saved');
  assert.equal(checkEntry.cmd, sha16('node --test test/alpha.test.js'));
  assert.deepEqual(checkEntry.files, [sha16('test/alpha.test.js')]);
});

test('narrowed FAIL: narrowed runs first, reports FAIL, ends behavioural tiers early while structural and scope tiers still run', (t): any => {
  const fixture = createFixture(t, { name: 'narrowed-fail' });

  // Seed state file with test/alpha.test.js
  const stateFile = path.join(fixture.configDir, 'state', 'verification', 'v0', 'failed-first-T-G3.json');
  const fullCmd = 'node --test test/alpha.test.js test/beta.test.js';
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        v: 1,
        cwd: sha16(fs.realpathSync(fixture.root)),
        checks: {
          'targeted-tests:testTargeted': {
            cmd: sha16(fullCmd),
            files: [sha16('test/alpha.test.js')],
          },
        },
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );

  const executed: any = [];
  const exec = (cmd: any, ...rest: any[]) => {
    if (typeof cmd === 'string' && rest[0] && Array.isArray(rest[0])) {
      return spawnSync(cmd, rest[0], rest[1]);
    }
    executed.push(cmd);
    if (cmd === 'node --test test/alpha.test.js') {
      // Narrowed command fails
      return { status: 1, stdout: PINNED_TAP_FAIL_ALPHA(fixture.root), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  const engine: any = new VerificationEngine({
    cwd: fixture.root,
    repoRoot: REPO_ROOT,
    exec,
    configDir: fixture.configDir,
    v0: true,
  });

  const contract = engine.compileContract({
    taskId: 'T-G3',
    riskLevel: 'MEDIUM',
    projectRoot: fixture.root,
    planPath: fixture.plan,
    changedFiles: ['test/alpha.test.js', 'test/beta.test.js'],
    scope: { allowedPaths: ['src/', 'test/'] },
  });

  const report = engine.runContract(contract, { changedFiles: ['test/alpha.test.js', 'test/beta.test.js'] });

  // 1. Narrowed command ran first under targeted-tests:testTargeted
  const testExecutions = executed.filter((c: any) => c.startsWith('node --test'));
  assert.equal(testExecutions[0], 'node --test test/alpha.test.js', 'narrowed command ran first');
  // Full test command was NOT executed because narrowed failed
  assert.ok(!executed.includes(fullCmd), 'full command was skipped after narrowed failure');

  // 2. Report fields
  assert.equal(report.status, 'FAIL');
  const targetedTier = report.tiers.find((t: any) => t.id === 'targeted-tests');
  assert.equal(targetedTier.status, 'FAIL');
  const targetedCheck = targetedTier.checks.find((c: any) => c.name === 'targeted-tests:testTargeted');
  assert.equal(targetedCheck.status, 'FAIL');
  assert.deepEqual(targetedCheck.failedFirst, { ran: true, status: 'FAIL', files: 1 });

  const broadTier = report.tiers.find((t: any) => t.id === 'broad-tests');
  assert.equal(broadTier.status, 'NOT_RUN', 'later behavioural tier was halted');
  assert.equal(broadTier.reason, 'failed-first-still-failing');
  assert.ok(broadTier.checks.length > 0, 'the halted tier has a runnable check');
  for (const check of broadTier.checks) {
    assert.equal(check.status, 'NOT_RUN');
    assert.equal(check.reason, 'failed-first-still-failing');
    assert.ok(!executed.includes(check.command), 'halted behavioural command did not execute');
  }

  // 3. Telemetry metric
  const metric = engine.runner.metrics.get(targetedCheck);
  assert.ok(metric);
  assert.equal(metric.failedFirst, 'fail');

  // 4. Scope and deterministic (parse, build, static-analysis) tiers still ran!
  const scopeTier = report.tiers.find((t: any) => t.id === 'change-scope');
  assert.ok(scopeTier);
  assert.equal(scopeTier.status, 'PASS', 'scope tier still ran and passed');

  const parseTier = report.tiers.find((t: any) => t.id === 'parse');
  assert.equal(parseTier.status, 'PASS', 'parse tier still ran');
});

function assertNarrowedPassRunsFull(t: any, Engine: any = VerificationEngine) {
  const fixture = createFixture(t, { name: 'narrowed-pass' });

  // Seed state file with test/alpha.test.js
  const stateFile = path.join(fixture.configDir, 'state', 'verification', 'v0', 'failed-first-T-G3.json');
  const fullCmd = 'node --test test/alpha.test.js test/beta.test.js';
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        v: 1,
        cwd: sha16(fs.realpathSync(fixture.root)),
        checks: {
          'targeted-tests:testTargeted': {
            cmd: sha16(fullCmd),
            files: [sha16('test/alpha.test.js')],
          },
        },
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );

  const executed: any = [];
  const exec = (cmd: any, ...rest: any[]) => {
    if (typeof cmd === 'string' && rest[0] && Array.isArray(rest[0])) {
      return spawnSync(cmd, rest[0], rest[1]);
    }
    executed.push(cmd);
    return { status: 0, stdout: PINNED_SPEC_PASS, stderr: '' };
  };

  const engine: any = new Engine({
    cwd: fixture.root,
    repoRoot: REPO_ROOT,
    exec,
    configDir: fixture.configDir,
    v0: true,
  });

  const contract = engine.compileContract({
    taskId: 'T-G3',
    riskLevel: 'LOW',
    projectRoot: fixture.root,
    planPath: fixture.plan,
    changedFiles: ['test/alpha.test.js', 'test/beta.test.js'],
    scope: { allowedPaths: ['src/', 'test/'] },
  });

  const report = engine.runContract(contract, { changedFiles: ['test/alpha.test.js', 'test/beta.test.js'] });

  // 1. Both narrowed and full commands ran, in order
  const testExecutions = executed.filter((c: any) => c.startsWith('node --test'));
  assert.equal(testExecutions[0], 'node --test test/alpha.test.js', 'narrowed ran first');
  assert.equal(testExecutions[1], fullCmd, 'full check ran second');

  // 2. Report fields
  assert.equal(report.status, 'PASS');
  const targetedTier = report.tiers.find((t: any) => t.id === 'targeted-tests');
  assert.equal(targetedTier.status, 'PASS');
  const targetedCheck = targetedTier.checks.find((c: any) => c.name === 'targeted-tests:testTargeted');
  assert.equal(targetedCheck.status, 'PASS');
  assert.deepEqual(targetedCheck.failedFirst, { ran: true, status: 'PASS', files: 1 });

  // 3. Telemetry metric
  const metric = engine.runner.metrics.get(targetedCheck);
  assert.ok(metric);
  assert.equal(metric.failedFirst, 'pass');

  // 4. On full PASS, check entry deleted, and empty state file is removed (IC-016)
  assert.ok(!fs.existsSync(stateFile), 'empty state file was unlinked on full pass');
}

test('narrowed PASS: narrowed runs first, full check runs and alone decides PASS, state file removed', (t) => {
  assertNarrowedPassRunsFull(t);
});

test('invariant: narrowed PASS but full check FAILS -> verdict is FAIL, full check alone decides', (t) => {
  const fixture = createFixture(t, { name: 'narrowed-pass-full-fail' });

  // Seed state file with test/alpha.test.js
  const stateFile = path.join(fixture.configDir, 'state', 'verification', 'v0', 'failed-first-T-G3.json');
  const fullCmd = 'node --test test/alpha.test.js test/beta.test.js';
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        v: 1,
        cwd: sha16(fs.realpathSync(fixture.root)),
        checks: {
          'targeted-tests:testTargeted': {
            cmd: sha16(fullCmd),
            files: [sha16('test/alpha.test.js')],
          },
        },
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );

  const executed: any = [];
  const exec = (cmd: any, ...rest: any[]) => {
    if (typeof cmd === 'string' && rest[0] && Array.isArray(rest[0])) {
      return spawnSync(cmd, rest[0], rest[1]);
    }
    executed.push(cmd);
    if (cmd === 'node --test test/alpha.test.js') {
      // Narrowed passes!
      return { status: 0, stdout: PINNED_SPEC_PASS, stderr: '' };
    }
    if (cmd === fullCmd) {
      // Full suite fails because beta failed!
      return { status: 1, stdout: PINNED_SPEC_FAIL_BETA, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  const engine: any = new VerificationEngine({
    cwd: fixture.root,
    repoRoot: REPO_ROOT,
    exec,
    configDir: fixture.configDir,
    v0: true,
  });

  const contract = engine.compileContract({
    taskId: 'T-G3',
    riskLevel: 'LOW',
    projectRoot: fixture.root,
    planPath: fixture.plan,
    changedFiles: ['test/alpha.test.js', 'test/beta.test.js'],
    scope: { allowedPaths: ['src/', 'test/'] },
  });

  const report = engine.runContract(contract, { changedFiles: ['test/alpha.test.js', 'test/beta.test.js'] });

  // 1. Both ran in order
  const testExecutions = executed.filter((c: any) => c.startsWith('node --test'));
  assert.equal(testExecutions[0], 'node --test test/alpha.test.js', 'narrowed ran first');
  assert.equal(testExecutions[1], fullCmd, 'full check ran second');

  // 2. Despite narrowed PASS, check status is FAIL because full check alone decides!
  assert.equal(report.status, 'FAIL');
  const targetedTier = report.tiers.find((t: any) => t.id === 'targeted-tests');
  assert.equal(targetedTier.status, 'FAIL');
  const targetedCheck = targetedTier.checks.find((c: any) => c.name === 'targeted-tests:testTargeted');
  assert.equal(targetedCheck.status, 'FAIL');
  assert.deepEqual(targetedCheck.failedFirst, { ran: true, status: 'PASS', files: 1 });

  // 3. State file was updated with test/beta.test.js
  const updatedContent = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const checkEntry = updatedContent.checks['targeted-tests:testTargeted'];
  assert.deepEqual(checkEntry.files, [sha16('test/beta.test.js')]);
});

test('negative control: letting a narrowed PASS skip the full check fails the full-scope-runs case', (t) => {
  const mutant = mutatedEngine(
    'const fullResult = this.runner.runCheck(check.name, check.command, check.timeoutMs, dedupeCache);',
    'const fullResult = narrowedResult;'
  );
  assert.throws(
    () => assertNarrowedPassRunsFull(t, mutant.VerificationEngine),
    { code: 'ERR_ASSERTION', message: /full check ran second/ },
    'the real engine mutant fails the same full-scope execution assertion'
  );
});

test('HIGH and CRITICAL risk levels (L3) ignore failed-first entirely', (t): any => {
  const fixture = createFixture(t, { name: 'high-risk' });

  // Seed state file
  const stateFile = path.join(fixture.configDir, 'state', 'verification', 'v0', 'failed-first-T-G3.json');
  const fullCmd = 'node --test test/alpha.test.js test/beta.test.js';
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        v: 1,
        cwd: sha16(fs.realpathSync(fixture.root)),
        checks: {
          'targeted-tests:testTargeted': {
            cmd: sha16(fullCmd),
            files: [sha16('test/alpha.test.js')],
          },
        },
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );

  const executed: any = [];
  const exec = (cmd: any, ...rest: any[]) => {
    if (typeof cmd === 'string' && rest[0] && Array.isArray(rest[0])) {
      return spawnSync(cmd, rest[0], rest[1]);
    }
    executed.push(cmd);
    return { status: 0, stdout: PINNED_SPEC_PASS, stderr: '' };
  };

  const engine: any = new VerificationEngine({
    cwd: fixture.root,
    repoRoot: REPO_ROOT,
    exec,
    configDir: fixture.configDir,
    v0: true,
  });

  const contract = engine.compileContract({
    taskId: 'T-G3',
    riskLevel: 'HIGH', // L3
    projectRoot: fixture.root,
    planPath: fixture.plan,
    changedFiles: ['test/alpha.test.js', 'test/beta.test.js'],
    scope: { allowedPaths: ['src/', 'test/'] },
  });

  const report = engine.runContract(contract, { changedFiles: ['test/alpha.test.js', 'test/beta.test.js'] });

  // Narrowed command was NOT executed
  assert.ok(!executed.includes('node --test test/alpha.test.js'), 'narrowed command was not run');
  assert.ok(executed.includes(fullCmd), 'full command ran normally');

  // No failedFirst field on any check
  for (const tier of report.tiers) {
    for (const check of tier.checks) {
      assert.equal(check.failedFirst, undefined, 'no failedFirst field on check for HIGH risk');
    }
  }
});

test('fallback to normal scope when: no template, no match in universe, or flag off', (t): any => {
  const fixture = createFixture(t, { name: 'fallbacks' });

  // 1. No match in universe: state file contains hash of deleted or non-matching file
  const stateFile = path.join(fixture.configDir, 'state', 'verification', 'v0', 'failed-first-T-G3.json');
  const fullCmd = 'node --test test/alpha.test.js test/beta.test.js';
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        v: 1,
        cwd: sha16(fs.realpathSync(fixture.root)),
        checks: {
          'targeted-tests:testTargeted': {
            cmd: sha16(fullCmd),
            files: [sha16('test/non_existent.test.js')],
          },
        },
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );

  const executedNoMatch: any = [];
  const execNoMatch = (cmd: any, ...rest: any[]) => {
    if (typeof cmd === 'string' && rest[0] && Array.isArray(rest[0])) {
      return spawnSync(cmd, rest[0], rest[1]);
    }
    executedNoMatch.push(cmd);
    return { status: 0, stdout: '', stderr: '' };
  };

  const engineNoMatch: any = new VerificationEngine({
    cwd: fixture.root,
    repoRoot: REPO_ROOT,
    exec: execNoMatch,
    configDir: fixture.configDir,
    v0: true,
  });

  const contract = engineNoMatch.compileContract({
    taskId: 'T-G3',
    riskLevel: 'LOW',
    projectRoot: fixture.root,
    planPath: fixture.plan,
    changedFiles: ['test/alpha.test.js', 'test/beta.test.js'],
    scope: { allowedPaths: ['src/', 'test/'] },
  });

  const reportNoMatch = engineNoMatch.runContract(contract, { changedFiles: ['test/alpha.test.js', 'test/beta.test.js'] });
  assert.ok(!executedNoMatch.some((c: any) => c.includes('non_existent')), 'did not run non_existent');
  assert.ok(executedNoMatch.includes(fullCmd), 'ran normal full command');
  const targetedCheckNoMatch = reportNoMatch.tiers.find((t: any) => t.id === 'targeted-tests')?.checks[0];
  assert.equal(targetedCheckNoMatch.failedFirst, undefined, 'no failedFirst field on no-match fallback');

  // 2. Flag off (v0: false)
  const executedFlagOff: any = [];
  const execFlagOff = (cmd: any, ...rest: any[]) => {
    if (typeof cmd === 'string' && rest[0] && Array.isArray(rest[0])) {
      return spawnSync(cmd, rest[0], rest[1]);
    }
    executedFlagOff.push(cmd);
    return { status: 0, stdout: '', stderr: '' };
  };

  const engineFlagOff: any = new VerificationEngine({
    cwd: fixture.root,
    repoRoot: REPO_ROOT,
    exec: execFlagOff,
    configDir: fixture.configDir,
    v0: false,
  });

  const reportFlagOff = engineFlagOff.runContract(contract, { changedFiles: ['test/alpha.test.js', 'test/beta.test.js'] });
  const targetedCheckFlagOff = reportFlagOff.tiers.find((t: any) => t.id === 'targeted-tests')?.checks[0];
  assert.equal(targetedCheckFlagOff.failedFirst, undefined, 'no failedFirst field when v0 flag is off');
});

test('plan testTargeted:null prevents package-template narrowing and passes on the first run', (t) => {
  // Plan with only broad tests
  const planOverrides: any = {
    parse: 'node -e "process.exit(0)"',
    build: 'node -e "process.exit(0)"',
    typecheck: null,
    lint: 'node -e "process.exit(0)"',
    test: 'npm test',
    testTargeted: null, // No targeted tests tier
  };
  const fixture: any = createFixture(t, { name: 'broad-only', planOverrides });

  const broadCmd = 'npm test';
  const stateFile = path.join(fixture.configDir, 'state', 'verification', 'v0', 'failed-first-T-G3.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        v: 1,
        cwd: sha16(fs.realpathSync(fixture.root)),
        checks: {
          'broad-tests:test': {
            cmd: sha16(broadCmd),
            files: [sha16('test/alpha.test.js')],
          },
        },
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );

  const executed: any = [];
  const exec = (cmd: any, ...rest: any[]) => {
    if (typeof cmd === 'string' && rest[0] && Array.isArray(rest[0])) {
      return spawnSync(cmd, rest[0], rest[1]);
    }
    executed.push(cmd);
    if (cmd.startsWith('node --test')) {
      return { status: 1, stdout: PINNED_TAP_FAIL_ALPHA(fixture.root), stderr: '' };
    }
    return { status: 0, stdout: PINNED_SPEC_PASS, stderr: '' };
  };

  const engine: any = new VerificationEngine({
    cwd: fixture.root,
    repoRoot: REPO_ROOT,
    exec,
    configDir: fixture.configDir,
    v0: true,
  });

  const contract = engine.compileContract({
    taskId: 'T-G3',
    riskLevel: 'MEDIUM', // Broad tests required at MEDIUM
    projectRoot: fixture.root,
    planPath: fixture.plan,
    changedFiles: ['test/alpha.test.js'],
    scope: { allowedPaths: ['src/', 'test/'] },
  });

  // Verify contract has broad-tests as resolved behavioural tier (targeted-tests is subsumed)
  const resolvedBehaviouralTiers = contract.tiers.filter((t: any) => t.kind === 'behavioral' && t.resolution === 'RESOLVED');
  assert.equal(resolvedBehaviouralTiers[0].id, 'broad-tests');
  assert.equal(contract.testTargeted, null, 'the plan explicitly disables the template');

  const report = engine.runContract(contract, { changedFiles: ['test/alpha.test.js'] });
  assert.equal(report.status, 'PASS');

  // The plan's null remains authoritative even though package.json supplies a template.
  const testExecutions = executed.filter((c: any) => c.startsWith('node --test') || c === broadCmd);
  assert.deepEqual(testExecutions, [broadCmd], 'only the full broad check ran');

  const broadCheck = report.tiers.find((t: any) => t.id === 'broad-tests').checks[0];
  assert.equal(broadCheck.failedFirst, undefined, 'the package template did not bypass the plan');
  assert.ok(!fs.existsSync(stateFile), 'the full PASS cleared the saved failure');
});

function createRecoverySequence(t: any): any {
  const fixture: any = createFixture(t, { name: 'strikes', planOverrides: {
    parse: 'node -e "process.exit(0)"',
    build: 'node -e "process.exit(0)"',
    typecheck: null,
    lint: 'node -e "process.exit(0)"',
  } });
  const stateFile = path.join(fixture.configDir, 'state', 'verification', 'v0', 'failed-first-T-G3.json');
  return {
    stateFile,
    run(fullFails: any) {
      const executed: any = [];
      // Each verify gets a new engine: the retry count must survive on disk.
      const engine: any = new VerificationEngine({
        cwd: fixture.root, repoRoot: REPO_ROOT, configDir: fixture.configDir, v0: true,
        exec: (cmd: any, ...rest: any[]) => {
          if (Array.isArray(rest[0])) return spawnSync(cmd, rest[0], rest[1]);
          if (cmd === 'npm test' || cmd.startsWith('node --test')) {
            executed.push(cmd);
            // The file still fails alone after the full suite is fixed (missing suite setup).
            if (cmd !== 'npm test' || fullFails) {
              return { status: 1, stdout: PINNED_TAP_FAIL_ALPHA(fixture.root), stderr: '' };
            }
            return { status: 0, stdout: PINNED_SPEC_PASS, stderr: '' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      const changedFiles: any = ['src/index.js'];
      const contract = engine.compileContract({
        taskId: 'T-G3', riskLevel: 'MEDIUM', projectRoot: fixture.root, planPath: fixture.plan,
        changedFiles, scope: { allowedPaths: ['src/', 'test/'] },
      });
      assert.equal(contract.testTargeted.source, 'package.json', 'the template comes from the manifest');
      assert.equal(contract.tiers.find((tier: any) => tier.id === 'targeted-tests').resolution, 'SUBSUMED');
      const report = engine.runContract(contract, { changedFiles });
      return { report, executed };
    },
  };
}

test('saved narrowed failures yield FAIL, FAIL, PASS after the full suite is fixed', (t) => {
  const sequence = createRecoverySequence(t);
  const initial = sequence.run(true);
  assert.equal(initial.report.status, 'FAIL');
  assert.deepEqual(initial.executed, ['npm test'], 'an initial full failure seeds the entry');

  const statuses: any = [];
  const savedStrikes: any = [];
  const narrowedExecutions: any = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const next = sequence.run(false);
    statuses.push(next.report.status);
    narrowedExecutions.push(next.executed);
    const entry = JSON.parse(fs.readFileSync(sequence.stateFile, 'utf8')).checks['broad-tests:test'];
    savedStrikes.push(entry.strikes);
  }
  const full = sequence.run(false);
  statuses.push(full.report.status);
  assert.deepEqual(statuses, ['FAIL', 'FAIL', 'PASS']);
  assert.deepEqual(savedStrikes, [1, 2], 'narrowed failures accumulate across verifies');
  for (const executed of narrowedExecutions) {
    assert.deepEqual(executed, ['node --test test/alpha.test.js']);
  }
  assert.deepEqual(full.executed, ['npm test'], 'two strikes force the full scope');
  assert.ok(!fs.existsSync(sequence.stateFile), 'the full PASS removes stale failure state');
  const next = sequence.run(false);
  assert.equal(next.report.status, 'PASS');
  assert.deepEqual(next.executed, ['npm test'], 'later verifies stay at the full passing scope');
});

test('a full-scope failure replaces the two-strike entry and permits narrowing again', (t) => {
  const sequence = createRecoverySequence(t);
  assert.equal(sequence.run(true).report.status, 'FAIL');
  for (const strikes of [1, 2]) {
    const next = sequence.run(true);
    assert.equal(next.report.status, 'FAIL');
    assert.deepEqual(next.executed, ['node --test test/alpha.test.js']);
    assert.equal(JSON.parse(fs.readFileSync(sequence.stateFile, 'utf8')).checks['broad-tests:test'].strikes, strikes);
  }
  const full = sequence.run(true);
  assert.equal(full.report.status, 'FAIL');
  assert.deepEqual(full.executed, ['npm test']);
  const entry = JSON.parse(fs.readFileSync(sequence.stateFile, 'utf8')).checks['broad-tests:test'];
  assert.equal(entry.strikes ?? 0, 0, 'the full failure resets the narrowed retry count');
  assert.equal(entry.cmd, sha16('npm test'));
  assert.deepEqual(entry.files, [sha16('test/alpha.test.js')]);
  const next = sequence.run(true);
  assert.equal(next.report.status, 'FAIL');
  assert.deepEqual(next.executed, ['node --test test/alpha.test.js'], 'narrowing resumes after the full failure');
  assert.equal(JSON.parse(fs.readFileSync(sequence.stateFile, 'utf8')).checks['broad-tests:test'].strikes, 1);
});

test('check name and failureSignature are unchanged by failed-first (no recovery iteration added)', (t) => {
  const fixture = createFixture(t, { name: 'sig-recovery' });

  const fullCmd = 'node --test test/alpha.test.js';
  const stateFile = path.join(fixture.configDir, 'state', 'verification', 'v0', 'failed-first-T-G3.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        v: 1,
        cwd: sha16(fs.realpathSync(fixture.root)),
        checks: {
          'targeted-tests:testTargeted': {
            cmd: sha16(fullCmd),
            files: [sha16('test/alpha.test.js')],
          },
        },
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );

  const exec = (cmd: any, ...rest: any[]) => {
    if (typeof cmd === 'string' && rest[0] && Array.isArray(rest[0])) {
      return spawnSync(cmd, rest[0], rest[1]);
    }
    if (typeof cmd === 'string' && cmd.startsWith('node --test')) {
      return { status: 1, stdout: PINNED_TAP_FAIL_ALPHA(fixture.root), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  const engine: any = new VerificationEngine({
    cwd: fixture.root,
    repoRoot: REPO_ROOT,
    exec,
    configDir: fixture.configDir,
    v0: true,
  });

  const contract = engine.compileContract({
    taskId: 'T-G3',
    riskLevel: 'LOW',
    projectRoot: fixture.root,
    planPath: fixture.plan,
    changedFiles: ['test/alpha.test.js'],
    scope: { allowedPaths: ['src/', 'test/'] },
  });

  const report = engine.runContract(contract, { changedFiles: ['test/alpha.test.js'] });
  assert.equal(report.status, 'FAIL');

  const check = report.tiers.find((t: any) => t.id === 'targeted-tests').checks[0];
  assert.equal(check.name, 'targeted-tests:testTargeted', 'check name is unchanged');

  const sig = engine.failureSignature(report);
  assert.ok(sig, 'failure signature generated');
  assert.ok(sig.includes('targeted-tests:testTargeted'), 'signature references check name');

  const recoveryPlan = engine.planRecovery(report, { iteration: 0 });
  assert.equal(recoveryPlan.failureSignature, sig, 'recovery plan keeps failureSignature unchanged');
});
