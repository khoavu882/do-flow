'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGeminiAdapter, nativePaths, MARKER_START } = require('../src/adapters/gemini');
const { assertAdapter } = require('../src/adapters');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-gemini-')); }
const assets = [{ id: 'guidance.core', source: 'core/CLAUDE.md' }];

test('implements the adapter contract and resolves official project/user native paths', () => {
  assertAdapter(createGeminiAdapter(), 'Gemini');
  const root = scratch();
  assert.equal(nativePaths({ scope: 'project', scopeRoot: root }).instruction, path.join(root, 'GEMINI.md'));
  assert.equal(nativePaths({ scope: 'global', scopeRoot: root, homeDir: root }).instruction, path.join(root, '.gemini', 'GEMINI.md'));
});

test('plans and applies a managed GEMINI.md section without overwriting foreign content', () => {
  const root = scratch(); const adapter = createGeminiAdapter();
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { instructionContent: '# DoFlow' } });
  assert.equal(planned.conflicts.length, 0);
  assert.equal(planned.changes[0].operation, 'create');
  assert.equal(planned.surfaces.mcp.status, 'supported');
  adapter.apply({ changes: planned.changes });
  const instruction = fs.readFileSync(path.join(root, 'GEMINI.md'), 'utf8');
  assert.match(instruction, /# DoFlow/);
  assert.match(instruction, new RegExp(MARKER_START));
  const verify = adapter.verify({ scope: 'project', scopeRoot: root, assets });
  assert.equal(verify.ok, true);
  assert.equal(verify.resources.length, 1);
});

test('preserves foreign GEMINI.md and reports unsupported policy automation plus extension workflow', () => {
  const root = scratch(); const adapter = createGeminiAdapter();
  fs.writeFileSync(path.join(root, 'GEMINI.md'), '# Personal instructions\n');
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { instructionContent: '# DoFlow', policies: [{ id: 'stop-check' }] } });
  assert.match(planned.conflicts[0], /without a DoFlow managed section/);
  assert.deepEqual(planned.surfaces.policies, [{ id: 'stop-check', status: 'unavailable', fallback: 'guidance', reason: 'Gemini policy automation is not rendered by this adapter' }]);
  assert.equal(planned.surfaces.extensions.status, 'different');
});

test('remove strips only the managed section, preserving foreign content on both sides', () => {
  const root = scratch(); const adapter = createGeminiAdapter();
  const install = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { instructionContent: '# DoFlow' } });
  adapter.apply({ changes: install.changes });
  const managed = fs.readFileSync(path.join(root, 'GEMINI.md'), 'utf8');
  fs.writeFileSync(path.join(root, 'GEMINI.md'), `# Before notes\n${managed}# After notes\n`);
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { operation: 'remove' } });
  assert.equal(removal.changes.length, 1);
  assert.equal(removal.changes[0].operation, 'remove');
  adapter.remove({ changes: removal.changes });
  const remaining = fs.readFileSync(path.join(root, 'GEMINI.md'), 'utf8');
  assert.match(remaining, /# Before notes/);
  assert.match(remaining, /# After notes/);
  assert.doesNotMatch(remaining, new RegExp(MARKER_START));
});

test('remove deletes the file only once nothing but the managed section remains', () => {
  const root = scratch(); const adapter = createGeminiAdapter();
  const install = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { instructionContent: '# DoFlow' } });
  adapter.apply({ changes: install.changes });
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { operation: 'remove' } });
  adapter.remove({ changes: removal.changes });
  assert.equal(fs.existsSync(path.join(root, 'GEMINI.md')), false);
});

test('remove is a no-op on a foreign GEMINI.md that DoFlow never owned', () => {
  const root = scratch(); const adapter = createGeminiAdapter();
  fs.writeFileSync(path.join(root, 'GEMINI.md'), '# Personal instructions\n');
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets, context: { operation: 'remove' } });
  assert.equal(removal.changes.length, 0);
  adapter.remove({ changes: removal.changes });
  assert.equal(fs.readFileSync(path.join(root, 'GEMINI.md'), 'utf8'), '# Personal instructions\n');
});

