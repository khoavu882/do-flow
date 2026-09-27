'use strict';

// G3 — consumer reachability. This is the guard that makes lazy loading safe. A mode documents
// its own triggers under `## Activation Triggers`, but that is prose ABOUT a trigger, not a
// trigger: no harness evaluates it. Skills are the only mechanism all three harnesses actually
// evaluate (via `description:`), so a lazy resource is reachable only if a skill — or an
// always-loaded rule — reads it.
//
// `pointers/` is the exception the rule has to bend for: those files are projected by the registry,
// not read by a skill, so their reachability test is a registry declaration (see below).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, GUIDANCE, SKILLS, coreTextFiles } = require('./_shared');
const { loadRegistry } = require('../../src/registry');

const registry = loadRegistry({ repoRoot: REPO });

function resourcesUnder(root) {
  const out = [];
  for (const dir of ['modes', 'references']) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.md')) out.push({ rel: `${dir}/${name}`, base: name.replace(/\.md$/, '') });
    }
  }
  return out;
}

/** Guidance-tree resources only — this is the set the "has a consumer" test checks, matching the
 * file's own framing (DOFLOW_CORE.md's inventory comment names these without loading them). */
function lazyResources() {
  return resourcesUnder(GUIDANCE);
}

/** Guidance-tree resources PLUS every skill's own `modes/`/`references/` subdirectory — a skill
 * that names `references/X.md` in its own SKILL.md means "relative to me", not "relative to the
 * shared guidance tree". Used only for existence-checking (test 2): whether a skill-scoped
 * resource has its OWN consumer is a separate, per-skill concern this guard does not police. */
function allLazyResources() {
  const skillDirs = fs.readdirSync(SKILLS).filter((name) => fs.statSync(path.join(SKILLS, name)).isDirectory());
  return [...lazyResources(), ...skillDirs.flatMap((name) => resourcesUnder(path.join(SKILLS, name)))];
}

/** A consumer is a skill or an always-loaded rule — NOT DOFLOW_CORE.md's inventory comment block,
 * which names resources without loading them and is precisely what made these files look
 * reachable while nothing loaded them. Also not a regression-fixture asset: do-code-review's
 * assets/expected_outputs directories intentionally hold malformed sample content (deliberately
 * broken references, stale language) to exercise its own checkers — real prose never lives there,
 * so scanning it here would fail the guard on the fixture doing its job correctly. */
const consumerFiles = () => coreTextFiles().filter(({ rel }) =>
  (rel.startsWith('core/shared/skills/') || rel.includes('guidance/rules/'))
  && !rel.includes('do-code-review/assets/') && !rel.includes('do-code-review/expected_outputs/'));

test('G3: every mode and reference file has at least one skill or rule consumer', () => {
  const consumers = consumerFiles();
  const orphans = lazyResources().filter(({ base }) => !consumers.some(({ text }) => text.includes(base)));
  assert.deepEqual(orphans.map((o) => o.rel), [],
    `lazy resources nothing loads (a mode's own "Activation Triggers" prose is not a trigger):\n  ${orphans.map((o) => o.rel).join('\n  ')}`);
});

test('G3: no consumer references a mode or reference file that does not exist', () => {
  const existing = new Set(allLazyResources().map((r) => r.rel));
  const dangling = [];
  for (const { rel, text } of consumerFiles()) {
    for (const [, ref] of text.matchAll(/`?((?:modes|references)\/[A-Za-z0-9_.-]+\.md)`?/g)) {
      if (!existing.has(ref)) dangling.push(`${rel} -> ${ref}`);
    }
  }
  assert.deepEqual(dangling, [], `consumers point at missing resources:\n  ${dangling.join('\n  ')}`);
});

/** `pointers/` is copy-tree'd into every install exactly as `modes/` and `references/` are, but a
 * pointer's consumer is not a skill: nothing inside the guidance tree reads these, and the agent
 * that does read one never sees it at this path. A pointer is an instruction file a harness adapter
 * renders, so the only thing that can make one reachable is an `assets.json` entry naming it as a
 * `source`. Riding along in guidance.context-layer's copy of the whole directory is not reachability
 * — that is how a superseded pointer stayed on disk, and in every install, describing behaviour two
 * adapters had already stopped implementing. */
function pointerFiles() {
  const abs = path.join(GUIDANCE, 'pointers');
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((name) => name.endsWith('.md'))
    .map((name) => path.relative(REPO, path.join(abs, name)).split(path.sep).join('/'));
}

/** Asset sources that name a single FILE, in the repo-relative forward-slash form assets.json writes
 * them. Directory sources are excluded deliberately: guidance.context-layer's source is the whole
 * guidance tree, and counting it would make every pointer trivially "declared" — the hole itself.
 * The converse direction (a declared source that does not exist on disk) needs no test here;
 * loadRegistry above already throws on it via validateRegistry's source check. */
function declaredFileSources() {
  return new Set(registry.assets
    .map((asset) => asset.source)
    .filter((source) => typeof source === 'string' && fs.statSync(path.resolve(REPO, source)).isFile())
    .map((source) => source.split(path.sep).join('/')));
}

test('G3: every pointer file is named as a source by a registry asset', () => {
  const declared = declaredFileSources();
  const orphans = pointerFiles().filter((rel) => !declared.has(rel));
  assert.deepEqual(orphans, [],
    `pointers no assets.json entry projects (copy-tree'ing the guidance tree is not reachability):\n  ${orphans.join('\n  ')}`);
});

test('G3: every skill directory contains a SKILL.md', () => {
  const broken = fs.readdirSync(SKILLS).filter((name) => !fs.existsSync(path.join(SKILLS, name, 'SKILL.md')));
  assert.deepEqual(broken, [], 'skill directories without a SKILL.md are invisible to every harness');
});
