'use strict';

// G3 — consumer reachability. This is the guard that makes lazy loading safe. A mode documents
// its own triggers under `## Activation Triggers`, but that is prose ABOUT a trigger, not a
// trigger: no harness evaluates it. Skills are the only mechanism all three harnesses actually
// evaluate (via `description:`), so a lazy resource is reachable only if a skill — or an
// always-loaded rule — reads it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GUIDANCE, SKILLS, coreTextFiles } = require('./_shared');

function lazyResources() {
  const out = [];
  for (const dir of ['modes', 'references']) {
    const abs = path.join(GUIDANCE, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.md')) out.push({ rel: `${dir}/${name}`, base: name.replace(/\.md$/, '') });
    }
  }
  return out;
}

/** A consumer is a skill or an always-loaded rule — NOT DOFLOW_CORE.md's inventory comment block,
 * which names resources without loading them and is precisely what made these files look
 * reachable while nothing loaded them. */
const consumerFiles = () => coreTextFiles().filter(({ rel }) =>
  rel.startsWith('core/shared/skills/') || rel.includes('guidance/rules/'));

test('G3: every mode and reference file has at least one skill or rule consumer', () => {
  const consumers = consumerFiles();
  const orphans = lazyResources().filter(({ base }) => !consumers.some(({ text }) => text.includes(base)));
  assert.deepEqual(orphans.map((o) => o.rel), [],
    `lazy resources nothing loads (a mode's own "Activation Triggers" prose is not a trigger):\n  ${orphans.map((o) => o.rel).join('\n  ')}`);
});

test('G3: no consumer references a mode or reference file that does not exist', () => {
  const existing = new Set(lazyResources().map((r) => r.rel));
  const dangling = [];
  for (const { rel, text } of consumerFiles()) {
    for (const [, ref] of text.matchAll(/`?((?:modes|references)\/[A-Za-z0-9_.-]+\.md)`?/g)) {
      if (!existing.has(ref)) dangling.push(`${rel} -> ${ref}`);
    }
  }
  assert.deepEqual(dangling, [], `consumers point at missing resources:\n  ${dangling.join('\n  ')}`);
});

test('G3: every skill directory contains a SKILL.md', () => {
  const broken = fs.readdirSync(SKILLS).filter((name) => !fs.existsSync(path.join(SKILLS, name, 'SKILL.md')));
  assert.deepEqual(broken, [], 'skill directories without a SKILL.md are invisible to every harness');
});
