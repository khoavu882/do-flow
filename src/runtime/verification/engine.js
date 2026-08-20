'use strict';

/**
 * Registry-driven verification layer (plan task C.2, design C7): `VerificationEngine` compiles a
 * contract **before** implementation and a report **after**, scaling required tiers to risk,
 * detecting commands from project manifests, and wiring the C8 recovery classifier into the
 * failure path with its bounded retry.
 *
 * Built on two modules split out alongside it:
 *   - `verification-contract-runner.js` — `VerificationContractRunner`, the deterministic
 *     check-execution primitive this engine compiles tiers of checks down to.
 *   - `verification-registry.js` — `loadVerificationRegistry`, which reads and validates
 *     `core/registry/verification.yaml` into the shape `compileContract` reads tiers from.
 *
 * Three defects in the runner this engine sits on (a check with no command reporting PASS, a
 * timed-out check losing its output, an empty contract reporting PASS over zero evidence — see
 * `verification-contract-runner.js`) are the reason this layer looks the way it does. Their shared
 * shape is a gate answering confidently about something it never evaluated, so the engine keeps
 * "not evaluated" as a first-class outcome — UNRESOLVED — that can never become PASS.
 */

const path = require('node:path');
const nodeFs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { detectCommands, applyTargetPattern } = require('../command-detect');
const { RecoveryManager } = require('../recovery');
const { finishRuntime, usageError } = require('../cli-result');
const {
  VerificationContractRunner,
  FATAL_CHECK_MARKERS,
  TIMEOUT_EXIT_CODE,
  MAX_STREAM_CHARS,
} = require('./contract-runner');
const {
  loadVerificationRegistry,
  TIER_RESOLUTIONS,
  TIER_STATUSES,
  RECOVERY_OUTCOMES,
  REGISTRY_FILENAME,
} = require('./registry');

// `handleVerifyCommand` (moved from bin/doflow.js) used bin/doflow.js's own REPO_ROOT — that file's
// SCRIPT_DIR is bin/, so REPO_ROOT = path.dirname(SCRIPT_DIR) = the repo root. This module lives at
// src/runtime/, two levels deeper than bin/, so the equivalent repo root is two levels up from here.
// bin/doflow.js:    path.dirname(__dirname)         with __dirname = <repo>/bin
// src/runtime/verification/*.js: path.resolve(__dirname,'..','..','..') with __dirname = <repo>/src/runtime/verification
// Both resolve to the same absolute repo root.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** `PASS` and `FAIL` are the Python's vocabulary. `INCONCLUSIVE` is added for the empty-contract
 * case only — see `evaluateContract`. */
const VERIFICATION_STATUSES = Object.freeze(['PASS', 'FAIL', 'INCONCLUSIVE']);

/**
 * @param {*} value
 * @returns {Array<string>}
 */
function toStringArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v !== '') : [];
}

/**
 * Parses `git status --porcelain` into the set of paths it touched.
 * @param {string} stdout
 * @returns {Array<string>}
 */
function parsePorcelain(stdout) {
  const files = [];
  for (const line of String(stdout || '').split('\n')) {
    if (line.trim() === '') continue;
    const body = line.slice(3);
    // A rename is reported as `old -> new`; the new path is the one that exists now.
    const arrow = body.indexOf(' -> ');
    files.push(arrow === -1 ? body.trim() : body.slice(arrow + 4).trim());
  }
  return files.filter(Boolean);
}

