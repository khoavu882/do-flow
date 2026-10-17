'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures');

const COUNTER = path.join(REPO, 'test/helper/settings-hot-path-counter.cjs');
const RESOLVER = path.join(REPO, 'src/runtime/settings/resolve.ts');
const STORAGE_REGISTRY = path.join(REPO, 'src/runtime/storage/registry.ts');
const STORAGE_ROOTS = path.join(REPO, 'src/runtime/storage/roots.ts');
const STORAGE_REGISTRY_ROOT = REPO;
const STORAGE_STAT_CEILING = 199; // BEFORE's 194 calls plus the NFR-003 allowance of five.
// One-process `install --dry-run -g` counts from a c81abbdc archive, with an empty project and
// scratch HOME/XDG_CONFIG_HOME. The allowance matches PF.3's filesystem delta acceptance.
const INSTALL_BEFORE_FS = Object.freeze({ stat: 415, open: 406, read: 1016, exists: 483 });
const INSTALL_FS_ALLOWANCE = Object.freeze({ stat: 10, open: 5, read: 10, exists: 10 });
let counterSerial = 0;

function isolatedProject(fixture) {
  const project = path.join(fixture.dir, 'empty-project');
  fs.mkdirSync(project);
  return project;
}

function runCounters(fixture, args, cwd, { extraPreload } = {}) {
  counterSerial += 1;
  const output = path.join(fixture.dir, `settings-hot-path-${process.pid}-${counterSerial}.jsonl`);
  const env = {
    DOFLOW_COUNTER_OUT: output,
    DOFLOW_SETTINGS_RESOLVER: RESOLVER,
    NODE_OPTIONS: [COUNTER, extraPreload].filter(Boolean).map((file) => `--require=${file}`).join(' '),
  };
  const result = fixture.run(args, { cwd, env });
  let counts = null;
  if (fs.existsSync(output)) {
    const lines = fs.readFileSync(output, 'utf8').trim().split('\n');
    counts = JSON.parse(lines[lines.length - 1]);
  }
  assert.ok(counts, 'counter preload wrote its report using the fixture temp directory');
  return { ...result, counts };
}

function runNodeWithCounters(fixture, script, cwd, project) {
  counterSerial += 1;
  const output = path.join(fixture.dir, `settings-hot-path-control-${process.pid}-${counterSerial}.jsonl`);
  const env = fixture.env({
    DOFLOW_COUNTER_OUT: output,
    DOFLOW_SETTINGS_RESOLVER: RESOLVER,
    DOFLOW_TEST_PROJECT: project,
    NODE_OPTIONS: `--require=${COUNTER}`,
  });
  const result = spawnSync(process.execPath, ['-e', script], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const lines = fs.readFileSync(output, 'utf8').trim().split('\n');
  return { result, counts: JSON.parse(lines[lines.length - 1]) };
}

test('install --dry-run -g stays within the BEFORE filesystem budget and loads the resolver at most once', (t) => {
  const fixture = createSettingsEnv(t, { prefix: 'doflow-settings-install-hot-path-' });
  const project = isolatedProject(fixture);
  const result = runCounters(fixture, ['install', '--dry-run', '-g'], project);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run complete/);
  assert.equal(result.counts.loadSettingsCalls, 0, 'install projection does not resolve user settings');
  assert.ok(result.counts.resolverModuleLoads <= 1);
  assert.deepEqual(result.counts.settingsSupportModules, [],
    `dry run imported ${result.counts.settingsSupportModules.join(', ')}`);
  for (const operation of Object.keys(INSTALL_BEFORE_FS)) {
    const ceiling = INSTALL_BEFORE_FS[operation] + INSTALL_FS_ALLOWANCE[operation];
    assert.ok(result.counts.fsOperations[operation] <= ceiling,
      `expected ${operation} <= ${ceiling} (BEFORE ${INSTALL_BEFORE_FS[operation]} + ${INSTALL_FS_ALLOWANCE[operation]}), got ${result.counts.fsOperations[operation]}`);
  }
});

test('negative control: repeated per-adapter settings resolution exceeds the install filesystem budget', (t) => {
  const fixture = createSettingsEnv(t, { prefix: 'doflow-settings-install-control-' });
  const project = isolatedProject(fixture);
  const planted = path.join(fixture.dir, 'planted-per-adapter-resolver.cjs');
  fs.writeFileSync(planted, `
    const { loadSettings } = require(${JSON.stringify(RESOLVER)});
    for (let adapter = 0; adapter < 12; adapter++) {
      loadSettings({ global: true, env: { ...process.env } });
    }
  `);
  const result = runCounters(fixture, ['install', '--dry-run', '-g'], project, { extraPreload: planted });
  const { counts } = result;

  assert.equal(result.status, 0, result.stderr);
  assert.equal(counts.resolverModuleLoads, 1);
  assert.equal(counts.loadSettingsCalls, 12);
  const exceeded = Object.keys(INSTALL_BEFORE_FS).some((operation) =>
    counts.fsOperations[operation] > INSTALL_BEFORE_FS[operation] + INSTALL_FS_ALLOWANCE[operation]);
  assert.ok(exceeded,
    `expected the planted per-adapter resolver calls to exceed ${JSON.stringify(INSTALL_FS_ALLOWANCE)}; got ${JSON.stringify(counts.fsOperations)}`);
});

test('storage report resolves settings once and stays within five stat calls of BEFORE', (t) => {
  const fixture = createSettingsEnv(t, { prefix: 'doflow-settings-storage-hot-path-' });
  const project = isolatedProject(fixture);
  const result = runCounters(fixture, ['storage', '--action', 'report', '--json', project], project);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, 'report');
  assert.equal(result.counts.resolverModuleLoads, 1);
  assert.equal(result.counts.loadSettingsCalls, 1, 'all root decisions share one project view');
  assert.ok(result.counts.fsStatCalls <= STORAGE_STAT_CEILING,
    `expected at most ${STORAGE_STAT_CEILING} public stat calls, got ${result.counts.fsStatCalls}`);
});

test('negative control detects resolver work repeated once per storage root', (t) => {
  const fixture = createSettingsEnv(t, { prefix: 'doflow-settings-storage-control-' });
  const project = isolatedProject(fixture);
  const script = `
    const { loadStorageRegistry } = require(${JSON.stringify(STORAGE_REGISTRY)});
    const { resolveRoots, readPruneSetting } = require(${JSON.stringify(STORAGE_ROOTS)});
    const registry = loadStorageRegistry({ repoRoot: ${JSON.stringify(STORAGE_REGISTRY_ROOT)} });
    const roots = resolveRoots({ registry, projectRoot: process.env.DOFLOW_TEST_PROJECT, env: process.env });
    for (const rootId of Object.keys(roots)) readPruneSetting({ roots, rootId });
    readPruneSetting({ roots, rootId: 'project-state' });
    readPruneSetting({ roots, rootId: 'user-state' });
  `;
  const { counts } = runNodeWithCounters(fixture, script, project, project);

  assert.equal(counts.resolverModuleLoads, 1);
  assert.ok(counts.loadSettingsCalls > 1, `negative control observed ${counts.loadSettingsCalls} loads`);
  assert.ok(counts.settingsSupportModules.length > 0, 'negative control loads the resolver implementation');
  assert.ok(counts.fsStatCalls > 5,
    `negative control observed only ${counts.fsStatCalls} resolver stat calls`);
});
