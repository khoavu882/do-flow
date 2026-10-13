'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const { EvidenceLedger } = require('./evidence-ledger.ts');
const { ClaimsManager } = require('./claims.ts');
const { ResearchRequestStore } = require('./research-request.ts');
const { finishRuntime, usageError, EXIT } = require('./cli-result.ts');
const nativeConsoleLog = console.log;
const featureResolve = require('./feature-resolve.ts');
const { readRegister } = require('./decision-register.ts');
const compose = require('./context/compose.ts');
const {
  FIELD_CLASSES,
  buildPackItem,
  buildObjectiveItem,
  buildConstraintItem,
  buildAcceptanceCriteriaItem,
  buildVerificationRequirementItem,
  buildScopeExcludedItem,
  buildClaimConflictItem,
  buildBlockingGapItem,
  buildResearchRequestItem,
  buildDecisionReasonItem,
  buildDecisionLiveItem,
  buildClaimSupportedItem,
  buildClaimHypothesisItem,
  buildPointerItem,
  buildRelevantFileItem,
  buildEvidenceSummaryItem,
  buildStructuralContextItem,
  computeEnvelopes,
  linearFit,
  groupOmissions,
  computePackDigest,
  formatOverflowMessage,
  formatMarkdown,
  formatJson,
} = require('./context/compose.ts');
const {
  extractMandatory,
  parseMandatoryFile,
  applyMandatoryOverride,
} = require('./context/mandatory.ts');

const NO_DECISIONS = Object.freeze({ available: false, live: [], liveCount: 0 });

const { TASK_CLASS_BUDGETS, resolveBudget, getRegisteredHarnessIds } = require('./context/budget.ts');
const { createDeliveryEntry, recordDelivery } = require('./context/delivery-store.ts');
const { boundedAcquire } = require('./task-state.ts');

/**
 * The live decisions of the feature the caller is working on (IC-012). The feature is resolved
 * from the branch, or from `slug` when the task id is not the feature slug. A feature with no
 * register or an unresolvable feature reads as "not available"; an unreadable register does too,
 * with a `reason`. Neither throws: a context pack is a read, and a missing register must not stop
 * a stage from getting its evidence.
 * @param {{projectRoot:string, slug?:string|null}} options
 * @returns {{available:boolean, live:Array<Object>, liveCount:number, reason?:string}}
 */
function loadLiveDecisions({ projectRoot, slug = null, feature: preloadedFeature = null }: any) {
  try {
    const feature = preloadedFeature || featureResolve.resolveActiveFeature({ projectRoot, slug });
    if (feature.error) return { ...NO_DECISIONS };
    let register;
    try {
      register = readRegister(feature.featureDir);
    } catch (error: any) {
      // The register exists but cannot be trusted. Stay unavailable, but say why, so a stage
      // sees the corruption instead of reading "no decisions".
      return { ...NO_DECISIONS, reason: `register unreadable: ${error.message}` };
    }
    if (!register) return { ...NO_DECISIONS };
    const live = register.decisions
      .filter((d: any) => d.status === 'live')
      .sort((a: any, b: any) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0))
      .map(({ id, topic, statement, decidedBy, stage }: any) => ({ id, topic, statement, decidedBy, stage }));
    return { available: true, live, liveCount: live.length };
  } catch {
    return { ...NO_DECISIONS };
  }
}

class ContextPackCompiler {
  declare options: any;
  /**
   * @param {Object} [defaultOptions]
   * @param {number} [defaultOptions.maxFiles=15]
   * @param {number} [defaultOptions.maxClaims=20]
   * @param {number} [defaultOptions.maxEvidenceItems=25]
   */
  constructor(defaultOptions: any = {}) {
    this.options = {
      maxFiles: defaultOptions.maxFiles || 15,
      maxClaims: defaultOptions.maxClaims || 20,
      maxEvidenceItems: defaultOptions.maxEvidenceItems || 25,
      maxResearchRequests: defaultOptions.maxResearchRequests || 20,
      maxStructuralItems: defaultOptions.maxStructuralItems || 5,
      enableCorrective: defaultOptions.enableCorrective !== false,
      selfRefWidth: defaultOptions.selfRefWidth ?? null,
    };
  }

