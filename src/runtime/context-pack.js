'use strict';

const { EvidenceLedger } = require('./evidence-ledger');
const { ClaimsManager } = require('./claims');
const { finishRuntime, usageError } = require('./cli-result');

class ContextPackCompiler {
  /**
   * @param {Object} [defaultOptions]
   * @param {number} [defaultOptions.maxFiles=15]
   * @param {number} [defaultOptions.maxClaims=20]
   * @param {number} [defaultOptions.maxEvidenceItems=25]
   */
  constructor(defaultOptions = {}) {
    this.options = {
      maxFiles: defaultOptions.maxFiles || 15,
      maxClaims: defaultOptions.maxClaims || 20,
      maxEvidenceItems: defaultOptions.maxEvidenceItems || 25,
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
  compileContextPack(params, budgetOverrides = {}) {
    const {
      taskId,
      taskClass = 'feature',
      objective = '',
      constraints = [],
      acceptanceCriteria = [],
      evidenceLedger,
      claimsManager,
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
  formatMarkdown(pack) {
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

    if (pack.relevantFiles.length > 0) {
      md += `### Relevant File Locators\n`;
      for (const f of pack.relevantFiles) {
        md += `- \`${f}\`\n`;
      }
      md += '\n';
    }

    return md;
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
 * @returns {number} exit code
 */
function handleContextPackCommand({ taskId, taskClass, objective, json = false, stateRoot } = {}) {
  const root = stateRoot || process.cwd();
  const ledger = new EvidenceLedger({ repoRoot: root });
  ledger.load(taskId);
  const claims = new ClaimsManager({ evidenceLedger: ledger, repoRoot: root });
  claims.load(taskId);
  claims.evaluateAll();

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
  });

  const empty = pack.evidenceCount === 0
    && pack.claims.supported.length === 0
    && pack.claims.hypotheses.length === 0
    && pack.claims.conflicts.length === 0;

  if (json) console.log(JSON.stringify({ ...pack, empty }, null, 2));
  else {
    console.log(compiler.formatMarkdown(pack));
    if (empty) console.log(`_No evidence or claims are recorded for task '${taskId}'; this pack states nothing._\n`);
  }
  return finishRuntime(empty ? 1 : 0);
}

module.exports = {
  ContextPackCompiler,
  handleContextPackCommand,
};
