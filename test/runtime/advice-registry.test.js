'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry');

const REPO = path.resolve(__dirname, '../..');
const MODELS = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/models.json'), 'utf8'));
const EXPECTED_LIMITS = {
  maxStateBytes: 49152, maxBodyBytes: 61440, minQuestions: 1, maxQuestions: 64,
  minOptions: 2, maxOptions: 26, questionName: '^[a-z][a-z0-9_-]{0,63}$',
};
const EXPECTED_STRENGTH = {
  choice: { clearAt: 0.8, splitWithin: 0.2 },
  yesno: { clearAbove: 0.85, clearBelow: 0.15, splitFrom: 0.35, splitTo: 0.65 },
};

function validRegistry() {
  return JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/advice.json'), 'utf8'));
}

function writeFixture(t, mutate = () => {}) {
  const registry = validRegistry();
  mutate(registry);
  const dir = tempDir(t, 'doflow-advice-registry-');
  const file = path.join(dir, 'advice.json');
  fs.writeFileSync(file, JSON.stringify(registry));
  return { repoRoot: REPO, file };
}

function expectInvalid(t, key, mutate) {
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
  assert.equal(registry.timeoutMs, 5000);
  assert.equal(registry.probeTimeoutMs, 1500);
  assert.equal(registry.doctorBudgetMs, 6000);
  assert.deepEqual(registry.limits, EXPECTED_LIMITS);
  assert.deepEqual(registry.strength, EXPECTED_STRENGTH);
  assert.deepEqual(registry.providers, [{
    id: 'ollama', adapter: 'ollama-systemone', modelProvider: 'ollama',
    defaultEndpoint: 'http://127.0.0.1:11434', route: '/v1/systemone',
    minVersion: '0.35.1', capability: 'decision',
  }]);
  assert.deepEqual(registry.kinds.map((kind) => kind.id), [
    'tier', 'task-class', 'verify-risk', 'review-depth', 'mcp-need', 'followup-triage',
  ]);
  assert.deepEqual(Object.keys(registry.kinds[0].criteria), MODELS.dispatchTiers.tiers);
  assert.deepEqual(Object.keys(MODELS.providers).length > 0, true);
});

expectInvalid('timeoutMs', 'timeoutMs', (r) => { r.timeoutMs = 99; });
expectInvalid('probeTimeoutMs', 'probeTimeoutMs', (r) => { r.probeTimeoutMs = 30001; });
expectInvalid('positive integer limits', 'limits.minQuestions', (r) => { r.limits.minQuestions = 0; });
expectInvalid('min greater than max', 'limits.minQuestions', (r) => { r.limits.minQuestions = 65; });
expectInvalid('body ceiling', 'limits.maxBodyBytes', (r) => { r.limits.maxBodyBytes = 65536; });
expectInvalid('option ceiling', 'limits.maxOptions', (r) => { r.limits.maxOptions = 27; });
expectInvalid('strength bands', 'strength.yesno', (r) => { r.strength.yesno.splitFrom = 0.7; });
expectInvalid('missing adapter file', 'providers[0].adapter', (r) => { r.providers[0].adapter = 'missing-adapter'; });
expectInvalid('unknown model provider', 'providers[0].modelProvider', (r) => { r.providers[0].modelProvider = 'missing-provider'; });
expectInvalid('tier criteria keys', 'kinds.tier.criteria', (r) => { r.kinds[0].criteria = { ...r.kinds[0].criteria, extra: 'not a tier' }; });

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
