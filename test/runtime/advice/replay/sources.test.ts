'use strict';

// 175 F-09 (design section 4): the case-source seam drops a case whose label or rule is not an option of the kind's
// question, counts it under `skipped['bad-label']`, and so keeps a stray class out of the figures. The source here is
// a fixture injected into the seam; no shipped source produces a stray label.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCases, optionNames } = require('../../../../src/runtime/advice/replay/sources/index.ts');
const { score } = require('../../../../src/runtime/advice/replay/score.ts');
const { caseSetDigest } = require('../../../../src/runtime/advice/replay/trust.ts');
const { loadAdviceRegistry } = require('../../../../src/runtime/advice/registry.ts');
const { REPO_ROOT } = require('../../../../src/helper/repo-root.ts');

const BARS = loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry.bars;

function fixtureSource(specs: Array<{ label: string; rule?: string }>, skipped: Record<string, number> = {}) {
  return {
    id: 'fixture', builderVersion: 1, labelIsRule: false, origin: 'project' as const,
    build: () => ({
      cases: specs.map((spec, i) => ({ id: i.toString(16).padStart(16, '0'), state: `state ${i}`, label: spec.label, rule: spec.rule ?? spec.label })),
      skipped: { ...skipped },
    }),
  };
}

const INPUT = { projectRoot: '/nowhere', roots: {}, kind: {} };
const repeat = (n: number, spec: { label: string; rule?: string }) => Array.from({ length: n }, () => spec);

test('F-09: a stray label or rule is dropped and counted as bad-label; the minority is not inflated', () => {
  const specs = [...repeat(90, { label: 'yes' }), ...repeat(5, { label: 'no' }), ...repeat(10, { label: 'maybe' })];
  const built = buildCases(fixtureSource(specs), INPUT, ['yes', 'no']);
  assert.equal(built.cases.length, 95);
  assert.deepEqual(built.skipped, { 'bad-label': 10 });
  assert.ok(built.cases.every((c: any) => c.label === 'yes' || c.label === 'no'));

  const answered = built.cases.map((c: any) => ({ id: c.id, label: c.label, rule: c.rule, model: c.label, latencyMs: 10 }));
  const metrics = score(answered, { options: ['yes', 'no'], bars: BARS, budgetMs: 1000 });
  assert.equal(metrics.minority, 5);
  // Without the seam the stray class counts as outside the largest class: 5 + 10.
  const unfiltered = fixtureSource(specs).build().cases.map((c: any) => ({ id: c.id, label: c.label, rule: c.rule, model: c.label, latencyMs: 10 }));
  assert.equal(score(unfiltered, { options: ['yes', 'no'], bars: BARS, budgetMs: 1000 }).minority, 15);

  const ruleOnly = buildCases(fixtureSource([{ label: 'yes', rule: 'perhaps' }, { label: 'no' }]), INPUT, ['yes', 'no']);
  assert.equal(ruleOnly.cases.length, 1);
  assert.deepEqual(ruleOnly.skipped, { 'bad-label': 1 });
});

test('F-09: the case-set digest ignores the dropped case, skips the source already counted are kept, and no options means no filter', () => {
  const clean = buildCases(fixtureSource(repeat(3, { label: 'yes' })), INPUT, ['yes', 'no']);
  const dirty = buildCases(fixtureSource([...repeat(3, { label: 'yes' }), { label: 'maybe' }], { 'unreadable-file': 2 }), INPUT, ['yes', 'no']);
  assert.equal(caseSetDigest(dirty.cases), caseSetDigest(clean.cases));
  assert.deepEqual(dirty.skipped, { 'unreadable-file': 2, 'bad-label': 1 });
  assert.equal(buildCases(fixtureSource([{ label: 'maybe' }]), INPUT, null).cases.length, 1);
  assert.deepEqual(optionNames({ type: 'yesno' }), ['yes', 'no']);
  assert.deepEqual(optionNames({ type: 'choice', options: { light: 'l', standard: 's' } }), ['light', 'standard']);
});