  /**
   * Compiles a ContextPack from task evidence and claims through compose.ts.
   * @param {Object} params
   * @param {Object} [budgetOverrides={}]
   * @returns {Object} ContextPack
   */
  compileContextPack(params: any, budgetOverrides: any = {}) {
    const {
      taskId = 'default',
      taskClass = 'feature',
      objective: paramObjective,
      constraints: paramConstraints = [],
      acceptanceCriteria: paramAc = [],
      verificationRequirements: paramVr = [],
      scopeExcluded: paramScope = [],
      blockingGaps: paramGaps = [],
      evidenceLedger,
      claimsManager,
      researchRequests = [],
      decisions = NO_DECISIONS,
      mandatory: paramMandatory,
      budget: paramBudget,
      maxBytes,
      harness,
      bare = false,
      mode: paramMode,
      noRecord = false,
      reason,
      since,
      expand,
    } = params;

    const limits = { ...this.options, ...budgetOverrides };

    const effectiveTaskClass = (!taskClass || typeof taskClass !== 'string' || taskClass.trim() === '') ? 'feature' : taskClass.trim();
    const resolvedBudget = paramBudget || resolveBudget({ taskClass: effectiveTaskClass, maxBytes, harnessFlag: harness });

    // Determine mandatory fields and provenance
    const mandatoryFields = paramMandatory?.fields || {};
    const mandatoryProv = paramMandatory?.provenance || {};

    const hasParamObjective = paramObjective !== undefined && paramObjective !== null;
    const objective = hasParamObjective
      ? paramObjective
      : (mandatoryFields.objective || '');

    const acSource = (paramAc.length > 0 ? paramAc : (mandatoryFields.acceptanceCriteria || []));
    const constraintsSource = (paramConstraints.length > 0 ? paramConstraints : (mandatoryFields.constraints || []));
    const vrSource = (paramVr.length > 0 ? paramVr : (mandatoryFields.verificationRequirements || []));
    const scopeSource = (paramScope.length > 0 ? paramScope : (mandatoryFields.scopeExcluded || []));
    const gapsSource = (paramGaps.length > 0 ? paramGaps : (mandatoryFields.blockingGaps || []));

    const mandatoryProvenance = {
      objective: hasParamObjective
        ? { supplied: Boolean(objective), source: 'caller', locator: null, digest: null, maturity: null, reason: objective ? null : 'caller-supplied-empty', gaps: [] }
        : (mandatoryProv.objective || { supplied: Boolean(objective), source: objective ? 'caller' : 'none', locator: null, digest: null, maturity: null, reason: objective ? null : 'none-in-artifact', gaps: [] }),
      acceptanceCriteria: mandatoryProv.acceptanceCriteria || { supplied: acSource.length > 0, source: acSource.length > 0 ? 'requirement' : 'none', locator: null, digest: null, maturity: null, reason: acSource.length > 0 ? null : 'artifact-absent', gaps: [] },
      constraints: mandatoryProv.constraints || { supplied: constraintsSource.length > 0, source: constraintsSource.length > 0 ? 'requirement' : 'none', locator: null, digest: null, maturity: null, reason: constraintsSource.length > 0 ? null : 'artifact-absent', gaps: [] },
      verificationRequirements: mandatoryProv.verificationRequirements || { supplied: vrSource.length > 0, source: vrSource.length > 0 ? 'requirement' : 'none', locator: null, digest: null, maturity: null, reason: vrSource.length > 0 ? null : 'artifact-absent', gaps: [] },
      scopeExcluded: mandatoryProv.scopeExcluded || { supplied: scopeSource.length > 0, source: scopeSource.length > 0 ? 'requirement' : 'none', locator: null, digest: null, maturity: null, reason: scopeSource.length > 0 ? null : 'artifact-absent', gaps: [] },
      blockingGaps: mandatoryProv.blockingGaps || { supplied: gapsSource.length > 0, source: gapsSource.length > 0 ? 'requirement' : 'none', locator: null, digest: null, maturity: null, reason: gapsSource.length > 0 ? null : 'artifact-absent', gaps: [] },
    };

    // Claims
    let rawClaims: any[] = [];
    if (claimsManager) {
      rawClaims = claimsManager.getClaims(taskId);
    } else if (params.claims) {
      if (Array.isArray(params.claims)) {
        rawClaims = params.claims;
      } else {
        const cList = (params.claims.conflicts || []).map((c: any) => ({ ...c, status: 'conflicted' }));
        const sList = (params.claims.supported || []).map((s: any) => ({ ...s, status: s.status || 'supported' }));
        const hList = (params.claims.hypotheses || []).map((h: any) => ({ ...h, status: h.status || 'hypothesis' }));
        rawClaims = [...cList, ...sList, ...hList];
      }
    }
    const conflictedClaims: any[] = [];
    const supportedClaims: any[] = [];
    const activeHypotheses: any[] = [];

    for (const claim of rawClaims) {
      if (claim.status === 'conflicted' || (Array.isArray(claim.contradictingEvidence) && claim.contradictingEvidence.length > 0)) {
        conflictedClaims.push(claim);
      } else if (claim.status === 'supported') {
        supportedClaims.push({
          ...claim,
          evidenceIds: Array.isArray(claim.evidenceIds)
            ? claim.evidenceIds
            : (Array.isArray(claim.supportingEvidence) ? claim.supportingEvidence : []),
        });
      } else if (claim.status === 'hypothesis') {
        activeHypotheses.push(claim);
      }
    }

    // Evidence
    const rawEvidence = evidenceLedger ? evidenceLedger.queryEvidence({ taskId }) : (params.evidence || []);
    const relevantFileSet = new Set<string>();
    const structuralNodes: any[] = [];
    const freshEvidenceItems: any[] = [];
    const nonFreshOmissions: any[] = [];

    for (const ev of rawEvidence) {
      if (ev.freshness?.status === 'FRESH') {
        if (ev.locator?.file) relevantFileSet.add(ev.locator.file);
        if (ev.kind === 'structural' && ev.content) structuralNodes.push(ev.content);
        freshEvidenceItems.push({
          id: ev.id,
          kind: ev.kind,
          locator: ev.locator,
          summary: typeof ev.content === 'string' ? ev.content.slice(0, 120) : null,
          freshness: 'FRESH',
        });
      } else {
        const status = ev.freshness?.status === 'STALE' ? 'STALE' : 'UNKNOWN';
        nonFreshOmissions.push({
          id: ev.id,
          field: 'evidenceSummary',
          reason: 'not-fresh',
          freshness: status,
        });
      }
    }
    const relevantFiles = params.relevantFiles
      ? Array.from(new Set([...params.relevantFiles, ...relevantFileSet]))
      : Array.from(relevantFileSet);

    // Build items
    const items: any[] = [];
    if (objective) items.push(buildObjectiveItem(objective));

    const blockingUnanswered = researchRequests.filter((r: any) => r.blocking && r.status !== 'ANSWERED');
    const otherRequests = researchRequests.filter((r: any) => !(r.blocking && r.status !== 'ANSWERED'));

    if (!bare) {
      acSource.forEach((ac: any, i: number) => items.push(buildAcceptanceCriteriaItem(ac, i)));
      constraintsSource.forEach((c: any, i: number) => items.push(buildConstraintItem(c, i)));
      vrSource.forEach((vr: any, i: number) => items.push(buildVerificationRequirementItem(vr, i)));
      scopeSource.forEach((se: any, i: number) => items.push(buildScopeExcludedItem(se, i)));
      gapsSource.forEach((bg: any, i: number) => items.push(buildBlockingGapItem(bg, i)));
      conflictedClaims.forEach((c: any) => items.push(buildClaimConflictItem(c)));

      blockingUnanswered.forEach((r: any) => items.push(buildResearchRequestItem(r)));
      if (decisions.reason) items.push(buildDecisionReasonItem(decisions.reason));

      if (decisions.available && Array.isArray(decisions.live)) {
        decisions.live.forEach((d: any) => items.push(buildDecisionLiveItem(d)));
      }
      supportedClaims.forEach((c: any) => items.push(buildClaimSupportedItem(c)));
      otherRequests.forEach((r: any) => items.push(buildResearchRequestItem(r)));
      activeHypotheses.forEach((h: any) => items.push(buildClaimHypothesisItem(h)));
      relevantFiles.forEach((f: any) => items.push(buildRelevantFileItem(f)));
      freshEvidenceItems.forEach((ev: any) => items.push(buildEvidenceSummaryItem(ev)));
      structuralNodes.forEach((sn: any, i: number) => items.push(buildStructuralContextItem(sn, i)));
    }

    const hasMandatoryItems = {
      objective: Boolean(objective),
      acceptanceCriteria: !bare && acSource.length > 0,
      constraints: !bare && constraintsSource.length > 0,
      verificationRequirements: !bare && vrSource.length > 0,
      scopeExcluded: !bare && scopeSource.length > 0,
      blockingGaps: !bare && (gapsSource.length > 0 || blockingUnanswered.length > 0),
      'claims.conflicts': !bare && conflictedClaims.length > 0,
      researchRequests: !bare && blockingUnanswered.length > 0,
    };

    const empty = rawEvidence.length === 0
      && rawClaims.length === 0
      && researchRequests.length === 0
      && (!decisions || decisions.liveCount === 0);

    const enableCorrective = budgetOverrides.enableCorrective !== undefined
      ? budgetOverrides.enableCorrective
      : (this.options.enableCorrective !== false);
    const selfRefWidth = budgetOverrides.selfRefWidth ?? this.options.selfRefWidth ?? null;

    const { envelopeMd, envelopeJson } = computeEnvelopes({
      taskId,
      taskClass: effectiveTaskClass,
      budget: resolvedBudget,
      mandatory: paramMandatory,
      empty,
      mode: bare ? 'bare' : (paramMode || 'full'),
      hasMandatoryItems,
      limits,
      selfRefWidth,
    });

    const hasMandatoryRequests = !bare && blockingUnanswered.length > 0;
    const fit = linearFit({
      items,
      budget: resolvedBudget.maxBytes,
      taskId,
      taskClass: effectiveTaskClass,
      envelopeMd,
      envelopeJson,
      initialOmissions: bare ? [] : nonFreshOmissions,
      sectionHeadingsJson: {
        'decisions.live': 5,
        'claims.supported': 5,
        'researchRequests (others)': hasMandatoryRequests ? 0 : 3,
        'claims.hypotheses': 4,
        pointers: 3,
        relevantFiles: 3,
        evidenceSummary: 3,
        structuralContext: 3,
      },
      itemCapLimits: {
        relevantFiles: limits.maxFiles ?? 15,
        'claims.supported': limits.maxClaims ?? 20,
        'claims.hypotheses': limits.maxClaims ?? 20,
        evidenceSummary: limits.maxEvidenceItems ?? 25,
        'researchRequests (others)': Math.max(0, (limits.maxResearchRequests ?? 20) - blockingUnanswered.length),
        structuralContext: limits.maxStructuralItems ?? 5,
      },
    });

    const assemblePack = (keptItems: any[], omissionsList: any[], isOverflow: boolean = false, overflowCause: any = null) => {
      const keptAc = keptItems.filter((i: any) => i.field === 'acceptanceCriteria').map((i: any) => i.value);
      const keptConstraints = keptItems.filter((i: any) => i.field === 'constraints').map((i: any) => i.value);
      const keptVr = keptItems.filter((i: any) => i.field === 'verificationRequirements').map((i: any) => i.value);
      const keptScope = keptItems.filter((i: any) => i.field === 'scopeExcluded').map((i: any) => i.value);
      const keptGaps = keptItems.filter((i: any) => i.field === 'blockingGaps').map((i: any) => i.value);
      const keptConflicts = keptItems.filter((i: any) => i.field === 'claims.conflicts').map((i: any) => i.value);
      const keptLiveDecisions = keptItems.filter((i: any) => i.field === 'decisions.live').map((i: any) => i.value);
      const keptSupported = keptItems.filter((i: any) => i.field === 'claims.supported').map((i: any) => i.value);
      const keptRequests = keptItems.filter((i: any) => i.field.startsWith('researchRequests')).map((i: any) => i.value);
      const keptHypotheses = keptItems.filter((i: any) => i.field === 'claims.hypotheses').map((i: any) => i.value);
      const keptPointers = keptItems.filter((i: any) => i.field === 'pointers').map((i: any) => i.value);
      const keptFiles = keptItems.filter((i: any) => i.field === 'relevantFiles').map((i: any) => i.value);
      const keptEvidence = keptItems.filter((i: any) => i.field === 'evidenceSummary').map((i: any) => i.value);
      const keptStructural = keptItems.filter((i: any) => i.field === 'structuralContext').map((i: any) => i.value);

      const omissions = groupOmissions(omissionsList);
      const packDigest = computePackDigest(keptItems);

      const cause = overflowCause || (isOverflow ? (fit.cause || 'mandatory') : null);
      const packTotalBytes = isOverflow ? Math.max(fit.mandatoryBytes, resolvedBudget.maxBytes) : fit.totalBytes;
      const packMandatoryBytes = fit.mandatoryBytes;
      const packOptionalBytes = isOverflow ? 0 : Math.max(0, fit.totalBytes - fit.mandatoryBytes);

      const packed = {
        version: 1,
        status: isOverflow ? 'OVERFLOW' : (empty ? 'EMPTY' : 'OK'),
        exitCode: isOverflow ? EXIT.OVERFLOW : (empty ? EXIT.EMPTY : EXIT.OK),
        taskId,
        taskClass: effectiveTaskClass,
        compiledAt: new Date().toISOString(),
        mode: bare ? 'bare' : (paramMode || 'full'),
        budget: resolvedBudget,
        overflow: isOverflow ? {
          cause,
          mandatoryBytes: packMandatoryBytes,
          budgetBytes: resolvedBudget.maxBytes,
          excessBytes: Math.max(0, (cause === 'mandatory' ? packMandatoryBytes : packTotalBytes) - resolvedBudget.maxBytes),
          action: 'split-or-new-session',
        } : null,
        overflowAction: isOverflow ? {
          message: formatOverflowMessage({
            cause,
            mandatoryBytes: packMandatoryBytes,
            totalBytes: packTotalBytes,
            budgetBytes: resolvedBudget.maxBytes,
            source: resolvedBudget.source,
          }),
        } : null,
        toolLimitNotice: null,
        objective,
        acceptanceCriteria: keptAc,
        constraints: keptConstraints,
        verificationRequirements: keptVr,
        scopeExcluded: keptScope,
        blockingGaps: keptGaps,
        claims: {
          conflicts: keptConflicts,
          supported: keptSupported,
          hypotheses: keptHypotheses,
        },
        researchRequests: keptRequests,
        mandatory: mandatoryProvenance,
        decisions: {
          available: Boolean(decisions && decisions.available),
          live: keptLiveDecisions,
          liveCount: keptLiveDecisions.length,
          ...(decisions?.reason ? { reason: decisions.reason } : {}),
        },
        pointers: keptPointers,
        relevantFiles: keptFiles,
        evidenceCount: keptEvidence.length,
        evidenceSummary: keptEvidence,
        structuralContext: keptStructural,
        budgetEnforcement: {
          totalFiles: relevantFiles.length,
          totalSupportedClaims: supportedClaims.length,
          totalActiveHypotheses: activeHypotheses.length,
          limits,
        },
        empty,
        omissions: bare ? { total: 0, groups: [] } : omissions,
        size: {
          totalBytes: packTotalBytes,
          mandatoryBytes: packMandatoryBytes,
          optionalBytes: packOptionalBytes,
          fittedOn: fit.fittedOn,
        },
        accounting: {
          tokens: {
            inlineTokensEst: Math.round(packTotalBytes / 4),
            netTokensEst: Math.round(packTotalBytes / 4),
            basis: 'estimated:bytes/4',
            actual: { unmeasured: 'needs a model call (paid)' },
          },
        },
        delivery: {
          key: null,
          packDigest,
          recorded: false,
          reason: null,
          since: null,
          deltaRefused: null,
        },
        delta: null,
        packEnd: {
          mode: bare ? 'bare' : (paramMode || 'full'),
          objective: objective ? 1 : 0,
          acceptanceCriteria: keptAc.length,
          constraints: keptConstraints.length,
          verificationRequirements: keptVr.length,
          scopeExcluded: keptScope.length,
          conflicts: keptConflicts.length,
          blockingGaps: keptGaps.length,
          omitted: bare ? 0 : omissions.total,
          bytes: packTotalBytes,
          digest: packDigest.slice(0, 19),
        },
      };
      Object.defineProperties(packed, {
        deliveryItems: { value: keptItems.map((item: any) => ({ id: item.id, digest: item.digest, cls: item.cls || item.class })) },
        deliveryOmissions: { value: bare ? [] : omissionsList.map((item: any) => ({ ...item })) },
      });
      return packed;
    };

    let pack: any = assemblePack(fit.kept, fit.omissions, fit.overflow, fit.cause);

    if (enableCorrective && pack.status === 'OK') {
      let currentKept = [...fit.kept];
      let currentOmissions = [...fit.omissions];

      while (pack.status === 'OK') {
        const mdOut = formatMarkdown(pack, { throwOnOverBudget: false });
        const jsonOut = formatJson(pack, { throwOnOverBudget: false });
        const mdLen = Buffer.byteLength(mdOut, 'utf8');
        const jsonLen = Buffer.byteLength(jsonOut, 'utf8');

        if (mdLen <= resolvedBudget.maxBytes && jsonLen <= resolvedBudget.maxBytes) {
          pack.size.fittedOn = jsonLen >= mdLen ? 'json' : 'markdown';
          break;
        }

        let lastOptIdx = -1;
        for (let idx = currentKept.length - 1; idx >= 0; idx--) {
          const it = currentKept[idx];
          if (it.cls === 'optional' || it.class === 'optional') {
            lastOptIdx = idx;
            break;
          }
        }

        if (lastOptIdx === -1) {
          const mandatoryOnlyKept = currentKept.filter((i: any) => i.cls === 'mandatory' || i.class === 'mandatory');
          const allOptOmitted = [
            ...(bare ? [] : nonFreshOmissions),
            ...items.filter((i: any) => i.cls === 'optional' || i.class === 'optional').map((i: any) => ({
              id: i.id,
              field: i.field,
              reason: 'mandatory-overflow',
              ...(i.freshness ? { freshness: i.freshness } : {}),
            })),
          ];
          const cause = Math.max(fit.mandatoryBytes, mdLen, jsonLen) > resolvedBudget.maxBytes ? 'mandatory' : 'accounting';
          pack = assemblePack(mandatoryOnlyKept, allOptOmitted, true, cause);
          break;
        }

        const [dropped] = currentKept.splice(lastOptIdx, 1);
        currentOmissions.push({
          id: dropped.id,
          field: dropped.field,
          reason: 'budget',
          ...(dropped.freshness ? { freshness: dropped.freshness } : {}),
        });
        pack = assemblePack(currentKept, currentOmissions, false, null);
      }
    }

    return pack;
  }

