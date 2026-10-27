'use strict';

// Feature 102 — Guidance Ablation & Rule Ledger Runtime Suite
// Covers IC-001 (rule ledger loading & candidates), IC-002 (never-ablate safety invariant),
// IC-003 (guidance masking & trial simulation), and IC-004 (eval noise-band decision integration).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const {
  loadRuleLedger,
  getAblationCandidates,
  assertAblatable,
  maskGuidance,
  runAblationTrial,
  evaluateAblationNoiseDecision,
  NeverAblateViolationError,
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
        enforcementRef: 'core/harnesses/shared/hooks/policies/pre-bash-guard.sh',
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

describe('IC-002: Never-Ablate Safety Invariant & assertAblatable', () => {
  const mock = createMockLedger();

  test('assertAblatable() succeeds for valid candidates', () => {
    assert.doesNotThrow(() => {
      assertAblatable(['rule-safe-candidate-1'], mock);
    });
    assert.doesNotThrow(() => {
      assertAblatable(['rule-safe-candidate-1', 'rule-safe-candidate-2'], mock);
    });
    assert.doesNotThrow(() => {
      assertAblatable([], mock);
    });
  });

  test('assertAblatable() throws NeverAblateViolationError on single protected rule', () => {
    assert.throws(
      () => {
        assertAblatable(['rule-safety-temporal-awareness'], mock);
      },
      (err: any) => {
        assert.equal(err.name, 'NeverAblateViolationError');
        assert.equal(err.code, 'ERR_NEVER_ABLATE');
        assert.deepEqual(err.violatedRuleIds, ['rule-safety-temporal-awareness']);
        assert.match(err.message, /neverAblate safety invariant is violated/);
        return true;
      }
    );
  });

  test('assertAblatable() throws listing all violated rule IDs on multiple protected rules', () => {
    assert.throws(
      () => {
        assertAblatable(['rule-safety-temporal-awareness', 'rule-safety-conflict-order'], mock);
      },
      (err: any) => {
        assert.equal(err.code, 'ERR_NEVER_ABLATE');
        assert.ok(err.violatedRuleIds.includes('rule-safety-temporal-awareness'));
        assert.ok(err.violatedRuleIds.includes('rule-safety-conflict-order'));
        return true;
      }
    );
  });

  test('assertAblatable() fails closed on mixed candidate lists (safe + protected)', () => {
    assert.throws(
      () => {
        assertAblatable(['rule-safe-candidate-1', 'rule-safety-conflict-order'], mock);
      },
      (err: any) => {
        assert.equal(err.code, 'ERR_NEVER_ABLATE');
        assert.deepEqual(err.violatedRuleIds, ['rule-safety-conflict-order']);
        return true;
      }
    );
  });

  test('assertAblatable() on shipped ledger rejects all 7 permanent safety rules', () => {
    const ledger = loadRuleLedger();
    const MANDATORY_SAFETY_RULES = [
      'rule-safety-conflict-order',
      'rule-safety-temporal-awareness',
      'rule-principles-retrieved-content-data',
      'rule-quality-no-invented-sources',
      'rule-quality-admit-unknowns',
      'rule-questions-noninteractive-fallback',
      'rule-questions-noninteractive-halt-on-blocker',
    ];

    for (const safetyId of MANDATORY_SAFETY_RULES) {
      assert.throws(
        () => assertAblatable([safetyId], ledger),
        (err: any) => {
          assert.equal(err.code, 'ERR_NEVER_ABLATE');
          assert.ok(err.violatedRuleIds.includes(safetyId));
          return true;
        },
        `Expected ${safetyId} to throw ERR_NEVER_ABLATE`
      );
    }
  });

  test('assertAblatable() throws on unknown rule ID', () => {
    assert.throws(
      () => assertAblatable(['non-existent-rule-id'], mock),
      /ERR_RULE_NOT_FOUND|not found/
    );
  });
});

