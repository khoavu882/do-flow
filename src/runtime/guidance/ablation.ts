'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

export type RuleCategory = 'safety' | 'workflow' | 'quality' | 'questions' | 'principles';
export type EnforcementType = 'mechanical' | 'advisory';

export interface RuleEntry {
  id: string;
  tag: string;
  statement: string;
  sourceFile: string;
  category: RuleCategory;
  enforcement: EnforcementType;
  enforcementRef: string | null;
  neverAblate: boolean;
  ablationCandidate: boolean;
  description?: string;
}

export interface RuleLedger {
  version: 1;
  description: string;
  rules: RuleEntry[];
}

export interface MaskGuidanceOptions {
  guidanceText: string;
  ablatedRuleIds: string[];
  ledger?: RuleLedger;
}

export interface AblationTrialOptions {
  candidateRuleIds: string[];
  repoRoot?: string;
  ledger?: RuleLedger;
  guidanceText?: string;
  simulationScores?: {
    baseline: Record<string, number[]>;
    candidate: Record<string, number[]>;
  };
  noiseArtifact?: any;
  noiseConfig?: any;
}

export interface AblationTrialResult {
  candidateRuleIds: string[];
  maskedGuidanceLengthBytes: number;
  byteDelta: number; // Bytes saved (original - masked)
  trialVerdict: 'gain-above-noise' | 'within-noise' | 'regression' | 'inconclusive';
  recommendation: 'merge-candidate' | 'do-not-merge';
  heldoutGain: number | null;
  ci95: [number, number] | null;
}

/**
 * Permanent immutable set of protected safety invariant rule IDs (IC-002).
 */
const PERMANENT_NEVER_ABLATE_RULE_IDS = Object.freeze(new Set<string>([
  'rule-safety-conflict-order',
  'rule-safety-temporal-awareness',
  'rule-principles-retrieved-content-data',
  'rule-quality-no-invented-sources',
  'rule-quality-admit-unknowns',
  'rule-questions-noninteractive-fallback',
  'rule-questions-noninteractive-halt-on-blocker',
]));

/**
 * Error thrown when an ablation attempt violates the never-ablate safety invariant (IC-002).
 */
class NeverAblateViolationError extends Error {
  readonly code = 'ERR_NEVER_ABLATE';
  readonly violatedRuleIds: string[];

  constructor(violatedRuleIds: string[]) {
    super(`Cannot ablate protected rules [${violatedRuleIds.join(', ')}]: neverAblate safety invariant is violated.`);
    this.name = 'NeverAblateViolationError';
    this.violatedRuleIds = violatedRuleIds;
  }
}

/**
 * Loads and validates core/registry/rules.json (IC-001 / IC-003).
 */
function loadRuleLedger(options?: { repoRoot?: string; fsImpl?: any }): RuleLedger {
  const fsImpl = options?.fsImpl || fs;
  const root = options?.repoRoot || REPO_ROOT;
  const ledgerPath = path.join(root, 'core', 'registry', 'rules.json');

  if (!fsImpl.existsSync(ledgerPath)) {
    const err: any = new Error(`ERR_RULE_LEDGER_INVALID: rules registry not found at ${ledgerPath}`);
    err.code = 'ERR_RULE_LEDGER_INVALID';
    throw err;
  }

  let text: string;
  try {
    text = fsImpl.readFileSync(ledgerPath, 'utf8');
  } catch (cause: any) {
    const err: any = new Error(`ERR_RULE_LEDGER_INVALID: failed to read ${ledgerPath}: ${cause?.message || cause}`);
    err.code = 'ERR_RULE_LEDGER_INVALID';
    throw err;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (cause: any) {
    const err: any = new Error(`ERR_RULE_LEDGER_INVALID: rules.json is not valid JSON: ${cause?.message || cause}`);
    err.code = 'ERR_RULE_LEDGER_INVALID';
    throw err;
  }

  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.rules)) {
    const err: any = new Error('ERR_RULE_LEDGER_INVALID: schema must have version: 1 and rules: array');
    err.code = 'ERR_RULE_LEDGER_INVALID';
    throw err;
  }

  const seenIds = new Set<string>();
  for (const rule of parsed.rules) {
    if (!rule || typeof rule !== 'object') {
      const err: any = new Error('ERR_RULE_LEDGER_INVALID: rule entry must be an object');
      err.code = 'ERR_RULE_LEDGER_INVALID';
      throw err;
    }
    if (!rule.id || typeof rule.id !== 'string') {
      const err: any = new Error('ERR_RULE_LEDGER_INVALID: rule id must be a non-empty string');
      err.code = 'ERR_RULE_LEDGER_INVALID';
      throw err;
    }
    if (seenIds.has(rule.id)) {
      const err: any = new Error(`ERR_RULE_LEDGER_INVALID: duplicate rule id: ${rule.id}`);
      err.code = 'ERR_RULE_LEDGER_INVALID';
      throw err;
    }
    seenIds.add(rule.id);

    // Mutual exclusion invariant
    if (rule.neverAblate === true && rule.ablationCandidate === true) {
      const err: any = new Error(`ERR_RULE_LEDGER_INVALID: rule ${rule.id} cannot have both neverAblate: true and ablationCandidate: true`);
      err.code = 'ERR_RULE_LEDGER_INVALID';
      throw err;
    }
  }

  return parsed as RuleLedger;
}

