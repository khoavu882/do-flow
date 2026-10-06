'use strict';

/**
 * Offline fixture tests for bench/runner.js behaviour: parity classification and report rows.
 *
 * Every input is data built in this file. Nothing here dispatches a run, calls a model, or writes
 * under the checkout's bench/baseline, bench/runs or bench/reports; the runner functions under test
 * take the baseline and the results as arguments for exactly that reason.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createScratch } = require('../helper/scratch-env');

const scratch = createScratch('doflow-bench-runner-');
// The runner reads git state in-process; node --test gives each file its own process, so applying
// the scratch environment here keeps every call off the developer's HOME and git config.
scratch.apply();
after(() => {
  scratch.restore();
  scratch.remove();
});

const runner = require('../../bench/runner.js');

const entry = (key, name, kind, split) => {
  const [skill, id] = key.split('/');
  return { key, skill, evalId: Number(id), name, kind, split };
};
const corpusOf = (...entries) => new Map(entries.map((e) => [e.key, e]));
const result = (key, name, kind, split, extra = {}) => {
  const [skill, id] = key.split('/');
  return { key, skill, evalId: Number(id), evalName: name, kind, passRate: 1, sourceStatus: 'verified', ...(split ? { split } : {}), ...extra };
};

const ONE = entry('s/1', 'one', 'triggering', 'train');
const TWO = entry('s/2', 'two', 'behavioral', 'train');
const baseline = (results, caseCount = results.length) => ({ caseCount, results });
const BASE = baseline([result('s/1', 'one', 'triggering', 'train'), result('s/2', 'two', 'behavioral', 'train')]);

test('F2: parity is ok when corpus and baseline are identical', () => {
  const p = runner.compareParity(corpusOf(ONE, TWO), BASE);
  assert.equal(p.ok, true);
  assert.deepEqual(p.pending, []);
  assert.deepEqual(p.missingFromCorpus, []);
  assert.deepEqual(p.changed, []);
  assert.equal(p.countMismatch, null);
});

test('F2: an added case is pending and never affects ok', () => {
  const added = entry('s/3', 'three', 'triggering', 'heldout');
  const p = runner.compareParity(corpusOf(ONE, TWO, added), BASE);
  assert.equal(p.ok, true);
  assert.deepEqual(p.pending, [added]);
});

test('F2: a removed case fails and is named', () => {
  const p = runner.compareParity(corpusOf(ONE), BASE);
  assert.equal(p.ok, false);
  assert.deepEqual(p.missingFromCorpus.map((c) => c.key), ['s/2']);
  assert.deepEqual(p.pending, []);
});

test('F2: a renamed case is one change, not a removal plus a pending case', () => {
  const p = runner.compareParity(corpusOf(ONE, { ...TWO, name: 'renamed' }), BASE);
  assert.equal(p.ok, false);
  assert.deepEqual(p.changed.map((c) => c.key), ['s/2']);
  assert.deepEqual(p.missingFromCorpus, []);
  assert.deepEqual(p.pending, []);
  assert.equal(p.changed[0].corpus.name, 'renamed');
  assert.equal(p.changed[0].baseline.name, 'two');
});

test('F2: a kind change fails', () => {
  const p = runner.compareParity(corpusOf(ONE, { ...TWO, kind: 'triggering' }), BASE);
  assert.equal(p.ok, false);
  assert.deepEqual(p.changed.map((c) => c.key), ['s/2']);
});

test('F2: a split change fails when the baseline recorded a split', () => {
  const p = runner.compareParity(corpusOf(ONE, { ...TWO, split: 'heldout' }), BASE);
  assert.equal(p.ok, false);
  assert.deepEqual(p.changed.map((c) => c.key), ['s/2']);
  assert.equal(p.changed[0].corpus.split, 'heldout');
  assert.equal(p.changed[0].baseline.split, 'train');
});

test('F2: a baseline without split is never compared on split', () => {
  const old = baseline([result('s/1', 'one', 'triggering'), result('s/2', 'two', 'behavioral')]);
  const p = runner.compareParity(corpusOf(ONE, { ...TWO, split: 'heldout' }), old);
  assert.equal(p.ok, true);
  assert.deepEqual(p.changed, []);
});

test('F2: a caseCount that disagrees with the entries fails', () => {
  const p = runner.compareParity(corpusOf(ONE, TWO), baseline(BASE.results, 3));
  assert.equal(p.ok, false);
  assert.deepEqual(p.countMismatch, { baselineCaseCount: 3, baselineEntries: 2 });
});

test('F2: a missing baseline fails with a note and lists every case as pending', () => {
  const p = runner.compareParity(corpusOf(ONE, TWO), null, 'bench/baseline/baseline.json');
  assert.equal(p.ok, false);
  assert.equal(p.countMismatch.note, 'no baseline at bench/baseline/baseline.json');
  assert.equal(p.pending.length, 2);
});

test('F2: parity text names each pending case and exits through ok', () => {
  const added = entry('s/3', 'three', 'triggering', 'heldout');
  const lines = runner.parityLines(runner.compareParity(corpusOf(ONE, TWO, added), BASE));
  assert.deepEqual(lines, [
    'PENDING s/3 (triggering, heldout: three) awaits a paid baseline capture and has no baseline result',
    'ok  the committed baseline describes the committed corpus; 1 case(s) pending',
  ]);
  assert.deepEqual(runner.parityLines(runner.compareParity(corpusOf(ONE, TWO), BASE)),
    ['ok  the committed baseline describes the committed corpus']);
});

test('F2: parity text keeps the GAP lines for a removed case and repeats identically', () => {
  const p = runner.compareParity(corpusOf(ONE), BASE);
  const lines = runner.parityLines(p);
  assert.match(lines[0], /^GAP s\/2 is in the baseline but not in the corpus \(behavioral: two\)$/);
  assert.match(lines[lines.length - 1], /re-capture the baseline/);
  assert.deepEqual(runner.parityLines(runner.compareParity(corpusOf(ONE), BASE)), lines);
});

test('F6: a case with no baseline result is a pending row, and the note counts them', () => {
  const cfg = { model: 'm' };
  const report = runner.buildReport({
    baseline: { commit: 'abc', model: 'm', results: [result('s/1', 'one', 'triggering', 'train')] },
    withResults: [result('s/1', 'one', 'triggering', 'train'), result('s/3', 'three', 'triggering', 'heldout')],
    cfg, iteration: 'it', commit: 'def',
  });
  assert.deepEqual(report.rows.map((r) => [r.key, r.status]), [['s/1', 'unchanged'], ['s/3', 'pending']]);
  assert.equal(report.summary.pending, 1);
  assert.equal('new' in report.summary, false);
  assert.equal(report.pendingNote, '1 case(s) are pending: they await a paid baseline capture and carry no baseline result');
  assert.equal(report.rows[1].baseline, null);
  assert.equal(report.rows[1].delta, null);
  assert.equal(report.rows[1].sourceComparable, false);
});

test('F6: pendingNote is null when no row is pending, and repeated calls are equal', () => {
  const input = {
    baseline: { commit: 'abc', model: 'm', results: [result('s/1', 'one', 'triggering', 'train'), result('s/2', 'two', 'behavioral', 'train', { passRate: 0.5 })] },
    withResults: [result('s/1', 'one', 'triggering', 'train'), result('s/2', 'two', 'behavioral', 'train', { passRate: 1 })],
    cfg: { model: 'm' }, iteration: 'it', commit: 'def',
  };
  const report = runner.buildReport(input);
  assert.equal(report.pendingNote, null);
  assert.equal(report.summary.pending, 0);
  assert.equal(report.summary.improved, 1);
  assert.deepEqual(runner.buildReport(input), report);
});

// --- skill_not_routed (F1, with-skill rows) ---------------------------------------------------

function routingRun(name, routingText) {
  const dir = path.join(scratch.dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.txt'), 'ran');
  if (routingText !== null) fs.writeFileSync(path.join(dir, runner.RUN_ROUTING_FILE), routingText);
  return runner.loadRunContext(dir);
}
const NOT_ROUTED = { text: 'x is not used', type: 'skill_not_routed', skill: 'x' };

test('F1: routing.json {routed:false} for the skill passes', () => {
  const g = runner.gradeAssertion(NOT_ROUTED, routingRun('false', '{"skill":"x","routed":false,"reason":"belongs to y"}'));
  assert.equal(g.passed, true);
  assert.equal(g.evidence, 'routing.json: x not routed');
});

test('F1: routing.json {routed:true} fails with the routed evidence', () => {
  const g = runner.gradeAssertion(NOT_ROUTED, routingRun('true', '{"skill":"x","routed":true}'));
  assert.equal(g.passed, false);
  assert.equal(g.evidence, 'routing.json: x routed, the request should not route here');
});

test('F1: an absent routing.json fails and never passes vacuously', () => {
  const ctx = routingRun('absent', null);
  assert.equal(ctx.routing, null);
  const g = runner.gradeAssertion(NOT_ROUTED, ctx);
  assert.equal(g.passed, false);
  assert.match(g.evidence, /no routing\.json saved/);
});

test('F1: a malformed, non-boolean or wrong-skill routing.json fails with its own fault', () => {
  const malformed = routingRun('malformed', '{not json');
  assert.deepEqual(malformed.routing, { malformed: true });
  const cases = [
    [malformed, /not a JSON object/],
    [routingRun('array', '[]'), /not a JSON object/],
    [routingRun('nonbool', '{"skill":"x","routed":"false"}'), /no boolean routed/],
    [routingRun('wrong', '{"skill":"y","routed":false}'), /records skill "y", not x/],
  ];
  for (const [ctx, fault] of cases) {
    const g = runner.gradeAssertion(NOT_ROUTED, ctx);
    assert.equal(g.passed, false);
    assert.match(g.evidence, fault);
  }
});

test('F1: skill_not_routed is a known assertion type', () => {
  assert.ok(runner.ASSERTION_TYPES.includes('skill_not_routed'));
  assert.deepEqual(runner.SPLITS, ['train', 'heldout']);
});

test('F1: a triggering plan run asks for routing.json and saves it; a behavioral run does not', () => {
  const plan = runner.buildPlan(runner.loadConfig(), { iteration: 'fixture' });
  const triggering = plan.runs.filter((r) => r.kind === 'triggering');
  const behavioral = plan.runs.filter((r) => r.kind === 'behavioral');
  assert.ok(triggering.length > 0 && behavioral.length > 0);
  for (const r of triggering) {
    assert.ok(r.saveOutputs.includes('routing.json'), `${r.skill}/${r.evalId} does not save routing.json`);
    assert.ok(r.skills.instruction.includes(`Write the decision to routing.json as {"skill": "${r.skill}", "routed": true or false}.`));
    assert.match(r.skills.instruction, /Do NOT invoke/);
  }
  for (const r of behavioral) {
    assert.equal(r.saveOutputs.includes('routing.json'), false);
    assert.equal(r.skills.instruction.includes('routing.json'), false);
  }
});
