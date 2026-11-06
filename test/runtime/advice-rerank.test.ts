'use strict';

// 141 IC-009 (choice arm): the rerank question builder, the answer interpreter and the pick-line payload. All pure, so
// every case is a table of fixed numbers; no client, file or network is involved. Fake text only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRerankQuestionSet,
  interpretRerankAnswers,
  rerankPayload,
  cutBytes,
} = require('../../src/runtime/advice/rerank.ts');
const { validateQuestionSet } = require('../../src/runtime/advice/kinds.ts');

const PARAMS = { arm: 'choice', minCandidates: 2, maxCandidates: 16, candidateBytes: 800, queryBytes: 2048, criteriaBytes: 1536 };
const CRITERIA = { choiceInstruction: 'Select the candidate that best answers the query.' };
const LIMITS = { maxStateBytes: 16384 };
const ADVICE_REGISTRY = {
  limits: { minQuestions: 1, maxQuestions: 16, minOptions: 2, maxOptions: 16, questionName: '^[a-z][a-z0-9-]*$' },
};

function candidates(n: number, text = 'passage text') {
  return Array.from({ length: n }, (_, i) => ({ ref: `docs/file-${i}.md`, title: `Title ${i}`, text: `${text} ${i}` }));
}

function build(overrides: Record<string, unknown> = {}) {
  return buildRerankQuestionSet({
    query: 'how are verdicts stored', candidates: candidates(4), params: PARAMS, arm: 'choice',
    criteria: CRITERIA, limits: LIMITS, ...overrides,
  });
}

// The 2026-11-06 probe: 16 candidates, D 0.259, I 0.180, C 0.117 largest; the 16 values summed to 1.0 (floating point).
const PROBE = {
  A: 0.05, B: 0.04, C: 0.117, D: 0.259, E: 0.03, F: 0.02, G: 0.03, H: 0.04,
  I: 0.18, J: 0.05, K: 0.04, L: 0.03, M: 0.03, N: 0.02, O: 0.02, P: 0.044,
};
const LABELS_16 = Object.keys(PROBE);

test('builds one choice question over labels A to P with the query as the named state field', () => {
  const built = build({ candidates: candidates(16) });
  assert.equal(built.ok, true);
  assert.equal(built.arm, 'choice');
  assert.deepEqual(built.labels, LABELS_16);
  assert.equal(built.refs.length, 16);
  assert.equal(built.refs[0], 'docs/file-0.md');
  assert.equal(built.questionSet.state, 'query: how are verdicts stored');
  assert.equal(built.questionSet.questions.length, 1);
  const [question] = built.questionSet.questions;
  assert.equal(question.name, 'rerank');
  assert.equal(question.type, 'choice');
  assert.equal(question.instructions, CRITERIA.choiceInstruction);
  assert.deepEqual(Object.keys(question.options), LABELS_16);
  assert.equal(question.options.A, 'Title 0 passage text 0');
  assert.equal(validateQuestionSet(built.questionSet, { adviceRegistry: ADVICE_REGISTRY }).ok, true);
});

test('only the first maxCandidates candidates are used', () => {
  const built = build({ candidates: candidates(20), params: { ...PARAMS, maxCandidates: 5 } });
  assert.deepEqual(built.labels, ['A', 'B', 'C', 'D', 'E']);
  assert.equal(built.refs.length, 5);
  // Never more than the 16 labels even when the registry allows more.
  assert.equal(build({ candidates: candidates(30), params: { ...PARAMS, maxCandidates: 30 } }).labels.length, 16);
});

test('too few candidates and a blank query are refused with a reason', () => {
  assert.deepEqual(build({ candidates: candidates(1) }), { ok: false, reason: 'too-few-candidates' });
  assert.deepEqual(build({ candidates: [] }), { ok: false, reason: 'too-few-candidates' });
  assert.deepEqual(build({ candidates: undefined }), { ok: false, reason: 'too-few-candidates' });
  assert.deepEqual(build({ query: '  \n\t ' }), { ok: false, reason: 'empty-query' });
  assert.deepEqual(build({ query: 42 }), { ok: false, reason: 'empty-query' });
});

