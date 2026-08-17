'use strict';

// G11 — evaluation coverage. A skill with no bench cases is a skill whose behaviour nobody can
// measure, which is exactly the state feature 008 exists to leave behind: the Phase D prose
// rewrite accepts behaviour drift, and that is only an acceptable trade when the drift is visible.
// A skill added later without cases would silently shrink the measured surface, so this guard
// reads the shipped skill list rather than any hand-maintained inventory.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { skillFiles } = require('./_shared');

const REPO = path.resolve(__dirname, '..', '..');
const BENCH = path.join(REPO, 'bench');

function casesFor(skill) {
  const file = path.join(BENCH, skill, 'evals.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('G11: every shipped skill has a bench case file', () => {
  const missing = skillFiles()
    .map(({ name }) => name)
    .filter((name) => casesFor(name) === null);
  assert.deepEqual(
    missing,
    [],
    `skills with no bench/<skill>/evals.json: ${missing.join(', ')}\n` +
      'Add cases, or the skill ships with behaviour nobody measures.',
  );
});

test('G11: every skill has both triggering and behavioural coverage', () => {
  const gaps = [];
  for (const { name } of skillFiles()) {
    const data = casesFor(name);
    if (!data) continue; // reported by the previous test; not double-counted here
    const kinds = new Set((data.evals || []).map((e) => e.kind));
    const missing = ['triggering', 'behavioral'].filter((k) => !kinds.has(k));
    if (missing.length) gaps.push(`${name} (missing: ${missing.join(', ')})`);
  }
  assert.deepEqual(
    gaps,
    [],
    `Triggering coverage answers "does it fire on the right request"; behavioural coverage answers\n` +
      `"is it correct once it fires". One without the other measures half the risk.\n${gaps.join('\n')}`,
  );
});

test('G11: case files are well formed and internally consistent', () => {
  const problems = [];
  for (const { name } of skillFiles()) {
    const data = casesFor(name);
    if (!data) continue;
    if (data.skill_name !== name) {
      problems.push(`${name}: skill_name is "${data.skill_name}"`);
    }
    const ids = new Set();
    for (const e of data.evals || []) {
      const where = `${name}/${e.id}`;
      if (ids.has(e.id)) problems.push(`${where}: duplicate id`);
      ids.add(e.id);
      if (!e.name) problems.push(`${where}: missing descriptive name`);
      if (!e.prompt) problems.push(`${where}: missing prompt`);
      if (!['triggering', 'behavioral'].includes(e.kind)) {
        problems.push(`${where}: kind must be triggering or behavioral, got "${e.kind}"`);
      }
      if (!Array.isArray(e.assertions) || e.assertions.length === 0) {
        problems.push(`${where}: no assertions — a case that asserts nothing cannot fail`);
      }
      for (const a of e.assertions || []) {
        if (!a.text) problems.push(`${where}: an assertion has no text`);
        // A regex that does not compile fails at grading time, long after it was written, and
        // reads as a failed assertion rather than a broken one. Catch it here instead.
        if (a.type === 'output_matches' || a.type === 'output_not_matches') {
          try {
            new RegExp(a.pattern, a.flags || 'm');
          } catch (err) {
            problems.push(`${where}: invalid regex /${a.pattern}/ — ${err.message}`);
          }
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('G11: the bench harness is not wired into the default test command', () => {
  // npm test is pure offline Node in ~14s. Pulling paid model calls into it would make the suite
  // cost money and stop being runnable in CI without credentials.
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test', 'npm test must stay the offline node runner');
  assert.ok(pkg.scripts.bench, 'the bench harness needs its own npm script');
  assert.ok(
    !pkg.scripts.test.includes('bench'),
    'npm test must not invoke the bench harness — it makes paid model calls',
  );
});
