'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { acquireLock, updateTaskState, readTaskState } = require('./task-state');
const { EvidenceLedger, assertSafeTaskId } = require('./evidence-ledger');
const { ClaimsManager } = require('./claims');
const { taskStoreDir } = require('./task-scope');
const { FreshnessValidator } = require('./freshness');
const { resolveLocator } = require('./locator-resolve');
const { finishRuntime, usageError } = require('./cli-result');

const STATES = new Set(['OPEN', 'ANSWERED', 'UNRESOLVED']);
const REASONS = new Set(['detected-gap', 'user-request']);
const safeId = (value, label) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} must be a safe non-empty identifier`);
  }
  return value;
};

function hasLocatedSource(item, projectRoot) {
  const locator = item.locator || {};
  if (locator.uri !== undefined) {
    if (typeof locator.uri !== 'string') return false;
    try {
      const url = new URL(locator.uri);
      if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return false;
    } catch { return false; }
  }
  return Boolean((locator.uri && typeof locator.uri === 'string')
    || (locator.file && resolveLocator({ locator, repoRoot: projectRoot }).resolved));
}

class ResearchRequestStore {
  constructor({ projectRoot = process.cwd(), fsImpl = fs, slug = null } = {}) {
    this.projectRoot = projectRoot;
    this.fsImpl = fsImpl;
    this.slug = slug;
    this.stateDir = path.join(projectRoot, '.doflow', 'state', 'research');
  }

  /** The feature's namespace directory when the task has one (task-scope.js), else the flat store. */
  file(taskId) {
    const dir = taskStoreDir({ projectRoot: this.projectRoot, store: 'research', taskId: assertSafeTaskId(taskId), slug: this.slug });
    return path.join(dir, `${taskId}.json`);
  }

  runFile(taskId) {
    return path.join(this.projectRoot, '.doflow', 'state', 'orchestration', `${assertSafeTaskId(taskId)}.json`);
  }

  read(taskId) {
    const data = readTaskState(this.fsImpl, this.file(taskId));
    if (!data) return { taskId, revision: 0, requests: [] };
    if (data.taskId !== taskId || !Array.isArray(data.requests)
      || data.requests.some(r => !STATES.has(r.status))) {
      throw new Error(`Invalid research state for task '${taskId}'`);
    }
    return data;
  }

  // Re-read inside updateTaskState's lock: overlapping writers cannot lose a request.
  change(taskId, update) {
    let result;
    updateTaskState({ fsImpl: this.fsImpl, file: this.file(taskId), build: disk => {
      if (disk && (disk.taskId !== taskId || !Array.isArray(disk.requests))) {
        throw new Error(`Invalid research state for task '${taskId}'`);
      }
      const requests = disk?.requests || [];
      result = update(requests);
      return { taskId, requests };
    } });
    return result;
  }

  stageFor(taskId, stageId) {
    const run = readTaskState(this.fsImpl, this.runFile(taskId));
    if (!run || run.taskClass !== 'feature' || run.state !== 'RUNNING') {
      throw new Error(`Task '${taskId}' has no active feature stage`);
    }
    const current = run.program[run.cursor];
    if (current?.type !== 'stage' || current.id !== stageId) {
      throw new Error(`Current feature stage is '${current?.type === 'stage' ? current.id : 'none'}', not '${stageId}'`);
    }
  }

  open({ taskId, stageId, question, reason, blocking } = {}) {
    safeId(taskId, 'taskId'); safeId(stageId, 'stageId');
    if (typeof question !== 'string' || !question.trim()) throw new Error('question is required');
    if (!REASONS.has(reason)) throw new Error(`reason must be one of: ${[...REASONS].join(', ')}`);
    if (blocking !== undefined && typeof blocking !== 'boolean') throw new Error('blocking must be true or false');
    // Lock order is run -> research for both open and completion. The stage check and request
    // write must be indivisible with the orchestrator's final completion check.
    const runFile = this.runFile(taskId);
    if (!this.fsImpl.existsSync(runFile)) throw new Error(`Task '${taskId}' has no active feature stage`);
    const release = acquireLock(this.fsImpl, runFile);
    try {
      this.stageFor(taskId, stageId);
      return this.change(taskId, requests => {
        const existing = requests.find(r => r.stageId === stageId && r.question === question.trim() && r.status === 'OPEN');
        if (existing) {
          if ((blocking ?? reason === 'detected-gap') && !existing.blocking) {
            existing.blocking = true;
            existing.reason = reason;
            existing.updatedAt = new Date().toISOString();
          }
          return existing;
        }
        const at = new Date().toISOString();
        const record = { id: `req_${crypto.randomBytes(12).toString('hex')}`, taskId, stageId,
          question: question.trim(), reason, blocking: blocking ?? reason === 'detected-gap',
          status: 'OPEN', claimId: null, evidenceIds: [], gap: null, createdAt: at, updatedAt: at };
        requests.push(record);
        return record;
      });
    } finally { release(); }
  }

  list(taskId) {
    safeId(taskId, 'taskId');
    return this.read(taskId).requests;
  }

  // Validate references before taking the write lock; only the status transition itself mutates state.
  resolve({ taskId, requestId, outcome, claimId, evidenceIds = [], gap } = {}) {
    safeId(taskId, 'taskId'); safeId(requestId, 'requestId');
    if (!['answered', 'unresolved'].includes(outcome)) throw new Error('outcome must be answered or unresolved');
    if (!Array.isArray(evidenceIds)) throw new Error('evidenceIds must be an array');
    if (outcome === 'unresolved') {
      if (!gap || !String(gap).trim()) throw new Error('unresolved requires a gap');
      if (claimId) throw new Error('unresolved cannot carry a claim');
    } else {
      if (gap) throw new Error('answered cannot carry a gap');
      if (!claimId || evidenceIds.length === 0) throw new Error('answered requires a claim and evidence IDs');
      const ledger = new EvidenceLedger({ repoRoot: this.projectRoot, slug: this.slug });
      ledger.load(taskId);
      new FreshnessValidator({ repoRoot: this.projectRoot }).validateLedgerFreshness(ledger);
      const claims = new ClaimsManager({ repoRoot: this.projectRoot, evidenceLedger: ledger, slug: this.slug });
      claims.load(taskId); claims.evaluateAll();
      const claim = claims.getClaim(claimId);
      if (!claim || claim.taskId !== taskId || claim.status !== 'supported') {
        throw new Error('answered requires a supported claim in the same task');
      }
      for (const id of evidenceIds) {
        const item = ledger.getEvidence(id);
        if (!item || item.taskId !== taskId || item.provenance !== 'extracted'
          || item.status === 'superseded' || item.freshness?.status !== 'FRESH'
          || !hasLocatedSource(item, this.projectRoot)
          || !claim.supportingEvidence.includes(id)) {
          throw new Error(`Evidence '${id}' is not fresh, located support for this claim and task`);
        }
      }
    }
    return this.change(taskId, requests => {
      const request = requests.find(r => r.id === requestId);
      if (!request) throw new Error(`Unknown research request '${requestId}' for task '${taskId}'`);
      if (request.status !== 'OPEN') throw new Error(`Request '${requestId}' is ${request.status}, not OPEN`);
      Object.assign(request, { status: outcome === 'answered' ? 'ANSWERED' : 'UNRESOLVED',
        claimId: claimId || null, evidenceIds: [...evidenceIds], gap: gap || null,
        updatedAt: new Date().toISOString() });
      return request;
    });
  }

  blockingGap(taskId, stageId) {
    const requests = this.list(taskId).filter(r => r.stageId === stageId && r.blocking);
    for (const request of requests) {
      if (request.status !== 'ANSWERED') return request;
      try {
        this.validateAnswer(taskId, request);
      } catch (error) {
        return { ...request, failureReason: error.message };
      }
    }
    return null;
  }

  validateAnswer(taskId, request) {
    const ledger = new EvidenceLedger({ repoRoot: this.projectRoot, slug: this.slug });
    ledger.load(taskId);
    new FreshnessValidator({ repoRoot: this.projectRoot }).validateLedgerFreshness(ledger);
    const claims = new ClaimsManager({ repoRoot: this.projectRoot, evidenceLedger: ledger, slug: this.slug });
    claims.load(taskId); claims.evaluateAll();
    const claim = claims.getClaim(request.claimId);
    if (!claim || claim.taskId !== taskId) {
      throw new Error(`Research claim '${request.claimId}' is missing from this task`);
    }
    if (claim.status !== 'supported') {
      throw new Error(`Research claim '${request.claimId}' is ${claim.status}, not supported`);
    }
    if (!request.evidenceIds?.length) throw new Error('Research answer has no linked evidence');
    for (const id of request.evidenceIds) {
      const item = ledger.getEvidence(id);
      if (!item || item.taskId !== taskId || item.provenance !== 'extracted'
        || item.status === 'superseded' || item.freshness?.status !== 'FRESH'
        || !hasLocatedSource(item, this.projectRoot)
        || !claim.supportingEvidence.includes(id)) {
        throw new Error(`Research evidence '${id}' is no longer fresh, located support`);
      }
    }
  }
}

function handleResearchRequestCommand({ action = 'list', taskId, stageId, question, reason,
  blocking, requestId, outcome, claimId, evidenceIds, gap, json = false, projectRoot, slug } = {}) {
  try {
    const store = new ResearchRequestStore({ projectRoot, slug });
    let result;
    switch (action) {
      case 'open': result = store.open({ taskId, stageId, question, reason, blocking }); break;
      case 'list': result = { taskId, requests: store.list(taskId) }; break;
      case 'resolve': result = store.resolve({ taskId, requestId, outcome, claimId, evidenceIds, gap }); break;
      default: return usageError('research-request', `unknown action '${action}'; valid: open, list, resolve`, json);
    }
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(JSON.stringify(result));
    return finishRuntime(0);
  } catch (error) {
    return usageError('research-request', error.message, json, error);
  }
}

module.exports = { ResearchRequestStore, handleResearchRequestCommand };
