'use strict';

// 141 IC-008 (common figures): the report over a fixture window, old-format lines, the one-project footer, read-only.
// No model is called; records are written through record.ts or as raw lines.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { appendPick, appendMiss, appendOutcome } = require('../../src/runtime/advice/record.ts');
const { buildReport, renderText, FOOTER } = require('../../src/runtime/advice/report.ts');

const REPO = path.resolve(__dirname, '../..');
const BIN = path.join(REPO, 'bin/doflow.js');
const STORAGE = loadStorageRegistry({ repoRoot: REPO });
const NOW = () => new Date('2026-06-10T12:00:00.000Z');
const KINDS = ['tier', 'task-class'];

function fixture(t: any) {
  const home = tempDir(t, 'doflow-report-home-');
  const project = tempDir(t, 'doflow-report-project-');
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') };
  const roots = resolveRoots({ registry: STORAGE, projectRoot: project, global: false, env });
  return { roots, project, env };
}

function pick(roots: any, minutes: number, overrides: any = {}) {
  const answer = { name: 'tier', type: 'choice', pick: 'standard', probabilities: { light: 0.1, standard: 0.8, frontier: 0.1 }, confidence: 0.7, strength: { word: 'clear', between: null } };
  const question = { name: 'tier', type: 'choice', options: { light: 'l', standard: 's', frontier: 'f' } };
  return appendPick({
    roots, now: () => new Date(Date.parse('2026-06-10T00:00:00.000Z') + minutes * 60000), kind: 'tier', answer, question,
    state: 'private state text', caller: 'advise', ...overrides,
  });
}

function rawLine(roots: any, date: string, value: any) {
  const file = path.join(roots['project-state'], 'advice', 'picks', `${date}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value)}\n`);
}

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(`${p}:${fs.statSync(p).size}`); } };
  walk(dir);
  return out.sort();
}

test('counts, agreement, modes, misses by reason and nearest-rank durations carry their n', (t) => {
  const { roots } = fixture(t);
  const ids: string[] = [];
  const specs: any[] = [
    { staticAnswer: 'standard', durationMs: 100, mode: 'shadow' },
    { staticAnswer: 'light', durationMs: 200, mode: 'shadow' },
    { staticAnswer: null, durationMs: 300, mode: 'act', elevated: true },
    { staticAnswer: 'standard', durationMs: 400 },
  ];
  specs.forEach((spec, i) => ids.push(pick(roots, i, spec).pickId));
  appendOutcome({ roots, now: NOW, pickId: ids[0], actual: 'standard', source: 'caller', store: 'project-state' });
  appendOutcome({ roots, now: NOW, pickId: ids[1], actual: 'light', source: 'caller', store: 'project-state' });
  appendMiss({ roots, now: NOW, kind: 'tier', caller: 'advise', reason: 'timeout', durationMs: 50 });
  appendMiss({ roots, now: NOW, kind: 'tier', caller: 'advise', reason: 'timeout', durationMs: 70 });
  appendMiss({ roots, now: NOW, kind: 'tier', caller: 'advise', reason: 'unreachable', durationMs: 5 });

  const report = buildReport({ roots, kinds: KINDS, now: NOW });
  const tier = report.kinds.tier;
  assert.deepEqual(tier.n, { picks: 4, misses: 3 });
  assert.deepEqual(tier.missesByReason, { timeout: 2, unreachable: 1 });
  assert.deepEqual(tier.agreeStatic, { n: 3, agree: 2 });
  assert.deepEqual(tier.agreeOutcome, { n: 2, agree: 1 });
  assert.equal(tier.elevated, 1);
  assert.deepEqual(tier.modes, { shadow: 2, act: 1, unrecorded: 1 });
  assert.deepEqual(tier.durationMs, { n: 4, p50: 200, p90: 400, p95: 400 });
  assert.deepEqual(tier.missDurationMs, { n: 3, p50: 50, p90: 70, p95: 70 });
  assert.deepEqual(report.window, { from: '2026-03-12', to: '2026-06-10', maxAgeDays: 90 });
  assert.equal(report.scope, 'this project only');
});

