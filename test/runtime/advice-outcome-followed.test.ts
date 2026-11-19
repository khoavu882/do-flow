'use strict';

// 175 T8 (IC-010, FR-017, O-6): `doflow advise --action outcome --followed followed|partly|overruled`, through the real
// CLI in a scratch HOME and project. The label is accepted only for a pick the person was shown (mode `show` or `act`,
// or an ad hoc ask); at least one of `--actual` and `--followed` is required. No model is asked.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch, childEnv } = require('../helper/scratch-env.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { appendPick, readWindow } = require('../../src/runtime/advice/record.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const BIN = path.join(REPO_ROOT, 'bin/doflow.js');
const STORAGE = loadStorageRegistry({ repoRoot: REPO_ROOT });

function fixture(t: any) {
  const scratch = createScratch('doflow-advice-followed-');
  t.after(() => scratch.remove());
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(project);
  const env = childEnv(scratch, { CI: null, DOFLOW_SESSION_ROLE: null });
  const roots = resolveRoots({ registry: STORAGE, projectRoot: project, env });
  const pick = (overrides: any = {}) => appendPick({
    roots, kind: 'tier', state: 'private state', caller: 'advise', staticAnswer: 'standard', durationMs: 10,
    answer: { name: 'tier', type: 'choice', pick: 'frontier', probabilities: {}, confidence: 0.6, strength: { word: 'clear', between: null } },
    question: { name: 'tier', type: 'choice', options: { light: 'l', standard: 's', frontier: 'f' } },
    ...overrides,
  }).pickId;
  const run = (...args: string[]) => spawnSync(process.execPath, [BIN, 'advise', '--action', 'outcome', ...args], { cwd: project, env, encoding: 'utf8' });
  const outcomes = () => readWindow({ roots }).records.map((entry: any) => entry.record).filter((record: any) => record.type === 'outcome');
  return { roots, pick, run, outcomes };
}

test('(a) --followed on a shown pick writes the label, with --actual when given, and nothing else', (t) => {
  const f = fixture(t);
  const show = f.pick({ mode: 'show' });
  const act = f.pick({ mode: 'act', elevated: false });
  const adhoc = f.pick({
    kind: 'adhoc', staticAnswer: null,
    answer: { name: 'q', type: 'yesno', pick: 'yes', probabilities: {}, confidence: 0.6, strength: { word: 'clear', between: null } },
    question: { name: 'q', type: 'yesno', instructions: 'ad hoc question' },
  });

  const partly = f.run('--pick-id', show, '--followed', 'partly', '--json');
  assert.equal(partly.status, 0, partly.stderr);
  assert.deepEqual(JSON.parse(partly.stdout), { pickId: show, followed: 'partly', recorded: true, file: JSON.parse(partly.stdout).file });
  const both = f.run('--pick-id', act, '--followed', 'overruled', '--actual', 'light');
  assert.equal(both.status, 0, both.stderr);
  assert.match(both.stdout, new RegExp(`Recorded outcome for ${act}: actual light, overruled\\.`));
  const followed = f.run('--pick-id', adhoc, '--followed', 'followed');
  assert.equal(followed.status, 0, followed.stderr);

  const lines = f.outcomes();
  for (const line of lines) assert.equal(typeof line.at, 'string');
  assert.deepEqual(lines.map(({ at, ...rest }: any) => rest), [
    { schema: 1, type: 'outcome', pickId: show, source: 'caller', followed: 'partly' },
    { schema: 1, type: 'outcome', pickId: act, source: 'caller', actual: 'light', followed: 'overruled' },
    { schema: 1, type: 'outcome', pickId: adhoc, source: 'caller', followed: 'followed' },
  ]);
  assert.equal('actual' in lines[0], false, 'no actual key when none was given');
});

test('(a) --followed on a pick that was never shown is a usage error and writes nothing', (t) => {
  const f = fixture(t);
  for (const mode of ['shadow', undefined]) {
    const id = f.pick(mode ? { mode } : {});
    for (const args of [['--followed', 'followed'], ['--followed', 'partly', '--actual', 'standard']]) {
      const result = f.run('--pick-id', id, ...args);
      assert.equal(result.status, 2, `${mode} ${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, /this pick was never shown/);
    }
  }
  assert.deepEqual(f.outcomes(), []);
});

test('(a) --followed on a shadow ad hoc pick is refused: an ad hoc kind alone does not mean it was shown', (t) => {
  const f = fixture(t);
  const id = f.pick({
    kind: 'adhoc', mode: 'shadow', staticAnswer: null,
    answer: { name: 'q', type: 'yesno', pick: 'yes', probabilities: {}, confidence: 0.6, strength: { word: 'clear', between: null } },
    question: { name: 'q', type: 'yesno', instructions: 'ad hoc question' },
  });
  const result = f.run('--pick-id', id, '--followed', 'followed');
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /this pick was never shown/);
  assert.deepEqual(f.outcomes(), []);
});

test('(a) neither --actual nor --followed, or a --followed outside the three words, is a usage error', (t) => {
  const f = fixture(t);
  const id = f.pick({ mode: 'show' });
  const neither = f.run('--pick-id', id);
  assert.equal(neither.status, 2);
  assert.match(neither.stderr, /--actual or --followed is required/);
  const json = f.run('--pick-id', id, '--json');
  assert.equal(json.status, 2);
  assert.match(json.stdout, /--actual or --followed is required/);
  const bad = f.run('--pick-id', id, '--followed', 'mostly');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--followed must be one of: followed, partly, overruled/);
  assert.deepEqual(f.outcomes(), []);
});

test('--actual alone still labels any retained pick, shown or not', (t) => {
  const f = fixture(t);
  const id = f.pick({ mode: 'shadow' });
  const result = f.run('--pick-id', id, '--actual', 'standard');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Recorded outcome for ${id}: actual standard\\.`));
  assert.deepEqual(f.outcomes().map(({ at, ...rest }: any) => rest), [{ schema: 1, type: 'outcome', pickId: id, source: 'caller', actual: 'standard' }]);
});
