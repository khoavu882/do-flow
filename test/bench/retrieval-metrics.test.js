'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../../bench/retrieval/lib/metrics.js');

const pathInfo = (p) => (p.startsWith('src/') ? { lineCount: 100 } : null);
const cand = (path, startLine, endLine, rank, extra = {}) => ({ path, startLine, endLine, heading: null, rank, provider: 'p', snippetBytes: 10, ...extra });
const qrel = (id, path, startLine, endLine, rel = 2, extra = {}) => ({ id, path, startLine, endLine, rel, anchorSha: 'x', ...extra });
const answer = (candidates, extra = {}) => ({ result: 'RETRIEVED', freshness: 'NOT_APPLICABLE', candidates, providers: [], payloadBytes: 0, wallMs: 1, ...extra });
const codeTask = (over) => ({ corpus: 'code', class: 'conceptual-discovery', qrels: [], expect: { result: ['RETRIEVED'] }, ...over });

test('class applicability: three classes are n/a on guidance, all apply to code', () => {
  assert.equal(m.CLASSES.length, 8);
  for (const cls of m.CLASSES) assert.deepEqual(m.applicability(cls, 'code'), { applicable: true });
  for (const cls of ['impact-refactor', 'unavailable-provider', 'verification-failure']) {
    const a = m.applicability(cls, 'guidance');
    assert.equal(a.applicable, false);
    assert.ok(a.reason.length > 0);
  }
  assert.deepEqual(m.classesFor('guidance'), ['exact-lookup', 'conceptual-discovery', 'stale-index', 'dirty-tree', 'oversized-context']);
  assert.throws(() => m.applicability('nope', 'code'), /unknown query class/);
});

test('minN: ranking classes 10, outcome classes 3', () => {
  assert.equal(m.minNFor('exact-lookup'), 10);
  assert.equal(m.minNFor('dirty-tree'), 3);
});

test('code match rule is span overlap; null lines hit only at file level', () => {
  const q = qrel('q1', 'src/a.ts', 10, 20);
  assert.equal(m.hits('code', cand('src/a.ts', 20, 25, 1), q), true);
  assert.equal(m.hits('code', cand('src/a.ts', 21, 25, 1), q), false);
  assert.equal(m.hits('code', cand('src/b.ts', 10, 20, 1), q), false);
  assert.equal(m.hits('code', cand('src/a.ts', null, null, 1), q), false);
  assert.equal(m.hits('code', cand('src/a.ts', null, null, 1), q, true), true);
});

test('guidance match rule is path plus normalised heading', () => {
  const q = { id: 'q1', path: 'g.md', heading: '## Safety rules', rel: 2, startLine: 1, endLine: 2 };
  assert.equal(m.hits('guidance', { path: 'g.md', heading: '  Safety rules ' }, q), true);
  assert.equal(m.hits('guidance', { path: 'g.md', heading: '### Other' }, q), false);
  assert.equal(m.hits('guidance', { path: 'g.md', heading: null }, q), false);
  assert.equal(m.hits('guidance', { path: 'g.md', heading: null }, q, true), true);
});

test('recall, MRR and success are computed from best ranks, each qrel credited once', () => {
  const task = codeTask({
    class: 'exact-lookup',
    qrels: [qrel('q1', 'src/a.ts', 1, 5, 2), qrel('q2', 'src/b.ts', 1, 5, 1)],
  });
  const ans = answer([cand('src/x.ts', 1, 2, 1), cand('src/a.ts', 3, 4, 2), cand('src/a.ts', 1, 5, 3), cand('src/y.ts', 1, 2, 4), cand('src/z.ts', 1, 2, 5), cand('src/b.ts', 2, 3, 6)]);
  const { metrics } = m.scoreTask({ task, answer: ans, pathInfo });
  assert.equal(metrics.recallAt1, 0);
  assert.equal(metrics.recallAt5, 0.5);
  assert.equal(metrics.recallAt10, 1);
  assert.equal(metrics.mrrAt10, 0.5);
  assert.equal(metrics.successAt1, 0);
  assert.equal(metrics.fileRecallAt1, 0);
  assert.equal(metrics.fileRecallAt5, 0.5);
  const top = m.scoreTask({ task, answer: answer([cand('src/a.ts', 1, 5, 1)]), pathInfo });
  assert.equal(top.metrics.successAt1, 1);
  assert.equal(top.metrics.recallAt1, 0.5);
});

