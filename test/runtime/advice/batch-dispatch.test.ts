'use strict';

// Row 176 T2 (design §6, IC-004, owner ruling O-1 (a)): a decision with one static answer per question (`staticPicks`) is
// a batch, of one question or more, and the dispatcher records one pick or miss line per question, each with its own pick
// id and static answer, so `advise --action report` and `--followed` keep working per question. A single-question
// decision without `staticPicks` writes the line it wrote before the change, byte for byte. The model is a fake server or an injected client; HOME and XDG_CONFIG_HOME are
// temp dirs, and the batched kind is a fixture in a registry passed through the context.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../../helper/tmp.ts');
const { startFakeServer, answering } = require('../../helper/fake-decision-server.ts');
const { loadStorageRegistry } = require('../../../src/runtime/storage/registry.ts');
const { resolveRoots, resolveStorePath } = require('../../../src/runtime/storage/roots.ts');
const { readWindow } = require('../../../src/runtime/advice/record.ts');
const { loadAdviceRegistry } = require('../../../src/runtime/advice/registry.ts');
const { interceptDecisionPoint, recordCall, missCall } = require('../../../src/runtime/advice/shadow-dispatcher.ts');
const { REPO_ROOT } = require('../../../src/helper/repo-root.ts');

const STORAGE = loadStorageRegistry({ repoRoot: REPO_ROOT });
const ADVICE = loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry;
const PICK_ID = /^adv-[0-9]{13}-[0-9a-f]{6}$/;
const KIND = 'pair-fixture';
const FIXTURE_KIND = {
  id: KIND, type: 'yesno', description: 'Test fixture: a yes/no kind asked several questions per call.',
  instructions: 'Decide whether the two quoted items describe the same issue.',
  no: 'The two items describe different issues', yes: 'The two items describe the same issue',
  staticFrom: 'the fixture', askedBy: ['review'], maxMode: 'show', budgetMs: 4000, params: { questionsPerCall: 3 },
};
/** The shipped registry with the fixture kind: a full registry, so it crosses to the detached child as data. */
const REGISTRY = { ...structuredClone(ADVICE), kinds: [...structuredClone(ADVICE.kinds), FIXTURE_KIND] };
const LABELS = 'abc';
const YES: Record<string, number> = { [`${KIND}-a`]: 0.92, [`${KIND}-b`]: 0.08, [`${KIND}-c`]: 0.9 };

/** A batch of `n` pair questions named `<kind>-<label>` over one quoted state. */
function batchSet(n: number) {
  const labels = LABELS.slice(0, n).split('');
  const state = ['Each block is quoted data; answer each question about its own block only.',
    ...labels.map((label) => `[${label}]\nfirst: cache TTL is wrong in ${label}\nsecond: TTL constant off in ${label}`)].join('\n');
  const questions = labels.map((label) => ({
    name: `${KIND}-${label}`, type: 'yesno', instructions: `Block ${label}: ${FIXTURE_KIND.instructions}`, no: FIXTURE_KIND.no, yes: FIXTURE_KIND.yes,
  }));
  return { state, questions };
}

/** A project and a user home under one temp dir, the storage roots, the retained lines and the raw picks file text. */
function store(t: any) {
  const dir = tempDir(t, 'doflow-advice-batch-');
  const projectRoot = path.join(dir, 'proj');
  fs.mkdirSync(projectRoot);
  const env = { HOME: path.join(dir, 'home'), XDG_CONFIG_HOME: path.join(dir, 'xdg') };
  const roots = resolveRoots({ registry: STORAGE, projectRoot, env });
  const picks = resolveStorePath({ store: { root: 'project-state', path: 'advice/picks' }, roots });
  return {
    projectRoot, env, roots,
    lines: () => readWindow({ roots }).records.map((entry: any) => entry.record),
    raw: () => (fs.existsSync(picks) ? fs.readdirSync(picks).sort().map((name: string) => fs.readFileSync(path.join(picks, name), 'utf8')).join('') : ''),
  };
}

