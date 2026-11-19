'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { loadAdviceRegistry, validateAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
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
    'tier', 'task-class', 'verify-risk', 'review-depth', 'mcp-need', 'rerank', 'claim-support', 'instructs-reader', 'same-issue',
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

test('141 IC-001: the shipped rerank kind (offline measurement only) carries the B.3 numbers, the ladder text and the illustrative thresholds', () => {
  const result = loadAdviceRegistry({ repoRoot: REPO });
  assert.equal(result.ok, true, result.detail);
  const kind = rerankOf(result.registry);
  assert.equal(kind.type, 'choice');
  assert.equal(kind.criteriaFrom, 'call');
  assert.equal(kind.budgetMs, 5000);
  assert.deepEqual(kind.askedBy, [], 'nothing asks rerank at run time; bench advice-gate scores it offline');
  assert.deepEqual(kind.params, {
    arm: 'choice', minCandidates: 2, maxCandidates: 16, candidateBytes: 800, queryBytes: 2048, criteriaBytes: 1536,
  });
  assert.equal(kind.scoreLadder.criteria.length, 5);
  assert.ok(kind.scoreLadder.instructions.includes('<label>'));
  assert.deepEqual(kind.thresholds, { illustrative: true, confidenceBelow: [0.5, 0.7, 0.9], expectedBelow: [1, 2] });
  assert.match(kind.description, /Offline measurement only/);
});

expectInvalid('rerank maxMode', 'kinds[5].maxMode', (r: any) => { rerankOf(r).maxMode = 'always'; });
expectInvalid('rerank budgetMs below 100', 'kinds[5].budgetMs', (r: any) => { rerankOf(r).budgetMs = 99; });
expectInvalid('rerank budgetMs above timeoutMs', 'kinds[5].budgetMs', (r: any) => { rerankOf(r).budgetMs = 15001; });
expectInvalid('rerank budgetMs fraction', 'kinds[5].budgetMs', (r: any) => { rerankOf(r).budgetMs = 5000.5; });
expectInvalid('kind description empty', 'kinds[5].description', (r: any) => { rerankOf(r).description = ' '; });
expectInvalid('params without criteriaFrom call or maxMode', 'kinds[0].params', (r: any) => { r.kinds[0].params = { size: 1 }; });
expectInvalid('params value not a positive integer', 'kinds[4].params.size', (r: any) => { r.kinds[4].maxMode = 'shadow'; r.kinds[4].params = { size: 0 }; });
expectInvalid('call kind with a static criteria map', 'kinds[5]', (r: any) => { rerankOf(r).criteria = { a: 'x' }; });
expectInvalid('rerank arm', 'kinds[5].params.arm', (r: any) => { rerankOf(r).params.arm = 'both'; });
expectInvalid('rerank minCandidates below limits.minOptions', 'kinds[5].params.minCandidates', (r: any) => { rerankOf(r).params.minCandidates = 1; });
expectInvalid('rerank maxCandidates above the label alphabet', 'kinds[5].params.maxCandidates', (r: any) => { rerankOf(r).params.maxCandidates = 17; });
expectInvalid('rerank maxCandidates below minCandidates', 'kinds[5].params.minCandidates', (r: any) => { rerankOf(r).params.maxCandidates = 1; rerankOf(r).params.minCandidates = 2; });
expectInvalid('rerank candidateBytes zero', 'kinds[5].params.candidateBytes', (r: any) => { rerankOf(r).params.candidateBytes = 0; });
expectInvalid('rerank queryBytes missing', 'kinds[5].params.queryBytes', (r: any) => { delete rerankOf(r).params.queryBytes; });
expectInvalid('rerank choice-arm body rule', 'maxCandidates * candidateBytes + queryBytes', (r: any) => { rerankOf(r).params.candidateBytes = 1800; });
expectInvalid('rerank ladder-arm body rule', 'maxCandidates * (candidateBytes + criteriaBytes) + queryBytes', (r: any) => { rerankOf(r).params.criteriaBytes = 2000; });
expectInvalid('scoreLadder missing on a call kind with an arm', 'kinds[5].scoreLadder', (r: any) => { delete rerankOf(r).scoreLadder; });
expectInvalid('scoreLadder instructions without <label>', 'kinds[5].scoreLadder.instructions', (r: any) => { rerankOf(r).scoreLadder.instructions = 'Rate it.'; });
expectInvalid('scoreLadder with 4 levels', 'kinds[5].scoreLadder.criteria', (r: any) => { rerankOf(r).scoreLadder.criteria.pop(); });
expectInvalid('scoreLadder with a repeated level', 'kinds[5].scoreLadder.criteria', (r: any) => { rerankOf(r).scoreLadder.criteria[1] = rerankOf(r).scoreLadder.criteria[0]; });
expectInvalid('scoreLadder with an empty level', 'kinds[5].scoreLadder.criteria', (r: any) => { rerankOf(r).scoreLadder.criteria[2] = ' '; });
expectInvalid('scoreLadder over criteriaBytes', 'kinds[5].scoreLadder.criteria', (r: any) => { rerankOf(r).params.criteriaBytes = 100; });
expectInvalid('thresholds not illustrative', 'kinds[5].thresholds.illustrative', (r: any) => { rerankOf(r).thresholds.illustrative = false; });
expectInvalid('thresholds confidence out of range', 'kinds[5].thresholds.confidenceBelow', (r: any) => { rerankOf(r).thresholds.confidenceBelow = [1]; });
expectInvalid('thresholds expected out of range', 'kinds[5].thresholds.expectedBelow', (r: any) => { rerankOf(r).thresholds.expectedBelow = [0]; });
expectInvalid('thresholds list too long', 'kinds[5].thresholds.confidenceBelow', (r: any) => { rerankOf(r).thresholds.confidenceBelow = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]; });

