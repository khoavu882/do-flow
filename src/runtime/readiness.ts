'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const { parseYamlFile } = require('./capability-router.ts');
const { resolveLocator, describeResolution } = require('./locator-resolve.ts');
const { readPlan, bindEvidence, declaredIntentList } = require('./retrieval-record.ts');
const { REPO_ROOT } = require('../helper/repo-root.ts');

const READINESS_STATES = new Set([
  'READY',
  'NEEDS_EVIDENCE',
  'NEEDS_USER_DECISION',
  'BLOCKED',
]);

// ── The one stage-entry policy ───────────────────────────────────────────────────────────────────
//
// Whether a readiness state permits editing used to live in prose, three times, disagreeing:
// do-implement allowed edits under NEEDS_EVIDENCE and NEEDS_USER_DECISION, do-flow stopped on
// anything but READY, and readiness_gate.md said gather-or-ask first — so entering the same work
// through different skills changed whether unresolved prerequisites blocked editing (review R3,
// P1). The policy now lives here, once; skills consume the decision instead of re-deriving it.
//
// The standalone exemption is an explicit execution mode, not an inference from a missing evidence
// record: a caller doing a deliberate one-off fix passes `--mode standalone`, and only the
// NEEDS_EVIDENCE row softens for it — an owed user decision or contradicting evidence stops edits
// in every mode, because neither is cured by the work being small.

const EXECUTION_MODES = new Set(['workflow', 'standalone']);
const STAGE_ENTRY_DECISIONS = new Set(['ENTER', 'GATHER_FIRST', 'ASK_USER', 'STOP']);

/**
 * Maps a computed readiness state and a declared execution mode to the one stage-entry decision.
 * @param {string} state one of READINESS_STATES
 * @param {string} [mode='workflow'] 'workflow' | 'standalone'
 * @returns {{decision: string, reason: string}}
 */
function stageEntryFor(state: any, mode = 'workflow') {
  if (!EXECUTION_MODES.has(mode)) {
    throw new Error(`Unknown execution mode '${mode}'. Valid: ${[...EXECUTION_MODES].join(', ')} — the standalone exemption is declared, never inferred.`);
  }
  if (!READINESS_STATES.has(state)) {
    throw new Error(`Unknown readiness state '${state}' has no stage-entry decision.`);
  }
  switch (state) {
    case 'BLOCKED':
      return { decision: 'STOP', reason: 'A claim on this task is conflicted — evidence disagrees with itself. No mode edits through that; resolve the contradiction first.' };
    case 'NEEDS_USER_DECISION':
      return { decision: 'ASK_USER', reason: 'A decision is owed by the user. Ask it and wait; editing first would decide it silently on their behalf.' };
    case 'NEEDS_EVIDENCE':
      return mode === 'standalone'
        ? { decision: 'ENTER', reason: 'Standalone mode: the unmet contract is reported, not enforced — a declared one-off edit outside a workflow run. Relay the missing requirements in the result.' }
        : { decision: 'GATHER_FIRST', reason: 'Workflow mode: gather the missing requirements before entering the stage; do not start editing on the assumption it will work out.' };
    case 'READY':
    default:
      return { decision: 'ENTER', reason: 'Every mandatory prerequisite is verified by fresh evidence.' };
  }
}

class ReadinessEngine {
  declare fsImpl: any;
  declare repoRoot: any;
  declare projectRoot: any;
  declare templatePath: any;
  declare templates: any;
  /**
   * @param {Object} [options]
   * @param {string} [options.repoRoot] the DoFlow install, where readiness-templates.json lives
   * @param {string} [options.projectRoot] the repository under work, which evidence locators name.
   *   Distinct from repoRoot on purpose: when the CLI runs inside another project, the templates
   *   come from the install and the locators must be resolved against that project, not the install.
   * @param {string} [options.templatePath]
   * @param {Object} [options.templates]
   * @param {Object} [options.fsImpl]
   */
  constructor(options: any = {}) {
    this.fsImpl = options.fsImpl || fs;
    this.repoRoot = options.repoRoot || REPO_ROOT;
    this.projectRoot = options.projectRoot || process.cwd();
    this.templatePath = options.templatePath || path.join(this.repoRoot, 'core', 'registry', 'readiness-templates.json');

    if (options.templates) {
      this.templates = options.templates;
    } else {
      this.loadTemplates();
    }
  }

