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
  structuralContext: 5,
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

function computeItemJsonBytes(field: string, value: any): number {
  if (value === undefined || value === null) return 0;
  if (field === 'objective') {
    return Buffer.byteLength(`  "objective": ${JSON.stringify(value)},\n`, 'utf8');
  }
  if (field === 'decisions.reason (register unreadable)') {
    const r = typeof value === 'object' && value.reason ? value.reason : value;
    return Buffer.byteLength(`    "reason": ${JSON.stringify(r)},\n`, 'utf8');
  }
  let indent = '    '; // 4 spaces
  if (field.startsWith('claims.') || field === 'decisions.live') {
    indent = '      '; // 6 spaces
  }
  const raw = JSON.stringify(value, null, 2);
  const lines = raw.split('\n');
  let bytes = 0;
  for (const line of lines) {
    bytes += Buffer.byteLength(indent + line + '\n', 'utf8');
  }
  bytes += 1; // comma ','
  return bytes;
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
    : computeItemJsonBytes(field, value);
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
  let mdLine = isBlockingUnanswered
    ? `- ${r.status} (blocking) ${r.stageId}: ${r.question}`
    : `- ${r.status} ${r.blocking ? '(blocking)' : '(nonblocking)'} ${r.stageId}: ${r.question}`;
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
  const ev = Array.isArray(c.evidenceIds)
    ? c.evidenceIds
    : (Array.isArray(c.supportingEvidence) ? c.supportingEvidence : []);
  const evSuffix = ev.length > 0 ? ` *(ev: ${ev.join(', ')})*` : '';
  return buildPackItem({
    id: c.id,
    field: 'claims.supported',
    value: { id: c.id, statement: c.statement, evidenceIds: ev },
    md: `- ✓ ${c.statement}${evSuffix}\n`,
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

const OPTIONAL_HEADING_BYTES_MD: Record<string, number> = Object.freeze({
  'decisions.live': Buffer.byteLength('### Live decisions\n\n', 'utf8'),
  'claims.supported': Buffer.byteLength('### Supported Facts & Invariants\n\n', 'utf8'),
  'researchRequests (others)': Buffer.byteLength('### Feature Research Requests\n\n', 'utf8'),
  'claims.hypotheses': Buffer.byteLength('### Active Hypotheses (Unverified)\n\n', 'utf8'),
  pointers: Buffer.byteLength('### Pointers\n\n', 'utf8'),
  relevantFiles: Buffer.byteLength('### Relevant File Locators\n\n', 'utf8'),
  evidenceSummary: Buffer.byteLength('### Evidence\n\n', 'utf8'),
  structuralContext: Buffer.byteLength('### Structural Context\n\n', 'utf8'),
});

const OPTIONAL_HEADING_BYTES_JSON: Record<string, number> = Object.freeze({
  'decisions.live': 5,
  'claims.supported': 5,
  'researchRequests (others)': 3,
  'claims.hypotheses': 4,
  pointers: 3,
  relevantFiles: 3,
  evidenceSummary: 3,
  structuralContext: 3,
});

function computeOmissionBytes(omissionsList: any[] = []): { md: number; json: number } {
  if (!omissionsList || omissionsList.length === 0) {
    return { md: 0, json: 0 };
  }
  const grouped = groupOmissions(omissionsList);
  let mdStr = '### Omitted\n';
  for (const g of grouped.groups) {
    const fresh = g.freshness ? ` ${g.freshness}` : '';
    mdStr += `- ${g.reason}${fresh} (${g.count}): ${g.ids.join(', ')}\n`;
  }
  mdStr += '\n';
  const mdBytes = Buffer.byteLength(mdStr, 'utf8');

  const fullBlock = JSON.stringify(grouped, null, 2);
  const emptyBlock = JSON.stringify({ total: 0, groups: [] }, null, 2);
  const fullLines = fullBlock.split('\n');
  const emptyLines = emptyBlock.split('\n');

  const fullBytes = Buffer.byteLength(fullBlock, 'utf8') + fullLines.length * 2;
  const emptyBytes = Buffer.byteLength(emptyBlock, 'utf8') + emptyLines.length * 2;
  const diffJson = Math.max(0, fullBytes - emptyBytes);
  return { md: mdBytes, json: diffJson };
}

/**
 * Computes both envelopes per IC-007 step 2.
 */
function computeEnvelopes({
  taskId = 'default',
  taskClass = 'feature',
  budget,
  mandatory,
  empty = false,
  mode = 'full',
  hasMandatoryItems = {},
  overflow = false,
  overflowAction = null,
  toolLimitNotice = null,
  limits = null,
  selfRefWidth = null,
  recordingExpected = false,
  form = 'json',
  harnessId = 'unstated',
}: any): { envelopeMd: number; envelopeJson: number } {
  // --- Markdown envelope ---
  let md = `## ContextPack: [${taskClass.toUpperCase()}] ${taskId}\n`;
  if (overflowAction?.message) {
    md += `> ${overflowAction.message}\n`;
  }
  if (toolLimitNotice?.message) {
    md += `> ${toolLimitNotice.message}\n`;
  }
  if (mode !== 'bare') {
    const mandSections = [
      { key: 'acceptanceCriteria', heading: '### Acceptance Criteria\n' },
      { key: 'constraints', heading: '### Constraints\n' },
      { key: 'verificationRequirements', heading: '### Verification Requirements\n' },
      { key: 'scopeExcluded', heading: '### Out of Scope\n' },
      { key: 'blockingGaps', heading: '### Blocking Gaps\n' },
    ];
    for (const sec of mandSections) {
      if (hasMandatoryItems[sec.key]) {
        md += sec.heading + '\n';
      } else {
        const prov = mandatory?.provenance?.[sec.key] || mandatory?.fields?.[sec.key] || mandatory?.[sec.key];
        const reason = prov?.reason || 'none';
        md += `${sec.heading}- not supplied: ${reason}\n\n`;
      }
    }
    if (hasMandatoryItems['claims.conflicts']) {
      md += `### Blocking Conflicts\n\n`;
    }
    if (mandatory) {
      md += `### Mandatory Sources\n`;
      const mandKeys = ['objective', 'acceptanceCriteria', 'constraints', 'verificationRequirements', 'scopeExcluded', 'blockingGaps'];
      const provMap = mandatory.provenance || mandatory;
      for (const k of mandKeys) {
        const prov = provMap[k];
        if (prov) {
          if (prov.supplied) {
            const digest12 = prov.digest ? prov.digest.slice(7, 19) : '000000000000';
            const loc = prov.locator ? `${prov.locator}@${digest12}` : `@${digest12}`;
            md += `- ${k}: ${prov.source} ${loc}\n`;
          } else {
            md += `- ${k}: not supplied: ${prov.reason || 'unknown'}\n`;
          }
        }
      }
      md += '\n';
    }
    if (empty) {
      md += `_No evidence or claims are recorded for task '${taskId}'; this pack states nothing._\n\n`;
    }
  }

  const paddedBytes = '000000000';
  const maxBytes = budget?.maxBytes || 225000;
  const source = budget?.source || 'task-class';
  const tokensEst = Math.round(maxBytes / 4);
  if (mode !== 'bare') {
    md += `_Budget ${maxBytes} B (${source}) · emitted ${paddedBytes} B · tokens ~${tokensEst} (estimated:bytes/4) · actual unmeasured_\n`;
  }
  md += `[end of pack] mode=${mode} objective=1 ac=00 constraints=00 verification=00 scope=00 conflicts=00 gaps=00 omitted=000 bytes=${paddedBytes} digest=sha256:000000000000\n`;
  const envelopeMd = Buffer.byteLength(md, 'utf8');

  // --- JSON envelope ---
  const capDigits = String(maxBytes).length;
  const renderedWidth = selfRefWidth !== null && selfRefWidth !== undefined ? selfRefWidth : capDigits;
  const selfRefBytes = Number('9'.repeat(Math.max(1, renderedWidth)));
  const selfRefTokens = Math.round(selfRefBytes / 4);

  const provMap = mandatory?.provenance || mandatory || {};
  const skeletonOrdered: any = {
    version: 1,
    status: overflow ? 'OVERFLOW' : (empty ? 'EMPTY' : 'OK'),
    exitCode: overflow ? 3 : (empty ? 1 : 0),
    taskId,
    taskClass,
    compiledAt: '2026-10-13T00:00:00.000Z',
    mode,
    budget: budget || { maxBytes, source, harness: { id: null, source: 'unstated' }, capacity: { value: null, basis: 'unknown:unstated' }, toolResultLimitBytes: null },
    overflow: overflow ? { cause: 'mandatory', mandatoryBytes: selfRefBytes, budgetBytes: maxBytes, excessBytes: 0, action: 'split-or-new-session' } : null,
    overflowAction: overflowAction ? { message: overflowAction.message } : null,
    toolLimitNotice: toolLimitNotice ? { message: toolLimitNotice.message } : null,
    ...(hasMandatoryItems.objective ? {} : { objective: '' }),
    acceptanceCriteria: [],
    constraints: [],
    verificationRequirements: [],
    scopeExcluded: [],
    blockingGaps: [],
    claims: { conflicts: [], supported: [], hypotheses: [] },
    researchRequests: [],
    mandatory: provMap,
    decisions: { available: true, live: [], liveCount: 0 },
    pointers: [],
    relevantFiles: [],
    evidenceCount: 0,
    evidenceSummary: [],
    structuralContext: [],
    budgetEnforcement: {
      totalFiles: 0,
      totalSupportedClaims: 0,
      totalActiveHypotheses: 0,
      limits: limits ? {
        maxFiles: limits.maxFiles,
        maxClaims: limits.maxClaims,
        maxEvidenceItems: limits.maxEvidenceItems,
        maxResearchRequests: limits.maxResearchRequests,
        maxStructuralItems: limits.maxStructuralItems,
      } : {},
    },
    empty,
    omissions: { total: 0, groups: [] },
    size: { totalBytes: selfRefBytes, mandatoryBytes: selfRefBytes, optionalBytes: selfRefBytes, fittedOn: 'json' },
    accounting: { tokens: { inlineTokensEst: Math.ceil(maxBytes / 4), netTokensEst: Math.ceil(maxBytes / 4), basis: 'estimated:bytes/4', actual: { unmeasured: 'no harness reports token usage to an external CLI; profile tokenTelemetry unverified' } } },
    delivery: { key: recordingExpected ? `${'sha256:' + '0'.repeat(64)}.${form}.${harnessId}` : null, packDigest: 'sha256:' + '0'.repeat(64), recorded: recordingExpected, reason: null, since: null, deltaRefused: null },
    delta: null,
    packEnd: { mode, objective: hasMandatoryItems.objective ? 1 : 0, acceptanceCriteria: 0, constraints: 0, verificationRequirements: 0, scopeExcluded: 0, conflicts: 0, blockingGaps: 0, omitted: 0, bytes: selfRefBytes, digest: 'sha256:000000000000' },
  };

  const jsonStr = JSON.stringify(skeletonOrdered, null, 2) + '\n';
  let envelopeJson = Buffer.byteLength(jsonStr, 'utf8');

  const mandKeysWithItems = ['acceptanceCriteria', 'constraints', 'verificationRequirements', 'scopeExcluded', 'blockingGaps'];
  for (const k of mandKeysWithItems) {
    if (hasMandatoryItems[k]) {
      envelopeJson += 3;
    }
  }
  if (hasMandatoryItems['claims.conflicts']) {
    envelopeJson += 5;
  }
  if (hasMandatoryItems['researchRequests']) {
    envelopeJson += 3;
  }

  return { envelopeMd, envelopeJson };
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
  includeOmissionCosts = true,
  itemCapLimits = ITEM_CAP_LIMITS,
  initialOmissions = [],
  sectionHeadingsMd = OPTIONAL_HEADING_BYTES_MD,
  sectionHeadingsJson = OPTIONAL_HEADING_BYTES_JSON,
}: any): any {
  const mandatoryItems = items.filter((i: any) => i.cls === 'mandatory' || i.class === 'mandatory' || i.deltaForced);
  const allOptional = items.filter((i: any) => (i.cls === 'optional' || i.class === 'optional') && !i.deltaForced);

  // Enforce item limits on optional items (reason: 'item-cap')
  const fieldCounts: Record<string, number> = {};
  const eligibleOptional: any[] = [];
  const cappedOmissions: any[] = [];
  let combinedResearchAndStruct = 0;

  for (const item of allOptional) {
    const limit = itemCapLimits[item.field];
    const current = fieldCounts[item.field] || 0;
    const isResearchOrStruct = item.field === 'researchRequests (others)' || item.field === 'structuralContext';
    const combinedCap = 20;

    if ((limit !== undefined && current >= limit) || (isResearchOrStruct && combinedResearchAndStruct >= combinedCap)) {
      cappedOmissions.push({
        id: item.id,
        field: item.field,
        reason: 'item-cap',
        ...(item.freshness ? { freshness: item.freshness } : {}),
      });
    } else {
      fieldCounts[item.field] = current + 1;
      if (isResearchOrStruct) combinedResearchAndStruct++;
      eligibleOptional.push(item);
    }
  }

  // Mandatory costs
  const mandatoryMdBytes = mandatoryItems.reduce((acc: number, i: any) => acc + i.mdBytes, 0) + envelopeMd;
  const mandatoryJsonBytes = mandatoryItems.reduce((acc: number, i: any) => acc + i.jsonBytes, 0) + envelopeJson;

  // Uncompressed omissions cost when all optional items are omitted
  const allOmitted = [
    ...initialOmissions,
    ...eligibleOptional.map((i: any) => ({
      id: i.id,
      field: i.field,
      reason: 'mandatory-overflow',
      ...(i.freshness ? { freshness: i.freshness } : {}),
    })),
    ...cappedOmissions,
  ];
  const allOmittedBytes = includeOmissionCosts ? computeOmissionBytes(allOmitted) : { md: 0, json: 0 };

  const initialCostMd = mandatoryMdBytes + allOmittedBytes.md;
  const initialCostJson = mandatoryJsonBytes + allOmittedBytes.json;

  // Check overflow
  if (Math.max(initialCostMd, initialCostJson) > budget) {
    const cause = Math.max(mandatoryMdBytes, mandatoryJsonBytes) > budget ? 'mandatory' : 'accounting';
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
      omissions: allOmitted,
      packDigest: computePackDigest(mandatoryItems),
    };
  }

  // Sort optional items by priority ascending, then source order
  const sortedOptional = [...eligibleOptional].sort((a: any, b: any) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return 0; // keeps source order
  });

  const keptOptional: any[] = [];
  const rejectedOptional: any[] = [];
  const activeSections = new Set<string>();

  // One linear pass
  for (const opt of sortedOptional) {
    const trialKept = [...keptOptional, opt];
    const trialSections = new Set(activeSections);
    trialSections.add(opt.field);

    const trialHeadingsMd = Array.from(trialSections).reduce((sum: number, f: string) => sum + (sectionHeadingsMd[f] || 0), 0);
    const trialHeadingsJson = Array.from(trialSections).reduce((sum: number, f: string) => sum + (sectionHeadingsJson[f] || 0), 0);

    const trialKeptMd = trialKept.reduce((acc: number, i: any) => acc + i.mdBytes, 0);
    const trialKeptJson = trialKept.reduce((acc: number, i: any) => acc + i.jsonBytes, 0);

    const trialOmitted = [
      ...initialOmissions,
      ...rejectedOptional.map((i: any) => ({
        id: i.id,
        field: i.field,
        reason: 'budget',
        ...(i.freshness ? { freshness: i.freshness } : {}),
      })),
      ...sortedOptional.slice(sortedOptional.indexOf(opt) + 1).map((i: any) => ({
        id: i.id,
        field: i.field,
        reason: 'budget',
        ...(i.freshness ? { freshness: i.freshness } : {}),
      })),
      ...cappedOmissions,
    ];
    const trialOmissionsBytes = includeOmissionCosts ? computeOmissionBytes(trialOmitted) : { md: 0, json: 0 };

    const trialCostMd = mandatoryMdBytes + trialKeptMd + trialHeadingsMd + trialOmissionsBytes.md;
    const trialCostJson = mandatoryJsonBytes + trialKeptJson + trialHeadingsJson + trialOmissionsBytes.json;

    if (Math.max(trialCostMd, trialCostJson) <= budget) {
      keptOptional.push(opt);
      activeSections.add(opt.field);
    } else {
      rejectedOptional.push(opt);
    }
  }

  const finalOmissions = [
    ...initialOmissions,
    ...rejectedOptional.map((i: any) => ({
      id: i.id,
      field: i.field,
      reason: 'budget',
      ...(i.freshness ? { freshness: i.freshness } : {}),
    })),
    ...cappedOmissions,
  ];
  const finalOmissionsBytes = includeOmissionCosts ? computeOmissionBytes(finalOmissions) : { md: 0, json: 0 };
  const finalHeadingsMd = Array.from(activeSections).reduce((sum: number, f: string) => sum + (sectionHeadingsMd[f] || 0), 0);
  const finalHeadingsJson = Array.from(activeSections).reduce((sum: number, f: string) => sum + (sectionHeadingsJson[f] || 0), 0);
  const finalKeptMd = keptOptional.reduce((acc: number, i: any) => acc + i.mdBytes, 0);
  const finalKeptJson = keptOptional.reduce((acc: number, i: any) => acc + i.jsonBytes, 0);

  const finalCostMd = mandatoryMdBytes + finalKeptMd + finalHeadingsMd + finalOmissionsBytes.md;
  const finalCostJson = mandatoryJsonBytes + finalKeptJson + finalHeadingsJson + finalOmissionsBytes.json;

  const fittedOn = finalCostJson > finalCostMd ? 'json' : 'markdown';
  const totalBytes = Math.max(finalCostMd, finalCostJson);
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
    omissions: finalOmissions,
    packDigest: computePackDigest(kept),
  };
}

