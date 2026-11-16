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

module.exports = {
  loadRuleLedger,
  getAblationCandidates,
};
