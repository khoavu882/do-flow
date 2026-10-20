'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EvidenceLedger } = require('./evidence-ledger.ts');
const { ClaimsManager } = require('./claims.ts');
const { ResearchRequestStore } = require('./research-request.ts');
const { finishRuntime, usageError, EXIT } = require('./cli-result.ts');
const nativeConsoleLog = console.log;
const { resolveFeature } = require('./task-scope.ts');
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

const { TASK_CLASS_BUDGETS, resolveBudget, getRegisteredHarnessIds, getRegisteredHarnesses } = require('./context/budget.ts');
const { createDeliveryEntry, readDeliveryEntry, recordDelivery, makeTokenRecord } = require('./context/delivery-store.ts');
const { boundedAcquire } = require('./task-state.ts');
const pointerTools = require('./context/pointer.ts');
const { arbitrate, emitContext } = require('./context/arbitrate.ts');
const { updateTaskState } = require('./task-state.ts');
const { taskRecord } = require('./task-scope.ts');

let correctiveTrimFallbackCount = 0;
function getCorrectiveTrimFallbackCount(): number { return correctiveTrimFallbackCount; }

/**
 * The live decisions of the feature the caller is working on (IC-012). The feature is resolved
 * from the branch, or from `slug` when the task id is not the feature slug. A feature with no
 * register or an unresolvable feature reads as "not available"; an unreadable register does too,
 * with a `reason`. Neither throws: a context pack is a read, and a missing register must not stop
 * a stage from getting its evidence.
 * @param {{projectRoot:string, slug?:string|null}} options
 * @returns {{available:boolean, live:Array<Object>, liveCount:number, reason?:string}}
 */