  /**
   * Formats a ContextPack into markdown per IC-005.
   * @param {Object} pack
   * @param {Object} [options]
   * @returns {string}
   */
  formatMarkdown(pack: any, options: any = {}) {
    return formatMarkdown(pack, options);
  }

  /**
   * Formats a ContextPack into JSON per IC-004.
   * @param {Object} pack
   * @param {Object} [options]
   * @returns {string}
   */
  formatJson(pack: any, options: any = {}) {
    return formatJson(pack, options);
  }

  /**
   * Compiles bounded context pack payload with mandatory/optional partitioning (IC-001).
   * @param {Object} options
   * @param {string} options.taskId
   * @param {string} [options.taskClass='feature']
   * @param {number} [options.maxBytes]
   * @param {string} [options.objective='']
   * @param {Object} [options.mandatory]
   * @param {Array<string>} [options.mandatory.acceptanceCriteria]
   * @param {Array<string>} [options.mandatory.constraints]
   * @param {string} [options.mandatory.verificationPlan]
   * @param {Object} [options.optional]
   * @param {Array<string>} [options.optional.hypotheses]
   * @param {Array<string>} [options.optional.narrative]
   * @param {Array<string>} [options.optional.unverifiedClaims]
   * @returns {Object} ContextPackResult
   */
  compileBoundedContextPack(options: any = {}) {
    const {
      taskId = 'default',
      taskClass = 'feature',
      maxBytes,
      objective = '',
      mandatory = {},
      optional = {},
    } = options;

    const resolvedBudget = resolveBudget({ taskClass, maxBytes });
    const budgetBytes = resolvedBudget.maxBytes;

    const acceptanceCriteria = Array.isArray(mandatory.acceptanceCriteria) ? [...mandatory.acceptanceCriteria] : [];
    const constraints = Array.isArray(mandatory.constraints) ? [...mandatory.constraints] : [];
    const verificationPlan = typeof mandatory.verificationPlan === 'string' ? mandatory.verificationPlan : '';

    // Build mandatory section payload
    let mandatoryMd = `## ContextPack: [${taskClass.toUpperCase()}] ${taskId}\n`;
    if (objective) {
      mandatoryMd += `**Objective:** ${objective}\n\n`;
    }
    if (acceptanceCriteria.length > 0) {
      mandatoryMd += `### Acceptance Criteria\n`;
      for (const ac of acceptanceCriteria) {
        mandatoryMd += `- [ ] ${ac}\n`;
      }
      mandatoryMd += '\n';
    }
    if (constraints.length > 0) {
      mandatoryMd += `### Constraints\n`;
      for (const c of constraints) {
        mandatoryMd += `- ! ${c}\n`;
      }
      mandatoryMd += '\n';
    }
    if (verificationPlan) {
      mandatoryMd += `### Verification Plan\n${verificationPlan}\n\n`;
    }

    const mandatoryBytes = Buffer.byteLength(mandatoryMd, 'utf8');

    const hypotheses = Array.isArray(optional.hypotheses) ? [...optional.hypotheses] : [];
    const unverifiedClaims = Array.isArray(optional.unverifiedClaims) ? [...optional.unverifiedClaims] : [];
    const narrative = Array.isArray(optional.narrative) ? [...optional.narrative] : [];

    const items: any[] = [];
    hypotheses.forEach((h: string, idx: number) => {
      const line = `- ? ${h}\n`;
      items.push({
        id: `hypothesis-${idx + 1}`,
        field: 'hypotheses',
        value: h,
        class: 'optional',
        cls: 'optional',
        priority: 1,
        md: line,
        mdBytes: Buffer.byteLength(line, 'utf8'),
        jsonBytes: 0,
      });
    });

    unverifiedClaims.forEach((c: string, idx: number) => {
      const line = `- ? ${c}\n`;
      items.push({
        id: `claim-${idx + 1}`,
        field: 'unverifiedClaims',
        value: c,
        class: 'optional',
        cls: 'optional',
        priority: 2,
        md: line,
        mdBytes: Buffer.byteLength(line, 'utf8'),
        jsonBytes: 0,
      });
    });

    narrative.forEach((n: string, idx: number) => {
      const line = `- ${n}\n`;
      items.push({
        id: `narrative-${idx + 1}`,
        field: 'narrative',
        value: n,
        class: 'optional',
        cls: 'optional',
        priority: 3,
        md: line,
        mdBytes: Buffer.byteLength(line, 'utf8'),
        jsonBytes: 0,
      });
    });

    const fit = compose.linearFit({
      items,
      budget: budgetBytes,
      taskId,
      taskClass,
      envelopeMd: mandatoryBytes,
      envelopeJson: mandatoryBytes,
      includeOmissionCosts: false,
      sectionHeadingsMd: {
        hypotheses: Buffer.byteLength('### Active Hypotheses (Unverified)\n\n', 'utf8'),
        unverifiedClaims: Buffer.byteLength('### Unverified Claims\n\n', 'utf8'),
        narrative: Buffer.byteLength('### Background Narrative\n\n', 'utf8'),
      },
      sectionHeadingsJson: {},
      itemCapLimits: {},
    });

    if (fit.overflow) {
      const omissions = items.map((i: any) => ({ id: i.id, reason: 'budget-cap-exceeded' }));
      return {
        taskId,
        taskClass,
        totalBytes: mandatoryBytes,
        budgetBytes,
        overflow: true,
        mandatoryBytes,
        optionalBytes: 0,
        omissions,
        payload: mandatoryMd,
        error: `Mandatory context (${mandatoryBytes} B) exceeds budget (${budgetBytes} B)`,
      };
    }

    const keptHypotheses = fit.kept.filter((i: any) => i.field === 'hypotheses').map((i: any) => i.value);
    const keptClaims = fit.kept.filter((i: any) => i.field === 'unverifiedClaims').map((i: any) => i.value);
    const keptNarrative = fit.kept.filter((i: any) => i.field === 'narrative').map((i: any) => i.value);

    let payload = mandatoryMd;
    if (keptHypotheses.length > 0) {
      payload += `### Active Hypotheses (Unverified)\n`;
      for (const h of keptHypotheses) payload += `- ? ${h}\n`;
      payload += '\n';
    }
    if (keptClaims.length > 0) {
      payload += `### Unverified Claims\n`;
      for (const c of keptClaims) payload += `- ? ${c}\n`;
      payload += '\n';
    }
    if (keptNarrative.length > 0) {
      payload += `### Background Narrative\n`;
      for (const n of keptNarrative) payload += `- ${n}\n`;
      payload += '\n';
    }

    const totalBytes = Buffer.byteLength(payload, 'utf8');
    const optionalBytes = totalBytes - mandatoryBytes;
    const omissions = fit.omissions.map((o: any) => ({ id: o.id, reason: 'budget-cap-exceeded' }));

    return {
      taskId,
      taskClass,
      totalBytes,
      budgetBytes,
      overflow: false,
      mandatoryBytes,
      optionalBytes,
      omissions,
      payload,
    };
  }