test('a state over limits.maxStateBytes is refused', () => {
  assert.deepEqual(build({ limits: { maxStateBytes: 8 } }), { ok: false, reason: 'state-too-large' });
});

test('whitespace runs collapse and the query is cut to queryBytes', () => {
  const built = build({ query: 'a  b\n\n c\t d', candidates: [
    { ref: 'r0', title: ' T\n0 ', text: 'x \n\n  y' }, { ref: 'r1', title: 'T1', text: 'z' },
  ] });
  assert.equal(built.questionSet.state, 'query: a b c d');
  assert.equal(built.questionSet.questions[0].options.A, 'T 0 x y');
  const cut = build({ query: 'q'.repeat(100), params: { ...PARAMS, queryBytes: 10 } });
  assert.equal(cut.questionSet.state, `query: ${'q'.repeat(10)}`);
});

test('candidate text is cut to candidateBytes at a code-point boundary and counted', () => {
  // 'é' is 2 bytes and '😀' is 4 bytes; a 7-byte cap on "aé😀é" (1+2+4+2 = 9) must not split the emoji or the last é.
  assert.deepEqual(cutBytes('aé😀é', 7), { text: 'aé😀', cut: true });
  assert.deepEqual(cutBytes('aé😀é', 6), { text: 'aé', cut: true });
  assert.deepEqual(cutBytes('aé😀é', 9), { text: 'aé😀é', cut: false });
  assert.deepEqual(cutBytes('😀', 3), { text: '', cut: true });

  const built = build({
    candidates: [
      { ref: 'r0', title: 'T', text: '😀'.repeat(50) },
      { ref: 'r1', title: 'T', text: 'short' },
      { ref: 'r2', title: 'T', text: 'é'.repeat(50) },
    ],
    params: { ...PARAMS, candidateBytes: 21 },
  });
  const { options } = built.questionSet.questions[0];
  assert.equal(built.truncated, 2);
  assert.equal(options.B, 'T short');
  for (const label of ['A', 'C']) {
    assert.ok(Buffer.byteLength(options[label], 'utf8') <= 21);
    assert.equal(options[label].includes('\ufffd'), false);
    assert.equal(Buffer.from(options[label], 'utf8').toString('utf8'), options[label]);
  }
  assert.equal(options.A, `T ${'😀'.repeat(4)}`);
});

test('an empty text becomes a placeholder naming the ref, so no option is blank', () => {
  const built = build({
    candidates: [
      { ref: 'src/a.ts:10', title: 'a', text: '' },
      { ref: 'src/b.ts:20', title: '', text: '   \n ' },
      { ref: 'src/c.ts:30', title: '', text: undefined },
    ],
  });
  const { options } = built.questionSet.questions[0];
  assert.equal(options.A, 'a (no text) src/a.ts:10');
  assert.equal(options.B, '(no text) src/b.ts:20');
  assert.equal(options.C, '(no text) src/c.ts:30');
  assert.equal(validateQuestionSet(built.questionSet, { adviceRegistry: ADVICE_REGISTRY }).ok, true);
});

test('a bad arm, params or criteria is refused instead of guessed', () => {
  assert.deepEqual(build({ arm: 'bogus' }), { ok: false, reason: 'unknown-arm' });
  assert.deepEqual(build({ arm: 'ladder' }), { ok: false, reason: 'arm-not-built' });
  assert.deepEqual(build({ params: { ...PARAMS, candidateBytes: 0 } }), { ok: false, reason: 'bad-params' });
  assert.deepEqual(build({ params: undefined }), { ok: false, reason: 'bad-params' });
  assert.deepEqual(build({ criteria: {} }), { ok: false, reason: 'bad-criteria' });
});

