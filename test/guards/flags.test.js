'use strict';

// G4 — flag consumers. FLAGS.md is loaded into every session on every harness, so a flag that
// routes to nothing is pure context cost that also misleads: it advertises a capability the
// framework does not have.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GUIDANCE, coreTextFiles } = require('./_shared');

const FLAGS = path.join(GUIDANCE, 'FLAGS.md');

// Suppressions must carry a reason so each one is visible in review rather than accumulating
// silently. A flag consumed behaviourally by the model — rather than by a file reference a scan
// can see — is the only legitimate entry.
const BEHAVIOURAL_ONLY = new Map([]);

function documentedFlags() {
  const text = fs.readFileSync(FLAGS, 'utf8');
  const flags = new Set();
  for (const [, group] of text.matchAll(/^\*\*(--[^*]+)\*\*/gm)) {
    for (const [, flag] of group.matchAll(/(--[a-z0-9-]+)/g)) flags.add(flag);
  }
  return [...flags];
}

test('G4: every flag documented in FLAGS.md is referenced somewhere else in core/', () => {
  const elsewhere = coreTextFiles({ exclude: ['core/shared/guidance/FLAGS.md'] });
  const dead = documentedFlags().filter((flag) => {
    if (BEHAVIOURAL_ONLY.has(flag)) return false;
    const pattern = new RegExp(`${flag}(?![a-z0-9-])`);
    return !elsewhere.some(({ text }) => pattern.test(text));
  });
  assert.deepEqual(dead, [],
    `flags documented but wired to nothing (remove them, or add a reasoned BEHAVIOURAL_ONLY entry):\n  ${dead.join('\n  ')}`);
});

test('G4: FLAGS.md does not enumerate MCP servers', () => {
  const text = fs.readFileSync(FLAGS, 'utf8');
  const named = ['context7', 'sequential-thinking', 'chrome-devtools', 'playwright']
    .filter((server) => text.includes(server));
  assert.deepEqual(named, [],
    'per-install MCP advertisement belongs to the generated MCP_INDEX.md; naming servers here '
    + 'advertises ones the user may not have installed');
});

test('G4: every BEHAVIOURAL_ONLY suppression names a flag that is still documented', () => {
  const documented = new Set(documentedFlags());
  const stale = [...BEHAVIOURAL_ONLY.keys()].filter((flag) => !documented.has(flag));
  assert.deepEqual(stale, [], 'suppressions for flags that no longer exist must be deleted');
});
