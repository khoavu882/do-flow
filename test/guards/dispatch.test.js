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

// Archetypes are written bare in backticks in skill text (`core-implementer`), never with the
// agent spec's `.md` suffix, so the suffix is stripped before the name becomes a pattern.
const archetypeNames = () => agentSpecFiles().map(({ name }) => name.replace(/\.md$/, ''));
const namedIn = (text, archetypes) => archetypes.filter((a) => new RegExp(`\\b${a}\\b`).test(text));

test('G9: every skill that names a specialist archetype also references MODEL_SELECTION', () => {
  const archetypes = archetypeNames();
  const failures = [];
  for (const { name, file } of skillFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const matched = namedIn(text, archetypes);
    if (matched.length === 0) continue;
    if (!text.includes('MODEL_SELECTION')) {
      failures.push(`${name} names ${matched.join(', ')} but does not reference MODEL_SELECTION`);
    }
  }
  assert.deepEqual(failures, [],
    `skills that dispatch to a specialist archetype must reference MODEL_SELECTION:\n  ${failures.join('\n  ')}`);
});

// Positive controls: the guard above passes when nothing matches, so it must be shown to match.
test('G9: the archetype match sees the names the skills actually write', () => {
  const archetypes = archetypeNames();
  const read = (skill) => fs.readFileSync(skillFiles().find(({ name }) => name === skill).file, 'utf8');
  assert.deepEqual(namedIn(read('do-execute-plan'), archetypes).sort(),
    ['core-implementer', 'quality-guardian', 'system-architect']);
  assert.ok(namedIn(read('do-code-review'), archetypes).includes('quality-guardian'));
  assert.deepEqual(namedIn('a skill with no specialist dispatch', archetypes), []);
});
