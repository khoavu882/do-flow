'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FIELD_CLASSES,
  buildPackItem,
  buildObjectiveItem,
  buildAcceptanceCriteriaItem,
  buildConstraintItem,
  linearFit,
} = require('../../src/runtime/context/compose.ts');

test('compose: the classification matches IC-006 exactly', () => {
  const expected: any = [
    { field: 'objective', cls: 'mandatory', priority: null, itemId: 'objective' },
    { field: 'acceptanceCriteria', cls: 'mandatory', priority: null, itemId: 'ac:<n>' },
    { field: 'constraints', cls: 'mandatory', priority: null, itemId: 'nfr:<NFR-id>' },
    { field: 'verificationRequirements', cls: 'mandatory', priority: null, itemId: 'vr:<n>' },
    { field: 'scopeExcluded', cls: 'mandatory', priority: null, itemId: 'scope:<n>' },
    { field: 'claims.conflicts', cls: 'mandatory', priority: null, itemId: 'claim id' },
    { field: 'blockingGaps', cls: 'mandatory', priority: null, itemId: 'gap:<n>' },
    { field: 'researchRequests (blocking, not ANSWERED)', cls: 'mandatory', priority: null, itemId: 'request id' },
    { field: 'decisions.reason (register unreadable)', cls: 'mandatory', priority: null, itemId: 'decisions:reason' },
    { field: 'decisions.live', cls: 'optional', priority: 1, itemId: 'decision id' },
    { field: 'claims.supported', cls: 'optional', priority: 2, itemId: 'claim id' },
    { field: 'researchRequests (others)', cls: 'optional', priority: 3, itemId: 'request id' },
    { field: 'claims.hypotheses', cls: 'optional', priority: 4, itemId: 'claim id' },
    { field: 'pointers', cls: 'optional', priority: 5, itemId: 'pointer id (IC-016)' },
    { field: 'relevantFiles', cls: 'optional', priority: 6, itemId: 'file:<path>' },
    { field: 'evidenceSummary', cls: 'optional', priority: 7, itemId: 'evidence id' },
    { field: 'structuralContext', cls: 'optional', priority: 8, itemId: 'struct:<n>' },
  ];

  assert.equal(FIELD_CLASSES.length, 17, 'FIELD_CLASSES must have exactly 17 entries');
  for (let i = 0; i < expected.length; i++) {
    const act = FIELD_CLASSES[i];
    const exp = expected[i];
    assert.equal(act.field, exp.field, `row ${i} field mismatch`);
    assert.equal(act.cls, exp.cls, `row ${i} cls mismatch`);
    assert.equal(act.priority, exp.priority, `row ${i} priority mismatch`);
    assert.equal(act.itemId, exp.itemId, `row ${i} itemId mismatch`);
  }
});

test('compose: moving acceptanceCriteria to optional fails, naming it (negative control)', () => {
  function verifyClassification(table: any) {
    const row = table.find((e: any) => e.field === 'acceptanceCriteria');
    if (!row) throw new Error('acceptanceCriteria missing');
    if (row.cls !== 'mandatory') {
      throw new Error(`acceptanceCriteria must be mandatory, got ${row.cls}`);
    }
  }

  // Positive check
  assert.doesNotThrow(() => verifyClassification(FIELD_CLASSES));

  // Negative control: simulated mutation
  const badTable = FIELD_CLASSES.map((e: any) =>
    e.field === 'acceptanceCriteria' ? { ...e, cls: 'optional' } : e
  );
  assert.throws(
    () => verifyClassification(badTable),
    (err: any) => err.message.includes('acceptanceCriteria') && err.message.includes('mandatory')
  );
});

test('compose: no field outside the table can be emitted (FR-011)', () => {
  const disallowedFields: any = ['toolCatalogs', 'graphDumps', 'routingReasoning', 'traceHistories', 'unknownField'];
  for (const field of disallowedFields) {
    assert.throws(
      () => buildPackItem({ id: 'test', field, value: 'bad', md: 'bad' }),
      (err: any) => err.message.includes(`Field '${field}' is outside the IC-006 classification table (FR-011)`)
    );
  }
});

test('compose: two runs give the same selection', () => {
  const items: any = [
    buildObjectiveItem('Deterministic selection test'),
    buildAcceptanceCriteriaItem('AC-1: deterministic output'),
    buildPackItem({ id: 'opt-1', field: 'decisions.live', value: 'Decision 1', md: '- d1\n', priority: 1 }),
    buildPackItem({ id: 'opt-2', field: 'claims.supported', value: 'Claim 1', md: '- c1\n', priority: 2 }),
    buildPackItem({ id: 'opt-3', field: 'claims.hypotheses', value: 'Hyp 1', md: '- h1\n', priority: 4 }),
  ];

  const run1 = linearFit({ items, budget: 500 });
  const run2 = linearFit({ items, budget: 500 });

  assert.deepEqual(run1.kept.map((i: any) => i.id), run2.kept.map((i: any) => i.id));
  assert.deepEqual(run1.omissions, run2.omissions);
  assert.equal(run1.packDigest, run2.packDigest);
  assert.equal(run1.totalBytes, run2.totalBytes);
  assert.equal(run1.fittedOn, run2.fittedOn);
});

