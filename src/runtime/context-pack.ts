'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const { EvidenceLedger } = require('./evidence-ledger.ts');
const { ClaimsManager } = require('./claims.ts');
const { ResearchRequestStore } = require('./research-request.ts');
const { finishRuntime, usageError, EXIT } = require('./cli-result.ts');
const featureResolve = require('./feature-resolve.ts');
const { readRegister } = require('./decision-register.ts');
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
  linearFit,
  groupOmissions,
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

    const resolvedBudget = paramBudget || resolveBudget({ taskClass, maxBytes, harnessFlag: harness });

    // Determine mandatory fields and provenance
    const mandatoryFields = paramMandatory?.fields || {};
    const mandatoryProv = paramMandatory?.provenance || {};

    const objective = paramObjective !== undefined && paramObjective !== null
      ? paramObjective
      : (mandatoryFields.objective || '');

    const acSource = (paramAc.length > 0 ? paramAc : (mandatoryFields.acceptanceCriteria || []));
    const constraintsSource = (paramConstraints.length > 0 ? paramConstraints : (mandatoryFields.constraints || []));
    const vrSource = (paramVr.length > 0 ? paramVr : (mandatoryFields.verificationRequirements || []));
    const scopeSource = (paramScope.length > 0 ? paramScope : (mandatoryFields.scopeExcluded || []));
    const gapsSource = (paramGaps.length > 0 ? paramGaps : (mandatoryFields.blockingGaps || []));

    const mandatoryProvenance = {
      objective: mandatoryProv.objective || { supplied: Boolean(objective), source: objective ? 'caller' : 'none', locator: null, digest: null, maturity: null, reason: objective ? null : 'none-in-artifact', gaps: [] },
      acceptanceCriteria: mandatoryProv.acceptanceCriteria || { supplied: acSource.length > 0, source: acSource.length > 0 ? 'requirement' : 'none', locator: null, digest: null, maturity: null, reason: acSource.length > 0 ? null : 'artifact-absent', gaps: [] },
      constraints: mandatoryProv.constraints || { supplied: constraintsSource.length > 0, source: constraintsSource.length > 0 ? 'requirement' : 'none', locator: null, digest: null, maturity: null, reason: constraintsSource.length > 0 ? null : 'artifact-absent', gaps: [] },
      verificationRequirements: mandatoryProv.verificationRequirements || { supplied: vrSource.length > 0, source: vrSource.length > 0 ? 'requirement' : 'none', locator: null, digest: null, maturity: null, reason: vrSource.length > 0 ? null : 'artifact-absent', gaps: [] },
      scopeExcluded: mandatoryProv.scopeExcluded || { supplied: scopeSource.length > 0, source: scopeSource.length > 0 ? 'requirement' : 'none', locator: null, digest: null, maturity: null, reason: scopeSource.length > 0 ? null : 'artifact-absent', gaps: [] },
      blockingGaps: mandatoryProv.blockingGaps || { supplied: gapsSource.length > 0, source: gapsSource.length > 0 ? 'requirement' : 'none', locator: null, digest: null, maturity: null, reason: gapsSource.length > 0 ? null : 'artifact-absent', gaps: [] },
    };

    // Claims
    const rawClaims = claimsManager ? claimsManager.getClaims(taskId) : (params.claims ? [...(params.claims.conflicts || []), ...(params.claims.supported || []), ...(params.claims.hypotheses || [])] : []);
    const conflictedClaims: any[] = [];
    const supportedClaims: any[] = [];
    const activeHypotheses: any[] = [];

    for (const claim of rawClaims) {
      if (claim.status === 'conflicted') conflictedClaims.push(claim);
      else if (claim.status === 'supported') supportedClaims.push(claim);
      else if (claim.status === 'hypothesis') activeHypotheses.push(claim);
    }

    // Evidence
    const rawEvidence = evidenceLedger ? evidenceLedger.queryEvidence({ taskId }) : (params.evidence || []);
    const relevantFileSet = new Set<string>();
    const structuralNodes: any[] = [];
    const freshEvidenceItems: any[] = [];

    for (const ev of rawEvidence) {
      if (ev.freshness?.status === 'FRESH') {
        if (ev.locator?.file) relevantFileSet.add(ev.locator.file);
        if (ev.kind === 'structural' && ev.content) structuralNodes.push(ev.content);
        freshEvidenceItems.push({
          id: ev.id,
          kind: ev.kind,
          locator: ev.locator,
          summary: typeof ev.content === 'string' ? ev.content.slice(0, 120) : null,
          freshness: ev.freshness?.status,
        });
      }
    }
    const relevantFiles = Array.from(relevantFileSet);

    // Build items
    const items: any[] = [];
    if (objective) items.push(buildObjectiveItem(objective));
    acSource.forEach((ac: any, i: number) => items.push(buildAcceptanceCriteriaItem(ac, i)));
    constraintsSource.forEach((c: any, i: number) => items.push(buildConstraintItem(c, i)));
    vrSource.forEach((vr: any, i: number) => items.push(buildVerificationRequirementItem(vr, i)));
    scopeSource.forEach((se: any, i: number) => items.push(buildScopeExcludedItem(se, i)));
    gapsSource.forEach((bg: any, i: number) => items.push(buildBlockingGapItem(bg, i)));
    conflictedClaims.forEach((c: any) => items.push(buildClaimConflictItem(c)));

    const blockingUnanswered = researchRequests.filter((r: any) => r.blocking && r.status !== 'ANSWERED');
    const otherRequests = researchRequests.filter((r: any) => !(r.blocking && r.status !== 'ANSWERED'));

    blockingUnanswered.forEach((r: any) => items.push(buildResearchRequestItem(r)));
    if (decisions.reason) items.push(buildDecisionReasonItem(decisions.reason));

    if (!bare) {
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

    const fit = linearFit({
      items,
      budget: resolvedBudget.maxBytes,
      taskId,
      taskClass,
      itemCapLimits: {
        relevantFiles: limits.maxFiles,
        'claims.supported': limits.maxClaims,
        'claims.hypotheses': limits.maxClaims,
        evidenceSummary: limits.maxEvidenceItems,
        'researchRequests (others)': Math.max(0, limits.maxResearchRequests - blockingUnanswered.length),
      },
    });

    const keptAc = fit.kept.filter((i: any) => i.field === 'acceptanceCriteria').map((i: any) => i.value);
    const keptConstraints = fit.kept.filter((i: any) => i.field === 'constraints').map((i: any) => i.value);
    const keptVr = fit.kept.filter((i: any) => i.field === 'verificationRequirements').map((i: any) => i.value);
    const keptScope = fit.kept.filter((i: any) => i.field === 'scopeExcluded').map((i: any) => i.value);
    const keptGaps = fit.kept.filter((i: any) => i.field === 'blockingGaps').map((i: any) => i.value);
    const keptConflicts = fit.kept.filter((i: any) => i.field === 'claims.conflicts').map((i: any) => i.value);
    const keptLiveDecisions = fit.kept.filter((i: any) => i.field === 'decisions.live').map((i: any) => i.value);
    const keptSupported = fit.kept.filter((i: any) => i.field === 'claims.supported').map((i: any) => i.value);
    const keptRequests = fit.kept.filter((i: any) => i.field.startsWith('researchRequests')).map((i: any) => i.value);
    const keptHypotheses = fit.kept.filter((i: any) => i.field === 'claims.hypotheses').map((i: any) => i.value);
    const keptPointers = fit.kept.filter((i: any) => i.field === 'pointers').map((i: any) => i.value);
    const keptFiles = fit.kept.filter((i: any) => i.field === 'relevantFiles').map((i: any) => i.value);
    const keptEvidence = fit.kept.filter((i: any) => i.field === 'evidenceSummary').map((i: any) => i.value);
    const keptStructural = fit.kept.filter((i: any) => i.field === 'structuralContext').map((i: any) => i.value);

    const empty = rawEvidence.length === 0
      && rawClaims.length === 0
      && researchRequests.length === 0
      && (!decisions || decisions.liveCount === 0);

    const omissions = groupOmissions(fit.omissions);

    const pack: any = {
      version: 1,
      status: fit.overflow ? 'OVERFLOW' : (empty ? 'EMPTY' : 'OK'),
      exitCode: fit.overflow ? EXIT.OVERFLOW : (empty ? EXIT.EMPTY : EXIT.OK),
      taskId,
      taskClass,
      compiledAt: new Date().toISOString(),
      mode: bare ? 'bare' : (paramMode || 'full'),
      budget: resolvedBudget,
      overflow: fit.overflow ? {
        cause: fit.cause,
        mandatoryBytes: fit.mandatoryBytes,
        budgetBytes: resolvedBudget.maxBytes,
        excessBytes: Math.max(0, (fit.cause === 'mandatory' ? fit.mandatoryBytes : fit.totalBytes) - resolvedBudget.maxBytes),
        action: 'split-or-new-session',
      } : null,
      overflowAction: fit.overflow ? {
        message: formatOverflowMessage({
          cause: fit.cause,
          mandatoryBytes: fit.mandatoryBytes,
          totalBytes: fit.totalBytes,
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
      omissions,
      size: {
        totalBytes: fit.totalBytes,
        mandatoryBytes: fit.mandatoryBytes,
        optionalBytes: fit.optionalBytes,
        fittedOn: fit.fittedOn,
      },
      accounting: {
        tokens: {
          inlineTokensEst: Math.round(fit.totalBytes / 4),
          netTokensEst: Math.round(fit.totalBytes / 4),
          basis: 'estimated:bytes/4',
          actual: { unmeasured: 'needs a model call (paid)' },
        },
      },
      delivery: {
        key: null,
        packDigest: fit.packDigest,
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
        omitted: omissions.total,
        bytes: fit.totalBytes,
        digest: fit.packDigest.slice(0, 19),
      },
    };

    return pack;
  }

  /**
   * Formats a ContextPack into markdown per IC-005.
   * @param {Object} pack
   * @returns {string}
   */
  formatMarkdown(pack: any) {
    return formatMarkdown(pack);
  }

  /**
   * Formats a ContextPack into JSON per IC-004.
   * @param {Object} pack
   * @returns {string}
   */
  formatJson(pack: any) {
    return formatJson(pack);
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

    // Rule 1: Mandatory content is never truncated; if mandatoryBytes > budgetBytes, returns overflow: true.
    if (mandatoryBytes > budgetBytes) {
      const omissions = [];
      const narrativeList = Array.isArray(optional.narrative) ? optional.narrative : [];
      const claimsList = Array.isArray(optional.unverifiedClaims) ? optional.unverifiedClaims : [];
      const hypList = Array.isArray(optional.hypotheses) ? optional.hypotheses : [];

      for (let i = 0; i < narrativeList.length; i++) omissions.push({ id: `narrative-${i + 1}`, reason: 'budget-cap-exceeded' });
      for (let i = 0; i < claimsList.length; i++) omissions.push({ id: `claim-${i + 1}`, reason: 'budget-cap-exceeded' });
      for (let i = 0; i < hypList.length; i++) omissions.push({ id: `hypothesis-${i + 1}`, reason: 'budget-cap-exceeded' });

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

    // Rule 2: Optional content is trimmed in reverse priority order when mandatoryBytes + optionalBytes > budgetBytes.
    // Priority order: 1. hypotheses, 2. unverifiedClaims, 3. narrative.
    // Trimming in reverse priority: narrative first, then claims, then hypotheses.
    const hypotheses = Array.isArray(optional.hypotheses) ? [...optional.hypotheses] : [];
    const unverifiedClaims = Array.isArray(optional.unverifiedClaims) ? [...optional.unverifiedClaims] : [];
    const narrative = Array.isArray(optional.narrative) ? [...optional.narrative] : [];

    const keptHypotheses = [];
    const keptClaims = [];
    const keptNarrative = [];
    const omissions = [];

    const buildPayload = (hList: any, cList: any, nList: any) => {
      let md = mandatoryMd;
      if (hList.length > 0) {
        md += `### Active Hypotheses (Unverified)\n`;
        for (const h of hList) md += `- ? ${h}\n`;
        md += '\n';
      }
      if (cList.length > 0) {
        md += `### Unverified Claims\n`;
        for (const c of cList) md += `- ? ${c}\n`;
        md += '\n';
      }
      if (nList.length > 0) {
        md += `### Background Narrative\n`;
        for (const n of nList) md += `- ${n}\n`;
        md += '\n';
      }
      return md;
    };

    // Forward trial fitting: hypotheses first
    for (let i = 0; i < hypotheses.length; i++) {
      const trial = [...keptHypotheses, hypotheses[i]];
      const trialMd = buildPayload(trial, [], []);
      if (Buffer.byteLength(trialMd, 'utf8') <= budgetBytes) {
        keptHypotheses.push(hypotheses[i]);
      } else {
        omissions.push({ id: `hypothesis-${i + 1}`, reason: 'budget-cap-exceeded' });
      }
    }

    // unverifiedClaims next
    for (let i = 0; i < unverifiedClaims.length; i++) {
      const trial = [...keptClaims, unverifiedClaims[i]];
      const trialMd = buildPayload(keptHypotheses, trial, []);
      if (Buffer.byteLength(trialMd, 'utf8') <= budgetBytes) {
        keptClaims.push(unverifiedClaims[i]);
      } else {
        omissions.push({ id: `claim-${i + 1}`, reason: 'budget-cap-exceeded' });
      }
    }

    // narrative next
    for (let i = 0; i < narrative.length; i++) {
      const trial = [...keptNarrative, narrative[i]];
      const trialMd = buildPayload(keptHypotheses, keptClaims, trial);
      if (Buffer.byteLength(trialMd, 'utf8') <= budgetBytes) {
        keptNarrative.push(narrative[i]);
      } else {
        omissions.push({ id: `narrative-${i + 1}`, reason: 'budget-cap-exceeded' });
      }
    }

    const payload = buildPayload(keptHypotheses, keptClaims, keptNarrative);
    const totalBytes = Buffer.byteLength(payload, 'utf8');
    const optionalBytes = totalBytes - mandatoryBytes;

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

    const baseBudget = resolveBudget({ taskClass, harnessFlag: harness });
    if (parsedMaxBytes > baseBudget.maxBytes && !reason) {
      return usageError('context-pack', `--max-bytes (${parsedMaxBytes}) exceeds resolved budget (${baseBudget.maxBytes}) and requires --reason`, json);
    }
  }

  const budget = resolveBudget({ taskClass, maxBytes: parsedMaxBytes, harnessFlag: harness });

  const feature = featureResolve.resolveActiveFeature({ projectRoot: root, slug: slug || null });

  let reqText: string | null = null;
  let reqPath = 'requirement.md';
  if (!feature.error && feature.featureDir) {
    reqPath = path.join(feature.featureDir, 'intention', 'requirement.md');
    try {
      if (fs.existsSync(reqPath)) {
        reqText = fs.readFileSync(reqPath, 'utf8');
      }
    } catch {
      reqText = null;
    }
  }

  let mandatory = extractMandatory({
    text: reqText,
    path: reqPath,
    featureError: feature.error || null,
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
    taskClass,
    objective: objective || mandatory.fields.objective || '',
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

  if (json) {
    console.log(compiler.formatJson(pack));
  } else {
    console.log(compiler.formatMarkdown(pack));
  }
  return finishRuntime(pack.exitCode);
}

module.exports = {
  ContextPackCompiler,
  TASK_CLASS_BUDGETS,
  handleContextPackCommand,
  loadLiveDecisions,
};