test('141 IC-001: a registry without the rerank kind still loads (no such call is made)', (t) => {
  const result = loadAdviceRegistry(writeFixture(t, (r: any) => { r.kinds = r.kinds.filter((kind: any) => kind.id !== 'rerank'); }));
  assert.equal(result.ok, true, result.detail);
});

// ── 141 IC-001: the claim-support kind entry (D.1) ───────────────────────────────────────────────

const claimOf = (r: any) => r.kinds.find((kind: any) => kind.id === 'claim-support');

test('141 IC-001: the shipped claim-support kind is a shadow-only yes/no kind with its own texts and byte caps', () => {
  const result = loadAdviceRegistry({ repoRoot: REPO });
  assert.equal(result.ok, true, result.detail);
  const kind = claimOf(result.registry);
  assert.equal(kind.type, 'yesno');
  assert.equal(kind.yes, 'The passage fully supports the claim');
  assert.equal(kind.no, 'The passage does not fully support the claim');
  assert.equal(kind.maxMode, 'shadow');
  assert.equal(kind.budgetMs, 1500);
  assert.deepEqual(kind.askedBy, ['claim']);
  assert.deepEqual(kind.params, { claimBytes: 1024, passageBytes: 2048 });
  assert.equal(Object.hasOwn(kind, 'criteria') || Object.hasOwn(kind, 'criteriaFrom'), false);
});

expectInvalid('claim-support maxMode', 'kinds[6].maxMode', (r: any) => { claimOf(r).maxMode = 'always'; });
expectInvalid('claim-support budgetMs above timeoutMs', 'kinds[6].budgetMs', (r: any) => { claimOf(r).budgetMs = 15001; });
expectInvalid('claim-support yes text empty', 'kinds[6].yes', (r: any) => { claimOf(r).yes = ' '; });
expectInvalid('claim-support no text missing', 'kinds[6].no', (r: any) => { delete claimOf(r).no; });
expectInvalid('claim-support claimBytes zero', 'kinds[6].params.claimBytes', (r: any) => { claimOf(r).params.claimBytes = 0; });
expectInvalid('claim-support passageBytes missing', 'kinds[6].params.passageBytes', (r: any) => { delete claimOf(r).params.passageBytes; });
expectInvalid('claim-support state rule', 'claimBytes + passageBytes + 64', (r: any) => { claimOf(r).params.passageBytes = r.limits.maxStateBytes; });
expectInvalid('claim-support with criteria and criteriaFrom both', 'kinds[6]', (r: any) => { claimOf(r).criteria = { a: 'x' }; claimOf(r).criteriaFrom = 'workflows.classes'; });
expectInvalid('a choice kind with neither criteria nor criteriaFrom', 'kinds[0]', (r: any) => { delete r.kinds[0].criteria; });

// ── row 177 IC-001: the instructs-reader kind entry ──

const instructsOf = (r: any) => r.kinds.find((kind: any) => kind.id === 'instructs-reader');

