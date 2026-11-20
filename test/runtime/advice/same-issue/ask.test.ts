'use strict';

// Row 176 TA (design §9 steps 2-3, §10 model check, §12, owner ruling O-3 (a)): checkPairs, the one call site of every
// same-issue decision. It batches the rule stage's candidate pairs by the kind's questionsPerCall, asks every batch at once
// through the dispatcher with a show surface and the lifecycle project root, and returns per pair the model's answer only
// when every batch was shown. The model is a fake server or an injected client; HOME and XDG_CONFIG_HOME are temp dirs, the
// kind is a fixture in a registry passed in, and a local result is planted in the temp result store.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../../../helper/tmp.ts');
const { createScratch } = require('../../../helper/scratch-env.ts');
const { makeRepo } = require('../../../helper/lifecycle-git-fixtures.ts');
const { startFakeServer, answering, digestOf } = require('../../../helper/fake-decision-server.ts');
const { loadStorageRegistry } = require('../../../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../../../src/runtime/storage/roots.ts');
const { readWindow } = require('../../../../src/runtime/advice/record.ts');
const { loadAdviceRegistry } = require('../../../../src/runtime/advice/registry.ts');
const { materializeKind } = require('../../../../src/runtime/advice/kinds.ts');
const { buildBatch } = require('../../../../src/runtime/advice/batch.ts');
const { itemText, pairState, pairKey } = require('../../../../src/runtime/advice/same-issue/rule.ts');
const { effectiveBars } = require('../../../../src/runtime/advice/replay/bars.ts');
const { getSource } = require('../../../../src/runtime/advice/replay/sources/index.ts');
const { writeResult } = require('../../../../src/runtime/advice/replay/results.ts');
const { questionDigest, builderDigest, barsDigest, caseSetDigest, projectKey } = require('../../../../src/runtime/advice/replay/trust.ts');
const { REPO_ROOT } = require('../../../../src/helper/repo-root.ts');

/** Required per call, so each test fails on its own while the module is missing. */
const checkPairs = (input: any) => require('../../../../src/runtime/advice/same-issue/ask.ts').checkPairs(input);

const STORAGE = loadStorageRegistry({ repoRoot: REPO_ROOT });
const ADVICE = loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry;
const KIND = 'same-issue';
const MODEL = 'clef-flash';
const FIXTURE_KIND = {
  id: KIND, type: 'yesno', description: 'Test fixture: the same-issue kind of design section 3.',
  instructions: 'Decide whether the two quoted items describe the same issue, so that one fix would settle both.',
  no: 'The two items describe different issues', yes: 'The two items describe the same issue',
  staticFrom: 'the rule stage', askedBy: ['review', 'followup'], maxMode: 'show', replay: { source: 'review-findings' }, budgetMs: 6000,
  params: { itemBytes: 512, questionsPerCall: 3, maxPairs: 32, perItem: 2, candidateAtPct: 15, flagAtPct: 40, locatorBonusPct: 15, maxCompare: 2000 },
};

/** The shipped registry with the fixture kind in place of any shipped same-issue entry. */
function registryWith(params: any = {}) {
  const kind = { ...structuredClone(FIXTURE_KIND), params: { ...FIXTURE_KIND.params, ...params } };
  return { ...structuredClone(ADVICE), kinds: [...structuredClone(ADVICE.kinds).filter((entry: any) => entry.id !== KIND), kind] };
}

/** Figures that pass the show bar of the package defaults, not the act bar; BELOW_SHOW fails the show bar. */
const SHOW_ONLY = {
  n: 120, valid: 120, validShare: 1, noAnswer: { count: 0, share: 0, byReason: {} },
  accuracy: { model: 0.95, rule: 0.8 }, kappa: { model: 0.8, rule: 0.5, lower: 0.6, gain: 0.3, gainLower: -0.05 },
  worse: 1, better: 19, worseShare: 1 / 120, minority: 48, latencyMs: { first: 600, p50: 400, p95: 700, max: 900 },
};
const BELOW_SHOW = { ...SHOW_ONLY, kappa: { ...SHOW_ONLY.kappa, lower: -0.1 } };

