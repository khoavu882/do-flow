'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createKiroAdapter } = require('../../../src/adapters/kiro');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-kiro-hooks-')); }

const REPO_ROOT = path.resolve(__dirname, "../../..");
const HOOKS_SOURCE = path.join(REPO_ROOT, 'core', 'harnesses', 'kiro', 'hooks');

function hooksAsset() {
  return { id: 'kiro.hooks-scripts', source: 'core/harnesses/kiro/hooks', renderer: 'copy-tree', capability: 'hooks', nativeDir: 'hooks' };
}

const EXPECTED_TRIGGERS = ['SessionStart', 'PreToolUse', 'PreToolUse', 'Stop'];

test('kiro.hooks-scripts materialises into .kiro/hooks/ for project scope', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const asset = hooksAsset();
  const context = { repoRoot: REPO_ROOT };
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  assert.equal(planned.conflicts.length, 0);
  assert.equal(planned.surfaces.hooks.status, 'supported');
  assert.ok(planned.changes.length > 0);
  adapter.apply({ changes: planned.changes });

  const installedDir = path.join(root, '.kiro', 'hooks');
  for (const name of fs.readdirSync(HOOKS_SOURCE)) {
    assert.ok(fs.existsSync(path.join(installedDir, name)), `expected ${name} to be installed`);
  }
});

test('kiro.hooks-scripts materialises into ~/.kiro/hooks/ for global scope', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const asset = hooksAsset();
  const context = { repoRoot: REPO_ROOT, homeDir: root };
  const planned = adapter.plan({ scope: 'global', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: planned.changes });

  const installedDir = path.join(root, '.kiro', 'hooks');
  for (const name of fs.readdirSync(HOOKS_SOURCE)) {
    assert.ok(fs.existsSync(path.join(installedDir, name)), `expected ${name} to be installed`);
  }
});

test('re-planning after install produces no changes and no conflicts', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const asset = hooksAsset();
  const context = { repoRoot: REPO_ROOT };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: first.changes });

  const ledger = { resources: first.changes.map((c) => ({ harness: 'kiro', assetId: c.assetId, kind: 'copy-tree-file', identity: c.identity, fingerprint: c.fingerprint })) };
  const second = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger });
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.conflicts, []);
});

test('refuses to overwrite a hook file modified outside DoFlow', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const asset = hooksAsset();
  const context = { repoRoot: REPO_ROOT };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: first.changes });

  const change = first.changes.find((c) => c.identity === 'doflow.json');
  const ledger = { resources: [{ harness: 'kiro', assetId: asset.id, kind: 'copy-tree-file', identity: 'doflow.json', fingerprint: change.fingerprint }] };
  fs.writeFileSync(path.join(root, '.kiro', 'hooks', 'doflow.json'), '{"tampered": true}');
  const second = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger });
  assert.match(second.conflicts.join('\n'), /modified outside DoFlow/);
});

test('removal cleanly deletes only fingerprint-matching hook files', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const asset = hooksAsset();
  const context = { repoRoot: REPO_ROOT };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: first.changes });

  const ledger = { resources: first.changes.map((c) => ({ harness: 'kiro', assetId: c.assetId, kind: 'copy-tree-file', identity: c.identity, fingerprint: c.fingerprint })) };
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context: { ...context, operation: 'remove' }, ledger });
  adapter.remove({ changes: removal.changes });

  for (const name of fs.readdirSync(HOOKS_SOURCE)) {
    assert.equal(fs.existsSync(path.join(root, '.kiro', 'hooks', name)), false, `expected ${name} to be removed`);
  }
});

test('verify reports the hooks tree as managed once installed', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const asset = hooksAsset();
  const context = { repoRoot: REPO_ROOT };
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: planned.changes });

  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets: [asset], context });
  assert.equal(verified.ok, true);
  const hooksStatus = verified.statuses.copyTree.find((s) => s.assetId === asset.id);
  assert.equal(hooksStatus.status, 'managed');
  assert.equal(hooksStatus.target, path.join(root, '.kiro', 'hooks'));
});

test('installed doflow.json is well-formed with the four expected DoFlow-authored triggers', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const asset = hooksAsset();
  const context = { repoRoot: REPO_ROOT };
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: planned.changes });

  const raw = fs.readFileSync(path.join(root, '.kiro', 'hooks', 'doflow.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 'v1');
  assert.ok(Array.isArray(parsed.hooks));
  assert.equal(parsed.hooks.length, 4);
  const triggers = parsed.hooks.map((hook) => hook.trigger).sort();
  assert.deepEqual(triggers, [...EXPECTED_TRIGGERS].sort());
  for (const hook of parsed.hooks) {
    assert.equal(typeof hook.name, 'string');
    assert.ok(hook.name.length > 0);
    assert.equal(hook.action.type, 'command');
    assert.equal(typeof hook.action.command, 'string');
    assert.equal(hook.enabled, true);
  }
});

test('installed hook scripts are executable', () => {
  const root = scratch(); const adapter = createKiroAdapter();
  const asset = hooksAsset();
  const context = { repoRoot: REPO_ROOT };
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: planned.changes });

  for (const name of fs.readdirSync(HOOKS_SOURCE)) {
    if (!name.endsWith('.sh')) continue;
    const mode = fs.statSync(path.join(root, '.kiro', 'hooks', name)).mode;
    assert.ok(mode & 0o111, `expected ${name} to be executable`);
  }
});

test('confirms the real registry routes kiro.hooks-scripts to kiro only', () => {
  const { loadRegistry, selectAssets } = require('../../../src/registry');
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const hooksAssets = selectAssets(registry, { harness: 'kiro', capability: 'hooks' });
  assert.equal(hooksAssets.length, 1);
  assert.equal(hooksAssets[0].id, 'kiro.hooks-scripts');
  assert.equal(hooksAssets[0].nativeDir.kiro, 'hooks');
  const declared = registry.assets.find((a) => a.id === 'kiro.hooks-scripts');
  assert.deepEqual(declared.appliesTo, ['kiro']);
});