  /**
   * Alias for compileBoundedContextPack.
   */
  compileBoundedPayload(options: any = {}) {
    return this.compileBoundedContextPack(options);
  }
}

/**
 * Handles `doflow context-pack` — compile the evidence and claims recorded for a task into the
 * context block a stage is handed.
 *
 * Exits 1 on a pack with nothing in it. An empty pack is not evidence that a task needs no
 * context; it is evidence that nothing was recorded, and reporting it as success is the
 * empty-contract defect in another costume.
 *
 * @param {Object} options
 * @param {string} options.taskId
 * @param {string} [options.taskClass]
 * @param {string} [options.objective]
 * @param {boolean} [options.json=false]
 * @param {string} [options.stateRoot]
 * @param {string} [options.slug] feature slug, when the task id is not the feature's own
 * @returns {number} exit code
 */
function handleContextPackCommand({
  taskId,
  taskClass = 'feature',
  objective,
  json = false,
  stateRoot,
  slug,
  mandatoryFile,
  harness = null,
  maxBytes,
  bare = false,
  noRecord = false,
  reason = null,
  since = null,
  expand = null,
}: any = {}) {
  const root = stateRoot || process.cwd();
  const effectiveTaskClass = (!taskClass || typeof taskClass !== 'string' || taskClass.trim() === '') ? 'feature' : taskClass.trim();

  // IC-001 Usage errors
  if (!taskId || typeof taskId !== 'string' || taskId.trim() === '') {
    return usageError('context-pack', '--task-id is required', json);
  }
  if (bare && expand) {
    return usageError('context-pack', '--bare cannot be combined with --expand', json);
  }
  if (since && !/^sha256:[0-9a-f]{64}$/.test(since)) {
    return usageError('context-pack', "--since must be 'sha256:' followed by 64 lowercase hex", json);
  }
  if (expand && (!since || !reason)) {
    return usageError('context-pack', '--expand requires both --since and --reason', json);
  }
  if (harness) {
    const validIds = getRegisteredHarnessIds();
    if (!validIds.includes(harness)) {
      return usageError('context-pack', `Unknown harness '${harness}'. Valid harnesses: ${validIds.join(', ')}`, json);
    }
  }

  let parsedMaxBytes: number | undefined;
  if (maxBytes !== undefined && maxBytes !== null) {
    const parsed = typeof maxBytes === 'number' ? maxBytes : parseInt(String(maxBytes).trim(), 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || (typeof maxBytes === 'string' && !/^[1-9]\d*$/.test(maxBytes.trim()))) {
      return usageError('context-pack', '--max-bytes must be a positive integer', json);
    }
    parsedMaxBytes = parsed;

    const baseBudget = resolveBudget({ taskClass: effectiveTaskClass, harnessFlag: harness });
    if (parsedMaxBytes > baseBudget.maxBytes && !reason) {
      return usageError('context-pack', `--max-bytes (${parsedMaxBytes}) exceeds resolved budget (${baseBudget.maxBytes}) and requires --reason`, json);
    }
  }

  const budget = resolveBudget({ taskClass: effectiveTaskClass, maxBytes: parsedMaxBytes, harnessFlag: harness });

  const feature = featureResolve.resolveActiveFeature({ projectRoot: root, slug: slug || null });

  let reqText: string | null = null;
  let reqPath = 'requirement.md';
  if (!feature.error && feature.featureDir) {
    reqPath = feature.paths?.requirement
      ? path.resolve(feature.repoRoot || root, feature.paths.requirement)
      : path.join(feature.featureDir, 'intention', 'requirement.md');
    try {
      if (fs.existsSync(reqPath)) {
        reqText = fs.readFileSync(reqPath, 'utf8');
      }
    } catch {
      reqText = null;
    }
  }

  let taskStories: string[] = [];
  if (!feature.error && feature.featureDir && taskId) {
    let planPath: string | null = null;
    if (feature.paths?.plan) {
      planPath = path.resolve(feature.repoRoot || root, feature.paths.plan);
    } else {
      const nestedPlan = path.join(feature.featureDir, 'plan', 'plan.md');
      const flatPlan = path.join(feature.featureDir, 'plan.md');
      if (fs.existsSync(nestedPlan)) planPath = nestedPlan;
      else if (fs.existsSync(flatPlan)) planPath = flatPlan;
    }
    if (planPath && fs.existsSync(planPath)) {
      try {
        const planText = fs.readFileSync(planPath, 'utf8');
        const { parsePlan } = require('./scaffold/artifacts.ts');
        const parsedPlan = parsePlan(planText);
        const matchedTask = (parsedPlan.tasks || []).find(
          (t: any) => t.id === taskId || t.id.toLowerCase() === taskId.toLowerCase()
        );
        if (matchedTask && Array.isArray(matchedTask.stories)) {
          taskStories = matchedTask.stories;
        }
      } catch {
        taskStories = [];
      }
    }
  }

  let mandatory = extractMandatory({
    text: reqText,
    path: reqPath,
    featureError: feature.error ? (feature.message || feature.error) : null,
    taskStories,
  });

  if (mandatoryFile) {
    try {
      let fileContent: string;
      if (mandatoryFile === '-') {
        fileContent = fs.readFileSync(0, 'utf8');
      } else {
        if (!fs.existsSync(mandatoryFile)) {
          const err: any = new Error(`--mandatory-file '${mandatoryFile}' does not exist`);
          err.code = 'USAGE_ERROR';
          throw err;
        }
        fileContent = fs.readFileSync(mandatoryFile, 'utf8');
      }
      const override = parseMandatoryFile(fileContent, mandatoryFile);
      mandatory = applyMandatoryOverride(mandatory, override);
    } catch (err: any) {
      return usageError('context-pack', err.message, json, err);
    }
  }

  const ledger = new EvidenceLedger({ repoRoot: root, slug });
  ledger.load(taskId);
  const claims = new ClaimsManager({ evidenceLedger: ledger, repoRoot: root, slug });
  claims.load(taskId);
  claims.evaluateAll();
  const researchRequests = new ResearchRequestStore({ projectRoot: root, slug }).list(taskId);

  const compiler = new ContextPackCompiler();
  const pack = compiler.compileContextPack({
    taskId,
    taskClass: effectiveTaskClass,
    objective: objective !== undefined && objective !== null ? objective : undefined,
    mandatory,
    budget,
    harness,
    maxBytes: parsedMaxBytes,
    bare,
    noRecord,
    reason,
    since,
    expand,
    evidenceLedger: ledger,
    claimsManager: claims,
    researchRequests,
    decisions: loadLiveDecisions({ projectRoot: root, slug: slug || null, feature }),
  });

  if (noRecord) {
    pack.delivery.reason = 'no-record';
  } else {
    const entry = createDeliveryEntry({ pack, form: json ? 'json' : 'markdown', harness });
    try {
      const result = recordDelivery({ projectRoot: root, taskId, slug, entry, acquire: boundedAcquire });
      pack.delivery.key = result.key;
      pack.delivery.recorded = true;
      pack.delivery.reason = null;
      pack.accounting.tokens = entry.tokens;
      pack.omissions = pack.mode === 'bare' ? pack.omissions : compose.groupOmissions(pack.deliveryOmissions, true);
    } catch (error: any) {
      if (error?.code !== 'store-locked' && error?.message !== 'store-locked') throw error;
      pack.delivery.key = null;
      pack.delivery.recorded = false;
      pack.delivery.reason = 'store-locked';
    }
  }

  const output = json ? compiler.formatJson(pack) : compiler.formatMarkdown(pack);
  const emittedBytes = Buffer.byteLength(output, 'utf8');
  if (pack.status === 'OK' && emittedBytes > budget.maxBytes) {
    throw new Error(`Emitted ${json ? 'JSON' : 'markdown'} pack size (${emittedBytes} B) exceeds budget (${budget.maxBytes} B)`);
  }
  if (console.log !== nativeConsoleLog) {
    console.log(output);
  } else {
    process.stdout.write(output);
  }
  return finishRuntime(pack.exitCode);
}

module.exports = {
  ContextPackCompiler,
  TASK_CLASS_BUDGETS,
  handleContextPackCommand,
  loadLiveDecisions,
};
