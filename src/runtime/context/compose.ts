'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const crypto = require('node:crypto');

/**
 * IC-006 Pack item model and classification table.
 * Exactly 17 rows, exported frozen.
 */
const FIELD_CLASSES = Object.freeze([
  Object.freeze({ field: 'objective', cls: 'mandatory', class: 'mandatory', optionalPriority: 'n/a', priority: null, itemId: 'objective' }),
  Object.freeze({ field: 'acceptanceCriteria', cls: 'mandatory', class: 'mandatory', optionalPriority: 'n/a', priority: null, itemId: 'ac:<n>' }),
  Object.freeze({ field: 'constraints', cls: 'mandatory', class: 'mandatory', optionalPriority: 'n/a', priority: null, itemId: 'nfr:<NFR-id>' }),
  Object.freeze({ field: 'verificationRequirements', cls: 'mandatory', class: 'mandatory', optionalPriority: 'n/a', priority: null, itemId: 'vr:<n>' }),
  Object.freeze({ field: 'scopeExcluded', cls: 'mandatory', class: 'mandatory', optionalPriority: 'n/a', priority: null, itemId: 'scope:<n>' }),
  Object.freeze({ field: 'claims.conflicts', cls: 'mandatory', class: 'mandatory', optionalPriority: 'n/a', priority: null, itemId: 'claim id' }),
  Object.freeze({ field: 'blockingGaps', cls: 'mandatory', class: 'mandatory', optionalPriority: 'n/a', priority: null, itemId: 'gap:<n>' }),
  Object.freeze({ field: 'researchRequests (blocking, not ANSWERED)', cls: 'mandatory', class: 'mandatory', optionalPriority: 'n/a', priority: null, itemId: 'request id' }),
  Object.freeze({ field: 'decisions.reason (register unreadable)', cls: 'mandatory', class: 'mandatory', optionalPriority: 'n/a', priority: null, itemId: 'decisions:reason' }),
  Object.freeze({ field: 'decisions.live', cls: 'optional', class: 'optional', optionalPriority: 1, priority: 1, itemId: 'decision id' }),
  Object.freeze({ field: 'claims.supported', cls: 'optional', class: 'optional', optionalPriority: 2, priority: 2, itemId: 'claim id' }),
  Object.freeze({ field: 'researchRequests (others)', cls: 'optional', class: 'optional', optionalPriority: 3, priority: 3, itemId: 'request id' }),
  Object.freeze({ field: 'claims.hypotheses', cls: 'optional', class: 'optional', optionalPriority: 4, priority: 4, itemId: 'claim id' }),
  Object.freeze({ field: 'pointers', cls: 'optional', class: 'optional', optionalPriority: 5, priority: 5, itemId: 'pointer id (IC-016)' }),
  Object.freeze({ field: 'relevantFiles', cls: 'optional', class: 'optional', optionalPriority: 6, priority: 6, itemId: 'file:<path>' }),
  Object.freeze({ field: 'evidenceSummary', cls: 'optional', class: 'optional', optionalPriority: 7, priority: 7, itemId: 'evidence id' }),
  Object.freeze({ field: 'structuralContext', cls: 'optional', class: 'optional', optionalPriority: 8, priority: 8, itemId: 'struct:<n>' }),
]);

const ITEM_CAP_LIMITS: Record<string, number> = Object.freeze({
  relevantFiles: 15,
  'claims.supported': 20,
  'claims.hypotheses': 20,
  evidenceSummary: 25,
  'researchRequests (others)': 20,
});

/**
 * Produces canonical JSON with sorted object keys.
 */
function canonicalJson(val: any): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(val).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(val[k])).join(',') + '}';
}

/**
 * Computes sha256 digest of canonical JSON.
 */
function itemDigest(value: any): string {
  const hash = crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
  return `sha256:${hash}`;
}

/**
 * Computes sha256 of the ordered list of item digests.
 */
