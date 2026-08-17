'use strict';

// G9 — dispatch consistency. A skill that names a specialist archetype (system-architect,
// core-implementer, quality-guardian, etc.) is delegating work to a sub-agent whose model choice
// matters; MODEL_SELECTION.md is how the framework tells that skill which model to request. A
// skill that names an archetype without pointing at that guidance would dispatch work with no
// model-selection reasoning behind it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { skillFiles, agentSpecFiles } = require('./_shared');

test('G9: every skill that names a specialist archetype also references MODEL_SELECTION', () => {
  const archetypes = agentSpecFiles().map(({ name }) => name);
  const failures = [];
  for (const { name, file } of skillFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const matched = archetypes.filter((archetype) => new RegExp(`\\b${archetype}\\b`).test(text));
    if (matched.length === 0) continue;
    if (!text.includes('MODEL_SELECTION')) {
      failures.push(`${name} names ${matched.join(', ')} but does not reference MODEL_SELECTION`);
    }
  }
  assert.deepEqual(failures, [],
    `skills that dispatch to a specialist archetype must reference MODEL_SELECTION:\n  ${failures.join('\n  ')}`);
});
