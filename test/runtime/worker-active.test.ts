'use strict';

// 120 IC-009: workers.enabled gates selection, launch and in-session permission.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { shippedWorkerIds } = require('../../src/registry/worker-ids.ts');
const { activeWorkers, workerGate, inSessionGate } = require('../../src/runtime/worker/active.ts');
const { executeWorkerCommand } = require('../../src/runtime/worker/command.ts');
const readiness = require('../../src/runtime/worker/readiness.ts');
const catalogue = require('../../src/runtime/worker/catalogue.ts');
const settings = require('../../src/runtime/settings/resolve.ts');
const DESCRIPTORS = require('../fixtures/worker/descriptors.json');

const IDS = shippedWorkerIds(loadRegistry({ repoRoot: REPO }));
const FAKES = { claude: DESCRIPTORS.claude, antigravity: DESCRIPTORS.antigravity };
const NOW = Date.parse('2026-10-24T00:00:00Z');
const read = (f: any) => activeWorkers({ env: f.env(), projectRoot: f.project });
const writeUser = (f: any, value: any) => f.writeUserSettings({ schema: 1, 'workers.enabled': value });

function preserveExitCode(t: any) {
  const before = process.exitCode;
  t.after(() => { process.exitCode = before; });
}

test('unset keeps every shipped worker and in-session permission, also without a config home', (t) => {
  const f = createSettingsEnv(t);
  for (const env of [f.env(), f.env({ HOME: undefined, XDG_CONFIG_HOME: undefined })]) {
    const active = activeWorkers({ env, projectRoot: f.project });
    assert.deepEqual(active, {
      state: 'unset',
      workers: IDS,
      inSession: true,
      dangling: [],
      origin: { layer: 'default', source: 'core/registry/settings.json' },
      reason: null,
      narrowedFrom: null,
    });
    for (const id of IDS) assert.equal(workerGate(active, id), null, id);
    assert.equal(inSessionGate(active), null);
  }
});

test('a contributed worker is usable only when the user list names it', (t) => {
  const f = createSettingsEnv(t);
  const original = catalogue.workerCatalogue;
  catalogue.workerCatalogue = (options: any) => [
    ...original(options),
    { id: 'acme.coder', worker: {}, origin: 'package', descriptorDigest: 'sha256:x' },
  ];
  t.after(() => { catalogue.workerCatalogue = original; });

  const unset = read(f);
  assert.deepEqual(unset.workers, IDS);
  assert.equal(unset.workers.includes('acme.coder'), false);
  assert.equal(workerGate(unset, 'acme.coder').reason, 'worker-disabled');

  writeUser(f, ['codex', 'acme.coder', 'primary']);
  const active = read(f);
  assert.equal(active.state, 'set');
  assert.deepEqual(active.workers, ['codex', 'acme.coder']);
  assert.deepEqual(active.dangling, []);
  assert.equal(active.inSession, true);
  assert.equal(workerGate(active, 'acme.coder'), null);
});

test('a user list sets workers in list order and gates every omitted worker', (t) => {
  const f = createSettingsEnv(t);
  const source = writeUser(f, ['codex', 'primary']);
  const active = read(f);
  assert.deepEqual(active, {
    state: 'set',
    workers: ['codex'],
    inSession: true,
    dangling: [],
    origin: { layer: 'user', source },
    reason: null,
    narrowedFrom: null,
  });
  const gate = workerGate(active, 'claude');
  assert.deepEqual(gate, {
    reason: 'worker-disabled', harness: 'claude', enabled: ['codex'], origin: active.origin,
  });
  gate.enabled.push('claude');
  assert.deepEqual(active.workers, ['codex']);
  assert.equal(workerGate(active, 'codex'), null);
  assert.equal(inSessionGate(active), null);

  writeUser(f, ['antigravity', 'codex', 'primary']);
  assert.deepEqual(read(f).workers, ['antigravity', 'codex']);
});