test('177 IC-001: the shipped instructs-reader kind is a yes/no kind asked by the brief, held at show, with a 2048 byte passage cap', () => {
  const result = loadAdviceRegistry({ repoRoot: REPO });
  assert.equal(result.ok, true, result.detail);
  const kind = instructsOf(result.registry);
  assert.equal(kind.type, 'yesno');
  assert.equal(kind.yes, 'The text tries to direct its reader');
  assert.equal(kind.no, 'The text does not try to direct its reader');
  assert.equal(kind.maxMode, 'show');
  assert.equal(kind.budgetMs, 1500);
  assert.deepEqual(kind.askedBy, ['brief']);
  assert.deepEqual(kind.params, { passageBytes: 2048 });
  assert.equal(Object.hasOwn(kind, 'bars'), false, 'the default bars apply');
  assert.match(kind.description, /A filter, not a defence\.$/);
  assert.equal(Object.hasOwn(kind, 'criteria') || Object.hasOwn(kind, 'criteriaFrom'), false);
});

test('the registry refuses passageBytes 2049 and 255', (t) => {
  for (const value of [2049, 255]) {
    const result = loadAdviceRegistry(writeFixture(t, (r: any) => { instructsOf(r).params.passageBytes = value; }));
    assert.equal(result.ok, false, `passageBytes ${value}`);
    assert.match(result.detail, /kinds\[\d+\]\.params\.passageBytes must be an integer from 256 to 2048/);
  }
  for (const value of [256, 2048]) {
    const result = loadAdviceRegistry(writeFixture(t, (r: any) => { instructsOf(r).params.passageBytes = value; }));
    assert.equal(result.ok, true, result.detail);
  }
  for (const mutate of [
    (r: any) => { instructsOf(r).params.passageBytes = 1024.5; },
    (r: any) => { instructsOf(r).params.passageBytes = '2048'; },
    (r: any) => { delete instructsOf(r).params.passageBytes; },
    (r: any) => { instructsOf(r).params.extra = 1; },
  ]) {
    assert.equal(loadAdviceRegistry(writeFixture(t, mutate)).ok, false);
  }
});

// ── row 176 IC-001: the same-issue kind entry ──

const sameIssueOf = (r: any) => r.kinds.find((kind: any) => kind.id === 'same-issue');

test('176 IC-001: the shipped same-issue kind is a compact yes/no kind asked by review and followup, held at show, read from review findings', () => {
  const result = loadAdviceRegistry({ repoRoot: REPO });
  assert.equal(result.ok, true, result.detail);
  const kind = sameIssueOf(result.registry);
  assert.equal(kind.type, 'yesno');
  assert.equal(kind.maxMode, 'show');
  assert.deepEqual(kind.askedBy, ['review', 'followup']);
  assert.deepEqual(kind.replay, { source: 'review-findings' });
  assert.deepEqual(kind.params, {
    itemBytes: 512, questionsPerCall: 8, maxPairs: 32, perItem: 2, candidateAtPct: 15, flagAtPct: 40, locatorBonusPct: 15, maxCompare: 2000,
  });
  assert.equal(Object.hasOwn(kind, 'criteria') || Object.hasOwn(kind, 'criteriaFrom'), false);
  assert.ok(JSON.stringify(kind).length < 1300, 'the entry stays compact');
});

test('176 IC-001: the registry refuses each same-issue bound alone and names the field', (t) => {
  const refused: Array<[string, any, string]> = [
    ['itemBytes', 63, 'itemBytes'], ['itemBytes', 4097, 'itemBytes'], ['itemBytes', 512.5, 'itemBytes'],
    ['questionsPerCall', 0, 'questionsPerCall'], ['questionsPerCall', 17, 'questionsPerCall'],
    ['candidateAtPct', 41, 'candidateAtPct'], ['candidateAtPct', 0, 'candidateAtPct'],
    ['flagAtPct', 101, 'flagAtPct'], ['flagAtPct', 10, 'candidateAtPct'],
    ['locatorBonusPct', 101, 'locatorBonusPct'], ['locatorBonusPct', -1, 'locatorBonusPct'],
    ['maxPairs', 7, 'maxPairs'], ['perItem', 0, 'perItem'], ['maxCompare', 0, 'maxCompare'],
    ['extra', 1, 'extra'],
  ];
  for (const [field, value, named] of refused) {
    const result = loadAdviceRegistry(writeFixture(t, (r: any) => { sameIssueOf(r).params[field] = value; }));
    assert.equal(result.ok, false, `${field} ${value}`);
    assert.match(result.detail, new RegExp(`kinds\\[\\d+\\]\\.params\\.${named}\\b`), `${field} ${value}: ${result.detail}`);
  }
  const missing = loadAdviceRegistry(writeFixture(t, (r: any) => { delete sameIssueOf(r).params.maxCompare; }));
  assert.match(missing.detail, /params\.maxCompare/);
  for (const [field, value] of [['itemBytes', 64], ['itemBytes', 4096 / 16], ['questionsPerCall', 1], ['questionsPerCall', 16], ['flagAtPct', 100], ['locatorBonusPct', 0], ['candidateAtPct', 40], ['maxPairs', 8]] as any[]) {
    const result = loadAdviceRegistry(writeFixture(t, (r: any) => { sameIssueOf(r).params[field] = value; }));
    assert.equal(result.ok, true, `${field} ${value}: ${result.detail}`);
  }
});