/** Items `F-1`..`F-n` and the pairs (F-1,F-2), (F-2,F-3), ... with the given rule answers, best score first. */
function fixturePairs(rules: string[]) {
  const items = new Map<string, any>();
  for (let index = 1; index <= rules.length + 1; index += 1) {
    items.set(`F-${index}`, { text: `Finding ${index}:   the cache TTL constant is wrong in module ${index}`, locator: `src/m${index}.ts:${index}` });
  }
  const pairs = rules.map((rule, index) => {
    const a = `F-${index + 1}`;
    const b = `F-${index + 2}`;
    return { a, b, score: 0.9 - index / 100, rule, key: pairKey(a, b) };
  });
  return { items, pairs };
}

/** The question set a batch of `pairs` must be asked with. */
function expectedBatch(registry: any, items: Map<string, any>, pairs: any[]) {
  const kind = registry.kinds.find((entry: any) => entry.id === KIND);
  const item = (id: string) => ({ id, text: itemText(items.get(id).text, kind.params.itemBytes), locator: items.get(id).locator });
  return buildBatch({
    question: materializeKind(KIND, { adviceRegistry: registry }).question,
    states: pairs.map((pair) => pairState(item(pair.a), item(pair.b))),
    questionsPerCall: kind.params.questionsPerCall,
  });
}

/** A project (real path, no repository), a user home, the storage roots and the retained lines. */
function project(t: any) {
  const dir = fs.realpathSync(tempDir(t, 'doflow-same-issue-ask-'));
  const root = path.join(dir, 'proj');
  fs.mkdirSync(root);
  const env = { HOME: path.join(dir, 'home'), XDG_CONFIG_HOME: path.join(dir, 'xdg') };
  const roots = resolveRoots({ registry: STORAGE, projectRoot: root, env });
  return { root, env, roots, lines: () => readWindow({ roots }).records.map((entry: any) => entry.record) };
}

