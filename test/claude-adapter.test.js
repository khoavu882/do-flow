'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const claude = require('../src/adapters/claude');
const { MARKER_START, MARKER_END } = require('../src/marker-merge');

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-claude-adapter-repo-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-claude-adapter-project-'));
  fs.mkdirSync(path.join(repoRoot, 'core'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'core', 'CLAUDE.md'), '# DoFlow framework\n');
  const instructions = path.join(projectRoot, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(instructions), { recursive: true });
  fs.writeFileSync(instructions, '# Project instructions\n\nPreserve this.\n');
  return { repoRoot, projectRoot, instructions };
}

// Shape matches what src/adapters/index.js#projectAdapterInput actually hands the adapter at
// runtime (flat renderer/capability), not the registry's raw nested asset.projection.claude.
const asset = {
  id: 'guidance.core', source: 'core/CLAUDE.md',
  renderer: 'claude-instructions', capability: 'instructions',
};

test('Claude adapter plans and applies a managed instruction section without replacing user content', () => {
  const { repoRoot, projectRoot, instructions } = fixture();
  const context = { repoRoot, assets: [asset] };
  const registry = { mcp: [{ id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] }] };
  const discovery = claude.discover({ scope: 'project', scopeRoot: projectRoot, context, registry });
  assert.deepEqual(discovery.knownMcpServers, ['context7']);
  const planned = claude.plan({ assets: [asset], scope: 'project', scopeRoot: projectRoot, discovery, context });
  assert.equal(planned.conflicts.length, 0);
  assert.equal(planned.changes[0].operation, 'create');
  claude.apply({ changes: planned.changes, scope: 'project', scopeRoot: projectRoot, context });
  const content = fs.readFileSync(instructions, 'utf8');
  assert.match(content, /Preserve this\./);
  assert.match(content, /# DoFlow framework/);
  assert.match(content, new RegExp(MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(claude.verify({ assets: [asset], scope: 'project', scopeRoot: projectRoot, context }).ok, true);
});

test('Claude adapter removes only its managed instruction section', () => {
  const { repoRoot, projectRoot, instructions } = fixture();
  const context = { repoRoot, assets: [asset] };
  const discovery = claude.discover({ scope: 'project', scopeRoot: projectRoot, context });
  const planned = claude.plan({ assets: [asset], scope: 'project', scopeRoot: projectRoot, discovery, context });
  claude.apply({ changes: planned.changes, scope: 'project', scopeRoot: projectRoot, context });
  claude.remove({ changes: [{ ...planned.changes[0], operation: 'remove' }] });
  const content = fs.readFileSync(instructions, 'utf8');
  assert.match(content, /Preserve this\./);
  assert.ok(!content.includes(MARKER_START));
  assert.ok(!content.includes(MARKER_END));
});

test('Claude adapter reports malformed instruction ownership as a planning conflict', () => {
  const { repoRoot, projectRoot, instructions } = fixture();
  fs.writeFileSync(instructions, `${MARKER_START}\npartial\n`);
  const context = { repoRoot, assets: [asset] };
  const discovery = claude.discover({ scope: 'project', scopeRoot: projectRoot, context });
  const planned = claude.plan({ assets: [asset], scope: 'project', scopeRoot: projectRoot, discovery, context });
  assert.equal(planned.changes.length, 0);
  assert.match(planned.conflicts[0], /malformed DoFlow markers/);
});

function copyTreeAsset(repoRoot) {
  const sourceDir = path.join(repoRoot, 'core', 'shared', 'skills');
  fs.mkdirSync(path.join(sourceDir, 'do-analyze'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'do-analyze', 'SKILL.md'), '# do-analyze\n');
  return { id: 'skills.doflow', source: 'core/shared/skills', renderer: 'copy-tree', capability: 'skills', nativeDir: 'skills' };
}

test('Claude adapter plans, applies, and verifies a copy-tree asset, then converges to no-op', () => {
  const { repoRoot, projectRoot } = fixture();
  const asset2 = copyTreeAsset(repoRoot);
  const context = { repoRoot, assets: [asset2] };
  const first = claude.plan({ assets: [asset2], scope: 'project', scopeRoot: projectRoot, context, ledger: { resources: [] } });
  assert.equal(first.conflicts.length, 0);
  assert.equal(first.changes.length, 1);
  assert.equal(first.changes[0].operation, 'create');
  claude.apply({ changes: first.changes, scope: 'project', scopeRoot: projectRoot, context });
  const installed = path.join(projectRoot, '.claude', 'skills', 'do-analyze', 'SKILL.md');
  assert.equal(fs.readFileSync(installed, 'utf8'), '# do-analyze\n');

  const verified = claude.verify({ assets: [asset2], scope: 'project', scopeRoot: projectRoot, context });
  assert.equal(verified.ok, true);
  assert.equal(verified.resources.length, 1);

  const ledger = { resources: verified.resources.map((r) => ({ harness: 'claude', assetId: asset2.id, kind: 'copy-tree-file', identity: r.identity, fingerprint: r.fingerprint })) };
  const second = claude.plan({ assets: [asset2], scope: 'project', scopeRoot: projectRoot, context, ledger });
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.conflicts, []);
});

test('Claude adapter removes only fingerprint-matching copy-tree files', () => {
  const { repoRoot, projectRoot } = fixture();
  const asset2 = copyTreeAsset(repoRoot);
  const context = { repoRoot, assets: [asset2] };
  const first = claude.plan({ assets: [asset2], scope: 'project', scopeRoot: projectRoot, context, ledger: { resources: [] } });
  claude.apply({ changes: first.changes, scope: 'project', scopeRoot: projectRoot, context });
  const ledger = { resources: [{ harness: 'claude', assetId: asset2.id, kind: 'copy-tree-file', identity: 'do-analyze/SKILL.md', fingerprint: first.changes[0].fingerprint }] };

  const removal = claude.plan({ assets: [asset2], scope: 'project', scopeRoot: projectRoot, context: { ...context, operation: 'remove' }, ledger, removing: true });
  claude.remove({ changes: removal.changes });
  assert.equal(fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'do-analyze', 'SKILL.md')), false);
});

