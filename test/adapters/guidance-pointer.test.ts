'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const POINTER = path.join(REPO, 'core/shared/guidance/pointers/codex.md');

test('Codex pointer names only the core imports and skill-requested extra files', () => {
  const content = fs.readFileSync(POINTER, 'utf8');
  assert.doesNotMatch(content, /(?:rules|modes|mcp|references)\//);
  assert.ok((content.match(/\{\{GUIDANCE\}\}/g) || []).length >= 2);
  assert.match(content, /unless they are already in your instructions/i);
  assert.ok(Buffer.byteLength(content, 'utf8') <= 400);
});

test('renderGuidancePointer resolves global and project scopes and rejects invalid inputs', () => {
  const { renderGuidancePointer } = require('../../src/adapters/guidance-pointer.ts');
  assert.equal(renderGuidancePointer('{{GUIDANCE}}/DOFLOW_CORE.md', { scope: 'global', scopeRoot: '/h' }), '/h/.doflow/guidance/DOFLOW_CORE.md');
  assert.equal(renderGuidancePointer('{{GUIDANCE}}/DOFLOW_CORE.md', { scope: 'project', scopeRoot: '/repo' }), '.doflow/guidance/DOFLOW_CORE.md');
  assert.throws(() => renderGuidancePointer('{{GUIDANCE}}/DOFLOW_CORE.md', { scope: 'workspace', scopeRoot: '/h' }), /scope/i);
  assert.throws(() => renderGuidancePointer('{{GUIDANCE}}/DOFLOW_CORE.md', { scope: 'global', scopeRoot: '/h/{{GUIDANCE}}' }), /token/i);
});
