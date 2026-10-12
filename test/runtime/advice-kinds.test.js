'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry');
const { materializeKind, validateQuestionSet, validateStaticAnswer } = require('../../src/runtime/advice/kinds.ts');

const REPO = path.resolve(__dirname, '../..');
const ADVICE = loadAdviceRegistry({ repoRoot: REPO }).registry;
const SOURCES = {
  workflows: JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/workflows.json'), 'utf8')),
  verification: JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/verification.json'), 'utf8')),
  mcp: JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/mcp.json'), 'utf8')),
};

function materialize(id, overrides = {}) {
  return materializeKind(id, { adviceRegistry: ADVICE, sources: SOURCES, ...overrides });
}
function choice(name = 'one', options = { a: 'A', b: 'B' }) {
  return { name, type: 'choice', instructions: 'Choose one.', options };
}

test('score criteria preserve order and obey distinct nonempty string bounds', () => {
  const validate = (criteria) => validateQuestionSet({ state: 'x', questions: [{ name: 'impact', type: 'score', instructions: 'Assess impact.', criteria }] }, { adviceRegistry: ADVICE });
  for (const count of [2, 26]) {
    const criteria = Array.from({ length: count }, (_, index) => `Criterion ${index}`);
    assert.equal(validate(criteria).ok, true);
    assert.deepEqual(validate(criteria).questionSet.questions[0].criteria, criteria);
  }
  for (const criteria of [undefined, {}, 'Low', [], ['Low'], Array.from({ length: 27 }, (_, index) => `Level ${index}`), ['Low', 'Low'], ['Low', ' '], ['Low', 2], ['Low', null], new Array(2)]) {
    assert.equal(validate(criteria).ok, false, JSON.stringify(criteria));
  }
  const question = { type: 'score', criteria: ['Low', 'High'] };
  assert.equal(validateStaticAnswer(question, 'High').ok, true);
  for (const value of [1, '1', 'high', ' High']) assert.equal(validateStaticAnswer(question, value).ok, false);
  assert.equal(ADVICE.kinds.length, 6);
  assert.equal(materialize('score').ok, false);
});

 test('IC-004: tier question uses its own registry criteria', () => {
  const result = materialize('tier');
  assert.equal(result.ok, true);
  assert.deepEqual(result.question.options, ADVICE.kinds.find((kind) => kind.id === 'tier').criteria);
  assert.equal(result.question.name, 'tier');
});

test('IC-004: task-class reads class keys and descriptions without hard-coded classes', () => {
  const result = materialize('task-class');
  assert.equal(result.ok, true);
  assert.deepEqual(result.question.options, Object.fromEntries(Object.entries(SOURCES.workflows.classes).map(([id, item]) => [id, item.description])));
  const extended = structuredClone(SOURCES);
  extended.workflows.classes['advice-probe'] = { description: 'A fixture-only class.' };
  const extra = materializeKind('task-class', { adviceRegistry: ADVICE, sources: extended });
  assert.equal(extra.question.options['advice-probe'], 'A fixture-only class.');
});

test('IC-004: verify-risk reads risk level keys and descriptions dynamically', () => {
  const result = materialize('verify-risk');
  assert.equal(result.ok, true);
  assert.deepEqual(result.question.options, Object.fromEntries(Object.entries(SOURCES.verification.riskLevels).map(([id, item]) => [id, item.description])));
});

test('IC-004: mcp-need requires a named server and uses its trigger as instructions', () => {
  const server = SOURCES.mcp.servers[0];
  const result = materialize('mcp-need', { server: server.id });
  assert.equal(result.ok, true);
  assert.equal(result.question.type, 'yesno');
  assert.equal(result.question.instructions, server.trigger);
  assert.equal(result.question.no, ADVICE.kinds.find((kind) => kind.id === 'mcp-need').no);
  assert.equal(result.question.yes, ADVICE.kinds.find((kind) => kind.id === 'mcp-need').yes);
  assert.equal(materialize('mcp-need').reason, 'usage-error');
  assert.equal(materialize('mcp-need', { server: 'missing-server' }).reason, 'usage-error');
  assert.equal(materialize('tier', { server: server.id }).reason, 'usage-error');
  const extended = structuredClone(SOURCES);
  extended.mcp.servers.push({ id: 'advice-probe', trigger: 'A fixture-only trigger.' });
  const extra = materializeKind('mcp-need', { adviceRegistry: ADVICE, sources: extended, server: 'advice-probe' });
  assert.equal(extra.question.instructions, 'A fixture-only trigger.');
});