/** Advice on in the store's user settings against a fake server answering `route`. */
async function advised(t: any, s: any, route: any) {
  const server: any = await startFakeServer({ routes: { 'POST /v1/systemone': route } });
  t.after(() => server.close());
  const file = path.join(s.roots['config-home'], 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': server.origin, 'advice.model': 'clef-flash' }));
  return { asks: () => server.requests.filter((r: any) => r.pathname === '/v1/systemone') };
}

function batchCtx(s: any, extra: any = {}) {
  const set = batchSet(3);
  return {
    kind: KIND, caller: 'review', state: set.state, staticPick: 'yes', staticPicks: ['yes', 'no', 'no'], taskId: null,
    questionSet: set, adviceRegistry: REGISTRY, projectRoot: s.projectRoot, env: s.env, ...extra,
  };
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
async function settledLines(s: any, count: number) {
  await waitFor(() => s.lines().length >= count);
  await new Promise((resolve) => setTimeout(resolve, 150));
  return s.lines();
}

/** An injected trust evaluator at `standing`; it keeps every request. */
function trustAt(standing: string) {
  const requests: any[] = [];
  const trust = async (request: any) => { requests.push(request); return { standing, reason: `injected ${standing}`, failedChecks: [], staleDigest: null, modelDigest: 'sha256:00' }; };
  return Object.assign(trust, { requests });
}

const SHOW = { kind: KIND, mode: 'show', model: 'clef-flash' };

test('(a) shadow: the caller gets no answers, and the child records one pick line per question with its own static and pick id', async (t) => {
  const s = store(t);
  const a = await advised(t, s, answering((name: string) => YES[name]));
  const res = await interceptDecisionPoint(batchCtx(s), { roots: s.roots, shadowConfig: { kind: KIND, mode: 'shadow', model: 'clef-flash' } });
  assert.equal(res.mode, 'shadow');
  assert.equal(res.advisorPick, null);
  assert.deepEqual(res.advisorAnswers, []);
  assert.deepEqual(res.pickIds, []);
  assert.match(res.pickId, PICK_ID);
  const lines = await settledLines(s, 3);
  assert.equal(a.asks().length, 1, 'one call for the whole batch');
  assert.deepEqual(Object.keys(a.asks()[0].body.questions), [`${KIND}-a`, `${KIND}-b`, `${KIND}-c`]);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line: any) => line.type === 'pick' && line.mode === 'shadow' && line.kind === KIND));
  assert.deepEqual(lines.map((line: any) => line.question), [`${KIND}-a`, `${KIND}-b`, `${KIND}-c`]);
  assert.deepEqual(lines.map((line: any) => line.pick), ['yes', 'no', 'yes']);
  assert.deepEqual(lines.map((line: any) => line.static), ['yes', 'no', 'no']);
  assert.equal(lines[0].pickId, res.pickId, 'the first line takes the decision\'s pick id');
  assert.equal(new Set(lines.map((line: any) => line.pickId)).size, 3, 'each line has its own pick id');
  assert.ok(lines.every((line: any) => PICK_ID.test(line.pickId)));
  assert.equal(new Set(lines.map((line: any) => line.durationMs)).size, 1, 'every line carries the call\'s duration');
});

test('(b) a failed call records one miss line per question with the call\'s reason', async (t) => {
  const s = store(t);
  await advised(t, s, { status: 500, body: { error: 'down' } });
  const res = await interceptDecisionPoint(batchCtx(s), { roots: s.roots, shadowConfig: { kind: KIND, mode: 'shadow', model: 'clef-flash' } });
  assert.equal(res.mode, 'shadow');
  const lines = await settledLines(s, 3);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line: any) => line.type === 'miss' && line.kind === KIND && line.mode === 'shadow'));
  assert.equal(new Set(lines.map((line: any) => line.reason)).size, 1, 'every miss carries the one call\'s reason');
  assert.equal(typeof lines[0].reason, 'string');
  assert.ok(lines[0].reason);
});

test('(b) a failed shown call returns a null answer per question and records a miss per question; a batch asks with no static answer', async (t) => {
  const s = store(t);
  const calls: any[] = [];
  const adviceClient = { ask: async (options: any) => { calls.push(options); return { status: 'unavailable', reason: 'timeout', answers: [] }; } };
  const res = await interceptDecisionPoint(batchCtx(s, { surface: 'show' }), { adviceClient, roots: s.roots, trust: trustAt('show'), shadowConfig: SHOW });
  assert.equal(res.mode, 'show');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].staticAnswer, null, 'the client checks a static answer against the first question only');
  assert.deepEqual(res.advisorAnswers, [null, null, null]);
  assert.equal(res.pickIds.length, 3);
  const lines = s.lines();
  assert.deepEqual(lines.map((line: any) => [line.type, line.reason, line.mode]), [['miss', 'timeout', 'show'], ['miss', 'timeout', 'show'], ['miss', 'timeout', 'show']]);
});

