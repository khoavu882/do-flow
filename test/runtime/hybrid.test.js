'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fuseRankedCandidates, normalizeCodeCandidates } = require('../../src/runtime/knowledge/hybrid.ts');

test('strict fusion normalizes full spans, deduplicates each provider vote and retains every origin', () => {
  const lists = [
    { provider: 'native.rg', capability: 'code.semantic-search', candidates: [
      { locator: { file: 'src/a.js', line: 4, endLine: 7 } },
      { locator: { file: 'src/a.js', line: 4, endLine: 7 } },
      { locator: { file: 'src/a.js', line: 4, endLine: 8 } },
    ] },
    { provider: 'semble.search', capability: 'code.semantic-search', candidates: [
      { locator: { file: 'src/a.js', line: 4, endLine: 7 } },
    ] },
  ];
  const result = fuseRankedCandidates({ rankedLists: lists, corpusIdentity: 'corpus-v1' });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].origins.length, 3);
  assert.equal(result.candidates[0].rrfScore, 1 / 61 + 1 / 61);
  assert.notEqual(result.candidates[0].id, result.candidates[1].id);
});

test('strict normalizer rejects traversal and invalid full spans', () => {
  const result = normalizeCodeCandidates([{ locator: '../escape.js:1' }, { locator: { file: 'ok.js', line: 0, endLine: 1 } }]);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected.length, 2);
});

// DEC-025 (IC-006): conceptual multi-provider lists fuse by file with vote depth D = requested top.
const CAP = 'code.semantic-search';
const fname = (i) => `src/f${String(i).padStart(2, '0')}.js`;
const span = ([file, line, endLine = line]) => ({ locator: { file, line, endLine } });
const list = (provider, spans, ref = provider === 'native.rg' ? 'ra-lex' : 'ra-sem') => ({ provider, capability: CAP, retrievalAttemptRef: ref, candidates: spans.map(span) });
const lexList = (files, line = 6, ref) => list('native.rg', files.map((f) => [f, line]), ref);
const semList = (spans, ref) => list('semble.search', spans, ref);
const fileFuse = (lists, depth = 10) => fuseRankedCandidates({ rankedLists: lists, corpusIdentity: 'c1', grain: 'file', depth }).candidates;
const files = (n) => Array.from({ length: n }, (_, i) => fname(i + 1));
const brief = (c) => `${c.locator.file}:${c.locator.line}-${c.locator.endLine}`;

test('DEC-025 file grain merges agreement: one candidate, both origins with their own locators, 2/61, widest span delivered', () => {
  const [c, ...rest] = fileFuse([lexList(['src/f.js']), semList([['src/f.js', 1, 20]])]);
  assert.equal(rest.length, 0, 'agreement occupies one slot (HEAD: two)');
  assert.equal(c.id, JSON.stringify(['c1', 'src/f.js']));
  assert.equal(c.rrfScore, 2 / 61);
  assert.deepEqual(c.locator, { file: 'src/f.js', line: 1, endLine: 20 });
  assert.deepEqual(c.origins.map((o) => [o.provider, o.locator.line, o.locator.endLine, o.originalRank, o.retrievalAttemptRef]),
    [['native.rg', 6, 6, 1, 'ra-lex'], ['semble.search', 1, 20, 1, 'ra-sem']]);
});

test('DEC-025 12-file same-order probe: the top 10 holds 10 distinct files (HEAD: 5)', () => {
  const all = files(12);
  const top = fileFuse([lexList(all), semList(all.map((f) => [f, 1, 20]))]).slice(0, 10);
  assert.deepEqual(top.map((c) => c.locator.file), all.slice(0, 10));
  assert.ok(top.every((c) => c.origins.length === 2));
});

test('DEC-025 reversed 12-file probe: 12 candidates, two origins each, equal-score ties by path, byte-identical across permuted input', () => {
  const all = files(12);
  const lists = [lexList(all), semList([...all].reverse().map((f) => [f, 1, 20]))];
  const view = (cs) => JSON.stringify(cs.map((c) => [c.id, c.locator, c.rrfScore, c.rank]));
  const out = fileFuse(lists, 12);
  assert.equal(out.length, 12);
  assert.ok(out.every((c) => c.origins.length === 2));
  assert.deepEqual(out.map((c) => c.locator.file), [1, 12, 2, 11, 3, 10, 4, 9, 5, 8, 6, 7].map(fname));
  for (let i = 0; i < 3; i += 1) assert.equal(view(fileFuse([lists[1], lists[0]], 12)), view(out));
});