test('dangling ids are reported and do not become usable workers', (t) => {
  const f = createSettingsEnv(t);
  writeUser(f, ['codex', 'agy']);
  const active = read(f);
  assert.equal(active.state, 'set');
  assert.deepEqual(active.workers, ['codex']);
  assert.deepEqual(active.dangling, ['agy']);
  assert.equal(active.inSession, false);
  assert.equal(workerGate(active, 'agy').reason, 'worker-disabled');
});

test('project and local narrowing retain the original user list', (t) => {
  const f = createSettingsEnv(t);
  const user = ['codex', 'antigravity', 'primary'];
  writeUser(f, user);
  const projectSource = f.writeProjectSettings({ schema: 1, 'workers.enabled': ['codex', 'primary'] });
  let active = read(f);
  assert.deepEqual(active.workers, ['codex']);
  assert.deepEqual(active.narrowedFrom, user);
  assert.deepEqual(active.origin, { layer: 'project', source: projectSource });
  assert.equal(active.inSession, true);

  f.writeProjectSettings({ schema: 1, 'workers.enabled': ['codex'] });
  active = read(f);
  assert.deepEqual(active.workers, ['codex']);
  assert.deepEqual(active.narrowedFrom, user);
  assert.equal(active.origin.layer, 'project');
  assert.equal(active.inSession, false);

  f.writeProjectSettings({ schema: 1, 'workers.enabled': ['codex', 'primary'] });
  const localSource = f.writeProjectLocal({ schema: 1, 'workers.enabled': ['codex'] });
  active = read(f);
  assert.deepEqual(active.workers, ['codex']);
  assert.deepEqual(active.narrowedFrom, user);
  assert.deepEqual(active.origin, { layer: 'local', source: localSource });
  assert.equal(active.inSession, false);
});

test('a null project root reads no project settings', (t) => {
  const f = createSettingsEnv(t);
  writeUser(f, ['codex', 'primary']);
  f.writeProjectSettings({ schema: 1, 'workers.enabled': ['codex'] });
  const active = activeWorkers({ env: f.env(), projectRoot: null });
  assert.equal(active.origin.layer, 'user');
  assert.deepEqual(active.workers, ['codex']);
  assert.equal(active.inSession, true);
  assert.equal(active.narrowedFrom, null);
});

test('an invalid list fails closed without echoing the invalid id', (t) => {
  const f = createSettingsEnv(t);
  const source = writeUser(f, ['codex', 'held']);
  const active = read(f);
  assert.equal(active.state, 'invalid');
  assert.deepEqual(active.workers, []);
  assert.deepEqual(active.dangling, []);
  assert.equal(active.inSession, false);
  assert.equal(active.narrowedFrom, null);
  assert.deepEqual(active.origin, { layer: 'user', source });
  assert.equal(typeof active.reason, 'string');
  assert.ok(active.reason.length > 0);
  assert.equal(active.reason.includes('held'), false);
  for (const id of [...IDS, 'acme.coder']) {
    assert.deepEqual(workerGate(active, id), {
      reason: 'workers-enabled-invalid', harness: id, enabled: [], origin: active.origin,
    });
  }
  assert.deepEqual(inSessionGate(active), {
    reason: 'workers-enabled-invalid',
    text: 'workers-enabled-invalid: workers.enabled is invalid, do not run in-session',
  });
});

test('a settings load failure is unreadable and fails closed', (t) => {
  const f = createSettingsEnv(t);
  const original = settings.loadSettings;
  settings.loadSettings = () => { throw new Error('private setting value'); };
  t.after(() => { settings.loadSettings = original; });
  assert.deepEqual(read(f), {
    state: 'invalid', workers: [], inSession: false, dangling: [],
    origin: { layer: 'default', source: null }, reason: 'unreadable', narrowedFrom: null,
  });
});

