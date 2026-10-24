'use strict';

// 120 C.6 (IC-014): enabled state is descriptive and never changes eligibility.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSettingsEnv, CLI } = require('../helper/settings-fixtures');
const { executeWorkerCommand } = require('../../src/runtime/worker/command.ts');
const { activeWorkers } = require('../../src/runtime/worker/active.ts');
const { workersDoctorView } = require('../../src/runtime/health.ts');
const readiness = require('../../src/runtime/worker/readiness.ts');
const DESCRIPTORS = require('../fixtures/worker/descriptors.json');

const FAKES = { claude: DESCRIPTORS.claude, gemini: DESCRIPTORS.gemini };
const NOW = Date.parse('2026-10-24T00:00:00Z');
const writeUser = (f: any, value: any) => f.writeUserSettings({ schema: 1, 'workers.enabled': value });

function options(f: any, extraEnv = {}) {
  return {
    descriptors: FAKES,
    env: f.env({
      PATH: '',
      DOFLOW_PRIMARY_HARNESS: undefined,
      DOFLOW_PRIMARY_MODEL: undefined,
      DOFLOW_SESSION_ROLE: undefined,
      ...extraEnv,
    }),
    cwd: f.project,
    now: () => new Date(NOW),
  };
}

async function describeBody(t: any, f: any, harness: any, extraEnv: any = {}) {
  const before = process.exitCode;
  t.after(() => { process.exitCode = before; });
  const result = await executeWorkerCommand({
    ...options(f, extraEnv), action: 'describe', harness,
  });
  assert.equal(result.exit, 0);
  assert.equal(result.body.disposition, 'described');
  assert.equal(result.body.harness, harness);
  assert.deepEqual(result.body.bindings, {
    light: { model: null, flag: 'n/a' },
    standard: { model: null, flag: 'n/a' },
    frontier: { model: null, flag: 'n/a' },
  });
  assert.deepEqual(result.body.active, activeWorkers({
    env: options(f, extraEnv).env, projectRoot: f.project,
  }));
  assert.deepEqual(Object.keys(result.body.active).sort(), [
    'dangling', 'inSession', 'narrowedFrom', 'origin', 'reason', 'state', 'workers',
  ]);
  return result.body;
}

function assertUnchanged(f: any, harness: any, body: any) {
  const baseline = readiness.describe({
    ...options(f), harness, root: f.project, now: () => NOW,
  });
  for (const key of ['requirements', 'eligible', 'declared', 'probe']) {
    assert.deepEqual(body[key], baseline[key], key);
  }
  for (const key of ['enabled', 'active', 'primary', 'bindings']) {
    assert.equal(Object.hasOwn(baseline, key), false, key);
  }
}

function assertDoctor(f: any, expected: any) {
  const env = options(f).env;
  const view = workersDoctorView({
    env, projectRoot: f.project, descriptors: FAKES, now: () => NOW,
  });
  const active = activeWorkers({ env, projectRoot: f.project });
  for (const key of ['state', 'origin', 'inSession', 'reason', 'dangling']) {
    assert.deepEqual(view[key], active[key], key);
  }
  assert.deepEqual(view.rows.map((row: any) => row.harness), ['claude', 'gemini']);
  assert.deepEqual(
    Object.fromEntries(view.rows.map((row: any) => [row.harness, row.enabled.state])),
    expected,
  );
  const baseline = readiness.select({
    ...options(f), root: f.project, now: () => NOW, needs: [],
  });
  for (const [index, row] of view.rows.entries()) {
    assert.deepEqual(row.enabled, readiness.enabledOf(active, row.harness));
    assert.equal(row.eligible, false);
    assert.equal(row.eligible, row.firstGap === null);
    assert.equal(typeof row.firstGap.requirement, 'string');
    assert.ok(row.firstGap.requirement.length > 0);
    assert.equal(row.eligible, baseline.candidates[index].eligible);
    assert.deepEqual(row.firstGap, baseline.candidates[index].gaps[0]);
    assert.deepEqual(Object.keys(row.firstGap).sort(), ['reason', 'requirement', 'result']);
    assert.equal(Object.hasOwn(row, 'bindings'), false);
    assert.deepEqual(row.bound, []);
  }
  return view;
}

function snapshot(dir: any) {
  return fs.readdirSync(dir).sort().flatMap((name: any) => {
    const file = path.join(dir, name);
    if (fs.lstatSync(file).isDirectory()) {
      return [[`${name}/`, null], ...snapshot(file).map(([child, value]: any) => [`${name}/${child}`, value])];
    }
    return [[name, fs.readFileSync(file, 'utf8')]];
  });
}