test('a kind with no records reads no data in text and null figures in JSON', (t) => {
  const { roots } = fixture(t);
  pick(roots, 0);
  const report = buildReport({ roots, kinds: KINDS, now: NOW });
  assert.deepEqual(report.kinds['task-class'].n, { picks: 0, misses: 0 });
  assert.equal(report.kinds['task-class'].agreeStatic, null);
  assert.equal(report.kinds['task-class'].durationMs, null);
  assert.match(renderText(report), /task-class\n {2}no data/);
});

test('lines in the old record format stay readable and unreadable lines are counted', (t) => {
  const { roots } = fixture(t);
  rawLine(roots, '2026-06-09', { schema: 1, type: 'pick', pickId: 'adv-1780000000000-aaaaaa', at: '2026-06-09T01:00:00.000Z', kind: 'tier', question: 'tier', qtype: 'choice', options: ['light', 'standard'], pick: 'light', static: 'light', durationMs: 900 });
  rawLine(roots, '2026-06-09', { schema: 1, type: 'miss', at: '2026-06-09T02:00:00.000Z', kind: 'tier', caller: 'advise', reason: 'timeout' });
  rawLine(roots, '2026-06-09', 'not json');
  const report = buildReport({ roots, kinds: KINDS, now: NOW });
  assert.equal(report.unreadable, 1);
  assert.deepEqual(report.kinds.tier.n, { picks: 1, misses: 1 });
  assert.deepEqual(report.kinds.tier.modes, { shadow: 0, act: 0, unrecorded: 1 });
  assert.equal(report.kinds.tier.elevated, 0);
  assert.deepEqual(report.kinds.tier.durationMs, { n: 1, p50: 900, p90: 900, p95: 900 });
  assert.deepEqual(report.kinds.tier.missDurationMs, { n: 0, p50: null, p90: null, p95: null });
});

test('records older than 90 days are outside the window', (t) => {
  const { roots } = fixture(t);
  pick(roots, 0, { now: () => new Date('2026-01-01T00:00:00.000Z') });
  assert.deepEqual(buildReport({ roots, kinds: KINDS, now: NOW }).kinds.tier.n, { picks: 0, misses: 0 });
});

test('text output states every n, ends with the one-project footer, and carries no state text', (t) => {
  const { roots } = fixture(t);
  pick(roots, 0, { staticAnswer: 'standard', durationMs: 120, mode: 'shadow' });
  const text = renderText(buildReport({ roots, kinds: KINDS, now: NOW }));
  assert.ok(text.endsWith(FOOTER));
  assert.equal(FOOTER, 'Records are from this project only; every figure shows its n.');
  assert.match(text, /agrees with the static answer: 1 of 1 \(100%\), n=1/);
  assert.match(text, /agrees with the recorded outcome: no data \(n=0\)/);
  assert.match(text, /pick duration ms \(n=1\)/);
  assert.equal(text.includes('private state text'), false);
});

test('verdict rows come from the verdict file with the evaluator reason; the shipped empty file gives none', (t) => {
  const { roots } = fixture(t);
  assert.deepEqual(buildReport({ roots, kinds: KINDS, now: NOW }).verdicts, []);
  const repoRoot = tempDir(t, 'doflow-report-verdicts-');
  fs.mkdirSync(path.join(repoRoot, 'core/registry'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'core/registry/advice-verdicts.json'), JSON.stringify({
    schemaVersion: 1, corpora: {}, verdicts: [
      { kind: 'tier', model: 'm1', result: 'pass' }, { kind: 'tier', model: 'm2', result: 'pass' }, { kind: 'other', model: 'm3', result: 'pass' },
    ],
  }));
  const evaluate = (kind: string, model: string) => (model === 'm1'
    ? { passed: true, reason: 'passes' } : { passed: false, reason: 'verdict stale: corpus changed' });
  const rows = buildReport({ roots, kinds: KINDS, now: NOW, repoRoot, evaluate }).verdicts;
  assert.deepEqual(rows, [
    { kind: 'tier', model: 'm1', arm: null, result: 'pass', stale: false, reason: null },
    { kind: 'tier', model: 'm2', arm: null, result: 'pass', stale: true, reason: 'verdict stale: corpus changed' },
  ]);
  assert.match(renderText({ ...buildReport({ roots, kinds: KINDS, now: NOW, repoRoot, evaluate }) }), /tier m2: pass, stale: verdict stale: corpus changed/);
});