test('(c) show at a passing standing returns an answer and a pick id per question, matching the lines', async (t) => {
  const s = store(t);
  await advised(t, s, answering((name: string) => YES[name]));
  const trust = trustAt('show');
  const res = await interceptDecisionPoint(batchCtx(s, { surface: 'show' }), { roots: s.roots, trust, shadowConfig: SHOW });
  assert.equal(res.mode, 'show');
  assert.equal(res.effectiveDecision, 'yes', 'a shown answer never changes the decision');
  assert.equal(res.advisorAnswers.length, 3);
  assert.deepEqual(res.advisorAnswers.map((answer: any) => answer.pick), ['yes', 'no', 'yes']);
  assert.equal(res.pickIds.length, 3);
  assert.equal(res.pickIds[0], res.pickId);
  assert.equal(new Set(res.pickIds).size, 3);
  const lines = s.lines();
  assert.deepEqual(lines.map((line: any) => line.pickId), res.pickIds);
  assert.deepEqual(res.advisorAnswers.map((answer: any) => answer.strength), lines.map((line: any) => line.strength));
  assert.ok(lines.every((line: any) => line.mode === 'show' && typeof line.strength === 'string'));
  assert.deepEqual(lines.map((line: any) => line.static), ['yes', 'no', 'no']);
  // The local result is stored against the kind's materialised question (replay/run.ts), not the batch's first block.
  assert.deepEqual(trust.requests[0].question, {
    name: KIND, type: 'yesno', instructions: FIXTURE_KIND.instructions, no: FIXTURE_KIND.no, yes: FIXTURE_KIND.yes,
  });
});

test('(c) a one-question batch is a batch: trust on the materialised question, no static answer asked, its line from staticPicks[0]', async (t) => {
  const s = store(t);
  const calls: any[] = [];
  const reply = { status: 'answered', reason: null, model: 'm', answers: [{ name: `${KIND}-a`, type: 'yesno', pick: 'yes', strength: { word: 'clear', between: null }, probabilities: { no: 0.1, yes: 0.9 }, confidence: 0.9 }] };
  const adviceClient = { ask: async (options: any) => { calls.push(options); return reply; } };
  const trust = trustAt('show');
  const set = batchSet(1);
  const res = await interceptDecisionPoint(batchCtx(s, { surface: 'show', state: set.state, questionSet: set, staticPick: 'no', staticPicks: ['no'] }), { adviceClient, roots: s.roots, trust, shadowConfig: SHOW });
  assert.equal(res.mode, 'show');
  assert.deepEqual(trust.requests[0].question, {
    name: KIND, type: 'yesno', instructions: FIXTURE_KIND.instructions, no: FIXTURE_KIND.no, yes: FIXTURE_KIND.yes,
  });
  assert.equal(calls[0].staticAnswer, null);
  assert.deepEqual(res.advisorAnswers, [{ pick: 'yes', strength: 'clear' }]);
  const lines = s.lines();
  assert.deepEqual(lines.map((line: any) => [line.type, line.question, line.static, line.pickId]), [['pick', `${KIND}-a`, 'no', res.pickId]]);
});

