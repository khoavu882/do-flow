'use strict';

// Every copy-tree adapter, driven through the real lifecycle against a copy of this package: an
// update after a source file is dropped deletes the installed copy and its ledger row, and a copy
// the user edited stays, loses its row, and is named by one notice.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScratch } = require('../helper/scratch-env');
const { loadRegistry } = require('../../src/registry');
const { registryLifecycleView, LIFECYCLE_HARNESSES } = require('../../src/lifecycle/view');
const { applyLifecycle } = require('../../src/lifecycle');

const REPO = path.resolve(__dirname, '..', '..');
const EDIT = '\nA line the user added.\n';

let pkgScratch;
let pkg;

before(() => {
  pkgScratch = createScratch('doflow-dropped-file-pkg-');
  pkg = path.join(pkgScratch.dir, 'pkg');
  for (const part of ['bin', 'src', 'core']) fs.cpSync(path.join(REPO, part), path.join(pkg, part), { recursive: true });
});

after(() => pkgScratch?.remove());

/** Plan and apply one install or update of `harness` at global scope in the current HOME. */
function run(harness) {
  const view = registryLifecycleView({ registry: loadRegistry({ repoRoot: pkg }), repoRoot: pkg, scope: { global: true }, targets: [harness] });
  assert.deepEqual(view.plan.conflicts, [], `${harness} plans without a conflict`);
  const target = view.plan.targets.find((item) => item.harness === harness);
  const { ledger } = applyLifecycle({ plan: view.plan, registry: view.registry, adapters: view.adapters, stateRoot: view.stateRoot, ledger: view.ledger });
  return { notices: target.notices ?? [], ledger };
}

/** The first copy-tree row of `harness` whose source file exists under the package copy's core/. */
function droppableRow(ledger, harness) {
  const assets = new Map(loadRegistry({ repoRoot: pkg }).assets.map((asset) => [asset.id, asset]));
  const core = path.join(pkg, 'core') + path.sep;
  for (const row of ledger.resources) {
    if (row.harness !== harness || row.kind !== 'copy-tree-file' || !assets.has(row.assetId)) continue;
    const source = path.join(pkg, assets.get(row.assetId).source, row.identity);
    if (source.startsWith(core) && fs.existsSync(source) && fs.statSync(source).isFile()) return { row, source };
  }
  return null;
}

/**
 * In a fresh scratch HOME: install `harness`, optionally edit the installed copy of one projected
 * file, delete that file's source from the package copy, and update. Returns what the update left,
 * read before the HOME is removed; the source file is restored either way.
 */
function dropRound(harness, { edit = false } = {}) {
  const scratch = createScratch(`doflow-dropped-file-${harness}-`);
  scratch.apply();
  let picked;
  try {
    const install = run(harness);
    picked = droppableRow(install.ledger, harness);
    assert.ok(picked, `${harness} installed a copy-tree file whose source is under core/`);
    const { target } = picked.row;
    if (edit) fs.appendFileSync(target, EDIT);
    const edited = edit ? fs.readFileSync(target) : null;
    fs.rmSync(picked.source);
    const update = run(harness);
    return {
      target, edited, installNotices: install.notices, notices: update.notices,
      bytes: fs.existsSync(target) ? fs.readFileSync(target) : null,
      rows: update.ledger.resources.filter((row) => row.target === target),
      relative: path.relative(scratch.home, target),
    };
  } finally {
    if (picked) fs.copyFileSync(path.join(REPO, path.relative(pkg, picked.source)), picked.source);
    scratch.restore();
    scratch.remove();
  }
}

for (const harness of LIFECYCLE_HARNESSES) {
  test(`${harness}: an update deletes the installed copy of a dropped source file and its ledger row`, () => {
    const result = dropRound(harness);
    assert.equal(result.bytes, null, `${result.target} is deleted`);
    assert.deepEqual(result.rows, [], 'no ledger row names the deleted copy');
    assert.deepEqual(result.notices.filter((notice) => !result.installNotices.includes(notice)), [], 'the update adds no notice');
  });

  test(`${harness}: an update keeps a hand-edited copy of a dropped source file, releases its row and names it once`, () => {
    const result = dropRound(harness, { edit: true });
    assert.deepEqual(result.bytes, result.edited, `${result.target} keeps the user's bytes`);
    assert.deepEqual(result.rows, [], 'no ledger row names the kept copy');
    const kept = result.notices.filter((notice) => notice.startsWith('kept hand-edited '));
    assert.deepEqual(kept, [`kept hand-edited ${result.relative}; DoFlow no longer manages it`]);
  });
}
