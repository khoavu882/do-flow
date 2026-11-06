'use strict';

// Feature 084 C-1/C-2 and 141 IC-004/IC-005. The bar is read only from the shipped registry files: a scored file written
// in the caller's project never certifies act, however it is shaped. Verdict cases use fixture registries in temp
// directories through `createBenchBar`; nothing here writes into the repository's core/registry.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { evaluateBenchBar, createBenchBar, gateDigest } = require('../../src/runtime/advice/bench-gate.ts');
const { interceptDecisionPoint } = require('../../src/runtime/advice/shadow-dispatcher.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const REAL_ADVICE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core/registry/advice.json'), 'utf8'));
const GATE = REAL_ADVICE.gate;

const PASSING = {
  kind: 'tier',
  cases: [
    { id: '1', split: 'heldout', state: 's1', staticPick: 'light', expected: 'standard', modelPicks: { m: 'standard' } },
    { id: '2', split: 'heldout', state: 's2', staticPick: 'light', expected: 'frontier', modelPicks: { m: 'frontier' } },
    { id: '3', split: 'heldout', state: 's3', staticPick: 'light', expected: 'light', modelPicks: { m: 'light' } },
  ],
};

// Each input the old scoring code accepted (or threw on), plus a fully measured passing corpus.
const CORPORA: Record<string, any> = {
  'aggregate-only': { models: { m: { accuracy: 1 } } },
  'train-only cases': { cases: [{ id: '1', split: 'train', state: 's', staticPick: 'light', expected: 'standard', modelPicks: { m: 'standard' } }] },
  'a missing staticPick': { cases: [{ id: '1', split: 'heldout', state: 's', expected: 'standard', modelPicks: { m: 'standard' } }] },
  null: null,
  'accuracy outside [0,1]': { models: { m: { accuracy: 5, staticBaselineAccuracy: 0.5, heldoutCases: 100 } } },
  'non-finite accuracy': { models: { m: { accuracy: 'Infinity', staticBaselineAccuracy: 0.5, heldoutCases: 100 } } },
  'a defaulted baseline': { models: { m: { accuracy: 0.9, heldoutCases: 100 } } },
  'too few heldout cases': { models: { m: { accuracy: 0.9, staticBaselineAccuracy: 0.5, heldoutCases: 0 } } },
  'a fully measured passing corpus': PASSING,
};

function projectWithCorpus(t: any, corpus: any) {
  const root = tempDir(t, 'doflow-bench-gate-');
  const file = path.join(root, 'bench', 'advice', 'tier.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(corpus));
  return root;
}

for (const [name, corpus] of Object.entries(CORPORA)) {
  test(`C-1/D3: a project bench file with ${name} never passes the bar`, async (t) => {
    const repoRoot = projectWithCorpus(t, corpus);
    const res = await evaluateBenchBar('tier', 'm', { repoRoot });
    assert.equal(res.passed, false);
    assert.equal(res.reason, "no trusted bench scores ship for kind 'tier' and model 'm'");
  });
}

test('the shipped verdict file is empty, so the real evaluator never passes (DEC-021)', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core/registry/advice-verdicts.json'), 'utf8'));
  assert.deepEqual(shipped, { schemaVersion: 1, corpora: {}, verdicts: [] });
  for (const kind of ['tier', 'rerank', 'mcp-need']) {
    const res = evaluateBenchBar(kind, 'm');
    assert.equal(res.passed, false);
    assert.equal(res.reason, `no trusted bench scores ship for kind '${kind}' and model 'm'`);
  }
});