test('invalid native settings block settings/MCP planning but never mutate the file', () => {
  const root = scratch(); const adapter = createGeminiAdapter();
  const settings = path.join(root, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true }); fs.writeFileSync(settings, '{ broken');
  const planned = adapter.plan({ scope: 'project', scopeRoot: root, assets: [], mcp: [{ id: 'context7' }] });
  assert.equal(planned.surfaces.settings.status, 'invalid');
  assert.equal(planned.surfaces.mcp.status, 'blocked');
  assert.match(planned.conflicts[0], /Invalid JSON/);
  assert.equal(fs.readFileSync(settings, 'utf8'), '{ broken');
});

test('project-scope config directory is .agents/, not .gemini/ (Antigravity convention)', () => {
  const root = scratch();
  assert.equal(nativePaths({ scope: 'project', scopeRoot: root }).configDir, path.join(root, '.agents'));
  assert.equal(nativePaths({ scope: 'global', scopeRoot: root, homeDir: root }).configDir, path.join(root, '.gemini'));
});

function copyTreeAsset(repoRoot) {
  const sourceDir = path.join(repoRoot, 'core', 'shared', 'skills');
  fs.mkdirSync(path.join(sourceDir, 'do-analyze'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'do-analyze', 'SKILL.md'), '# do-analyze\n');
  return { id: 'skills.doflow', source: 'core/shared/skills', renderer: 'copy-tree', capability: 'skills', nativeDir: 'skills' };
}

test('Gemini adapter plans, applies, and verifies a copy-tree asset under .agents/ for project scope', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createGeminiAdapter();
  const asset = copyTreeAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  assert.equal(first.conflicts.length, 0);
  assert.equal(first.changes.length, 1);
  adapter.apply({ changes: first.changes });
  const installed = path.join(root, '.agents', 'skills', 'do-analyze', 'SKILL.md');
  assert.equal(fs.readFileSync(installed, 'utf8'), '# do-analyze\n');

  const verified = adapter.verify({ scope: 'project', scopeRoot: root, assets: [asset], context });
  assert.equal(verified.ok, true);
  assert.equal(verified.resources.length, 1);

  const ledger = { resources: verified.resources.map((r) => ({ harness: 'gemini', assetId: asset.id, kind: 'copy-tree-file', identity: r.identity, fingerprint: r.fingerprint })) };
  const second = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger });
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.conflicts, []);
});

test('Gemini adapter installs the same copy-tree asset under .gemini/ for global scope', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createGeminiAdapter();
  const asset = copyTreeAsset(repoRoot);
  const context = { repoRoot, homeDir: root };
  const planned = adapter.plan({ scope: 'global', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: planned.changes });
  assert.equal(fs.readFileSync(path.join(root, '.gemini', 'skills', 'do-analyze', 'SKILL.md'), 'utf8'), '# do-analyze\n');
});

test('Gemini adapter removes only fingerprint-matching copy-tree files', () => {
  const repoRoot = scratch(); const root = scratch(); const adapter = createGeminiAdapter();
  const asset = copyTreeAsset(repoRoot);
  const context = { repoRoot };
  const first = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context, ledger: { resources: [] } });
  adapter.apply({ changes: first.changes });
  const ledger = { resources: [{ harness: 'gemini', assetId: asset.id, kind: 'copy-tree-file', identity: 'do-analyze/SKILL.md', fingerprint: first.changes[0].fingerprint }] };
  const removal = adapter.plan({ scope: 'project', scopeRoot: root, assets: [asset], context: { ...context, operation: 'remove' }, ledger });
  adapter.remove({ changes: removal.changes });
  assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'do-analyze', 'SKILL.md')), false);
});
