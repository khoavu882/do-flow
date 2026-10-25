'use strict';

const TIER_ORDER: Record<string, number> = Object.freeze({
  light: 0,
  standard: 1,
  frontier: 2,
});

const VERIFY_RISK_ORDER: Record<string, number> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});

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

  if (kind === 'autopilot') {
    const cautionActions = new Set(['pause', 'require-confirmation', 'halt', 'block']);
    if (!cautionActions.has(staticPick.toLowerCase()) && cautionActions.has(advisorClean.toLowerCase())) {
      return { effectiveDecision: advisorClean, elevated: true };
    }
    return { effectiveDecision: staticPick, elevated: false };
  }

  if (advisorClean.toLowerCase() === staticPick.toLowerCase()) {
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
