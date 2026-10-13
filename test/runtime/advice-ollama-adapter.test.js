'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const adapter = require('../../src/runtime/advice/providers/ollama-systemone.ts');

const choiceSet = {
  state: 'A short task state.',
  questions: [{ name: 'tier', type: 'choice', instructions: 'Choose a tier.', options: { light: 'Small', standard: 'Normal' } }],
};
const yesNoSet = {
  state: 'A stage state.',
  questions: [{ name: 'needs', type: 'yesno', instructions: 'Is the trigger due?', no: 'Not due', yes: 'Due' }],
};

function body(value) { return JSON.stringify(value); }

const scoreSet = { state: 'Impact assessment.', questions: [{ name: 'impact', type: 'score', instructions: 'Assess impact.', criteria: ['Low', 'Medium', 'High'] }] };
function scoreReply(overrides = {}) {
  return { type: 'score', score: 1.15, legend: { 0: 'Low', 1: 'Medium', 2: 'High' }, probabilities: { 0: 0.25, 1: 0.35, 2: 0.4 }, confidence: 0.7, ...overrides };
}
function parseScore(value) { return adapter.parseReply(200, body({ answers: { impact: value } }), scoreSet); }

test('score request sends an ordered criteria array and reply separates fractional score from argmax', () => {
  assert.deepEqual(adapter.buildRequest(scoreSet, { model: 'clef-flash' }).body.questions.impact, { type: 'score', instructions: 'Assess impact.', criteria: ['Low', 'Medium', 'High'] });
  assert.deepEqual(parseScore(scoreReply()), { ok: true, answers: [{ name: 'impact', type: 'score', criteria: ['Low', 'Medium', 'High'], pickIndex: 2, pick: 'High', score: 1.15, probabilities: { 0: 0.25, 1: 0.35, 2: 0.4 }, confidence: 0.7 }] });
  const tied = parseScore(scoreReply({ score: 0.5, probabilities: { 0: 0.5, 1: 0.5, 2: 0 } }));
  assert.equal(tied.answers[0].pickIndex, 0);
  assert.equal(tied.answers[0].pick, 'Low');
});

test('score reply refuses malformed type, exact index keys, legend, finite bounds and distributions', () => {
  const invalid = [
    { type: undefined }, { type: 'choice' }, { score: undefined }, { score: '1.15' }, { score: -0.1 }, { score: 2.1 }, { score: Infinity },
    { confidence: null }, { confidence: '0.7' }, { confidence: -0.1 }, { confidence: 1.1 }, { confidence: NaN },
    { legend: null }, { legend: ['Low', 'Medium', 'High'] }, { legend: { 0: 'Low', 1: 'Medium' } },
    { legend: { 0: 'Low', 1: 'Medium', 2: 'Wrong' } }, { legend: { 0: 'Low', 1: 'Medium', 2: 'High', 3: 'Extra' } },
    { probabilities: null }, { probabilities: [0.25, 0.35, 0.4] }, { probabilities: { 0: 0.25, 1: 0.35 } },
    { probabilities: { 0: 0.25, 1: 0.35, 2: 0.4, 3: 0 } }, { probabilities: { '00': 0.25, 1: 0.35, 2: 0.4 } },
    { probabilities: { 0: '0.25', 1: 0.35, 2: 0.4 } }, { probabilities: { 0: -0.1, 1: 0.35, 2: 0.4 } },
    { probabilities: { 0: Infinity, 1: 0.35, 2: 0.4 } }, { probabilities: { 0: 1.1, 1: 0.35, 2: 0.4 } },
    { probabilities: { 0: 0.25, 1: 0.35, 2: 0.3 } }, { score: 1 },
  ];
  for (const change of invalid) assert.equal(parseScore(scoreReply(change)).reason, 'malformed-reply', JSON.stringify(change));
});

test('score distribution and weighted score allow only 1e-6 tolerance and inclusive numeric bounds', () => {
  assert.equal(parseScore(scoreReply({ score: 1.15 + 0.5e-6 })).ok, true);
  assert.equal(parseScore(scoreReply({ score: 1.15 + 2e-6 })).ok, false);
  assert.equal(parseScore(scoreReply({ probabilities: { 0: 0.25 + 0.5e-6, 1: 0.35, 2: 0.4 } })).ok, true);
  assert.equal(parseScore(scoreReply({ probabilities: { 0: 0.25 + 2e-6, 1: 0.35, 2: 0.4 } })).ok, false);
  for (const index of [0, 2]) {
    const probabilities = { 0: 0, 1: 0, 2: 0 };
    probabilities[index] = 1;
    assert.equal(parseScore(scoreReply({ score: index, probabilities, confidence: index === 0 ? 0 : 1 })).ok, true);
  }
});

test('IC-006: choice request maps neutral options to systemone criteria without extra fields', () => {
  const request = adapter.buildRequest(choiceSet, { model: 'clef-flash' });
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/systemone');
  assert.deepEqual(request.body, {
    model: 'clef-flash', state: choiceSet.state,
    questions: { tier: { type: 'choice', instructions: 'Choose a tier.', criteria: { light: 'Small', standard: 'Normal' } } },
  });
  assert.equal(Object.hasOwn(request.body, 'keep_alive'), false);
  assert.equal(Object.hasOwn(request.body, 'images'), false);
});

