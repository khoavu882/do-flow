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

/** The record's path under one state root, with the namespace evidence uses for the same task. */
function currentRelPath({ stateRoot, taskId, slug }) {
  const { namespace } = resolveTaskScope({ projectRoot: stateRoot, taskId, slug });
  return namespace ? path.join(STORE, namespace, `${taskId}.json`) : path.join(STORE, `${taskId}.json`);
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
  const file = path.join(stateRoot, currentRelPath({ stateRoot, taskId, slug }));
  const record = {
    version: RECORD_VERSION,
    taskId,
    slug: scope.slug || slug || null,
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
  const prior = priorRecord(file, fsImpl);
  if (prior.kind === 'newer') throw new Error(newerRecordText(file, prior.version));
  let replacedUnreadable = null;
  if (prior.kind === 'unreadable') {
    replacedUnreadable = `${file}.unreadable`;
    fsImpl.renameSync(file, replacedUnreadable);
  }
  updateTaskState({ fsImpl, file, build: () => record });
  return { file, record, replacedUnreadable };
}

/**
 * The task's record in this checkout, else in exactly one other checkout. Another checkout's path
 * is derived without running the feature resolver there: namespaced when the slug's folder in that
 * checkout has a decision register and the task id is not the slug itself, flat otherwise.
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
  const relPath = (root, isCurrent) => {
    if (isCurrent) return currentRelPath({ stateRoot, taskId, slug });
    const namespaced = slug && slug !== taskId
      && fsImpl.existsSync(path.join(root, 'agent-docs', 'doflow', slug, 'decisions', 'register.json'));
    return namespaced ? path.join(STORE, slug, `${taskId}.json`) : path.join(STORE, `${taskId}.json`);
  };
  const found = findStateFile({ stateRoot, relPath, ...(exec ? { exec } : {}), fsImpl });
  const base = { record: null, file: found.file, origin: found.origin, candidates: found.candidates, detail: null };
  if (found.status !== 'found') return { ...base, status: found.status };
  try {
    return { ...base, status: 'found', record: JSON.parse(fsImpl.readFileSync(found.file, 'utf8')) };
  } catch (error) {
    return { ...base, status: 'unreadable', detail: `unparsable JSON: ${error.message}` };
  }
}

module.exports = { writeReadinessRecord, readReadinessRecord, newerVersionOf, RECORD_VERSION };
