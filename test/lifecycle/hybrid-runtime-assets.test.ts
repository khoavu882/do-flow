'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry } = require('../../src/registry/index.ts');
const { planTree, applyTree, sharedTreeDestDir } = require('../../src/adapters/copy-tree.ts');
const { REPO } = require('../guards/_shared');
const { tempDir } = require('../helper/tmp.ts');

test('runtime.lib projects the Semble bridge into every harness runtime tree', (t) => {
  const registry = loadRegistry({ repoRoot: REPO });
  const asset = registry.assets.find((item: any) => item.id === 'runtime.lib');
  assert.ok(asset);
  assert.equal(asset.source, 'src');
  const harnessIds = registry.harnesses.map((item: any) => item.id).sort();
  assert.deepEqual([...asset.appliesTo].sort(), harnessIds);
  for (const harness of harnessIds) {
    assert.equal(asset.projection[harness].renderer, 'copy-tree');
    assert.equal(asset.nativeDir[harness], '../.doflow/runtime/src');
  }

  const project = tempDir(t, 'doflow-hybrid-runtime-');
  const destDir = sharedTreeDestDir(project, asset.nativeDir[harnessIds[0]]);
  const plan = planTree({ sourceDir: path.join(REPO, asset.source), destDir });
  assert.deepEqual(plan.conflicts, []);
  assert.ok(plan.changes.some((change: any) => change.relPath === 'runtime/knowledge/semble-bridge.py'));
  applyTree({ changes: plan.changes });

  const source = path.join(REPO, 'src/runtime/knowledge/semble-bridge.py');
  const projected = path.join(destDir, 'runtime/knowledge/semble-bridge.py');
  assert.deepEqual(fs.readFileSync(projected), fs.readFileSync(source));
});
