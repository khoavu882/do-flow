'use strict';

/**
 * G21 — the wholesale-asset constant against adapter behaviour (feature 041, task D.3; FR-007).
 *
 * `src/runtime/inventory/siblings.js` reports an unmanaged file only when it sits in a directory
 * the harness loads **wholesale** — every file present becomes operative context. A directory the
 * harness resolves by name is never even read, because a neighbouring file there cannot take
 * effect. Which directories are which is not declared anywhere: nothing in the registry records
 * load semantics, so `WHOLESALE_ASSETS` is a constant derived by hand from two adapter facts. A
 * third harness gaining an apply-to-everything transform would silently stop being inspected, and
 * before this guard no test would have failed.
 *
 * Two halves, because the two facts behind the constant are not equally checkable:
 *
 *   1. **Derived, by executing the adapter.** Copilot's directory is loaded wholesale because
 *      `copy-tree.js`'s `copilot-rule-instructions` transform renders *every* file it copies under
 *      an `applyTo: '**'` header. That is a property of the transform, so this guard runs each
 *      entry of the `TRANSFORMS` table over a probe file and reads the frontmatter it produces
 *      rather than trusting a comment. Any projection in `assets.json` declaring a transform that
 *      renders apply-to-everything must appear in the constant — which is exactly the third-harness
 *      case.
 *   2. **Recorded, with the structural facts it rests on pinned.** Kiro's steering tree is loaded
 *      wholesale because Kiro loads `.kiro/steering/` as steering context and DoFlow projects the
 *      whole guidance tree there; no transform, no renderer and no registry field distinguishes
 *      that from a name-resolved copy-tree, so it cannot be derived. `RECORDED` carries the entry
 *      with its rationale, and this guard pins the two registry facts the rationale depends on, so
 *      the constant has to be re-derived if either moves.
 *
 * **Why not the signal D.1 proposed.** D.1 suggested tying the constant to `copy-tree.js` emitting
 * no change for a byte-identical destination (the `unchanged, no-op` branch). That branch compares
 * destination bytes against the bytes the source would write — it is the *currency* signal the
 * report already uses in `index.js#plannedChangeKeys`, and it behaves identically whether the
 * harness loads the directory wholesale or by name. It cannot distinguish the two, so it cannot
 * pin a constant about load semantics. The transform table can, and executes rather than reads.
 *
 * This guard runs adapter code (one pure transform per table entry) instead of scanning it. The
 * reachability guards scan statically because they audit text a harness will read; here the fact
 * under audit *is* the bytes a transform produces, and scanning for the literal would pin the
 * comment rather than the behaviour.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { TRANSFORMS } = require('../../src/adapters/copy-tree');
const { WHOLESALE_ASSETS } = require('../../src/runtime/inventory/siblings');

const ASSETS = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'assets.json'), 'utf8'));
const HARNESSES = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'harnesses.json'), 'utf8'));

/** A file with its own frontmatter and a body, so a transform that strips and re-wraps is
 * exercised the way a real guidance rule exercises it. */
const PROBE_SOURCE = 'RULE_01_SAFETY.md';
const PROBE_CONTENT = Buffer.from('---\nname: probe\ndescription: "probe"\n---\n\n**Purpose**: probe\n\nbody\n');

/**
 * A frontmatter directive that applies the file to everything the harness sees. Deliberately
 * broader than the one spelling in use today (`applyTo: '**'`), because the failure this guard
 * exists to catch is a *new* transform, and a new harness is as likely to spell it `globs: "**"`.
 * A directive scoped to anything narrower than `**` is not wholesale and must not match.
 */