class VerificationEngine {
  /**
   * @param {Object} [options]
   * @param {string} [options.cwd] directory checks run in
   * @param {string} [options.repoRoot] where `core/registry/` lives
   * @param {Object} [options.registry] pre-parsed registry (test seam)
   * @param {Object} [options.fsImpl] injection seam for manifest and registry reads
   * @param {Function} [options.exec] injection seam for shell execution; `spawnSync` contract
   * @param {Function} [options.clock] injection seam returning epoch milliseconds
   * @param {RecoveryManager} [options.recovery] overrides the per-risk-level manager
   */
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.fsImpl = options.fsImpl || nodeFs;
    this.exec = options.exec || spawnSync;
    this.clock = options.clock || Date.now;
    this.registry = loadVerificationRegistry({
      repoRoot: options.repoRoot,
      registryDir: options.registryDir,
      registryPath: options.registryPath,
      registry: options.registry,
      fsImpl: this.fsImpl,
    });
    this.policy = this.registry.policy || {};
    this.runner = new VerificationContractRunner({ cwd: this.cwd, exec: this.exec });
    this.recoveryOverride = options.recovery || null;
  }

  /** @returns {string} ISO timestamp from the injected clock */
  timestamp() {
    return new Date(this.clock()).toISOString();
  }

  /**
   * @param {string} riskLevel
   * @returns {Object} the risk-level definition
   */
  riskDefinition(riskLevel) {
    const def = this.registry.riskLevels[riskLevel];
    if (!def) {
      // Never coerce to the default: a caller that mistyped CRITICAL would silently get MEDIUM's
      // lighter tier set on the change that most needed the heavier one.
      throw new Error(
        `Unknown risk level '${riskLevel}'. Valid: ${Object.keys(this.registry.riskLevels).join(', ')}`,
      );
    }
    return def;
  }

  /**
   * Compiles the verification contract. Called **before** implementation: this is the artifact that
   * states how success will be established (FR-009), and `runContract` later reports against it.
   *
   * @param {Object} input
   * @param {string} input.taskId
   * @param {string} [input.riskLevel] defaults to `policy.defaultRiskLevel`
   * @param {Object} [input.detection] a `detectCommands` result; detected here when absent
   * @param {string} [input.projectRoot] used for detection when `detection` is not supplied
   * @param {string} [input.planPath] a feature `plan.md` whose override block wins over detection
   * @param {string} [input.planText] override text supplied directly
   * @param {string} [input.targetPattern] scopes the targeted-tests tier
   * @param {Array<{name: string, command: string, timeoutMs?: number}>} [input.structuralChecks]
   * @param {Array<{id: string, description?: string, command?: string}>} [input.requirements]
   * @param {{maxFiles?: number, allowedPaths?: Array<string>}} [input.scope]
   * @returns {Object} the contract
   */
  compileContract(input = {}) {
    // A contract with no task is the readiness.js `taskId || 'default'` defect in a new place: a
    // confident verdict filed against the wrong subject. Refuse instead of inventing an id.
    if (typeof input.taskId !== 'string' || input.taskId.trim() === '') {
      throw new Error('compileContract requires a non-empty taskId');
    }

    const riskLevel = input.riskLevel || this.policy.defaultRiskLevel;
    const risk = this.riskDefinition(riskLevel);
    const requiredTiers = new Set(risk.requiredTiers);
    const advisoryTiers = new Set(risk.advisoryTiers || []);

    const detection = input.detection || detectCommands({
      projectRoot: input.projectRoot || this.cwd,
      planPath: input.planPath,
      planText: input.planText,
      fsImpl: this.fsImpl,
    });

    const structuralChecks = Array.isArray(input.structuralChecks) ? input.structuralChecks : [];
    const requirements = Array.isArray(input.requirements) ? input.requirements : [];
    const scope = input.scope && typeof input.scope === 'object' ? input.scope : {};
    const declaredNone = new Set(detection.declaredNone || []);
    const absent = new Set(detection.absent || []);

    const tiers = this.registry.tiers.map((tier) => {
      const required = requiredTiers.has(tier.id);
      const advisory = advisoryTiers.has(tier.id);
      const base = {
        id: tier.id,
        name: tier.name,
        kind: tier.kind,
        order: tier.order,
        required,
        advisory,
        fatal: Boolean(tier.fatal),
        modelBased: Boolean(tier.modelBased),
        failureClass: tier.failureClass || null,
        checks: [],
        resolution: 'SKIPPED',
        reason: `Not required at risk level ${riskLevel}.`,
      };
      if (!required && !advisory) return base;

      if (tier.source === 'detected-command') {
        return Object.assign(base, this.resolveCommandTier(tier, detection, declaredNone, absent, input.targetPattern));
      }
      if (tier.source === 'caller-supplied' && tier.id === 'structural-invariants') {
        return Object.assign(base, this.resolveStructuralTier(tier, structuralChecks));
      }
      if (tier.source === 'caller-supplied' && tier.id === 'requirement-satisfaction') {
        return Object.assign(base, this.resolveRequirementTier(tier, requirements));
      }
      if (tier.source === 'scope-observation') {
        return Object.assign(base, this.resolveScopeTier(tier, scope));
      }
      if (tier.source === 'model') {
        return Object.assign(base, {
          resolution: 'RESOLVED',
          reason: 'Advisory model review; supplied to runContract, never establishes PASS.',
        });
      }
      // A tier whose source this engine does not implement is unevaluated, not satisfied.
      return Object.assign(base, {
        resolution: 'UNRESOLVED',
        reason: `Tier source '${tier.source}' has no evaluator in this engine.`,
      });
    });

    // Subsumption is a second pass because it depends on how a *later* tier resolved: parse is
    // covered by build only if build actually has a command.
    const byId = new Map(tiers.map((t) => [t.id, t]));
    for (const tier of this.registry.tiers) {
      const resolved = byId.get(tier.id);
      if (!resolved || resolved.resolution !== 'UNRESOLVED') continue;
      const cover = toStringArray(tier.subsumedBy).find((id) => byId.get(id) && byId.get(id).resolution === 'RESOLVED');
      if (cover) {
        resolved.resolution = 'SUBSUMED';
        resolved.subsumedBy = cover;
        resolved.reason = `No dedicated command; covered by the '${cover}' tier, which runs the same source through a stricter step.`;
      }
    }

    const unresolvedRequiredTiers = tiers
      .filter((t) => t.required && t.resolution === 'UNRESOLVED')
      .map((t) => ({ tier: t.id, reason: t.reason }));

    return {
      version: this.registry.version,
      taskId: input.taskId,
      riskLevel,
      compiledAt: this.timestamp(),
      compiledBeforeImplementation: true,
      cwd: this.cwd,
      maxRecoveryIterations: risk.maxRecoveryIterations,
      detection: {
        usable: detection.usable,
        manifestFound: detection.manifestFound,
        manifests: detection.manifests,
        absent: detection.absent,
        declaredNone: detection.declaredNone,
        errors: detection.errors,
      },
      scope: {
        maxFiles: Number.isFinite(scope.maxFiles) ? scope.maxFiles : null,
        allowedPaths: toStringArray(scope.allowedPaths),
      },
      tiers,
      unresolvedRequiredTiers,
      runnableCheckCount: tiers.reduce((n, t) => n + t.checks.length, 0),
    };
  }

  /**
   * Resolves a tier served by a detected command. The whole point of the three-way distinction in
   * `command-detect` lands here.
   * @private
   */
  resolveCommandTier(tier, detection, declaredNone, absent, targetPattern) {
    if (!detection.usable) {
      return {
        resolution: 'UNRESOLVED',
        reason: `Command detection is unusable: ${detection.errors.join('; ')}`,
      };
    }

    const roles = toStringArray(tier.commandRoles);
    const selectAll = tier.commandRoleSelection === 'all';
    const checks = [];
    const notes = [];

    for (const role of roles) {
      const found = detection.commands[role];
      if (!found) continue;
      const { command, substituted } = applyTargetPattern(found.command, targetPattern);
      if (command === null) {
        // The command is a template and no target was supplied. Fall through to the next role —
        // for targeted-tests that is the broad test command, which the report records.
        notes.push(`role '${role}' needs a target pattern and none was supplied`);
        continue;
      }
      checks.push({
        name: `${tier.id}:${role}`,
        tier: tier.id,
        role,
        command,
        timeoutMs: tier.timeoutMs || undefined,
        source: found.source,
        derivation: found.derivation,
        targetScoped: substituted,
      });
      if (!selectAll) break;
    }

    if (checks.length > 0) {
      const fellBack = !selectAll && checks[0].role !== roles[0];
      return {
        resolution: 'RESOLVED',
        reason: fellBack
          ? `Using the '${checks[0].role}' command; ${notes.join('; ')}.`
          : null,
        checks,
      };
    }

    // Explicit human declaration outranks everything: the plan said this project has no such
    // command, which is a statement, not a detection miss.
    if (roles.every((role) => declaredNone.has(role))) {
      return {
        resolution: 'NOT_APPLICABLE',
        reason: `plan.md declares this project has no ${roles.join('/')} command.`,
      };
    }

    // A manifest was read and does not declare the role. For build or lint that is real evidence
    // the project has no such step; for a test command it is not, and `absenceIsEvidence: false`
    // in the registry is what keeps that case UNRESOLVED and off PASS.
    if (tier.absenceIsEvidence && detection.manifestFound && roles.every((role) => absent.has(role) || declaredNone.has(role))) {
      return {
        resolution: 'NOT_APPLICABLE',
        reason: `${detection.manifests.join(', ')} declares no ${roles.join('/')} step.`,
      };
    }

    const why = detection.manifestFound
      ? `no ${roles.join('/')} command could be detected from ${detection.manifests.join(', ')}`
      : `no project manifest was found under ${detection.projectRoot || this.cwd}`;
    return {
      resolution: 'UNRESOLVED',
      reason: `${why}. Declare it in plan.md's \`${this.policy.planOverrideBlock}\` block (use null to state the project has none).`,
    };
  }

  /** @private */
  resolveStructuralTier(tier, structuralChecks) {
    const checks = structuralChecks
      .filter((c) => c && typeof c.command === 'string' && c.command.trim() !== '')
      .map((c, i) => ({
        name: `${tier.id}:${c.name || `invariant_${i + 1}`}`,
        tier: tier.id,
        role: 'structural',
        command: c.command,
        timeoutMs: c.timeoutMs || tier.timeoutMs || undefined,
        source: 'caller',
        derivation: 'declared',
      }));
    if (checks.length === 0) {
      return {
        resolution: 'UNRESOLVED',
        reason: 'No structural invariant checks were supplied, and this risk level requires structural evidence.',
      };
    }
    return { resolution: 'RESOLVED', checks, reason: null };
  }

  /** @private */
  resolveRequirementTier(tier, requirements) {
    const checks = [];
    const unevaluated = [];
    for (const req of requirements) {
      if (!req || typeof req.id !== 'string' || req.id === '') continue;
      if (typeof req.command === 'string' && req.command.trim() !== '') {
        checks.push({
          name: `${tier.id}:${req.id}`,
          tier: tier.id,
          role: 'requirement',
          requirementId: req.id,
          description: req.description || null,
          command: req.command,
          timeoutMs: req.timeoutMs || tier.timeoutMs || undefined,
          source: 'caller',
          derivation: 'declared',
        });
      } else {
        // An asserted requirement is not a verified one. It is listed so the report can name what
        // is unproven, rather than counted as satisfied.
        unevaluated.push({ id: req.id, description: req.description || null });
      }
    }
    if (checks.length === 0 && unevaluated.length === 0) {
      return {
        resolution: 'UNRESOLVED',
        reason: 'No requirement checks were supplied, and this risk level requires requirement evidence.',
      };
    }
    return {
      resolution: 'RESOLVED',
      checks,
      unevaluatedRequirements: unevaluated,
      reason: unevaluated.length > 0
        ? `${unevaluated.length} requirement(s) have no executable check and cannot be reported satisfied.`
        : null,
    };
  }

  /** @private */
  resolveScopeTier(tier, scope) {
    const maxFiles = Number.isFinite(scope.maxFiles) ? scope.maxFiles : null;
    const allowedPaths = toStringArray(scope.allowedPaths);
    if (maxFiles === null && allowedPaths.length === 0) {
      return {
        resolution: 'UNRESOLVED',
        reason: 'No change-scope bound was declared before implementation, so the actual scope has nothing to be compared against.',
      };
    }
    return {
      resolution: 'RESOLVED',
      bound: { maxFiles, allowedPaths },
      reason: null,
    };
  }

  /**
   * Observes which files the change actually touched.
   * @private
   * @returns {{ files: Array<string>|null, reason: string|null }}
   */
  observeChangedFiles(changedFiles) {
    if (Array.isArray(changedFiles)) return { files: changedFiles.filter((f) => typeof f === 'string'), reason: null };

    let res;
    try {
      res = this.exec('git status --porcelain', {
        shell: true,
        cwd: this.cwd,
        encoding: 'utf8',
        timeout: 30000,
      });
    } catch (error) {
      return { files: null, reason: `Could not observe the changed files: ${error.message}` };
    }
    if (!res || res.error || res.status !== 0) {
      const detail = (res && res.error && res.error.message) || (res && truncate(res.stderr)) || 'git returned a non-zero status';
      return { files: null, reason: `Could not observe the changed files: ${detail}` };
    }
    return { files: parsePorcelain(res.stdout), reason: null };
  }

  /**
   * Runs a compiled contract and produces the report. Called **after** implementation.
   *
   * @param {Object} contract from `compileContract`
   * @param {Object} [runtimeInput]
   * @param {Array<string>} [runtimeInput.changedFiles] overrides the git observation
   * @param {{status: string, findings?: Array<string>, reviewer?: string}} [runtimeInput.modelReview]
   * @returns {Object} the report
   */
  runContract(contract, runtimeInput = {}) {
    if (!contract || !Array.isArray(contract.tiers)) {
      throw new Error('runContract expects a contract produced by compileContract');
    }

    const startedAt = this.timestamp();
    const reportTiers = [];
    const failedChecks = [];
    let fatalTier = null;
    let checksRun = 0;
    let checksPassed = 0;

    for (const tier of contract.tiers) {
      const entry = {
        id: tier.id,
        name: tier.name,
        kind: tier.kind,
        required: tier.required,
        advisory: tier.advisory,
        modelBased: tier.modelBased,
        failureClass: tier.failureClass,
        status: tier.resolution === 'RESOLVED' ? 'NOT_RUN' : tier.resolution,
        reason: tier.reason,
        checks: [],
      };

      if (tier.resolution !== 'RESOLVED') {
        reportTiers.push(entry);
        continue;
      }

      if (fatalTier) {
        entry.status = 'NOT_RUN';
        entry.reason = `Not run: the fatal '${fatalTier}' tier failed, so any result here would describe that failure rather than this tier.`;
        reportTiers.push(entry);
        continue;
      }

      if (tier.modelBased) {
        Object.assign(entry, this.evaluateModelTier(tier, runtimeInput.modelReview));
        reportTiers.push(entry);
        continue;
      }

      if (tier.kind === 'scope') {
        Object.assign(entry, this.evaluateScopeTier(tier, runtimeInput.changedFiles));
        reportTiers.push(entry);
        continue;
      }

      for (const check of tier.checks) {
        const result = this.runner.runCheck(check.name, check.command, check.timeoutMs);
        result.tier = tier.id;
        result.role = check.role;
        if (check.requirementId) result.requirementId = check.requirementId;
        entry.checks.push(result);
        checksRun += 1;
        if (result.status === 'PASS') checksPassed += 1;
        else failedChecks.push(result.name);
      }

      const anyFailed = entry.checks.some((c) => c.status === 'FAIL');
      if (anyFailed) {
        entry.status = 'FAIL';
        if (tier.fatal) fatalTier = tier.id;
      } else if (Array.isArray(tier.unevaluatedRequirements) && tier.unevaluatedRequirements.length > 0) {
        // Every executable requirement check passed, but some requirements had none. Reporting the
        // tier as PASS would claim satisfaction for requirements nothing evaluated.
        entry.status = 'UNRESOLVED';
        entry.unevaluatedRequirements = tier.unevaluatedRequirements;
      } else if (entry.checks.length === 0) {
        entry.status = 'UNRESOLVED';
        entry.reason = 'Tier resolved but contributed no runnable check.';
      } else {
        entry.status = 'PASS';
      }
      reportTiers.push(entry);
    }

    const requiredTiers = reportTiers.filter((t) => t.required);
    const requiredFailed = requiredTiers.filter((t) => t.status === 'FAIL');
    const requiredUnverified = requiredTiers.filter((t) => t.status === 'UNRESOLVED' || t.status === 'NOT_RUN');
    const evaluated = reportTiers.filter((t) => t.status === 'PASS' || t.status === 'FAIL');
    const modelTier = reportTiers.find((t) => t.modelBased);

    let status;
    let reason;
    if (evaluated.length === 0) {
      // The empty-contract defect, generalized: zero evaluated tiers is a verdict over zero
      // evidence whether the contract was empty or every tier turned out unresolvable.
      status = 'INCONCLUSIVE';
      reason = contract.tiers.every((t) => t.resolution === 'SKIPPED')
        ? 'Contract declared no checks; nothing was verified'
        : 'No tier produced a result; nothing was verified';
    } else if (requiredFailed.length > 0) {
      status = 'FAIL';
      reason = `Required tier(s) failed: ${requiredFailed.map((t) => t.id).join(', ')}.`;
    } else if (modelTier && modelTier.status === 'FAIL') {
      // A model review can lower the verdict but never raise it — checked after the deterministic
      // tiers so it is never the thing that established correctness.
      status = 'FAIL';
      reason = 'Model-based review reported a failure.';
    } else if (requiredUnverified.length > 0) {
      status = 'INCONCLUSIVE';
      reason = `Required tier(s) were never evaluated: ${requiredUnverified.map((t) => t.id).join(', ')}.`;
    } else {
      status = 'PASS';
      reason = 'Every required tier passed.';
    }

    const requirementTier = reportTiers.find((t) => t.kind === 'requirement');
    const scopeTier = reportTiers.find((t) => t.kind === 'scope');

    return {
      version: contract.version,
      taskId: contract.taskId,
      riskLevel: contract.riskLevel,
      status,
      reason,
      startedAt,
      finishedAt: this.timestamp(),
      tiers: reportTiers,
      failedChecks,
      counts: {
        checksRun,
        checksPassed,
        checksFailed: checksRun - checksPassed,
        tiersRequired: requiredTiers.length,
        tiersPassed: requiredTiers.filter((t) => t.status === 'PASS').length,
        tiersFailed: requiredFailed.length,
        tiersUnverified: requiredUnverified.length,
        tiersNotApplicable: requiredTiers.filter((t) => t.status === 'NOT_APPLICABLE' || t.status === 'SUBSUMED').length,
      },
      requirementSatisfaction: requirementTier
        ? {
          status: requirementTier.status,
          satisfied: requirementTier.checks.filter((c) => c.status === 'PASS').map((c) => c.requirementId || c.name),
          failed: requirementTier.checks.filter((c) => c.status === 'FAIL').map((c) => c.requirementId || c.name),
          unevaluated: (requirementTier.unevaluatedRequirements || []).map((r) => r.id),
        }
        : null,
      scope: scopeTier ? scopeTier.scope || { status: scopeTier.status, reason: scopeTier.reason } : null,
      modelReview: modelTier
        ? { status: modelTier.status, primaryProof: false, findings: modelTier.findings || [] }
        : null,
      unresolved: reportTiers
        .filter((t) => t.status === 'UNRESOLVED' || t.status === 'NOT_RUN')
        .map((t) => ({ tier: t.id, required: t.required, reason: t.reason })),
      // A PASS reached with several tiers declared inapplicable is still a PASS, but a reader who
      // cannot see which tiers never ran will over-read it. Listed next to the verdict, not buried.
      notApplicable: reportTiers
        .filter((t) => t.status === 'NOT_APPLICABLE' || t.status === 'SUBSUMED')
        .map((t) => ({ tier: t.id, status: t.status, reason: t.reason })),
      detection: contract.detection,
    };
  }

  /** @private */
  evaluateModelTier(tier, modelReview) {
    if (!modelReview || typeof modelReview.status !== 'string') {
      return {
        status: 'UNRESOLVED',
        reason: 'No model review was supplied for a risk level that requires one to be recorded.',
        findings: [],
      };
    }
    const supplied = modelReview.status.toUpperCase();
    if (supplied === 'FAIL') {
      return { status: 'FAIL', reason: 'Model review reported findings.', findings: toStringArray(modelReview.findings) };
    }
    if (supplied === 'PASS') {
      // Recorded as PASS for the tier, but the overall verdict already required every deterministic
      // tier to pass before reaching here — this never becomes the proof of anything on its own.
      return { status: 'PASS', reason: 'Model review recorded no findings; advisory only.', findings: [] };
    }
    return {
      status: 'UNRESOLVED',
      reason: `Model review status '${modelReview.status}' is neither PASS nor FAIL.`,
      findings: toStringArray(modelReview.findings),
    };
  }

  /** @private */
  evaluateScopeTier(tier, changedFiles) {
    const bound = tier.bound || { maxFiles: null, allowedPaths: [] };
    const { files, reason } = this.observeChangedFiles(changedFiles);
    if (files === null) {
      return {
        status: 'UNRESOLVED',
        reason,
        scope: { bound, actual: null, withinBound: null, reason },
      };
    }

    const violations = [];
    if (Number.isFinite(bound.maxFiles) && files.length > bound.maxFiles) {
      violations.push(`${files.length} files changed, bound was ${bound.maxFiles}`);
    }
    if (bound.allowedPaths.length > 0) {
      const outside = files.filter((f) => !bound.allowedPaths.some((p) => f === p || f.startsWith(p.endsWith('/') ? p : `${p}/`)));
      if (outside.length > 0) violations.push(`outside the declared paths: ${outside.join(', ')}`);
    }

    const withinBound = violations.length === 0;
    return {
      status: withinBound ? 'PASS' : 'FAIL',
      reason: withinBound ? null : `Change exceeded its declared scope — ${violations.join('; ')}.`,
      scope: { bound, actual: { fileCount: files.length, files }, withinBound, violations },
    };
  }

  /**
   * Declares completion. FR-009: a task is complete only when its required checks pass, or when the
   * user explicitly accepts what is still failing.
   *
   * @param {Object} report
   * @param {Object} [acceptance]
   * @param {boolean} [acceptance.userAccepted]
   * @param {string} [acceptance.acceptedBy] who accepted; an unattributed acceptance is refused
   * @param {string} [acceptance.note]
   * @returns {{ complete: boolean, basis: string, reason: string, acceptedFailures?: Array<Object> }}
   */
  declareCompletion(report, acceptance = {}) {
    if (!report || typeof report.status !== 'string') {
      throw new Error('declareCompletion expects a report produced by runContract');
    }
    if (report.status === 'PASS') {
      return { complete: true, basis: 'required-checks-passed', reason: report.reason };
    }
    if (acceptance.userAccepted !== true) {
      return {
        complete: false,
        basis: 'not-accepted',
        reason: `Verification is ${report.status}: ${report.reason} Completion needs the required checks to pass or an explicit user acceptance.`,
      };
    }
    const requiresAccepter = (this.policy.completion || {}).overrideRequiresAccepter !== false;
    if (requiresAccepter && (typeof acceptance.acceptedBy !== 'string' || acceptance.acceptedBy.trim() === '')) {
      // "The user explicitly accepts" needs a user. An anonymous flag is indistinguishable from the
      // caller setting it for itself.
      return {
        complete: false,
        basis: 'acceptance-unattributed',
        reason: 'Accepting a failing verification requires naming who accepted it.',
      };
    }
    return {
      complete: true,
      basis: 'user-accepted-failures',
      reason: acceptance.note || `Accepted by ${acceptance.acceptedBy} while ${report.status}.`,
      acceptedFailures: (report.tiers || [])
        .filter((t) => t.required && t.status !== 'PASS' && t.status !== 'NOT_APPLICABLE' && t.status !== 'SUBSUMED' && t.status !== 'SKIPPED')
        .map((t) => ({ tier: t.id, status: t.status, reason: t.reason })),
    };
  }

  /**
   * A stable fingerprint of what failed. Two identical fingerprints across attempts mean the retry
   * changed nothing observable, which FR-010 forbids as a response.
   * @param {Object} report
   * @returns {string}
   */
  failureSignature(report) {
    const failed = [...(report.failedChecks || [])].sort().join('|');
    const unresolved = (report.unresolved || []).map((u) => u.tier).sort().join('|');
    return `${report.status}::${failed}::${unresolved}`;
  }

  /**
   * Classifies a failing report and returns the targeted action for that class (C8), bounded by the
   * risk level's retry limit.
   *
   * @param {Object} report
   * @param {Object} [options]
   * @param {number} [options.iteration=0] retries already spent
   * @param {string} [options.lastAgent]
   * @param {number} [options.maxIterations] defaults to the report's risk level
   * @returns {Object|null} null when there is nothing to recover from
   */
  planRecovery(report, options = {}) {
    if (!report || report.status === 'PASS') return null;

    const maxIterations = Number.isInteger(options.maxIterations)
      ? options.maxIterations
      : this.riskDefinition(report.riskLevel).maxRecoveryIterations;
    const manager = this.recoveryOverride || new RecoveryManager({ maxIterations });

    const failingTier = (report.tiers || []).find((t) => t.required && t.status === 'FAIL')
      || (report.tiers || []).find((t) => t.status === 'FAIL');
    const unverifiedTier = (report.tiers || []).find((t) => t.required && (t.status === 'UNRESOLVED' || t.status === 'NOT_RUN'));

    let failureClass;
    let classificationSource;
    let errorMessage;
    let hint = null;

    if (failingTier) {
      const firstFailure = (failingTier.checks || []).find((c) => c.status === 'FAIL');
      errorMessage = [failingTier.reason, firstFailure && firstFailure.error, firstFailure && firstFailure.stderr]
        .filter(Boolean)
        .join(' ');
      // A tier's declared class is structural evidence about what kind of check failed; the keyword
      // classifier reads prose. recovery.js already prefers structure over prose between check
      // names and error text, and this applies the same precedence one level up. The classifier
      // still runs and is reported, so a disagreement stays visible rather than being hidden.
      const classified = manager.classifyFailure(errorMessage, report.failedChecks);
      failureClass = failingTier.failureClass || classified;
      classificationSource = failingTier.failureClass ? 'tier-declaration' : 'classifier';
      if (failingTier.failureClass && failingTier.failureClass !== classified) {
        hint = `Keyword classifier suggested ${classified}; the '${failingTier.id}' tier declares ${failingTier.failureClass}.`;
      }
    } else if (unverifiedTier) {
      errorMessage = unverifiedTier.reason || 'A required verification tier was never evaluated.';
      failureClass = this.policy.unresolvedDetectionFailureClass || manager.classifyFailure(errorMessage, []);
      classificationSource = 'unresolved-tier';
      hint = `Nothing verified the '${unverifiedTier.id}' tier. Declare its command in plan.md's \`${this.policy.planOverrideBlock}\` block, or set it to null to state the project has none.`;
    } else {
      errorMessage = report.reason || 'Verification did not pass.';
      failureClass = manager.classifyFailure(errorMessage, report.failedChecks);
      classificationSource = 'classifier';
    }

    const plan = manager.planRecovery(failureClass, options.iteration || 0, options.lastAgent);
    return {
      ...plan,
      classificationSource,
      maxIterations,
      errorMessage,
      hint,
      reportStatus: report.status,
      failureSignature: this.failureSignature(report),
    };
  }

  /**
   * Runs a contract and, on failure, drives the bounded recovery loop.
   *
   * `remediate` must report that it changed something. FR-010 forbids re-running unchanged
   * behaviour, so a remediation that returns `changed !== true` stops the loop instead of producing
   * a second identical attempt, and an attempt whose failure fingerprint repeats stops it too — a
   * change that altered nothing observable is the same thing wearing a different hat.
   *
   * @param {Object} contract
   * @param {Object} [options]
   * @param {Function} [options.remediate] `(plan, report, iteration) => {changed: boolean, contract?}`
   * @param {string} [options.lastAgent]
   * @param {Object} [options.runtimeInput] forwarded to each `runContract`
   * @returns {{ outcome: string, report: Object, plan: Object|null, attempts: Array<Object>, reason: string }}
   */
  runWithRecovery(contract, options = {}) {
    let current = contract;
    let lastAgent = options.lastAgent;
    let previousSignature = null;
    let iteration = 0;
    const attempts = [];

    for (;;) {
      const report = this.runContract(current, options.runtimeInput || {});
      const signature = this.failureSignature(report);
      attempts.push({ iteration, status: report.status, signature, failedChecks: report.failedChecks });

      if (report.status === 'PASS') {
        return { outcome: 'PASS', report, plan: null, attempts, reason: report.reason };
      }
      if (signature === previousSignature) {
        return {
          outcome: 'NO_PROGRESS',
          report,
          plan: null,
          attempts,
          reason: 'The previous recovery reported a change but produced an identical failure; retrying again would repeat unchanged behaviour.',
        };
      }
      previousSignature = signature;

      const plan = this.planRecovery(report, { iteration, lastAgent });
      if (!plan.canRetry) {
        return { outcome: 'ABORTED', report, plan, attempts, reason: plan.reason };
      }
      if (typeof options.remediate !== 'function') {
        return {
          outcome: 'NO_REMEDIATION',
          report,
          plan,
          attempts,
          reason: `Recovery action ${plan.action} is available but no remediation callback was supplied.`,
        };
      }

      const outcome = options.remediate(plan, report, iteration);
      if (!outcome || outcome.changed !== true) {
        return {
          outcome: 'NO_CHANGE',
          report,
          plan,
          attempts,
          reason: `Remediation for ${plan.failureClass} reported no change; re-running unchanged behaviour is not a permitted response.`,
        };
      }
      if (outcome.contract) current = outcome.contract;
      lastAgent = plan.agent;
      iteration += 1;
    }
  }

  /**
   * Convenience: compile, run, and report in one call. The two halves stay separately callable
   * because FR-009 requires the contract to exist *before* implementation, which this shape cannot
   * express on its own.
   * @param {Object} input `compileContract` input
   * @param {Object} [runtimeInput] `runContract` input
   */
  verify(input, runtimeInput) {
    const contract = this.compileContract(input);
    return { contract, report: this.runContract(contract, runtimeInput) };
  }
}