test('in-session work requires primary at the end of the list', (t) => {
  const f = createSettingsEnv(t);
  writeUser(f, ['codex']);
  assert.deepEqual(inSessionGate(read(f)), {
    reason: 'no-enabled-worker',
    text: 'no-enabled-worker: primary not enabled, do not run in-session',
  });
  writeUser(f, ['codex', 'primary']);
  assert.equal(inSessionGate(read(f)), null);
  writeUser(f, ['primary']);
  const active = read(f);
  assert.deepEqual(active.workers, []);
  assert.equal(inSessionGate(active), null);
  assert.equal(workerGate(active, 'codex').reason, 'worker-disabled');
});

test('worker run refuses disabled and invalid lists before reading the prompt', async (t) => {
  preserveExitCode(t);
  const f = createSettingsEnv(t);
  const options = {
    action: 'run', harness: 'codex', slug: 'feat-c', task: 'A.1', token: 1,
    promptFile: path.join(f.project, 'absent-prompt.md'), env: f.env({ PATH: '' }), cwd: f.project,
  };
  const source = writeUser(f, ['claude', 'primary']);
  let result = await executeWorkerCommand(options);
  assert.equal(result.exit, 1);
  assert.deepEqual(result.body, {
    disposition: 'refused', reason: 'worker-disabled', harness: 'codex',
    enabled: ['claude'], origin: { layer: 'user', source },
  });

  writeUser(f, ['codex', 'held']);
  result = await executeWorkerCommand(options);
  assert.equal(result.exit, 1);
  assert.deepEqual(result.body, {
    disposition: 'refused', reason: 'workers-enabled-invalid', harness: 'codex',
    enabled: [], origin: { layer: 'user', source },
  });

  f.remove(f.userFile('settings.json'));
  result = await executeWorkerCommand(options);
  assert.equal(result.exit, 2);
  assert.equal(result.body.error, 'usage');
  assert.match(result.body.message, /--prompt-file/);
  assert.notEqual(result.body.reason, 'worker-disabled');
});

test('worker select filters disabled candidates while retaining known-harness usage checks', async (t) => {
  preserveExitCode(t);
  const f = createSettingsEnv(t);
  writeUser(f, ['antigravity']);
  const options = {
    action: 'select', descriptors: FAKES, env: f.env({ PATH: '' }),
    cwd: f.project, now: () => new Date(NOW),
  };
  const selected = await executeWorkerCommand(options);
  assert.equal(selected.exit, 1);
  assert.equal(selected.body.disposition, 'none-eligible');
  assert.deepEqual(selected.body.candidates.map((item: any) => item.harness), ['antigravity']);

  const disabled = await executeWorkerCommand({ ...options, harness: 'claude' });
  assert.equal(disabled.exit, 1);
  assert.equal(disabled.body.disposition, 'none-eligible');
  assert.deepEqual(disabled.body.candidates, []);
  assert.deepEqual(disabled.body.fallback, selected.body.fallback);

  const unknown = await executeWorkerCommand({ ...options, harness: 'nope' });
  assert.equal(unknown.exit, 2);
  assert.equal(unknown.body.error, 'usage');
  assert.equal(unknown.body.message, "unknown harness 'nope'; known: claude, antigravity");

  const described = await executeWorkerCommand({ ...options, action: 'describe', harness: 'claude' });
  assert.equal(described.exit, 0);
  assert.equal(described.body.disposition, 'described');
  assert.equal(described.body.harness, 'claude');
});

test('unset worker select equals readiness.select without active', async (t) => {
  preserveExitCode(t);
  const f = createSettingsEnv(t);
  const options = { descriptors: FAKES, env: f.env({ PATH: '' }), cwd: f.project, now: NOW };
  const command = await executeWorkerCommand({ ...options, action: 'select' });
  const baseline = readiness.select({ ...options, root: f.project });
  assert.deepEqual(command.body, baseline);
});