test('the report writes nothing', (t) => {
  const { roots, project } = fixture(t);
  pick(roots, 0);
  const before = snapshot(project);
  buildReport({ roots, kinds: KINDS, now: NOW });
  assert.deepEqual(snapshot(project), before);
});

test('advise --action report: JSON, text, --kind narrowing, unknown kind exits 2', (t) => {
  const { roots, project, env } = fixture(t);
  appendPick({
    roots, kind: 'tier', state: 'secret', caller: 'advise', durationMs: 42, staticAnswer: 'standard', mode: 'shadow',
    answer: { name: 'tier', type: 'choice', pick: 'standard', probabilities: {}, confidence: 0.5, strength: { word: 'clear', between: null } },
    question: { name: 'tier', type: 'choice', options: { light: 'l', standard: 's' } },
  });
  const run = (...args: string[]) => spawnSync(process.execPath, [BIN, 'advise', ...args], { cwd: project, env: { ...process.env, ...env }, encoding: 'utf8' });
  // The CLI shell keeps its own run log beside the advice records; the report must leave the advice directory untouched.
  const advice = path.join(roots['project-state'], 'advice');
  const before = snapshot(advice);

  const json = run('--action', 'report', '--json');
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.scope, 'this project only');
  assert.deepEqual(parsed.kinds.tier.n, { picks: 1, misses: 0 });
  assert.deepEqual(parsed.kinds.tier.durationMs, { n: 1, p50: 42, p90: 42, p95: 42 });
  assert.ok(Object.hasOwn(parsed.kinds, 'review-depth'));

  const text = run('--action', 'report', '--kind', 'tier');
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.trimEnd().endsWith(FOOTER));
  assert.equal(text.stdout.includes('secret'), false);
  assert.equal(text.stdout.includes('task-class'), false);

  const bad = run('--action', 'report', '--kind', 'nope');
  assert.equal(bad.status, 2);
  assert.deepEqual(snapshot(advice), before);
});

// 141 B.8 (IC-008): the rerank figures, per arm, with criteria, would-drop counts and the sentinel check.

const SENTINEL = 'SENTINEL-Q7Z-do-not-print';
const THRESHOLDS = { illustrative: true, confidenceBelow: [0.5, 0.9], expectedBelow: [1, 2] };
const ADVICE_REGISTRY = { kinds: [{ id: 'rerank', thresholds: THRESHOLDS, params: {} }] };
const CRITERIA = { source: 'registry', digest: '3f9a1c0b27de', warning: null };
const RERANK_KINDS = ['tier', 'rerank'];

function rerankPick(roots: any, minutes: number, rerank: any, extra: any = {}, now: any = null) {
  const ladder = rerank.arm === 'ladder';
  const criteria = ['0', '1', '2', '3', '4'];
  return appendPick({
    roots, now: now || (() => new Date(Date.parse('2026-06-10T00:00:00.000Z') + minutes * 60000)), kind: 'rerank', caller: 'retrieve',
    staticAnswer: 'A', mode: 'shadow', elevated: false, durationMs: 1000 + minutes, state: `query: ${SENTINEL}`,
    question: ladder ? { name: 'rerank-a', type: 'score', criteria } : { name: 'rerank', type: 'choice', options: { A: SENTINEL, B: SENTINEL } },
    answer: { name: 'rerank', type: 'choice', pick: rerank.order[0], probabilities: {}, confidence: 0.5, strength: { word: 'clear', between: null } },
    extra: { rerank: { truncated: 0, candidateBytes: 800, criteriaDigest: '3f9a1c0b27de', criteriaSource: 'registry', ...rerank, ...extra } },
  });
}