test('DEC-025 RRF terms are summed in ascending-rank order, so equal rank multisets tie bit-identically (DEC-016)', () => {
  // ranks (1,3,10) for z and (3,10,1) for a: summed in list order they differ in the last bit and z would lead.
  const filler = (n, tag) => Array.from({ length: n }, (_, i) => [`src/${tag}${i}.js`, 1]);
  const p = list('p.one', [['src/z.js', 1], ...filler(1, 'p'), ['src/a.js', 1], ...filler(6, 'p2')]);
  const q = list('q.two', [...filler(2, 'q'), ['src/z.js', 1], ...filler(6, 'q2'), ['src/a.js', 1]]);
  const r = list('r.three', [['src/a.js', 1], ...filler(8, 'r'), ['src/z.js', 1]]);
  const out = fileFuse([p, q, r]);
  const [a, z] = ['src/a.js', 'src/z.js'].map((f) => out.find((c) => c.locator.file === f));
  assert.equal(a.rrfScore, z.rrfScore);
  assert.ok(out.indexOf(a) < out.indexOf(z), 'equal scores fall to canonical path');
});

test('DEC-025 semantic multi-chunk dense rank: [f1, f1, f2] gives f2 rank 2 and f1 one vote with both chunk origins', () => {
  const out = fileFuse([lexList(['src/other.js']), semList([['src/f1.js', 1, 9], ['src/f1.js', 30, 40], ['src/f2.js', 1, 5]])]);
  const f1 = out.find((c) => c.locator.file === 'src/f1.js');
  const f2 = out.find((c) => c.locator.file === 'src/f2.js');
  assert.equal(f2.rrfScore, 1 / 62, 'dense file rank 2, not raw chunk rank 3');
  assert.equal(f1.rrfScore, 1 / 61, 'one vote for two chunks');
  assert.deepEqual(f1.origins.map((o) => [o.locator.line, o.locator.endLine, o.originalRank]), [[1, 9, 1], [30, 40, 2]]);
  assert.deepEqual(f1.locator, { file: 'src/f1.js', line: 1, endLine: 9 }, 'the provider first-ranked span, never a union');
});

test('DEC-025 delivered span: widest first-ranked span; equal width goes to the better provider rank, then smaller line, then provider id', () => {
  const out = fileFuse([
    list('native.rg', [['src/x.js', 6], ['src/y.js', 40], ['src/z.js', 8], ['src/l.js', 5]]),
    list('semble.search', [['src/y.js', 30], ['src/w.js', 1, 3], ['src/z.js', 50], ['src/x.js', 10, 30]]),
  ]);
  const at = (f) => brief(out.find((c) => c.locator.file === f));
  assert.equal(at('src/x.js'), 'src/x.js:10-30', 'widest wins even when that provider ranks the file lower');
  assert.equal(at('src/y.js'), 'src/y.js:30-30', 'equal width: semantic ranks y first (case iv)');
  assert.equal(at('src/z.js'), 'src/z.js:8-8', 'equal width and equal rank: smaller line');
  assert.equal(at('src/l.js'), 'src/l.js:5-5', 'a lexical-only file keeps its line');
  assert.equal(at('src/w.js'), 'src/w.js:1-3');
  const [same] = fileFuse([list('semble.search', [['src/q.js', 7]]), list('native.rg', [['src/q.js', 7]])]);
  assert.equal(same.provider, 'native.rg', 'identical spans fall to provider id');
});

test('DEC-025 nested and adjacent spans share one file slot; each origin keeps its own locator', () => {
  for (const lexLine of [25, 20, 21]) {
    const out = fileFuse([lexList(['src/f.js'], lexLine), semList([['src/f.js', 1, 20]])]);
    assert.equal(out.length, 1);
    assert.equal(brief(out[0]), 'src/f.js:1-20');
    assert.equal(out[0].origins.find((o) => o.provider === 'native.rg').locator.line, lexLine);
  }
  const adjacent = fileFuse([lexList(['src/h.js'], 1), semList([['src/g.js', 1, 20], ['src/g.js', 21, 40]])]);
  assert.deepEqual(adjacent.map(brief), ['src/g.js:1-20', 'src/h.js:1-1']);
});