test('probabilities order the labels, as in the 2026-11-06 probe', () => {
  const result = interpretRerankAnswers([{ name: 'rerank', type: 'choice', pick: 'D', probabilities: PROBE }], LABELS_16, 'choice');
  assert.equal(result.valid, true);
  assert.deepEqual(result.order.slice(0, 3), ['D', 'I', 'C']);
  assert.equal(result.order.length, 16);
  assert.equal(result.top1Changed, true);
  assert.equal(result.expected, null);
  assert.equal(result.confidence, null);
});

test('values that do not sum to 1 are still used for order only', () => {
  // The probe summed to 1.0000000000000002; a sum of 0.3 or 3 must not invalidate the order either.
  const small = interpretRerankAnswers([{ probabilities: { A: 0.1, B: 0.2 } }], ['A', 'B'], 'choice');
  assert.deepEqual([small.valid, small.order], [true, ['B', 'A']]);
  const big = interpretRerankAnswers([{ probabilities: { A: 1, B: 1, C: 1 } }], ['A', 'B', 'C'], 'choice');
  assert.deepEqual([big.valid, big.order], [true, ['A', 'B', 'C']]);
});

test('ties keep first-stage rank and top1Changed is false when A stays first', () => {
  const tied = interpretRerankAnswers([{ probabilities: { A: 0.25, B: 0.25, C: 0.4, D: 0.25 } }], ['A', 'B', 'C', 'D'], 'choice');
  assert.deepEqual(tied.order, ['C', 'A', 'B', 'D']);
  assert.equal(tied.top1Changed, true);
  const same = interpretRerankAnswers([{ probabilities: { A: 0.5, B: 0.5 } }], ['A', 'B'], 'choice');
  assert.deepEqual(same.order, ['A', 'B']);
  assert.equal(same.top1Changed, false);
});

test('probabilities may also arrive as an array in label order', () => {
  const result = interpretRerankAnswers([{ probabilities: [0.1, 0.7, 0.2] }], ['A', 'B', 'C'], 'choice');
  assert.deepEqual([result.valid, result.order], [true, ['B', 'C', 'A']]);
});

test('an invalid or missing answer returns the first-stage order unchanged', () => {
  const labels = ['A', 'B', 'C'];
  const fallback = { valid: false, order: labels, top1Changed: false, expected: null, confidence: null };
  const bad: any[] = [
    undefined, null, [], 'x', [null], [{}], [{ probabilities: null }],
    [{ probabilities: { A: 0.5, B: 0.5 } }], // C missing
    [{ probabilities: { A: 0.5, B: 0.5, C: '0.9' } }],
    [{ probabilities: { A: 0.5, B: 0.5, C: NaN } }],
    [{ probabilities: { A: 0.5, B: 0.5, C: Infinity } }],
    [{ probabilities: { A: 0.5, B: 0.5, C: 1.2 } }],
    [{ probabilities: { A: 0.5, B: 0.5, C: -0.1 } }],
    [{ probabilities: [0.5, 0.5] }],
  ];
  for (const answers of bad) assert.deepEqual(interpretRerankAnswers(answers, labels, 'choice'), fallback, JSON.stringify(answers));
  // An arm this module does not read yet also falls back, rather than guessing.
  assert.deepEqual(interpretRerankAnswers([{ probabilities: { A: 0.1, B: 0.9, C: 0 } }], labels, 'ladder'), fallback);
  // The fallback is a copy: changing it must not touch the caller's labels.
  const result = interpretRerankAnswers(undefined, labels, 'choice');
  result.order.reverse();
  assert.deepEqual(labels, ['A', 'B', 'C']);
});

