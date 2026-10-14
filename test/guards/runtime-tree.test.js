'use strict';

// G32 — one source, one runtime tree. The lifecycle prunes a runtime file the current source no
// longer produces (pruneRetiredRuntimeFiles, src/lifecycle/index.ts) on the strength of two facts
// this guard holds, because the prune itself cannot see them:
// - each runtime asset projects ONE source directory to ONE `.doflow/runtime/...` tree for every
//   harness, with no layout and no transform, and no other asset writes into that tree. Then
//   "the source does not produce this path" means the same thing for every harness, including one
//   the run does not update.
// - every path under a shared `.doflow/` tree that a projected file names (a harness's hooks, the
//   shared scripts, skills, agent specs) exists in this source. Then a prune can never delete a
//   file a not-yet-updated harness still calls by path.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry } = require('../../src/registry/index.ts');
const { RUNTIME_TREE_ASSETS } = require('../../src/lifecycle/index.ts');
const { sharedTreeDestDir, walkRelFiles } = require('../../src/adapters/copy-tree.ts');
const { REPO } = require('./_shared');
const { tempDir } = require('../helper/tmp');

const registry = loadRegistry({ repoRoot: REPO });

/** Findings for the runtime assets of `reg`: one projection shape and one tree each, nothing else
 * writing into any of them, and a source directory that exists under `repo`. */
function checkRuntimeTrees(reg, repo, ids) {
  const findings = [];
  const harnessIds = reg.harnesses.map((harness) => harness.id).sort();
  const trees = new Map();
  for (const id of ids) {
    const asset = reg.assets.find((item) => item.id === id);
    if (!asset) { findings.push(`${id}: not in the registry`); continue; }
    if (JSON.stringify([...asset.appliesTo].sort()) !== JSON.stringify(harnessIds)) findings.push(`${id}: applies to ${asset.appliesTo.join(', ')}, not every harness`);
    if (asset.layout || asset.transform) findings.push(`${id}: declares an asset-level layout or transform`);
    const dirs = new Set();
    for (const harness of asset.appliesTo) {
      const projection = asset.projection?.[harness] ?? {};
      if (projection.renderer !== 'copy-tree') findings.push(`${id}: ${harness} renders with '${projection.renderer}', not copy-tree`);
      if (projection.layout || projection.transform) findings.push(`${id}: ${harness} declares a layout or transform`);
      dirs.add(asset.nativeDir?.[harness]);
    }
    if (dirs.size !== 1) { findings.push(`${id}: harnesses project to ${dirs.size} trees`); continue; }
    const [nativeDir] = dirs;
    if (typeof nativeDir !== 'string' || !nativeDir.startsWith('../.doflow/runtime/')) { findings.push(`${id}: tree ${nativeDir} is not under ../.doflow/runtime/`); continue; }
    if (sharedTreeDestDir('/scope', nativeDir) !== path.join('/scope', nativeDir.slice(3))) findings.push(`${id}: ${nativeDir} does not resolve at the scope root`);
    if (!fs.existsSync(path.join(repo, asset.source))) findings.push(`${id}: source ${asset.source} is missing`);
    trees.set(nativeDir, id);
  }
  const nested = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  for (const asset of reg.assets) {
    for (const [harness, nativeDir] of Object.entries(asset.nativeDir ?? {})) {
      for (const [tree, owner] of trees) {
        if (asset.id !== owner && typeof nativeDir === 'string' && nested(nativeDir, tree)) findings.push(`${asset.id}: ${harness} writes into ${owner}'s tree (${nativeDir})`);
      }
    }
  }
  return [...new Set(findings)];
}

/** Each shared `.doflow/<tree>` the registry projects, mapped to its source directory. */
function sharedTrees(reg) {
  const trees = new Map();
  for (const asset of reg.assets) {
    for (const nativeDir of Object.values(asset.nativeDir ?? {})) {
      if (typeof nativeDir === 'string' && nativeDir.startsWith('../.doflow/')) trees.set(nativeDir.slice('../.doflow/'.length), asset.source);
    }
  }
  return trees;
}

/** Runtime paths spelled through the DoFlow root's variable or a relative hop instead of `.doflow/`:
 * `$CONFIG_DIR/runtime/...` (doflow-run), `${DOFLOW_CONFIG_DIR:-$HOME/.doflow}/runtime/...`
 * (render-puml.sh), `$POLICY_DIR/../../../runtime/...` (the hook policies). Only the runtime trees,
 * whose `runtime/<tree>/` prefix names nothing else in the scanned files. */
const RUNTIME_SPELLED = /(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"?|\.doflow["}]|\.\.)\/(runtime\/[A-Za-z0-9_./-]+)(.?)/g;

/** Every `.doflow/<tree>/<path>` a scanned file names, and every runtime path RUNTIME_SPELLED
 * finds, with the source path it maps to. A reference built from a variable
 * (`.doflow/scripts/${x}`) or a glob is not a path, and a path under a `.doflow/` directory no asset
 * projects (state, backups) is not DoFlow source. */