function rerankWindow(roots: any) {
  // choice arm: 3 picks, two change the top candidate. Displacements per pick (mean |new - old| over candidates): 1, 1, 0.
  rerankPick(roots, 0, { arm: 'choice', n: 2, refs: ['a', 'b'], order: ['B', 'A'], firstStageMs: 10 });
  rerankPick(roots, 1, { arm: 'choice', n: 2, refs: ['a', 'b'], order: ['B', 'A'], firstStageMs: 30 });
  rerankPick(roots, 2, { arm: 'choice', n: 2, refs: ['a', 'b'], order: ['A', 'B'], firstStageMs: 20 });
  // ladder arm: 2 picks, 3 candidates each, one changes the top candidate. Displacements: 4/3 and 0.
  rerankPick(roots, 3, { arm: 'ladder', n: 3, refs: ['a', 'b', 'c'], order: ['C', 'B', 'A'], expected: [0.5, 1.5, 3], confidence: [0.4, 0.6, 0.95], firstStageMs: 40 });
  rerankPick(roots, 4, { arm: 'ladder', n: 3, refs: ['a', 'b', 'c'], order: ['A', 'B', 'C'], expected: [3, 2, 1], confidence: [0.95, 0.6, 0.4], firstStageMs: 50 });
  // misses of the rerank kind, then a tier pick that must not leak into the rerank figures.
  appendMiss({ roots, now: NOW, kind: 'rerank', caller: 'retrieve', reason: 'timeout', durationMs: 5000 });
  appendMiss({ roots, now: NOW, kind: 'rerank', caller: 'retrieve', reason: 'timeout', durationMs: 5001 });
  appendMiss({ roots, now: NOW, kind: 'rerank', caller: 'retrieve', reason: 'malformed-reply', durationMs: 90 });
  pick(roots, 5);
  // an old-format line of the kind (no payload, no mode) and a line that cannot be read.
  rawLine(roots, '2026-06-09', { schema: 1, type: 'pick', pickId: 'adv-1780000000000-bbbbbb', at: '2026-06-09T01:00:00.000Z', kind: 'rerank', question: 'rerank', qtype: 'choice', options: ['A', 'B'], pick: 'A', static: 'A', durationMs: 700 });
  rawLine(roots, '2026-06-09', '{"schema":1,"type":"pick"');
}

test('rerank figures: top-1 change, rank displacement, first-stage time and arms each carry their n', (t) => {
  const { roots } = fixture(t);
  rerankWindow(roots);
  const report = buildReport({ roots, kinds: RERANK_KINDS, now: NOW, adviceRegistry: ADVICE_REGISTRY, criteria: CRITERIA });
  const r = report.rerank;
  assert.equal(report.unreadable, 1);
  assert.deepEqual(r.n, { picks: 6, misses: 3 });
  assert.equal(r.withoutPayload, 1);
  assert.deepEqual(r.missesByReason, { timeout: 2, 'malformed-reply': 1 });
  assert.deepEqual(r.top1Changed, { n: 5, changed: 3 });
  assert.deepEqual(r.meanRankDisplacement, { n: 5, mean: 0.67 });
  assert.deepEqual(r.firstStageMs, { n: 5, p50: 30, p95: 50 });
  assert.deepEqual(r.arms.choice, { picks: 3, top1Changed: { n: 3, changed: 2 }, meanRankDisplacement: { n: 3, mean: 0.67 } });
  assert.deepEqual(r.arms.ladder, { picks: 2, top1Changed: { n: 2, changed: 1 }, meanRankDisplacement: { n: 2, mean: 0.67 } });
  assert.deepEqual(report.kinds.tier.n, { picks: 1, misses: 0 });
  assert.deepEqual(r.criteria, { ...CRITERIA, recorded: { n: 5, bySource: { registry: 5, settings: 0, unrecorded: 0 }, digests: { '3f9a1c0b27de': 5 } } });
});

