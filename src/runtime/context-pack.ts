'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const { EvidenceLedger } = require('./evidence-ledger.ts');
const { ClaimsManager } = require('./claims.ts');
const { ResearchRequestStore } = require('./research-request.ts');
const { finishRuntime, usageError } = require('./cli-result.ts');
const { resolveActiveFeature } = require('./feature-resolve.ts');
const { readRegister } = require('./decision-register.ts');
const {
  FIELD_CLASSES,
  buildPackItem,
  linearFit,
} = require('./context/compose.ts');

const NO_DECISIONS = Object.freeze({ available: false, live: [], liveCount: 0 });

const { TASK_CLASS_BUDGETS, resolveBudget } = require('./context/budget.ts');

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
    const feature = resolveActiveFeature({ projectRoot, slug });
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
   * Compiles a ContextPack from task evidence and claims.
   * @param {Object} params
   * @param {string} params.taskId
   * @param {string} [params.taskClass='feature']
   * @param {string} [params.objective='']
   * @param {Array<string>} [params.constraints=[]]
   * @param {Array<string>} [params.acceptanceCriteria=[]]
   * @param {Object} params.evidenceLedger
   * @param {Object} params.claimsManager
   * @param {Object} [budgetOverrides={}]
   * @returns {Object} ContextPack
   */
  compileContextPack(params: any, budgetOverrides: any = {}) {
    const {
      taskId,
      taskClass = 'feature',
      objective = '',
      constraints = [],
      acceptanceCriteria = [],
      evidenceLedger,
      claimsManager,
      researchRequests = [],
      decisions = NO_DECISIONS,
    } = params;

    const limits = { ...this.options, ...budgetOverrides };

    const rawClaims = claimsManager ? claimsManager.getClaims(taskId) : [];
    const rawEvidence = evidenceLedger ? evidenceLedger.queryEvidence({ taskId }) : [];

    // Filter claims
    const supportedClaims = [];
    const activeHypotheses = [];
    const conflictedClaims = [];

    for (const claim of rawClaims) {
      if (claim.status === 'supported') {
        if (supportedClaims.length < limits.maxClaims) {
          supportedClaims.push({
            id: claim.id,
            statement: claim.statement,
            evidenceIds: claim.supportingEvidence,
          });
        }
      } else if (claim.status === 'hypothesis') {
        activeHypotheses.push({
          id: claim.id,
          statement: claim.statement,
        });
      } else if (claim.status === 'conflicted') {
        conflictedClaims.push({
          id: claim.id,
          statement: claim.statement,
          supportingEvidence: claim.supportingEvidence,
          contradictingEvidence: claim.contradictingEvidence,
        });
      }
    }

    // Extract relevant files and structural context from fresh evidence
    const relevantFileSet = new Set();
    const structuralNodes = [];
    const freshEvidenceItems = [];

    for (const ev of rawEvidence) {
      if (ev.freshness?.status === 'FRESH') {
        if (ev.locator?.file) {
          relevantFileSet.add(ev.locator.file);
        }
        if (ev.kind === 'structural' && ev.content) {
          structuralNodes.push(ev.content);
        }
        if (freshEvidenceItems.length < limits.maxEvidenceItems) {
          freshEvidenceItems.push({
            id: ev.id,
            kind: ev.kind,
            locator: ev.locator,
            summary: typeof ev.content === 'string' ? ev.content.slice(0, 120) : null,
          });
        }
      }
    }

    const relevantFiles = Array.from(relevantFileSet).slice(0, limits.maxFiles);

    return {
      version: 1,
      taskId: taskId || 'default',
      taskClass,
      compiledAt: new Date().toISOString(),
      objective,
      constraints: [...constraints],
      // Ported from `evidence/context_pack.py` (plan task B.3): the only field the Python pack
      // carried that this one did not. What the task must satisfy belongs beside the evidence
      // gathered to satisfy it, otherwise the verification engine has to re-read the requirement
      // to find out what it is verifying against.
      verificationRequirements: [...acceptanceCriteria],
      claims: {
        supported: supportedClaims,
        hypotheses: activeHypotheses,
        conflicts: conflictedClaims,
      },
      relevantFiles,
      structuralContext: structuralNodes.slice(0, 5),
      evidenceCount: freshEvidenceItems.length,
      evidenceSummary: freshEvidenceItems,
      researchRequests: [...researchRequests]
        .sort((a, b) => Number(b.blocking && b.status !== 'ANSWERED')
          - Number(a.blocking && a.status !== 'ANSWERED'))
        .slice(0, limits.maxResearchRequests).map(r => ({
          id: r.id, stageId: r.stageId, question: r.question, status: r.status,
          blocking: r.blocking, claimId: r.claimId, evidenceIds: r.evidenceIds, gap: r.gap,
        })),
      decisions: {
        available: decisions.available, live: [...decisions.live], liveCount: decisions.liveCount,
        ...(decisions.reason ? { reason: decisions.reason } : {}),
      },
      budgetEnforcement: {
        totalFiles: relevantFiles.length,
        totalSupportedClaims: supportedClaims.length,
        totalActiveHypotheses: activeHypotheses.length,
        limits,
      },
    };
  }

  /**
   * Formats a ContextPack into a concise markdown context block.
   * @param {Object} pack
   * @returns {string}
   */
  formatMarkdown(pack: any) {
    let md = `## ContextPack: [${pack.taskClass.toUpperCase()}] ${pack.taskId}\n`;
    if (pack.objective) {
      md += `**Objective:** ${pack.objective}\n\n`;
    }

    if (pack.claims.supported.length > 0) {
      md += `### Supported Facts & Invariants\n`;
      for (const c of pack.claims.supported) {
        md += `- ✓ ${c.statement} *(ev: ${c.evidenceIds.join(', ')})*\n`;
      }
      md += '\n';
    }

    if (pack.claims.hypotheses.length > 0) {
      md += `### Active Hypotheses (Unverified)\n`;
      for (const h of pack.claims.hypotheses) {
        md += `- ? ${h.statement}\n`;
      }
      md += '\n';
    }

    if (pack.researchRequests.length > 0) {
      md += `### Feature Research Requests\n`;
      for (const r of pack.researchRequests) {
        md += `- ${r.status} ${r.blocking ? '(blocking)' : '(nonblocking)'} ${r.stageId}: ${r.question}`;
        if (r.gap) md += ` — ${r.gap}`;
        if (r.claimId) md += ` (claim: ${r.claimId})`;
        md += '\n';
      }
      md += '\n';
    }

    if (pack.decisions && pack.decisions.liveCount > 0) {
      md += `### Live decisions\n`;
      for (const d of pack.decisions.live) md += `- ${d.id} (${d.topic}): ${d.statement}\n`;
      md += '\n';
    }

    if (pack.relevantFiles.length > 0) {
      md += `### Relevant File Locators\n`;
      for (const f of pack.relevantFiles) {
        md += `- \`${f}\`\n`;
      }
      md += '\n';
    }

    return md;
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
function handleContextPackCommand({ taskId, taskClass, objective, json = false, stateRoot, slug }: any = {}) {
  const root = stateRoot || process.cwd();
  const ledger = new EvidenceLedger({ repoRoot: root, slug });
  ledger.load(taskId);
  const claims = new ClaimsManager({ evidenceLedger: ledger, repoRoot: root, slug });
  claims.load(taskId);
  claims.evaluateAll();
  const researchRequests = new ResearchRequestStore({ projectRoot: root, slug }).list(taskId);

  const compiler = new ContextPackCompiler();
  const pack = compiler.compileContextPack({
    taskId,
    // The library's own default. Passed through rather than substituted here so there is one
    // place that decides what an unstated class means for a *label* — which is all it is in a
    // pack, unlike readiness where it selects the contract.
    ...(taskClass ? { taskClass } : {}),
    objective: objective || '',
    evidenceLedger: ledger,
    claimsManager: claims,
    researchRequests,
    decisions: loadLiveDecisions({ projectRoot: root, slug: slug || null }),
  });

  const empty = pack.evidenceCount === 0
    && pack.claims.supported.length === 0
    && pack.claims.hypotheses.length === 0
    && pack.claims.conflicts.length === 0
    && pack.researchRequests.length === 0
    && pack.decisions.liveCount === 0;

  if (json) console.log(JSON.stringify({ ...pack, empty }, null, 2));
  else {
    console.log(compiler.formatMarkdown(pack));
    if (empty) console.log(`_No evidence or claims are recorded for task '${taskId}'; this pack states nothing._\n`);
  }
  return finishRuntime(empty ? 1 : 0);
}

module.exports = {
  ContextPackCompiler,
  TASK_CLASS_BUDGETS,
  handleContextPackCommand,
  loadLiveDecisions,
};