// A fixture package root: the registry given (default: the real one) plus the verdict file given (a string is written as is).
function fixtureRoot(t: any, file: any, advice: any = REAL_ADVICE) {
  const root = tempDir(t, 'doflow-bench-gate-pkg-');
  fs.mkdirSync(path.join(root, 'core', 'registry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'core', 'registry', 'advice.json'), JSON.stringify(advice));
  if (file !== undefined) fs.writeFileSync(path.join(root, 'core', 'registry', 'advice-verdicts.json'), typeof file === 'string' ? file : JSON.stringify(file));
  return root;
}

function verdict(over: any = {}) {
  return {
    kind: 'tier', model: 'm', arm: null, criteriaDigest: null,
    gateVersion: GATE.version, gateDigest: gateDigest(GATE), corpusVersion: 1, corpusDigest: 'sha256:aa',
    runAt: '2026-11-06T00:00:00.000Z', host: { platform: 'darwin', arch: 'arm64' },
    n: 30, valid: 30, validShare: 1,
    quality: { metric: 'accuracy', model: 0.9, static: 0.7, delta: 0.2, ci: [0.03, 0.37], excluded: 0 },
    latencyMs: { p50: 1400, p95: 3100 },
    result: 'pass', failedChecks: [],
    ...over,
  };
}

function verdictFile(verdicts: any[], corpora: any = { tier: { corpusVersion: 1, digest: 'sha256:aa', heldoutCases: 30 } }) {
  return { schemaVersion: 1, corpora, verdicts };
}

function evaluate(t: any, file: any, kind = 'tier', model = 'm', extra?: any, advice?: any) {
  return createBenchBar({ registryRoot: fixtureRoot(t, file, advice) })(kind, model, extra);
}

test('IC-005: a matching passing verdict meets the bar', (t) => {
  const res = evaluate(t, verdictFile([verdict()]));
  assert.equal(res.passed, true);
  assert.deepEqual([res.kind, res.model], ['tier', 'm']);
});

test('IC-005: a matching verdict file in the project is never read; the shipped file has none', (t) => {
  const project = projectWithCorpus(t, PASSING);
  fs.mkdirSync(path.join(project, 'core', 'registry'), { recursive: true });
  fs.writeFileSync(path.join(project, 'core', 'registry', 'advice-verdicts.json'), JSON.stringify(verdictFile([verdict()])));
  const bar = createBenchBar({ registryRoot: fixtureRoot(t, verdictFile([])) });
  const res = bar('tier', 'm', { repoRoot: project, registryRoot: project });
  assert.equal(res.passed, false);
  assert.equal(res.reason, "no trusted bench scores ship for kind 'tier' and model 'm'");
});

test('IC-005: a verdict is keyed by (kind, model, arm)', (t) => {
  const file = verdictFile([verdict()]);
  const bar = createBenchBar({ registryRoot: fixtureRoot(t, file) });
  assert.equal(bar('tier', 'other').passed, false);
  assert.equal(bar('tier', 'other').reason, "no trusted bench scores ship for kind 'tier' and model 'other'");
  assert.equal(bar('mcp-need', 'm').passed, false);
  // arm is read for rerank only; a non-rerank kind with a stray arm still uses a null arm
  assert.equal(bar('tier', 'm', { arm: 'ladder' }).passed, true);
});

test('IC-005: a rerank verdict for one arm never stands in for the other or for no arm', (t) => {
  const corpora = { rerank: { corpusVersion: 1, digest: 'sha256:aa', heldoutCases: 74 } };
  const rerank = verdict({ kind: 'rerank', arm: 'choice', criteriaDigest: '3f9a1c0b27de', quality: { metric: 'ndcgAt5', model: 0.5, static: 0.4, delta: 0.1, ci: [0.02, 0.2], excluded: 0 }, latencyMs: { p50: 900, p95: 2500 } });
  const bar = createBenchBar({ registryRoot: fixtureRoot(t, verdictFile([rerank], corpora)) });
  assert.equal(bar('rerank', 'm', { arm: 'choice', criteriaDigest: '3f9a1c0b27de' }).passed, true);
  assert.equal(bar('rerank', 'm', { arm: 'ladder', criteriaDigest: '3f9a1c0b27de' }).passed, false);
  assert.equal(bar('rerank', 'm').passed, false);
  // no caller digest: the criteria check is skipped
  assert.equal(bar('rerank', 'm', { arm: 'choice' }).passed, true);
  // a rerank cap of 3000 ms applies
  const slow = verdict({ kind: 'rerank', arm: 'choice', latencyMs: { p50: 900, p95: 3500 }, result: 'fail', failedChecks: ['latency'] });
  const res = createBenchBar({ registryRoot: fixtureRoot(t, verdictFile([slow], corpora)) })('rerank', 'm', { arm: 'choice' });
  assert.equal(res.reason, 'verdict failed: latency');
});

test('IC-005: a different criteria digest reads as stale', (t) => {
  const corpora = { rerank: { corpusVersion: 1, digest: 'sha256:aa', heldoutCases: 74 } };
  const rerank = verdict({ kind: 'rerank', arm: 'ladder', criteriaDigest: '3f9a1c0b27de' });
  const res = createBenchBar({ registryRoot: fixtureRoot(t, verdictFile([rerank], corpora)) })('rerank', 'm', { arm: 'ladder', criteriaDigest: '000000000000' });
  assert.equal(res.passed, false);
  assert.equal(res.reason, 'verdict stale: criteria changed');
});

test('IC-005: stale bars, stale corpus', (t) => {
  assert.equal(evaluate(t, verdictFile([verdict({ gateDigest: 'sha256:00' })])).reason, 'verdict stale: pass bars changed');
  assert.equal(evaluate(t, verdictFile([verdict({ gateVersion: GATE.version + 1 })])).reason, 'verdict stale: pass bars changed');
  const edited = { ...REAL_ADVICE, gate: { ...GATE, validShareMin: 0.5 } };
  assert.equal(evaluate(t, verdictFile([verdict()]), 'tier', 'm', undefined, edited).reason, 'verdict stale: pass bars changed');
  const noGate = { ...REAL_ADVICE };
  delete noGate.gate;
  assert.equal(evaluate(t, verdictFile([verdict()]), 'tier', 'm', undefined, noGate).reason, 'verdict stale: pass bars changed');
  // illustrative is outside the digest, so flipping it keeps the verdict current
  const flipped = { ...REAL_ADVICE, gate: { ...GATE, illustrative: false } };
  assert.equal(evaluate(t, verdictFile([verdict()]), 'tier', 'm', undefined, flipped).passed, true);

  assert.equal(evaluate(t, verdictFile([verdict({ corpusDigest: 'sha256:bb' })])).reason, 'verdict stale: corpus changed');
  assert.equal(evaluate(t, verdictFile([verdict({ corpusVersion: 2 })])).reason, 'verdict stale: corpus changed');
  assert.equal(evaluate(t, verdictFile([verdict()], {})).reason, 'verdict stale: corpus changed');
});

test('IC-005: a stored pass over failing numbers is inconsistent, never accepted', (t) => {
  const reason = 'verdict inconsistent: stored result differs from its numbers';
  assert.equal(evaluate(t, verdictFile([verdict({ quality: { ...verdict().quality, ci: [-0.1, 0.3] } })])).reason, reason);
  assert.equal(evaluate(t, verdictFile([verdict({ validShare: 0.5 })])).reason, reason);
  assert.equal(evaluate(t, verdictFile([verdict({ latencyMs: { p50: 1, p95: 99999 } })])).reason, reason);
  assert.equal(evaluate(t, verdictFile([verdict({ n: 3 })])).reason, reason);
  // a stored fail over passing numbers is inconsistent too
  assert.equal(evaluate(t, verdictFile([verdict({ result: 'fail', failedChecks: ['quality'] })])).reason, reason);
  // missing figures fail their checks instead of throwing
  assert.equal(evaluate(t, verdictFile([verdict({ quality: null, latencyMs: null })])).passed, false);
});

test('IC-005: a consistent failing verdict names its failed checks', (t) => {
  const failing = verdict({ validShare: 0.5, latencyMs: { p50: 1, p95: 99999 }, result: 'fail', failedChecks: ['valid-share', 'latency'] });
  const res = evaluate(t, verdictFile([failing]));
  assert.equal(res.passed, false);
  assert.equal(res.reason, 'verdict failed: valid-share, latency');
});

test('IC-005: a consistent insufficient-data verdict reports n against minCases', (t) => {
  const small = verdict({ n: 12, valid: 12, result: 'insufficient-data', failedChecks: ['min-cases'] });
  const res = evaluate(t, verdictFile([small]));
  assert.equal(res.passed, false);
  assert.equal(res.reason, `insufficient data: 12 of ${GATE.minCases} cases`);
});

test('IC-005: an unreadable, malformed or ambiguous verdict file returns bench verdicts unreadable', (t) => {
  const unreadable = 'bench verdicts unreadable';
  assert.equal(evaluate(t, undefined).reason, unreadable);
  assert.equal(evaluate(t, '{ not json').reason, unreadable);
  assert.equal(evaluate(t, { schemaVersion: 2, corpora: {}, verdicts: [] }).reason, unreadable);
  assert.equal(evaluate(t, { schemaVersion: 1, corpora: {}, verdicts: {} }).reason, unreadable);
  assert.equal(evaluate(t, verdictFile([verdict(), verdict()])).reason, unreadable);
  const missingAdvice = tempDir(t, 'doflow-bench-gate-noadvice-');
  fs.mkdirSync(path.join(missingAdvice, 'core', 'registry'), { recursive: true });
  fs.writeFileSync(path.join(missingAdvice, 'core', 'registry', 'advice-verdicts.json'), JSON.stringify(verdictFile([verdict()])));
  assert.equal(createBenchBar({ registryRoot: missingAdvice })('tier', 'm').reason, unreadable);
});

test('IC-005: an own-property lookup keeps inherited names from standing in for a corpus entry', (t) => {
  assert.equal(evaluate(t, verdictFile([verdict({ kind: 'constructor' })], {}), 'constructor').reason, 'verdict stale: corpus changed');
});

test('C-2: a passing file in the project plus advice.kinds.tier=act gives shadow with BENCH_BAR_UNMET', async (t) => {
  const root = projectWithCorpus(t, PASSING);
  fs.mkdirSync(path.join(root, '.doflow'), { recursive: true });
  fs.writeFileSync(path.join(root, '.doflow', 'settings.json'), JSON.stringify({ advice: { kinds: { tier: 'act' }, models: { tier: 'm' } } }));
  const home = tempDir(t, 'doflow-bench-gate-home-');
  let asked = 0;
  const res = await interceptDecisionPoint({
    kind: 'tier', caller: 'brief-tools', state: 's', staticPick: 'light', taskId: 't',
    projectRoot: root, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') }, record: false,
  }, {
    adviceClient: { ask: async () => { asked += 1; return { status: 'answered', model: 'm', answers: [{ name: 'tier', type: 'choice', pick: 'frontier' }] }; } },
  });
  assert.equal(res.mode, 'shadow');
  assert.equal(res.effectiveDecision, 'light');
  assert.equal(res.advisorPick, null);
  assert.match(res.warning, /^BENCH_BAR_UNMET: /);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(asked, 0, 'record:false: the degraded shadow call would record nothing, so it is not made');
});