test('nDCG at 10 matches a hand computation', () => {
  const task = codeTask({ qrels: [qrel('q1', 'src/a.ts', 1, 5, 2), qrel('q2', 'src/b.ts', 1, 5, 1)] });
  const ans = answer([cand('src/b.ts', 1, 5, 1), cand('src/a.ts', 1, 5, 2)]);
  const { metrics } = m.scoreTask({ task, answer: ans, pathInfo });
  const dcg = 1 / Math.log2(2) + 3 / Math.log2(3);
  const idcg = 3 / Math.log2(2) + 1 / Math.log2(3);
  assert.ok(Math.abs(metrics.ndcgAt10 - dcg / idcg) < 1e-12);
  const g = m.scoreTask({ task: { ...task, corpus: 'guidance', qrels: [{ ...task.qrels[0], heading: 'h' }] }, answer: answer([]), pathInfo });
  assert.equal(g.metrics.ndcgAt10, undefined, 'nDCG is a code metric');
});

test('locatorValidity is the valid fraction, and N/A (null, never 1.0) when nothing was returned', () => {
  const task = codeTask({ qrels: [qrel('q1', 'src/a.ts', 1, 5)] });
  const ans = answer([cand('src/a.ts', 1, 5, 1), cand('src/a.ts', 90, 120, 2), cand('docs/x.md', 1, 2, 3), cand('src/a.ts', null, null, 4)]);
  assert.equal(m.scoreTask({ task, answer: ans, pathInfo }).metrics.locatorValidity, 0.5);
  const empty = m.scoreTask({ task, answer: answer([], { result: 'EMPTY' }), pathInfo });
  assert.equal(empty.metrics.locatorValidity, null);
  assert.deepEqual(empty.na, { locatorValidity: true });
});

test('falseAbsence and statusMatch', () => {
  const task = codeTask({ qrels: [qrel('q1', 'src/a.ts', 1, 5)], expect: { result: ['RETRIEVED'] } });
  const r = m.scoreTask({ task, answer: answer([], { result: 'EMPTY' }), pathInfo }).metrics;
  assert.equal(r.falseAbsence, 1);
  assert.equal(r.statusMatch, 0);
  const ok = m.scoreTask({ task, answer: answer([cand('src/a.ts', 1, 5, 1)]), pathInfo }).metrics;
  assert.equal(ok.falseAbsence, 0);
  assert.equal(ok.statusMatch, 1);
});

test('true negative exact lookup is scored on statusMatch only', () => {
  const task = codeTask({ class: 'exact-lookup', qrels: [], expect: { result: ['EMPTY'] } });
  const { metrics } = m.scoreTask({ task, answer: answer([], { result: 'EMPTY' }), pathInfo });
  assert.equal(metrics.statusMatch, 1);
  assert.equal(metrics.falseAbsence, 0);
  assert.equal(metrics.recallAt10, null);
  assert.equal(metrics.successAt1, null);
  assert.equal(metrics.mrrAt10, null);
});

test('impact-refactor: missedDependencies and allDependenciesFound', () => {
  const task = codeTask({
    class: 'impact-refactor',
    qrels: [qrel('q1', 'src/a.ts', 1, 5)],
    dependencies: [qrel('q2', 'src/b.ts', 1, 5, 1), qrel('q3', 'src/c.ts', 1, 5, 1)],
  });
  const part = m.scoreTask({ task, answer: answer([cand('src/b.ts', 1, 2, 1)]), pathInfo }).metrics;
  assert.equal(part.missedDependencies, 0.5);
  assert.equal(part.allDependenciesFound, 0);
  const all = m.scoreTask({ task, answer: answer([cand('src/b.ts', 1, 2, 1), cand('src/c.ts', 1, 2, 2)]), pathInfo }).metrics;
  assert.equal(all.missedDependencies, 0);
  assert.equal(all.allDependenciesFound, 1);
});