/**
 * Retrieves all rules eligible for ablation trials (neverAblate === false && ablationCandidate === true).
 */
function getAblationCandidates(ledger: RuleLedger): RuleEntry[] {
  if (!ledger || !Array.isArray(ledger.rules)) return [];
  return ledger.rules.filter((rule) => !rule.neverAblate && rule.ablationCandidate === true);
}

/**
 * Verifies that none of the target rule IDs violate the never-ablate invariant (IC-002).
 * Throws NeverAblateViolationError (ERR_NEVER_ABLATE) if violated.
 */
function assertAblatable(ruleIds: string[], ledger: RuleLedger): void {
  if (!Array.isArray(ruleIds) || ruleIds.length === 0) return;

  const ruleMap = new Map<string, RuleEntry>();
  if (ledger && Array.isArray(ledger.rules)) {
    for (const rule of ledger.rules) {
      ruleMap.set(rule.id, rule);
    }
  }

  const violated: string[] = [];
  for (const id of ruleIds) {
    if (PERMANENT_NEVER_ABLATE_RULE_IDS.has(id)) {
      violated.push(id);
      continue;
    }
    const rule = ruleMap.get(id);
    if (!rule) {
      const err: any = new Error(`ERR_RULE_NOT_FOUND: Rule '${id}' not found in rule ledger.`);
      err.code = 'ERR_RULE_NOT_FOUND';
      throw err;
    }
    if (rule.neverAblate) {
      violated.push(id);
    }
  }

  if (violated.length > 0) {
    throw new NeverAblateViolationError(violated);
  }
}

/**
 * Masks designated rules from the guidance string without altering disk files (IC-003).
 */
