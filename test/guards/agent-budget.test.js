'use strict';

// G64 — agent roster cap and description budget (feature 118, IC-002 / IC-007, FR-004, FR-012).
//
// Every agent spec's `description` is loaded into the main session's context on every harness that
// lists agents, so the roster is a standing context cost. This guard caps it: at most 7 specs, each
// description at most 160 characters, all descriptions together at most 1,000, and every spec
// declares `access` (`read-only` or `write`, IC-002). Raising a cap is a deliberate edit to this
// file, never a side effect of adding a spec.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { agentSpecFiles } = require('./_shared');

const MAX_SPECS = 7;
const MAX_DESCRIPTION = 160;
const MAX_TOTAL = 1000;
const ACCESS_VALUES = ['read-only', 'write'];

/** Frontmatter values for the keys this guard reads. Quotes are stripped; no YAML dependency. */
function frontmatterValue(text, key) {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return undefined;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const match = line.match(new RegExp(`^${key}\\s*:\\s*(.*?)\\s*$`));
    if (!match) continue;
    const value = match[1];
    return /^"(.*)"$|^'(.*)'$/.test(value) ? value.slice(1, -1) : value;
  }
  return undefined;
}

function readSpecs() {
  return agentSpecFiles().map(({ name, file }) => {
    const text = fs.readFileSync(file, 'utf8');
    return { name, description: frontmatterValue(text, 'description') ?? '', access: frontmatterValue(text, 'access') };
  });
}

/** Every budget violation in a list of `{ name, description, access }`, as readable lines. */
function findings(specs) {
  const out = [];
  if (specs.length > MAX_SPECS) out.push(`${specs.length} specs exceed the cap of ${MAX_SPECS}`);
  for (const { name, description, access } of specs) {
    if (description.length > MAX_DESCRIPTION) {
      out.push(`${name}: description is ${description.length} characters, cap ${MAX_DESCRIPTION}`);
    }
    if (!ACCESS_VALUES.includes(access)) {
      out.push(`${name}: access is ${JSON.stringify(access)}, expected one of ${ACCESS_VALUES.join(', ')}`);
    }
  }
  const total = specs.reduce((sum, spec) => sum + spec.description.length, 0);
  if (total > MAX_TOTAL) out.push(`descriptions total ${total} characters, cap ${MAX_TOTAL}`);
  return out;
}

const specs = readSpecs();

test('G64: the shipped roster is within the spec count, description and total budgets and declares access', () => {
  assert.deepEqual(findings(specs), []);
});

test('G64: the check bites on an eighth spec, a 161-character description, and a 1,001-character sum', () => {
  const base = specs.map((spec) => ({ ...spec, access: 'read-only' }));
  assert.deepEqual(findings(base), [], 'controls start from a clean roster');

  const eighth = [...base, ...Array.from({ length: MAX_SPECS + 1 - base.length }, (_, i) => (
    { name: `extra-${i}.md`, description: 'x', access: 'write' }))];
  assert.match(findings(eighth).join('\n'), /exceed the cap of 7/);

  const long = base.map((spec, i) => (i === 0 ? { ...spec, description: 'x'.repeat(MAX_DESCRIPTION + 1) } : spec));
  assert.match(findings(long).join('\n'), /description is 161 characters/);

  // Five specs cannot reach the sum cap (5 x 160 = 800), so pad the roster to the spec cap first and
  // spread the excess so no single description trips its own cap.
  const padded = [...base, ...Array.from({ length: MAX_SPECS - base.length }, (_, i) => (
    { name: `pad-${i}.md`, description: '', access: 'write' }))];
  let need = MAX_TOTAL + 1 - padded.reduce((acc, spec) => acc + spec.description.length, 0);
  const over = padded.map((spec) => {
    const add = Math.min(need, MAX_DESCRIPTION - spec.description.length);
    need -= add;
    return { ...spec, description: spec.description + 'x'.repeat(add) };
  });
  assert.equal(need, 0, 'seven descriptions can hold 1,001 characters');
  assert.match(findings(over).join('\n'), /^descriptions total 1001 characters, cap 1000$/m);
  assert.equal(findings(over).length, 1, 'the sum control trips only the sum cap');

  const missing = base.map((spec, i) => (i === 0 ? { ...spec, access: undefined } : spec));
  assert.match(findings(missing).join('\n'), /access is undefined/);
});
