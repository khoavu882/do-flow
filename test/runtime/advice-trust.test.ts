'use strict';

// 175 T5 (IC-006, FR-012): the trust evaluator every show or act decision rests on. It reads only the user-level result
// store and the user's bars override, keys a result by (project key, kind, model digest), calls a result stale when the
// question, builder or bars digest moved, and re-judges the stored numbers against the current bars every time. The model
// digest comes from an injected fake client; no test reaches a model, and every store lives in a temp folder.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
const { materializeKind } = require('../../src/runtime/advice/kinds.ts');
const { effectiveBars } = require('../../src/runtime/advice/replay/bars.ts');
const { getSource } = require('../../src/runtime/advice/replay/sources/index.ts');
const { writeResult } = require('../../src/runtime/advice/replay/results.ts');
const {
  evaluateTrust, questionDigest, builderDigest, barsDigest, caseSetDigest, projectKey,
} = require('../../src/runtime/advice/replay/trust.ts');

const KIND = 'claim-support';
const MODEL_DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;

const registry = () => structuredClone(loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry);
const questionOf = (reg: any) => materializeKind(KIND, { adviceRegistry: reg }).question;
const kindOf = (reg: any) => reg.kinds.find((entry: any) => entry.id === KIND);

/** The real source with its label not the rule, so a stored result can certify (the shipped one is measure-only). */
const CERTIFYING = { ...getSource('claim-ledger'), labelIsRule: false };
const certifying = (id: string) => (id === 'claim-ledger' ? CERTIFYING : null);

/** Figures that pass the show and the act bar of the package defaults. */
const PASSING = {
  n: 120, valid: 120, validShare: 1, noAnswer: { count: 0, share: 0, byReason: {} },
  accuracy: { model: 0.95, rule: 0.8 }, kappa: { model: 0.8, rule: 0.5, lower: 0.6, gain: 0.3, gainLower: 0.1 },
  worse: 1, better: 19, worseShare: 1 / 120, minority: 40, latencyMs: { first: 600, p50: 400, p95: 700, max: 900 },
};
const SHOW_ONLY = { ...PASSING, kappa: { ...PASSING.kappa, gainLower: -0.05 } };
const BELOW_SHOW = { ...PASSING, kappa: { ...PASSING.kappa, lower: -0.1 } };

function setup(t: any) {
  const userState = tempDir(t, 'doflow-trust-user-state-');
  const configHome = tempDir(t, 'doflow-trust-config-');
  const project = tempDir(t, 'doflow-trust-project-');
  const calls: any[] = [];
  const clientWith = (answer: any) => ({ modelDigest: async (args: any) => { calls.push(args); return answer; } });
  return {
    userState, configHome, project, calls, clientWith,
    roots: { 'user-state': userState, 'config-home': configHome },
    client: clientWith({ digest: MODEL_DIGEST, reason: null }),
  };
}

/** Stores a result whose digests match the current registry, question and effective bars of `project`. */
function storeFresh(f: any, { reg = registry(), project = f.project, metrics = PASSING, source = CERTIFYING, digest = MODEL_DIGEST, extra = {} }: any = {}) {
  const bars = effectiveBars({ registry: reg, kind: KIND, roots: f.roots });
  assert.equal(bars.ok, true);
  const entry = {
    kind: KIND, provider: 'local', model: 'decider:4b', modelDigest: digest,
    questionDigest: questionDigest(questionOf(reg)),
    builderDigest: builderDigest(source, kindOf(reg)),
    barsDigest: barsDigest(bars.bars, kindOf(reg).budgetMs),
    caseSet: { source: 'claim-ledger', origin: 'project', projectKey: projectKey(project), digest: caseSetDigest([]), eligible: 120, replayed: 120 },
    metrics, runAt: '2026-11-19T08:00:00.000Z', doflowVersion: '2.4.0', ...extra,
  };
  writeResult({ roots: f.roots, entry });
  return entry;
}

function evaluate(f: any, over: any = {}) {
  const reg = over.registry || registry();
  return evaluateTrust({
    kind: KIND, model: 'decider:4b', provider: 'local', endpoint: 'http://127.0.0.1:1', question: questionOf(reg),
    registry: reg, roots: f.roots, client: f.client, projectRoot: f.project, sourceOf: certifying, ...over,
  });
}