describe('IC-003: Guidance Masking Engine', () => {
  const mock = createMockLedger();

  const sampleGuidance = [
    '# Workflow Rules',
    '',
    '## Planning',
    '- **Parallel when write sets are disjoint; otherwise sequential.** Use task lists past 3 tasks when available.',
    '- Validate before execution, verify after; run lint/typecheck before marking complete.',
    '',
    '## Quality',
    'Naming: Follow language standards (camelCase JS, snake_case Python); no mixed conventions',
    'Push back on bad approaches; evidence-based claims only',
  ].join('\n');

  test('maskGuidance() removes single specified rule without modifying surrounding layout', () => {
    const masked = maskGuidance({
      guidanceText: sampleGuidance,
      ablatedRuleIds: ['rule-safe-candidate-1'],
      ledger: mock,
    });

    assert.ok(!masked.includes('Parallel when write sets are disjoint'), 'Masked rule text must be removed');
    assert.ok(masked.includes('Validate before execution'), 'Un-ablated rule must be preserved');
    assert.ok(masked.includes('# Workflow Rules'), 'Header must be preserved');
    assert.ok(masked.includes('## Quality'), 'Section header must be preserved');
    assert.ok(masked.includes('Naming: Follow language standards'), 'Other rules must be preserved');
  });

  test('maskGuidance() removes multiple rules in one pass', () => {
    const masked = maskGuidance({
      guidanceText: sampleGuidance,
      ablatedRuleIds: ['rule-safe-candidate-1', 'rule-safe-candidate-2'],
      ledger: mock,
    });

    assert.ok(!masked.includes('Parallel when write sets are disjoint'));
    assert.ok(!masked.includes('Naming: Follow language standards'));
    assert.ok(masked.includes('Validate before execution'));
    assert.ok(masked.includes('Push back on bad approaches'));
  });

  test('maskGuidance() with empty ablatedRuleIds returns identical text', () => {
    const masked = maskGuidance({
      guidanceText: sampleGuidance,
      ablatedRuleIds: [],
      ledger: mock,
    });
    assert.equal(masked, sampleGuidance);
  });

  test('maskGuidance() handles multi-line principles with headers and colons', () => {
    const principlesText = [
      '# Engineering Principles',
      '',
      '## The loop',
      '',
      '**Understand → Plan → Execute → Verify.** One name for it everywhere.',
      '',
      '## Trade-offs',
      '',
      'Classify a decision as reversible, costly, or irreversible before arguing it.',
    ].join('\n');

    const ledger = loadRuleLedger();
    const masked = maskGuidance({
      guidanceText: principlesText,
      ablatedRuleIds: ['rule-principles-tradeoffs'],
      ledger,
    });

    assert.ok(!masked.includes('Classify a decision as reversible'), 'Masked body line must be removed');
    assert.ok(masked.includes('**Understand → Plan → Execute → Verify.**'), 'Un-ablated rule must be preserved');
  });

  test('maskGuidance() throws ERR_NEVER_ABLATE if caller attempts to mask protected rule', () => {
    assert.throws(
      () => {
        maskGuidance({
          guidanceText: sampleGuidance,
          ablatedRuleIds: ['rule-safety-temporal-awareness'],
          ledger: mock,
        });
      },
      (err: any) => {
        assert.equal(err.code, 'ERR_NEVER_ABLATE');
        return true;
      }
    );
  });

  test('zero disk mutation: maskGuidance does not touch canonical files on disk', () => {
    const ledger = loadRuleLedger();
    const candidate = getAblationCandidates(ledger).find((c: any) => c.sourceFile.endsWith('rules/RULES.md') && c.category === 'workflow');
    assert.ok(candidate, 'Must find a workflow candidate in rules/RULES.md');
    const ruleFile = path.join(REPO_ROOT, candidate.sourceFile);
    const statBefore = fs.statSync(ruleFile);
    const contentBefore = fs.readFileSync(ruleFile, 'utf8');

    const masked = maskGuidance({
      guidanceText: contentBefore,
      ablatedRuleIds: [candidate.id],
      ledger,
    });

    assert.notEqual(masked, contentBefore);
    // Disk file must be completely untouched
    assert.equal(fs.readFileSync(ruleFile, 'utf8'), contentBefore);
    assert.equal(fs.statSync(ruleFile).mtimeMs, statBefore.mtimeMs);
  });
});

describe('IC-003: Ablation Simulation Trial (runAblationTrial)', () => {
  const mock = createMockLedger();

  test('runAblationTrial() calculates byte savings and executes trial simulation', () => {
    const result = runAblationTrial({
      candidateRuleIds: ['rule-safe-candidate-1'],
      ledger: mock,
      simulationScores: {
        baseline: { 'case-1': [1, 1, 1], 'case-2': [1, 1, 1], 'case-3': [1, 1, 1] },
        candidate: { 'case-1': [1, 1, 1], 'case-2': [1, 1, 1], 'case-3': [1, 1, 1] },
      },
    });

    assert.ok(result);
    assert.deepEqual(result.candidateRuleIds, ['rule-safe-candidate-1']);
    assert.ok(typeof result.maskedGuidanceLengthBytes === 'number');
    assert.ok(typeof result.byteDelta === 'number');
    assert.ok(result.byteDelta > 0, 'Byte delta must represent saved prompt bytes');
    assert.ok(['gain-above-noise', 'within-noise', 'regression', 'inconclusive'].includes(result.trialVerdict));
    assert.ok(['merge-candidate', 'do-not-merge'].includes(result.recommendation));
  });

  test('runAblationTrial() throws ERR_NEVER_ABLATE if target contains protected rule', () => {
    assert.throws(
      () => {
        runAblationTrial({
          candidateRuleIds: ['rule-safety-temporal-awareness'],
          ledger: mock,
        });
      },
      (err: any) => {
        assert.equal(err.code, 'ERR_NEVER_ABLATE');
        return true;
      }
    );
  });
});