test('176 IC-001: the state-size product questionsPerCall x (2 x itemBytes + 64) + 256 must fit limits.maxStateBytes', (t) => {
  const over = loadAdviceRegistry(writeFixture(t, (r: any) => { sameIssueOf(r).params.itemBytes = 4096; }));
  assert.equal(over.ok, false);
  assert.match(over.detail, /kinds\[\d+\]\.params questionsPerCall \* \(2 \* itemBytes \+ 64\) \+ 256 must be at most limits\.maxStateBytes/);
  const fits = loadAdviceRegistry(writeFixture(t, (r: any) => { Object.assign(sameIssueOf(r).params, { itemBytes: 2900, questionsPerCall: 8 }); }));
  assert.equal(fits.ok, true, fits.detail);
});

test('176 IC-001: questionsPerCall on any kind is a positive integer of at most 16', (t) => {
  for (const value of [0, 17, 1.5, '4']) {
    const result = loadAdviceRegistry(writeFixture(t, (r: any) => { claimOf(r).params.questionsPerCall = value; }));
    assert.equal(result.ok, false, String(value));
    assert.match(result.detail, /kinds\[\d+\]\.params\.questionsPerCall/);
  }
  const result = loadAdviceRegistry(writeFixture(t, (r: any) => { claimOf(r).params.questionsPerCall = 16; }));
  assert.equal(result.ok, true, result.detail);
});

test('141 IC-001: a registry without the claim-support kind still loads (no such call is made)', (t) => {
  const result = loadAdviceRegistry(writeFixture(t, (r: any) => { r.kinds = r.kinds.filter((kind: any) => kind.id !== 'claim-support'); }));
  assert.equal(result.ok, true, result.detail);
});

test('row 174: askedBy names the real callers - mcp-need is asked by the do skill, rerank by nothing', () => {
  const result = loadAdviceRegistry({ repoRoot: REPO });
  assert.equal(result.ok, true, result.detail);
  const askedBy = Object.fromEntries(result.registry.kinds.map((kind: any) => [kind.id, kind.askedBy]));
  assert.deepEqual(askedBy['mcp-need'], ['do']);
  assert.deepEqual(askedBy.rerank, []);
});

// ── row 174 O-3: every kind carries its own call budget, and the detached shadow calls share a user-level slot limit ──

test('row 174 O-3: every shipped kind has its budgetMs as data, and timeoutMs is left to a kind-less ask', () => {
  const result = loadAdviceRegistry({ repoRoot: REPO });
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(Object.fromEntries(result.registry.kinds.map((kind: any) => [kind.id, kind.budgetMs])), {
    tier: 1500, 'task-class': 3000, 'verify-risk': 2000, 'review-depth': 1500, 'mcp-need': 1500, rerank: 5000, 'claim-support': 1500, 'instructs-reader': 1500, 'same-issue': 6000,
  });
  assert.equal(result.registry.timeoutMs, 15000);
  assert.match(result.registry.description, /warm measurements with headroom/);
  assert.equal(result.registry.shadowSlots, 4);
});

for (const [index, kind] of validRegistry().kinds.entries()) {
  expectInvalid(`${kind.id} without budgetMs`, `kinds[${index}].budgetMs`, (r: any) => { delete r.kinds[index].budgetMs; });
}
expectInvalid('shadowSlots missing', 'shadowSlots', (r: any) => { delete r.shadowSlots; });
expectInvalid('shadowSlots zero', 'shadowSlots', (r: any) => { r.shadowSlots = 0; });
expectInvalid('shadowSlots fraction', 'shadowSlots', (r: any) => { r.shadowSlots = 1.5; });

