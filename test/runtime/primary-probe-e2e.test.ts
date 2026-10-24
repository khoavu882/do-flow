'use strict';

// Row 120 IC-005, IC-006 and IC-007: confirm primary model resolution through the shared bridge.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { MODEL_PAYLOADS, REPO } = require('../helper/hook-fixtures');

const BRIDGE = path.join(REPO, 'core/harnesses/shared/hooks/bridge/bridge.sh');
const CLI = path.join(REPO, 'bin/doflow.js');
const POLICY = 'mcp-tool-guard';
const IDENTITY_ENV = [
  'DOFLOW_SESSION_ROLE',
  'DOFLOW_RUN_ID',
  'DOFLOW_LINEAGE_ID',
  'DOFLOW_ATTEMPT',
  'DOFLOW_WORKTREE',
  'DOFLOW_TASK_ID',
];

function scratch(t: any) {
  const dir = tempDir(t, 'doflow-primary-probe-e2e-');
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  return { home, cwd };
}

function isolatedEnv(home: string): any {
  const env: any = { ...process.env, HOME: home };
  delete env.XDG_CONFIG_HOME;
  for (const name of IDENTITY_ENV) delete env[name];
  return env;
}

function runBridge(s: any, harness: string) {
  const fixture = MODEL_PAYLOADS[harness];
  const env = isolatedEnv(s.home);
  env.DOFLOW_FAILURE_CAPTURE = 'off';
  env.DOFLOW_TELEMETRY = 'off';
  env.DOFLOW_DECISION_FD = '';
  env.DOFLOW_BRIDGE_TRACE = '';
  return spawnSync('bash', [BRIDGE, harness, fixture.event, POLICY], {
    cwd: s.cwd,
    env,
    input: JSON.stringify(fixture.native),
    encoding: 'utf8',
  });
}

function resolvePrimary(s: any, harness: string, model?: string) {
  const env = isolatedEnv(s.home);
  env.DOFLOW_PRIMARY_HARNESS = harness;
  if (model === undefined) delete env.DOFLOW_PRIMARY_MODEL;
  else env.DOFLOW_PRIMARY_MODEL = model;
  return spawnSync(process.execPath, [CLI, 'primary', '--action', 'resolve', '--json'], {
    cwd: s.cwd,
    env,
    encoding: 'utf8',
  });
}

function resultOf(result: any) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.ok(result.stdout, result.stderr);
  return JSON.parse(result.stdout);
}

test('codex bridge observation confirms the declared model', (t) => {
  const s = scratch(t);
  const fixture = MODEL_PAYLOADS.codex;
  const bridge = runBridge(s, 'codex');
  assert.equal(bridge.status, 0, bridge.stderr);

  const result = resolvePrimary(s, 'codex', fixture.native.model);
  const primary = resultOf(result);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(primary.state, 'confirmed');
  assert.equal(primary.harness, 'codex');
  assert.equal(primary.model, fixture.native.model);
  assert.equal(primary.observed.sessions, 1);
});

test('a conflicting codex declaration is contradicted with a warning', (t) => {
  const s = scratch(t);
  const fixture = MODEL_PAYLOADS.codex;
  const declared = 'gpt-5.2';
  const bridge = runBridge(s, 'codex');
  assert.equal(bridge.status, 0, bridge.stderr);

  const result = resolvePrimary(s, 'codex', declared);
  const primary = resultOf(result);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(primary.state, 'contradicted');
  assert.deepEqual(primary.warnings, [
    `primary-contradicted: declared ${declared}, observed ${fixture.native.model}`,
  ]);
});

test('a conflicting codex declaration is refused by the user setting', (t) => {
  const s = scratch(t);
  const fixture = MODEL_PAYLOADS.codex;
  const declared = 'gpt-5.2';
  const bridge = runBridge(s, 'codex');
  assert.equal(bridge.status, 0, bridge.stderr);

  const config = path.join(s.home, '.config', 'doflow');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({
    schema: 1,
    'primary.onContradiction': 'refuse',
  }));

  const result = resolvePrimary(s, 'codex', declared);
  const primary = resultOf(result);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(primary.state, 'refused');
  assert.deepEqual(primary.warnings, [
    `primary-contradicted: declared ${declared}, observed ${fixture.native.model}`,
  ]);
});

test('pi bridge observation confirms the payload model without a declaration', (t) => {
  const s = scratch(t);
  const bridge = runBridge(s, 'pi');
  assert.equal(bridge.status, 0, bridge.stderr);

  const result = resolvePrimary(s, 'pi');
  const primary = resultOf(result);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(primary.state, 'confirmed');
  assert.equal(primary.harness, 'pi');
  assert.equal(primary.model, MODEL_PAYLOADS.pi.native.model);
  assert.equal(primary.observed.sessions, 1);
});

test('gemini remains declared-only and writes no primary observation folder', (t) => {
  const s = scratch(t);
  const bridge = runBridge(s, 'gemini');
  assert.equal(bridge.status, 0, bridge.stderr);

  const result = resolvePrimary(s, 'gemini');
  const primary = resultOf(result);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(primary.state, 'declared-only');
  assert.equal(primary.harness, 'gemini');
  assert.equal(primary.model, null);
  assert.equal(
    fs.existsSync(path.join(s.home, '.config', 'doflow', 'session-env', 'primary')),
    false,
  );
});