test('IC-006: yesno request maps to noul false/true criteria', () => {
  assert.deepEqual(adapter.buildRequest(yesNoSet, { model: 'nimble' }).body, {
    model: 'nimble', state: yesNoSet.state,
    questions: { needs: { type: 'noul', instructions: 'Is the trigger due?', criteria: { false: 'Not due', true: 'Due' } } },
  });
});

test('IC-006: a valid choice reply becomes a provider-neutral answer', () => {
  const probabilities = { light: 0.1, standard: 0.85 };
  const parsed = adapter.parseReply(200, body({ answers: { tier: { choice: 'standard', probabilities, confidence: 0.71 } } }), choiceSet);
  assert.deepEqual(parsed, { ok: true, answers: [{ name: 'tier', type: 'choice', pick: 'standard', probabilities, confidence: 0.71 }] });
});

test('IC-006: yesno maps noul probability to yes/no probabilities without confidence', () => {
  const parsed = adapter.parseReply(200, body({ answers: { needs: { noul: 0.7 } } }), yesNoSet);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.answers[0].pick, 'yes');
  assert.equal(parsed.answers[0].probabilities.yes, 0.7);
  assert.ok(Math.abs(parsed.answers[0].probabilities.no - 0.3) < 1e-12);
  assert.equal(parsed.answers[0].confidence, null);
  const no = adapter.parseReply(200, body({ answers: { needs: { noul: 0.2 } } }), yesNoSet);
  assert.equal(no.answers[0].pick, 'no');
  assert.ok(Math.abs(no.answers[0].probabilities.no - 0.8) < 1e-12);
  assert.equal(no.answers[0].probabilities.yes, 0.2);
  assert.equal(no.answers[0].confidence, null);
});

test('IC-006: missing answers, out-of-options picks and non-numeric probabilities are malformed', () => {
  assert.deepEqual(adapter.parseReply(200, body({ answers: {} }), choiceSet), { ok: false, reason: 'malformed-reply', detail: 'answer missing for question tier' });
  assert.deepEqual(adapter.parseReply(200, body({ answers: { tier: { choice: 'frontier', probabilities: { light: 0.2, standard: 0.8 }, confidence: 0.5 } } }), choiceSet), { ok: false, reason: 'malformed-reply', detail: 'choice for question tier is outside its options' });
  assert.deepEqual(adapter.parseReply(200, body({ answers: { tier: { choice: 'standard', probabilities: { light: 'low', standard: 0.8 }, confidence: 0.5 } } }), choiceSet), { ok: false, reason: 'malformed-reply', detail: 'probability for tier.light is not a number from 0 to 1' });
});

test('IC-006: status mapping handles 400, both 404 forms, 413 and 500', () => {
  assert.deepEqual(adapter.parseReply(400, body({ error: 'invalid request' }), choiceSet), { ok: false, reason: 'endpoint-rejected', detail: 'invalid request' });
  assert.deepEqual(adapter.parseReply(404, body({ error: 'model not found' }), choiceSet), { ok: false, reason: 'model-missing', detail: 'model not found' });
  assert.deepEqual(adapter.parseReply(404, 'not json', choiceSet), { ok: false, reason: 'endpoint-missing', detail: 'decision endpoint is missing' });
  assert.deepEqual(adapter.parseReply(413, '', choiceSet), { ok: false, reason: 'over-limit', detail: 'request exceeds the server limit' });
  assert.deepEqual(adapter.parseReply(500, '', choiceSet), { ok: false, reason: 'server-error', detail: 'Ollama returned HTTP 500' });
});

test('IC-006: version, tags and show requests/parsers match Ollama read routes', () => {
  assert.deepEqual(adapter.versionRequest(), { method: 'GET', path: '/api/version' });
  assert.deepEqual(adapter.parseVersion(200, body({ version: '0.40.2' })), { version: '0.40.2' });
  assert.equal(adapter.parseVersion(500, body({ version: '0.40.2' })), null);
  assert.deepEqual(adapter.listRequest(), { method: 'GET', path: '/api/tags' });
  assert.deepEqual(adapter.parseList(200, body({ models: [
    { name: 'clef-flash:latest', capabilities: ['completion', 'decision'] },
    { name: 'nimble:latest' },
  ] })), [
    { name: 'clef-flash:latest', capabilities: ['completion', 'decision'] },
    { name: 'nimble:latest', capabilities: null },
  ]);
  assert.deepEqual(adapter.showRequest('nimble:latest'), { method: 'POST', path: '/api/show', body: { model: 'nimble:latest' } });
  assert.deepEqual(adapter.parseShow(200, body({ capabilities: ['decision'] })), { capabilities: ['decision'] });
  assert.equal(adapter.parseShow(500, body({ capabilities: ['decision'] })), null);
});

test('IC-006: an untagged configured model matches its listed :latest tag only', () => {
  assert.equal(adapter.modelMatches('clef-flash', 'clef-flash:latest'), true);
  assert.equal(adapter.modelMatches('clef-flash', 'clef-flash:8b'), false);
  assert.equal(adapter.modelMatches('clef-flash:latest', 'clef-flash'), false);
});

test('IC-018 rule 4: the provider declares no write or server-start route', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/runtime/advice/providers/ollama-systemone.ts'), 'utf8');
  for (const forbidden of ['/api/pull', '/api/push', '/api/create', '/api/copy', '/api/delete', 'ollama serve']) {
    assert.equal(source.includes(forbidden), false, `provider source contains ${forbidden}`);
  }
});
