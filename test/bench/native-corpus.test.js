'use strict';

/**
 * Offline validation of the native-session corpus and its grader.
 *
 * `bench/native/README.md` stated that "Offline tests validate the broken fixtures and the grader"
 * while no test anywhere referenced `bench/native` — the runner, the five cases and the grading rules
 * had no coverage at all, and the sentence asserting otherwise is the kind of claim that stops anyone
 * from looking. These tests are that validation.
 *
 * What they deliberately do not do: run a native host. A live session needs an operator, a real model
 * and money, which is why `bench/native/runner.js` says the offline suite never launches one. Nothing
 * here spawns a host or executes the `install` argv that `prepare` records — it is checked as data.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { corpus, prepare, grade } = require('../../bench/native/runner');

const REPO = path.resolve(__dirname, '../..');
const SKILLS_DIR = path.join(REPO, 'core', 'shared', 'skills');

function tmpDir(suffix) {
  // prepare() requires a directory that does not exist yet, so name one inside a real temp root.
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-native-')), suffix);
}

test('every case starts from a fixture that fails its own checks', () => {
  // The load-bearing property of the whole corpus. A case whose starting files already satisfy
  // `checks` measures nothing: the host could do absolutely nothing and still be graded taskSuccess.
  // That failure mode is invisible in a live run, because a PASS looks exactly like a real PASS.
  const vacuous = [];
  for (const item of corpus.cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-native-fixture-'));
    for (const [file, body] of Object.entries(item.files || {})) {
      fs.writeFileSync(path.join(dir, file), body);
    }
    const run = spawnSync(process.execPath, ['-e', item.checks], {
      cwd: dir, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    });
    if (run.status === 0) vacuous.push(item.id);
  }
  assert.deepEqual(vacuous, [],
    'these cases ship a fixture that already passes its own checks, so the case cannot measure '
    + `anything:\n  ${vacuous.join('\n  ')}`);
});

test('the corpus declares unique ids, real skills, and at least one message per case', () => {
  const ids = corpus.cases.map((c) => c.id);
  assert.deepEqual(ids, [...new Set(ids)], 'case ids must be unique: grade() looks a case up by id');
  assert.ok(corpus.harnesses.length > 0, 'at least one harness must be declared');

  const shipped = new Set(fs.readdirSync(SKILLS_DIR)
    .filter((name) => fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md'))));

  const problems = [];
  for (const item of corpus.cases) {
    if (!Array.isArray(item.messages) || item.messages.length === 0) problems.push(`${item.id}: no messages`);
    if (!item.checks) problems.push(`${item.id}: no checks program`);
    if (typeof item.maxQuestions !== 'number') problems.push(`${item.id}: maxQuestions is not a number`);
    for (const skill of item.expectedSkills || []) {
      // An expectedSkills entry naming a skill that does not ship can never be satisfied, so the case
      // would grade routing:false forever and read as a host failure rather than a corpus error.
      if (!shipped.has(skill)) problems.push(`${item.id}: expects skill '${skill}', which does not ship`);
    }
  }
  assert.deepEqual(problems, [], `native corpus problems:\n  ${problems.join('\n  ')}`);
});

test('prepare records the plan without installing anything, and refuses to overwrite a run', () => {
  const dir = tmpDir('run');
  const plan = prepare({
    id: 'routing',
    harness: corpus.harnesses[0],
    directory: dir,
    model: 'test-model',
    hostVersion: 'test-host-1.0',
  });

  assert.equal(plan.id, 'routing');
  assert.equal(plan.version, 1);
  assert.ok(fs.existsSync(path.join(dir, 'plan.json')), 'the plan is written to disk');
  assert.ok(fs.existsSync(path.join(dir, 'workspace', 'slug.js')), 'the fixture lands in workspace/');

  // The install command is recorded as an argv for an operator to run, never executed here.
  assert.equal(plan.install.executable, process.execPath);
  assert.ok(plan.install.args.includes('install'));
  assert.ok(!fs.existsSync(path.join(dir, 'workspace', '.claude')),
    'prepare must not have performed the install it only describes');

  for (const skill of corpus.cases.find((c) => c.id === 'routing').expectedSkills) {
    assert.match(plan.sourceHashes[skill], /^[0-9a-f]{64}$/,
      'every expected skill must have a recorded source hash, since grade() compares reads against it');
  }

  assert.throws(() => prepare({
    id: 'routing', harness: corpus.harnesses[0], directory: dir, model: 'm', hostVersion: 'h',
  }), 'a second prepare into the same directory must fail rather than overwrite measured work');
});

test('prepare rejects an unknown harness and a missing model or host version', () => {
  assert.throws(() => prepare({
    id: 'routing', harness: 'not-a-harness', directory: tmpDir('a'), model: 'm', hostVersion: 'h',
  }), /harness/);
  assert.throws(() => prepare({
    id: 'routing', harness: corpus.harnesses[0], directory: tmpDir('b'), model: '', hostVersion: 'h',
  }), /model and hostVersion/);
  assert.throws(() => prepare({
    id: 'not-a-case', harness: corpus.harnesses[0], directory: tmpDir('c'), model: 'm', hostVersion: 'h',
  }), /Unknown native case/);
});

test('grading a run with no controller record is INCONCLUSIVE, never PASS', () => {
  // The fixture is still broken and no session was recorded, so there is nothing to conclude. The
  // distinction matters: a missing controller record must not be reported as a failing host, and it
  // must certainly not be reported as a passing one.
  const dir = tmpDir('ungraded');
  prepare({
    id: 'routing', harness: corpus.harnesses[0], directory: dir, model: 'm', hostVersion: 'h',
  });

  const result = grade(dir);
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(result.metrics.taskSuccess, false, 'the untouched fixture still fails its checks');
  assert.ok(result.missing.length > 0, 'what was absent is named rather than implied');
  assert.equal(result.metrics.routing, null, 'routing is unknown, not false, with no observed reads');
});

test('grade refuses a run whose case changed after preparation', () => {
  const dir = tmpDir('stale');
  prepare({
    id: 'routing', harness: corpus.harnesses[0], directory: dir, model: 'm', hostVersion: 'h',
  });

  // Simulate the corpus moving under a prepared run by corrupting the recorded hash.
  const planPath = path.join(dir, 'plan.json');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  plan.corpusHash = '0'.repeat(64);
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

  assert.throws(() => grade(dir), /Case changed since preparation/,
    'grading against a different case than was prepared would attribute one case\'s result to another');
});