test('(e) busy slots record a busy miss per question and start no call', async (t) => {
  const s = store(t);
  const a = await advised(t, s, answering((name: string) => YES[name]));
  const slots = path.join(s.roots['user-state'], 'advice', 'shadow-slots');
  fs.mkdirSync(slots, { recursive: true });
  for (let index = 0; index < ADVICE.shadowSlots; index += 1) {
    fs.writeFileSync(path.join(slots, `slot-${index}.json`), JSON.stringify({ token: `held${index}`, pid: process.pid, startedAt: Date.now(), budgetMs: 60000 }));
  }
  const res = await interceptDecisionPoint(batchCtx(s), { roots: s.roots, shadowConfig: { kind: KIND, mode: 'shadow', model: 'clef-flash' } });
  assert.equal(res.mode, 'shadow');
  const lines = s.lines();
  assert.deepEqual(lines.map((line: any) => [line.type, line.reason]), [['miss', 'busy'], ['miss', 'busy'], ['miss', 'busy']]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(a.asks().length, 0);
});

// ── (d) a single-question decision writes the line it wrote before the change ──────────────────────────────────────
//
// Captured from the unchanged dispatcher (b25116eb, whose advice files differ from develop only by T1's two new ones) by
// running exactly these four scenarios, with the time, a minted pick id and a measured duration masked.

const BASE_LINES = {
  shownChoice:
    "{\"schema\":1,\"type\":\"pick\",\"pickId\":\"<pick>\",\"at\":\"<at>\",\"kind\":\"tier\",\"question\":\"tier\",\"qtype\":\"choice\",\"options\":[\"light\",\"standard\",\"frontier\"],\"instructions\":null,\"pick\":\"frontier\",\"strength\":\"clear\",\"between\":null,\"probabilities\":{\"light\":0.1,\"standard\":0.1,\"frontier\":0.8},\"confidence\":0.8,\"static\":\"light\",\"provider\":null,\"model\":\"m\",\"stateDigest\":\"sha256:6b4dfbce38e9338ba8153ce7b8f515b9e08f8cd8f3162f608f5c43e31cd4574c\",\"stateBytes\":58,\"caller\":\"brief-tools\",\"taskId\":\"task-abc\",\"durationMs\":<ms>,\"mode\":\"show\",\"elevated\":false}\n",
  recordedYesNo:
    "{\"schema\":1,\"type\":\"pick\",\"pickId\":\"adv-0000000000001-abcdef\",\"at\":\"<at>\",\"kind\":\"pair-fixture\",\"question\":\"pair-fixture\",\"qtype\":\"yesno\",\"options\":[\"no\",\"yes\"],\"instructions\":null,\"pick\":\"yes\",\"strength\":\"clear\",\"between\":null,\"probabilities\":{\"no\":0.1,\"yes\":0.9},\"confidence\":0.9,\"static\":\"no\",\"provider\":\"ollama\",\"model\":\"m\",\"stateDigest\":\"sha256:6b4dfbce38e9338ba8153ce7b8f515b9e08f8cd8f3162f608f5c43e31cd4574c\",\"stateBytes\":58,\"caller\":\"review\",\"taskId\":null,\"durationMs\":42,\"mode\":\"shadow\",\"elevated\":false}\n",
  recordedMiss:
    "{\"schema\":1,\"type\":\"miss\",\"at\":\"<at>\",\"kind\":\"pair-fixture\",\"caller\":\"review\",\"reason\":\"busy\",\"model\":\"m\",\"durationMs\":0,\"mode\":\"shadow\"}\n",
  shadowChild:
    "{\"schema\":1,\"type\":\"pick\",\"pickId\":\"<pick>\",\"at\":\"<at>\",\"kind\":\"pair-fixture\",\"question\":\"pair-fixture\",\"qtype\":\"yesno\",\"options\":[\"no\",\"yes\"],\"instructions\":null,\"pick\":\"yes\",\"strength\":\"clear\",\"between\":null,\"probabilities\":{\"no\":0.09999999999999998,\"yes\":0.9},\"confidence\":null,\"static\":\"no\",\"provider\":\"ollama\",\"model\":\"clef-flash\",\"stateDigest\":\"sha256:6b4dfbce38e9338ba8153ce7b8f515b9e08f8cd8f3162f608f5c43e31cd4574c\",\"stateBytes\":58,\"caller\":\"review\",\"taskId\":null,\"durationMs\":<ms>,\"mode\":\"shadow\",\"elevated\":false}\n",
};

const mask = (text: string) => text.replace(/"at":"[^"]+"/g, '"at":"<at>"').replace(/"pickId":"adv-[0-9]{13}-[0-9a-f]{6}"/g, '"pickId":"<pick>"').replace(/"durationMs":\d+/g, '"durationMs":<ms>');

const SINGLE_STATE = 'Implement an integration spanning several runtime modules.';
const TIER_QUESTION = { name: 'tier', type: 'choice', instructions: 'Choose a tier.', options: { light: 'Light', standard: 'Standard', frontier: 'Frontier' } };
const SINGLE_YESNO = { name: KIND, type: 'yesno', instructions: FIXTURE_KIND.instructions, no: FIXTURE_KIND.no, yes: FIXTURE_KIND.yes };
const YESNO_ANSWER = { name: KIND, type: 'yesno', pick: 'yes', strength: { word: 'clear', between: null }, probabilities: { no: 0.1, yes: 0.9 }, confidence: 0.9, model: 'm' };

test('(d) a single-question decision writes, byte for byte, the line the base code writes', async (t) => {
  // A shown tier decision through the whole show path, with an injected client.
  const shown = store(t);
  const tierReply = {
    status: 'answered', reason: null, model: 'm',
    answers: [{ name: 'tier', type: 'choice', pick: 'frontier', strength: { word: 'clear', between: null }, probabilities: { light: 0.1, standard: 0.1, frontier: 0.8 }, confidence: 0.8, pickId: null }],
  };
  await interceptDecisionPoint({
    kind: 'tier', caller: 'brief-tools', state: SINGLE_STATE, staticPick: 'light', taskId: 'task-abc', surface: 'show',
    questionSet: { state: SINGLE_STATE, questions: [TIER_QUESTION] }, adviceRegistry: REGISTRY, projectRoot: shown.projectRoot, env: shown.env,
  }, { adviceClient: { ask: async () => tierReply }, roots: shown.roots, trust: trustAt('show'), shadowConfig: { kind: 'tier', mode: 'show', model: 'm' } });
  assert.equal(mask(shown.raw()), BASE_LINES.shownChoice);

  // A yes/no answer and a miss recorded by recordCall itself, with a fixed pick id and duration.
  const single = { kind: KIND, caller: 'review', state: SINGLE_STATE, staticPick: 'no', taskId: null, questionSet: { state: SINGLE_STATE, questions: [SINGLE_YESNO] }, adviceRegistry: REGISTRY };
  const recorded = store(t);
  recordCall({ ...single, projectRoot: recorded.projectRoot, env: recorded.env }, { roots: recorded.roots }, 'shadow', {
    status: 'answered', pick: 'yes', answer: YESNO_ANSWER, answers: [YESNO_ANSWER], reason: null, provider: 'ollama', model: 'm', durationMs: 42,
  }, 'adv-0000000000001-abcdef', false);
  assert.equal(recorded.raw().replace(/"at":"[^"]+"/g, '"at":"<at>"'), BASE_LINES.recordedYesNo);
  const missed = store(t);
  recordCall({ ...single, projectRoot: missed.projectRoot, env: missed.env }, { roots: missed.roots }, 'shadow', missCall('busy', 'm'), 'adv-0000000000001-abcdef', false);
  assert.equal(missed.raw().replace(/"at":"[^"]+"/g, '"at":"<at>"'), BASE_LINES.recordedMiss);

  // A single-question shadow decision of the fixture kind, asked and recorded by the detached child.
  const child = store(t);
  await advised(t, child, answering(() => 0.9));
  await interceptDecisionPoint({ ...single, projectRoot: child.projectRoot, env: child.env }, { roots: child.roots, shadowConfig: { kind: KIND, mode: 'shadow', model: 'clef-flash' } });
  await settledLines(child, 1);
  assert.equal(mask(child.raw()), BASE_LINES.shadowChild);
});

// ── a multi-question decision that declares no batch records what it recorded before the change ────────────────────
//
// Only `staticPicks` aligned with the questions declares a batch. A caller's own multi-question set (the ad hoc
// `advise` path hands the dispatcher a whole call-criteria set, here a three-candidate rerank ladder) keeps one line and
// its trust check on the first question. Captured from b25116eb (a scratch export, not a checkout) by running these two
// scenarios, masked as in (d).

const NON_BATCH_BASE = {
  rerankShown:
    "{\"schema\":1,\"type\":\"pick\",\"pickId\":\"<pick>\",\"at\":\"<at>\",\"kind\":\"rerank\",\"question\":\"rerank-a\",\"qtype\":\"score\",\"options\":[\"The candidate is unrelated to the query.\",\"The candidate shares the topic but does not help answer the query.\",\"The candidate answers part of the query or only one aspect of it.\",\"The candidate answers the query but leaves out detail or needs other passages.\",\"The candidate answers the query fully on its own.\"],\"instructions\":null,\"pick\":\"The candidate answers the query fully on its own.\",\"strength\":\"clear\",\"between\":null,\"probabilities\":{\"0\":0.1,\"1\":0.1,\"2\":0.1,\"3\":0.1,\"4\":0.6},\"confidence\":0.6,\"static\":\"A\",\"provider\":null,\"model\":\"m\",\"stateDigest\":\"sha256:8a5a1f53b54b81b5c429e0c1ee189ab0414bc2722763c0478da460b897c97d09\",\"stateBytes\":218,\"caller\":\"advise\",\"taskId\":null,\"durationMs\":<ms>,\"mode\":\"show\",\"elevated\":false,\"criteria\":[\"The candidate is unrelated to the query.\",\"The candidate shares the topic but does not help answer the query.\",\"The candidate answers part of the query or only one aspect of it.\",\"The candidate answers the query but leaves out detail or needs other passages.\",\"The candidate answers the query fully on its own.\"],\"pickIndex\":4,\"score\":3.5}\n",
  rerankBusy:
    "{\"schema\":1,\"type\":\"miss\",\"at\":\"<at>\",\"kind\":\"rerank\",\"caller\":\"advise\",\"reason\":\"busy\",\"model\":\"m\",\"durationMs\":<ms>,\"mode\":\"shadow\"}\n",
};

test('a multi-question decision without aligned staticPicks is no batch: one line, byte for byte the base one, trust on its first question', async (t) => {
  const { buildRerankQuestionSet } = require('../../../src/runtime/advice/rerank.ts');
  const RERANK = ADVICE.kinds.find((kind: any) => kind.id === 'rerank');
  const candidates = ['a', 'b', 'c'].map((name) => ({ ref: `docs/${name}.md`, title: `T ${name}`, text: `candidate text ${name}` }));
  const built = buildRerankQuestionSet({
    query: 'a query', candidates, params: { ...RERANK.params, arm: 'ladder' }, arm: 'ladder',
    criteria: { ladder: RERANK.scoreLadder.criteria, choiceInstruction: 'choose' }, scoreLadder: RERANK.scoreLadder, limits: ADVICE.limits,
  });
  assert.equal(built.ok, true);
  const reply = {
    status: 'answered', reason: null, model: 'm',
    answers: built.labels.map((label: string, index: number) => ({
      name: `rerank-${label.toLowerCase()}`, type: 'score', pick: built.questionSet.questions[index].criteria[4], pickIndex: 4, score: 3.5, confidence: 0.6,
      criteria: built.questionSet.questions[index].criteria, strength: { word: 'clear', between: null }, probabilities: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.1, 4: 0.6 },
    })),
  };
  const ctx = (s: any, extra: any = {}) => ({
    kind: 'rerank', caller: 'advise', state: built.questionSet.state, staticPick: 'A', staticAnswer: 'A', questionSet: built.questionSet,
    adviceRegistry: ADVICE, taskId: null, projectRoot: s.projectRoot, env: s.env, ...extra,
  });

  // Shown, as `advise --kind rerank` does it.
  const shown = store(t);
  const trust = trustAt('show');
  const res = await interceptDecisionPoint(ctx(shown, { surface: 'show' }), { adviceClient: { ask: async () => reply }, roots: shown.roots, trust, shadowConfig: { kind: 'rerank', mode: 'show', model: 'm' } });
  assert.equal(mask(shown.raw()), NON_BATCH_BASE.rerankShown);
  assert.deepEqual(trust.requests[0].question, built.questionSet.questions[0]);
  assert.deepEqual(res.pickIds, [res.pickId], 'a decision that is no batch reports its one line');
  assert.deepEqual(res.advisorAnswers, [{ pick: reply.answers[0].pick, strength: 'clear' }]);

  // Shadow with every slot held: one busy miss, with no staticPicks and with staticPicks not aligned with the questions.
  for (const extra of [{}, { staticPicks: ['A', 'B'] }]) {
    const busy = store(t);
    const slots = path.join(busy.roots['user-state'], 'advice', 'shadow-slots');
    fs.mkdirSync(slots, { recursive: true });
    for (let index = 0; index < ADVICE.shadowSlots; index += 1) {
      fs.writeFileSync(path.join(slots, `slot-${index}.json`), JSON.stringify({ token: `held${index}`, pid: process.pid, startedAt: Date.now(), budgetMs: 60000 }));
    }
    await interceptDecisionPoint(ctx(busy, extra), { roots: busy.roots, shadowConfig: { kind: 'rerank', mode: 'shadow', model: 'm' } });
    assert.equal(mask(busy.raw()), NON_BATCH_BASE.rerankBusy);
  }
});