const APPLY_TO_EVERYTHING = /^\s*(?:applyTo|applies_?to|globs?)\s*:\s*['"]?\*\*['"]?\s*$/im;

/** The frontmatter block of a rendered file, or '' when it renders none. */
function frontmatter(rendered) {
  if (!rendered.startsWith('---')) return '';
  const end = rendered.indexOf('\n---', 3);
  return end === -1 ? '' : rendered.slice(4, end);
}

/** Whether this transform makes every file it renders apply to everything. */
function rendersApplyToEverything(transform) {
  return APPLY_TO_EVERYTHING.test(frontmatter(transform(PROBE_SOURCE, PROBE_CONTENT).toString('utf8')));
}

/** `harness/assetId`, the key both halves of this guard and the constant itself are compared on. */
function pairKey(harness, assetId) { return `${harness}/${assetId}`; }

/** The constant, flattened to the same key shape. */
function declaredPairs() {
  const pairs = new Set();
  for (const [harness, assetIds] of Object.entries(WHOLESALE_ASSETS)) {
    for (const assetId of assetIds) pairs.add(pairKey(harness, assetId));
  }
  return pairs;
}

/** Every (harness, asset) projection declaring one of the named transforms. */
function projectionsDeclaring(transformNames) {
  const pairs = new Set();
  for (const asset of ASSETS.assets ?? []) {
    for (const [harness, projection] of Object.entries(asset.projection ?? {})) {
      if (transformNames.has(projection?.transform)) pairs.add(pairKey(harness, asset.id));
    }
  }
  return pairs;
}

/**
 * The wholesale directories no transform can reveal, each with the reason it is here and the
 * registry facts that reason rests on. An entry is a recorded decision, not a loophole: the facts
 * are asserted below, so a registry change that invalidates one fails this guard instead of
 * quietly leaving the constant describing a directory that moved.
 */
const RECORDED = new Map([
  [pairKey('kiro', 'guidance.context-layer'), {
    rationale: 'Kiro loads every file under .kiro/steering/ as steering context and has no '
      + 'single-file instruction surface at all (src/adapters/kiro/index.js header; '
      + 'https://kiro.dev/docs/steering/), and DoFlow projects the whole shared guidance tree '
      + 'there. Nothing in the projection distinguishes that from a name-resolved copy-tree — same '
      + 'renderer, no transform — so it cannot be derived from adapter behaviour the way Copilot\'s '
      + 'can, only recorded.',
    nativeDir: 'steering',
    harnessPath: 'steering',
  }],
]);

test('G21: every apply-to-everything projection is in the wholesale-asset set (FR-007)', () => {
  const wholesaleTransforms = new Set(
    Object.entries(TRANSFORMS).filter(([, fn]) => rendersApplyToEverything(fn)).map(([name]) => name)
  );
  assert.ok(wholesaleTransforms.size > 0,
    'no copy-tree transform renders an apply-to-everything directive any more. Either the '
    + 'Copilot instructions transform was removed — in which case WHOLESALE_ASSETS must lose its '
    + 'copilot entry — or the directive is spelled in a way APPLY_TO_EVERYTHING no longer matches, '
    + 'in which case this guard has stopped deriving anything and must be taught the new spelling');

  const derived = projectionsDeclaring(wholesaleTransforms);
  const declared = declaredPairs();
  const missing = [...derived].filter((pair) => !declared.has(pair)).sort();
  assert.deepEqual(missing, [],
    'these projections render every file under an apply-to-everything header, so the harness loads '
    + 'their directory wholesale and an unmanaged file dropped there is operative context — but '
    + "src/runtime/inventory/siblings.js's WHOLESALE_ASSETS does not list them, so `doflow "
    + 'inventory` never reads those directories and reports nothing found in them. Add each to '
    + `that constant:\n  ${missing.join('\n  ')}`);
});

test('G21: the recorded wholesale entries still rest on the registry facts they cite', () => {
  const stale = [];
  for (const [pair, entry] of RECORDED) {
    const [harness, assetId] = pair.split('/');
    const asset = (ASSETS.assets ?? []).find((candidate) => candidate.id === assetId);
    if (!asset) { stale.push(`${pair}: no such registry asset`); continue; }
    if (!(asset.appliesTo ?? []).includes(harness)) { stale.push(`${pair}: the asset no longer applies to ${harness}`); continue; }
    if (asset.nativeDir?.[harness] !== entry.nativeDir) {
      stale.push(`${pair}: nativeDir is now ${JSON.stringify(asset.nativeDir?.[harness] ?? null)}, not '${entry.nativeDir}'`);
    }
    const declaredPath = (HARNESSES.harnesses ?? []).find((h) => h.id === harness)?.paths?.[entry.harnessPath];
    if (!declaredPath) stale.push(`${pair}: ${harness} declares no '${entry.harnessPath}' path`);
    if (typeof entry.rationale !== 'string' || entry.rationale.trim() === '') {
      stale.push(`${pair}: a recorded entry must carry the reason it cannot be derived`);
    }
  }
  assert.deepEqual(stale, [],
    'a recorded wholesale entry cites registry facts that have since changed, so the hand-derivation '
    + 'behind WHOLESALE_ASSETS no longer holds. Re-derive the entry against what the adapter does '
    + `now — do not simply update the citation:\n  ${stale.join('\n  ')}`);
});

test('G21: every wholesale-asset entry is derived or recorded, and names a real projection', () => {
  const wholesaleTransforms = new Set(
    Object.entries(TRANSFORMS).filter(([, fn]) => rendersApplyToEverything(fn)).map(([name]) => name)
  );
  const derived = projectionsDeclaring(wholesaleTransforms);

  const unaccounted = [];
  const unreal = [];
  for (const pair of declaredPairs()) {
    if (!derived.has(pair) && !RECORDED.has(pair)) unaccounted.push(pair);
    const [harness, assetId] = pair.split('/');
    const asset = (ASSETS.assets ?? []).find((candidate) => candidate.id === assetId);
    if (!asset || !(asset.appliesTo ?? []).includes(harness)) unreal.push(pair);
  }

  assert.deepEqual(unaccounted.sort(), [],
    'these entries of WHOLESALE_ASSETS are neither derivable from a transform nor listed in this '
    + "guard's RECORDED map. A directory claimed to be loaded wholesale on no stated basis makes "
    + '`doflow inventory` report unmanaged files that can never take effect. Add the reason to '
    + `RECORDED, or remove the entry:\n  ${unaccounted.join('\n  ')}`);

  assert.deepEqual(unreal.sort(), [],
    'these entries of WHOLESALE_ASSETS name a registry asset that does not exist or no longer '
    + 'applies to that harness, so the constant is describing a projection that is gone:\n  '
    + unreal.join('\n  '));
});
