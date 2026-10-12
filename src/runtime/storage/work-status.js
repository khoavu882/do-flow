'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { loadStorageRegistry } = require('./registry.ts');

const RUN_STATES = new Set(['RUNNING', 'AWAITING_GATE', 'COMPLETED', 'REJECTED']);
const RUN_OPEN_STATES = Object.freeze(['RUNNING', 'AWAITING_GATE']);
const UNCHECKED = /^\s*- \[ \] /m;
const UNCHECKED_TASK = /^\s*- \[ \] (\S+)/gm;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function recordStorePaths(fsImpl) {
  try {
    const registry = loadStorageRegistry({ repoRoot: REPO_ROOT, fsImpl });
    return new Map(registry.stores
      .filter((store) => store.root === 'project-state' && store.entry === 'record' && store.rule === 'work')
      .map((store) => [store.id, store.path]));
  } catch {
    return new Map();
  }
}

function createWorkCache({ projectRoot, fsImpl = fs }) {
  return {
    projectRoot: path.resolve(projectRoot),
    fsImpl,
    recordStorePaths: recordStorePaths(fsImpl),
    runNames: null,
    runListError: false,
    featureNames: null,
    featureListError: false,
    runs: new Map(),
    plans: new Map(),
  };
}

/**
 * A cache for one locked recheck: it keeps the pass's resolved store paths but drops every run,
 * plan and listing, so the recheck reads the work's current run and plan rather than the snapshot
 * taken at selection. A run reopened or a plan task unchecked after selection keeps the record.
 */
function refreshedWorkCache(cache) {
  return { ...cache, runNames: null, runListError: false, featureNames: null, featureListError: false,
    runs: new Map(), plans: new Map() };
}

function cacheFor({ projectRoot, fsImpl, cache }) {
  const resolved = path.resolve(projectRoot);
  if (cache && cache.projectRoot === resolved && cache.fsImpl === fsImpl
      && cache.recordStorePaths instanceof Map && cache.runs instanceof Map && cache.plans instanceof Map) return cache;
  return createWorkCache({ projectRoot: resolved, fsImpl });
}

function stateRoot(projectRoot) {
  return path.join(projectRoot, '.doflow', 'state');
}

function safeSegment(value) {
  return typeof value === 'string' && SAFE_SEGMENT.test(value) && !value.includes('..');
}

