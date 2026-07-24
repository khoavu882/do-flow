'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configPath, fingerprint, planCodexConfig, applyCodexConfig, reconcileCodexConfig } = require('../src/codex-config');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-codex-config-')); }
function resource(value = true) { return { target: 'codex', scope: 'project', kind: 'configuration-entry', identity: 'features.hooks', value, sourceVersion: '2.4.4' }; }

test('creates a valid project config and records only the owned entry', () => {
  const projectRoot = scratch();
  const result = reconcileCodexConfig({ scope: 'project', projectRoot, desiredResources: [resource()] });
  assert.equal(result.applied, true);
  const file = configPath({ scope: 'project', projectRoot });
  assert.equal(fs.readFileSync(file, 'utf8'), '[features]\nhooks = true\n');
  assert.equal(result.managedResources[0].fingerprint, fingerprint(true));
});

test('merges without altering unknown TOML content', () => {
  const root = scratch(); const file = path.join(root, 'config.toml');
  const before = '# personal\nmodel = "gpt-5"\n\n[providers.work]\nendpoint = "https://example.test"\n';
  fs.writeFileSync(file, before);
  reconcileCodexConfig({ file, scope: 'project', desiredResources: [resource()] });
  const after = fs.readFileSync(file, 'utf8');
  assert.match(after, /# personal\nmodel = "gpt-5"/);
  assert.match(after, /\[providers\.work\]\nendpoint = "https:\/\/example\.test"/);
  assert.match(after, /\[features\]\nhooks = true/);
});

test('deselect removes only a proven-owned key and leaves its table and neighbours intact', () => {
  const root = scratch(); const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, '[features]\nhooks = true\nother = "keep"\n');
  const result = reconcileCodexConfig({ file, scope: 'project', managedResources: [{ ...resource(), fingerprint: fingerprint(true) }], desiredResources: [] });
  assert.equal(result.applied, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '[features]\n\nother = "keep"\n');
});

test('refuses a foreign resource with byte-for-byte preservation', () => {
  const root = scratch(); const file = path.join(root, 'config.toml'); const before = '[features]\nhooks = false\n';
  fs.writeFileSync(file, before);
  const result = reconcileCodexConfig({ file, scope: 'project', desiredResources: [resource()] });
  assert.equal(result.status, 'conflict'); assert.equal(result.applied, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('refuses malformed TOML without touching bytes', () => {
  const root = scratch(); const file = path.join(root, 'config.toml'); const before = '[features\nhooks = true\n';
  fs.writeFileSync(file, before);
  const result = reconcileCodexConfig({ file, scope: 'project', desiredResources: [resource()] });
  assert.equal(result.status, 'malformed'); assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('refuses a user-modified owned entry', () => {
  const root = scratch(); const file = path.join(root, 'config.toml'); const before = '[features]\nhooks = false\n';
  fs.writeFileSync(file, before);
  const result = reconcileCodexConfig({ file, scope: 'project', managedResources: [{ ...resource(), fingerprint: fingerprint(true) }], desiredResources: [resource()] });
  assert.equal(result.status, 'conflict'); assert.match(result.conflicts[0], /modified/); assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('requires a recorded fingerprint before changing an existing owned identity', () => {
  const root = scratch(); const file = path.join(root, 'config.toml'); const before = '[features]\nhooks = true\n';
  fs.writeFileSync(file, before);
  const result = reconcileCodexConfig({ file, scope: 'project', managedResources: [resource()], desiredResources: [resource(false)] });
  assert.equal(result.status, 'conflict'); assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('updates an owned value while preserving its user comment', () => {
  const root = scratch(); const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, '[features]\n  hooks = true # local note\n');
  reconcileCodexConfig({ file, scope: 'project', managedResources: [{ ...resource(), fingerprint: fingerprint(true) }], desiredResources: [resource(false)] });
  assert.match(fs.readFileSync(file, 'utf8'), /  hooks = false # local note/);
});

test('dry-run reports a change but never creates the file', () => {
  const root = scratch(); const file = path.join(root, 'config.toml');
  const result = reconcileCodexConfig({ file, scope: 'project', desiredResources: [resource()], dryRun: true });
  assert.equal(result.status, 'change'); assert.equal(result.applied, false); assert.equal(fs.existsSync(file), false);
});

test('an atomic-write failure leaves the original file unchanged and cleans its temporary file', () => {
  const root = scratch(); const file = path.join(root, 'config.toml'); const before = '[features]\nhooks = true\n';
  fs.writeFileSync(file, before);
  const plan = planCodexConfig({ file, scope: 'project', managedResources: [{ ...resource(), fingerprint: fingerprint(true) }], desiredResources: [resource(false)] });
  const fsImpl = { ...fs, renameSync() { throw new Error('simulated rename failure'); } };
  assert.throws(() => applyCodexConfig(plan, { fsImpl }), /simulated/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')).length, 0);
});
