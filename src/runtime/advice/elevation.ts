'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

const TIER_ORDER: Record<string, number> = Object.freeze({
  light: 0,
  standard: 1,
  frontier: 2,
});

// Risk order = key order of riskLevels in core/registry/verification.json, read once.
// An unreadable registry gives an empty order, which means "never elevated".
function loadVerifyRiskOrder(): Record<string, number> {
  const order: Record<string, number> = {};
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core/registry/verification.json'), 'utf8'));
    Object.keys(registry.riskLevels).forEach((level, i) => { order[level.toLowerCase()] = i; });
  } catch {
    return Object.freeze({});
  }
  return Object.freeze(order);
}

const VERIFY_RISK_ORDER: Record<string, number> = loadVerifyRiskOrder();

const REVIEW_DEPTH_ORDER: Record<string, number> = Object.freeze({
  single: 0,
  deep: 1,
});

const TASK_CLASS_ORDER: Record<string, number> = Object.freeze({
  'trivial-edit': 0,
  'refactor': 1,
  'bug': 1,
  'dependency-change': 1,
  'feature': 2,
});

function applyElevationInvariant(
  kind: string,
  staticPick: string,
  advisorPick: string | null
): { effectiveDecision: string; elevated: boolean } {
  if (!advisorPick || typeof advisorPick !== 'string' || !advisorPick.trim()) {
    return { effectiveDecision: staticPick, elevated: false };
  }

  const advisorClean = advisorPick.trim();

  if (kind === 'tier') {
    const sRank = TIER_ORDER[staticPick.toLowerCase()];
    const aRank = TIER_ORDER[advisorClean.toLowerCase()];
    if (sRank !== undefined && aRank !== undefined && aRank > sRank) {
      return { effectiveDecision: advisorClean, elevated: true };
    }
    return { effectiveDecision: staticPick, elevated: false };
  }

  if (kind === 'verify-risk') {
    const sRank = VERIFY_RISK_ORDER[staticPick.toLowerCase()];
    const aRank = VERIFY_RISK_ORDER[advisorClean.toLowerCase()];
    if (sRank !== undefined && aRank !== undefined && aRank > sRank) {
      return { effectiveDecision: advisorClean, elevated: true };
    }
    return { effectiveDecision: staticPick, elevated: false };
  }

  if (kind === 'review-depth') {
    const sRank = REVIEW_DEPTH_ORDER[staticPick.toLowerCase()];
    const aRank = REVIEW_DEPTH_ORDER[advisorClean.toLowerCase()];
    if (sRank !== undefined && aRank !== undefined && aRank > sRank) {
      return { effectiveDecision: advisorClean, elevated: true };
    }
    return { effectiveDecision: staticPick, elevated: false };
  }

  if (kind === 'task-class') {
    const sRank = TASK_CLASS_ORDER[staticPick.toLowerCase()];
    const aRank = TASK_CLASS_ORDER[advisorClean.toLowerCase()];
    if (sRank !== undefined && aRank !== undefined && aRank > sRank) {
      return { effectiveDecision: advisorClean, elevated: true };
    }
    return { effectiveDecision: staticPick, elevated: false };
  }

  return { effectiveDecision: staticPick, elevated: false };
}

module.exports = {
  applyElevationInvariant,
  TIER_ORDER,
  VERIFY_RISK_ORDER,
  REVIEW_DEPTH_ORDER,
  TASK_CLASS_ORDER,
};
