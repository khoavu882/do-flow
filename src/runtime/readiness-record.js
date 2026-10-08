'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { updateTaskState } = require('./task-state');
const { resolveTaskScope } = require('./task-scope');
const { findStateFile } = require('./checkouts');

// The readiness record: the latest evaluation of one task, kept where `readiness` ran.
//
// An evaluation used to vanish once printed, so a later step could only evaluate again with
// whatever inputs it was handed at that moment. Recording it lets the handoff, `verify` and the
// edit hook ask one question — was this task READY before the work started — and read the answer
// from any checkout of the repository.

const RECORD_VERSION = 1;
const STORE = path.join('.doflow', 'state', 'readiness');

/**
 * Where a task's record may be under one checkout, in the order every reader takes them: under the
 * feature's namespace, then flat. The writer, `verify`, `orchestrate` and the edit hook all use this
 * one list, so a record written anywhere is found by each of them from any checkout.
 * @param {string} taskId
 * @param {string|null} slug the task's feature slug, when one is known
 * @returns {Array<string>} paths relative to a checkout root
 */
function recordCandidates(taskId, slug) {
  const flat = path.join(STORE, `${taskId}.json`);
  return slug && slug !== taskId ? [path.join(STORE, slug, `${taskId}.json`), flat] : [flat];
}

/** A record version this runtime cannot read because a newer DoFlow wrote it, else null. */
function newerVersionOf(record) {
  const v = record && typeof record === 'object' ? record.version : undefined;
  return Number.isInteger(v) && v > RECORD_VERSION ? v : null;
}

/** The refusal for a record a newer DoFlow wrote: it names the file and is never overwritten. */
function newerRecordText(file, version) {
  return `the readiness record ${file} was written by a newer DoFlow (record version ${version}; this runtime reads ${RECORD_VERSION}), `
    + 'so it was left as it is. Run this command with the DoFlow that wrote the record, or upgrade DoFlow here.';
}

/**
 * What is already at `file` before a write: nothing, a record to replace, a record a newer DoFlow
 * wrote, or bytes no evaluation can be read from.
 * @returns {{kind: 'none'|'record'|'newer'|'unreadable', version?: number}}
 */
function priorRecord(file, fsImpl) {
  let text;
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'none' };
    throw error;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: 'unreadable' };
  }
  const newer = newerVersionOf(data);
  if (newer !== null) return { kind: 'newer', version: newer };
  // The state-file reader refuses any other version it did not write, so such bytes are set aside too.
  if (data && typeof data === 'object' && data.version !== undefined && data.version !== RECORD_VERSION) return { kind: 'unreadable' };
  return { kind: 'record' };
}

/**
 * Records one evaluation, replacing the previous one for the task. A previous file that cannot be
 * read is moved to `<file>.unreadable` (replacing an earlier one there) so the refusal that sent the
 * caller here can be cleared; one a newer DoFlow wrote is left alone and the write is refused.
 * @param {Object} options
 * @param {string} options.stateRoot
 * @param {string} options.taskId
 * @param {string|null} [options.slug]
 * @param {Object} options.report an `evaluateTaskReadiness` result
 * @param {Object} options.inputs only the caller-stated keys that were given
 * @param {Array<string>|null} [options.declaredScope] the scope's paths when it parses as a path list
 * @param {string} options.mode
 * @param {Date} [options.now]
 * @param {Object} [options.fsImpl]
 * @returns {{file: string, record: Object, replacedUnreadable: string|null}} the `.unreadable` path when
 *   a previous file was set aside
 */
function writeReadinessRecord({ stateRoot, taskId, slug = null, report, inputs, declaredScope = null, mode, now = new Date(), fsImpl = fs }) {
  const scope = resolveTaskScope({ projectRoot: stateRoot, taskId, slug });
  const recordSlug = scope.slug || slug || null;
  // The record a reader would find in this checkout is the one replaced; with none, the record goes
  // where the task's evidence goes (under the feature's namespace when it has a register).
  const file = recordCandidates(taskId, recordSlug).map((rel) => path.join(stateRoot, rel)).find((f) => fsImpl.existsSync(f))
    || path.join(stateRoot, STORE, ...(scope.namespace ? [scope.namespace] : []), `${taskId}.json`);
  const record = {
    version: RECORD_VERSION,
    taskId,
    slug: recordSlug,
    taskClass: report.taskClass,
    templateName: report.templateName,
    state: report.state,
    stageEntry: report.stageEntry ? report.stageEntry.decision : null,
    executionMode: mode,
    inputs: { ...inputs },
    declaredScope: Array.isArray(declaredScope) ? [...declaredScope] : null,
    unmet: (report.requirements || []).filter((r) => r.required && !r.satisfied).map((r) => r.id),
    evidenceCount: Number.isInteger(report.evidenceCount) ? report.evidenceCount : 0,
    evaluatedAt: now.toISOString(),
  };
  // Inspected and set aside under the write's own lock, so a concurrent writer can neither rename
  // a record just written nor slip a newer one in between the check and the write.
  let replacedUnreadable = null;
  const prepare = () => {
    const prior = priorRecord(file, fsImpl);
    if (prior.kind === 'newer') throw new Error(newerRecordText(file, prior.version));
    if (prior.kind === 'unreadable') {
      replacedUnreadable = `${file}.unreadable`;
      fsImpl.renameSync(file, replacedUnreadable);
    }
  };
  updateTaskState({ fsImpl, file, prepare, build: () => record });
  return { file, record, replacedUnreadable };
}

/**
 * The task's record in this checkout, else in exactly one other checkout, at the first of
 * `recordCandidates` that exists in each. No resolver is run: the candidates depend only on the
 * task id and the slug the caller names.
 * @param {Object} options
 * @param {string} options.stateRoot
 * @param {string} options.taskId
 * @param {string|null} [options.slug]
 * @param {Function} [options.exec]
 * @param {Object} [options.fsImpl]
 * @returns {{status: 'found'|'missing'|'ambiguous'|'unreadable', record: Object|null, file: string|null,
 *   origin: 'current'|'other'|null, candidates: Array<string>, detail: string|null}}
 */
function readReadinessRecord({ stateRoot, taskId, slug = null, exec, fsImpl = fs }) {
  const found = findStateFile({ stateRoot, relPath: recordCandidates(taskId, slug), ...(exec ? { exec } : {}), fsImpl });
  const base = { record: null, file: found.file, origin: found.origin, candidates: found.candidates, detail: null };
  if (found.status !== 'found') return { ...base, status: found.status };
  try {
    return { ...base, status: 'found', record: JSON.parse(fsImpl.readFileSync(found.file, 'utf8')) };
  } catch (error) {
    return { ...base, status: 'unreadable', detail: `unparsable JSON: ${error.message}` };
  }
}

module.exports = { writeReadinessRecord, readReadinessRecord, recordCandidates, newerVersionOf, RECORD_VERSION };
