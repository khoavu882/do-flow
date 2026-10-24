'use strict';

// 088 RE: verification owns the same main-checkout store as lifecycle/worker state, while
// commands still execute in the invoking checkout. A nested .doflow is never a store root.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { verifyStateRoot } = require('../../src/runtime/verification/engine.ts');

const CLI = path.resolve(__dirname, '../../bin/doflow.js');
const TASK = '905-demo';

function fixture(t, { failing = false, nested = false } = {}) {
  const root = tempDir(t, 'doflow-verify-linked-');
  const main = path.join(root, 'main');
  const home = path.join(root, 'home');
  fs.mkdirSync(main);
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'),
    DOFLOW_TELEMETRY: 'on', DOFLOW_VERIFY_V0: 'on' };
  for (const key of ['DOFLOW_CONFIG_DIR', 'DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT',
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'NODE_TEST_CONTEXT']) delete env[key];
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args],
      { cwd: main, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  };
  fs.writeFileSync(path.join(main, '.gitignore'), '.doflow/\n.ran\n');
  fs.writeFileSync(path.join(main, 'package.json'), JSON.stringify({ name: 'linked-fixture', version: '1.0.0',
    scripts: { test: 'node --test "test/*.test.js"' } }));
  fs.mkdirSync(path.join(main, 'test'));
  fs.writeFileSync(path.join(main, 'test/alpha.test.js'), "require('node:test').test('alpha', () => require('../check.cjs'));\n");
  fs.writeFileSync(path.join(main, 'check.cjs'), [
    "require('node:fs').appendFileSync('.ran', process.cwd() + '\\n');",
    `require('node:assert/strict').equal(${failing}, false);`,
  ].join('\n'));
  const commands = { parse: 'node -e 0', build: 'node -e 0', typecheck: null,
    lint: 'node -e 0' };
  fs.writeFileSync(path.join(main, 'plan.md'), `# Plan\n\n\`\`\`doflow-verification\n${JSON.stringify(commands)}\n\`\`\`\n`);
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'fixture');
  const configDir = path.join(main, '.doflow');
  fs.mkdirSync(path.join(configDir, 'state/runs'), { recursive: true });
  const linked = nested ? path.join(configDir, 'state/dispatch-worktrees/d-0123456789ab') : path.join(root, 'linked');
  git('worktree', 'add', '-q', '-b', `feat/${TASK}`, linked);
  return { main, linked, configDir, env };
}

function verify(f, extra = {}) {
  const result = spawnSync(process.execPath, [CLI, 'verify', '--task-id', TASK, '--risk', 'LOW',
    '--plan-path', path.join(f.main, 'plan.md'), '--scope', 'check.cjs,test/', '--json'],
  { cwd: f.linked, env: { ...f.env, ...extra }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.ok(result.stdout.trim().startsWith('{'), result.stderr || result.stdout);
  return { ...result, report: JSON.parse(result.stdout) };
}

function telemetry(configDir) {
  const dir = path.join(configDir, 'state/runs/telemetry');
  return fs.readdirSync(dir).filter((file) => file.endsWith('.jsonl'))
    .flatMap((file) => fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map((line) => JSON.parse(line)));
}

test('a passing verify from a sibling linked checkout stores inflight results and telemetry in main', (t) => {
  const f = fixture(t);
  assert.deepEqual(verifyStateRoot({ start: f.linked, env: f.env }), { configDir: f.configDir, projectRoot: f.main });
  for (let run = 1; run <= 2; run++) {
    const result = verify(f);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.report.status, 'PASS');
    assert.equal(fs.existsSync(path.join(f.linked, '.doflow/state')), false, 'no state fragment in linked checkout');
    assert.equal(telemetry(f.configDir).filter((line) => line.kind === 'verify.run').length, run);
    assert.ok(fs.readdirSync(path.join(f.configDir, 'state/verification/v0')).some((file) => /^inflight-.*\.result\.json$/.test(file)));
  }
  assert.deepEqual(fs.readFileSync(path.join(f.linked, '.ran'), 'utf8').trim().split('\n'), [f.linked, f.linked], 'checks execute in linked');
  assert.equal(fs.existsSync(path.join(f.main, '.ran')), false);
});

test('a failing verify keeps logs and failed-first state in main, keyed to the invoking checkout', (t) => {
  const f = fixture(t, { failing: true });
  const result = verify(f);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.report.status, 'FAIL');
  assert.equal(fs.existsSync(path.join(f.linked, '.doflow/state')), false);
  const logs = path.join(f.configDir, 'state/verification/logs');
  const failedCheck = result.report.tiers.flatMap((tier) => tier.checks).find((check) => check.status === 'FAIL');
  assert.ok(failedCheck, 'the behavioural check failed');
  assert.equal(path.dirname(failedCheck.logPath), logs);
  assert.match(fs.readFileSync(failedCheck.logPath, 'utf8'), /AssertionError/);
  const state = JSON.parse(fs.readFileSync(path.join(f.configDir, `state/verification/v0/failed-first-${TASK}.json`), 'utf8'));
  assert.equal(state.cwd, crypto.createHash('sha256').update(f.linked).digest('hex').slice(0, 16));
  const failedPath = crypto.createHash('sha256').update('test/alpha.test.js').digest('hex').slice(0, 16);
  assert.ok(Object.values(state.checks).some((check) => check.files.includes(failedPath)));
  assert.equal(telemetry(f.configDir).find((line) => line.kind === 'verify.run').status, 'FAIL');
});

test('a nested attempt delivery pack and planted ledger cannot capture verification state', (t) => {
  const f = fixture(t, { nested: true });
  const state = path.join(f.linked, '.doflow/state');
  fs.mkdirSync(path.join(state, 'delivery'), { recursive: true });
  fs.writeFileSync(path.join(state, 'delivery/A.1.json'), '{}\n');
  fs.mkdirSync(path.join(state, 'runs'));
  const result = verify(f);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(fs.readdirSync(state).sort(), ['delivery', 'runs']);
  assert.equal(fs.readFileSync(path.join(state, 'delivery/A.1.json'), 'utf8'), '{}\n');
  assert.deepEqual(fs.readdirSync(path.join(state, 'runs')), []);
  assert.equal(telemetry(f.configDir).filter((line) => line.kind === 'verify.run').length, 1);
});

test('an explicit store override and the main store V0 sentinel retain precedence from linked', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.configDir, 'verify-v0.off'), '');
  const disabled = verify(f);
  assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);
  assert.equal(fs.existsSync(path.join(f.configDir, 'state/verification/v0')), false);
  assert.equal(telemetry(f.configDir).find((line) => line.kind === 'verify.run').v0, 'off');
  const override = path.join(path.dirname(f.main), 'override', '.doflow');
  fs.mkdirSync(path.join(override, 'state/runs'), { recursive: true });
  assert.equal(verifyStateRoot({ start: f.linked, env: { ...f.env, DOFLOW_CONFIG_DIR: override } }).configDir, override);
  const enabled = verify(f, { DOFLOW_CONFIG_DIR: override });
  assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);
  assert.ok(fs.readdirSync(path.join(override, 'state/verification/v0')).some((file) => file.endsWith('.result.json')));
  assert.equal(telemetry(override).find((line) => line.kind === 'verify.run').v0, 'on');
  assert.equal(fs.existsSync(path.join(f.linked, '.doflow/state')), false);
});
