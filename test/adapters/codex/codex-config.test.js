'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configPath, fingerprint, planCodexConfig, applyCodexConfig, reconcileCodexConfig } = require('../../../src/adapters/codex/config');

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

// --- quoted TOML keys -------------------------------------------------------
// Quoted keys are ordinary TOML. The scanner previously matched bare keys only and threw on the
// whole file, so a single `[mcp_servers."my-server"]` made the entire config unreadable and
// blocked every Codex operation.
const { parseToml } = require('../../../src/helper/toml');

test('parses quoted table headers and quoted assignment keys', () => {
  for (const toml of [
    '[mcp_servers."my-server"]\ncommand = "uv"\n',
    "[mcp_servers.'my-server']\ncommand = 'uv'\n",
    '[plugins."scope@name"]\nx = 1\n',
    '[tui.nux]\n"gpt-5.5" = 4\n',        // a dot INSIDE a quoted key is legal
  ]) {
    assert.doesNotThrow(() => parseToml(toml), `must parse: ${toml.split('\n')[0]}`);
  }
});

test('still fails closed on genuinely unsupported table syntax', () => {
  for (const toml of ['[[a.b]]\nx = 1\n', '[a."b]\nx = 1\n', '[a.]\nx = 1\n', '[]\nx = 1\n']) {
    assert.throws(() => parseToml(toml), `must reject: ${toml.split('\n')[0]}`);
  }
});

test('a dot inside a quoted key cannot collide with a real path separator', () => {
  const entries = parseToml('[t]\n"a.b" = 1\n[t.a]\nb = 2\n').entries;
  assert.equal(entries.size, 2, 'the two distinct keys must not collapse into one');
  assert.notDeepEqual([...entries.keys()][0], [...entries.keys()][1]);
});

// --- new-key placement ------------------------------------------------------
// Regression: a new key whose table already existed was pushed at end-of-file, so it silently
// joined whichever table happened to trail the file. `features.hooks` written after an
// `[mcp_servers.x]` block became `mcp_servers.x.hooks` — the managed entry looked applied but
// landed under the wrong table entirely.
test('a new key is inserted into its own table, not appended after a trailing table', () => {
  const file = path.join(scratch(), 'config.toml');
  fs.writeFileSync(file, '[features]\nskills = true\n\n[mcp_servers.playwright]\ncommand = "npx"\n');
  const plan = planCodexConfig({ file, scope: 'user', managedResources: [], desiredResources: [{ identity: 'features.hooks', value: true }] });
  applyCodexConfig(plan);

  const entries = parseToml(fs.readFileSync(file, 'utf8')).entries;
  assert.equal(entries.get('features.hooks')?.value, true, 'must land in [features]');
  assert.equal(entries.get('mcp_servers.playwright.hooks'), undefined, 'must not leak into the trailing table');
});

test('several new keys for one absent table share a single header', () => {
  const file = path.join(scratch(), 'config.toml');
  fs.writeFileSync(file, '[other]\nz = 1\n');
  const plan = planCodexConfig({ file, scope: 'user', managedResources: [], desiredResources: [
    { identity: 'features.hooks', value: true }, { identity: 'features.skills', value: true }] });
  applyCodexConfig(plan);

  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.split('[features]').length - 1, 1, 'exactly one [features] header');
  const entries = parseToml(text).entries;
  assert.equal(entries.get('features.hooks')?.value, true);
  assert.equal(entries.get('features.skills')?.value, true);
});
