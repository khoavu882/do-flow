'use strict';

/**
 * The registry-driven layer's own registry: loads and validates `core/registry/verification.yaml`
 * (plan task C.2, design C7) into the shape `VerificationEngine` (in `verification.js`) compiles
 * contracts against.
 *
 * Validation is deliberately strict and throws rather than degrading: a registry that half-loads
 * produces a gate that verifies half of what it claims, which is the failure mode the whole
 * verification module exists to prevent.
 */

const path = require('node:path');
const nodeFs = require('node:fs');
const { parseYamlFile } = require('../capability-router');
const { REPO_ROOT } = require('../../helper/repo-root');

const REGISTRY_FILENAME = 'verification.yaml';

/** Tier-level outcomes. `UNRESOLVED` is the load-bearing one: it says "this tier was required and
 * nothing was evaluated for it", and it is what keeps a report off PASS. */
const TIER_RESOLUTIONS = Object.freeze([
  'RESOLVED',
  'UNRESOLVED',
  'SUBSUMED',
  'NOT_APPLICABLE',
  'SKIPPED',
]);

const TIER_STATUSES = Object.freeze([
  'PASS',
  'FAIL',
  'UNRESOLVED',
  'SUBSUMED',
  'NOT_APPLICABLE',
  'SKIPPED',
  'NOT_RUN',
]);

/** Outcomes of a bounded recovery loop. */
const RECOVERY_OUTCOMES = Object.freeze([
  'PASS',
  'ABORTED',
  'NO_CHANGE',
  'NO_PROGRESS',
  'NO_REMEDIATION',
]);

function assert(condition, message) {
  if (!condition) throw new Error(`verification.yaml is invalid: ${message}`);
}

/**
 * Loads and validates the verification registry.
 *
 * Validation is deliberately strict and throws rather than degrading: a registry that half-loads
 * produces a gate that verifies half of what it claims, which is the failure mode this whole module
 * exists to prevent.
 *
 * @param {Object} [options]
 * @param {string} [options.repoRoot]
 * @param {string} [options.registryDir]
 * @param {string} [options.registryPath]
 * @param {Object} [options.registry] pre-parsed registry, bypassing the filesystem (test seam)
 * @param {Object} [options.fsImpl]
 * @returns {Object} the validated registry
 */
function loadVerificationRegistry(options = {}) {
  let data = options.registry;
  if (!data) {
    const repoRoot = options.repoRoot || REPO_ROOT;
    const registryDir = options.registryDir || path.join(repoRoot, 'core', 'registry');
    const registryPath = options.registryPath || path.join(registryDir, REGISTRY_FILENAME);
    data = parseYamlFile(registryPath, options.fsImpl || nodeFs);
  }

  assert(data && typeof data === 'object', 'root must be an object');
  assert(Array.isArray(data.tiers) && data.tiers.length > 0, 'tiers must be a non-empty array');
  assert(data.riskLevels && typeof data.riskLevels === 'object', 'riskLevels must be an object');

  const policy = data.policy || {};
  // FR-009 states this as a MUST, so it is enforced at load rather than trusted at call sites.
  assert(policy.modelReviewIsPrimaryProof === false, 'policy.modelReviewIsPrimaryProof must be false');

  const seen = new Set();
  let previousOrder = -Infinity;
  let lastNonModelOrder = -Infinity;
  let firstModelOrder = Infinity;

  for (const tier of data.tiers) {
    assert(tier && typeof tier.id === 'string' && tier.id !== '', 'every tier needs an id');
    assert(!seen.has(tier.id), `duplicate tier id '${tier.id}'`);
    seen.add(tier.id);
    assert(Number.isFinite(tier.order), `tier '${tier.id}' needs a numeric order`);
    assert(tier.order > previousOrder, `tier '${tier.id}' is declared out of order; tiers must be listed cheapest-first`);
    previousOrder = tier.order;
    if (tier.modelBased) {
      firstModelOrder = Math.min(firstModelOrder, tier.order);
      assert(tier.canEstablishPass === false, `model-based tier '${tier.id}' must declare canEstablishPass: false`);
    } else {
      lastNonModelOrder = Math.max(lastNonModelOrder, tier.order);
    }
  }
  // "Deterministic checks MUST run before any model-based review" (FR-009) is a structural property
  // of the registry, so it is checkable here instead of being re-asserted in prose.
  assert(firstModelOrder > lastNonModelOrder, 'every model-based tier must be ordered after every deterministic tier');

  for (const [level, def] of Object.entries(data.riskLevels)) {
    assert(def && Array.isArray(def.requiredTiers), `risk level '${level}' needs requiredTiers`);
    for (const id of def.requiredTiers.concat(def.advisoryTiers || [])) {
      assert(seen.has(id), `risk level '${level}' references unknown tier '${id}'`);
    }
    assert(
      Number.isInteger(def.maxRecoveryIterations) && def.maxRecoveryIterations > 0,
      `risk level '${level}' needs a positive integer maxRecoveryIterations`,
    );
  }

  return data;
}

module.exports = {
  loadVerificationRegistry,
  TIER_RESOLUTIONS,
  TIER_STATUSES,
  RECOVERY_OUTCOMES,
  REGISTRY_FILENAME,
};
