'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { handleModelsCommand } = require('../../src/runtime/models/command.ts');
const { writeCatalogue, readCatalogue } = require('../../src/runtime/models/catalogue.ts');
const { workerPoolDoctorView, handleDoctorCommand } = require('../../src/runtime/health.ts');
const { dispatchRuntimeCommand } = require('../../src/cli/runtime-commands.ts');

function setup(t: any) {
  const root = tempDir(t, 'doflow-models-cmd-');
  const project = path.join(root, 'project');
  const config = path.join(root, 'config');
  const userDoflow = path.join(config, 'doflow');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(userDoflow, { recursive: true });

  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: config,
  };
  return { root, project, config, userDoflow, env };
}

test('doflow models --action list returns empty when no catalogue exists', async (t: any) => {
  const { project, env } = setup(t);
  let logged = '';
  const originalLog = console.log;
  console.log = (msg: string) => { logged += msg + '\n'; };

  try {
    const code = await handleModelsCommand({
      action: 'list',
      actionGiven: true,
      json: true,
      projectRoot: project,
      env,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(logged);
    assert.deepEqual(parsed.models, []);
  } finally {
    console.log = originalLog;
  }
});

test('doflow models --action sync --harness updates single harness in catalogue', async (t: any) => {
  const { project, env } = setup(t);

  const code = await handleModelsCommand({
    action: 'sync',
    actionGiven: true,
    harness: 'claude',
    json: true,
    projectRoot: project,
    env,
  });

  assert.equal(code, 0);
  const cat = readCatalogue(project);
  assert.ok(cat);
  assert.ok(cat.harnesses.claude);
  assert.equal(cat.harnesses.claude.harnessId, 'claude');
});

test('doflow models --action sync rejects unknown harness with usage error', async (t: any) => {
  const { project, env } = setup(t);

  const code = await handleModelsCommand({
    action: 'sync',
    actionGiven: true,
    harness: 'non-existent-harness',
    json: true,
    projectRoot: project,
    env,
  });

  assert.equal(code, 2);
});

test('doflow models --action list reflects enablement from models.enabled', async (t: any) => {
  const { project, userDoflow, env } = setup(t);

  // Write catalogue with two models
  writeCatalogue({
    version: 1,
    syncedAt: new Date().toISOString(),
    harnesses: {
      claude: {
        harnessId: 'claude',
        binary: 'claude',
        installed: true,
        version: '1.0.0',
        loginState: 'logged-in',
        reloginHint: null,
        detectedMode: 'subscription',
        derivedBilling: 'free',
        offeredModels: [
          { id: 'claude-3-7-sonnet', displayName: 'Claude 3.7 Sonnet', family: 'anthropic' },
          { id: 'claude-3-5-haiku', displayName: 'Claude 3.5 Haiku', family: 'anthropic' },
        ],
        lastSyncedAt: new Date().toISOString(),
      },
    },
  }, project);

  // Configure models.enabled at user layer (allowing both)
  fs.writeFileSync(
    path.join(userDoflow, 'settings.json'),
    JSON.stringify({ 'models.enabled': ['claude-3-7-sonnet', 'claude-3-5-haiku'] }),
    'utf8'
  );

  // Configure models.enabled at project layer (narrowing to only claude-3-7-sonnet)
  const doflowDir = path.join(project, '.doflow');
  fs.mkdirSync(doflowDir, { recursive: true });
  fs.writeFileSync(
    path.join(doflowDir, 'settings.json'),
    JSON.stringify({ 'models.enabled': ['claude-3-7-sonnet'] }),
    'utf8'
  );

  let logged = '';
  const originalLog = console.log;
  console.log = (msg: string) => { logged += msg + '\n'; };

  try {
    const code = await handleModelsCommand({
      action: 'list',
      actionGiven: true,
      json: true,
      projectRoot: project,
      env,
    });
    assert.equal(code, 0);
    const rows = JSON.parse(logged);
    assert.equal(rows.length, 2);
    const m1 = rows.find((r: any) => r.model === 'claude-3-7-sonnet');
    const m2 = rows.find((r: any) => r.model === 'claude-3-5-haiku');
    assert.equal(m1.status, 'enabled');
    assert.equal(m2.status, 'listed');
  } finally {
    console.log = originalLog;
  }
});

test('doflow models --action describe shows metadata and offering harnesses', async (t: any) => {
  const { project, env } = setup(t);

  writeCatalogue({
    version: 1,
    syncedAt: new Date().toISOString(),
    harnesses: {
      claude: {
        harnessId: 'claude',
        binary: 'claude',
        installed: true,
        version: '1.0.0',
        loginState: 'logged-in',
        reloginHint: null,
        detectedMode: 'subscription',
        derivedBilling: 'free',
        offeredModels: [
          { id: 'claude-3-7-sonnet', displayName: 'Claude 3.7 Sonnet', family: 'anthropic' },
        ],
        lastSyncedAt: new Date().toISOString(),
      },
    },
  }, project);

  let logged = '';
  const originalLog = console.log;
  console.log = (msg: string) => { logged += msg + '\n'; };

  try {
    const code = await handleModelsCommand({
      action: 'describe',
      actionGiven: true,
      model: 'claude-3-7-sonnet',
      json: true,
      projectRoot: project,
      env,
    });
    assert.equal(code, 0);
    const desc = JSON.parse(logged);
    assert.equal(desc.model, 'claude-3-7-sonnet');
    assert.equal(desc.displayName, 'Claude 3.7 Sonnet');
    assert.equal(desc.harnesses.length, 1);
    assert.equal(desc.harnesses[0].harnessId, 'claude');
    assert.equal(desc.harnesses[0].loginState, 'logged-in');
  } finally {
    console.log = originalLog;
  }
});

test('doflow models --action describe fails for unlisted model', async (t: any) => {
  const { project, env } = setup(t);

  let logged = '';
  const originalLog = console.log;
  console.log = (msg: string) => { logged += msg + '\n'; };

  try {
    const code = await handleModelsCommand({
      action: 'describe',
      actionGiven: true,
      model: 'ghost-model',
      json: true,
      projectRoot: project,
      env,
    });
    assert.equal(code, 1);
    const res = JSON.parse(logged);
    assert.equal(res.error, 'not-found');
  } finally {
    console.log = originalLog;
  }
});

test('doflow models rejects invalid action', async (t: any) => {
  const { project, env } = setup(t);

  const code = await handleModelsCommand({
    action: 'bogus-action',
    actionGiven: true,
    json: true,
    projectRoot: project,
    env,
  });

  assert.equal(code, 2);
});

test('dispatchRuntimeCommand dispatches models verb correctly', async (t: any) => {
  const { project } = setup(t);

  const code = await dispatchRuntimeCommand({
    cmd: 'models',
    action: 'list',
    actionGiven: true,
    json: true,
    positional: [project],
  });

  assert.equal(code, 0);
});

test('workerPoolDoctorView reports unsynced when catalogue is absent', (t: any) => {
  const { project, env } = setup(t);

  const view = workerPoolDoctorView({ projectRoot: project, env });
  assert.equal(view.state, 'unsynced');
  assert.equal(view.models.listedCount, 0);
  assert.ok(Array.isArray(view.harnesses));
  assert.equal(view.harnesses.length, 7);
  for (const h of view.harnesses) {
    assert.equal(h.loginState, 'uncalibrated');
  }
});

test('workerPoolDoctorView and handleDoctorCommand report worker pool diagnostics', async (t: any) => {
  const { project, env } = setup(t);

  writeCatalogue({
    version: 1,
    syncedAt: new Date().toISOString(),
    harnesses: {
      codex: {
        harnessId: 'codex',
        binary: 'gh',
        installed: true,
        version: '2.50.0',
        loginState: 'logged-out',
        reloginHint: 'gh auth login',
        detectedMode: 'unverified',
        derivedBilling: 'unknown',
        offeredModels: [
          { id: 'o3-mini', displayName: 'o3-mini', family: 'openai' },
        ],
        lastSyncedAt: new Date().toISOString(),
      },
    },
  }, project);

  const view = workerPoolDoctorView({ projectRoot: project, env });
  assert.equal(view.state, 'synced');
  assert.equal(view.models.listedCount, 1);
  const codex = view.harnesses.find((h: any) => h.harness === 'codex');
  assert.ok(codex);
  assert.equal(codex.loginState, 'logged-out');
  assert.equal(codex.reloginHint, 'gh auth login');
  assert.equal(codex.effectiveBilling.value, 'unknown');

  let textOutput = '';
  const originalLog = console.log;
  console.log = (msg: string = '') => { textOutput += msg + '\n'; };

  try {
    const code = await handleDoctorCommand({ projectRoot: project, json: false, env });
    assert.equal(code, 0);
    assert.ok(textOutput.includes('[Worker Pool & Models]'));
    assert.ok(textOutput.includes('codex'));
    assert.ok(textOutput.includes('(re-login: gh auth login)'));
    assert.ok(textOutput.includes('Models: 0 enabled, 1 listed'));
  } finally {
    console.log = originalLog;
  }
});