/**
 * Groups omissions according to IC-008.
 * Order: not-fresh STALE, not-fresh UNKNOWN, mandatory-overflow, budget, item-cap, unchanged.
 */
function groupOmissions(omissionsList: any[] = [], recorded = false): { total: number; groups: any[] } {
  if (!omissionsList || omissionsList.length === 0) {
    return { total: 0, groups: [] };
  }

  const rank = (g: any): number => {
    if (g.reason === 'not-fresh' && g.freshness === 'STALE') return 1;
    if (g.reason === 'not-fresh' && g.freshness === 'UNKNOWN') return 2;
    if (g.reason === 'not-fresh') return 2;
    if (g.reason === 'mandatory-overflow') return 3;
    if (g.reason === 'budget') return 4;
    if (g.reason === 'item-cap') return 5;
    if (g.reason === 'unchanged') return 6;
    return 7;
  };

  const groupMap = new Map<string, { reason: string; freshness?: string; ids: string[]; ranges: any[] }>();

  for (const item of omissionsList) {
    const key = `${item.reason}:${item.freshness || ''}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        reason: item.reason,
        ...(item.freshness ? { freshness: item.freshness } : {}),
        ids: [],
        ranges: [],
      });
    }
    groupMap.get(key)!.ids.push(item.id);
  }

  const groups = Array.from(groupMap.entries())
    .map(([key, g]) => {
      const matching = omissionsList.filter((item) => `${item.reason}:${item.freshness || ''}` === key);
      const ranges: any[] = [];
      const ranged = new Set<number>();
      if (recorded) {
        for (let start = 0; start < matching.length;) {
          const first = matching[start];
          const match = /^(.+?)(\d+)$/.exec(first.id);
          let end = start;
          if (match) {
            let previous = Number(match[2]);
            for (let i = start + 1; i < matching.length; i += 1) {
              const next = /^(.+?)(\d+)$/.exec(matching[i].id);
              if (matching[i].field !== first.field || !next || next[1] !== match[1] || Number(next[2]) !== previous + 1) break;
              previous = Number(next[2]);
              end = i;
            }
          }
          if (end - start + 1 >= 3) {
            for (let i = start; i <= end; i += 1) ranged.add(i);
            ranges.push({ field: first.field, from: matching[start].id, to: matching[end].id, count: end - start + 1 });
          }
          start = end + 1;
        }
      }
      const ids = g.ids.filter((_, index) => !ranged.has(index));
      return { ...g, ids, ranges, count: g.ids.length };
    })
    .sort((a, b) => rank(a) - rank(b));

  return {
    total: omissionsList.length,
    groups,
  };
}

/**
 * Formats the OVERFLOW notice per IC-005.
 */
function formatOverflowMessage({ cause, mandatoryBytes, totalBytes, budgetBytes, source }: any): string {
  const secondSentence = cause === 'accounting'
    ? `The omission record brings the pack to ${totalBytes} B against a ${budgetBytes} B budget.`
    : `It is ${mandatoryBytes} B against a ${budgetBytes} B budget (${source}).`;
  return `OVERFLOW (exit 3): mandatory content is complete and nothing in it was dropped. ${secondSentence} Split the task or its context, or start a new session, then request the pack again.`;
}

/**
 * Formats short pack digest: sha256:<first 12 hex> per IC-009.
 */
function formatShortDigest(packDigest: string): string {
  if (!packDigest) return 'sha256:000000000000';
  const hex = packDigest.replace(/^sha256:/, '');
  return `sha256:${hex.slice(0, 12)}`;
}

/**
 * Parses the [end of pack] line from the end of a markdown pack.
 * Returns null if the line is missing or malformed.
 */
function parsePackEndLine(md: string): any {
  if (typeof md !== 'string') return null;
  const lines = md.trimEnd().split('\n');
  const lastLine = lines[lines.length - 1];
  if (!lastLine || !lastLine.startsWith('[end of pack] ')) return null;

  const match = lastLine.match(
    /^\[end of pack\] mode=(\S+) objective=(\d+) ac=(\d+) constraints=(\d+) verification=(\d+) scope=(\d+) conflicts=(\d+) gaps=(\d+) omitted=(\d+) bytes=(\d+) digest=(\S+)$/
  );
  if (!match) return null;

  return {
    mode: match[1],
    objective: parseInt(match[2], 10),
    acceptanceCriteria: parseInt(match[3], 10),
    constraints: parseInt(match[4], 10),
    verificationRequirements: parseInt(match[5], 10),
    scopeExcluded: parseInt(match[6], 10),
    conflicts: parseInt(match[7], 10),
    blockingGaps: parseInt(match[8], 10),
    omitted: parseInt(match[9], 10),
    bytes: parseInt(match[10], 10),
    rawBytes: match[10],
    isPadded: match[10].length === 9,
    digest: match[11],
  };
}

/**
 * Verifies that a markdown pack ends with a valid, padded [end of pack] line
 * whose byte count equals the total byte length of the markdown.
 */
function verifyPackEndLine(md: string): { ok: boolean; reason?: string; parsed?: any } {
  if (typeof md !== 'string') {
    return { ok: false, reason: 'invalid-input' };
  }
  const parsed = parsePackEndLine(md);
  if (!parsed) {
    return { ok: false, reason: 'missing-end-of-pack-line' };
  }
  if (!parsed.isPadded) {
    return { ok: false, reason: 'unpadded-bytes-field', parsed };
  }
  const actualLen = Buffer.byteLength(md, 'utf8');
  if (parsed.bytes !== actualLen) {
    return {
      ok: false,
      reason: `byte-count-mismatch: declared ${parsed.bytes}, actual ${actualLen}`,
      parsed,
    };
  }
  return { ok: true, parsed };
}

/**
 * Formats a ContextPack into markdown per IC-005.
 */
function formatMarkdown(pack: any, options: any = {}): string {
  const throwOnOverBudget = options.throwOnOverBudget !== false;
  const toolLimitBytes = pack.budget?.toolResultLimitBytes;
  const isToolLimitDeclared = typeof toolLimitBytes === 'number' && toolLimitBytes > 0;
  const harnessName = pack.budget?.harness?.id || 'harness';

  const getToolLimitMessage = (bytes: number) => {
    return `TOOL LIMIT: this pack is ${bytes} B and ${harnessName} delivers tool output up to ${toolLimitBytes} B, so it may arrive cut. If the last line is not "[end of pack] ...", it was cut.`;
  };

  const mode = pack.mode || 'full';
  if (pack.expansion) {
    const body = `### Expanded: ${pack.expansion.path}\n${pack.expansion.content}${pack.expansion.targetChanged ? '\n> Target changed since this pointer was recorded.\n' : ''}${pack.delivery?.recorded === false ? `\n> Expansion not recorded: ${pack.delivery.reason || 'unknown'}\n` : ''}\n`;
    const digest = pack.packEnd?.digest || formatShortDigest(pack.delivery?.packDigest);
    let total = pack.size?.totalBytes || 0;
    for (let i = 0; i < 6; i++) {
      const header = `## ContextPack: [${pack.taskClass.toUpperCase()}] ${pack.taskId}\n`;
      const footer = `_Budget ${pack.budget.maxBytes} B (${pack.budget.source}) · emitted ${total} B · tokens ~${Math.round(total / 4)} (estimated:bytes/4) · actual unmeasured_\n`;
      const end = `[end of pack] mode=expand objective=0 ac=0 constraints=0 verification=0 scope=0 conflicts=0 gaps=0 omitted=0 bytes=${String(total).padStart(9, '0')} digest=${digest}\n`;
      const output = header + body + footer + end;
      const actual = Buffer.byteLength(output, 'utf8');
      if (actual === total) {
        pack.size.totalBytes = actual;
        pack.packEnd.bytes = actual;
        if (throwOnOverBudget && actual > pack.budget.maxBytes) throw new Error(`Emitted markdown pack size (${actual} B) exceeds budget (${pack.budget.maxBytes} B)`);
        return output;
      }
      total = actual;
    }
  }
  let md = '';
  if (pack.objective) {
    md += `**Objective:** ${pack.objective}\n\n`;
  }

  if (mode !== 'bare') {
    // Mandatory sections
  md += `### Acceptance Criteria\n`;
  if (pack.acceptanceCriteria && pack.acceptanceCriteria.length > 0) {
    for (const ac of pack.acceptanceCriteria) {
      const text = typeof ac === 'object' ? ac.text : ac;
      const reqs = typeof ac === 'object' && Array.isArray(ac.requirements) && ac.requirements.length > 0
        ? ` (${ac.requirements.join(', ')})`
        : '';
      md += `- [ ] ${text}${reqs}\n`;
    }
  } else {
    const reason = pack.mandatory?.acceptanceCriteria?.reason || 'none';
    md += `- not supplied: ${reason}\n`;
  }
  md += '\n';

  md += `### Constraints\n`;
  if (pack.constraints && pack.constraints.length > 0) {
    for (const c of pack.constraints) {
      const id = typeof c === 'object' && c.id ? c.id : '';
      const text = typeof c === 'object' ? c.text : c;
      const kind = typeof c === 'object' && c.kind ? ` (${c.kind})` : '';
      md += `- ! ${id ? id + ' ' : ''}${text}${kind}\n`;
    }
  } else {
    const reason = pack.mandatory?.constraints?.reason || 'none';
    md += `- not supplied: ${reason}\n`;
  }
  md += '\n';

  md += `### Verification Requirements\n`;
  if (pack.verificationRequirements && pack.verificationRequirements.length > 0) {
    for (const vr of pack.verificationRequirements) {
      const text = typeof vr === 'object' ? vr.text : vr;
      md += `- ${text}\n`;
    }
  } else {
    const reason = pack.mandatory?.verificationRequirements?.reason || 'none';
    md += `- not supplied: ${reason}\n`;
  }
  md += '\n';

  md += `### Out of Scope\n`;
  if (pack.scopeExcluded && pack.scopeExcluded.length > 0) {
    for (const se of pack.scopeExcluded) {
      const text = typeof se === 'object' ? se.text : se;
      md += `- ${text}\n`;
    }
  } else {
    const reason = pack.mandatory?.scopeExcluded?.reason || 'none';
    md += `- not supplied: ${reason}\n`;
  }
  md += '\n';

  if (pack.claims?.conflicts && pack.claims.conflicts.length > 0) {
    md += `### Blocking Conflicts\n`;
    for (const c of pack.claims.conflicts) {
      const sup = Array.isArray(c.supportingEvidence) ? c.supportingEvidence.join(', ') : '';
      const con = Array.isArray(c.contradictingEvidence) ? c.contradictingEvidence.join(', ') : '';
      md += `- CONFLICT ${c.statement} (supports: ${sup}; contradicts: ${con})\n`;
    }
    md += '\n';
  }

  const blockingUnanswered = (pack.researchRequests || []).filter((r: any) => r.blocking && r.status !== 'ANSWERED');
  const otherRequests = (pack.researchRequests || []).filter((r: any) => !(r.blocking && r.status !== 'ANSWERED'));

  md += `### Blocking Gaps\n`;
  const hasBlockingGaps = (pack.blockingGaps && pack.blockingGaps.length > 0) || blockingUnanswered.length > 0;
  if (hasBlockingGaps) {
    if (pack.blockingGaps && pack.blockingGaps.length > 0) {
      for (const bg of pack.blockingGaps) {
        const text = typeof bg === 'object' ? bg.text : bg;
        md += `- ${text}\n`;
      }
    }
    for (const r of blockingUnanswered) {
      let line = `- ${r.status} (blocking) ${r.stageId}: ${r.question}`;
      if (r.gap) line += ` — ${r.gap}`;
      if (r.claimId) line += ` (claim: ${r.claimId})`;
      md += `${line}\n`;
    }
  } else {
    const reason = pack.mandatory?.blockingGaps?.reason || 'none';
    md += `- not supplied: ${reason}\n`;
  }
  md += '\n';

  if (pack.mandatory) {
    md += `### Mandatory Sources\n`;
    const mandKeys = ['objective', 'acceptanceCriteria', 'constraints', 'verificationRequirements', 'scopeExcluded', 'blockingGaps'];
    for (const k of mandKeys) {
      const prov = pack.mandatory[k];
      if (prov) {
        if (prov.supplied) {
          const digest12 = prov.digest ? prov.digest.slice(7, 19) : '';
          const loc = prov.locator ? `${prov.locator}@${digest12}` : `@${digest12}`;
          md += `- ${k}: ${prov.source} ${loc}\n`;
        } else {
          md += `- ${k}: not supplied: ${prov.reason || 'unknown'}\n`;
        }
      }
    }
    md += '\n';
  }

  // Optional sections
  if (pack.decisions?.live && pack.decisions.live.length > 0) {
    md += `### Live decisions\n`;
    for (const d of pack.decisions.live) {
      md += `- ${d.id} (${d.topic}): ${d.statement}\n`;
    }
    md += '\n';
  }

  if (pack.claims?.supported && pack.claims.supported.length > 0) {
    md += `### Supported Facts & Invariants\n`;
    for (const c of pack.claims.supported) {
      const evList = Array.isArray(c.evidenceIds) ? c.evidenceIds : (Array.isArray(c.supportingEvidence) ? c.supportingEvidence : []);
      const ev = evList.length > 0 ? ` *(ev: ${evList.join(', ')})*` : '';
      md += `- ✓ ${c.statement}${ev}\n`;
    }
    md += '\n';
  }

  if (otherRequests.length > 0) {
    md += `### Feature Research Requests\n`;
    for (const r of otherRequests) {
      let line = `- ${r.status} ${r.blocking ? '(blocking)' : '(nonblocking)'} ${r.stageId}: ${r.question}`;
      if (r.gap) line += ` — ${r.gap}`;
      if (r.claimId) line += ` (claim: ${r.claimId})`;
      md += `${line}\n`;
    }
    md += '\n';
  }

  if (pack.claims?.hypotheses && pack.claims.hypotheses.length > 0) {
    md += `### Active Hypotheses (Unverified)\n`;
    for (const h of pack.claims.hypotheses) {
      const statement = typeof h === 'object' ? h.statement : h;
      md += `- ? ${statement}\n`;
    }
    md += '\n';
  }

  if (pack.pointers && pack.pointers.length > 0) {
    md += `### Pointers\n`;
    for (const p of pack.pointers) {
      const range = p.range ? `:${p.range.startLine}-${p.range.endLine}` : '';
      md += `- ${p.id} ${p.path}${range} ${p.bytes} B\n`;
    }
    md += '\n';
  }

  if (pack.relevantFiles && pack.relevantFiles.length > 0) {
    md += `### Relevant File Locators\n`;
    for (const f of pack.relevantFiles) {
      md += `- \`${f}\`\n`;
    }
    md += '\n';
  }

  if (pack.evidenceSummary && pack.evidenceSummary.length > 0) {
    md += `### Evidence\n`;
    for (const ev of pack.evidenceSummary) {
      md += `- [${ev.kind}] ${ev.summary || ''} (${ev.locator?.file || ''})\n`;
    }
    md += '\n';
  }

  if (pack.structuralContext && pack.structuralContext.length > 0) {
    md += `### Structural Context\n`;
    for (const s of pack.structuralContext) {
      md += `- ${s}\n`;
    }
    md += '\n';
  }

  if (pack.empty) {
    md += `_No evidence or claims are recorded for task '${pack.taskId}'; this pack states nothing._\n\n`;
  }

  if (mode === 'delta' && pack.delta?.removed?.length) {
    md += `### Removed since ${formatShortDigest(pack.delta.since)}\n`;
    for (const id of pack.delta.removed) md += `- ${id}\n`;
    md += '\n';
  }

  if (pack.omissions?.groups && pack.omissions.groups.length > 0) {
    md += `### Omitted\n`;
    for (const g of pack.omissions.groups) {
      const fresh = g.freshness ? ` ${g.freshness}` : '';
      md += `- ${g.reason}${fresh} (${g.count}): ${g.ids.join(', ')}\n`;
    }
    md += '\n';
  }
  }

  const body = md;
  const endObj = pack.packEnd || {};
  const shortDigest = endObj.digest || formatShortDigest(pack.delivery?.packDigest);

  const objectiveCount = endObj.objective ?? (pack.objective ? 1 : 0);
  const acCount = endObj.acceptanceCriteria ?? (pack.acceptanceCriteria?.length || 0);
  const constraintsCount = endObj.constraints ?? (pack.constraints?.length || 0);
  const verificationCount = endObj.verificationRequirements ?? (pack.verificationRequirements?.length || 0);
  const scopeCount = endObj.scopeExcluded ?? (pack.scopeExcluded?.length || 0);
  const conflictsCount = endObj.conflicts ?? (pack.claims?.conflicts?.length || 0);
  const gapsCount = endObj.blockingGaps ?? (pack.blockingGaps?.length || 0);
  const omittedCount = endObj.omitted ?? (pack.omissions?.total || 0);

  let totalBytes = pack.size?.totalBytes || 1000;
  for (let iter = 0; iter < 5; iter++) {
    let header = `## ContextPack: [${pack.taskClass.toUpperCase()}] ${pack.taskId}\n`;
    if (pack.overflowAction?.message) {
      header += `> ${pack.overflowAction.message}\n`;
    }
    if (isToolLimitDeclared && totalBytes > toolLimitBytes) {
      const msg = getToolLimitMessage(totalBytes);
      header += `> ${msg}\n`;
      pack.toolLimitNotice = { message: msg };
    } else {
      pack.toolLimitNotice = null;
    }

    const tokensEst = Math.round(totalBytes / 4);
    const footer = mode === 'bare'
      ? ''
      : `_Budget ${pack.budget.maxBytes} B (${pack.budget.source}) · emitted ${totalBytes} B · tokens ~${tokensEst} (estimated:bytes/4) · actual unmeasured_\n`;
    const paddedBytes = String(totalBytes).padStart(9, '0');
    const endLine = `[end of pack] mode=${mode} objective=${objectiveCount} ac=${acCount} constraints=${constraintsCount} verification=${verificationCount} scope=${scopeCount} conflicts=${conflictsCount} gaps=${gapsCount} omitted=${omittedCount} bytes=${paddedBytes} digest=${shortDigest}\n`;

    const full = header + body + footer + endLine;
    const actualLen = Buffer.byteLength(full, 'utf8');
    if (actualLen === totalBytes) {
      if (pack.size) {
        pack.size.totalBytes = actualLen;
        if (pack.overflow) {
          pack.size.mandatoryBytes = Math.min(actualLen, pack.size.mandatoryBytes || actualLen);
          pack.size.optionalBytes = 0;
        } else {
          pack.size.optionalBytes = Math.min(pack.size.optionalBytes || 0, actualLen);
          pack.size.mandatoryBytes = actualLen - pack.size.optionalBytes;
        }
      }
      if (pack.packEnd) pack.packEnd.bytes = actualLen;
      if (throwOnOverBudget && pack.status === 'OK' && pack.budget?.maxBytes && actualLen > pack.budget.maxBytes) {
        throw new Error(`Emitted markdown pack size (${actualLen} B) exceeds budget (${pack.budget.maxBytes} B)`);
      }
      return full;
    }
    totalBytes = actualLen;
  }

  let header = `## ContextPack: [${pack.taskClass.toUpperCase()}] ${pack.taskId}\n`;
  if (pack.overflowAction?.message) {
    header += `> ${pack.overflowAction.message}\n`;
  }
  if (isToolLimitDeclared && totalBytes > toolLimitBytes) {
    header += `> ${getToolLimitMessage(totalBytes)}\n`;
    pack.toolLimitNotice = { message: getToolLimitMessage(totalBytes) };
  } else {
    pack.toolLimitNotice = null;
  }
  const tokensEst = Math.round(totalBytes / 4);
  const footer = `_Budget ${pack.budget.maxBytes} B (${pack.budget.source}) · emitted ${totalBytes} B · tokens ~${tokensEst} (estimated:bytes/4) · actual unmeasured_\n`;
  const paddedBytes = String(totalBytes).padStart(9, '0');
  const endLine = `[end of pack] mode=${mode} objective=${objectiveCount} ac=${acCount} constraints=${constraintsCount} verification=${verificationCount} scope=${scopeCount} conflicts=${conflictsCount} gaps=${gapsCount} omitted=${omittedCount} bytes=${paddedBytes} digest=${shortDigest}\n`;
  const full = header + body + footer + endLine;
  const actualLen = Buffer.byteLength(full, 'utf8');
  if (pack.size) {
    pack.size.totalBytes = actualLen;
    if (pack.overflow) {
      pack.size.mandatoryBytes = Math.min(actualLen, pack.size.mandatoryBytes || actualLen);
      pack.size.optionalBytes = 0;
    } else {
      pack.size.optionalBytes = Math.min(pack.size.optionalBytes || 0, actualLen);
      pack.size.mandatoryBytes = actualLen - pack.size.optionalBytes;
    }
  }
  if (pack.packEnd) pack.packEnd.bytes = actualLen;
  if (throwOnOverBudget && pack.status === 'OK' && pack.budget?.maxBytes && actualLen > pack.budget.maxBytes) {
    throw new Error(`Emitted markdown pack size (${actualLen} B) exceeds budget (${pack.budget.maxBytes} B)`);
  }
  return full;
}