test('175 T5: a fresh passing result is act; the digest call carries the endpoint, model, provider and timeout', async (t) => {
  const f = setup(t);
  storeFresh(f);
  const trust = await evaluate(f, { timeoutMs: 250 });
  assert.deepEqual([trust.standing, trust.failedChecks, trust.staleDigest, trust.modelDigest], ['act', [], null, MODEL_DIGEST]);
  assert.equal(typeof trust.reason, 'string');
  assert.equal(f.calls.length, 1);
  assert.deepEqual({ ...f.calls[0], signal: undefined }, { endpoint: 'http://127.0.0.1:1', model: 'decider:4b', provider: 'local', timeoutMs: 250, signal: undefined });
});

test('175 T5 (d): the question, builder and bars digests each make the result stale alone, the first one named', async (t) => {
  const f = setup(t);
  storeFresh(f);

  const changedQuestion = registry();
  kindOf(changedQuestion).instructions = 'Decide whether the passage supports the claim.';
  let trust = await evaluate(f, { registry: changedQuestion });
  assert.deepEqual([trust.standing, trust.staleDigest], ['stale', 'question']);

  const changedBuilder = registry();
  kindOf(changedBuilder).params = { ...kindOf(changedBuilder).params, claimBytes: 512 };
  trust = await evaluate(f, { registry: changedBuilder });
  assert.deepEqual([trust.standing, trust.staleDigest], ['stale', 'builder']);

  const changedBudget = registry();
  kindOf(changedBudget).budgetMs = 2000;
  trust = await evaluate(f, { registry: changedBudget });
  assert.deepEqual([trust.standing, trust.staleDigest], ['stale', 'bars']);

  // Both the question and the bars moved: the question is named first.
  kindOf(changedQuestion).budgetMs = 2000;
  trust = await evaluate(f, { registry: changedQuestion });
  assert.deepEqual([trust.standing, trust.staleDigest], ['stale', 'question']);
});

test('175 T5 (d): a change to the user bars override makes a stored result stale (bars)', async (t) => {
  const f = setup(t);
  storeFresh(f);
  const bars = structuredClone(registry().bars);
  bars.show.minCases = 31;
  fs.writeFileSync(path.join(f.configHome, 'advice-bars.json'), JSON.stringify({ schema: 1, bars }));
  const trust = await evaluate(f);
  assert.deepEqual([trust.standing, trust.staleDigest], ['stale', 'bars']);
});

test('175 T5 (d) O-4: another model digest or another project key is none; two projects for one kind and digest coexist', async (t) => {
  const f = setup(t);
  const other = tempDir(t, 'doflow-trust-other-project-');
  storeFresh(f);
  storeFresh(f, { project: other, metrics: BELOW_SHOW });

  assert.equal((await evaluate(f, { client: f.clientWith({ digest: OTHER_DIGEST, reason: null }) })).standing, 'none');
  assert.equal((await evaluate(f, { projectRoot: tempDir(t, 'doflow-trust-third-project-') })).standing, 'none');
  assert.equal((await evaluate(f)).standing, 'act');
  const theirs = await evaluate(f, { projectRoot: other });
  assert.deepEqual([theirs.standing, theirs.failedChecks], ['below-show', ['kappa-lower']]);
});

test('175 T5 (d): no model digest, or an invalid bars override, is unknown; the digest is checked first', async (t) => {
  const f = setup(t);
  storeFresh(f);
  let trust = await evaluate(f, { client: f.clientWith({ digest: null, reason: 'no-digest' }) });
  assert.equal(trust.standing, 'unknown');
  assert.match(trust.reason, /no-digest/);
  assert.equal(trust.modelDigest, null);

  trust = await evaluate(f, { client: { modelDigest: async () => { throw new Error('boom'); } } });
  assert.equal(trust.standing, 'unknown');
  trust = await evaluate(f, { model: null });
  assert.equal(trust.standing, 'unknown');

  fs.writeFileSync(path.join(f.configHome, 'advice-bars.json'), '{ not json');
  trust = await evaluate(f);
  assert.equal(trust.standing, 'unknown');
  assert.match(trust.reason, /bars-override-invalid/);

  trust = await evaluate(f, { client: f.clientWith({ digest: null, reason: 'timeout' }) });
  assert.deepEqual([trust.standing, /timeout/.test(trust.reason)], ['unknown', true]);
});

