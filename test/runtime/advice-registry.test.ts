'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
const { buildPackage } = require('../../src/release/build-package.ts');

const REPO = path.resolve(__dirname, '../..');
const MODELS = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/models.json'), 'utf8'));
const EXPECTED_LIMITS: any = {
  maxStateBytes: 49152, maxBodyBytes: 61440, minQuestions: 1, maxQuestions: 64,
  minOptions: 2, maxOptions: 26, questionName: '^[a-z][a-z0-9_-]{0,63}$',
};
const EXPECTED_STRENGTH: any = {
  choice: { clearAt: 0.8, splitWithin: 0.2 },
  yesno: { clearAbove: 0.85, clearBelow: 0.15, splitFrom: 0.35, splitTo: 0.65 },
};

function validRegistry() {
  return JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/advice.json'), 'utf8'));
}

function writeFixture(t: any, mutate: any = () => {}) {
  const registry = validRegistry();
  mutate(registry);
  const dir = tempDir(t, 'doflow-advice-registry-');
  const file = path.join(dir, 'advice.json');
  fs.writeFileSync(file, JSON.stringify(registry));
  return { repoRoot: REPO, file };
}

function expectInvalid(t: any, key: any, mutate: any) {
  test(`IC-003 rejects ${key}`, (ctx) => {
    const result = loadAdviceRegistry(writeFixture(ctx, mutate));
    assert.deepEqual(result.ok, false);
    assert.equal(result.reason, 'config-invalid');
    assert.equal(typeof result.detail, 'string');
    assert.match(result.detail, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}

test('IC-003: shipped registry loads with the fixed limits, bands, providers and kinds', () => {
  const result = loadAdviceRegistry({ repoRoot: REPO });
  assert.equal(result.ok, true, result.detail);
  const registry = result.registry;
  assert.equal(registry.timeoutMs, 15000);
  assert.equal(registry.probeTimeoutMs, 1500);
  assert.equal(registry.doctorBudgetMs, 6000);
  assert.deepEqual(registry.limits, EXPECTED_LIMITS);
  assert.deepEqual(registry.strength, EXPECTED_STRENGTH);
  assert.deepEqual(registry.providers, [{
    id: 'ollama', adapter: 'ollama-systemone', modelProvider: 'ollama',
    defaultEndpoint: 'http://127.0.0.1:11434', route: '/v1/systemone',
    minVersion: '0.35.1', capability: 'decision',
  }]);
  assert.deepEqual(registry.kinds.map((kind: any) => kind.id), [
    'tier', 'task-class', 'verify-risk', 'review-depth', 'mcp-need', 'followup-triage', 'rerank',
  ]);
  assert.deepEqual(Object.keys(registry.kinds[0].criteria), MODELS.dispatchTiers.tiers);
  assert.deepEqual(Object.keys(MODELS.providers).length > 0, true);
});

expectInvalid('timeoutMs', 'timeoutMs', (r: any) => { r.timeoutMs = 99; });
expectInvalid('probeTimeoutMs', 'probeTimeoutMs', (r: any) => { r.probeTimeoutMs = 30001; });
expectInvalid('positive integer limits', 'limits.minQuestions', (r: any) => { r.limits.minQuestions = 0; });
expectInvalid('min greater than max', 'limits.minQuestions', (r: any) => { r.limits.minQuestions = 65; });
expectInvalid('body ceiling', 'limits.maxBodyBytes', (r: any) => { r.limits.maxBodyBytes = 65536; });
expectInvalid('option ceiling', 'limits.maxOptions', (r: any) => { r.limits.maxOptions = 27; });
expectInvalid('strength bands', 'strength.yesno', (r: any) => { r.strength.yesno.splitFrom = 0.7; });
expectInvalid('missing adapter file', 'providers[0].adapter', (r: any) => { r.providers[0].adapter = 'missing-adapter'; });
expectInvalid('unknown model provider', 'providers[0].modelProvider', (r: any) => { r.providers[0].modelProvider = 'missing-provider'; });
expectInvalid('tier criteria keys', 'kinds.tier.criteria', (r: any) => { r.kinds[0].criteria = { ...r.kinds[0].criteria, extra: 'not a tier' }; });

test('141 IC-001: the shipped gate block carries the proposed illustrative defaults', () => {
  const result = loadAdviceRegistry({ repoRoot: REPO });
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(result.registry.gate, {
    version: 1, illustrative: true, minCases: 30, validShareMin: 0.99,
    quality: { lowerBoundAbove: 0, nonInferiorityDelta: 0.02, confidence: 0.95, resamples: 10000, seed: 20261106 },
    latency: { p95CapMs: { default: 5000, rerank: 3000 }, ratioMax: 2 },
  });
});

test('141 IC-001: a registry with no gate block still loads, and exposes no gate (every verdict reads as stale)', (t) => {
  const result = loadAdviceRegistry(writeFixture(t, (r: any) => { delete r.gate; }));
  assert.equal(result.ok, true, result.detail);
  assert.equal(Object.hasOwn(result.registry, 'gate'), false);
});

expectInvalid('gate that is not an object', 'gate', (r: any) => { r.gate = []; });
expectInvalid('gate version', 'gate.version', (r: any) => { r.gate.version = 0; });
expectInvalid('gate illustrative flag', 'gate.illustrative', (r: any) => { r.gate.illustrative = false; });
expectInvalid('gate minCases zero', 'gate.minCases', (r: any) => { r.gate.minCases = 0; });
expectInvalid('gate minCases fraction', 'gate.minCases', (r: any) => { r.gate.minCases = 30.5; });
expectInvalid('gate validShareMin zero', 'gate.validShareMin', (r: any) => { r.gate.validShareMin = 0; });
expectInvalid('gate validShareMin above one', 'gate.validShareMin', (r: any) => { r.gate.validShareMin = 1.01; });
expectInvalid('gate validShareMin string', 'gate.validShareMin', (r: any) => { r.gate.validShareMin = '0.99'; });
expectInvalid('gate quality missing', 'gate.quality', (r: any) => { delete r.gate.quality; });
expectInvalid('gate lowerBoundAbove', 'gate.quality.lowerBoundAbove', (r: any) => { r.gate.quality.lowerBoundAbove = null; });
expectInvalid('gate nonInferiorityDelta negative', 'gate.quality.nonInferiorityDelta', (r: any) => { r.gate.quality.nonInferiorityDelta = -0.01; });
expectInvalid('gate confidence zero', 'gate.quality.confidence', (r: any) => { r.gate.quality.confidence = 0; });
expectInvalid('gate confidence above one', 'gate.quality.confidence', (r: any) => { r.gate.quality.confidence = 95; });
expectInvalid('gate resamples below 1000', 'gate.quality.resamples', (r: any) => { r.gate.quality.resamples = 999; });
expectInvalid('gate seed', 'gate.quality.seed', (r: any) => { r.gate.quality.seed = 1.5; });
expectInvalid('gate latency missing', 'gate.latency', (r: any) => { delete r.gate.latency; });
expectInvalid('gate p95 default missing', 'gate.latency.p95CapMs', (r: any) => { delete r.gate.latency.p95CapMs.default; });
expectInvalid('gate p95 cap not positive', 'gate.latency.p95CapMs', (r: any) => { r.gate.latency.p95CapMs.rerank = 0; });
expectInvalid('gate ratioMax below one', 'gate.latency.ratioMax', (r: any) => { r.gate.latency.ratioMax = 0.5; });

test('141 IC-004: the shipped verdict file is empty in the IC-004 shape', () => {
  const file = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/advice-verdicts.json'), 'utf8'));
  assert.deepEqual(file, { schemaVersion: 1, corpora: {}, verdicts: [] });
});

test('IC-003: missing and unparseable files return the same failure shape without throwing', (t) => {
  const dir = tempDir(t, 'doflow-advice-registry-');
  const missing = loadAdviceRegistry({ repoRoot: REPO, file: path.join(dir, 'missing.json') });
  const badFile = path.join(dir, 'broken.json');
  fs.writeFileSync(badFile, '{ not json');
  const malformed = loadAdviceRegistry({ repoRoot: REPO, file: badFile });
  for (const result of [missing, malformed]) {
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'config-invalid');
    assert.equal(typeof result.detail, 'string');
    assert.ok(result.detail.length > 0);
    assert.deepEqual(Object.keys(result).sort(), ['detail', 'ok', 'reason']);
  }
});

// maint-advise-ext: the packaged tree (npm run build:package) ships every module as .js, so the adapter
// file is found by the extension of the running module, not a fixed `.ts`. Both tests run the BUILT
// registry module against the BUILT tree, the layout a global install has.
function packedRegistryModule(t: any) {
  const root = path.join(tempDir(t, 'doflow-advice-packed-'), 'package');
  buildPackage(root);
  return { root, module: require(path.join(root, 'src/runtime/advice/registry.js')) };
}

test('maint-advise-ext: the shipped registry loads from the packaged (.js) tree', (t) => {
  const packed = packedRegistryModule(t);
  const adapterDir = path.join(packed.root, 'src/runtime/advice/providers');
  assert.deepEqual(fs.readdirSync(adapterDir), ['ollama-systemone.js']);
  const result = packed.module.loadAdviceRegistry();
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.registry.providers[0].adapter, 'ollama-systemone');
});

test('maint-advise-ext: the packaged tree still rejects a missing adapter and an adapter of the other extension', (t) => {
  const packed = packedRegistryModule(t);
  const adapterDir = path.join(packed.root, 'src/runtime/advice/providers');
  const registry = JSON.parse(fs.readFileSync(path.join(packed.root, 'core/registry/advice.json'), 'utf8'));
  const file = path.join(path.dirname(packed.root), 'advice.json');
  const load = (adapter: any) => {
    registry.providers[0].adapter = adapter;
    fs.writeFileSync(file, JSON.stringify(registry));
    return packed.module.loadAdviceRegistry({ file });
  };

  const missing = load('missing-adapter');
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /providers\[0\]\.adapter must name a file under/);

  fs.writeFileSync(path.join(adapterDir, 'other-ext.ts'), '');
  const wrongExtension = load('other-ext');
  assert.equal(wrongExtension.ok, false, 'a .ts adapter is not a loadable module in a .js tree');
  assert.match(wrongExtension.detail, /providers\[0\]\.adapter/);

  const traversal = load('../registry');
  assert.equal(traversal.ok, false);
  assert.match(traversal.detail, /must be a safe adapter id/);
});