  loadTemplates() {
    try {
      const data = parseYamlFile(this.templatePath, this.fsImpl);
      this.templates = data.templates || {};
    } catch (error: any) {
      throw new Error(`Failed to load readiness templates from '${this.templatePath}': ${error.message}`);
    }
  }

  /**
   * Suggests retrieval actions when an evidence requirement is missing.
   * @param {string} reqId
   * @param {Object} reqDef
   * @param {Object} taskProfile
   * @returns {Object}
   */
  suggestAction(reqId: any, reqDef: any, taskProfile: any) {
    if (reqId === 'root_cause') {
      return {
        intent: 'trace-dependency',
        capability: 'code.relationships',
        action: 'Query structural call graphs or inspect git history to establish root cause evidence for the bug.',
      };
    }
    if (reqId === 'affected_code' || reqId === 'target_identified') {
      return {
        intent: 'locate-known-symbol',
        capability: 'code.exact-search',
        action: 'Perform exact symbol or file search to record target code locators.',
      };
    }
    if (reqId === 'blast_radius' || reqId === 'architecture_mapped') {
      return {
        intent: 'estimate-blast-radius',
        capability: 'code.impact-analysis',
        action: 'Query caller trees and dependent modules using Graphify or exact search.',
      };
    }
    if (reqId === 'reproduction' || reqId === 'baseline_tests') {
      return {
        intent: 'verify-runtime-behavior',
        capability: 'behavior.verify',
        action: 'Execute automated tests or record runtime observation reproducing the behavior.',
      };
    }
    // These are satisfied by what the caller states, not by retrieved evidence (evaluateReadiness),
    // so the action names the flag that states it (--scope / --invariants, cli/index.ts).
    if (reqId === 'scope_clear' || reqId === 'scope_verified') {
      return {
        intent: 'locate-concept',
        capability: 'code.semantic-search',
        action: `State the scope boundary for requirement '${reqId}' (${reqDef.description}): pass --scope "<boundary>" when evaluating readiness.`,
      };
    }
    if (reqId === 'invariants_captured') {
      return {
        intent: 'locate-concept',
        capability: 'code.semantic-search',
        action: `State the invariants the change must preserve for requirement '${reqId}' (${reqDef.description}): pass --invariants "<invariants>" when evaluating readiness.`,
      };
    }
    return {
      intent: 'locate-concept',
      capability: 'code.semantic-search',
      action: `Gather evidence for requirement '${reqId}' (${reqDef.description}).`,
    };
  }

