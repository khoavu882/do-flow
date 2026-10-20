'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The registry-driven layer's own registry: loads and validates `core/registry/verification.json`
 * (plan task C.2, design C7) into the shape `VerificationEngine` (in `verification.js`) compiles
 * contracts against.
 *
 * Validation is deliberately strict and throws rather than degrading: a registry that half-loads
 * produces a gate that verifies half of what it claims, which is the failure mode the whole
 * verification module exists to prevent.
 */

const path = require('node:path');
const nodeFs = require('node:fs');
const { parseYamlFile } = require('../capability-router.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { configHome } = require('../config-home.ts');

const REGISTRY_FILENAME = 'verification.json';

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

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(`verification.json is invalid: ${message}`);
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
function loadVerificationRegistry(options: any = {}): any {
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

  const seen = new Set<string>();
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

  assert(data.levels && typeof data.levels === 'object', 'levels must be an object');
  const l0 = data.levels.L0;
  assert(l0 && typeof l0 === 'object', 'levels.L0 must be an object');
  assert(Array.isArray(l0.tiers) && l0.tiers.length > 0, 'levels.L0.tiers must be a non-empty array');
  for (const t of l0.tiers) {
    assert(seen.has(t), `levels.L0 tier '${t}' must exist in tiers`);
  }

  for (const [level, def] of Object.entries(data.riskLevels) as [string, any][]) {
    assert(def && Array.isArray(def.requiredTiers), `risk level '${level}' needs requiredTiers`);
    for (let i = 0; i < l0.tiers.length; i++) {
      assert(
        def.requiredTiers[i] === l0.tiers[i],
        `risk level '${level}' requiredTiers must begin with L0 tiers [${l0.tiers.join(', ')}]`,
      );
    }
    for (const id of def.requiredTiers.concat(def.advisoryTiers || [])) {
      assert(seen.has(id), `risk level '${level}' references unknown tier '${id}'`);
    }
    assert(
      Number.isInteger(def.maxRecoveryIterations) && def.maxRecoveryIterations > 0,
      `risk level '${level}' needs a positive integer maxRecoveryIterations`,
    );
  }

  const levelNames = ['L1', 'L2', 'L3'] as const;
  const riskLevelsInLevels = new Map<string, string>();
  for (const lvl of levelNames) {
    const entry = data.levels[lvl];
    assert(entry && typeof entry === 'object', `levels.${lvl} must be an object`);
    assert(Array.isArray(entry.riskLevels), `levels.${lvl}.riskLevels must be an array`);
    for (const r of entry.riskLevels) {
      assert(typeof r === 'string' && r !== '', `levels.${lvl}.riskLevels entries must be non-empty strings`);
      assert(Object.hasOwn(data.riskLevels, r), `levels.${lvl} references unknown risk level '${r}'`);
      assert(!riskLevelsInLevels.has(r), `risk level '${r}' is declared in multiple levels ('${riskLevelsInLevels.get(r)}' and '${lvl}')`);
      riskLevelsInLevels.set(r, lvl);
    }
  }
  for (const r of Object.keys(data.riskLevels)) {
    assert(riskLevelsInLevels.has(r), `risk level '${r}' must be assigned to exactly one of L1..L3`);
  }

  assert(policy.v0 && typeof policy.v0 === 'object', 'policy.v0 must be an object');
  assert(Array.isArray(policy.v0.levels), 'policy.v0.levels must be an array');
  const allowedV0Levels = new Set(['L1', 'L2']);
  for (const lvl of policy.v0.levels) {
    assert(allowedV0Levels.has(lvl), `policy.v0.levels must be a subset of ['L1', 'L2']: found '${lvl}'`);
  }

  // 089 IC-008: the reuse policy is data (levels that may reuse, age bound, declared ignored inputs).
  assert(policy.reuse && typeof policy.reuse === 'object', 'policy.reuse must be an object');
  assert(Array.isArray(policy.reuse.levels), 'policy.reuse.levels must be an array');
  for (const lvl of policy.reuse.levels) {
    assert(allowedV0Levels.has(lvl), `policy.reuse.levels must be a subset of ['L1', 'L2']: found '${lvl}'`);
  }
  assert(
    Number.isInteger(policy.reuse.maxAgeMs) && policy.reuse.maxAgeMs > 0,
    'policy.reuse.maxAgeMs must be a positive integer',
  );
  assert(Array.isArray(policy.reuse.ignoredInputs), 'policy.reuse.ignoredInputs must be an array');
  for (const input of policy.reuse.ignoredInputs) {
    assert(
      typeof input === 'string' && input !== '' && !input.includes('\0')
        && !path.isAbsolute(input) && !path.win32.isAbsolute(input)
        && !input.split(/[\\/]+/).includes('..'),
      `policy.reuse.ignoredInputs entries must be relative paths without '..': found '${String(input)}'`,
    );
  }

  return data;
}

/**
 * Maps a risk level ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL') to its verification level ('L1' | 'L2' | 'L3').
 * Returns null if the risk level is unknown, null, or undefined.
 */
function levelOf(registry: any, risk: string | null | undefined): 'L1' | 'L2' | 'L3' | null {
  if (!registry?.levels || typeof risk !== 'string') return null;
  for (const lvl of ['L1', 'L2', 'L3'] as const) {
    const riskLevels = registry.levels[lvl]?.riskLevels;
    if (Array.isArray(riskLevels) && riskLevels.includes(risk)) {
      return lvl;
    }
  }
  return null;
}

/**
 * Returns whether V0 behavior applies to the given risk level under the registry policy.
 * True when the risk level maps to a level listed in policy.v0.levels.
 */
function v0Applies(registry: any, risk: string | null | undefined): boolean {
  const level = levelOf(registry, risk);
  if (!level) return false;
  const v0Levels = registry?.policy?.v0?.levels;
  return Array.isArray(v0Levels) && v0Levels.includes(level);
}

/**
 * Returns whether result reuse may apply to the given risk level (089 IC-008).
 * True when the risk level maps to a level listed in policy.reuse.levels.
 */
function reuseApplies(registry: any, risk: string | null | undefined): boolean {
  const level = levelOf(registry, risk);
  if (!level) return false;
  const reuseLevels = registry?.policy?.reuse?.levels;
  return Array.isArray(reuseLevels) && reuseLevels.includes(level);
}

/**
 * Resolves whether V0 behavior is enabled (IC-015, DD-8).
 * False if env.DOFLOW_VERIFY_V0 === 'off', else false if <configDir>/verify-v0.off exists, else true.
 * A stat fault counts as absent (on). Read once per verify command (handleVerifyCommand).
 *
 * @param {Object} [env=process.env]
 * @param {string|null} [configDir] directory containing verify-v0.off sentinel; falls back to configHome(env).dir
 * @param {Object} [fsImpl=nodeFs]
 * @returns {boolean}
 */
function v0Enabled(env: any = process.env, configDir?: string | null, fsImpl: any = nodeFs): boolean {
  if (env && env.DOFLOW_VERIFY_V0 === 'off') {
    return false;
  }
  const dir = configDir !== undefined ? configDir : configHome(env).dir;
  if (!dir) {
    return true;
  }
  const io = fsImpl || nodeFs;
  try {
    const stat = io.statSync(path.join(dir, 'verify-v0.off'));
    if (typeof stat.isFile === 'function' ? stat.isFile() : true) {
      return false;
    }
  } catch {
    // A stat fault counts as absent (on).
    return true;
  }
  return true;
}

module.exports = {
  loadVerificationRegistry,
  levelOf,
  v0Applies,
  reuseApplies,
  v0Enabled,
  TIER_RESOLUTIONS,
  TIER_STATUSES,
  RECOVERY_OUTCOMES,
  REGISTRY_FILENAME,
};

