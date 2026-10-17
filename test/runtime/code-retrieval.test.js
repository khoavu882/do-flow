'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { admitCodeCorpus } = require('../../src/runtime/knowledge/code-corpus.ts');
const { searchCodeLexical } = require('../../src/runtime/knowledge/code-lexical.ts');
const { executeCodeRetrieval } = require('../../src/runtime/knowledge/code-retrieval.ts');
const { handleRetrievalPlanCommand } = require('../../src/runtime/retrieval-plan.ts');
const { readPlan } = require('../../src/runtime/retrieval-record.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const router = { capabilities: {
  'code.exact-search': { providers: [{ id: 'native.rg' }] },
  'code.semantic-search': { providers: [{ id: 'semble.search' }, { id: 'native.rg' }] },
} };

function fixture(t) {
  const root = tempDir(t, 'doflow-code-retrieval-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/auth.js'), 'function parseToken(value) {\n  return refreshCredentials(value);\n}\n');
  const inventory = admitCodeCorpus({ root, files: ['src/auth.js'] });
  return { root, inventory };
}

function declare(root, taskId, need) {
  const log = console.log; console.log = () => {};
  try { return handleRetrievalPlanCommand({ taskId, action: 'declare', need, repoRoot: REPO_ROOT, stateRoot: root, json: true }); }
  finally { console.log = log; }
}

test('exact query is deterministic, live validated and never invokes Semble', async (t) => {
  const f = fixture(t); let semanticCalls = 0;
  const result = await executeCodeRetrieval({ query: 'parseToken', root: f.root, profile: 'hybrid', providers: {
    router, inventory: f.inventory,
    semanticQuery: async () => { semanticCalls += 1; throw new Error('exact query must not invoke Semble'); },
  } });
  assert.equal(result.exit, 0);
  assert.equal(result.response.queryClass, 'exact');
  assert.equal(result.response.effectiveProfile, 'lexical-only');
  assert.equal(semanticCalls, 0);
  assert.equal(result.response.results.length, 1);
  assert.deepEqual(result.response.results[0].locator, { file: 'src/auth.js', line: 1, endLine: 1 });
  assert.equal(result.response.absenceEstablished, false);
});

test('conceptual hybrid provider fault is preserved and followed by a distinct lexical fallback', async (t) => {
  const f = fixture(t); let lexicalCalls = 0;
  const result = await executeCodeRetrieval({ query: 'refresh user credentials', root: f.root, profile: 'hybrid', modelPath: '/fake/model', providers: {
    router, inventory: f.inventory,
    lexicalSearch: (options) => { lexicalCalls += 1; return searchCodeLexical(options); },
    semanticQuery: async () => ({ ok: false, reason: 'provider-unavailable', freshness: 'UNKNOWN', candidates: [] }),
  } });
  assert.equal(result.exit, 0);
  assert.equal(result.response.queryClass, 'conceptual');
  assert.equal(result.response.effectiveProfile, 'lexical-only');
  assert.equal(lexicalCalls, 2);
  assert.deepEqual(result.response.attempts.map((a) => a.provider), ['native.rg', 'semble.search', 'native.rg']);
  assert.notEqual(result.response.attempts[0].retrievalAttemptId, result.response.attempts[2].retrievalAttemptId);
  assert.equal(result.response.gaps[0].reason, 'provider-unavailable');
  assert.ok(result.response.results.length > 0);
  const lexicalOrigins = result.response.results[0].origins.filter((origin) => origin.provider === 'native.rg');
  assert.equal(lexicalOrigins.length, 2, 'same provider keeps both attempt origins without a second rank vote');
  assert.equal(result.response.absenceEstablished, false);
});

test('task binding is rejected before corpus/provider work and ad hoc calls stay unbound', async (t) => {
  const f = fixture(t); let calls = 0;
  const invalid = await executeCodeRetrieval({ query: 'parseToken', root: f.root, taskId: 'no-plan', need: 'missing', providers: {
    router, inventory: f.inventory, lexicalSearch: () => { calls += 1; return { candidates: [], complete: true }; },
  } });
  assert.equal(invalid.exit, 2);
  assert.equal(calls, 0);
  const adhoc = await executeCodeRetrieval({ query: 'parseToken', root: f.root, providers: { router, inventory: f.inventory } });
  assert.equal(adhoc.exit, 0);
  assert.equal(adhoc.response.queryRef, null);
  assert.equal(adhoc.response.activeTaskAttemptRef, null);
  assert.equal(fs.existsSync(path.join(f.root, '.doflow', 'state', 'evidence')), false);
});

test('declared need capability is checked before provider execution', async (t) => {
  const f = fixture(t); const taskId = 't-capability-mismatch';
  const declared = declare(f.root, taskId, 'locate-concept');
  assert.equal(declared, 0);
  let calls = 0;
  const result = await executeCodeRetrieval({ query: 'parseToken', root: f.root, taskId, need: 'locate-concept', providers: {
    router, inventory: f.inventory, lexicalSearch: () => { calls += 1; return { candidates: [], complete: true }; },
  } });
  assert.equal(result.exit, 2);
  assert.equal(result.response.error, 'capability-mismatch');
  assert.equal(calls, 0);
});