test('oversized-context: mustInclude counts only what fits the budget, silent truncation scores 0', () => {
  const task = codeTask({
    class: 'oversized-context',
    qrels: [qrel('q1', 'src/a.ts', 1, 5), qrel('q2', 'src/b.ts', 1, 5)],
    expect: { result: ['RETRIEVED'], mustInclude: ['q1', 'q2'], budgetBytes: 15 },
  });
  const ans = answer([cand('src/a.ts', 1, 5, 1), cand('src/b.ts', 1, 5, 2), cand('src/c.ts', 1, 5, 3)]);
  assert.equal(m.scoreTask({ task, answer: ans, pathInfo }).metrics.mustIncludeMet, 0);
  const roomy = { ...task, expect: { ...task.expect, budgetBytes: 20 } };
  assert.equal(m.scoreTask({ task: roomy, answer: ans, pathInfo }).metrics.mustIncludeMet, 1);
});

test('verification-failure: every line survives and the exit code matches', () => {
  const task = codeTask({
    class: 'verification-failure',
    expect: { result: ['RETRIEVED'], mustSurvive: { exitCode: 1, lines: ['FAIL a', 'boom'] } },
  });
  const ok = m.scoreTask({ task, answer: answer([], { output: 'x\nFAIL a\nboom\n', exitCode: 1 }), pathInfo }).metrics;
  assert.equal(ok.mustSurviveMet, 1);
  assert.equal(m.scoreTask({ task, answer: answer([], { output: 'FAIL a', exitCode: 1 }), pathInfo }).metrics.mustSurviveMet, 0);
  assert.equal(m.scoreTask({ task, answer: answer([], { output: 'FAIL a\nboom', exitCode: 0 }), pathInfo }).metrics.mustSurviveMet, 0);
});

test('tokensEst is ceil(bytes / 4) and carries its basis; guidance graph hits are reported apart', () => {
  const task = { corpus: 'guidance', class: 'conceptual-discovery', qrels: [{ id: 'q1', path: 'g.md', heading: 'H', startLine: 1, endLine: 2, rel: 2 }], expect: { result: ['RETRIEVED'] } };
  const organic = { path: 'g.md', heading: 'Other', startLine: null, endLine: null, rank: 1, provider: 'guidance.bm25', snippetBytes: 5 };
  const graph = { path: 'g.md', heading: 'H', startLine: null, endLine: null, rank: 1, provider: 'guidance.bm25', snippetBytes: 5 };
  const r = m.scoreTask({ task, answer: answer([organic], { payloadBytes: 9, graphCandidates: [graph] }), pathInfo: () => ({ lineCount: 10 }) });
  assert.equal(r.metrics.tokensEst, 3);
  assert.equal(m.TOKENS_BASIS, 'estimated:bytes/4');
  assert.equal(r.metrics.recallAt5, 0);
  assert.equal(r.graphMetrics.recallAt5, 1);
  assert.deepEqual(Object.keys(r.metrics).filter((k) => k.startsWith('recallAt')), ['recallAt1', 'recallAt3', 'recallAt5']);
});

test('macro aggregation prints n and skips undefined values; falseAbsence reports count and rate', () => {
  assert.deepEqual(m.macro([1, 0, null, 0.5]), { value: 0.5, n: 3 });
  assert.deepEqual(m.macro([null]), { value: null, n: 0, na: true });
  const agg = m.aggregate([{ recallAt1: 1, falseAbsence: 0 }, { recallAt1: null, falseAbsence: 1 }, { recallAt1: 0, falseAbsence: 1 }]);
  assert.deepEqual(agg.recallAt1, { value: 0.5, n: 2 });
  assert.deepEqual(agg.falseAbsence, { count: 2, rate: 2 / 3, n: 3 });
});