// ── row 174 L-2: removedSettings is validated, and no key in it is still declared in settings.json ──

test('row 174 L-2: the shipped removedSettings are five distinct advice. keys, none declared in settings.json', () => {
  const removed: string[] = validRegistry().removedSettings;
  assert.equal(removed.length, 5);
  assert.equal(new Set(removed).size, 5);
  const declared = Object.keys(JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/settings.json'), 'utf8')).keys);
  assert.deepEqual(removed.filter((key) => declared.includes(key)), []);
  const result = loadAdviceRegistry({ repoRoot: REPO });
  assert.equal(result.ok, true, result.detail);
});

expectInvalid('removedSettings missing', 'removedSettings', (r: any) => { delete r.removedSettings; });
expectInvalid('removedSettings not an array', 'removedSettings', (r: any) => { r.removedSettings = 'advice.kinds.rerank'; });
expectInvalid('an empty removedSettings entry', 'removedSettings[1]', (r: any) => { r.removedSettings[1] = ''; });
expectInvalid('a removedSettings entry that is not a string', 'removedSettings[0]', (r: any) => { r.removedSettings[0] = 7; });
expectInvalid('a removedSettings entry outside advice.', 'removedSettings[2]', (r: any) => { r.removedSettings[2] = 'review.depth'; });
expectInvalid('a duplicate removedSettings entry', 'removedSettings[1]', (r: any) => { r.removedSettings[1] = r.removedSettings[0]; });
expectInvalid('a removedSettings entry settings.json still declares', 'removedSettings[0]', (r: any) => { r.removedSettings[0] = 'advice.kinds.tier'; });

test('row 174 L-2: the declared-key check reads the settings registry it is given', () => {
  const registry = validRegistry();
  const key = registry.removedSettings[0];
  const withKey = validateAdviceRegistry(registry, { repoRoot: REPO, settings: { keys: { [key]: {} } } });
  assert.equal(withKey.ok, false);
  assert.match(withKey.errors.join('; '), /removedSettings\[0\] names 'advice\.kinds\.rerank', which core\/registry\/settings\.json still declares/);
  assert.equal(validateAdviceRegistry(registry, { repoRoot: REPO, settings: { keys: {} } }).ok, true);
});

// ── row 175 IC-001: the bars block, kinds[].bars, kinds[].replay and maxMode show ──

const BARS = {
  version: 1,
  statistics: { confidence: 0.95, resamples: 10000, seed: 20261119 },
  show: { minCases: 30, minMinority: 10, kappaLowerAbove: 0, notWorseThanRule: true, p95WithinBudget: true },
  act: { minCases: 100, minMinority: 25, kappaGainLowerAbove: 0, maxWorseShare: 0.02 },
};
const fullBars = () => JSON.parse(JSON.stringify(BARS));
const claimIndex = validRegistry().kinds.findIndex((kind: any) => kind.id === 'claim-support');
const rerankIndex = validRegistry().kinds.findIndex((kind: any) => kind.id === 'rerank');

test('row 175 IC-001 (a): the shipped bars validate and equal the design values; claim-support replays from claim-ledger', () => {
  const result = loadAdviceRegistry({ repoRoot: REPO });
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(result.registry.bars, BARS);
  assert.deepEqual(claimOf(result.registry).replay, { source: 'claim-ledger' });
  assert.equal(Object.hasOwn(rerankOf(result.registry), 'replay'), false);
});

expectInvalid('bars missing', 'bars', (r: any) => { delete r.bars; });
expectInvalid('bars not an object', 'bars', (r: any) => { r.bars = []; });
expectInvalid('bars.version zero', 'bars.version', (r: any) => { r.bars.version = 0; });
expectInvalid('bars.statistics.confidence of 1', 'bars.statistics.confidence', (r: any) => { r.bars.statistics.confidence = 1; });
expectInvalid('bars.statistics.resamples below 1000', 'bars.statistics.resamples', (r: any) => { r.bars.statistics.resamples = 999; });
expectInvalid('bars.statistics.seed fraction', 'bars.statistics.seed', (r: any) => { r.bars.statistics.seed = 1.5; });
expectInvalid('bars.show.minCases zero', 'bars.show.minCases', (r: any) => { r.bars.show.minCases = 0; });
expectInvalid('bars.act.minCases below show.minCases', 'bars.act.minCases', (r: any) => { r.bars.act.minCases = 29; });
expectInvalid('bars.show.minMinority over half of minCases', 'bars.show.minMinority', (r: any) => { r.bars.show.minMinority = 16; });
expectInvalid('bars.act.minMinority over half of minCases', 'bars.act.minMinority', (r: any) => { r.bars.act.minMinority = 51; });
expectInvalid('bars.act.minMinority below show.minMinority', 'bars.act.minMinority', (r: any) => { r.bars.act.minMinority = 9; });
expectInvalid('bars.show.kappaLowerAbove of 1', 'bars.show.kappaLowerAbove', (r: any) => { r.bars.show.kappaLowerAbove = 1; });
expectInvalid('bars.show.notWorseThanRule not a boolean', 'bars.show.notWorseThanRule', (r: any) => { r.bars.show.notWorseThanRule = 'yes'; });
expectInvalid('bars.show.p95WithinBudget not a boolean', 'bars.show.p95WithinBudget', (r: any) => { r.bars.show.p95WithinBudget = 1; });
expectInvalid('bars.act.kappaGainLowerAbove of 2', 'bars.act.kappaGainLowerAbove', (r: any) => { r.bars.act.kappaGainLowerAbove = 2; });
expectInvalid('bars.act.maxWorseShare above 1', 'bars.act.maxWorseShare', (r: any) => { r.bars.act.maxWorseShare = 1.01; });
expectInvalid('an unknown key in bars', 'bars.extra', (r: any) => { r.bars.extra = 1; });
expectInvalid('an unknown key in bars.show', 'bars.show.extra', (r: any) => { r.bars.show.extra = 1; });
expectInvalid('an unknown key in bars.statistics', 'bars.statistics.extra', (r: any) => { r.bars.statistics.extra = 1; });
expectInvalid('a missing key in bars.act', 'bars.act.maxWorseShare', (r: any) => { delete r.bars.act.maxWorseShare; });
expectInvalid('a partial per-kind bars block', `kinds[${claimIndex}].bars.act`, (r: any) => { claimOf(r).bars = { version: 1, statistics: BARS.statistics, show: BARS.show }; });
expectInvalid('a per-kind bars block that breaks a rule', `kinds[${claimIndex}].bars.act.minCases`, (r: any) => { claimOf(r).bars = fullBars(); claimOf(r).bars.act.minCases = 1; });
expectInvalid('a per-kind bars block that is not an object', `kinds[${claimIndex}].bars`, (r: any) => { claimOf(r).bars = 'strict'; });
expectInvalid('an unknown replay source id', `kinds[${claimIndex}].replay.source`, (r: any) => { claimOf(r).replay.source = 'no-such-source'; });
expectInvalid('an inherited property name as a replay source id', `kinds[${claimIndex}].replay.source`, (r: any) => { claimOf(r).replay.source = 'toString'; });
expectInvalid('a replay block without a source', `kinds[${claimIndex}].replay.source`, (r: any) => { claimOf(r).replay = {}; });
expectInvalid('an unknown key in a replay block', `kinds[${claimIndex}].replay.extra`, (r: any) => { claimOf(r).replay.extra = 1; });
expectInvalid('a replay source on a kind nothing asks', `kinds[${rerankIndex}].replay`, (r: any) => { rerankOf(r).replay = { source: 'claim-ledger' }; });

test('row 175 IC-001: a full per-kind bars block and a null one both load', (t) => {
  const full = loadAdviceRegistry(writeFixture(t, (r: any) => { claimOf(r).bars = fullBars(); }));
  assert.equal(full.ok, true, full.detail);
  const none = loadAdviceRegistry(writeFixture(t, (r: any) => { claimOf(r).bars = null; }));
  assert.equal(none.ok, true, none.detail);
});

test('row 175 IC-001 (c): maxMode accepts show and still refuses an unknown mode', (t) => {
  const show = loadAdviceRegistry(writeFixture(t, (r: any) => { claimOf(r).maxMode = 'show'; }));
  assert.equal(show.ok, true, show.detail);
  const act = loadAdviceRegistry(writeFixture(t, (r: any) => { claimOf(r).maxMode = 'act'; }));
  assert.equal(act.ok, true, act.detail);
  const bad = loadAdviceRegistry(writeFixture(t, (r: any) => { claimOf(r).maxMode = 'maybe'; }));
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /maxMode must be one of off, shadow, show, act/);
});
