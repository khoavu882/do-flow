'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
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

// ── 107-B review C-4: the walk refuses an incomplete or escaping import set ──────────────────────

test('107-B C-4: an import that climbs out of the guidance root is refused', (t) => {
  const parent = tempDir(t, 'doflow-guidance-escape-');
  const root = path.join(parent, 'guidance');
  seed(root, { 'DOFLOW_CORE.md': '@../outside.md\n' });
  seed(parent, { 'outside.md': 'not guidance\n' });
  assert.throws(() => guidanceManifest(root), /outside\.md.*escapes the guidance root|escapes the guidance root.*outside\.md/);
});

test('107-B C-4: an absolute import is refused', (t) => {
  const root = tempDir(t, 'doflow-guidance-absolute-');
  seed(root, { 'DOFLOW_CORE.md': '@/etc/hosts\n' });
  assert.throws(() => guidanceManifest(root), /absolute/);
});

test('107-B C-4: an imported source file that is a symlink is refused', (t) => {
  const root = tempDir(t, 'doflow-guidance-symlink-');
  seed(root, { 'DOFLOW_CORE.md': '@link.md\n', 'real.md': 'content\n' });
  fs.symlinkSync(path.join(root, 'real.md'), path.join(root, 'link.md'));
  assert.throws(() => guidanceManifest(root), /link\.md.*symlink|symlink.*link\.md/);
});

test('107-B C-4: an imported file under a symlinked directory is refused', (t) => {
  const root = tempDir(t, 'doflow-guidance-symlink-dir-');
  seed(root, { 'DOFLOW_CORE.md': '@linked/one.md\n', 'elsewhere/one.md': 'content\n' });
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'linked'));
  assert.throws(() => guidanceManifest(root), /linked\/one\.md.*symlink|symlink.*linked\/one\.md/);
});

test('107-B C-4: the selector fails on a dangling import that is not generated, and exempts MCP_INDEX.md', (t) => {
  const { resolveSelect } = require('../../src/adapters/copy-tree.ts');
  const select = resolveSelect('guidance-manifest');
  const dangling = tempDir(t, 'doflow-guidance-dangling-');
  seed(dangling, { 'DOFLOW_CORE.md': '@missing.md\n' });
  assert.throws(() => select(dangling, fs), /missing\.md/);
  const generated = tempDir(t, 'doflow-guidance-generated-');
  seed(generated, { 'DOFLOW_CORE.md': '@MCP_INDEX.md\n' });
  assert.deepEqual([...select(generated, fs)], ['DOFLOW_CORE.md']);
});

test('107-B C-4: a plan over a tree with a dangling import fails instead of installing a partial core set', (t) => {
  const { planTree } = require('../../src/adapters/copy-tree.ts');
  const source = tempDir(t, 'doflow-guidance-plan-src-');
  seed(source, { 'DOFLOW_CORE.md': '@missing.md\n' });
  assert.throws(() => planTree({ sourceDir: source, destDir: tempDir(t, 'doflow-guidance-plan-dst-'), select: 'guidance-manifest' }), /missing\.md/);
});