test('semantic failure is appended to the existing retrieval plan with its original provider identity', async (t) => {
  const f = fixture(t); const taskId = 't-semantic-fault';
  assert.equal(declare(f.root, taskId, 'locate-concept'), 0);
  const result = await executeCodeRetrieval({ query: 'refresh user credentials', root: f.root, taskId, need: 'locate-concept', profile: 'hybrid', modelPath: '/fake/model', providers: {
    router, inventory: f.inventory,
    semanticQuery: async () => ({ ok: false, reason: 'provider-error', freshness: 'STALE', candidates: [] }),
  } });
  assert.equal(result.exit, 0);
  const attempts = readPlan(f.root, taskId).needs[0].attempts;
  const semantic = attempts.find((attempt) => attempt.provider === 'semble.search');
  assert.ok(semantic);
  assert.equal(semantic.status, 'UNREACHED');
  assert.equal(semantic.reason, 'policy-bypass');
  assert.equal(semantic.indexState, 'STALE');
  assert.equal(result.response.attempts.find((a) => a.provider === 'semble.search').recordedAttempt.n, semantic.n);
});

test('explicit index action calls lifecycle only and rejects simultaneous query', async (t) => {
  const f = fixture(t); let calls = 0;
  const providers = { router, inventory: f.inventory, lifecycle: async ({ action, modelPath }) => {
    calls += 1; assert.equal(action, 'build'); assert.equal(modelPath, '/fake/model');
    return { ok: true, action, complete: true, generation: 'g1' };
  } };
  const result = await executeCodeRetrieval({ root: f.root, scope: 'code', indexAction: 'build', modelPath: '/fake/model', providers });
  assert.equal(result.exit, 0);
  assert.equal(result.response.complete, true);
  assert.equal(calls, 1);
  const invalid = await executeCodeRetrieval({ root: f.root, query: 'parseToken', indexAction: 'refresh', modelPath: '/fake/model', providers });
  assert.equal(invalid.exit, 2);
  assert.equal(calls, 1);
});

test('a lexical bound hit is reported with its bounds cause, never as provider-error', async (t) => {
  const root = fs.realpathSync(require('../helper/tmp').tempDir(t, 'doflow-code-retrieval-bound-'));
  fs.writeFileSync(path.join(root, 'many.js'), Array.from({ length: 205 }, (_, i) => `parseToken(${i});`).join('\n') + '\n');
  const inventory = admitCodeCorpus({ root, files: ['many.js'] });
  const result = await executeCodeRetrieval({ query: 'parseToken', root, providers: { router, inventory } });
  assert.equal(result.exit, 0);
  assert.equal(result.response.attempts[0].reason, 'candidate-limit');
  assert.deepEqual(result.response.gaps.filter((g) => g.source === 'lexical'), [{ provider: 'native.rg', reason: 'candidate-limit', source: 'lexical' }]);
  assert.equal(JSON.stringify(result.response).includes('provider-error'), false);
  assert.equal(result.response.coverage.complete, false, 'a bound still leaves coverage partial');
  assert.ok(result.response.results.length > 0);
});

test('bounds cause control: real lexical faults stay provider-error, deadlines stay timeouts, on both lexical paths', async (t) => {
  const { lexicalOutcome } = require('../../src/runtime/knowledge/code-retrieval.ts');
  const out = (...reasons) => lexicalOutcome({ complete: false, rejections: reasons.map((reason) => ({ reason })) });
  assert.deepEqual(lexicalOutcome({ complete: true, rejections: [] }), { failure: null, bound: null });
  assert.deepEqual(out('output-byte-limit'), { failure: null, bound: 'output-byte-limit' });
  assert.deepEqual(out('read-byte-limit', 'candidate-limit'), { failure: null, bound: 'read-byte-limit' });
  assert.deepEqual(out('symlink'), { failure: 'provider-error', bound: null });
  assert.deepEqual(out('candidate-limit', 'source-changed'), { failure: 'provider-error', bound: null }, 'a fault beside a bound is still a fault');
  assert.deepEqual(out('candidate-limit', 'deadline'), { failure: 'provider-timeout', bound: null });
  assert.deepEqual(out(), { failure: 'provider-error', bound: null });
  const f = fixture(t);
  const faulty = () => ({ candidates: [], complete: false, rejections: [{ reason: 'not-regular-file' }], accounting: {}, coverage: { complete: false } });
  const result = await executeCodeRetrieval({ query: 'refresh user credentials', root: f.root, profile: 'hybrid', modelPath: '/fake/model', providers: {
    router, inventory: f.inventory, lexicalSearch: faulty,
    semanticQuery: async () => ({ ok: false, reason: 'provider-unavailable', freshness: 'UNKNOWN', candidates: [] }) } });
  assert.deepEqual(result.response.attempts.map((a) => a.reason), ['provider-error', 'provider-unavailable', 'provider-error']);
  assert.deepEqual(result.response.gaps.map((g) => `${g.source}:${g.reason}`), ['lexical:provider-error', 'semantic:provider-unavailable', 'fallback:provider-error']);
});