function maskGuidance(options: MaskGuidanceOptions): string {
  const { guidanceText, ablatedRuleIds } = options;
  if (!ablatedRuleIds || ablatedRuleIds.length === 0) {
    return guidanceText;
  }

  const ledger = options.ledger || loadRuleLedger();
  assertAblatable(ablatedRuleIds, ledger);

  const ruleMap = new Map<string, RuleEntry>();
  for (const rule of ledger.rules) {
    ruleMap.set(rule.id, rule);
  }

  const targets = ablatedRuleIds.map((id) => ruleMap.get(id)!).filter(Boolean);
  if (targets.length === 0) return guidanceText;

  const targetSignatures = targets.map((target) => {
    const rawStatement = target.statement.replace(/\.\.\./g, ' ').trim();
    const cleanStatement = rawStatement.replace(/[`*#_]/g, '').trim();
    const prefix = cleanStatement.slice(0, 36).toLowerCase();

    // Support section-headed rules (e.g. "Trade-offs: Classify a decision...")
    const colonIdx = cleanStatement.indexOf(':');
    let headingPrefix = '';
    let bodyPrefix = '';
    if (colonIdx > 0) {
      headingPrefix = cleanStatement.slice(0, colonIdx).trim().toLowerCase();
      bodyPrefix = cleanStatement.slice(colonIdx + 1).trim().slice(0, 36).toLowerCase();
    }

    return {
      id: target.id,
      tag: target.tag,
      cleanStatement,
      prefix,
      headingPrefix,
      bodyPrefix,
    };
  });

  const lines = guidanceText.split('\n');
  const filteredLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cleanLine = line.replace(/[`*#_]/g, '').toLowerCase().trim();

    let matchesTarget = false;
    for (const sig of targetSignatures) {
      if (line.includes(sig.id)) {
        matchesTarget = true;
        break;
      }
      if (sig.prefix && cleanLine.includes(sig.prefix)) {
        matchesTarget = true;
        break;
      }
      if (sig.bodyPrefix && cleanLine.includes(sig.bodyPrefix)) {
        matchesTarget = true;
        break;
      }
      if (sig.headingPrefix && (cleanLine === sig.headingPrefix || cleanLine.startsWith(sig.headingPrefix))) {
        matchesTarget = true;
        break;
      }
      if (sig.cleanStatement && cleanLine.length > 10 && sig.cleanStatement.toLowerCase().includes(cleanLine)) {
        matchesTarget = true;
        break;
      }
    }

    if (!matchesTarget) {
      filteredLines.push(line);
    }
  }

  return filteredLines.join('\n');
}

/**
 * Helper to count total test runs across cases for infraShare computation.
 */
function countRuns(scores: Record<string, number[]>): number {
  if (!scores || typeof scores !== 'object') return 0;
  return Object.values(scores).reduce((acc, curr) => acc + (Array.isArray(curr) ? curr.length : 0), 0);
}

/**
 * Noise-floor decision bridge evaluating statistical ablation success via bench/noise.ts decide() (IC-004).
 */
function evaluateAblationNoiseDecision({
  baselineScores,
  candidateScores,
  noiseArtifact,
  noiseConfig,
  scope = 'heldout',
}: {
  baselineScores: Record<string, number[]>;
  candidateScores: Record<string, number[]>;
  noiseArtifact?: any;
  noiseConfig?: any;
  scope?: 'heldout' | 'corpus' | 'train';
}) {
  let decide: any;
  try {
    const noiseMod = require('../../../bench/noise.ts');
    decide = noiseMod.decide;
  } catch (err: any) {
    const error: any = new Error(`ERR_BENCH_NOT_FOUND: bench/noise.ts is only available in developer checkouts: ${err?.message || err}`);
    error.code = 'ERR_BENCH_NOT_FOUND';
    throw error;
  }

  const noise = noiseArtifact?.scopes?.[scope]?.noise ?? null;
  const cfg = noiseConfig || {};
  const mde = typeof cfg.mde === 'number' ? cfg.mde : 0.05;
  const maxInfraShare = typeof cfg.maxInfraShare === 'number' ? cfg.maxInfraShare : 0.10;
  const seed = Number.isInteger(cfg.seed) ? cfg.seed : 96;

  const decision = decide({
    scope,
    baseline: baselineScores,
    candidate: candidateScores,
    excluded: {
      baseline: { runs: countRuns(baselineScores), excluded: 0 },
      candidate: { runs: countRuns(candidateScores), excluded: 0 },
    },
    noise,
    mde,
    maxInfraShare,
    seed,
  });

  const rawVerdict = decision.verdict;
  const recommendation = (rawVerdict === 'gain-above-noise' || rawVerdict === 'within-noise')
    ? 'merge-candidate'
    : 'do-not-merge';

  return {
    verdict: rawVerdict,
    recommendation,
    gain: decision.gain,
    ci95: decision.ci95,
    band: decision.band,
    detail: decision.detail,
  };
}

/**
 * Loads baseline core guidance from filesystem for trial evaluation.
 */
function loadCanonicalGuidance(repoRoot: string, fsImpl: any): string {
  const guidanceDir = path.join(repoRoot, 'core', 'shared', 'guidance');
  const files = [
    path.join(guidanceDir, 'PRINCIPLES.md'),
    path.join(guidanceDir, 'rules', 'RULES.md'),
  ];
  const parts: string[] = [];
  for (const f of files) {
    if (fsImpl.existsSync(f)) {
      parts.push(fsImpl.readFileSync(f, 'utf8'));
    }
  }
  return parts.join('\n\n');
}

/**
 * Runs an ablation trial evaluating behavioral impact against baseline repeats (IC-003).
 */
function runAblationTrial(options: AblationTrialOptions): AblationTrialResult {
  const repoRoot = options?.repoRoot || REPO_ROOT;
  const fsImpl = (options as any)?.fsImpl || fs;
  const ledger = options.ledger || loadRuleLedger({ repoRoot, fsImpl });

  assertAblatable(options.candidateRuleIds, ledger);

  const baseText = options.guidanceText || loadCanonicalGuidance(repoRoot, fsImpl);
  const maskedText = maskGuidance({
    guidanceText: baseText,
    ablatedRuleIds: options.candidateRuleIds,
    ledger,
  });

  const originalLength = Buffer.byteLength(baseText, 'utf8');
  const maskedLength = Buffer.byteLength(maskedText, 'utf8');
  const byteDelta = originalLength - maskedLength;

  let trialVerdict: 'gain-above-noise' | 'within-noise' | 'regression' | 'inconclusive' = 'inconclusive';
  let recommendation: 'merge-candidate' | 'do-not-merge' = 'do-not-merge';
  let heldoutGain: number | null = null;
  let ci95: [number, number] | null = null;

  if (options.simulationScores) {
    const decision = evaluateAblationNoiseDecision({
      baselineScores: options.simulationScores.baseline,
      candidateScores: options.simulationScores.candidate,
      noiseArtifact: options.noiseArtifact,
      noiseConfig: options.noiseConfig,
      scope: 'heldout',
    });
    trialVerdict = decision.verdict as 'gain-above-noise' | 'within-noise' | 'regression' | 'inconclusive';
    recommendation = decision.recommendation as 'merge-candidate' | 'do-not-merge';
    heldoutGain = decision.gain;
    ci95 = decision.ci95;
  }

  return {
    candidateRuleIds: options.candidateRuleIds,
    maskedGuidanceLengthBytes: maskedLength,
    byteDelta,
    trialVerdict,
    recommendation,
    heldoutGain,
    ci95,
  };
}

module.exports = {
  PERMANENT_NEVER_ABLATE_RULE_IDS,
  NeverAblateViolationError,
  loadRuleLedger,
  getAblationCandidates,
  assertAblatable,
  maskGuidance,
  evaluateAblationNoiseDecision,
  runAblationTrial,
};