test('would-drop counts the ladder arm only, strictly below each registry threshold, and drops nothing', (t) => {
  const { roots } = fixture(t);
  rerankWindow(roots);
  const w = buildReport({ roots, kinds: RERANK_KINDS, now: NOW, adviceRegistry: ADVICE_REGISTRY, criteria: CRITERIA }).rerank.wouldDrop;
  const row = (field: string, value: number) => w.thresholds.find((x: any) => x.field === field && x.value === value);
  assert.equal(w.illustrative, true);
  assert.equal(w.picks, 2);
  assert.equal(w.candidates, 6);
  // confidence [0.4, 0.6, 0.95] and [0.95, 0.6, 0.4]
  assert.deepEqual(row('confidenceBelow', 0.5), { field: 'confidenceBelow', value: 0.5, wouldDrop: 2, ofCandidates: 6, top1WouldDrop: 1, ofPicks: 2 });
  assert.deepEqual(row('confidenceBelow', 0.9), { field: 'confidenceBelow', value: 0.9, wouldDrop: 4, ofCandidates: 6, top1WouldDrop: 1, ofPicks: 2 });
  // expected [0.5, 1.5, 3] and [3, 2, 1]: below 1 is one candidate; below 2 is 0.5, 1.5 and 1 (2 is not strictly below).
  assert.deepEqual(row('expectedBelow', 1), { field: 'expectedBelow', value: 1, wouldDrop: 1, ofCandidates: 6, top1WouldDrop: 1, ofPicks: 2 });
  assert.deepEqual(row('expectedBelow', 2), { field: 'expectedBelow', value: 2, wouldDrop: 3, ofCandidates: 6, top1WouldDrop: 1, ofPicks: 2 });
  const text = renderText(buildReport({ roots, kinds: RERANK_KINDS, now: NOW, adviceRegistry: ADVICE_REGISTRY, criteria: CRITERIA }));
  assert.match(text, /would-drop \(measurement only\), ladder arm:/);
  assert.match(text, /confidence below 0\.5: 2 of 6 candidates; first-stage top candidate 1 of 2 picks/);
  assert.match(text, /Illustrative thresholds; nothing was dropped\./);
});

test('rerank text states n everywhere, prints the criteria warning, and keeps the footer last', (t) => {
  const { roots } = fixture(t);
  rerankWindow(roots);
  const criteria = { source: 'registry', digest: '3f9a1c0b27de', warning: 'advice.criteria.rerank has 3 lines; expected 5 or 6; the registry text is in force' };
  const text = renderText(buildReport({ roots, kinds: RERANK_KINDS, now: NOW, adviceRegistry: ADVICE_REGISTRY, criteria }));
  assert.match(text, /picks: 6; misses: 3 \(timeout 2, malformed-reply 1\)/);
  assert.match(text, /picks without a rerank payload: 1 of 6/);
  assert.match(text, /top-1 changed: 3 of 5 \(60%\), n=5/);
  assert.match(text, /mean absolute rank displacement per candidate: 0\.67, n=5/);
  assert.match(text, /first-stage time ms \(n=5\): p50 30, p95 50/);
  assert.match(text, /choice: picks 3; top-1 changed 2 of 3 \(67%\), n=3/);
  assert.match(text, /ladder: picks 2; top-1 changed 1 of 2 \(50%\), n=2/);
  assert.match(text, /criteria in force: registry, digest 3f9a1c0b27de; warning: advice\.criteria\.rerank has 3 lines/);
  assert.match(text, /criteria recorded \(n=5\): registry 5, settings 0, unrecorded 0; digests 3f9a1c0b27de 5/);
  assert.ok(text.endsWith(FOOTER));
});

