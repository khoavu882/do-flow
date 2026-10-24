'use strict';

// 086 IC-016: a later setting registers in data, docs and its consumer without resolver changes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures.ts');
const { loadSettingsRegistry } = require('../../src/runtime/settings/registry.ts');
const { loadSettings } = require('../../src/runtime/settings/resolve.ts');
const { handleConfigCommand } = require('../../src/runtime/settings/cli.ts');
const { checkSettingsDocs, renderSettingsRow } = require('../helper/settings-doc-guard.ts');

function verifyKey() {
  return {
    type: 'enum', values: ['off', 'on'], order: ['off', 'on'], default: 'on',
    scope: 'narrow-only', combine: 'override', securityRelevant: false, failSafe: 'on',
    env: { name: 'DOFLOW_VERIFY_V0', parse: 'off-words', direction: 'narrow' },
    flag: null, shellRead: null, needsConfigHome: false,
    legacy: [{ layer: 'project', kind: 'sentinel', path: 'verify-v0.off', value: 'off' }],
    consumers: ['src/runtime/settings/resolve.ts'],
    description: 'Verification baseline V0; a project or the env may switch it off.',
  };
}

function sharedViewsKey() {
  return {
    type: 'enum', values: ['off', 'on'], order: ['off', 'on'], default: 'on',
    scope: 'project-overridable', combine: 'override', views: ['project', 'global'],
    securityRelevant: false, failSafe: 'off', env: null, flag: null, shellRead: null,
    needsConfigHome: false, legacy: [], consumers: ['src/runtime/settings/resolve.ts'],
    description: 'A fixture key reported in project and user views.',
  };
}

function writeFixtureRepo(root: any, raw: any) {
  const registryDir = path.join(root, 'core', 'registry');
  fs.mkdirSync(registryDir, { recursive: true });
  for (const name of ['advice.json', 'protocols.json', 'storage.json', 'harnesses.json', 'models.json']) {
    fs.copyFileSync(path.join(REPO, 'core', 'registry', name), path.join(registryDir, name));
  }
  fs.writeFileSync(path.join(registryDir, 'settings.json'), `${JSON.stringify(raw, null, 2)}\n`);
  for (const source of new Set(Object.values(raw.keys).flatMap((spec: any) => spec.consumers || []))) {
    const consumer = path.join(root, source);
    fs.mkdirSync(path.dirname(consumer), { recursive: true });
    fs.copyFileSync(path.join(REPO, source), consumer);
  }
}

function addVerifyDocsRow(text: any, raw: any, registry: any) {
  const lines = text.split('\n');
  const heading = lines.indexOf('## Settings keys');
  assert.notEqual(heading, -1, 'settings docs table exists');
  let end = heading + 1;
  while (end < lines.length && !lines[end].startsWith('|')) end++;
  assert.ok(end < lines.length, 'settings docs table has a header');
  while (end < lines.length && lines[end].startsWith('|')) end++;
  lines.splice(end, 0, renderSettingsRow('verify.v0', raw.keys['verify.v0'], registry));
  return lines.join('\n');
}

function listConfig(repoRoot: any, fixture: any, extraEnv = {}) {
  const lines: any = [];
  const errors: any = [];
  const oldLog = console.log;
  const oldError = console.error;
  let status;
  try {
    console.log = (value) => lines.push(String(value));
    console.error = (value) => errors.push(String(value));
    status = handleConfigCommand({
      positional: ['list'], showOrigin: true, projectRoot: fixture.project,
      repoRoot, env: fixture.env(extraEnv),
    });
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
  assert.equal(status, 0, errors.join('\n'));
  assert.deepEqual(errors, []);
  return lines.join('\n');
}

test('IC-016: verify.v0 registers through the existing consumer and config list origin paths', (t) => {
  const fixture = createSettingsEnv(t, { prefix: 'doflow-settings-register-key-' });
  const repoRoot = path.join(fixture.dir, 'repo');
  const raw = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'settings.json'), 'utf8'));
  raw.keys['verify.v0'] = verifyKey();
  writeFixtureRepo(repoRoot, raw);

  const loaded = loadSettingsRegistry({ repoRoot, verifyRefs: true, checkConsumers: true });
  assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.detail);
  const defaultView = loadSettings({ projectRoot: fixture.project, env: fixture.env(), registry: loaded.registry });
  assert.equal(defaultView.get('verify.v0').value, 'on');
  assert.equal(defaultView.get('verify.v0').origin.layer, 'default');

  const shippedDocs = fs.readFileSync(path.join(REPO, 'docs', 'settings.md'), 'utf8');
  const fixtureDocsFile = path.join(fixture.dir, 'docs', 'settings.md');
  fs.mkdirSync(path.dirname(fixtureDocsFile), { recursive: true });
  fs.writeFileSync(fixtureDocsFile, shippedDocs);
  const missingRow = checkSettingsDocs(raw, shippedDocs, loaded.registry);
  assert.ok(missingRow.some((message: any) => message.includes('missing verify.v0')), missingRow.join('\n'));
  fs.writeFileSync(fixtureDocsFile, addVerifyDocsRow(shippedDocs, raw, loaded.registry));
  assert.deepEqual(checkSettingsDocs(raw, fs.readFileSync(fixtureDocsFile, 'utf8'), loaded.registry), [],
    'the same G44 S2 check accepts the added fixture row');

  const defaultOutput = listConfig(repoRoot, fixture);
  assert.match(defaultOutput, /^verify\.v0 = "on"  \(default: core\/registry\/settings\.json\)$/m);

  const envOutput = listConfig(repoRoot, fixture, { DOFLOW_VERIFY_V0: 'off' });
  assert.match(envOutput, /^verify\.v0 = "off"  \(env: DOFLOW_VERIFY_V0\)$/m);

  fs.writeFileSync(path.join(fixture.project, '.doflow', 'verify-v0.off'), 'off\n');
  const sentinelOutput = listConfig(repoRoot, fixture, { DOFLOW_VERIFY_V0: undefined });
  assert.match(sentinelOutput, /^verify\.v0 = "off"  \(project: .*verify-v0\.off\)$/m);
});

test('config list prints both views generically for a registered 8th key', (t) => {
  const fixture = createSettingsEnv(t, { prefix: 'doflow-settings-register-views-' });
  const repoRoot = path.join(fixture.dir, 'repo');
  const raw = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'settings.json'), 'utf8'));
  raw.keys['verify.shared'] = sharedViewsKey();
  writeFixtureRepo(repoRoot, raw);
  fixture.writeUserSettings({ schema: 1, 'verify.shared': 'on' });
  fixture.writeProjectSettings({ schema: 1, 'verify.shared': 'off' });

  const loaded = loadSettingsRegistry({ repoRoot, verifyRefs: true, checkConsumers: true });
  assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.detail);
  const output = listConfig(repoRoot, fixture);
  assert.match(output, /^verify\.shared \[project roots\] = "off"  \(project: .*settings\.json\)$/m);
  assert.match(output, /^verify\.shared \[user roots\] = "on"  \(user: .*settings\.json\)$/m);
  assert.match(output, new RegExp(`    project ${fixture.project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/\.doflow\\/settings\\.json: "off" — decided`));
  assert.match(output, new RegExp(`    user ${fixture.xdg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/doflow\\/settings\\.json: "on" — decided`));
});
