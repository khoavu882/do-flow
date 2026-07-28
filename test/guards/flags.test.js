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

// CLI and skill-local arguments quoted inside guidance prose. They belong to a command or to a
// single skill's own argument-hint, not to this framework's global flag vocabulary, so FLAGS.md
// neither documents nor owns them. Each entry needs a reason, like BEHAVIOURAL_ONLY above.
const NOT_FRAMEWORK_FLAGS = new Map([
  ['--json', 'output mode of do-paths.sh / do-prereqs.sh, quoted in DOFLOW_CHAIN.md'],
  ['--contracts', "do-execute-plan's own argument, described in DOFLOW_CHAIN.md"],
]);

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

// The reverse direction, which G3 has had from the start and this guard did not: a flag named
// anywhere in core/ must be documented in FLAGS.md. Without it, removing a flag leaves every
// mention of it behind as a pointer to something that no longer exists — silently, because the
// forward check only ever looks at what FLAGS.md still lists.
test('G4: every flag referenced in core/ is documented in FLAGS.md', () => {
  const documented = new Set(documentedFlags());
  const dangling = [];
  // Scoped to the guidance tree on purpose. Guidance and FLAGS.md share one vocabulary; a skill's
  // own arguments are declared in its argument-hint and owned there, and hook scripts are full of
  // ordinary CLI flags that this file has no business tracking.
  const inGuidance = ({ rel }) => rel.startsWith('core/shared/guidance/') && rel.endsWith('.md');
  for (const { rel, text } of coreTextFiles({ exclude: ['core/shared/guidance/FLAGS.md'] }).filter(inGuidance)) {
    for (const [, flag] of text.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]{2,})(?![\w-])/g)) {
      if (NOT_FRAMEWORK_FLAGS.has(flag)) continue;
      if (!documented.has(flag)) dangling.push(`${rel} -> ${flag}`);
    }
  }
  assert.deepEqual([...new Set(dangling)].sort(), [],
    `flags referenced but not documented in FLAGS.md:\n  ${[...new Set(dangling)].sort().join('\n  ')}`);
});

test('G4: every BEHAVIOURAL_ONLY suppression names a flag that is still documented', () => {
  const documented = new Set(documentedFlags());
  const stale = [...BEHAVIOURAL_ONLY.keys()].filter((flag) => !documented.has(flag));
  assert.deepEqual(stale, [], 'suppressions for flags that no longer exist must be deleted');
});
