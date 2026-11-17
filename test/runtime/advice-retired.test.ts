'use strict';

// Row 174 R-05: an outcome recorded by a retired source (`classify-verdict`) is not an observation of the pick it names, so
// doctor, the report and `advice-picks` count it in no figure. A counted outcome (`caller`, `brief-record`) still counts.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { appendPick, appendOutcome } = require('../../src/runtime/advice/record.ts');
const { buildReport } = require('../../src/runtime/advice/report.ts');
const { advicePicksBody } = require('../../src/runtime/advice/picks.ts');
const { buildAdviceDoctor } = require('../../src/runtime/advice/doctor.ts');

const STORAGE = loadStorageRegistry({ repoRoot: REPO_ROOT });
const NOW = () => new Date('2026-06-10T12:00:00.000Z');

function fixture(t: any) {
  const home = fs.realpathSync(tempDir(t, 'doflow-retired-home-'));
  const project = fs.realpathSync(tempDir(t, 'doflow-retired-project-'));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') };
  const roots = resolveRoots({ registry: STORAGE, projectRoot: project, global: false, env });
  const answer = { name: 'tier', type: 'choice', pick: 'frontier', probabilities: { standard: 0.2, frontier: 0.8 }, confidence: 0.8, strength: { word: 'clear', between: null } };
  const question = { name: 'tier', type: 'choice', options: { standard: 's', frontier: 'f' } };
  const written = (minutes: number) => appendPick({ roots, now: () => new Date(Date.parse('2026-06-10T00:00:00.000Z') + minutes * 60000),
    kind: 'tier', answer, question, staticAnswer: 'standard', state: 'state text', caller: 'advise' });
  const first = written(0).pickId;
  const second = written(1).pickId;
  // `first` has only a retired outcome (it would match); `second` has a counted one (it matches too).
  appendOutcome({ roots, now: NOW, pickId: first, actual: 'frontier', source: 'classify-verdict', store: 'project-state' });
  appendOutcome({ roots, now: NOW, pickId: second, actual: 'frontier', source: 'caller', store: 'project-state' });
  return { home, project, env, roots, first, second };
}

test('the report counts no retired-source outcome in its agreement', (t) => {
  const { roots } = fixture(t);
  const tier = buildReport({ roots, kinds: ['tier'], now: NOW }).kinds.tier;
  assert.equal(tier.n.picks, 2);
  assert.deepEqual(tier.agreeOutcome, { n: 1, agree: 1 }, 'only the caller outcome counts');
});

test('advice-picks shows no outcome for a pick whose only outcome has a retired source', (t) => {
  const { project, env, first, second } = fixture(t);
  const { exit, json: body } = advicePicksBody({ cwd: project, env, now: NOW, json: true, flags: ['--json'] });
  assert.equal(exit, 0);
  const byId = new Map<string, any>(body.picks.map((p: any) => [p.pickId, p]));
  assert.equal(byId.get(first).outcome, null);
  assert.equal(byId.get(second).outcome.actual, 'frontier');
});

test('doctor counts no retired-source outcome in withOutcome or matched', async (t) => {
  const { project, env, first } = fixture(t);
  const report = await buildAdviceDoctor({ repoRoot: REPO_ROOT, projectRoot: project, env, now: NOW });
  const tier = report.advice.kinds.find((row: any) => row.kind === 'tier');
  assert.equal(tier.picks, 2);
  assert.equal(tier.withOutcome, 1);
  assert.equal(tier.matched, 1);
  assert.deepEqual(tier.outcomeSources, ['caller']);
  assert.ok(first);
});
