'use strict';

// 120 A.3 (IC-005 and IC-007): primary resolution and the read-only observation contract.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { cwdHash } = require('../../src/runtime/context/identity.ts');
const { resolvePrimary } = require('../../src/runtime/context/primary.ts');

const NOW = Date.parse('2026-10-24T12:00:00.000Z');

function setup(t) {
  const root = tempDir(t, 'doflow-primary-');
  const projectRoot = path.join(root, 'project');
  const config = path.join(root, 'config');
  const observationsRoot = path.join(root, 'observations');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(path.join(config, 'doflow'), { recursive: true });
  const env = { HOME: root, XDG_CONFIG_HOME: config, PATH: '', DOFLOW_SESSION_ROLE: 'main' };
  const registry = { harnesses: ['codex', 'claude', 'pi', 'gemini'].map((id) => ({ id, primaryProbe: { model: id === 'gemini' ? 'none' : 'payload' } })) };
  const models = { providers: [{ id: 'claude', families: ['claude'] }, { id: 'codex', families: ['unknown'] }] };
  const storage = { stores: [] };
  return { root, projectRoot, config, observationsRoot, env, registry, models, storage };
}

function writeObservation(f, harness, model, session, extra = {}) {
  const dir = path.join(f.observationsRoot, 'primary', cwdHash(f.projectRoot), harness);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session}.json`);
  fs.writeFileSync(file, JSON.stringify({
    schema: 1, harness, model, event: 'SessionStart',
    observedAt: '2026-10-24T11:00:00.000Z', session, ...extra,
  }));
  return file;
}

function resolve(f) {
  return resolvePrimary({
    env: f.env, projectRoot: f.projectRoot, observationsRoot: f.observationsRoot,
    registry: f.registry, models: f.models, storage: f.storage, now: () => NOW,
  });
}

test('primary resolution follows ordered declaration, observation, and role rules without spawning', (t) => {
  const originals = {};
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
    originals[name] = childProcess[name];
    childProcess[name] = () => { throw new Error(`unexpected ${name}`); };
  }
  t.after(() => {
    for (const [name, value] of Object.entries(originals)) childProcess[name] = value;
  });

  let f = setup(t);
  assert.equal(resolve(f).state, 'unknown');

  f = setup(t);
  f.env.DOFLOW_PRIMARY_HARNESS = 'codex';
  f.env.DOFLOW_PRIMARY_MODEL = 'GPT-X';
  writeObservation(f, 'codex', 'gpt-x', '0123456789abcdef');
  const confirmed = resolve(f);
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.declared.model, 'GPT-X');
  assert.equal(confirmed.model, 'gpt-x');

  f = setup(t);
  f.env.DOFLOW_PRIMARY_HARNESS = 'codex';
  f.env.DOFLOW_PRIMARY_MODEL = 'gpt-x';
  writeObservation(f, 'codex', 'other-model', '1123456789abcdef');
  const contradicted = resolve(f);
  assert.equal(contradicted.state, 'contradicted');
  assert.deepEqual(contradicted.warnings, ['primary-contradicted: declared gpt-x, observed other-model']);

  f = setup(t);
  f.env.DOFLOW_PRIMARY_HARNESS = 'codex';
  f.env.DOFLOW_PRIMARY_MODEL = 'gpt-x';
  fs.writeFileSync(path.join(f.config, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'primary.onContradiction': 'refuse' }));
  writeObservation(f, 'codex', 'other-model', '2123456789abcdef');
  assert.equal(resolve(f).state, 'refused');

  f = setup(t);
  f.env.DOFLOW_PRIMARY_HARNESS = 'codex';
  assert.equal(resolve(f).reason, 'no-observation');

  f = setup(t);
  f.env.DOFLOW_PRIMARY_HARNESS = 'codex';
  writeObservation(f, 'codex', 'one', '3123456789abcdef');
  writeObservation(f, 'codex', 'two', '4123456789abcdef');
  assert.equal(resolve(f).reason, 'ambiguous-sessions');

  f = setup(t);
  f.env.DOFLOW_PRIMARY_HARNESS = 'gemini';
  assert.equal(resolve(f).state, 'declared-only');

  for (const role of ['worker', 'banana']) {
    f = setup(t);
    f.env.DOFLOW_SESSION_ROLE = role;
    assert.equal(resolve(f).state, 'not-primary');
  }

  f = setup(t);
  f.env.DOFLOW_PRIMARY_MODEL = 'orphan';
  assert.deepEqual(resolve(f).warnings, ['primary-model-without-harness']);

  f = setup(t);
  f.env.DOFLOW_PRIMARY_HARNESS = 'claude';
  writeObservation(f, 'claude', 'claude-model', '5123456789abcdef');
  assert.equal(resolve(f).family, 'claude');

  f = setup(t);
  f.env.DOFLOW_PRIMARY_HARNESS = 'claude';
  f.env.DOFLOW_PRIMARY_MODEL = 'declared';
  writeObservation(f, 'claude', 'observed', '6123456789abcdef');
  assert.equal(resolve(f).family, 'unknown');

  f = setup(t);
  writeObservation(f, 'codex', 'gpt-x', '7123456789abcdef');
  assert.equal(resolve(f).state, 'unknown');

  f = setup(t);
  f.env.DOFLOW_PRIMARY_HARNESS = 'codex';
  for (const [name, value] of [
    ['extra.json', { schema: 1, harness: 'codex', model: 'x', event: 'start', observedAt: '2026-10-24T11:00:00.000Z', session: '8123456789abcdef', extra: true }],
    ['schema.json', { schema: 2, harness: 'codex', model: 'x', event: 'start', observedAt: '2026-10-24T11:00:00.000Z', session: '9123456789abcdef' }],
    ['session.json', { schema: 1, harness: 'codex', model: 'x', event: 'start', observedAt: '2026-10-24T11:00:00.000Z', session: 'bad' }],
    ['model.json', { schema: 1, harness: 'codex', model: '-rf', event: 'start', observedAt: '2026-10-24T11:00:00.000Z', session: 'a123456789abcdef' }],
  ]) {
    const dir = path.join(f.observationsRoot, 'primary', cwdHash(f.projectRoot), 'codex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  }
  assert.equal(resolve(f).reason, 'no-observation');
});
