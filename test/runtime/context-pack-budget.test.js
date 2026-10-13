'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ContextPackCompiler, TASK_CLASS_BUDGETS } = require('../../src/runtime/context-pack.ts');

test('context-pack-budget: task class budgets map all 9 task classes to positive rails', () => {
  const expectedClasses = [
    'feature',
    'dependency-change',
    'bug',
    'refactor',
    'documentation',
    'operations',
    'review',
    'research',
    'trivial-edit',
  ];

  for (const cls of expectedClasses) {
    assert.ok(TASK_CLASS_BUDGETS[cls], `expected budget for class ${cls}`);
    assert.ok(typeof TASK_CLASS_BUDGETS[cls] === 'number' && TASK_CLASS_BUDGETS[cls] > 0);
  }
});

test('context-pack-budget: compileBoundedContextPack fits all items when within budget', () => {
  const compiler = new ContextPackCompiler();
  const res = compiler.compileBoundedContextPack({
    taskId: 'task-test-01',
    taskClass: 'feature',
    objective: 'Implement budget bounded context packs',
    mandatory: {
      acceptanceCriteria: ['AC-01: payload under budget', 'AC-02: mandatory preserved'],
      constraints: ['C-01: deterministic UTF-8 bytes'],
      verificationPlan: 'Run node --test test/runtime/context-pack-budget.test.js',
    },
    optional: {
      hypotheses: ['Hypothesis: token savings exceeds 30%'],
      unverifiedClaims: ['Claim: performance overhead is negligible'],
      narrative: ['Historical context on context bloat'],
    },
    maxBytes: 10000,
  });

  assert.equal(res.overflow, false);
  assert.equal(res.omissions.length, 0);
  assert.ok(res.totalBytes > 0 && res.totalBytes <= 10000);
  assert.ok(res.mandatoryBytes > 0);
  assert.ok(res.optionalBytes > 0);
  assert.ok(res.payload.includes('AC-01: payload under budget'));
  assert.ok(res.payload.includes('Historical context on context bloat'));
});

test('context-pack-budget: trims optional items in reverse priority order when exceeding budget', () => {
  const compiler = new ContextPackCompiler();

  // Construct items so mandatory fits, but all optional together would exceed a tight budget
  const mandatory = {
    acceptanceCriteria: ['AC-01: must never drop criteria'],
    constraints: ['C-01: strict enforcement'],
    verificationPlan: 'Verify via test suite',
  };

  const optional = {
    hypotheses: ['High priority hypothesis: token reduction confirmed'],
    unverifiedClaims: ['Medium priority claim: claims check verified'],
    narrative: [
      'Low priority narrative item 1: long explanation of background',
      'Low priority narrative item 2: another long background paragraph',
    ],
  };

  // Determine baseline mandatory byte count
  const dryRun = compiler.compileBoundedContextPack({
    taskId: 'task-test-02',
    mandatory,
    optional: {},
  });
  const mandatoryBytes = dryRun.mandatoryBytes;

  // Set budget slightly above mandatory, enough for hypothesis but not narrative
  const tightBudget = mandatoryBytes + 120;

  const res = compiler.compileBoundedContextPack({
    taskId: 'task-test-02',
    taskClass: 'bug',
    maxBytes: tightBudget,
    mandatory,
    optional,
  });

  assert.equal(res.overflow, false);
  assert.ok(res.totalBytes <= tightBudget, `totalBytes (${res.totalBytes}) must be <= budget (${tightBudget})`);
  assert.ok(res.payload.includes('AC-01: must never drop criteria'), 'mandatory criteria preserved');
  assert.ok(res.payload.includes('C-01: strict enforcement'), 'mandatory constraint preserved');

  // Narrative should be trimmed before hypothesis
  assert.ok(res.omissions.some((o) => o.id.startsWith('narrative')), 'narrative omitted');
  assert.ok(!res.payload.includes('Low priority narrative item 2'), 'narrative item 2 excluded');
});

test('context-pack-budget: reports overflow and never truncates mandatory content when mandatory alone exceeds budget', () => {
  const compiler = new ContextPackCompiler();

  const mandatory = {
    acceptanceCriteria: [
      'AC-01: long requirement that requires significant detail and explanation',
      'AC-02: secondary invariant that must hold across all execution paths',
    ],
    constraints: ['C-01: hard constraint that cannot be relaxed under any circumstance'],
    verificationPlan: 'Execute complete validation matrix across all environments',
  };

  const res = compiler.compileBoundedContextPack({
    taskId: 'task-test-03',
    taskClass: 'trivial-edit',
    maxBytes: 50, // Impossibly small budget
    mandatory,
    optional: {
      hypotheses: ['H-01'],
      narrative: ['N-01'],
    },
  });

  assert.equal(res.overflow, true);
  assert.ok(res.error && res.error.includes('exceeds budget'));
  // Rule 1: Mandatory content is NEVER truncated even in overflow
  assert.ok(res.payload.includes('AC-01: long requirement'));
  assert.ok(res.payload.includes('C-01: hard constraint'));
  assert.ok(res.omissions.length > 0, 'all optional items marked omitted on overflow');
});

test('context-pack-budget: deterministic UTF-8 multi-byte character accounting', () => {
  const compiler = new ContextPackCompiler();

  const res = compiler.compileBoundedContextPack({
    taskId: 'task-test-utf8',
    taskClass: 'research',
    objective: '测试 UTF-8 字符预算 🚀',
    mandatory: {
      acceptanceCriteria: ['AC-01: 支持多语言字符 (UTF-8 multi-byte testing)'],
    },
  });

  const expectedBytes = Buffer.byteLength(res.payload, 'utf8');
  assert.equal(res.totalBytes, expectedBytes);
  assert.equal(res.overflow, false);
});