function loadLiveDecisions({ projectRoot, slug = null }: any) {
  try {
    const feature = resolveFeature({ projectRoot, slug });
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

function hashSourceFiles(root: string, paths: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const source of [...new Set(paths)].sort()) {
    if (typeof source !== 'string' || source === '') continue;
    const absolute = path.resolve(root, source);
    const relative = path.relative(path.resolve(root), absolute);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) continue;
    try {
      result[relative.split(path.sep).join('/')] = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`;
    } catch { /* unavailable source paths cannot be represented as verified sources */ }
  }
  return result;
}

function sourcesChanged(root: string, sources: Record<string, string>): boolean {
  for (const [source, digest] of Object.entries(sources || {})) {
    const current = hashSourceFiles(root, [source])[source];
    if (current !== digest) return true;
  }
  return false;
}

function classifyStoreFailure(error: any): string {
  if (error?.code === 'store-locked' || error?.message === 'store-locked') return 'store-locked';
  if (error?.code === 'store-unreadable') return 'store-unreadable';
  if (['EACCES', 'EROFS', 'EPERM', 'ENOSPC'].includes(error?.code)) return 'store-unwritable';
  return 'store-unwritable';
}

function profileRetention(harnessId: string | null, profiles: any[] | null): any {
  if (!harnessId) return null;
  const harnesses = profiles || getRegisteredHarnesses();
  return harnesses.find((item: any) => item.id === harnessId)?.contextProfile?.retention || null;
}

function appendPointerExpansion({ projectRoot, taskId, slug, key, expansion, fsImpl = fs }: any): void {
  const { file, seed } = taskRecord({ projectRoot, store: 'delivery', taskId, slug, fsImpl });
  updateTaskState({
    fsImpl, file, prepare: seed,
    acquire: (impl: any, target: string) => boundedAcquire(impl, target, { retries: 3, waitMs: 5 }),
    build(disk: any) {
      const deliveries = Array.isArray(disk?.deliveries) ? disk.deliveries : [];
      let found = false;
      const updated = deliveries.map((entry: any) => {
        if (entry.key !== key) return entry;
        found = true;
        return { ...entry, expansions: [...(entry.expansions || []), expansion] };
      });
      if (!found) {
        const error: any = new Error('delivery entry disappeared');
        error.code = 'entry-evicted';
        throw error;
      }
      return { taskId, deliveries: updated };
    },
  });
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
      pointers: suppliedPointers = [],
      expansion = null,
    } = params;

    const limits = { ...this.options, ...budgetOverrides };
    const contentLimits = {
      maxFiles: limits.maxFiles,
      maxClaims: limits.maxClaims,
      maxEvidenceItems: limits.maxEvidenceItems,
      maxResearchRequests: limits.maxResearchRequests,
      maxStructuralItems: limits.maxStructuralItems,
    };

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
      if (ev.status === 'superseded') {
        nonFreshOmissions.push({
          id: ev.id,
          field: 'evidenceSummary',
          reason: 'superseded',
        });
      } else if (ev.freshness?.status === 'FRESH') {
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
      suppliedPointers.forEach((p: any) => items.push(buildPointerItem(p)));
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
    const registeredHarnessIds = getRegisteredHarnessIds();
    const reservedHarnessWidth = Math.max(...registeredHarnessIds.map((id: string) => id.length), 0);
    const selfRefWidth = Math.max(budgetOverrides.selfRefWidth ?? this.options.selfRefWidth ?? 0, reservedHarnessWidth);
    const longestHarnessId = registeredHarnessIds.reduce((longest: string, id: string) => id.length > longest.length ? id : longest, 'unstated');
    const envelopeBudget = {
      ...resolvedBudget,
      harness: { ...resolvedBudget.harness, id: longestHarnessId },
    };

    const { envelopeMd, envelopeJson } = computeEnvelopes({
      taskId,
      taskClass: effectiveTaskClass,
      budget: envelopeBudget,
      mandatory: paramMandatory,
      empty,
      mode: bare ? 'bare' : (paramMode || 'full'),
      hasMandatoryItems,
      limits,
      selfRefWidth,
      recordingExpected: params.recordingExpected === true,
      // Reserve the longest registered identity and delivery form for parity.
      form: 'markdown',
      harnessId: longestHarnessId,
    });

    const hasMandatoryRequests = !bare && blockingUnanswered.length > 0;
    let deltaInfo: any = null;
    let unchangedOmissions: any[] = [];
    let removedIds: string[] = [];
    let fitItems = items;
    if (params.deltaSinceEntry && paramMode === 'delta') {
      const oldItems = params.deltaSinceEntry.items || {};
      const currentIds = new Set(items.map((item: any) => item.id));
      const added: string[] = [];
      const changed: string[] = [];
      const unchanged: string[] = [];
      fitItems = [];
      for (const item of items) {
        const oldDigest = oldItems[item.id];
        if (item.cls === 'mandatory') {
          if (!oldDigest) added.push(item.id);
          else if (oldDigest !== item.digest) changed.push(item.id);
          else unchanged.push(item.id);
          fitItems.push(item);
        } else if (!oldDigest) {
          added.push(item.id); fitItems.push({ ...item, deltaForced: true });
        } else if (oldDigest === item.digest) {
          unchanged.push(item.id);
          unchangedOmissions.push({ id: item.id, field: item.field, reason: 'unchanged' });
        } else {
          changed.push(item.id); fitItems.push({ ...item, deltaForced: true });
        }
      }
      removedIds = Object.keys(oldItems).filter((id: string) => !currentIds.has(id));
      deltaInfo = { since, added, changed, removed: removedIds, unchanged };
    }

    const fit = linearFit({
      items: fitItems,
      budget: resolvedBudget.maxBytes,
      taskId,
      taskClass: effectiveTaskClass,
      envelopeMd,
      envelopeJson,
      initialOmissions: bare ? [] : [...nonFreshOmissions, ...unchangedOmissions],
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
      const packTotalBytes = fit.totalBytes;
      const packMandatoryBytes = fit.mandatoryBytesByForm?.[params.form === 'markdown' ? 'markdown' : 'json'] ?? fit.mandatoryBytes;
      const packOptionalBytes = packTotalBytes - packMandatoryBytes;

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
          excessBytes: Math.max(0, packTotalBytes - resolvedBudget.maxBytes),
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
        ...(expansion ? { expansion } : {}),
        relevantFiles: keptFiles,
        evidenceCount: keptEvidence.length,
        evidenceSummary: keptEvidence,
        structuralContext: keptStructural,
        budgetEnforcement: {
          totalFiles: relevantFiles.length,
          totalSupportedClaims: supportedClaims.length,
          totalActiveHypotheses: activeHypotheses.length,
          limits: contentLimits,
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
          tokens: makeTokenRecord(packTotalBytes),
        },
        delivery: {
          key: params.recordingExpected ? `${packDigest}.${params.form || 'json'}.${params.harness?.id || 'unstated'}` : null,
          packDigest,
          recorded: params.recordingExpected === true,
          reason: null,
          since: since || null,
          deltaRefused: params.deltaRefused || null,
        },
        delta: deltaInfo,
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
        deliveryItems: { value: keptItems.map((item: any) => ({ ...item, cls: item.cls || item.class })) },
        deliveryOmissions: { value: bare ? [] : omissionsList.map((item: any) => ({ ...item })) },
        deliveryAllItems: { value: items.map((item: any) => ({ id: item.id, digest: item.digest, cls: item.cls || item.class })) },
        trimOptional: { value: () => {
          const currentItems = (packed as any).deliveryItems as any[];
          let trimIndex = -1;
          for (let i = currentItems.length - 1; i >= 0; i -= 1) {
            if (currentItems[i].cls === 'optional' && !currentItems[i].deltaForced) { trimIndex = i; break; }
          }
          if (trimIndex < 0) return null;
          const dropped = currentItems[trimIndex];
          const nextItems = currentItems.filter((_: any, i: number) => i !== trimIndex);
          const nextOmissions = [...(packed as any).deliveryOmissions, {
            id: dropped.id, field: dropped.field, reason: 'budget', ...(dropped.freshness ? { freshness: dropped.freshness } : {}),
          }];
          return assemblePack(nextItems, nextOmissions, false, null);
        } },
      });
      return packed;
    };

    let pack: any = assemblePack(fit.kept, fit.omissions, fit.overflow, fit.cause);

    if (enableCorrective && pack.status === 'OK') {
      let currentKept = [...fit.kept];
      let currentOmissions = [...fit.omissions];
      let fallbackCounted = false;

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
          if ((it.cls === 'optional' || it.class === 'optional') && !it.deltaForced) {
            lastOptIdx = idx;
            break;
          }
        }

        if (lastOptIdx === -1) {
          const mandatoryOnlyKept = currentKept.filter((i: any) => i.cls === 'mandatory' || i.class === 'mandatory' || i.deltaForced);
          const allOptOmitted = [
            ...(bare ? [] : nonFreshOmissions),
            ...items.filter((i: any) => (i.cls === 'optional' || i.class === 'optional') && !i.deltaForced).map((i: any) => ({
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

        if (!fallbackCounted) {
          correctiveTrimFallbackCount += 1;
          fallbackCounted = true;
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

    const fittedOutput = params.form === 'markdown'
      ? formatMarkdown(pack, { throwOnOverBudget: false })
      : formatJson(pack, { throwOnOverBudget: false });
    pack.size.totalBytes = Buffer.byteLength(fittedOutput, 'utf8');
    pack.size.optionalBytes = pack.size.totalBytes - pack.size.mandatoryBytes;
    pack.packEnd.bytes = pack.size.totalBytes;
    pack.accounting.tokens = makeTokenRecord(pack.size.totalBytes);

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
 * @param {string} [options.sourceRoot] the checkout the verb runs in (default stateRoot)
 * @param {string} [options.slug] feature slug, when the task id is not the feature's own
 * @returns {number} exit code
 */
function handleContextPackCommand({
  taskId,
  taskClass = 'feature',
  objective,
  json = false,
  stateRoot,
  sourceRoot,
  slug,
  mandatoryFile,
  harness = null,
  maxBytes,
  bare = false,
  noRecord = false,
  reason = null,
  since = null,
  expand = null,
  profiles = null,
}: any = {}) {
  const root = stateRoot || process.cwd();
  // 115 IC-004/IC-007: records live under `root`; the feature folder, its plan and pointers, and the
  // source files a delivery hashes are read in the checkout the verb runs in.
  const source = sourceRoot || root;
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
  let baseBudget: any = null;
  if (maxBytes !== undefined && maxBytes !== null) {
    const parsed = typeof maxBytes === 'number' ? maxBytes : parseInt(String(maxBytes).trim(), 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || (typeof maxBytes === 'string' && !/^[1-9]\d*$/.test(maxBytes.trim()))) {
      return usageError('context-pack', '--max-bytes must be a positive integer', json);
    }
    parsedMaxBytes = parsed;

    baseBudget = resolveBudget({ taskClass: effectiveTaskClass, harnessFlag: harness, profiles });
    if (parsedMaxBytes > baseBudget.maxBytes && !reason) {
      return usageError('context-pack', `--max-bytes (${parsedMaxBytes}) exceeds resolved budget (${baseBudget.maxBytes}) and requires --reason`, json);
    }
  }

  const budget = resolveBudget({ taskClass: effectiveTaskClass, maxBytes: parsedMaxBytes, harnessFlag: harness, profiles });

  const feature = resolveFeature({ projectRoot: source, slug: slug || null });

  let deltaExpansions: any[] = [];
  if (parsedMaxBytes !== undefined) {
    if (!baseBudget) {
      baseBudget = resolveBudget({ taskClass: effectiveTaskClass, harnessFlag: harness, profiles });
    }
    if (parsedMaxBytes > baseBudget.maxBytes) {
      deltaExpansions.push({ at: new Date().toISOString(), kind: 'cap-raised', target: null, reason, bytesAdded: null });
    }
  }
  const basis = resolveDeltaBasis({ root, source, taskId, slug, since: expand ? null : since, budget, profiles });
  const { sinceEntry, deltaRefused, retention } = basis;
  if (basis.expansion) deltaExpansions.push(basis.expansion);

  if (expand) {
    const prior = readDeliveryEntry({ projectRoot: root, taskId, slug, packDigest: since });
    if (!prior) return usageError('context-pack', `Unknown digest '${since}'`, json);
    const pointer = (prior.pointers || []).find((candidate: any) => candidate.id === expand);
    if (!pointer) return usageError('context-pack', `Unknown pointer '${expand}' in digest '${since}'`, json);
    const current = pointerTools.readPointerSlice({ projectRoot: source, pointer });
    if (!current) return usageError('context-pack', `Unknown pointer '${expand}' in digest '${since}'`, json);
    const compiler = new ContextPackCompiler();
    const pack = compiler.compileContextPack({ taskId, taskClass: effectiveTaskClass, objective: '', mandatory: { fields: {}, provenance: {} }, budget,
      mode: 'expand', expansion: { id: expand, path: pointer.path, content: current.slice, targetChanged: current.digest !== pointer.digest } });
    pack.status = 'OK';
    pack.exitCode = EXIT.OK;
    pack.mode = 'expand';
    pack.delivery = { key: prior.key, packDigest: since, recorded: false, reason: noRecord ? 'no-record' : null,
      since, deltaRefused: null, expansionRecorded: false };
    pack.packEnd.mode = 'expand';
    pack.packEnd.digest = since.slice(7, 19);
    const sliceBytes = Buffer.byteLength(current.slice, 'utf8');
    let output = '';
    let emitted = 0;
    for (let render = 0; render < 3; render += 1) {
      output = json ? compiler.formatJson(pack, { throwOnOverBudget: false }) : compiler.formatMarkdown(pack, { throwOnOverBudget: false });
      emitted = Buffer.byteLength(output, 'utf8');
      const tokenValue = Math.ceil(emitted / 4);
      if (pack.accounting.tokens?.estimated?.value === tokenValue) break;
      pack.accounting.tokens = makeTokenRecord(emitted);
    }
    if (emitted > budget.maxBytes) {
      return usageError('context-pack', `slice is ${emitted} B, over the ${budget.maxBytes} B cap (${budget.source}); re-run with --max-bytes ${emitted} --reason "${reason}"`, json);
    }
    let expansionRecorded = false;
    let recordReason: string | null = noRecord ? 'no-record' : null;
    if (!noRecord) {
      const expansionRecord = { at: new Date().toISOString(), kind: 'pointer-followed', target: expand, reason,
        bytesAdded: sliceBytes, targetChanged: current.digest !== pointer.digest };
      try {
        appendPointerExpansion({ projectRoot: root, taskId, slug, key: prior.key, expansion: expansionRecord });
        expansionRecorded = true;
        recordReason = null;
      } catch (error: any) {
        recordReason = error?.code === 'entry-evicted' ? 'entry-evicted' : classifyStoreFailure(error);
      }
    }
    pack.delivery.recorded = expansionRecorded;
    pack.delivery.reason = recordReason;
    pack.delivery.expansionRecorded = expansionRecorded;
    pack.expansionRecorded = expansionRecorded;
    for (let render = 0; render < 3; render += 1) {
      output = json ? compiler.formatJson(pack, { throwOnOverBudget: false }) : compiler.formatMarkdown(pack, { throwOnOverBudget: false });
      emitted = Buffer.byteLength(output, 'utf8');
      const tokenValue = Math.ceil(emitted / 4);
      if (pack.accounting.tokens?.estimated?.value === tokenValue) break;
      pack.accounting.tokens = makeTokenRecord(emitted);
    }
    if (console.log !== nativeConsoleLog) console.log(output);
    else process.stdout.write(output);
    return finishRuntime(EXIT.OK);
  }

  let mandatory = gatherMandatory({ root: source, taskId, feature });

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

  const { pack, output } = deliverPack({
    root, source, taskId, slug, effectiveTaskClass, objective, mandatory, budget, harness, parsedMaxBytes, bare, noRecord,
    json, reason, since, sinceEntry, deltaRefused, deltaExpansions, expand, retention, feature,
  });
  if (console.log !== nativeConsoleLog) {
    console.log(output);
  } else {
    process.stdout.write(output);
  }
  return finishRuntime(pack.exitCode);
}

/**
 * The context-pack verb's compile, fit, render and delivery-record steps for a full or delta pack,
 * with no output: `handleContextPackCommand()` prints the result and `packForEmission()` hands it
 * to `emitContext()`. Returns the final pack and its rendered text in the requested form.
 */
function deliverPack({
  root, source = root, taskId, slug, effectiveTaskClass, objective, mandatory, budget, harness, parsedMaxBytes, bare, noRecord,
  json, reason, since, sinceEntry, deltaRefused, deltaExpansions, expand, retention, feature,
}: any): { pack: any; output: string } {
  const ledger = new EvidenceLedger({ repoRoot: root, slug });
  ledger.load(taskId);
  const claims = new ClaimsManager({ evidenceLedger: ledger, repoRoot: root, slug });
  claims.load(taskId);
  claims.evaluateAll();

  const researchRequests = new ResearchRequestStore({ projectRoot: root, slug }).list(taskId);

  const compiler = new ContextPackCompiler();
  let pack = compiler.compileContextPack({
    taskId,
    taskClass: effectiveTaskClass,
    objective: objective !== undefined && objective !== null ? objective : undefined,
    mandatory,
    budget,
    harness,
    maxBytes: parsedMaxBytes,
    bare,
    noRecord,
    recordingExpected: !noRecord,
    form: json ? 'json' : 'markdown',
    reason,
    since,
    mode: since && !deltaRefused && !expand ? 'delta' : undefined,
    deltaSinceEntry: since && !deltaRefused && !expand ? sinceEntry : null,
    deltaRefused,
    expand,
    pointers: pointerTools.collectPointers({ projectRoot: source, feature }),
    evidenceLedger: ledger,
    claimsManager: claims,
    researchRequests,
    decisions: loadLiveDecisions({ projectRoot: source, slug: slug || null }),
  });

  let deliverySources: any = null;
  let deliveryRetention: any = null;
  const form = json ? 'json' : 'markdown';
  let deliveryRecorded = !noRecord;
  let deliveryReason: string | null = noRecord ? 'no-record' : null;
  pack.delivery.recorded = deliveryRecorded;
  pack.delivery.reason = deliveryReason;
  pack.delivery.key = noRecord ? null : `${pack.delivery.packDigest}.${form}.${budget.harness?.id || 'unstated'}`;
  pack.omissions = pack.mode === 'bare' ? pack.omissions : compose.groupOmissions(pack.deliveryOmissions, !noRecord);
  if (pack.status === 'OVERFLOW') {
    pack = { ...pack, deliveryOmissions: pack.deliveryOmissions.map((item: any) => item.reason === 'budget' ? { ...item, reason: 'mandatory-overflow' } : item) };
    pack.omissions = pack.mode === 'bare' ? pack.omissions : compose.groupOmissions(pack.deliveryOmissions, !noRecord);
  }
  if (!noRecord) {
    deliverySources = hashSourceFiles(source, pack.relevantFiles || []);
    deliveryRetention = retention?.value === 'supported' || retention?.value === 'unsupported'
      ? { status: retention.value, basis: `declared:${retention.source || 'profile'}` }
      : { status: 'unknown', basis: retention?.unverified || 'contextProfile.retention is unverified' };
  }

  const renderTrimmed = (): { output: string; bytes: number } => {
    while (true) {
      let mdOutput = '';
      let jsonOutput = '';
      let mdBytes = 0;
      let jsonBytes = 0;
      let stable = false;
      for (let render = 0; render < 3; render += 1) {
        mdOutput = compiler.formatMarkdown(pack, { throwOnOverBudget: false });
        jsonOutput = compiler.formatJson(pack, { throwOnOverBudget: false });
        mdBytes = Buffer.byteLength(mdOutput, 'utf8');
        jsonBytes = Buffer.byteLength(jsonOutput, 'utf8');
        const emitted = json ? jsonBytes : mdBytes;
        const priorBytes = pack.size.totalBytes;
        const priorOptionalBytes = pack.size.optionalBytes;
        const tokens = makeTokenRecord(emitted);
        const priorValue = pack.accounting.tokens?.estimated?.value;
        pack.size.totalBytes = emitted;
        pack.size.optionalBytes = emitted - pack.size.mandatoryBytes;
        pack.accounting.tokens = tokens;
        if (priorValue === tokens.estimated.value && priorBytes === emitted && priorOptionalBytes === pack.size.optionalBytes) { stable = true; break; }
      }
      if (!stable) {
        mdOutput = compiler.formatMarkdown(pack, { throwOnOverBudget: false });
        jsonOutput = compiler.formatJson(pack, { throwOnOverBudget: false });
        mdBytes = Buffer.byteLength(mdOutput, 'utf8');
        jsonBytes = Buffer.byteLength(jsonOutput, 'utf8');
        pack.size.totalBytes = json ? jsonBytes : mdBytes;
        pack.size.optionalBytes = pack.size.totalBytes - pack.size.mandatoryBytes;
        pack.accounting.tokens = makeTokenRecord(pack.size.totalBytes);
      }
      if (pack.status !== 'OK' || (mdBytes <= budget.maxBytes && jsonBytes <= budget.maxBytes)) {
        const output = json ? jsonOutput : mdOutput;
        const bytes = json ? jsonBytes : mdBytes;
        pack.packEnd.bytes = bytes;
        pack.size.totalBytes = bytes;
        pack.size.optionalBytes = bytes - pack.size.mandatoryBytes;
        pack.accounting.tokens = makeTokenRecord(bytes);
        return { output, bytes };
      }
      const trimmed = (pack as any).trimOptional?.();
      if (trimmed) {
        pack = trimmed;
        pack.delivery.recorded = deliveryRecorded;
        pack.delivery.reason = deliveryReason;
        pack.delivery.key = deliveryRecorded ? `${pack.delivery.packDigest}.${form}.${budget.harness?.id || 'unstated'}` : null;
        pack.accounting.tokens = makeTokenRecord(json ? jsonBytes : mdBytes);
        pack.omissions = pack.mode === 'bare' ? pack.omissions : compose.groupOmissions(pack.deliveryOmissions, !noRecord);
        continue;
      }
      const cause = pack.size.mandatoryBytes > budget.maxBytes ? 'mandatory' : 'accounting';
      pack.status = 'OVERFLOW';
      pack.exitCode = EXIT.OVERFLOW;
      if (cause === 'mandatory') {
        pack = { ...pack, deliveryOmissions: pack.deliveryOmissions.map((item: any) => item.reason === 'budget' ? { ...item, reason: 'mandatory-overflow' } : item) };
        pack.omissions = pack.mode === 'bare' ? pack.omissions : compose.groupOmissions(pack.deliveryOmissions, !noRecord);
      }
      pack.overflow = { cause, mandatoryBytes: pack.size.mandatoryBytes, budgetBytes: budget.maxBytes,
        excessBytes: Math.max(0, Math.max(mdBytes, jsonBytes) - budget.maxBytes), action: 'split-or-new-session' };
      pack.overflowAction = { message: cause === 'accounting'
        ? `The omission record brings the pack to ${Math.max(mdBytes, jsonBytes)} B against a ${budget.maxBytes} B budget.`
        : `It is ${pack.size.mandatoryBytes} B against a ${budget.maxBytes} B budget (${budget.source}).` };
      let output = '';
      let bytes = 0;
      for (let render = 0; render < 3; render += 1) {
        output = json ? compiler.formatJson(pack, { throwOnOverBudget: false }) : compiler.formatMarkdown(pack, { throwOnOverBudget: false });
        bytes = Buffer.byteLength(output, 'utf8');
        const tokenValue = Math.ceil(bytes / 4);
        if (pack.accounting.tokens?.estimated?.value === tokenValue) break;
        pack.accounting.tokens = makeTokenRecord(bytes);
      }
      pack.packEnd.bytes = bytes;
      pack.size.totalBytes = bytes;
      return { output, bytes };
    }
  };
  let rendered = renderTrimmed();
  let output = rendered.output;
  let emittedBytes = rendered.bytes;
  if (!noRecord) {
    const entry = createDeliveryEntry({ pack: { ...pack, deliveryOmissions: pack.deliveryOmissions }, form, harness: budget.harness?.id || null,
      sources: deliverySources, expansions: deltaExpansions, retention: deliveryRetention });
    entry.bytes = emittedBytes;
    entry.tokens = makeTokenRecord(emittedBytes);
    try {
      const result = recordDelivery({ projectRoot: root, taskId, slug, entry, acquire: boundedAcquire });
      pack.delivery.key = result?.key || entry.key;
      deliveryRecorded = true;
      deliveryReason = null;
      pack.delivery.recorded = deliveryRecorded;
      pack.delivery.reason = deliveryReason;
    } catch (error: any) {
      deliveryRecorded = false;
      deliveryReason = classifyStoreFailure(error);
      pack.delivery.key = null;
      pack.delivery.recorded = deliveryRecorded;
      pack.delivery.reason = deliveryReason;
    }
    pack.omissions = pack.mode === 'bare' ? pack.omissions : compose.groupOmissions(pack.deliveryOmissions, pack.delivery.recorded);
    rendered = renderTrimmed();
    output = rendered.output;
    emittedBytes = rendered.bytes;
  }
  if (pack.status === 'OVERFLOW') {
    pack.overflow.excessBytes = Math.max(0, emittedBytes - budget.maxBytes);
    pack.overflowAction.message = formatOverflowMessage({
      cause: pack.overflow.cause,
      mandatoryBytes: pack.size.mandatoryBytes,
      totalBytes: emittedBytes,
      budgetBytes: budget.maxBytes,
      source: budget.source,
    });
    rendered = renderTrimmed();
    output = rendered.output;
    emittedBytes = rendered.bytes;
    pack.packEnd.bytes = emittedBytes;
    pack.size.totalBytes = emittedBytes;
  }
  return { pack, output };
}

/** The delta basis of a `since` digest: its delivery entry, or why a delta was refused (widened to full). */
function resolveDeltaBasis({ root, source = root, taskId, slug, since, budget, profiles }: any) {
  const retention = profileRetention(budget.harness?.id || null, profiles);
  let sinceEntry: any = null;
  let deltaRefused: string | null = null;
  let expansion: any = null;
  if (since) {
    sinceEntry = readDeliveryEntry({ projectRoot: root, taskId, slug, packDigest: since });
    if (!sinceEntry) deltaRefused = 'since-unknown';
    else if (sourcesChanged(source, sinceEntry.sources || {})) deltaRefused = 'sources-changed';
    else if (!budget.harness?.id) deltaRefused = 'harness-unstated';
    else if (retention?.value !== 'supported') deltaRefused = 'retention-unproven';
    if (deltaRefused) {
      expansion = { at: new Date().toISOString(), kind: 'delta-widened', target: null, reason: deltaRefused, bytesAdded: null };
    }
  }
  return { sinceEntry, deltaRefused, retention, expansion };
}

/** The mandatory fields of a task from its feature's requirement.md and the task's plan stories. */
function gatherMandatory({ root, taskId, feature }: any) {
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

  return extractMandatory({
    text: reqText,
    path: reqPath,
    featureError: feature.error ? (feature.message || feature.error) : null,
    taskStories,
  });
}

/**
 * 078 IC-001: the context pack `emitContext()` delivers on `launch` and `delta`, compiled by
 * compileContextPack() through the verb's own steps, with `maxBytes` as the budget and `since` the
 * unit's last delivered pack digest (a delta when its entry qualifies, else widened to full).
 * `noRecord` (peek) leaves the delivery store untouched. Rendered as markdown.
 */
function packForEmission({ root, stateRoot = root, taskId = 'default', taskClass = 'feature', slug = null, harness = null, maxBytes, since = null, noRecord = false, env = process.env }: any): { pack: any; output: string } {
  const budget = resolveBudget({ taskClass, maxBytes, harnessFlag: harness, env });
  const feature = resolveFeature({ projectRoot: root, slug: slug || null });
  // 115 C-2: the delivery record goes where `context-pack` puts it, under the state root; the feature
  // folder, the plan and the hashed source files are read in `root`, the checkout emitting.
  const basis = resolveDeltaBasis({ root: stateRoot, source: root, taskId, slug, since, budget, profiles: null });
  return deliverPack({
    root: stateRoot, source: root, taskId, slug, effectiveTaskClass: taskClass, objective: undefined, mandatory: gatherMandatory({ root, taskId, feature }),
    budget, harness, parsedMaxBytes: maxBytes, bare: false, noRecord, json: false, reason: null, since,
    sinceEntry: basis.sinceEntry, deltaRefused: basis.deltaRefused, deltaExpansions: basis.expansion ? [basis.expansion] : [],
    expand: null, retention: basis.retention, feature,
  });
}

module.exports = {
  ContextPackCompiler,
  arbitrate,
  emitContext,
  TASK_CLASS_BUDGETS,
  handleContextPackCommand,
  loadLiveDecisions,
  packForEmission,
  getCorrectiveTrimFallbackCount,
};
