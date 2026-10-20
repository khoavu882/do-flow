'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { GENERATED_EXCLUSIONS, guidanceManifest } = require('../../src/adapters/guidance-manifest.ts');

const GUIDANCE = path.join(__dirname, '../..', 'core/shared/guidance');

function seed(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

test('guidanceManifest returns the core set in breadth-first import order on the real tree', () => {
  const manifest = guidanceManifest(GUIDANCE);
  assert.deepEqual(manifest, {
    files: [
      'DOFLOW_CORE.md',
      'PRINCIPLES.md',
      'FLAGS.md',
      'rules/RULE_01_SAFETY.md',
      'rules/RULE_02_WORKFLOW.md',
      'rules/RULE_03_QUALITY.md',
      'rules/RULE_04_QUESTIONS.md',
    ],
    generated: ['MCP_INDEX.md'],
    dangling: [],
  });
  assert.deepEqual([...GENERATED_EXCLUSIONS], [[
    'MCP_INDEX.md',
    'generated per install from the servers actually selected; size varies per machine',
  ]]);
  assert.equal(new Set(manifest.files.map((rel) => path.posix.basename(rel))).size, manifest.files.length,
    'selected files must have unique flat-layout basenames');
});

test('guidanceManifest returns exact files, generated, and dangling fields for nested imports and a cycle', (t) => {
  const root = tempDir(t, 'doflow-guidance-manifest-');
  seed(root, {
    'DOFLOW_CORE.md': '@nested/one.md\n@MCP_INDEX.md\n@missing.md\n',
    'nested/one.md': '@../two.md\n',
    'two.md': '@nested/one.md\n',
  });

  assert.deepEqual(guidanceManifest(root), {
    files: ['DOFLOW_CORE.md', 'nested/one.md', 'two.md'],
    generated: ['MCP_INDEX.md'],
    dangling: ['missing.md'],
  });
});

test('guidanceManifest throws when DOFLOW_CORE.md is missing', (t) => {
  const root = tempDir(t, 'doflow-guidance-manifest-empty-');
  assert.throws(() => guidanceManifest(root), /DOFLOW_CORE\.md.*missing|missing.*DOFLOW_CORE\.md/);
});