test('the payload holds ids, numbers and the arm in the IC-007 shape', () => {
  const refs = LABELS_16.map((_, i) => `docs/file-${i}.md`);
  const interpreted = interpretRerankAnswers([{ probabilities: PROBE }], LABELS_16, 'choice');
  const payload = rerankPayload({
    arm: 'choice', labels: LABELS_16, refs, order: interpreted.order, truncated: 5, params: PARAMS,
    firstStageMs: 12, expected: null, confidence: null, criteriaDigest: '3f9a1c0b27de',
  });
  assert.deepEqual(payload, {
    arm: 'choice', n: 16, refs, order: interpreted.order, truncated: 5, candidateBytes: 800,
    top1Changed: true, firstStageMs: 12, criteriaDigest: '3f9a1c0b27de',
  });
  assert.equal(Object.hasOwn(payload, 'expected'), false);
  assert.equal(Object.hasOwn(payload, 'confidence'), false);
});

test('a payload with an order that is not a permutation falls back to the first-stage order', () => {
  const base = { arm: 'choice', labels: ['A', 'B', 'C'], refs: ['r0', 'r1', 'r2'], truncated: 0, params: PARAMS, firstStageMs: 3, criteriaDigest: null };
  for (const order of [undefined, ['B', 'A'], ['B', 'B', 'A'], ['B', 'A', 'Z']]) {
    const payload = rerankPayload({ ...base, order });
    assert.deepEqual(payload.order, ['A', 'B', 'C']);
    assert.equal(payload.top1Changed, false);
  }
  const odd = rerankPayload({ ...base, order: ['A', 'B', 'C'], firstStageMs: -5, criteriaDigest: 'not hex' });
  assert.equal(odd.firstStageMs, null);
  assert.equal(odd.criteriaDigest, null);
});

test('no query, candidate or criteria text reaches the payload', () => {
  const QUERY = 'SENTINEL_QUERY_TEXT_91ac';
  const TITLE = 'SENTINEL_TITLE_TEXT_5d2e';
  const BODY = 'SENTINEL_BODY_TEXT_77b0';
  const INSTRUCTION = 'SENTINEL_CRITERIA_TEXT_c3f1';
  const built = buildRerankQuestionSet({
    query: QUERY,
    candidates: [
      { ref: 'docs/one.md', title: TITLE, text: BODY },
      { ref: 'docs/two.md', title: TITLE, text: BODY },
      { ref: 'docs/three.md', title: TITLE, text: '' },
    ],
    params: PARAMS, arm: 'choice', criteria: { choiceInstruction: INSTRUCTION }, limits: LIMITS,
  });
  // The sentinels do reach the question set (that is the call to the model) ...
  const asked = JSON.stringify(built.questionSet);
  for (const sentinel of [QUERY, TITLE, BODY, INSTRUCTION]) assert.ok(asked.includes(sentinel), sentinel);

  const interpreted = interpretRerankAnswers(
    [{ name: 'rerank', type: 'choice', pick: 'B', probabilities: { A: 0.2, B: 0.5, C: 0.3 }, text: BODY }], built.labels, 'choice');
  const payload = rerankPayload({
    arm: built.arm, labels: built.labels, refs: built.refs, order: interpreted.order, truncated: built.truncated,
    params: PARAMS, firstStageMs: 7, criteriaDigest: '3f9a1c0b27de',
    // Text smuggled through any extra or misused field must not be copied either.
    query: QUERY, candidates: built.questionSet, criteria: { choiceInstruction: INSTRUCTION }, state: built.questionSet.state,
  } as any);
  // ... and never the record.
  const recorded = JSON.stringify(payload);
  for (const sentinel of [QUERY, TITLE, BODY, INSTRUCTION, 'query:', '(no text)']) {
    assert.equal(recorded.includes(sentinel), false, sentinel);
  }
  assert.deepEqual(Object.keys(payload).sort(), [
    'arm', 'candidateBytes', 'criteriaDigest', 'firstStageMs', 'n', 'order', 'refs', 'top1Changed', 'truncated',
  ]);
  // A criteria digest that is text rather than 12 hex characters is dropped.
  assert.equal(rerankPayload({ arm: 'choice', labels: ['A', 'B'], refs: ['a', 'b'], order: ['A', 'B'], criteriaDigest: INSTRUCTION }).criteriaDigest, null);
});
