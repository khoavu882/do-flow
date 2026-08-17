'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPiAdapter, nativePaths } = require('../src/adapters/pi');
const { assertAdapter } = require('../src/adapters');
const { MARKER_START } = require('../src/marker-merge');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-pi-')); }

function guidanceAsset(sourceFile) {
  return { id: 'guidance.codex-pointer', capability: 'instructions', source: sourceFile };
}

function contextWithSource(sourceFile) {
  return { sourceFor: () => sourceFile };
}

test('implements the adapter contract and resolves official project/global native paths', () => {
  assertAdapter(createPiAdapter(), 'Pi');
  const root = scratch();
  assert.equal(nativePaths({ scope: 'project', scopeRoot: root }).instruction, path.join(root, 'AGENTS.md'));
  assert.equal(nativePaths({ scope: 'global', scopeRoot: root, homeDir: root }).instruction, path.join(root, '.pi', 'agent', 'AGENTS.md'));
  assert.equal(nativePaths({ scope: 'project', scopeRoot: root }).configDir, path.join(root, '.pi'));
  assert.equal(nativePaths({ scope: 'global', scopeRoot: root, homeDir: root }).configDir, path.join(root, '.pi', 'agent'));
});

test('plans and applies a managed AGENTS.md section without overwriting foreign content', () => {
  const root = scratch(); const adapter = createPiAdapter();
  const sourceFile = path.join(root, 'source.md');
  fs.writeFileSync(sourceFile, '# DoFlow');
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [guidanceAsset(sourceFile)], context: contextWithSource(sourceFile) });
  assert.equal(planned.conflicts.length, 0);
  assert.equal(planned.changes[0].operation, 'create');
  adapter.apply({ changes: planned.changes });
  const instruction = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(instruction, /# DoFlow/);
  assert.match(instruction, new RegExp(MARKER_START));
  const verify = adapter.verify({ scope: 'project', scopeRoot: root, assets: [guidanceAsset(sourceFile)] });
  assert.equal(verify.ok, true);
  assert.equal(verify.resources.length, 1);
});

test('refuses to merge into a foreign AGENTS.md that has no DoFlow managed section', () => {
  const root = scratch(); const adapter = createPiAdapter();
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Personal instructions\n');
  const sourceFile = path.join(root, 'source.md');
  fs.writeFileSync(sourceFile, '# DoFlow');
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [guidanceAsset(sourceFile)], context: contextWithSource(sourceFile) });
  assert.match(planned.conflicts[0], /without a DoFlow managed section/);
});

test('remove strips only the managed section, preserving foreign content on both sides', () => {
  const root = scratch(); const adapter = createPiAdapter();
  const sourceFile = path.join(root, 'source.md');
  fs.writeFileSync(sourceFile, '# DoFlow');
  const asset = guidanceAsset(sourceFile);
  const install = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context: contextWithSource(sourceFile) });
  adapter.apply({ changes: install.changes });
  const managed = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), `# Before notes\n${managed}# After notes\n`);
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context: { ...contextWithSource(sourceFile), operation: 'remove' } });
  assert.equal(removal.changes.length, 1);
  assert.equal(removal.changes[0].operation, 'remove');
  adapter.remove({ changes: removal.changes });
  const remaining = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(remaining, /# Before notes/);
  assert.match(remaining, /# After notes/);
  assert.doesNotMatch(remaining, new RegExp(MARKER_START));
});

// Unlike Gemini's dedicated removeManagedSection, this adapter's writeChange-based remove writes
// back whatever strippedInstruction computed, including an empty string — it never independently
// deletes the file. That is this adapter's existing, unmodified contract (shared verbatim with
// OpenCode's), so an AGENTS.md that was nothing but the managed section ends up empty, not absent.
test('remove leaves an empty AGENTS.md once nothing but the managed section remains', () => {
  const root = scratch(); const adapter = createPiAdapter();
  const sourceFile = path.join(root, 'source.md');
  fs.writeFileSync(sourceFile, '# DoFlow');
  const asset = guidanceAsset(sourceFile);
  const install = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context: contextWithSource(sourceFile) });
  adapter.apply({ changes: install.changes });
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context: { ...contextWithSource(sourceFile), operation: 'remove' } });
  adapter.remove({ changes: removal.changes });
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), true);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '');
});

test('remove is a no-op on a foreign AGENTS.md that DoFlow never owned', () => {
  const root = scratch(); const adapter = createPiAdapter();
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Personal instructions\n');
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: [], context: { operation: 'remove' } });
  assert.equal(removal.changes.length, 0);
  adapter.remove({ changes: removal.changes });
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# Personal instructions\n');
});

