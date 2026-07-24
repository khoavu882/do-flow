'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const claude = require('../src/adapters/claude');
const { MARKER_START, MARKER_END } = require('../src/claude-md-merge');

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-claude-adapter-repo-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-claude-adapter-project-'));
  fs.mkdirSync(path.join(repoRoot, 'core'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'core', 'CLAUDE.md'), '# DoFlow framework\n');
  fs.writeFileSync(path.join(repoRoot, 'core', '.mcp.json'), '{"mcpServers":{"context7":{}}}\n');
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
  const discovery = claude.discover({ scope: 'project', scopeRoot: projectRoot, context });
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
