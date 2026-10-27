'use strict';

// G-B — direction ratchets for the repository architecture (docs/architecture.md#boundary-ratchets). Two jobs:
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
const { REPO } = require('./_shared.ts');

const CORE = path.join(REPO, 'core');

function jsFiles(dir: any, out: any = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full: any = path.join(dir, entry.name);
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
  const offenders: any = [];
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
  // The registry family is plain JSON (core/registry/*.json). If you are here because a registry
  // file was ADDED, ask whether the fact belongs in an existing file first (single-source
  // doctrine) before raising this.
  const registryEntries = fs.readdirSync(path.join(REPO, 'core', 'registry'))
    .filter((name: any) => /\.json$/.test(name));
  // `advice.json` is optional runtime data, not a shared install registry (063 DEC-025).
  // 17: `gates.json` (108) adds the roadmap policy. `settings.json` (086 DD-1) remains the one
  // registry of settings keys. Per-owner declarations in advice.json and storage.json were
  // rejected, so one loader reads and renders every key once.
  // `telemetry.json` (088) is the telemetry contract v1: one registry for every key a telemetry line may carry.
  // `protocols.json` (119 IC-001) holds review and debate presets, the lens catalogue and the locked invariants;
  // presets are registry data, not settings objects (119 D2).
  // 19: `contribution-points.json` (122 IC-002) is the point registry of the package extension model: which points exist,
  // their tier and status, and the forbidden manifest fields. A separate file because the package loader reads it on its
  // own (a bad file disables only non-bundled packages), not through `loadRegistry`.
  // 20: `rules.json` (102 IC-001) is the rule ledger for always-loaded guidance rules and safety invariants.
  // 21: `transcripts.json` (093 IC-021) is the transcript locator registry; like `advice.json` it has its own loader
  // (`src/runtime/transcripts/registry.ts`) so a bad file turns the transcript feature off instead of failing installs.
  // 22: `guidance-caps.json` (row 130) is the per-harness vendor size-cap table G74 reads. Not folded into
  // harnesses.json: each row cites a vendor page and date, and one harness can carry two caps of different scope.
  assert.equal(registryEntries.length, 22,
    `core/registry holds ${registryEntries.length} files; expected the ratcheted 22`);

  // Stage 3 makes adapters thinner but never fewer: one directory per harness, plus the shared
  // copy-tree engine and the contract validator live as siblings.
  const adapterDirs = fs.readdirSync(path.join(REPO, 'src', 'adapters'), { withFileTypes: true })
    .filter((e: any) => e.isDirectory()).map((e: any) => e.name);
  assert.equal(adapterDirs.length, 7,
    `expected 7 harness adapter directories, found: ${adapterDirs.join(', ')}`);
});