  /**
   * Evaluates task readiness against a declarative template.
   * @param {Object} taskProfile
   * @param {string} taskProfile.taskId
   * @param {'bug'|'feature'|'refactor'|'trivial-edit'|'dependency-change'} [taskProfile.taskClass='feature']
   * @param {string} [taskProfile.description]
   * @param {string} [taskProfile.verificationPlan]
   * @param {boolean} [taskProfile.userDecisionPending=false]
   * @param {Object} evidenceLedger
   * @param {Object} claimsManager
   * @returns {Object} ReadinessReport
   */
  evaluateReadiness(taskProfile: any, evidenceLedger: any, claimsManager: any) {
    if (!taskProfile || typeof taskProfile !== 'object') {
      throw new Error('taskProfile must be an object');
    }

    // Fail closed on identity, for the same reason the unrecognized-requirement branch below does.
    // These previously defaulted to `'default'` and `'feature'`, which meant a caller passing `id`
    // instead of `taskId` — an easy slip, and one that actually happened while writing
    // test/runtime/runtime-claim-status.test.js — got a confident READY/NEEDS_EVIDENCE verdict computed
    // from an unrelated task's evidence and claims. A gate must never answer about something it did
    // not evaluate; reported independently by three separate reviews of this runtime before being
    // fixed here.
    if (typeof taskProfile.taskId !== 'string' || taskProfile.taskId.trim() === '') {
      const nearMiss = ['id', 'task_id', 'taskID'].find((k) => taskProfile[k] !== undefined);
      throw new Error(
        `taskProfile.taskId is required to evaluate readiness${nearMiss ? ` (received '${nearMiss}' instead)` : ''}` +
          ' — readiness is evaluated against one task\'s evidence and claims, so guessing the id would grade the wrong task.',
      );
    }
    if (typeof taskProfile.taskClass !== 'string' || taskProfile.taskClass.trim() === '') {
      throw new Error(
        `taskProfile.taskClass is required to evaluate readiness. Available: ${Object.keys(this.templates).join(', ')}`,
      );
    }

    const taskId = taskProfile.taskId;
    const taskClass = taskProfile.taskClass;
    const template = this.templates[taskClass];

    if (!template) {
      throw new Error(`Unknown task class '${taskClass}'. Available: ${Object.keys(this.templates).join(', ')}`);
    }

    const requirements = template.requirements || {};
    const requirementResults = [];
    let allSatisfied = true;
    let hasBlocked = false;

    // Check for user decision gate
    if (taskProfile.userDecisionPending) {
      return {
        taskId,
        taskClass,
        state: 'NEEDS_USER_DECISION',
        templateName: template.name,
        summary: 'Task requires explicit user approval on an architectural or design decision.',
        satisfiedRequirements: [],
        missingRequirements: [],
        claimsSummary: { supported: 0, hypotheses: 0, conflicts: 0 },
      };
    }

    // Inspect claims
    const taskClaims = claimsManager ? claimsManager.getClaims(taskId) : [];
    const conflictedClaims = taskClaims.filter((c: any) => c.status === 'conflicted');
    if (conflictedClaims.length > 0) {
      hasBlocked = true;
    }

    const allTaskEvidence = evidenceLedger ? evidenceLedger.queryEvidence({ taskId }) : [];
    let plan = null;
    let unreadablePlan = null;
    try {
      plan = readPlan(this.projectRoot, taskId);
    } catch (error: any) {
      if (error.code !== 'store-unreadable') throw error;
      unreadablePlan = { unreadable: true, reason: error.message };
    }
    const queryBound = Boolean(plan?.planId);
    const binding = queryBound ? bindEvidence(plan, allTaskEvidence) : null;
    const unboundIds = new Set(binding ? binding.unbound.map((item: any) => item.id) : []);
    // A superseded item is retired: it neither satisfies a requirement nor can it be unresolvable
    // (the stale check below already skips it), so nothing else can be left that clears it.
    const taskEvidence = allTaskEvidence.filter((item: any) => item.freshness?.status === 'FRESH'
      && item.status !== 'superseded'
      && (!queryBound || !unboundIds.has(item.id)));

    // An item accepted before FR-004 existed, or one whose target file has since shrunk, can be
    // FRESH and still point at nothing. *Stale* (the file changed at all) and *unresolvable* (the
    // locator no longer names anything) are different verdicts and must not be collapsed: a stale
    // item is still checkable by a human, an unresolvable one is not (FR-005).
    // Stale and unresolvable are different failures and are reported apart: an unresolvable
    // locator points at nothing, a stale one points at something that changed since it was read.
    // A superseded item is excluded here, not from getAllEvidence(): superseding is a recorded
    // human judgment that this specific item no longer needs re-checking (a fresher item already
    // covers the same ground), the same way a retracted/superseded claim stops being read as live
    // in evaluateClaim — it is not a claim that the file never changed. An item that genuinely went
    // stale and was never superseded still forces NEEDS_EVIDENCE exactly as before.
    const staleEvidence = (evidenceLedger ? evidenceLedger.getAllEvidence() : [])
      .filter((item: any) => item.taskId === taskId && item.result !== 'EMPTY'
        && item.freshness?.status === 'STALE' && item.status !== 'superseded')
      .map((item: any) => ({ evidenceId: item.id, locator: item.locator, reason: 'file-modified-since-recorded' }));

    const unresolvableEvidence = [];
    for (const item of taskEvidence) {
      if (item.provenance !== 'extracted' || !item.locator || !item.locator.file) continue;
      const resolution = resolveLocator({ locator: item.locator, repoRoot: this.projectRoot });
      if (!resolution.resolved) {
        unresolvableEvidence.push({
          evidenceId: item.id,
          locator: item.locator,
          reason: resolution.reason,
          detail: describeResolution(item.locator, resolution),
        });
      }
    }

    const staleAbsence = [];
    const staleAbsenceByRequirement = new Map<string, any[]>();
    for (const item of allTaskEvidence) {
      if (item.result !== 'EMPTY' || item.status !== 'active'
          || !['STALE', 'UNKNOWN'].includes(item.freshness?.status)
          || (queryBound && unboundIds.has(item.id))) continue;
      for (const requirement of Array.isArray(item.establishes) ? item.establishes : []) {
        const entry = { evidenceId: item.id, requirement, provider: item.source?.provider || null,
          freshness: item.freshness.status, refresh: plan?.providers?.[item.source?.provider]?.refresh || null };
        staleAbsence.push(entry);
        const entries = staleAbsenceByRequirement.get(requirement) || [];
        entries.push({ item, entry });
        staleAbsenceByRequirement.set(requirement, entries);
      }
    }

    const unboundEvidence = queryBound
      ? { count: binding.unbound.length, ids: binding.unbound.slice(0, 5).map((item: any) => item.id) }
      : undefined;

    for (const [reqId, reqDef] of Object.entries<any>(requirements)) {
      let isSatisfied = false;
      let reason = null;
      let reasonCode = null;
      let matchedEvidenceIds = [];

      // Check verification plan requirement
      if (reqId === 'regression_verification' || reqId === 'verification_plan' || reqId === 'verification_command') {
        if (taskProfile.verificationPlan || taskProfile.verificationCommand) {
          isSatisfied = true;
        } else {
          reason = 'No verification command or test execution plan defined in task profile.';
        }
      }
      // Check claim status requirement (e.g. root_cause). A template can additionally demand a
      // claim *role*: `root_cause` is only established by a claim declared as the root-cause claim,
      // not by any supported claim the task happens to hold (review R1 — a supported claim about an
      // unrelated invariant satisfied the bug template's root-cause requirement).
      else if (reqDef.requiresClaimStatus) {
        // A `supported` claim counts only while at least one of its supporting items is live
        // (active, FRESH, bound) in `taskEvidence`: support that was superseded, went stale or is
        // unbound no longer backs it (107-B review C-1). Other statuses are not evidence-backed.
        const liveEvidenceIds = new Set(taskEvidence.map((item: any) => item.id));
        const statusMatched = taskClaims.filter((c: any) => c.status === reqDef.requiresClaimStatus);
        const hasLiveSupport = (c: any) => reqDef.requiresClaimStatus !== 'supported'
          || (c.supportingEvidence || []).some((id: string) => liveEvidenceIds.has(id));
        // A claim whose stored status still reads `supported` but whose support was retired is
        // named as such, so the user is not told to add a supported claim they can already see.
        const retired = statusMatched.filter((c: any) => !hasLiveSupport(c)
          && (!reqDef.requiresClaimRole || c.role === reqDef.requiresClaimRole));
        let matchingClaims = statusMatched.filter(hasLiveSupport);
        if (reqDef.requiresClaimRole) {
          const withRole = matchingClaims.filter((c: any) => c.role === reqDef.requiresClaimRole);
          if (withRole.length === 0 && matchingClaims.length > 0) {
            reason = `${matchingClaims.length} claim(s) have status '${reqDef.requiresClaimStatus}' but none `
              + `declares role '${reqDef.requiresClaimRole}' — add the claim with --role ${reqDef.requiresClaimRole}, `
              + 'or re-state which claim answers this requirement.';
          }
          matchingClaims = withRole;
        }
        if (matchingClaims.length > 0) {
          isSatisfied = true;
          matchedEvidenceIds = matchingClaims.flatMap((c: any) => c.supportingEvidence);
        } else if (!reason && retired.length > 0) {
          reasonCode = 'claim-support-retired';
          reason = `${retired.length} claim(s) with status '${reqDef.requiresClaimStatus}'`
            + `${reqDef.requiresClaimRole ? ` and role '${reqDef.requiresClaimRole}'` : ''} have no live supporting `
            + `evidence (${retired.slice(0, 5).map((c: any) => c.id).join(', ')}): each supporting item was superseded, `
            + 'went stale or is not bound to the task plan. Link a fresh item with `claim --action link` and re-evaluate.';
        } else if (!reason) {
          reason = `Requires at least one claim with status '${reqDef.requiresClaimStatus}'`
            + `${reqDef.requiresClaimRole ? ` and role '${reqDef.requiresClaimRole}'` : ''}.`;
        }
      }
      // Check evidence kind requirement. Kind alone is a category, not an outcome: to count, an
      // item must also (a) be an extracted read rather than a model inference, (b) explicitly name
      // this requirement in `establishes`, and (c) where the template demands an execution, carry a
      // typed observation whose exit status matches. Before these checks, an inferred item reading
      // "Baseline tests failed: 12 failures." satisfied `baseline_tests` by being kind test-result
      // (review R1, P1 — reproduced through the public CLI).
      else if (Array.isArray(reqDef.evidenceKinds) && reqDef.evidenceKinds.length > 0) {
        const allowedKinds = new Set(reqDef.evidenceKinds);
        const rawKindMatched = allTaskEvidence.filter((ev: any) => allowedKinds.has(ev.kind));
        const kindMatched = taskEvidence.filter((ev: any) => allowedKinds.has(ev.kind));
        const extracted = kindMatched.filter((ev: any) => ev.provenance === 'extracted');
        const bound = extracted.filter((ev: any) => Array.isArray(ev.establishes) && ev.establishes.includes(reqId));
        const observationOk = (ev: any) => !reqDef.requiresObservation || (ev.observation
          && Number.isInteger(ev.observation.exitCode)
          && (reqDef.expectedExit !== 'zero' || ev.observation.exitCode === 0)
          && (reqDef.expectedExit !== 'nonzero' || ev.observation.exitCode !== 0));
        const qualifies = (ev: any) => ev.provenance === 'extracted'
          && Array.isArray(ev.establishes) && ev.establishes.includes(reqId)
          && observationOk(ev);
        const qualifying = taskEvidence.filter((ev: any) => allowedKinds.has(ev.kind) && qualifies(ev));
        if (qualifying.length > 0) {
          isSatisfied = true;
          matchedEvidenceIds = qualifying.map((ev: any) => ev.id);
        } else if (kindMatched.length === 0) {
          reason = `Missing fresh evidence of kind: ${reqDef.evidenceKinds.join(', ')}.`;
        } else if (extracted.length === 0) {
          reason = `${kindMatched.length} item(s) of the right kind exist but none is 'extracted' — an inferred `
            + 'or asserted item is analysis, and analysis cannot establish a measured prerequisite.';
        } else if (bound.length === 0) {
          reason = `${extracted.length} extracted item(s) of the right kind exist but none declares it `
            + `establishes '${reqId}' — record evidence with establishes: ['${reqId}'] so the gate grades `
            + 'what the item was actually gathered to prove.';
        } else if (reqDef.expectedExit === 'zero' && bound.some((ev: any) => ev.observation && ev.observation.exitCode !== 0)) {
          const failed = bound.find((ev: any) => ev.observation && ev.observation.exitCode !== 0);
          reason = `The bound observation ran '${failed.observation.command}' and exited ${failed.observation.exitCode}; `
            + 'this requirement needs an exit status of 0. A failed run does not establish a passing baseline.';
        } else {
          reason = 'The bound evidence lacks a typed observation ({command, exitCode})'
            + `${reqDef.expectedExit ? ` with a${reqDef.expectedExit === 'zero' ? ' passing (0)' : ' non-zero'} exit status` : ''} — `
            + 'record the execution itself, not a description of one.';
        }
        if (!isSatisfied && reqDef.required) {
          const staleAbsences = staleAbsenceByRequirement.get(reqId) || [];
          if (staleAbsences.length > 0) {
            const { item, entry } = staleAbsences[0];
            const refresh = entry.refresh || 'none declared';
            reasonCode = 'stale-absence-unverified';
            const prefix = `'${reqId}' rests only on an empty answer from ${entry.provider || 'unknown provider'}, whose index was ${entry.freshness} when it was recorded (${item.id}). An empty answer from that index cannot establish absence. `;
            if (item.freshness?.staleReason === 'tree-changed-since-recorded'
                || item.freshness?.staleReason === 'tree-unverifiable') {
              reason = `${prefix}the working tree changed since it was recorded; re-run the lookup and record the absence again.`;
            } else if (item.freshness?.gitCommit === null) {
              reason = `${prefix}absence cannot be established outside a git work tree; record a positive item.`;
            } else {
              reason = `${prefix}Run the declared refresh command (${refresh}) and record the absence again, or re-run the lookup with a live provider such as native.rg: doflow evidence --task-id ${taskId} --action add --absence --need <intent> --provider native.rg ...`;
            }
          } else if (queryBound) {
            const unboundKind = rawKindMatched.filter((ev: any) => unboundIds.has(ev.id));
            const unboundQualifying = unboundKind.filter((ev: any) =>
              ev.freshness?.status === 'FRESH' && qualifies(ev));
            if (unboundQualifying.length > 0) {
              const ids = unboundQualifying.slice(0, 5).map((item: any) => item.id).join(', ');
              reasonCode = 'unbound-retrieval-evidence';
              reason = `${unboundQualifying.length} item(s) of the right kind are not bound to a declared need of plan ${plan.planId} (${ids}), so they do not count. Re-record them with --need <intent>; declared: ${declaredIntentList(plan)}.`;
            }
          }
        }
      }
      // Scope verified / scope clear
      else if (reqId === 'scope_clear' || reqId === 'scope_verified' || reqId === 'invariants_captured') {
        if (taskProfile.scopeClear || taskProfile.description || taskProfile.invariants) {
          isSatisfied = true;
        } else {
          reason = `Prerequisite '${reqId}' not documented.`;
        }
      } else {
        // Fail closed. A gate whose unrecognized requirements default to satisfied reports READY
        // for prerequisites it never actually evaluated — the one failure mode a readiness contract
        // exists to prevent. No shipped template reaches here today; a future one adding a
        // requirement without `evidenceKinds`/`requiresClaimStatus` should surface as unmet, not
        // silently pass.
        isSatisfied = false;
        reason = `Requirement '${reqId}' has no evaluator; treating as unmet.`;
      }

      if (!isSatisfied && reqDef.required) {
        allSatisfied = false;
      }

      requirementResults.push({
        id: reqId,
        description: reqDef.description,
        required: Boolean(reqDef.required),
        satisfied: isSatisfied,
        reason,
        reasonCode,
        evidenceIds: matchedEvidenceIds,
        recommendedAction: isSatisfied ? null : this.suggestAction(reqId, reqDef, taskProfile),
      });
    }

    let state = 'READY';
    let summary = 'All mandatory readiness prerequisites are verified by fresh evidence.';

    if (hasBlocked) {
      state = 'BLOCKED';
      summary = `Task is blocked by ${conflictedClaims.length} conflicted claim(s). Contradicting evidence must be resolved.`;
    } else if (!allSatisfied) {
      state = 'NEEDS_EVIDENCE';
      const missingCount = requirementResults.filter((r) => r.required && !r.satisfied).length;
      summary = `Task requires ${missingCount} additional evidence item(s) before implementation.`;
    }

    // FR-005. Applied after the base verdict so it can never be overwritten by it, and appended
    // rather than replacing, so a task that is short of evidence *and* holding an unresolvable
    // locator reports both. Not BLOCKED: nothing contradicts anything here — the record simply no
    // longer points at the repository, which is a different failure from evidence that disagrees
    // with itself. Naming the specific items is the requirement; a silent downgrade would leave the
    // reader to hunt for which item moved.
    if (staleEvidence.length > 0) {
      if (state === 'READY') state = 'NEEDS_EVIDENCE';
      summary += ` ${staleEvidence.length} evidence item(s) went stale: the files they name have `
        + 'changed since they were recorded. Re-record them against the tree as it stands.';
    }

    if (unresolvableEvidence.length > 0) {
      if (state === 'READY') state = 'NEEDS_EVIDENCE';
      summary += ` ${unresolvableEvidence.length} evidence item(s) have a locator that no longer `
        + `resolves: ${unresolvableEvidence.map((u) => u.detail).join('; ')}. `
        + 'Re-record them against the tree as it stands.';
    }

    if (unreadablePlan) {
      summary += ` Warning: retrieval plan is unreadable and was treated as absent: ${unreadablePlan.reason}`;
    }

    return {
      taskId,
      taskClass,
      state,
      templateName: template.name,
      summary,
      requirements: requirementResults,
      claimsSummary: {
        total: taskClaims.length,
        supported: taskClaims.filter((c: any) => c.status === 'supported').length,
        hypotheses: taskClaims.filter((c: any) => c.status === 'hypothesis').length,
        conflicts: conflictedClaims.length,
      },
      evidenceCount: taskEvidence.length,
      unresolvableEvidence,
      staleEvidence,
      staleAbsence,
      ...(unreadablePlan ? { retrievalPlan: unreadablePlan } : {}),
      ...(unboundEvidence ? { unboundEvidence } : {}),
    };
  }
}