function listRunNames(cache, shouldStop) {
  if (shouldStop?.()) return { names: [], incomplete: true };
  if (cache.runNames !== null) return { names: cache.runNames, incomplete: false };
  const dir = path.join(stateRoot(cache.projectRoot), 'orchestration');
  let entries;
  try { entries = cache.fsImpl.readdirSync(dir, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') entries = [];
    else { cache.runNames = []; cache.runListError = true; return { names: cache.runNames, incomplete: false }; }
  }
  if (shouldStop?.()) return { names: [], incomplete: true };
  const names = [];
  for (const entry of entries) {
    if (shouldStop?.()) return { names: [], incomplete: true };
    if (entry.name.endsWith('.json')) names.push(entry.name.slice(0, -5));
  }
  if (shouldStop?.()) return { names: [], incomplete: true };
  cache.runNames = names;
  return { names, incomplete: false };
}

function readRun(cache, runId) {
  if (cache.runs.has(runId)) return cache.runs.get(runId);
  const file = path.join(stateRoot(cache.projectRoot), 'orchestration', `${runId}.json`);
  let result;
  try {
    const value = JSON.parse(cache.fsImpl.readFileSync(file, 'utf8'));
    result = value && typeof value === 'object' && !Array.isArray(value) && RUN_STATES.has(value.state)
      ? { ok: true, value }
      : { ok: false };
  } catch {
    result = { ok: false };
  }
  cache.runs.set(runId, result);
  return result;
}

function resolveRun(cache, taskId, namespace, shouldStop) {
  const listed = listRunNames(cache, shouldStop);
  if (listed.incomplete) return { id: null, unreadable: false, incomplete: true };
  if (cache.runListError) return { id: null, unreadable: true };
  let exact = false, namespaced = false, prefix = null;
  for (const candidate of listed.names) {
    if (shouldStop?.()) return { id: null, unreadable: false, incomplete: true };
    if (candidate === taskId) exact = true;
    else if (safeSegment(namespace) && candidate === namespace) namespaced = true;
    else if ((taskId.startsWith(`${candidate}-`) || taskId.startsWith(`${candidate}.`))
      && (!prefix || candidate.length > prefix.length || (candidate.length === prefix.length && candidate < prefix))) prefix = candidate;
  }
  const id = exact ? taskId : namespaced ? namespace : prefix;
  if (!id) return { id: null, value: null, unreadable: false };
  if (shouldStop?.()) return { id: null, unreadable: false, incomplete: true };
  const read = readRun(cache, id);
  if (shouldStop?.()) return { id: null, unreadable: false, incomplete: true };
  return read.ok ? { id, value: read.value, unreadable: false } : { id, value: null, unreadable: true };
}

function readRecord({ projectRoot, storePath, recordId, namespace, mtimeMs, fsImpl }) {
  const storeSegments = typeof storePath === 'string' && storePath !== '' ? storePath.split('/') : [];
  if (typeof storePath !== 'string' || storeSegments.some((segment) => !safeSegment(segment))
      || !safeSegment(recordId)
      || (namespace !== null && namespace !== undefined && !safeSegment(namespace))) {
    return { ok: false };
  }
  const file = path.join(stateRoot(projectRoot), ...storeSegments, ...(namespace ? [namespace] : []), `${recordId}.json`);
  try {
    const value = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    const mtime = mtimeMs === undefined ? fsImpl.statSync(file).mtimeMs : mtimeMs;
    if (!Number.isFinite(mtime)) return { ok: false };
    return { ok: true, value, mtimeMs: mtime };
  } catch {
    return { ok: false };
  }
}

function listFeatureNames(cache, shouldStop) {
  if (shouldStop?.()) return { names: [], incomplete: true };
  if (cache.featureNames !== null) return { names: cache.featureNames, incomplete: false };
  const dir = path.join(cache.projectRoot, 'agent-docs', 'doflow');
  let entries;
  try { entries = cache.fsImpl.readdirSync(dir, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') entries = [];
    else { cache.featureNames = []; cache.featureListError = true; return { names: cache.featureNames, incomplete: false }; }
  }
  if (shouldStop?.()) return { names: [], incomplete: true };
  const names = [];
  for (const entry of entries) {
    if (shouldStop?.()) return { names: [], incomplete: true };
    if (entry.isDirectory() && safeSegment(entry.name)) names.push(entry.name);
  }
  if (shouldStop?.()) return { names: [], incomplete: true };
  cache.featureNames = names;
  return { names, incomplete: false };
}

function featureFromFolders(cache, taskId, shouldStop) {
  const listed = listFeatureNames(cache, shouldStop);
  if (listed.incomplete) return { feature: null, incomplete: true };
  let best = null;
  for (const name of listed.names) {
    if (shouldStop?.()) return { feature: null, incomplete: true };
    if ((taskId === name || taskId.startsWith(`${name}-`) || taskId.startsWith(`${name}.`))
      && (!best || name.length > best.length || (name.length === best.length && name < best))) best = name;
  }
  return { feature: best, incomplete: false };
}

function stringField(record, field) {
  const value = record && typeof record === 'object' ? record[field] : null;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** true, false when the folder is definitely absent, or null when it cannot be told. */
function folderExists(fsImpl, folder) {
  try { fsImpl.lstatSync(folder); return true; }
  catch (error) { return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? false : null; }
}

function readPlan(cache, feature, shouldStop) {
  if (shouldStop?.()) return { exists: false, ok: false, text: null, incomplete: true };
  if (cache.plans.has(feature)) return cache.plans.get(feature);
  if (!safeSegment(feature)) {
    const invalid = { exists: true, ok: false, text: null };
    cache.plans.set(feature, invalid);
    return invalid;
  }
  const folder = path.join(cache.projectRoot, 'agent-docs', 'doflow', feature);
  let result;
  try {
    result = { exists: true, ok: true, text: cache.fsImpl.readFileSync(path.join(folder, 'plan.md'), 'utf8'), folder: true };
  } catch (error) {
    result = error?.code === 'ENOENT'
      ? { exists: false, ok: true, text: null, folder: folderExists(cache.fsImpl, folder) }
      : { exists: true, ok: false, text: null };
  }
  if (result.folder === null) result = { exists: true, ok: false, text: null };
  if (shouldStop?.()) return { exists: result.exists, ok: result.ok, text: null, incomplete: true };
  cache.plans.set(feature, result);
  return result;
}

function planWithUncheckedTask(cache, taskId, shouldStop) {
  const listed = listFeatureNames(cache, shouldStop);
  if (listed.incomplete) return { found: false, unreadable: false, incomplete: true };
  if (cache.featureListError) return { found: false, unreadable: true };
  for (const feature of listed.names) {
    if (shouldStop?.()) return { found: false, unreadable: false, incomplete: true };
    const plan = readPlan(cache, feature, shouldStop);
    if (plan.incomplete) return { found: false, unreadable: false, incomplete: true };
    if (!plan.ok) return { found: false, unreadable: true };
    if (!plan.exists) continue;
    UNCHECKED_TASK.lastIndex = 0;
    let match;
    while ((match = UNCHECKED_TASK.exec(plan.text)) !== null) {
      if (shouldStop?.()) return { found: false, unreadable: false, incomplete: true };
      if (match[1] === taskId) return { found: true, unreadable: false };
    }
    if (shouldStop?.()) return { found: false, unreadable: false, incomplete: true };
  }
  return { found: false, unreadable: false };
}

function answer(state, reason, run, feature, since = null) {
  return { state, since, reason, run, feature };
}

function incompleteAnswer(run = null, feature = null) {
  return { ...answer('undecidable', 'pass-budget-exhausted', run, feature), incomplete: true };
}

/**
 * The one definition of whether a per-task record is still open work (IC-004).
 * Reads fail closed: an unreadable run, record, or relevant plan is never called finished. An
 * optional pass deadline makes discovery cancellable; incomplete results must not be treated as
 * finished by storage selection.
 */
function workStatus({
  projectRoot, store, taskId, namespace = null, mtimeMs, cache, fsImpl, shouldStop,
}) {
  const project = path.resolve(projectRoot);
  const fileSystem = fsImpl || cache?.fsImpl || fs;
  const pass = cacheFor({ projectRoot: project, fsImpl: fileSystem, cache });
  const recordId = taskId;
  const workId = typeof taskId === 'string' ? taskId.replace(/_claims$/, '') : taskId;

  if (shouldStop?.()) return incompleteAnswer();
  if (!safeSegment(workId)) return answer('undecidable', 'record-unreadable', null, null);

  // W1-W2: an exact run wins over the namespace and delimited prefixes, even when unreadable.
  const resolvedRun = resolveRun(pass, workId, namespace, shouldStop);
  if (resolvedRun.incomplete || shouldStop?.()) return incompleteAnswer();
  if (resolvedRun.unreadable) return answer('undecidable', 'run-unreadable', resolvedRun.id, null);
  const run = resolvedRun.value;

  // W3: `store` is the registry id, while the record lives under that declaration's physical
  // path. An orchestration record is also its exact run file, so reuse the cached parse rather than
  // reading that file twice.
  const storePath = pass.recordStorePaths.get(store);
  let record;
  if (storePath === 'orchestration' && !namespace && recordId === workId && resolvedRun.id === workId && run) {
    try {
      const file = path.join(stateRoot(project), storePath, `${recordId}.json`);
      const recordMtime = mtimeMs === undefined ? fileSystem.statSync(file).mtimeMs : mtimeMs;
      record = Number.isFinite(recordMtime)
        ? { ok: true, value: run, mtimeMs: recordMtime }
        : { ok: false };
    } catch {
      record = { ok: false };
    }
  } else {
    record = readRecord({ projectRoot: project, storePath, recordId, namespace, mtimeMs, fsImpl: fileSystem });
  }
  if (shouldStop?.()) return incompleteAnswer(resolvedRun.id);
  if (!record.ok) return answer('undecidable', 'record-unreadable', resolvedRun.id, null);

  // W4: old timestamps never close a live or gate-paused run.
  if (run && RUN_OPEN_STATES.includes(run.state)) {
    return answer('open', 'run-open', resolvedRun.id, null);
  }

  // W5: feature metadata is ordered; folder-name inference is the final fallback.
  let feature = stringField(run, 'featureSlug')
    || stringField(record.value, 'featureSlug')
    || stringField(record.value, 'slug')
    || (safeSegment(namespace) ? namespace : null);
  if (!feature) {
    const inferred = featureFromFolders(pass, workId, shouldStop);
    if (inferred.incomplete || shouldStop?.()) return incompleteAnswer(resolvedRun.id);
    feature = inferred.feature;
  }

  // W6-W7 (AM22): a named feature finishes only through its plan. A feature folder without plan.md
  // is paused before planning, so its work stays open; a named feature whose folder is gone
  // (renamed or removed) cannot be judged, so its records are kept. Unfinished work is never
  // pruned by age.
  if (feature) {
    const plan = readPlan(pass, feature, shouldStop);
    if (plan.incomplete || shouldStop?.()) return incompleteAnswer(resolvedRun.id, feature);
    if (!plan.ok) return answer('undecidable', 'plan-unreadable', resolvedRun.id, feature);
    if (!plan.exists && !plan.folder) return answer('undecidable', 'feature-missing', resolvedRun.id, feature);
    if (!plan.exists) return answer('open', 'plan-missing', resolvedRun.id, feature);
    const unchecked = UNCHECKED.test(plan.text);
    if (shouldStop?.()) return incompleteAnswer(resolvedRun.id, feature);
    if (unchecked) return answer('open', 'plan-unchecked', resolvedRun.id, feature);
  } else {
    // W8: an exact first token is enough to associate legacy work with an unchecked task.
    const unchecked = planWithUncheckedTask(pass, workId, shouldStop);
    if (unchecked.incomplete || shouldStop?.()) return incompleteAnswer(resolvedRun.id);
    if (unchecked.unreadable) return answer('undecidable', 'plan-unreadable', resolvedRun.id, null);
    if (unchecked.found) return answer('open', 'task-unchecked', resolvedRun.id, null);
  }

  if (shouldStop?.()) return incompleteAnswer(resolvedRun.id, feature);
  // W9: invalid or absent legacy run timestamps are omitted; the record mtime remains authoritative.
  const runEnd = run ? Date.parse(run.updatedAt) : NaN;
  const since = Number.isFinite(runEnd) ? Math.max(runEnd, record.mtimeMs) : record.mtimeMs;
  return answer('finished', run ? 'run-finished' : 'no-run', resolvedRun.id, feature, since);
}

module.exports = { workStatus, createWorkCache, refreshedWorkCache, RUN_OPEN_STATES };