test('DEC-025 repeated attempts by one provider coalesce into one vote with both attempt refs', () => {
  const { coalesceProviderLists } = require('../../src/runtime/knowledge/code-retrieval.ts');
  const lists = coalesceProviderLists([lexList(['src/a.js', 'src/b.js'], 6, 'ra-1'), semList([['src/b.js', 1, 20], ['src/a.js', 1, 20]]), lexList(['src/a.js', 'src/b.js'], 6, 'ra-2')]);
  const out = fileFuse(lists);
  const a = out.find((c) => c.locator.file === 'src/a.js');
  assert.equal(a.rrfScore, 1 / 61 + 1 / 62, 'native.rg votes once');
  assert.deepEqual(a.origins.filter((o) => o.provider === 'native.rg').map((o) => o.retrievalAttemptRef), ['ra-1', 'ra-2']);
});

test('DEC-025 single-provider and exact lists keep span grain: file grain is a no-op on lexical-only output', () => {
  const lex = list('native.rg', [['src/a.js', 3], ['src/a.js', 9], ['src/b.js', 1]]);
  const span = fuseRankedCandidates({ rankedLists: [lex], corpusIdentity: 'c1' }).candidates;
  assert.deepEqual(fileFuse([lex]), span);
  assert.deepEqual(fileFuse([lex, semList([])]), span, 'an empty semantic list grants no file grain');
  assert.equal(span.length, 3);
  assert.equal(span[0].id, JSON.stringify(['c1', 'src/a.js', 3, 3]));
});

test('DEC-025 depth cap: 15 files agreed at ranks 11-25 cannot push out the semantic top files (fails unbounded)', () => {
  const noise = Array.from({ length: 15 }, (_, i) => `src/n${String(i).padStart(2, '0')}.js`);
  const lexOnly = Array.from({ length: 10 }, (_, i) => `src/l${i}.js`);
  const semOnly = ['src/a-sem.js', ...Array.from({ length: 9 }, (_, i) => `src/s${i}.js`)];
  const out = fileFuse([lexList([...lexOnly, ...noise]), semList([...semOnly, ...noise].map((f) => [f, 1, 20]))]);
  const top = out.slice(0, 10).map((c) => c.locator.file);
  assert.equal(top[0], 'src/a-sem.js');
  assert.equal(top.some((f) => noise.includes(f)), false, JSON.stringify(top));
  assert.ok(out.slice(20).every((c) => c.rrfScore === 0), 'files beyond every provider depth are unscored');
});

test('DEC-025 agreement within the depth outranks a single first-place vote', () => {
  const out = fileFuse([lexList(['src/l1.js', 'src/l2.js', 'src/both.js']), semList([['src/s1.js', 1, 9], ['src/s2.js', 1, 9], ['src/both.js', 1, 9]])]);
  assert.equal(out[0].locator.file, 'src/both.js');
  assert.equal(out[0].rrfScore, 2 / 63);
});

test('DEC-025 unscored tail follows every voted file by smallest provider rank, then path, deterministically', () => {
  const lex = lexList(['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js']);
  const sem = semList([['src/e.js', 1, 9], ['src/f.js', 1, 9], ['src/d.js', 1, 9], ['src/g.js', 1, 9]]);
  const out = fileFuse([lex, sem], 2);
  assert.deepEqual(out.map((c) => c.locator.file), ['a', 'e', 'b', 'f', 'c', 'd', 'g'].map((n) => `src/${n}.js`));
  assert.deepEqual(out.map((c) => c.rrfScore > 0), [true, true, true, true, false, false, false]);
  const bytes = JSON.stringify(out.map((c) => [c.id, c.locator, c.rrfScore]));
  for (let i = 0; i < 3; i += 1) assert.equal(JSON.stringify(fileFuse([sem, lex], 2).map((c) => [c.id, c.locator, c.rrfScore])), bytes);
});

test('DEC-025 top = 1: differing first places fall to full-depth RRF, then path', () => {
  const out = fileFuse([lexList(['src/z.js', 'src/y.js']), semList([['src/a.js', 1, 9], ['src/m.js', 1, 9], ['src/n.js', 1, 9], ['src/o.js', 1, 9], ['src/z.js', 1, 9]])], 1);
  assert.deepEqual(out.slice(0, 2).map((c) => c.locator.file), ['src/z.js', 'src/a.js'], 'z also has a deeper semantic vote');
  const none = fileFuse([lexList(['src/z.js']), semList([['src/a.js', 1, 9]])], 1);
  assert.deepEqual(none.map((c) => c.locator.file), ['src/a.js', 'src/z.js']);
});