test('IC-004: both other own-criteria kinds use the registry text', () => {
  for (const id of ['review-depth', 'followup-triage']) {
    const result = materialize(id);
    assert.equal(result.ok, true);
    assert.deepEqual(result.question.options, ADVICE.kinds.find((kind) => kind.id === id).criteria);
  }
});

test('IC-004: a criteria source below minOptions makes only that kind unavailable', () => {
  const sources = structuredClone(SOURCES);
  sources.workflows.classes = { only: { description: 'One class.' } };
  const result = materializeKind('task-class', { adviceRegistry: ADVICE, sources });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'config-invalid');
  assert.match(result.detail, /limits\.minOptions/);
  assert.equal(materializeKind('review-depth', { adviceRegistry: ADVICE, sources }).ok, true);
});

test('IC-004: a criteria source above maxOptions makes only that kind unavailable', () => {
  const sources = structuredClone(SOURCES);
  sources.workflows.classes = Object.fromEntries(Array.from({ length: 27 }, (_, index) => [`class-${index}`, { description: `Class ${index}.` }]));
  const result = materializeKind('task-class', { adviceRegistry: ADVICE, sources });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'config-invalid');
  assert.match(result.detail, /limits\.maxOptions/);
  assert.equal(materializeKind('review-depth', { adviceRegistry: ADVICE, sources }).ok, true);
});

test('IC-005: ad hoc question sets accept one valid choice and yesno', () => {
  const set = { state: 'A task.', questions: [choice(), { name: 'ready', type: 'yesno', instructions: 'Ready?', no: 'No', yes: 'Yes' }] };
  const result = validateQuestionSet(set, { adviceRegistry: ADVICE });
  assert.equal(result.ok, true);
  assert.deepEqual(result.questionSet, set);
  const invalidState = validateQuestionSet({ ...set, state: 7 }, { adviceRegistry: ADVICE });
  assert.equal(invalidState.ok, false);
  assert.match(invalidState.detail, /state must be a string/);
});

test('IC-005: ad hoc question count is bounded by advice.json minQuestions and maxQuestions', () => {
  for (const [questions, key] of [[[], 'limits.minQuestions'], [Array.from({ length: 65 }, (_, index) => choice(`q${index}`)), 'limits.maxQuestions']]) {
    const result = validateQuestionSet({ state: 'x', questions }, { adviceRegistry: ADVICE });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'config-invalid');
    assert.ok(result.detail.includes(key));
  }
});

test('IC-005: ad hoc names must match questionName and be unique', () => {
  for (const [questions, key] of [
    [[choice('Bad Name')], 'limits.questionName'],
    [[choice('same'), choice('same')], 'limits.questionName'],
  ]) {
    const result = validateQuestionSet({ state: 'x', questions }, { adviceRegistry: ADVICE });
    assert.equal(result.ok, false);
    assert.ok(result.detail.includes(key));
  }
});

test('IC-005: choice option count is bounded by minOptions and maxOptions', () => {
  for (const [options, key] of [[{ a: 'A' }, 'limits.minOptions'], [Object.fromEntries(Array.from({ length: 27 }, (_, index) => [`o${index}`, `Option ${index}`])), 'limits.maxOptions']]) {
    const result = validateQuestionSet({ state: 'x', questions: [choice('options', options)] }, { adviceRegistry: ADVICE });
    assert.equal(result.ok, false);
    assert.ok(result.detail.includes(key));
  }
});

test('IC-005: both yesno texts are required and failures name advice.json', () => {
  for (const question of [
    { name: 'ready', type: 'yesno', instructions: 'Ready?', yes: 'Yes' },
    { name: 'ready', type: 'yesno', instructions: 'Ready?', no: 'No' },
  ]) {
    const result = validateQuestionSet({ state: 'x', questions: [question] }, { adviceRegistry: ADVICE });
    assert.equal(result.ok, false);
    assert.ok(result.detail.includes('advice.json'));
  }
});

test('IC-005: static answer must be one of the question options', () => {
  const question = choice('task-class', { feature: 'Feature', bug: 'Bug' });
  assert.deepEqual(validateStaticAnswer(question, 'bug'), { ok: true });
  const invalid = validateStaticAnswer(question, 'unknown');
  assert.equal(invalid.ok, false);
  assert.match(invalid.detail, /feature.*bug/);
});