function computePackDigest(items: any[]): string {
  const hash = crypto.createHash('sha256');
  for (const item of items) {
    hash.update((item.digest || '') + '\n');
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Constructs a PackItem, enforcing that `field` exists in FIELD_CLASSES (FR-011).
 */
function buildPackItem({
  id,
  field,
  value,
  md,
  priority = null,
  mdBytes,
  jsonBytes,
  digest,
  freshness,
}: any): any {
  const entry = FIELD_CLASSES.find((e: any) => e.field === field);
  if (!entry) {
    throw new Error(`Field '${field}' is outside the IC-006 classification table (FR-011)`);
  }
  const cls = entry.cls;
  const prio = priority !== null && priority !== undefined ? priority : (entry.priority ?? 0);
  const computedMdBytes = mdBytes !== undefined ? mdBytes : Buffer.byteLength(md, 'utf8');
  const computedJsonBytes = jsonBytes !== undefined
    ? jsonBytes
    : (Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8') + 6);
  const computedDigest = digest !== undefined ? digest : itemDigest(value);

  return {
    id,
    field,
    cls,
    priority: prio,
    value,
    md,
    jsonBytes: computedJsonBytes,
    mdBytes: computedMdBytes,
    digest: computedDigest,
    ...(freshness ? { freshness } : {}),
  };
}

// Item builders for existing fields
function buildObjectiveItem(objective: string): any {
  return buildPackItem({
    id: 'objective',
    field: 'objective',
    value: objective,
    md: objective ? `**Objective:** ${objective}\n\n` : '',
    priority: 0,
  });
}

function buildConstraintItem(c: any, index: number = 0): any {
  const id = typeof c === 'object' && c.id ? c.id : `nfr:${index + 1}`;
  const text = typeof c === 'object' ? c.text : c;
  const kind = typeof c === 'object' ? c.kind : 'constraint';
  const val = typeof c === 'object' ? c : { id, text, kind };
  return buildPackItem({
    id,
    field: 'constraints',
    value: val,
    md: `- ! ${id} ${text} (${kind})\n`,
    priority: 0,
  });
}

function buildAcceptanceCriteriaItem(ac: any, index: number = 0): any {
  const id = typeof ac === 'object' && ac.id ? ac.id : `ac:${index + 1}`;
  const text = typeof ac === 'object' ? ac.text : ac;
  const reqs = typeof ac === 'object' && Array.isArray(ac.requirements) ? ac.requirements : [];
  const stories = typeof ac === 'object' && Array.isArray(ac.stories) ? ac.stories : [];
  const val = typeof ac === 'object' ? ac : { id, text, requirements: reqs, stories };
  const suffix = reqs.length > 0 ? ` (${reqs.join(', ')})` : '';
  return buildPackItem({
    id,
    field: 'acceptanceCriteria',
    value: val,
    md: `- [ ] ${text}${suffix}\n`,
    priority: 0,
  });
}

function buildVerificationRequirementItem(vr: any, index: number = 0): any {
  const id = typeof vr === 'object' && vr.id ? vr.id : `vr:${index + 1}`;
  const text = typeof vr === 'object' ? vr.text : vr;
  const val = typeof vr === 'object' ? vr : { id, text };
  return buildPackItem({
    id,
    field: 'verificationRequirements',
    value: val,
    md: `- ${text}\n`,
    priority: 0,
  });
}

function buildScopeExcludedItem(scope: any, index: number = 0): any {
  const id = typeof scope === 'object' && scope.id ? scope.id : `scope:${index + 1}`;
  const text = typeof scope === 'object' ? scope.text : scope;
  const val = typeof scope === 'object' ? scope : { id, text };
  return buildPackItem({
    id,
    field: 'scopeExcluded',
    value: val,
    md: `- ${text}\n`,
    priority: 0,
  });
}

function buildClaimConflictItem(claim: any): any {
  const supporting = Array.isArray(claim.supportingEvidence) ? claim.supportingEvidence : [];
  const contradicting = Array.isArray(claim.contradictingEvidence) ? claim.contradictingEvidence : [];
  return buildPackItem({
    id: claim.id,
    field: 'claims.conflicts',
    value: {
      id: claim.id,
      statement: claim.statement,
      supportingEvidence: supporting,
      contradictingEvidence: contradicting,
    },
    md: `- CONFLICT ${claim.statement} (supports: ${supporting.join(', ')}; contradicts: ${contradicting.join(', ')})\n`,
    priority: 0,
  });
}

function buildBlockingGapItem(gap: any, index: number = 0): any {
  const id = typeof gap === 'object' && gap.id ? gap.id : `gap:${index + 1}`;
  const text = typeof gap === 'object' ? gap.text : gap;
  const val = typeof gap === 'object' ? gap : { id, text, source: 'requirement' };
  return buildPackItem({
    id,
    field: 'blockingGaps',
    value: val,
    md: `- ${text}\n`,
    priority: 0,
  });
}

function buildResearchRequestItem(r: any): any {
  const isBlockingUnanswered = Boolean(r.blocking && r.status !== 'ANSWERED');
  const field = isBlockingUnanswered
    ? 'researchRequests (blocking, not ANSWERED)'
    : 'researchRequests (others)';
  const val = {
    id: r.id,
    stageId: r.stageId,
    question: r.question,
    status: r.status,
    blocking: r.blocking,
    claimId: r.claimId,
    evidenceIds: r.evidenceIds,
    gap: r.gap,
  };
  let mdLine = `- ${r.status} ${r.blocking ? '(blocking)' : '(nonblocking)'} ${r.stageId}: ${r.question}`;
  if (r.gap) mdLine += ` — ${r.gap}`;
  if (r.claimId) mdLine += ` (claim: ${r.claimId})`;
  mdLine += '\n';

  return buildPackItem({
    id: r.id,
    field,
    value: val,
    md: mdLine,
    priority: isBlockingUnanswered ? 0 : 3,
  });
}

function buildDecisionReasonItem(reason: string): any {
  return buildPackItem({
    id: 'decisions:reason',
    field: 'decisions.reason (register unreadable)',
    value: { reason },
    md: `- not supplied: register unreadable: ${reason}\n`,
    priority: 0,
  });
}

function buildDecisionLiveItem(d: any): any {
  return buildPackItem({
    id: d.id,
    field: 'decisions.live',
    value: {
      id: d.id,
      topic: d.topic,
      statement: d.statement,
      decidedBy: d.decidedBy,
      stage: d.stage,
    },
    md: `- ${d.id} (${d.topic}): ${d.statement}\n`,
    priority: 1,
  });
}

function buildClaimSupportedItem(c: any): any {
  const ev = Array.isArray(c.evidenceIds) ? c.evidenceIds : [];
  return buildPackItem({
    id: c.id,
    field: 'claims.supported',
    value: { id: c.id, statement: c.statement, evidenceIds: ev },
    md: `- ✓ ${c.statement} *(ev: ${ev.join(', ')})*\n`,
    priority: 2,
  });
}

function buildClaimHypothesisItem(h: any): any {
  const id = typeof h === 'object' && h.id ? h.id : `hypothesis:${typeof h === 'object' ? h.statement : h}`;
  const statement = typeof h === 'object' ? h.statement : h;
  return buildPackItem({
    id,
    field: 'claims.hypotheses',
    value: { id, statement },
    md: `- ? ${statement}\n`,
    priority: 4,
  });
}

function buildPointerItem(p: any): any {
  const rangeStr = p.range ? `:${p.range.startLine}-${p.range.endLine}` : '';
  return buildPackItem({
    id: p.id,
    field: 'pointers',
    value: p,
    md: `- ${p.id} ${p.path}${rangeStr} ${p.bytes} B\n`,
    priority: 5,
  });
}

function buildRelevantFileItem(f: string): any {
  return buildPackItem({
    id: `file:${f}`,
    field: 'relevantFiles',
    value: f,
    md: `- \`${f}\`\n`,
    priority: 6,
  });
}

function buildEvidenceSummaryItem(ev: any): any {
  return buildPackItem({
    id: ev.id,
    field: 'evidenceSummary',
    value: { id: ev.id, kind: ev.kind, locator: ev.locator, summary: ev.summary },
    md: `- [${ev.kind}] ${ev.summary || ''} (${ev.locator?.file || ''})\n`,
    priority: 7,
    freshness: ev.freshness?.status,
  });
}

function buildStructuralContextItem(struct: any, index: number = 0): any {
  const id = `struct:${index + 1}`;
  return buildPackItem({
    id,
    field: 'structuralContext',
    value: struct,
    md: `- ${struct}\n`,
    priority: 8,
  });
}

/**
 * Linear fit on max(md, json) per IC-007.
 */
function linearFit({
  items,
  budget,
  taskId = 'default',
  taskClass = 'feature',
  envelopeMd = 0,
  envelopeJson = 0,
  itemCapLimits = ITEM_CAP_LIMITS,
}: any): any {
  const mandatoryItems = items.filter((i: any) => i.cls === 'mandatory');
  const allOptional = items.filter((i: any) => i.cls === 'optional');

  // Enforce item limits on optional items (reason: 'item-cap')
  const fieldCounts: Record<string, number> = {};
  const eligibleOptional: any[] = [];
  const cappedOmissions: any[] = [];

  for (const item of allOptional) {
    const limit = itemCapLimits[item.field];
    const current = fieldCounts[item.field] || 0;
    if (limit !== undefined && current >= limit) {
      cappedOmissions.push({
        id: item.id,
        field: item.field,
        reason: 'item-cap',
        ...(item.freshness ? { freshness: item.freshness } : {}),
      });
    } else {
      fieldCounts[item.field] = current + 1;
      eligibleOptional.push(item);
    }
  }

  // Cost functions for omissions
  const omissionBytesMd = (item: any) => (item.id.length + 4);
  const omissionBytesJson = (item: any) => (item.id.length + 8);

  // Mandatory costs
  const mandatoryMdBytes = mandatoryItems.reduce((acc: number, i: any) => acc + i.mdBytes, 0) + envelopeMd;
  const mandatoryJsonBytes = mandatoryItems.reduce((acc: number, i: any) => acc + i.jsonBytes, 0) + envelopeJson;

  // Uncompressed omissions cost when all optional items are omitted
  const allOmittedMd = [...eligibleOptional, ...cappedOmissions].reduce((acc: number, i: any) => acc + omissionBytesMd(i), 0);
  const allOmittedJson = [...eligibleOptional, ...cappedOmissions].reduce((acc: number, i: any) => acc + omissionBytesJson(i), 0);

  const initialCostMd = mandatoryMdBytes + allOmittedMd;
  const initialCostJson = mandatoryJsonBytes + allOmittedJson;

  // Check overflow
  if (Math.max(initialCostMd, initialCostJson) > budget) {
    const cause = Math.max(mandatoryMdBytes, mandatoryJsonBytes) > budget ? 'mandatory' : 'accounting';
    const allOmissions = [
      ...eligibleOptional.map((i: any) => ({
        id: i.id,
        field: i.field,
        reason: 'mandatory-overflow',
        ...(i.freshness ? { freshness: i.freshness } : {}),
      })),
      ...cappedOmissions,
    ];
    const fittedOn = initialCostJson > initialCostMd ? 'json' : 'markdown';
    return {
      taskId,
      taskClass,
      budgetBytes: budget,
      totalBytes: Math.max(initialCostMd, initialCostJson),
      mandatoryBytes: Math.max(mandatoryMdBytes, mandatoryJsonBytes),
      optionalBytes: 0,
      overflow: true,
      cause,
      fittedOn,
      kept: mandatoryItems,
      omissions: allOmissions,
      packDigest: computePackDigest(mandatoryItems),
    };
  }

  // Sort optional items by priority ascending, then source order
  const sortedOptional = [...eligibleOptional].sort((a: any, b: any) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return 0; // keeps source order
  });

  let currentCostMd = initialCostMd;
  let currentCostJson = initialCostJson;
  const keptOptional: any[] = [];
  const omissions: any[] = [...cappedOmissions];

  // One linear pass
  for (const opt of sortedOptional) {
    const nextCostMd = currentCostMd + opt.mdBytes - omissionBytesMd(opt);
    const nextCostJson = currentCostJson + opt.jsonBytes - omissionBytesJson(opt);

    if (Math.max(nextCostMd, nextCostJson) <= budget) {
      keptOptional.push(opt);
      currentCostMd = nextCostMd;
      currentCostJson = nextCostJson;
    } else {
      omissions.push({
        id: opt.id,
        field: opt.field,
        reason: 'budget',
        ...(opt.freshness ? { freshness: opt.freshness } : {}),
      });
    }
  }

  const fittedOn = currentCostJson > currentCostMd ? 'json' : 'markdown';
  const totalBytes = Math.max(currentCostMd, currentCostJson);
  const mandatoryBytes = Math.max(mandatoryMdBytes, mandatoryJsonBytes);
  const optionalBytes = totalBytes - mandatoryBytes;
  const kept = [...mandatoryItems, ...keptOptional];

  return {
    taskId,
    taskClass,
    budgetBytes: budget,
    totalBytes,
    mandatoryBytes,
    optionalBytes,
    overflow: false,
    cause: null,
    fittedOn,
    kept,
    omissions,
    packDigest: computePackDigest(kept),
  };
}

module.exports = {
  FIELD_CLASSES,
  ITEM_CAP_LIMITS,
  canonicalJson,
  itemDigest,
  computePackDigest,
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
};