/**
 * Handles `doflow verify` — compile the verification contract (FR-009) and, by default, run it and
 * report against it.
 *
 * `--action contract` stops after compiling, which is the before-implementation half: it states
 * how success will be established without establishing anything. The default runs the checks and
 * emits the report. The contract is recompiled rather than read back from a state file, so the two
 * halves cannot describe different contracts.
 *
 * @param {Object} options
 * @param {string} options.taskId
 * @param {'report'|'contract'|'status'} [options.action='report']
 * @param {string} [options.risk] risk level; the registry's default when omitted
 * @param {string} [options.planPath] a `plan.md` whose command override beats detection
 * @param {boolean} [options.json=false]
 * @param {string} [options.projectRoot]
 * @returns {number} exit code
 */
function handleVerifyCommand({ taskId, action = 'report', risk, planPath, json = false, projectRoot } = {}) {
  const cwd = projectRoot || process.cwd();
  let engine;
  let contract;
  try {
    engine = new VerificationEngine({ cwd, repoRoot: REPO_ROOT });
    contract = engine.compileContract({ taskId, riskLevel: risk, projectRoot: cwd, planPath });
  } catch (error) {
    return usageError('verify', error.message, json);
  }

  if (action === 'contract') {
    if (json) console.log(JSON.stringify(contract, null, 2));
    else {
      console.log(`\nDoFlow Verification Contract [${contract.taskId}] — risk ${contract.riskLevel}:`);
      console.log('═'.repeat(78));
      for (const tier of contract.tiers) {
        console.log(`  ${tier.id.padEnd(22)} ${tier.resolution.padEnd(12)} ${tier.required ? 'required' : 'advisory'}`);
        if (tier.reason) console.log(`      ${tier.reason}`);
      }
      console.log('═'.repeat(78) + '\n');
    }
    // A contract is a plan, not a verdict — compiling one always answers, even when a tier could
    // not be resolved, because the unresolved tier is itself part of what the contract states.
    return finishRuntime(0);
  }
  if (action !== 'report' && action !== 'status') {
    return usageError('verify', `unknown --action '${action}'. Valid: report (default), contract`, json);
  }

  const report = engine.runContract(contract);
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`\nDoFlow Verification Report [${report.taskId}] — ${report.status}:`);
    console.log('═'.repeat(78));
    console.log(report.reason);
    console.log('─'.repeat(78));
    for (const tier of report.tiers) {
      console.log(`  ${tier.id.padEnd(22)} ${tier.status.padEnd(16)} ${tier.required ? 'required' : 'advisory'}`);
      if (tier.reason) console.log(`      ${tier.reason}`);
    }
    console.log('─'.repeat(78));
    console.log(`Checks: ${report.counts.checksPassed}/${report.counts.checksRun} passed`);
    if (report.unresolved.length) {
      console.log('Never evaluated (not a pass):');
      for (const u of report.unresolved) console.log(`  ${u.tier}${u.required ? ' [required]' : ''} — ${u.reason}`);
    }
    console.log('═'.repeat(78) + '\n');
  }
  // PASS is the only status that answers "verified". FAIL and INCONCLUSIVE are both findings, and
  // collapsing INCONCLUSIVE into success would report a verdict over zero evidence as a pass.
  return finishRuntime(report.status === 'PASS' ? 0 : 1);
}

module.exports = {
  VerificationContractRunner,
  VerificationEngine,
  loadVerificationRegistry,
  VERIFICATION_STATUSES,
  TIER_RESOLUTIONS,
  TIER_STATUSES,
  RECOVERY_OUTCOMES,
  FATAL_CHECK_MARKERS,
  TIMEOUT_EXIT_CODE,
  MAX_STREAM_CHARS,
  REGISTRY_FILENAME,
  handleVerifyCommand,
};
