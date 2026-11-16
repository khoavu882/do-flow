'use strict';

// Feature 102 — Guidance Ablation & Rule Ledger Runtime Suite
// Covers IC-001 (rule ledger loading & candidates), the part `doflow health` reads. The never-ablate flags
// themselves are checked by test/guards/guidance-rules-registry.test.ts.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');

const {
  loadRuleLedger,
  getAblationCandidates,
} = require('../../src/runtime/guidance/ablation.ts');

function createMockLedger(): any {
  return {
    version: 1,
    description: 'Mock rule ledger for runtime tests',
    rules: [
      {
        id: 'rule-safe-candidate-1',
        tag: 'workflow',
        statement: 'Parallel when write sets are disjoint; otherwise sequential.',
        sourceFile: 'core/shared/guidance/rules/RULES.md',
        category: 'workflow',
        enforcement: 'advisory',
        enforcementRef: null,
        neverAblate: false,
        ablationCandidate: true,
      },
      {
        id: 'rule-safe-candidate-2',
        tag: 'quality',
        statement: 'Naming: Follow language standards (camelCase JS, snake_case Python); no mixed conventions',
        sourceFile: 'core/shared/guidance/rules/RULES.md',
        category: 'quality',
        enforcement: 'advisory',
        enforcementRef: null,
        neverAblate: false,
        ablationCandidate: true,
      },
      {
        id: 'rule-safety-temporal-awareness',
        tag: 'temporal',
        statement: 'Read the date from the environment before any temporal claim; never infer it from your knowledge cutoff, and state its source.',
        sourceFile: 'core/shared/guidance/rules/RULES.md',
        category: 'safety',
        enforcement: 'advisory',
        enforcementRef: null,
        neverAblate: true,
        ablationCandidate: false,
      },
      {
        id: 'rule-safety-conflict-order',
        tag: 'safety',
        statement: 'Conflict order: Safety > Scope > Quality > Speed. Prototype != Production requirements.',
        sourceFile: 'core/shared/guidance/rules/RULES.md',
        category: 'safety',
        enforcement: 'mechanical',
        enforcementRef: 'core/harnesses/shared/hooks/policies/pre-implementation-gate.sh',
        neverAblate: true,
        ablationCandidate: false,
      },
      {
        id: 'rule-non-candidate-inert',
        tag: 'principles',
        statement: 'Inert non-candidate rule statement.',
        sourceFile: 'core/shared/guidance/PRINCIPLES.md',
        category: 'principles',
        enforcement: 'advisory',
        enforcementRef: null,
        neverAblate: false,
        ablationCandidate: false,
      },
    ],
  };
}

describe('IC-001: Rule Ledger Loading & Candidate Discovery', () => {
  test('loadRuleLedger() loads core/registry/rules.json by default', () => {
    const ledger = loadRuleLedger();
    assert.ok(ledger, 'Rule ledger must be returned');
    assert.equal(ledger.version, 1);
    assert.ok(typeof ledger.description === 'string');
    assert.ok(Array.isArray(ledger.rules));
    assert.ok(ledger.rules.length > 0);
  });

  test('loadRuleLedger() supports custom repoRoot option', () => {
    const tempRoot = suiteTempDir('doflow-test-rules-ledger-');
    const registryDir = path.join(tempRoot, 'core', 'registry');
    fs.mkdirSync(registryDir, { recursive: true });
    const mock = createMockLedger();
    fs.writeFileSync(path.join(registryDir, 'rules.json'), JSON.stringify(mock, null, 2), 'utf8');

    const loaded = loadRuleLedger({ repoRoot: tempRoot });
    assert.equal(loaded.version, 1);
    assert.equal(loaded.rules.length, 5);
    assert.equal(loaded.rules[0].id, 'rule-safe-candidate-1');
  });

  test('loadRuleLedger() throws descriptive error on missing file', () => {
    const tempRoot = suiteTempDir('doflow-test-missing-ledger-');
    assert.throws(
      () => loadRuleLedger({ repoRoot: tempRoot }),
      /rules\.json/
    );
  });

  test('getAblationCandidates() filters exclusively eligible rules', () => {
    const mock = createMockLedger();
    const candidates = getAblationCandidates(mock);

    assert.equal(candidates.length, 2);
    const candidateIds = candidates.map((c: any) => c.id).sort();
    assert.deepEqual(candidateIds, ['rule-safe-candidate-1', 'rule-safe-candidate-2']);

    for (const c of candidates) {
      assert.equal(c.neverAblate, false, 'Candidate must not be protected');
      assert.equal(c.ablationCandidate, true, 'Candidate must have ablationCandidate === true');
    }
  });

  test('getAblationCandidates() on shipped ledger returns non-empty set with 0 safety rules', () => {
    const ledger = loadRuleLedger();
    const candidates = getAblationCandidates(ledger);

    assert.ok(candidates.length > 0, 'Shipped registry must have ablation candidates');
    for (const c of candidates) {
      assert.equal(c.neverAblate, false);
      assert.equal(c.ablationCandidate, true);
      assert.ok(!c.id.includes('safety'), `Safety rule '${c.id}' cannot be an ablation candidate`);
    }
  });
});