test('a rerank kind with no records prints no data, and a choice-only window has no ladder data', (t) => {
  const { roots } = fixture(t);
  const empty = buildReport({ roots, kinds: RERANK_KINDS, now: NOW, adviceRegistry: ADVICE_REGISTRY, criteria: CRITERIA });
  assert.deepEqual(empty.rerank.top1Changed, { n: 0, changed: 0 });
  assert.equal(empty.rerank.meanRankDisplacement, null);
  assert.deepEqual(empty.rerank.firstStageMs, { n: 0, p50: null, p95: null });
  assert.match(renderText(empty), /rerank\n {2}no data/);

  rerankPick(roots, 0, { arm: 'choice', n: 2, refs: ['a', 'b'], order: ['B', 'A'] });
  const report = buildReport({ roots, kinds: RERANK_KINDS, now: NOW, adviceRegistry: ADVICE_REGISTRY, criteria: CRITERIA });
  assert.deepEqual(report.rerank.firstStageMs, { n: 0, p50: null, p95: null });
  assert.equal(report.rerank.wouldDrop.picks, 0);
  assert.equal(report.rerank.wouldDrop.thresholds.length, 4);
  const text = renderText(report);
  assert.match(text, /first-stage time ms: no data \(n=0\)/);
  assert.match(text, /ladder: no data \(n=0\)/);
  assert.match(text, /would-drop \(measurement only\), ladder arm:\n {4}no data \(n=0\)/);
});

test('rerank figures are absent when another kind is selected and appear when rerank is selected', (t) => {
  const { roots } = fixture(t);
  rerankWindow(roots);
  const only = (kind: string) => buildReport({ roots, kinds: RERANK_KINDS, kind, now: NOW, adviceRegistry: ADVICE_REGISTRY, criteria: CRITERIA });
  assert.equal('rerank' in only('tier'), false);
  assert.equal(only('rerank').rerank.n.picks, 6);
});

test('the criteria in force and its digest go to the verdict evaluator for the rerank kind', (t) => {
  const { roots } = fixture(t);
  const repoRoot = tempDir(t, 'doflow-report-verdicts-');
  fs.mkdirSync(path.join(repoRoot, 'core/registry'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'core/registry/advice-verdicts.json'), JSON.stringify({
    schemaVersion: 1, corpora: {}, verdicts: [{ kind: 'rerank', model: 'm1', arm: 'ladder', result: 'pass' }],
  }));
  const seen: any[] = [];
  const evaluate = (kind: string, model: string, given: any) => { seen.push(given); return { passed: false, reason: 'verdict stale: criteria changed' }; };
  const rows = buildReport({ roots, kinds: RERANK_KINDS, now: NOW, repoRoot, evaluate, adviceRegistry: ADVICE_REGISTRY, criteria: CRITERIA }).verdicts;
  assert.deepEqual(seen, [{ arm: 'ladder', criteriaDigest: '3f9a1c0b27de' }]);
  assert.deepEqual(rows, [{ kind: 'rerank', model: 'm1', arm: 'ladder', result: 'pass', stale: true, reason: 'verdict stale: criteria changed' }]);
});

test('no query, candidate, ref or criteria text reaches the text or the JSON, even from a hand-written line', (t) => {
  const { roots } = fixture(t);
  rerankWindow(roots);
  rerankPick(roots, 9, { arm: 'ladder', n: 2, refs: [`docs/${SENTINEL}.md`, 'b'], order: ['B', 'A'], expected: [1, 2], confidence: [0.5, 0.5], query: SENTINEL, candidates: [SENTINEL], criteria: [SENTINEL], text: SENTINEL });
  rawLine(roots, '2026-06-09', { schema: 1, type: 'pick', pickId: 'adv-1780000000001-cccccc', at: '2026-06-09T03:00:00.000Z', kind: 'rerank', pick: 'B', static: 'A', durationMs: 5, query: SENTINEL, rerank: { arm: 'choice', n: 2, order: ['B', 'A'], refs: [SENTINEL, SENTINEL], query: SENTINEL, criteriaDigest: SENTINEL, criteriaSource: SENTINEL } });
  const report = buildReport({ roots, kinds: RERANK_KINDS, now: NOW, adviceRegistry: ADVICE_REGISTRY, criteria: CRITERIA });
  assert.equal(JSON.stringify(report).includes(SENTINEL), false);
  assert.equal(renderText(report).includes(SENTINEL), false);
  assert.equal(report.rerank.n.picks, 8, 'the hand-written line is counted');
  assert.deepEqual(report.rerank.criteria.recorded.digests, { '3f9a1c0b27de': 6 });
});