describe('IC-004: Noise-Band Decision Integration', () => {
  const mockNoiseArtifact = {
    kind: 'bench-noise',
    schemaVersion: 1,
    scopes: {
      heldout: { noise: 0.04, headroom: false },
      corpus: { noise: 0.04, headroom: false },
    },
  };

  const mockNoiseConfig = {
    k: 3,
    kMin: 2,
    mde: 0.05,
    headroom: 0.95,
    maxInfraShare: 0.10,
    seed: 42,
  };

  test('within-noise evaluation produces recommendation: merge-candidate (pruning validated)', () => {
    // Identical performance between baseline and candidate -> 0 diff, within noise band
    const baseline = {
      'case-1': [1, 1, 1],
      'case-2': [1, 1, 1],
      'case-3': [1, 1, 1],
      'case-4': [0, 1, 1],
    };
    const candidate = {
      'case-1': [1, 1, 1],
      'case-2': [1, 1, 1],
      'case-3': [1, 1, 1],
      'case-4': [0, 1, 1],
    };

    const decision = evaluateAblationNoiseDecision({
      baselineScores: baseline,
      candidateScores: candidate,
      noiseArtifact: mockNoiseArtifact,
      noiseConfig: mockNoiseConfig,
      scope: 'heldout',
    });

    assert.equal(decision.verdict, 'within-noise');
    assert.equal(decision.recommendation, 'merge-candidate', 'Zero performance loss allows prompt pruning');
  });

  test('gain-above-noise evaluation produces recommendation: merge-candidate', () => {
    const baseline = {
      'case-1': [0, 0, 0],
      'case-2': [0, 0, 0],
      'case-3': [0, 0, 0],
      'case-4': [0, 0, 0],
    };
    const candidate = {
      'case-1': [1, 1, 1],
      'case-2': [1, 1, 1],
      'case-3': [1, 1, 1],
      'case-4': [1, 1, 1],
    };

    const decision = evaluateAblationNoiseDecision({
      baselineScores: baseline,
      candidateScores: candidate,
      noiseArtifact: mockNoiseArtifact,
      noiseConfig: mockNoiseConfig,
      scope: 'heldout',
    });

    assert.equal(decision.verdict, 'gain-above-noise');
    assert.equal(decision.recommendation, 'merge-candidate');
  });

  test('regression evaluation produces recommendation: do-not-merge', () => {
    const baseline = {
      'case-1': [1, 1, 1],
      'case-2': [1, 1, 1],
      'case-3': [1, 1, 1],
      'case-4': [1, 1, 1],
    };
    const candidate = {
      'case-1': [0, 0, 0],
      'case-2': [0, 0, 0],
      'case-3': [0, 0, 0],
      'case-4': [0, 0, 0],
    };

    const decision = evaluateAblationNoiseDecision({
      baselineScores: baseline,
      candidateScores: candidate,
      noiseArtifact: mockNoiseArtifact,
      noiseConfig: mockNoiseConfig,
      scope: 'heldout',
    });

    assert.equal(decision.verdict, 'regression');
    assert.equal(decision.recommendation, 'do-not-merge', 'Ablation that harms accuracy cannot be merged');
  });

  test('inconclusive eval due to missing noise band produces recommendation: do-not-merge', () => {
    const baseline = { 'case-1': [1, 1, 1] };
    const candidate = { 'case-1': [1, 1, 1] };

    const decision = evaluateAblationNoiseDecision({
      baselineScores: baseline,
      candidateScores: candidate,
      noiseArtifact: { scopes: {} }, // missing noise band
      noiseConfig: mockNoiseConfig,
      scope: 'heldout',
    });

    assert.equal(decision.verdict, 'inconclusive');
    assert.equal(decision.recommendation, 'do-not-merge', 'Inconclusive power fails safe to do-not-merge');
  });
});
