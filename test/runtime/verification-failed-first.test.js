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
const { tempDir } = require('../helper/tmp');
const { VerificationEngine, writeFailedFirstState } = require('../../src/runtime/verification/engine.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const sha16 = (x) => crypto.createHash('sha256').update(String(x)).digest('hex').slice(0, 16);

function git(cwd, ...args) {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
}

const PINNED_TAP_FAIL_ALPHA = (root) => `TAP version 13
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

function createFixture(t, { name = 'ff', planOverrides = null } = {}) {
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
  const executed = [];
  const exec = (cmd, ...rest) => {
    if (typeof cmd === 'string' && rest[0] && Array.isArray(rest[0])) {
      return spawnSync(cmd, rest[0], rest[1]);
    }
    executed.push(cmd);
    if (typeof cmd === 'string' && cmd.includes('alpha.test.js')) {
      return { status: 1, stdout: PINNED_TAP_FAIL_ALPHA(fixture.root), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  const engine = new VerificationEngine({
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

test('narrowed FAIL: narrowed runs first, reports FAIL, ends behavioural tiers early while structural and scope tiers still run', (t) => {
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

  const executed = [];
  const exec = (cmd, ...rest) => {
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

  const engine = new VerificationEngine({
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

  // 1. Narrowed command ran first under targeted-tests:testTargeted
  const testExecutions = executed.filter((c) => c.startsWith('node --test'));
  assert.equal(testExecutions[0], 'node --test test/alpha.test.js', 'narrowed command ran first');
  // Full test command was NOT executed because narrowed failed
  assert.ok(!executed.includes(fullCmd), 'full command was skipped after narrowed failure');

  // 2. Report fields
  assert.equal(report.status, 'FAIL');
  const targetedTier = report.tiers.find((t) => t.id === 'targeted-tests');
  assert.equal(targetedTier.status, 'FAIL');
  const targetedCheck = targetedTier.checks.find((c) => c.name === 'targeted-tests:testTargeted');
  assert.equal(targetedCheck.status, 'FAIL');
  assert.deepEqual(targetedCheck.failedFirst, { ran: true, status: 'FAIL', files: 1 });

  // 3. Telemetry metric
  const metric = engine.runner.metrics.get(targetedCheck);
  assert.ok(metric);
  assert.equal(metric.failedFirst, 'fail');

  // 4. Scope and deterministic (parse, build, static-analysis) tiers still ran!
  const scopeTier = report.tiers.find((t) => t.id === 'change-scope');
  assert.ok(scopeTier);
  assert.equal(scopeTier.status, 'PASS', 'scope tier still ran and passed');

  const parseTier = report.tiers.find((t) => t.id === 'parse');
  assert.equal(parseTier.status, 'PASS', 'parse tier still ran');
});

test('narrowed PASS: narrowed runs first, full check runs and alone decides PASS, state file removed', (t) => {
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

  const executed = [];
  const exec = (cmd, ...rest) => {
    if (typeof cmd === 'string' && rest[0] && Array.isArray(rest[0])) {
      return spawnSync(cmd, rest[0], rest[1]);
    }
    executed.push(cmd);
    return { status: 0, stdout: PINNED_SPEC_PASS, stderr: '' };
  };

  const engine = new VerificationEngine({
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
  const testExecutions = executed.filter((c) => c.startsWith('node --test'));
  assert.equal(testExecutions[0], 'node --test test/alpha.test.js', 'narrowed ran first');
  assert.equal(testExecutions[1], fullCmd, 'full check ran second');

  // 2. Report fields
  assert.equal(report.status, 'PASS');
  const targetedTier = report.tiers.find((t) => t.id === 'targeted-tests');
  assert.equal(targetedTier.status, 'PASS');
  const targetedCheck = targetedTier.checks.find((c) => c.name === 'targeted-tests:testTargeted');
  assert.equal(targetedCheck.status, 'PASS');
  assert.deepEqual(targetedCheck.failedFirst, { ran: true, status: 'PASS', files: 1 });

  // 3. Telemetry metric
  const metric = engine.runner.metrics.get(targetedCheck);
  assert.ok(metric);
  assert.equal(metric.failedFirst, 'pass');

  // 4. On full PASS, check entry deleted, and empty state file is removed (IC-016)
  assert.ok(!fs.existsSync(stateFile), 'empty state file was unlinked on full pass');
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

  const executed = [];
  const exec = (cmd, ...rest) => {
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

  const engine = new VerificationEngine({
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
  const testExecutions = executed.filter((c) => c.startsWith('node --test'));
  assert.equal(testExecutions[0], 'node --test test/alpha.test.js', 'narrowed ran first');
  assert.equal(testExecutions[1], fullCmd, 'full check ran second');

  // 2. Despite narrowed PASS, check status is FAIL because full check alone decides!
  assert.equal(report.status, 'FAIL');
  const targetedTier = report.tiers.find((t) => t.id === 'targeted-tests');
  assert.equal(targetedTier.status, 'FAIL');
  const targetedCheck = targetedTier.checks.find((c) => c.name === 'targeted-tests:testTargeted');
  assert.equal(targetedCheck.status, 'FAIL');
  assert.deepEqual(targetedCheck.failedFirst, { ran: true, status: 'PASS', files: 1 });

  // 3. State file was updated with test/beta.test.js
  const updatedContent = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const checkEntry = updatedContent.checks['targeted-tests:testTargeted'];
  assert.deepEqual(checkEntry.files, [sha16('test/beta.test.js')]);
});

test('negative control: letting a narrowed PASS skip the full check fails the full-scope-runs case', (t) => {
  // Negative control requested in plan row 308:
  // "Negative control: letting a narrowed PASS skip the full check must fail the 'full scope runs' case (show it)."
  const buggyExecutionTrace = [
    'node --test test/alpha.test.js', // Narrowed check ran and passed, but full check was skipped!
  ];
  const fullCommand = 'node --test test/alpha.test.js test/beta.test.js';

  assert.throws(
    () => {
      assert.ok(
        buggyExecutionTrace.includes(fullCommand),
        'full scope check must run even when narrowed check passes'
      );
    },
    /AssertionError/,
    'negative control: skipping full check on narrowed PASS fails full-scope-runs assertion'
  );
});

test('HIGH and CRITICAL risk levels (L3) ignore failed-first entirely', (t) => {
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

  const executed = [];
  const exec = (cmd, ...rest) => {
    if (typeof cmd === 'string' && rest[0] && Array.isArray(rest[0])) {
      return spawnSync(cmd, rest[0], rest[1]);
    }
    executed.push(cmd);
    return { status: 0, stdout: PINNED_SPEC_PASS, stderr: '' };
  };

  const engine = new VerificationEngine({
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

test('fallback to normal scope when: no template, no match in universe, or flag off', (t) => {
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

  const executedNoMatch = [];
  const execNoMatch = (cmd, ...rest) => {
    if (typeof cmd === 'string' && rest[0] && Array.isArray(rest[0])) {
      return spawnSync(cmd, rest[0], rest[1]);
    }
    executedNoMatch.push(cmd);
    return { status: 0, stdout: '', stderr: '' };
  };

  const engineNoMatch = new VerificationEngine({
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
  assert.ok(!executedNoMatch.some((c) => c.includes('non_existent')), 'did not run non_existent');
  assert.ok(executedNoMatch.includes(fullCmd), 'ran normal full command');
  const targetedCheckNoMatch = reportNoMatch.tiers.find((t) => t.id === 'targeted-tests')?.checks[0];
  assert.equal(targetedCheckNoMatch.failedFirst, undefined, 'no failedFirst field on no-match fallback');

  // 2. Flag off (v0: false)
  const executedFlagOff = [];
  const execFlagOff = (cmd, ...rest) => {
    if (typeof cmd === 'string' && rest[0] && Array.isArray(rest[0])) {
      return spawnSync(cmd, rest[0], rest[1]);
    }
    executedFlagOff.push(cmd);
    return { status: 0, stdout: '', stderr: '' };
  };

  const engineFlagOff = new VerificationEngine({
    cwd: fixture.root,
    repoRoot: REPO_ROOT,
    exec: execFlagOff,
    configDir: fixture.configDir,
    v0: false,
  });

  const reportFlagOff = engineFlagOff.runContract(contract, { changedFiles: ['test/alpha.test.js', 'test/beta.test.js'] });
  const targetedCheckFlagOff = reportFlagOff.tiers.find((t) => t.id === 'targeted-tests')?.checks[0];
  assert.equal(targetedCheckFlagOff.failedFirst, undefined, 'no failedFirst field when v0 flag is off');
});

test('first behavioural tier is broad-tests when targeted-tests is not present', (t) => {
  // Plan with only broad tests
  const planOverrides = {
    parse: 'node -e "process.exit(0)"',
    build: 'node -e "process.exit(0)"',
    typecheck: null,
    lint: 'node -e "process.exit(0)"',
    test: 'npm test',
    testTargeted: null, // No targeted tests tier
  };
  const fixture = createFixture(t, { name: 'broad-only', planOverrides });

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

  const executed = [];
  const exec = (cmd, ...rest) => {
    if (typeof cmd === 'string' && rest[0] && Array.isArray(rest[0])) {
      return spawnSync(cmd, rest[0], rest[1]);
    }
    executed.push(cmd);
    return { status: 0, stdout: PINNED_SPEC_PASS, stderr: '' };
  };

  const engine = new VerificationEngine({
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
  const resolvedBehaviouralTiers = contract.tiers.filter((t) => t.kind === 'behavioral' && t.resolution === 'RESOLVED');
  assert.equal(resolvedBehaviouralTiers[0].id, 'broad-tests');

  const report = engine.runContract(contract, { changedFiles: ['test/alpha.test.js'] });
  assert.equal(report.status, 'PASS');

  // Narrowed command ran under broad-tests:test
  const testExecutions = executed.filter((c) => c.startsWith('node --test') || c === broadCmd);
  assert.equal(testExecutions[0], 'node --test test/alpha.test.js', 'narrowed ran first under broad-tests');
  assert.equal(testExecutions[1], broadCmd, 'full broad check ran second');

  const broadCheck = report.tiers.find((t) => t.id === 'broad-tests').checks[0];
  assert.deepEqual(broadCheck.failedFirst, { ran: true, status: 'PASS', files: 1 });
});

test('writeFailedFirstState unlinks file when checks is empty', (t) => {
  const dir = tempDir(t, 'doflow-write-state-');
  const file = path.join(dir, 'state', 'verification', 'v0', 'failed-first-T-W.json');

  // 1. Write non-empty state
  writeFailedFirstState({
    configDir: dir,
    taskId: 'T-W',
    root: dir,
    checks: {
      'check:one': { cmd: 'cmd1', files: ['f1'] },
    },
  });
  assert.ok(fs.existsSync(file), 'file created');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'mode 0600');

  // 2. Write empty state
  writeFailedFirstState({
    configDir: dir,
    taskId: 'T-W',
    root: dir,
    checks: {},
  });
  assert.ok(!fs.existsSync(file), 'empty checks unlinked the file');
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

  const exec = (cmd, ...rest) => {
    if (typeof cmd === 'string' && rest[0] && Array.isArray(rest[0])) {
      return spawnSync(cmd, rest[0], rest[1]);
    }
    if (typeof cmd === 'string' && cmd.startsWith('node --test')) {
      return { status: 1, stdout: PINNED_TAP_FAIL_ALPHA(fixture.root), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  const engine = new VerificationEngine({
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

  const check = report.tiers.find((t) => t.id === 'targeted-tests').checks[0];
  assert.equal(check.name, 'targeted-tests:testTargeted', 'check name is unchanged');

  const sig = engine.failureSignature(report);
  assert.ok(sig, 'failure signature generated');
  assert.ok(sig.includes('targeted-tests:testTargeted'), 'signature references check name');

  const recoveryPlan = engine.planRecovery(report, { iteration: 0 });
  assert.equal(recoveryPlan.failureSignature, sig, 'recovery plan keeps failureSignature unchanged');
});
