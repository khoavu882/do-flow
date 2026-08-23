'use strict';

// G-B — direction ratchets for the structure refactor (docs/refactor-plan.md). Two jobs:
//
// 1. The dependency direction rule: `core/` is content + registries + native sources and must
//    stay consumable without the tool that installs it. No file under core/ may require from
//    src/, bin/, or test/. This is the seam a future content-package split (stage 7) depends
//    on, so it is pinned before anything moves, not after.
//
// 2. Inventory ratchets. Exact counts of structural facts each refactor stage changes on
//    purpose. A ratchet does not forbid the change — it forbids the change happening WITHOUT
//    this file being edited in the same commit, so every structural shift is a reviewed,
//    documented decision rather than drift. Counts may be lowered freely; raising one means
//    the new state was consciously accepted here first.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');

const CORE = path.join(REPO, 'core');

function jsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      jsFiles(full, out);
      continue;
    }
    if (/\.m?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('G-B1: nothing under core/ requires from src/, bin/, or test/', () => {
  const offenders = [];
  // Walks every require call's specifier by hand rather than matching one big regex, so this
  // guard's own source contains no require-call-shaped literal for G16 to misparse.
  const ESCAPE = /^(?:\.\.?\/)+(?:src|bin|test)\//;
  for (const file of jsFiles(CORE)) {
    const text = fs.readFileSync(file, 'utf8');
    let at = text.indexOf('require');
    while (at !== -1) {
      const m = /^require\s*\(\s*(['"])([^'"]+)\1/.exec(text.slice(at));
      if (m && ESCAPE.test(m[2])) { offenders.push(path.relative(REPO, file)); break; }
      at = text.indexOf('require', at + 1);
    }
  }
  assert.deepEqual(offenders, [], `core/ must not depend on tool code:\n  ${offenders.join('\n  ')}`);
});

test('G-B2: inventory ratchets — registry files and adapters', () => {
  // Stage 1 renames these to .json; when it lands, this list changes shape in the same commit
  // and the count stays 12. If you are here because a registry file was ADDED, ask whether the
  // fact belongs in an existing file first (single-source doctrine) before raising this.
  const registryEntries = fs.readdirSync(path.join(REPO, 'core', 'registry'))
    .filter((name) => /\.(yaml|json)$/.test(name));
  assert.equal(registryEntries.length, 12,
    `core/registry holds ${registryEntries.length} files; expected the ratcheted 12`);

  // Stage 3 makes adapters thinner but never fewer: one directory per harness, plus the shared
  // copy-tree engine and the contract validator live as siblings.
  const adapterDirs = fs.readdirSync(path.join(REPO, 'src', 'adapters'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  assert.equal(adapterDirs.length, 8,
    `expected 8 harness adapter directories, found: ${adapterDirs.join(', ')}`);
});