test('plan never touches settings.json — the skills tree is materialised, not registered', () => {
  const root = scratch(); const adapter = createPiAdapter();
  const settingsFile = path.join(root, '.pi', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, '{"model":"user-choice"}');
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [], context: {} });
  assert.equal(planned.changes.length, 0);
  assert.equal(planned.conflicts.length, 0);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{"model":"user-choice"}');
});

function copyTreeAsset(repoRoot) {
  const sourceDir = path.join(repoRoot, 'core', 'shared', 'skills');
  fs.mkdirSync(path.join(sourceDir, 'do-analyze'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'do-analyze', 'SKILL.md'), '# do-analyze\n');
  return { id: 'skills.doflow', source: 'core/shared/skills', renderer: 'copy-tree', capability: 'skills', nativeDir: 'skills' };
}

test('Pi adapter plans, applies, and verifies a copy-tree asset under .pi/skills for project scope', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createPiAdapter();
  const asset = copyTreeAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  assert.equal(first.conflicts.length, 0);
  assert.equal(first.changes.length, 1);
  adapter.apply({ changes: first.changes });
  const installed = path.join(root, '.pi', 'skills', 'do-analyze', 'SKILL.md');
  assert.equal(fs.readFileSync(installed, 'utf8'), '# do-analyze\n');

  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets: [asset], context });
  assert.equal(verified.ok, true);
  assert.equal(verified.resources.length, 1);

  const ledger = { resources: verified.resources.map((r) => ({ harness: 'pi', assetId: asset.id, kind: 'copy-tree-file', identity: r.identity, fingerprint: r.fingerprint })) };
  const second = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger });
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.conflicts, []);
});

test('Pi adapter installs the same copy-tree asset under ~/.pi/agent/skills for global scope', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createPiAdapter();
  const asset = copyTreeAsset(repoRoot);
  const context = { repoRoot, homeDir: root };
  const planned = adapter.plan({ scope: 'global', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: planned.changes });
  assert.equal(fs.readFileSync(path.join(root, '.pi', 'agent', 'skills', 'do-analyze', 'SKILL.md'), 'utf8'), '# do-analyze\n');
});

test('Pi adapter removes only fingerprint-matching copy-tree files', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createPiAdapter();
  const asset = copyTreeAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: first.changes });
  const ledger = { resources: [{ harness: 'pi', assetId: asset.id, kind: 'copy-tree-file', identity: 'do-analyze/SKILL.md', fingerprint: first.changes[0].fingerprint }] };
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context: { ...context, operation: 'remove' }, ledger });
  adapter.remove({ changes: removal.changes });
  assert.equal(fs.existsSync(path.join(root, '.pi', 'skills', 'do-analyze', 'SKILL.md')), false);
});

test('Pi adapter refuses to remove a copy-tree file that was modified outside DoFlow', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createPiAdapter();
  const asset = copyTreeAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: first.changes });
  fs.writeFileSync(path.join(root, '.pi', 'skills', 'do-analyze', 'SKILL.md'), '# tampered\n');
  const ledger = { resources: [{ harness: 'pi', assetId: asset.id, kind: 'copy-tree-file', identity: 'do-analyze/SKILL.md', fingerprint: first.changes[0].fingerprint }] };
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context: { ...context, operation: 'remove' }, ledger });
  assert.equal(removal.changes.length, 0);
  assert.match(removal.conflicts[0], /modified outside DoFlow/);
});

test('assets.yaml routes skills.doflow to the pi adapter as a copy-tree asset', () => {
  const { loadRegistry, selectAssets, harnessFor } = require('../src/registry');
  const { projectAdapterInput } = require('../src/adapters');
  const repoRoot = path.resolve(__dirname, '..');
  const registry = loadRegistry({ repoRoot });
  const harness = harnessFor(registry, 'pi');
  const adapter = createPiAdapter();
  const selected = selectAssets(registry, { harness: 'pi', capability: 'skills' });
  assert.equal(selected.length, 1, 'pi must receive exactly one skills asset');

  const root = scratch();
  const input = projectAdapterInput({ registry, harness, scope: 'project', scopeRoot: root, assets: selected, context: { repoRoot, homeDir: root } });
  assert.equal(input.assets[0].renderer, 'copy-tree');
  const planned = adapter.plan({ ...input, ledger: { resources: [] } });
  assert.equal(planned.conflicts.length, 0);
  assert.ok(planned.changes.length > 0, 'skills projection planned no files');
  for (const change of planned.changes) {
    assert.ok(change.target.startsWith(path.join(root, '.pi', 'skills')),
      `skills must land in .pi/skills, got ${change.target}`);
  }
});
