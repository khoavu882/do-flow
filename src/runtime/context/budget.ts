'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const path = require('node:path');
const fs = require('node:fs');
const { loadRegistry } = require('../../registry/index.ts');

const TASK_CLASS_BUDGETS: Record<string, number> = Object.freeze({
  feature: 225000,
  'dependency-change': 85000,
  bug: 71000,
  refactor: 71000,
  documentation: 57000,
  operations: 45000,
  review: 42000,
  research: 35302,
  'trivial-edit': 30000,
});

function getRegisteredHarnesses(): any {
  const repoRoot = path.resolve(__dirname, '../../../');
  return loadRegistry({ repoRoot }).harnesses;
}

function getRegisteredHarnessIds(): string[] {
  return getRegisteredHarnesses().map((h: any) => h.id);
}

let cachedBudgetsJson: any = null;

function getBudgetsJson(): any {
  if (cachedBudgetsJson) return cachedBudgetsJson;
  try {
    const budgetsPath = path.resolve(__dirname, '../../../bench/perf/budgets.json');
    if (fs.existsSync(budgetsPath)) {
      cachedBudgetsJson = JSON.parse(fs.readFileSync(budgetsPath, 'utf8'));
      return cachedBudgetsJson;
    }
  } catch {
    // fallback if unreadable
  }
  return null;
}

/**
 * Resolves budget and harness identity per IC-012.
 * Precedence:
 * 1. Harness identity: flag -> env (DOFLOW_AGENT) -> unstated
 * 2. Cap: override (--max-bytes) -> profile -> task-class
 * 3. Capacity: declared -> unknown
 */
function resolveBudget({
  taskClass = 'feature',
  maxBytes,
  harnessFlag = null,
  env = process.env,
  profiles = null,
  budgetsJson = null,
}: any = {}): any {
  const harnesses = profiles || getRegisteredHarnesses();
  const validIds = harnesses.map((h: any) => h.id);

  // 1. Harness identity
  let harness: { id: string | null; source: 'flag' | 'env' | 'unstated'; basis?: string };

  if (harnessFlag !== null && harnessFlag !== undefined && harnessFlag !== '') {
    if (!validIds.includes(harnessFlag)) {
      const err: any = new Error(`Unknown harness '${harnessFlag}'. Valid harnesses: ${validIds.join(', ')}`);
      err.code = 'USAGE_ERROR';
      err.validIds = validIds;
      throw err;
    }
    harness = { id: harnessFlag, source: 'flag' };
  } else if (env && env.DOFLOW_AGENT) {
    const agentEnv = env.DOFLOW_AGENT;
    if (validIds.includes(agentEnv)) {
      harness = { id: agentEnv, source: 'env' };
    } else {
      harness = { id: null, source: 'unstated', basis: 'env-unregistered' };
    }
  } else {
    harness = { id: null, source: 'unstated' };
  }

  // Find harness declaration for profile lookup
  const harnessObj = harness.id ? harnesses.find((h: any) => h.id === harness.id) : null;
  const contextProfile = harnessObj?.contextProfile;

  // Capacity & Tool Limit
  let capacity: { value: number | null; basis: string };
  let toolResultLimitBytes: number | null = null;

  if (!harness.id) {
    capacity = { value: null, basis: 'unknown:harness-unstated' };
  } else if (contextProfile?.capacityTokens && typeof contextProfile.capacityTokens.value === 'number') {
    capacity = {
      value: contextProfile.capacityTokens.value,
      basis: `declared:${contextProfile.capacityTokens.source || 'profile'}`,
    };
  } else if (contextProfile?.capacityTokens?.unverified) {
    capacity = {
      value: null,
      basis: `unknown:${contextProfile.capacityTokens.unverified}`,
    };
  } else {
    capacity = {
      value: null,
      basis: 'unknown:profile-value-unavailable',
    };
  }

  if (contextProfile?.toolResultLimitBytes && typeof contextProfile.toolResultLimitBytes.value === 'number') {
    toolResultLimitBytes = contextProfile.toolResultLimitBytes.value;
  }

  // 2. Cap resolution
  let resolvedMaxBytes: number;
  let source: 'override' | 'profile' | 'task-class';
  let startupTokens: { value: number; basis: string } | null = null;

  if (Number.isInteger(maxBytes) && maxBytes > 0) {
    resolvedMaxBytes = maxBytes;
    source = 'override';
  } else if (
    contextProfile?.capacityTokens &&
    typeof contextProfile.capacityTokens.value === 'number' &&
    contextProfile?.reserveTokens &&
    typeof contextProfile.reserveTokens.value === 'number'
  ) {
    // Profile available calculation: (capacity - startup - reserve) * 4
    const effectiveBudgets = budgetsJson !== null && budgetsJson !== undefined ? budgetsJson : getBudgetsJson();
    let startupTokensEstimate = 0;
    let startupTokensBasis = 'unmeasured:no-entry';
    if (effectiveBudgets?.startupContext && Array.isArray(effectiveBudgets.startupContext)) {
      const entry = effectiveBudgets.startupContext.find((s: any) => s.harness === harness.id);
      if (typeof entry?.tokensEst === 'number') {
        startupTokensEstimate = entry.tokensEst;
        startupTokensBasis = entry.tokensBasis || 'estimated:bytes/4';
      } else if (entry?.sessionStartStdoutBytes?.unmeasured) {
        startupTokensBasis = `unmeasured:${entry.sessionStartStdoutBytes.unmeasured}`;
      }
    }
    startupTokens = {
      value: startupTokensEstimate,
      basis: startupTokensBasis,
    };
    const available = (contextProfile.capacityTokens.value - startupTokensEstimate - contextProfile.reserveTokens.value) * 4;
    resolvedMaxBytes = Math.max(0, available);
    source = 'profile';
  } else {
    resolvedMaxBytes = TASK_CLASS_BUDGETS[taskClass] || 225000;
    source = 'task-class';
  }

  return {
    maxBytes: resolvedMaxBytes,
    source,
    harness,
    capacity,
    toolResultLimitBytes,
    ...(startupTokens ? { startupTokens } : {}),
  };
}

module.exports = {
  TASK_CLASS_BUDGETS,
  resolveBudget,
  getRegisteredHarnessIds,
  getRegisteredHarnesses,
};