test('enabledOf follows IC-014 precedence and copies the origin', () => {
  const origin = { layer: 'user', source: '/fixture/settings.json' };
  const active = {
    state: 'set',
    workers: ['gemini', 'claude'],
    narrowedFrom: ['gemini', 'claude', 'codex', 'primary'],
    origin,
  };
  assert.deepEqual(readiness.enabledOf(active, 'claude'), {
    state: 'enabled', position: 2, origin,
  });
  assert.deepEqual(readiness.enabledOf(active, 'codex'), {
    state: 'disabled', position: null, origin,
  });
  assert.deepEqual(readiness.enabledOf(active, 'other'), {
    state: 'unlisted', position: null, origin,
  });
  assert.deepEqual(readiness.enabledOf({ ...active, state: 'unset' }, 'claude'), {
    state: 'default', position: null, origin,
  });
  assert.deepEqual(readiness.enabledOf({ ...active, state: 'invalid' }, 'claude'), {
    state: 'unlisted', position: null, origin,
  });
  const enabled = readiness.enabledOf(active, 'claude');
  assert.notStrictEqual(enabled.origin, origin);
  enabled.origin.layer = 'local';
  assert.equal(origin.layer, 'user');
});

test('unset describe and doctor show default state with the default origin', async (t) => {
  const f = createSettingsEnv(t);
  const body = await describeBody(t, f, 'claude');
  assert.deepEqual(body.enabled, {
    state: 'default',
    position: null,
    origin: { layer: 'default', source: 'core/registry/settings.json' },
  });
  assert.equal(body.active.state, 'unset');
  assert.equal(typeof body.primary.state, 'string');
  assertUnchanged(f, 'claude', body);
  assertDoctor(f, { claude: 'default', gemini: 'default' });
});

test('enabled describe and doctor use effective worker order for positions', async (t) => {
  const f = createSettingsEnv(t);
  const source = writeUser(f, ['gemini', 'claude', 'primary']);
  const claude = await describeBody(t, f, 'claude');
  const gemini = await describeBody(t, f, 'gemini');
  assert.deepEqual(claude.enabled, {
    state: 'enabled', position: 2, origin: { layer: 'user', source },
  });
  assert.deepEqual(gemini.enabled, {
    state: 'enabled', position: 1, origin: { layer: 'user', source },
  });
  assert.equal(claude.active.inSession, true);
  assert.deepEqual(claude.active.workers, ['gemini', 'claude']);
  assertDoctor(f, { claude: 'enabled', gemini: 'enabled' });
});

test('project and local narrowing show disabled without filtering eligibility', async (t) => {
  const f = createSettingsEnv(t);
  const user = ['claude', 'gemini', 'primary'];
  writeUser(f, user);
  const source = f.writeProjectSettings({
    schema: 1, 'workers.enabled': ['gemini', 'primary'],
  });
  const claude = await describeBody(t, f, 'claude');
  const gemini = await describeBody(t, f, 'gemini');
  assert.deepEqual(claude.enabled, {
    state: 'disabled', position: null, origin: { layer: 'project', source },
  });
  assert.deepEqual(gemini.enabled, {
    state: 'enabled', position: 1, origin: { layer: 'project', source },
  });
  assert.deepEqual(claude.active.narrowedFrom, user);
  assertUnchanged(f, 'claude', claude);
  assertDoctor(f, { claude: 'disabled', gemini: 'enabled' });

  const localSource = f.writeProjectLocal({
    schema: 1, 'workers.enabled': ['primary'],
  });
  const local = await describeBody(t, f, 'gemini');
  assert.deepEqual(local.enabled, {
    state: 'disabled', position: null, origin: { layer: 'local', source: localSource },
  });
  assert.deepEqual(local.active.narrowedFrom, user);
  assertUnchanged(f, 'gemini', local);
  assertDoctor(f, { claude: 'disabled', gemini: 'disabled' });
});

test('unlisted describe and doctor retain the user origin and original eligibility', async (t) => {
  const f = createSettingsEnv(t);
  const source = writeUser(f, ['gemini']);
  const body = await describeBody(t, f, 'claude');
  assert.deepEqual(body.enabled, {
    state: 'unlisted', position: null, origin: { layer: 'user', source },
  });
  assert.equal(body.active.inSession, false);
  assertUnchanged(f, 'claude', body);
  assertDoctor(f, { claude: 'unlisted', gemini: 'enabled' });
});

test('invalid lists show unlisted rows and a reason without echoing the invalid value', async (t) => {
  const f = createSettingsEnv(t);
  const source = writeUser(f, ['gemini', 'held']);
  const body = await describeBody(t, f, 'claude');
  assert.deepEqual(body.enabled, {
    state: 'unlisted', position: null, origin: { layer: 'user', source },
  });
  assert.equal(body.active.state, 'invalid');
  assert.equal(typeof body.active.reason, 'string');
  assert.ok(body.active.reason.length > 0);
  assert.equal(body.active.reason.includes('held'), false);
  assertUnchanged(f, 'claude', body);
  const view = assertDoctor(f, { claude: 'unlisted', gemini: 'unlisted' });
  assert.equal(view.state, 'invalid');
  assert.equal(view.reason.includes('held'), false);
});