/** Advice on in the user settings against a fake server answering `route`; `kindMode` sets advice.kinds.same-issue. */
async function advised(t: any, p: any, route: any, kindMode: string | null = null) {
  const server: any = await startFakeServer({ routes: { 'POST /v1/systemone': route } });
  t.after(() => server.close());
  const setting: any = { schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': server.origin, 'advice.model': MODEL };
  if (kindMode) setting[`advice.kinds.${KIND}`] = kindMode;
  const file = path.join(p.roots['config-home'], 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(setting));
  return { server, asks: () => server.requests.filter((r: any) => r.pathname === '/v1/systemone') };
}

/** A local result for the project whose digests match the fixture kind, its question and the effective bars. */
function storeResult(p: any, registry: any, metrics: any, modelDigest: string) {
  const kind = registry.kinds.find((entry: any) => entry.id === KIND);
  const bars = effectiveBars({ registry, kind: KIND, roots: p.roots });
  assert.equal(bars.ok, true);
  writeResult({ roots: p.roots, entry: {
    kind: KIND, provider: 'ollama', model: MODEL, modelDigest,
    questionDigest: questionDigest(materializeKind(KIND, { adviceRegistry: registry }).question),
    builderDigest: builderDigest(getSource('review-findings'), kind),
    barsDigest: barsDigest(bars.bars, kind.budgetMs),
    caseSet: { source: 'review-findings', origin: 'project', projectKey: projectKey(p.root), digest: caseSetDigest([]), eligible: 120, replayed: 120 },
    metrics, runAt: '2026-11-19T08:00:00.000Z', doflowVersion: '2.4.0',
  } });
}

async function waitFor(check: () => any, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

/** Waits for `count` lines, then a little longer, so a line written past the count would be seen. */
async function settledLines(p: any, count: number) {
  await waitFor(() => p.lines().length >= count);
  await new Promise((resolve) => setTimeout(resolve, 150));
  return p.lines();
}

/** The yes probability per block label: a clear yes, a split, a clear no. */
const YES: Record<string, number> = { [`${KIND}-a`]: 0.92, [`${KIND}-b`]: 0.5, [`${KIND}-c`]: 0.08 };
const RULES = ['yes', 'no', 'no', 'yes'];

/** Asserts the fake server got one call per batch of three, in any order, each asking exactly its pairs. */
function assertAsked(asks: any[], registry: any, items: Map<string, any>, pairs: any[]) {
  const expected = [pairs.slice(0, 3), pairs.slice(3)].map((group) => expectedBatch(registry, items, group));
  const got = asks.map((ask: any) => ({ state: ask.body.state, names: Object.keys(ask.body.questions) }))
    .sort((left: any, right: any) => right.names.length - left.names.length);
  assert.deepEqual(got, expected.map((set) => ({ state: set.state, names: set.questions.map((q: any) => q.name) })));
}

test('(a) an unset kind runs in shadow: nothing shown, one call per batch of the candidate pairs, one line per pair', async (t) => {
  const p = project(t);
  const registry = registryWith();
  const a = await advised(t, p, answering((name: string) => YES[name]));
  const { items, pairs } = fixturePairs(RULES);
  const res = await checkPairs({ kind: KIND, pairs, items, caller: 'review', cwd: p.root, env: p.env, adviceRegistry: registry });
  assert.deepEqual([res.shown, res.mode, res.reason, res.batches], [false, 'shadow', 'shadow', 2]);
  assert.deepEqual(res.pairs, pairs.map(({ a: first, b, score, rule }: any) => ({ a: first, b, score, rule, model: null, noAnswer: null })));
  const lines = await settledLines(p, 4);
  assertAsked(a.asks(), registry, items, pairs);
  assert.equal(lines.length, 4, 'one line per pair');
  assert.ok(lines.every((line: any) => line.type === 'pick' && line.mode === 'shadow' && line.kind === KIND && line.caller === 'review'));
  assert.deepEqual(lines.map((line: any) => line.static).sort(), [...RULES].sort());
});

test('(b) show at a passing local result: every batch shown, the model answer per pair, a split is no answer', async (t) => {
  const p = project(t);
  const registry = registryWith();
  const a = await advised(t, p, answering((name: string) => YES[name]), 'show');
  storeResult(p, registry, SHOW_ONLY, `sha256:${digestOf('clef-flash:latest')}`);
  const { items, pairs } = fixturePairs(RULES);
  const res = await checkPairs({ kind: KIND, pairs, items, caller: 'followup', cwd: p.root, env: p.env, adviceRegistry: registry });
  assert.equal(res.reason, null);
  assert.deepEqual([res.shown, res.mode, res.batches], [true, 'show', 2]);
  // Batch one asks blocks a, b, c; batch two, the one-pair batch, asks block a.
  assert.deepEqual(res.pairs.map((pair: any) => [pair.a, pair.b, pair.rule, pair.model, pair.noAnswer]), [
    ['F-1', 'F-2', 'yes', 'yes', null],
    ['F-2', 'F-3', 'no', null, 'split'],
    ['F-3', 'F-4', 'no', 'no', null],
    ['F-4', 'F-5', 'yes', 'yes', null],
  ]);
  assertAsked(a.asks(), registry, items, pairs);
  const lines = p.lines();
  assert.equal(lines.length, 4);
  assert.ok(lines.every((line: any) => line.type === 'pick' && line.mode === 'show' && line.caller === 'followup'));
});

test('(c) show at a failing local result runs as (a), the reason naming the unmet standing', async (t) => {
  const p = project(t);
  const registry = registryWith();
  const a = await advised(t, p, answering((name: string) => YES[name]), 'show');
  storeResult(p, registry, BELOW_SHOW, `sha256:${digestOf('clef-flash:latest')}`);
  const { items, pairs } = fixturePairs(RULES);
  const res = await checkPairs({ kind: KIND, pairs, items, caller: 'review', cwd: p.root, env: p.env, adviceRegistry: registry });
  assert.deepEqual([res.shown, res.mode, res.batches], [false, 'shadow', 2]);
  assert.match(res.reason, /^LOCAL_RESULT_UNMET: below-show: /);
  assert.ok(res.pairs.every((pair: any) => pair.model === null && pair.noAnswer === null));
  const lines = await settledLines(p, 4);
  assertAsked(a.asks(), registry, items, pairs);
  assert.equal(lines.length, 4);
  assert.ok(lines.every((line: any) => line.type === 'pick' && line.mode === 'shadow'));
});

/** An injected client that answers yes to every question once `expected` asks are in flight together. */
function barrierClient(expected: number) {
  const asks: any[] = [];
  let open: () => void = () => {};
  const together = new Promise<void>((resolve) => { open = resolve; });
  const ask = async (options: any) => {
    asks.push(options);
    if (asks.length === expected) open();
    await Promise.race([together, new Promise((resolve) => setTimeout(resolve, 2000))]);
    const answers = options.questionSet.questions.map((q: any) => ({ name: q.name, type: 'yesno', pick: 'yes', strength: { word: 'clear', between: null }, probabilities: { no: 0.1, yes: 0.9 }, confidence: 0.9 }));
    return { status: 'answered', reason: null, model: 'm', answers, together: asks.length };
  };
  return { asks, ask };
}

const trustShow = (requests: any[]) => async (request: any) => {
  requests.push(request);
  return { standing: 'show', reason: 'injected show', failedChecks: [], staleDigest: null, modelDigest: 'sha256:00' };
};

test('(d) 17 pairs at 8 per call make 3 batches (8, 8, 1) in pair order, all asked together', async (t) => {
  const p = project(t);
  const registry = registryWith({ questionsPerCall: 8 });
  const { items, pairs } = fixturePairs(Array.from({ length: 17 }, (_, index) => (index % 2 ? 'no' : 'yes')));
  const client = barrierClient(3);
  const services = { adviceClient: client, trust: trustShow([]), shadowConfig: { kind: KIND, mode: 'show', model: 'm' } };
  const started = Date.now();
  const res = await checkPairs({ kind: KIND, pairs, items, caller: 'review', cwd: p.root, env: p.env, adviceRegistry: registry, services });
  assert.ok(Date.now() - started < 2000, 'the batches were in flight together');
  assert.deepEqual([res.shown, res.batches], [true, 3]);
  assert.deepEqual(client.asks.map((ask: any) => ask.questionSet.questions.length), [8, 8, 1]);
  const groups = [pairs.slice(0, 8), pairs.slice(8, 16), pairs.slice(16)];
  assert.deepEqual(client.asks.map((ask: any) => ask.questionSet.state), groups.map((group) => expectedBatch(registry, items, group).state));
  assert.equal(res.pairs.length, 17);
  assert.ok(res.pairs.every((pair: any) => pair.model === 'yes' && pair.noAnswer === null));
  assert.equal(p.lines().length, 17);
});

test('(e) from a linked worktree the dispatcher gets the main checkout as the decision root', async (t) => {
  const scratch = createScratch('doflow-same-issue-root-');
  t.after(() => scratch.remove());
  const repo = makeRepo(scratch, 'main');
  const linked = path.join(scratch.dir, 'linked');
  repo.git('worktree', 'add', '-q', '-b', 'feat/x', linked);
  const env = { HOME: scratch.home, XDG_CONFIG_HOME: scratch.xdg };
  const requests: any[] = [];
  const services = { adviceClient: barrierClient(1), trust: trustShow(requests), shadowConfig: { kind: KIND, mode: 'show', model: 'm' } };
  const { items, pairs } = fixturePairs(['yes']);
  const res = await checkPairs({ kind: KIND, pairs, items, caller: 'review', cwd: linked, env, adviceRegistry: registryWith(), services });
  assert.equal(res.shown, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].projectRoot, fs.realpathSync(repo.dir));
  assert.notEqual(requests[0].projectRoot, fs.realpathSync(linked));
});

test('(f) zero pairs make no call and record nothing', async (t) => {
  const p = project(t);
  const a = await advised(t, p, answering(() => 0.9), 'show');
  const res = await checkPairs({ kind: KIND, pairs: [], items: new Map(), caller: 'review', cwd: p.root, env: p.env, adviceRegistry: registryWith() });
  assert.deepEqual([res.shown, res.batches, res.pairs], [false, 0, []]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(a.server.requests.length, 0);
  assert.deepEqual(p.lines(), []);
});

test('(g) a call that names another kind is refused before anything is asked', async () => {
  const { items, pairs } = fixturePairs(['yes']);
  await assert.rejects(checkPairs({ kind: 'claim-support', pairs, items, caller: 'review', cwd: process.cwd(), adviceRegistry: registryWith() }), /same-issue kind only \(got 'claim-support'\)/);
});