/** One live snapshot for readiness inspection and orchestration transitions. Reads never persist
 * derived freshness or claim status; every invocation evaluates the current project again.
 * `mode` defaults to 'workflow' — fail closed: the standalone exemption must be declared. */
function evaluateTaskReadiness({ taskProfile, repoRoot = REPO_ROOT, projectRoot = process.cwd(), treeRoot = projectRoot, sourceRoot = projectRoot, mode = 'workflow' }: any) {
  // Validated before any ledger work, not just inside stageEntryFor at the end — an invalid mode
  // used to pay a full freshness/claims evaluation before erroring (review suggestion, 026).
  if (!EXECUTION_MODES.has(mode)) {
    throw new Error(`Unknown execution mode '${mode}'. Valid: ${[...EXECUTION_MODES].join(', ')} — the standalone exemption is declared, never inferred.`);
  }
  const { EvidenceLedger } = require('./evidence-ledger.ts');
  const { ClaimsManager } = require('./claims.ts');
  const { FreshnessValidator } = require('./freshness.ts');
  const ledger = new EvidenceLedger({ repoRoot: projectRoot });
  ledger.load(taskProfile.taskId);
  new FreshnessValidator({ repoRoot: projectRoot, treeRoot, sourceRoot }).validateLedgerFreshness(ledger);
  const claims = new ClaimsManager({ evidenceLedger: ledger, repoRoot: projectRoot });
  claims.load(taskProfile.taskId);
  claims.evaluateAll();
  const report = new ReadinessEngine({ repoRoot, projectRoot }).evaluateReadiness(taskProfile, ledger, claims);
  return { ...report, executionMode: mode, stageEntry: stageEntryFor(report.state, mode) };
}

module.exports = {
  evaluateTaskReadiness,
  stageEntryFor,
  ReadinessEngine,
  READINESS_STATES,
  EXECUTION_MODES,
  STAGE_ENTRY_DECISIONS,
};