test('advise --action report --json carries the rerank block and the criteria in force', (t) => {
  const { roots, project, env } = fixture(t);
  rerankPick(roots, 0, { arm: 'choice', n: 2, refs: ['a', 'b'], order: ['B', 'A'], firstStageMs: 12 }, {}, () => new Date());
  const run = (...args: string[]) => spawnSync(process.execPath, [BIN, 'advise', ...args], { cwd: project, env: { ...process.env, ...env }, encoding: 'utf8' });
  const json = run('--action', 'report', '--json', '--kind', 'rerank');
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(parsed.rerank.top1Changed, { n: 1, changed: 1 });
  assert.equal(parsed.rerank.criteria.source, 'registry');
  assert.match(parsed.rerank.criteria.digest, /^[0-9a-f]{12}$/);
  assert.equal(parsed.rerank.wouldDrop.thresholds.length > 0, true);
  const text = run('--action', 'report', '--kind', 'rerank');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /would-drop \(measurement only\)/);
  assert.ok(text.stdout.trimEnd().endsWith(FOOTER));
});

// 141 D.4 (IC-008): the claim-support figures by recorded relation, with the assertion-not-accuracy line.

const CS_KINDS = ['tier', 'claim-support'];
const CS_NOTE = 'A recorded link is an assertion, not ground truth; agreement here is not accuracy.';

function claimPick(roots: any, minutes: number, relation: string, yes: number, extra: any = {}) {
  return appendPick({
    roots, now: () => new Date(Date.parse('2026-06-10T00:00:00.000Z') + minutes * 60000), kind: 'claim-support', caller: 'claim',
    staticAnswer: relation === 'supports' ? 'yes' : 'no', mode: 'shadow', elevated: false, durationMs: 100 * (minutes + 1),
    state: `claim: ${SENTINEL}\npassage: ${SENTINEL}`,
    question: { name: 'claim-support', type: 'yesno' },
    answer: { name: 'claim-support', type: 'yesno', pick: yes >= 0.5 ? 'yes' : 'no', probabilities: { yes, no: 1 - yes }, confidence: 0.8, strength: { word: 'clear', between: null } },
    extra: { claimSupport: { claimId: `c-${minutes}`, evidenceId: `e-${minutes}`, relation, claimStatus: 'supported', claimBytes: 12, passageBytes: 30, truncated: false, ...extra } },
  });
}

function claimWindow(roots: any) {
  claimPick(roots, 0, 'supports', 0.9);
  claimPick(roots, 1, 'supports', 0.7);
  claimPick(roots, 2, 'supports', 0.2);
  claimPick(roots, 3, 'contradicts', 0.6);
  claimPick(roots, 4, 'contradicts', 0.1);
  appendMiss({ roots, now: NOW, kind: 'claim-support', caller: 'claim', reason: 'timeout', durationMs: 5000 });
  appendMiss({ roots, now: NOW, kind: 'claim-support', caller: 'claim', reason: 'timeout', durationMs: 5001 });
  appendMiss({ roots, now: NOW, kind: 'claim-support', caller: 'claim', reason: 'unreachable', durationMs: 20 });
  // an old line: a claim-support pick written without the payload.
  rawLine(roots, '2026-06-09', { schema: 1, type: 'pick', pickId: 'adv-1780000000000-dddddd', at: '2026-06-09T01:00:00.000Z', kind: 'claim-support', question: 'claim-support', qtype: 'yesno', options: ['no', 'yes'], pick: 'yes', static: 'yes', durationMs: 50 });
}