test('175 T5 (d): no store, or an unreadable one, is none', async (t) => {
  const f = setup(t);
  assert.equal((await evaluate(f)).standing, 'none');
  fs.mkdirSync(path.join(f.userState, 'advice'), { recursive: true });
  fs.writeFileSync(path.join(f.userState, 'advice', 'results.json'), '{ torn');
  assert.equal((await evaluate(f)).standing, 'none');
  assert.equal((await evaluate(f, { roots: { 'user-state': null, 'config-home': f.configHome } })).standing, 'none');
});

test('175 T5: the shipped claim-ledger source is measure-only, however good the stored numbers', async (t) => {
  const f = setup(t);
  storeFresh(f, { source: getSource('claim-ledger') });
  const trust = await evaluate(f, { sourceOf: undefined });
  assert.deepEqual([trust.standing, trust.failedChecks], ['measure-only', []]);
});

test('175 T5 (e): a passing result file planted under the project is never read and gives none', async (t) => {
  const f = setup(t);
  // The same passing entry, planted where a project-level store would sit, with a lowering bars file beside it.
  const planted = storeFresh({ ...f, roots: { ...f.roots, 'user-state': path.join(f.project, '.doflow', 'state') } });
  assert.ok(fs.existsSync(path.join(f.project, '.doflow', 'state', 'advice', 'results.json')));
  fs.writeFileSync(path.join(f.project, '.doflow', 'advice-bars.json'), JSON.stringify({ schema: 1 }));
  assert.equal(planted.caseSet.projectKey, projectKey(f.project));

  const touched: string[] = [];
  const fsImpl = new Proxy(fs, {
    get(target: any, prop: any) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return (...args: any[]) => { if (typeof args[0] === 'string') touched.push(`${String(prop)} ${args[0]}`); return value.apply(target, args); };
    },
  });
  const trust = await evaluate(f, { fsImpl });
  assert.equal(trust.standing, 'none');
  const inside = touched.filter((line) => line.split(' ').slice(1).join(' ').startsWith(`${f.project}${path.sep}`));
  assert.deepEqual(inside, [], 'no path under the project was touched');
  assert.ok(touched.some((line) => line.includes(f.userState)), 'the user-level store was the one read');
});

test('175 T5 (f): stored numbers are re-judged by the current bars, never by anything stored', async (t) => {
  const f = setup(t);
  storeFresh(f, { metrics: BELOW_SHOW });
  let trust = await evaluate(f);
  assert.deepEqual([trust.standing, trust.failedChecks], ['below-show', ['kappa-lower']]);

  storeFresh(f, { metrics: SHOW_ONLY });
  trust = await evaluate(f);
  assert.deepEqual([trust.standing, trust.failedChecks], ['show', ['kappa-gain-lower']]);

  storeFresh(f, { metrics: { ...PASSING, n: 20, minority: 5 } });
  trust = await evaluate(f);
  assert.deepEqual([trust.standing, trust.failedChecks], ['below-minimum', ['min-cases', 'min-minority']]);

  // A planted stored standing does not lift failing numbers: the entry is dropped on read, so there is no result.
  const file = path.join(f.userState, 'advice', 'results.json');
  const text = JSON.parse(fs.readFileSync(file, 'utf8'));
  text.results[0].standing = 'act';
  text.results[0].metrics = BELOW_SHOW;
  fs.writeFileSync(file, JSON.stringify(text));
  trust = await evaluate(f);
  assert.equal(trust.standing, 'none');
});

test('175 T5: the digest helpers are sha256 over canonical JSON, independent of key order', () => {
  const reg = registry();
  const question = questionOf(reg);
  const reordered = Object.fromEntries(Object.entries(question).reverse());
  assert.equal(questionDigest(reordered), questionDigest(question));
  assert.match(questionDigest(question), /^sha256:[0-9a-f]{64}$/);
  const bars = reg.bars;
  assert.notEqual(barsDigest(bars, 1500), barsDigest(bars, 1501));
  const a = { id: 'b0', state: 'two', label: 'yes', rule: 'yes' };
  const b = { id: 'a0', state: 'one', label: 'no', rule: 'no' };
  assert.equal(caseSetDigest([a, b]), caseSetDigest([b, a]), 'cases are sorted by id');
  assert.notEqual(caseSetDigest([a, b]), caseSetDigest([a, { ...b, state: 'one!' }]), 'the state is part of the digest');
  assert.match(projectKey(REPO_ROOT), /^sha256:[0-9a-f]{64}$/);
});