function referencedPaths(files, trees, repo) {
  const refs = [];
  const keys = [...trees.keys()].sort((a, b) => b.length - a.length);
  const add = (file, rawRel, tail, label, only) => {
    if (/[$*{<]/.test(tail)) return;
    const rel = rawRel.replace(/[./]+$/, '');
    const key = keys.find((tree) => rel.startsWith(`${tree}/`) && (!only || tree.startsWith(only)));
    if (!key) return;
    refs.push({ file: path.relative(repo, file), ref: `${label}${rel}`, source: path.join(repo, trees.get(key), rel.slice(key.length + 1)) });
  };
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\.doflow\/([A-Za-z0-9_./-]+)(.?)/g)) add(file, match[1], match[2], '.doflow/');
    for (const match of text.matchAll(RUNTIME_SPELLED)) add(file, match[2], match[3], `${match[1]}/`, 'runtime/');
  }
  return refs;
}

const SCANNED = ['core/harnesses', 'core/shared/scripts', 'core/shared/skills', 'core/shared/agent-specs'];
const scannedFiles = SCANNED.flatMap((dir) => walkRelFiles(path.join(REPO, dir), fs).map((rel) => path.join(REPO, dir, rel)));

test('G32.1: each runtime asset projects one source to one .doflow/runtime tree for every harness, and nothing else writes there', () => {
  assert.deepEqual(RUNTIME_TREE_ASSETS, ['runtime.cli', 'runtime.lib', 'runtime.registry']);
  assert.deepEqual(checkRuntimeTrees(registry, REPO, RUNTIME_TREE_ASSETS), []);
});

test('G32.1 control: a harness-specific layout, a second tree, or a foreign asset in the tree is named', () => {
  const fixture = JSON.parse(JSON.stringify(registry));
  const lib = fixture.assets.find((asset) => asset.id === 'runtime.lib');
  lib.projection.pi.layout = 'instructions-md';
  lib.nativeDir.kiro = '../.doflow/runtime/kiro-src';
  fixture.assets.find((asset) => asset.id === 'scripts.doflow').nativeDir.codex = '../.doflow/runtime/bin/scripts';
  assert.deepEqual(checkRuntimeTrees(fixture, REPO, RUNTIME_TREE_ASSETS), [
    'runtime.lib: pi declares a layout or transform',
    'runtime.lib: harnesses project to 2 trees',
    "scripts.doflow: codex writes into runtime.cli's tree (../.doflow/runtime/bin/scripts)",
  ]);
});

/** References already broken when this guard was added, each with why it is not fixed here. An
 * entry that starts resolving fails the guard, so the list only shrinks. */
const KNOWN_STALE = new Map([
  // The runner ships under .doflow/shared/hooks (hooks.shared), not .doflow/scripts. Nothing in
  // src/ loads this shared hooks.json as a harness config, so repointing it is a hook-behaviour
  // change outside 073 T4; reported to the feature's open issues instead.
]);

test('G32.2: every path under a shared .doflow tree that a projected file names exists in this source', () => {
  const refs = referencedPaths(scannedFiles, sharedTrees(registry), REPO);
  assert.ok(refs.some((ref) => ref.ref.startsWith('.doflow/runtime/')), 'the scan must reach the runtime references (doflow-run, the hook policies)');
  assert.ok(refs.some((ref) => !ref.ref.startsWith('.doflow/')), 'the scan must reach runtime paths spelled through a variable or ../ (doflow-run, render-puml.sh, the hook policies)');
  const missing = [...new Set(refs.filter((ref) => !fs.existsSync(ref.source)).map((ref) => `${ref.file}: ${ref.ref}`))];
  assert.deepEqual(missing.filter((entry) => !KNOWN_STALE.has(entry)), []);
  assert.deepEqual([...KNOWN_STALE.keys()].filter((entry) => !missing.includes(entry)), [], 'a known-stale reference now resolves: drop it from KNOWN_STALE');
});

test('G32.2 control: a reference to a runtime file the source no longer ships is named, in every spelling; variables and unprojected trees are not paths', (t) => {
  const file = path.join(tempDir(t, 'doflow-g32-'), 'hook.sh');
  fs.writeFileSync(file, [
    'node "$ROOT/.doflow/runtime/src/helper/git.js"',
    'node "$ROOT/.doflow/runtime/bin/doflow.js"',
    'cat "$ROOT/.doflow/scripts/${name}.sh" "$ROOT/.doflow/state/ledger.json"',
    'node "$CONFIG_DIR/runtime/bin/gone.js"',
    'node "${DOFLOW_CONFIG_DIR:-$HOME/.doflow}/runtime/src/runtime/gone.ts"',
    'cat "${POLICY_DIR:+$POLICY_DIR/../../../runtime/core/registry/gone.json}"',
    'node "$CONFIG_DIR/runtime/bin/doflow.js" "$CONFIG_DIR/runtime/src/${x}.ts" "$SRC/src/runtime/x.ts"',
  ].join('\n'));
  const refs = referencedPaths([file], sharedTrees(registry), REPO);
  assert.deepEqual(refs.map((ref) => ref.ref), [
    '.doflow/runtime/src/helper/git.js', '.doflow/runtime/bin/doflow.js',
    '$CONFIG_DIR/runtime/bin/gone.js', '.doflow}/runtime/src/runtime/gone.ts', '../runtime/core/registry/gone.json',
    '$CONFIG_DIR/runtime/bin/doflow.js',
  ]);
  assert.deepEqual(refs.filter((ref) => !fs.existsSync(ref.source)).map((ref) => ref.ref), [
    '.doflow/runtime/src/helper/git.js', '$CONFIG_DIR/runtime/bin/gone.js', '.doflow}/runtime/src/runtime/gone.ts', '../runtime/core/registry/gone.json',
  ]);
});