test('compose: fitting on markdown only fails on a fixture where JSON is the larger form (negative control)', () => {
  // Construct a fixture where md is small (fits in budget), but JSON is large (exceeds budget)
  const mandatory = buildObjectiveItem('Objective');
  // Optional item: md is 20 bytes, but JSON payload is 500 bytes
  const largeJsonItem = buildPackItem({
    id: 'large-json-item',
    field: 'claims.supported',
    value: { bigArray: Array(50).fill('some long text property value inside json') },
    md: `- ✓ Small md\n`,
    priority: 2,
    mdBytes: 20,
    jsonBytes: 500,
  });

  // Set budget such that mandatory + md fits, but mandatory + JSON > budget.
  const budget = Math.max(mandatory.mdBytes, mandatory.jsonBytes) + 300;

  // The true linearFit uses max(md, json) and MUST omit largeJsonItem because JSON exceeds budget
  const correctResult = linearFit({
    items: [mandatory, largeJsonItem],
    budget,
  });

  assert.equal(correctResult.overflow, false, 'linearFit must not overflow when omitting optional item fits within budget');
  assert.ok(
    correctResult.omissions.some((o: any) => o.id === 'large-json-item' && o.reason === 'budget'),
    'correct fit must omit item with reason budget because JSON exceeded budget'
  );
  assert.ok(
    !correctResult.kept.some((i: any) => i.id === 'large-json-item'),
    'correct fit must not keep item that exceeds JSON budget'
  );

  // Negative control: a buggy fit checking ONLY markdown keeps the item and exceeds JSON budget
  function buggyMarkdownOnlyFit({ items, budget }: any) {
    const kept: any = [];
    let mdCost = 0;
    for (const item of items) {
      if (item.cls === 'mandatory') {
        kept.push(item);
        mdCost += item.mdBytes;
      } else if (mdCost + item.mdBytes <= budget) {
        kept.push(item);
        mdCost += item.mdBytes;
      }
    }
    return kept;
  }

  const buggyKept = buggyMarkdownOnlyFit({ items: [mandatory, largeJsonItem], budget });
  assert.ok(
    buggyKept.some((i: any) => i.id === 'large-json-item'),
    'buggy markdown-only fit erroneously kept the item'
  );
  const totalJson = buggyKept.reduce((sum: any, i: any) => sum + i.jsonBytes, 0);
  assert.ok(
    totalJson > budget,
    `buggy fit produced JSON (${totalJson} B) exceeding budget (${budget} B)`
  );
});

test('compose: compileBoundedContextPack is an adapter over linearFit and calls it once (negative control)', () => {
  const compose = require('../../src/runtime/context/compose.ts');
  const { ContextPackCompiler } = require('../../src/runtime/context-pack.ts');
  const compiler: any = new ContextPackCompiler();

  let fitCalls = 0;
  const originalLinearFit = compose.linearFit;
  compose.linearFit = function (...args: any[]) {
    fitCalls++;
    return originalLinearFit.apply(this, args);
  };

  try {
    const res = compiler.compileBoundedContextPack({
      taskId: 'adapter-test',
      taskClass: 'feature',
      objective: 'Adapter test objective',
      mandatory: {
        acceptanceCriteria: ['AC-1'],
        constraints: ['C-1'],
      },
      optional: {
        hypotheses: ['H-1', 'H-2'],
        unverifiedClaims: ['C-1', 'C-2'],
        narrative: ['N-1', 'N-2'],
      },
      maxBytes: 5000,
    });

    assert.equal(fitCalls, 1, `linearFit must be called exactly once by compileBoundedContextPack, got ${fitCalls}`);
    assert.equal(res.overflow, false);
    assert.ok(res.totalBytes > 0);
  } finally {
    compose.linearFit = originalLinearFit;
  }

  // Negative control: spying on linearFit fails if the adapter calls it per trial
  function assertSingleFitCall(count: any) {
    if (count !== 1) {
      throw new Error(`Negative control: linearFit called ${count} times; adapter serialised per trial`);
    }
  }

  assert.doesNotThrow(() => assertSingleFitCall(1));
  assert.throws(
    () => assertSingleFitCall(6),
    /adapter serialised per trial/
  );
});