function settingsAssetFixture(repoRoot) {
  const sourceDir = path.join(repoRoot, 'core', 'harnesses', 'claude', 'settings');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '~/.claude/hooks/session-start.sh' }] }] } }));
  fs.writeFileSync(path.join(sourceDir, 'keybindings.json'), '{"bind":"ctrl+k"}');
  return { id: 'claude.settings', source: 'core/harnesses/claude/settings', renderer: 'claude-settings', capability: 'settings' };
}

test('Claude adapter rewrites settings.json hook paths for project scope but not global scope', () => {
  const { repoRoot, projectRoot } = fixture();
  const asset2 = settingsAssetFixture(repoRoot);
  const context = { repoRoot, assets: [asset2] };
  const planned = claude.plan({ assets: [asset2], scope: 'project', scopeRoot: projectRoot, context, ledger: { resources: [] } });
  assert.equal(planned.changes.length, 2);
  claude.apply({ changes: planned.changes, scope: 'project', scopeRoot: projectRoot, context });
  const installed = JSON.parse(fs.readFileSync(path.join(projectRoot, '.claude', 'settings.json'), 'utf8'));
  assert.equal(installed.hooks.SessionStart[0].hooks[0].command, '${CLAUDE_PROJECT_DIR}/.claude/hooks/session-start.sh');
  assert.equal(fs.readFileSync(path.join(projectRoot, '.claude', 'keybindings.json'), 'utf8'), '{"bind":"ctrl+k"}');

  const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-claude-adapter-global-'));
  const globalPlanned = claude.plan({ assets: [asset2], scope: 'global', scopeRoot: globalRoot, context, ledger: { resources: [] } });
  claude.apply({ changes: globalPlanned.changes, scope: 'global', scopeRoot: globalRoot, context });
  const globalInstalled = JSON.parse(fs.readFileSync(path.join(globalRoot, '.claude', 'settings.json'), 'utf8'));
  assert.equal(globalInstalled.hooks.SessionStart[0].hooks[0].command, '~/.claude/hooks/session-start.sh');
});

test('Claude adapter reports a settings conflict instead of silently overwriting a hand-edited settings.json', () => {
  const { repoRoot, projectRoot } = fixture();
  const asset2 = settingsAssetFixture(repoRoot);
  const context = { repoRoot, assets: [asset2] };
  const first = claude.plan({ assets: [asset2], scope: 'project', scopeRoot: projectRoot, context, ledger: { resources: [] } });
  claude.apply({ changes: first.changes, scope: 'project', scopeRoot: projectRoot, context });
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  fs.writeFileSync(settingsPath, '{"handEdited":true}');
  const ledger = { resources: first.changes.map((c) => ({ harness: 'claude', assetId: asset2.id, kind: 'settings-file', identity: c.identity, fingerprint: c.fingerprint })) };
  const second = claude.plan({ assets: [asset2], scope: 'project', scopeRoot: projectRoot, context, ledger });
  assert.equal(second.changes.some((c) => c.identity === 'settings.json'), false);
  assert.match(second.conflicts.join('\n'), /settings\.json was modified outside DoFlow/);
});