test('claim-support figures by recorded relation carry n, model yes, agreement and misses by reason', (t) => {
  const { roots } = fixture(t);
  claimWindow(roots);
  const c = buildReport({ roots, kinds: CS_KINDS, now: NOW }).claimSupport;
  assert.deepEqual(c.n, { picks: 6, misses: 3 });
  assert.deepEqual(c.missesByReason, { timeout: 2, unreachable: 1 });
  assert.equal(c.withoutPayload, 1);
  assert.deepEqual(c.byRelation.supports, { n: 3, modelYes: 2, agree: 2 });
  assert.deepEqual(c.byRelation.contradicts, { n: 2, modelYes: 1, agree: 1 });
  assert.equal(c.durationMs.n, 6);
  const text = renderText(buildReport({ roots, kinds: CS_KINDS, now: NOW }));
  assert.match(text, /claim-support\n {2}picks: 6; misses: 3 \(timeout 2, unreachable 1\)/);
  assert.match(text, /picks without a claim-support payload: 1 of 6/);
  assert.match(text, /supports: picks 3; model said yes at p>=0\.5: 2 of 3; .*: 2 of 3 \(67%\), n=3/);
  assert.match(text, /contradicts: picks 2; model said yes at p>=0\.5: 1 of 2; .*: 1 of 2 \(50%\), n=2/);
  assert.ok(text.includes(CS_NOTE));
  assert.ok(text.trimEnd().endsWith(FOOTER), 'the footer stays last');
});

test('a relation with no records prints no data, and a kind with no records prints no data', (t) => {
  const { roots } = fixture(t);
  assert.match(renderText(buildReport({ roots, kinds: CS_KINDS, now: NOW })), /claim-support\n {2}no data/);
  claimPick(roots, 0, 'supports', 0.9);
  const report = buildReport({ roots, kinds: CS_KINDS, now: NOW });
  assert.deepEqual(report.claimSupport.byRelation.contradicts, { n: 0, modelYes: 0, agree: 0 });
  assert.match(renderText(report), /contradicts: no data \(n=0\)/);
});

test('a pick with a malformed payload relation or no probability stays readable', (t) => {
  const { roots } = fixture(t);
  rawLine(roots, '2026-06-09', { schema: 1, type: 'pick', pickId: 'adv-1780000000002-eeeeee', at: '2026-06-09T02:00:00.000Z', kind: 'claim-support', pick: 'yes', static: 'yes', durationMs: 5, claimSupport: { relation: 'weird' } });
  rawLine(roots, '2026-06-09', { schema: 1, type: 'pick', pickId: 'adv-1780000000003-ffffff', at: '2026-06-09T02:30:00.000Z', kind: 'claim-support', pick: 'no', static: 'no', durationMs: 5, claimSupport: { relation: 'contradicts' } });
  const c = buildReport({ roots, kinds: CS_KINDS, now: NOW }).claimSupport;
  assert.equal(c.withoutPayload, 1);
  assert.deepEqual(c.byRelation.contradicts, { n: 1, modelYes: 0, agree: 1 });
});

test('claim-support figures are absent when another kind is selected', (t) => {
  const { roots } = fixture(t);
  claimWindow(roots);
  assert.equal('claimSupport' in buildReport({ roots, kinds: CS_KINDS, kind: 'tier', now: NOW }), false);
  assert.equal(buildReport({ roots, kinds: CS_KINDS, kind: 'claim-support', now: NOW }).claimSupport.n.picks, 6);
});

test('no claim, passage or hand-written text reaches the claim-support text or JSON', (t) => {
  const { roots } = fixture(t);
  claimWindow(roots);
  claimPick(roots, 9, 'supports', 0.9, { claim: SENTINEL, passage: SENTINEL, text: SENTINEL });
  rawLine(roots, '2026-06-09', { schema: 1, type: 'pick', pickId: 'adv-1780000000004-aaaaaa', at: '2026-06-09T03:00:00.000Z', kind: 'claim-support', pick: 'yes', static: 'yes', durationMs: 5, state: SENTINEL, claimSupport: { relation: 'supports', claimId: SENTINEL, evidenceId: SENTINEL, claim: SENTINEL, passage: SENTINEL, claimStatus: SENTINEL } });
  const report = buildReport({ roots, kinds: CS_KINDS, now: NOW });
  assert.equal(JSON.stringify(report).includes(SENTINEL), false);
  assert.equal(renderText(report).includes(SENTINEL), false);
  assert.equal(report.claimSupport.n.picks, 8, 'the hand-written line is counted');
});