// ── 141 IC-001: the rerank kind entry and the call-built kind rules ──────────────────────────────

const rerankOf = (r: any) => r.kinds.find((kind: any) => kind.id === 'rerank');

test('141 IC-001: the shipped rerank kind carries the B.3 numbers, the ladder text and the illustrative thresholds', () => {
  const result = loadAdviceRegistry({ repoRoot: REPO });
  assert.equal(result.ok, true, result.detail);
  const kind = rerankOf(result.registry);
  assert.equal(kind.type, 'choice');
  assert.equal(kind.criteriaFrom, 'call');
  assert.equal(kind.maxMode, 'shadow');
  assert.equal(kind.budgetMs, 5000);
  assert.deepEqual(kind.askedBy, ['retrieve']);
  assert.deepEqual(kind.params, {
    arm: 'choice', minCandidates: 2, maxCandidates: 16, candidateBytes: 800, queryBytes: 2048, criteriaBytes: 1536,
  });
  assert.equal(kind.scoreLadder.criteria.length, 5);
  assert.ok(kind.scoreLadder.instructions.includes('<label>'));
  assert.deepEqual(kind.thresholds, { illustrative: true, confidenceBelow: [0.5, 0.7, 0.9], expectedBelow: [1, 2] });
  assert.match(kind.description, /budgetMs 5000/);
  assert.equal(result.registry.gate.latency.p95CapMs.rerank, 3000, 'the latency bar is not loosened to fit the measurement');
});