test('describe includes the declared primary and tolerates primary resolution failures', async (t) => {
  const f = createSettingsEnv(t);
  const body = await describeBody(t, f, 'claude', { DOFLOW_PRIMARY_HARNESS: 'gemini' });
  assert.equal(body.primary.harness, 'gemini');
  assert.equal(body.primary.state, 'declared-only');

  const primary = require('../../src/runtime/context/primary.ts');
  const original = primary.resolvePrimary;
  t.after(() => { primary.resolvePrimary = original; });
  primary.resolvePrimary = () => { throw new Error('primary unavailable for test'); };
  const unavailable = await describeBody(t, f, 'claude');
  assert.deepEqual(unavailable.primary, {
    state: 'unavailable', message: 'primary unavailable for test',
  });
  assertUnchanged(f, 'claude', unavailable);
});

test('readiness describe adds active and primary independently only when supplied', (t) => {
  const f = createSettingsEnv(t);
  const base = { ...options(f), harness: 'claude', root: f.project, now: () => NOW };
  const baseline = readiness.describe(base);
  const active = activeWorkers({ env: base.env, projectRoot: f.project });
  const primary = { state: 'declared-only', harness: 'gemini' };

  assert.deepEqual(readiness.describe({ ...base, active: undefined, primary: undefined }), baseline);
  const withActive = readiness.describe({ ...base, active });
  assert.deepEqual(withActive, {
    ...baseline, enabled: readiness.enabledOf(active, 'claude'), active,
  });
  assert.notStrictEqual(withActive.active, active);
  assert.equal(Object.hasOwn(withActive, 'primary'), false);
  const withPrimary = readiness.describe({ ...base, primary });
  assert.deepEqual(withPrimary, { ...baseline, primary });
  assert.strictEqual(withPrimary.primary, primary);
  assert.equal(Object.hasOwn(withPrimary, 'active'), false);
  assert.equal(Object.hasOwn(withPrimary, 'enabled'), false);
});

test('dangling ids do not occupy positions and read-only views leave the fixture unchanged', async (t) => {
  const f = createSettingsEnv(t);
  writeUser(f, ['gemini', 'agy', 'primary']);
  const before = snapshot(f.dir);
  const body = await describeBody(t, f, 'gemini');
  assert.equal(body.enabled.position, 1);
  assert.deepEqual(body.active.dangling, ['agy']);
  const view = assertDoctor(f, { claude: 'unlisted', gemini: 'enabled' });
  assert.deepEqual(view.dangling, ['agy']);
  assert.deepEqual(snapshot(f.dir), before);
  assert.equal(fs.existsSync(f.userFile('session-env')), false);

  writeUser(f, ['gemini', 'agy', 'claude', 'primary']);
  assert.equal((await describeBody(t, f, 'claude')).enabled.position, 2);
});

test('doctor text and JSON report workers beside the unchanged primary line without creating session-env', (t) => {
  const f = createSettingsEnv(t);
  writeUser(f, ['claude', 'ghost']);
  const env = {
    HOME: f.home,
    USERPROFILE: f.home,
    XDG_CONFIG_HOME: f.xdg,
    PATH: '',
    GIT_CONFIG_GLOBAL: path.join(f.dir, 'no-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    DOFLOW_PRIMARY_HARNESS: 'gemini',
  };
  const cli = (args: any) => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: f.project, env, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.error, undefined);
    assert.ok([0, 1].includes(result.status), result.stderr);
    return result.stdout;
  };

  const text = cli(['doctor']);
  assert.match(text, /\[Primary and Workers\]/);
  assert.match(text, /^  worker claude: enabled #1, ineligible \([^)]+\); bound tiers: none$/m);
  assert.equal(text.split('\n').filter((line: any) => line === '  worker ghost: dangling (no registry or enabled package knows it)').length, 1);
  assert.equal(text.split('\n').filter((line: any) => line === "  note: workers.enabled: worker 'ghost' is not installed (ignored)").length, 1);
  assert.deepEqual(text.split('\n').filter((line: any) => /^\s*primary: /.test(line)), [
    '  primary: declared-only gemini/- (env), probe declared-only',
  ]);

  const report = JSON.parse(cli(['doctor', '--json']));
  assert.deepEqual(report.workers.dangling, ['ghost']);
  assert.equal(report.workers.state, 'set');
  const claude = report.workers.rows.find((row: any) => row.harness === 'claude');
  assert.equal(claude.enabled.state, 'enabled');
  assert.equal(claude.enabled.position, 1);
  assert.equal(report.primary.harness, 'gemini');
  for (const row of report.workers.rows) {
    assert.equal(Object.hasOwn(row, 'bindings'), false);
    assert.deepEqual(row.bound, []);
  }
  assert.equal(fs.existsSync(f.userFile('session-env')), false);

  writeUser(f, ['gemini', 'held']);
  const invalidText = cli(['doctor']);
  const workerLines = invalidText.split('\n').filter((line: any) => /^  workers? /.test(line) || /^  workers\.enabled: /.test(line));
  assert.match(workerLines[0], /^  workers\.enabled: invalid \(.+\)$/);
  assert.equal(invalidText.includes('held'), false);
  assert.match(invalidText, /^  worker claude: unlisted, ineligible \([^)]+\); bound tiers: none$/m);
  assert.equal(fs.existsSync(f.userFile('session-env')), false);
});