/**
 * Formats a ContextPack into JSON per IC-004.
 */
function formatJson(pack: any, options: any = {}): string {
  const throwOnOverBudget = options.throwOnOverBudget !== false;
  const toolLimitBytes = pack.budget?.toolResultLimitBytes;
  const isToolLimitDeclared = typeof toolLimitBytes === 'number' && toolLimitBytes > 0;
  const harnessName = pack.budget?.harness?.id || 'harness';

  const getToolLimitMessage = (bytes: number) => {
    return `TOOL LIMIT: this pack is ${bytes} B and ${harnessName} delivers tool output up to ${toolLimitBytes} B, so it may arrive cut. If the last line is not "[end of pack] ...", it was cut.`;
  };

  const ordered: any = {};
  const keys = [
    'version', 'status', 'exitCode', 'taskId', 'taskClass', 'compiledAt', 'mode',
    'budget', 'overflow', 'overflowAction', 'toolLimitNotice', 'objective',
    'acceptanceCriteria', 'constraints', 'verificationRequirements', 'scopeExcluded',
    'blockingGaps', 'claims', 'researchRequests', 'mandatory', 'decisions',
    'pointers', 'relevantFiles', 'evidenceCount', 'evidenceSummary', 'structuralContext',
    'budgetEnforcement', 'empty', 'omissions', 'size', 'accounting', 'delivery',
    'delta', 'expansion', 'expansionRecorded', 'packEnd',
  ];

  for (const k of keys) {
    if (pack[k] !== undefined) {
      ordered[k] = pack[k];
    } else {
      ordered[k] = null;
    }
  }

  const endObj = pack.packEnd || {};
  const mode = endObj.mode || pack.mode || 'full';
  const shortDigest = endObj.digest || formatShortDigest(pack.delivery?.packDigest);

  const objectiveCount = endObj.objective ?? (pack.objective ? 1 : 0);
  const acCount = endObj.acceptanceCriteria ?? (pack.acceptanceCriteria?.length || 0);
  const constraintsCount = endObj.constraints ?? (pack.constraints?.length || 0);
  const verificationCount = endObj.verificationRequirements ?? (pack.verificationRequirements?.length || 0);
  const scopeCount = endObj.scopeExcluded ?? (pack.scopeExcluded?.length || 0);
  const conflictsCount = endObj.conflicts ?? (pack.claims?.conflicts?.length || 0);
  const gapsCount = endObj.blockingGaps ?? (pack.blockingGaps?.length || 0);
  const omittedCount = endObj.omitted ?? (pack.omissions?.total || 0);

  ordered.packEnd = {
    mode,
    objective: objectiveCount,
    acceptanceCriteria: acCount,
    constraints: constraintsCount,
    verificationRequirements: verificationCount,
    scopeExcluded: scopeCount,
    conflicts: conflictsCount,
    blockingGaps: gapsCount,
    omitted: omittedCount,
    bytes: pack.size?.totalBytes || 1000,
    digest: shortDigest,
  };

  let totalBytes = pack.size?.totalBytes || 1000;
  for (let iter = 0; iter < 5; iter++) {
    ordered.size.totalBytes = totalBytes;
    ordered.packEnd.bytes = totalBytes;
    if (isToolLimitDeclared) {
      if (totalBytes > toolLimitBytes) {
        const msg = getToolLimitMessage(totalBytes);
        ordered.toolLimitNotice = { message: msg };
        pack.toolLimitNotice = ordered.toolLimitNotice;
      } else {
        ordered.toolLimitNotice = null;
        pack.toolLimitNotice = null;
      }
    }
    const jsonStr = JSON.stringify(ordered, null, 2) + '\n';
    const actualLen = Buffer.byteLength(jsonStr, 'utf8');
    if (actualLen === totalBytes) {
      if (pack.size) {
        pack.size.totalBytes = actualLen;
        if (pack.overflow) {
          pack.size.mandatoryBytes = Math.min(actualLen, pack.size.mandatoryBytes || actualLen);
          pack.size.optionalBytes = 0;
        } else {
          pack.size.optionalBytes = Math.min(pack.size.optionalBytes || 0, actualLen);
          pack.size.mandatoryBytes = actualLen - pack.size.optionalBytes;
        }
        ordered.size.totalBytes = pack.size.totalBytes;
        ordered.size.mandatoryBytes = pack.size.mandatoryBytes;
        ordered.size.optionalBytes = pack.size.optionalBytes;
      }
      if (pack.packEnd) pack.packEnd.bytes = actualLen;
      ordered.packEnd.bytes = actualLen;
      if (throwOnOverBudget && pack.status === 'OK' && pack.budget?.maxBytes && actualLen > pack.budget.maxBytes) {
        throw new Error(`Emitted JSON pack size (${actualLen} B) exceeds budget (${pack.budget.maxBytes} B)`);
      }
      return jsonStr;
    }
    totalBytes = actualLen;
  }

  ordered.size.totalBytes = totalBytes;
  ordered.packEnd.bytes = totalBytes;
  const jsonStr = JSON.stringify(ordered, null, 2) + '\n';
  const actualLen = Buffer.byteLength(jsonStr, 'utf8');
  if (pack.size) {
    pack.size.totalBytes = actualLen;
    if (pack.overflow) {
      pack.size.mandatoryBytes = Math.min(actualLen, pack.size.mandatoryBytes || actualLen);
      pack.size.optionalBytes = 0;
    } else {
      pack.size.optionalBytes = Math.min(pack.size.optionalBytes || 0, actualLen);
      pack.size.mandatoryBytes = actualLen - pack.size.optionalBytes;
    }
    ordered.size.totalBytes = pack.size.totalBytes;
    ordered.size.mandatoryBytes = pack.size.mandatoryBytes;
    ordered.size.optionalBytes = pack.size.optionalBytes;
  }
  if (pack.packEnd) pack.packEnd.bytes = actualLen;
  ordered.packEnd.bytes = actualLen;
  if (throwOnOverBudget && pack.status === 'OK' && pack.budget?.maxBytes && actualLen > pack.budget.maxBytes) {
    throw new Error(`Emitted JSON pack size (${actualLen} B) exceeds budget (${pack.budget.maxBytes} B)`);
  }
  return jsonStr;
}

module.exports = {
  FIELD_CLASSES,
  ITEM_CAP_LIMITS,
  canonicalJson,
  itemDigest,
  computePackDigest,
  formatShortDigest,
  parsePackEndLine,
  verifyPackEndLine,
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
  computeItemJsonBytes,
  computeOmissionBytes,
  computeEnvelopes,
  OPTIONAL_HEADING_BYTES_MD,
  OPTIONAL_HEADING_BYTES_JSON,
  linearFit,
  groupOmissions,
  formatOverflowMessage,
  formatMarkdown,
  formatJson,
};