expectInvalid('rerank maxMode', 'kinds[6].maxMode', (r: any) => { rerankOf(r).maxMode = 'always'; });
expectInvalid('rerank budgetMs below 100', 'kinds[6].budgetMs', (r: any) => { rerankOf(r).budgetMs = 99; });
expectInvalid('rerank budgetMs above timeoutMs', 'kinds[6].budgetMs', (r: any) => { rerankOf(r).budgetMs = 15001; });
expectInvalid('rerank budgetMs fraction', 'kinds[6].budgetMs', (r: any) => { rerankOf(r).budgetMs = 5000.5; });
expectInvalid('kind description empty', 'kinds[6].description', (r: any) => { rerankOf(r).description = ' '; });
expectInvalid('params without criteriaFrom call or maxMode', 'kinds[0].params', (r: any) => { r.kinds[0].params = { size: 1 }; });
expectInvalid('params value not a positive integer', 'kinds[4].params.size', (r: any) => { r.kinds[4].maxMode = 'shadow'; r.kinds[4].params = { size: 0 }; });
expectInvalid('call kind with a static criteria map', 'kinds[6]', (r: any) => { rerankOf(r).criteria = { a: 'x' }; });
expectInvalid('rerank arm', 'kinds[6].params.arm', (r: any) => { rerankOf(r).params.arm = 'both'; });
expectInvalid('rerank minCandidates below limits.minOptions', 'kinds[6].params.minCandidates', (r: any) => { rerankOf(r).params.minCandidates = 1; });
expectInvalid('rerank maxCandidates above the label alphabet', 'kinds[6].params.maxCandidates', (r: any) => { rerankOf(r).params.maxCandidates = 17; });
expectInvalid('rerank maxCandidates below minCandidates', 'kinds[6].params.minCandidates', (r: any) => { rerankOf(r).params.maxCandidates = 1; rerankOf(r).params.minCandidates = 2; });
expectInvalid('rerank candidateBytes zero', 'kinds[6].params.candidateBytes', (r: any) => { rerankOf(r).params.candidateBytes = 0; });
expectInvalid('rerank queryBytes missing', 'kinds[6].params.queryBytes', (r: any) => { delete rerankOf(r).params.queryBytes; });
expectInvalid('rerank choice-arm body rule', 'maxCandidates * candidateBytes + queryBytes', (r: any) => { rerankOf(r).params.candidateBytes = 1800; });
expectInvalid('rerank ladder-arm body rule', 'maxCandidates * (candidateBytes + criteriaBytes) + queryBytes', (r: any) => { rerankOf(r).params.criteriaBytes = 2000; });
expectInvalid('scoreLadder missing on a call kind with an arm', 'kinds[6].scoreLadder', (r: any) => { delete rerankOf(r).scoreLadder; });
expectInvalid('scoreLadder instructions without <label>', 'kinds[6].scoreLadder.instructions', (r: any) => { rerankOf(r).scoreLadder.instructions = 'Rate it.'; });
expectInvalid('scoreLadder with 4 levels', 'kinds[6].scoreLadder.criteria', (r: any) => { rerankOf(r).scoreLadder.criteria.pop(); });
expectInvalid('scoreLadder with a repeated level', 'kinds[6].scoreLadder.criteria', (r: any) => { rerankOf(r).scoreLadder.criteria[1] = rerankOf(r).scoreLadder.criteria[0]; });
expectInvalid('scoreLadder with an empty level', 'kinds[6].scoreLadder.criteria', (r: any) => { rerankOf(r).scoreLadder.criteria[2] = ' '; });
expectInvalid('scoreLadder over criteriaBytes', 'kinds[6].scoreLadder.criteria', (r: any) => { rerankOf(r).params.criteriaBytes = 100; });
expectInvalid('thresholds not illustrative', 'kinds[6].thresholds.illustrative', (r: any) => { rerankOf(r).thresholds.illustrative = false; });
expectInvalid('thresholds confidence out of range', 'kinds[6].thresholds.confidenceBelow', (r: any) => { rerankOf(r).thresholds.confidenceBelow = [1]; });
expectInvalid('thresholds expected out of range', 'kinds[6].thresholds.expectedBelow', (r: any) => { rerankOf(r).thresholds.expectedBelow = [0]; });
expectInvalid('thresholds list too long', 'kinds[6].thresholds.confidenceBelow', (r: any) => { rerankOf(r).thresholds.confidenceBelow = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]; });

test('141 IC-001: a registry without the rerank kind still loads (no such call is made)', (t) => {
  const result = loadAdviceRegistry(writeFixture(t, (r: any) => { r.kinds = r.kinds.filter((kind: any) => kind.id !== 'rerank'); }));
  assert.equal(result.ok, true, result.detail);
});
