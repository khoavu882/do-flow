'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root');
const { loadStorageRegistry } = require('./registry');

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

function listRunNames(cache) {
  if (cache.runNames !== null) return cache.runNames;
  const dir = path.join(stateRoot(cache.projectRoot), 'orchestration');
  try {
    cache.runNames = cache.fsImpl.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -5));
  } catch (error) {
    if (error?.code === 'ENOENT') cache.runNames = [];
    else {
      cache.runNames = [];
      cache.runListError = true;
    }
  }
  return cache.runNames;
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

function resolveRun(cache, taskId, namespace) {
  const names = listRunNames(cache);
  if (cache.runListError) return { id: null, unreadable: true };
  let id = null;
  if (names.includes(taskId)) id = taskId;
  else if (safeSegment(namespace) && names.includes(namespace)) id = namespace;
  else {
    id = names
      .filter((candidate) => taskId.startsWith(`${candidate}-`) || taskId.startsWith(`${candidate}.`))
      .sort((a, b) => b.length - a.length || a.localeCompare(b))[0] || null;
  }
  if (!id) return { id: null, value: null, unreadable: false };
  const read = readRun(cache, id);
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

function listFeatureNames(cache) {
  if (cache.featureNames !== null) return cache.featureNames;
  const dir = path.join(cache.projectRoot, 'agent-docs', 'doflow');
  try {
    cache.featureNames = cache.fsImpl.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && safeSegment(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code === 'ENOENT') cache.featureNames = [];
    else {
      cache.featureNames = [];
      cache.featureListError = true;
    }
  }
  return cache.featureNames;
}

function featureFromFolders(cache, taskId) {
  return listFeatureNames(cache)
    .filter((name) => taskId === name || taskId.startsWith(`${name}-`) || taskId.startsWith(`${name}.`))
    .sort((a, b) => b.length - a.length || a.localeCompare(b))[0] || null;
}

function stringField(record, field) {
  const value = record && typeof record === 'object' ? record[field] : null;
  return typeof value === 'string' && value !== '' ? value : null;
}

function readPlan(cache, feature) {
  if (cache.plans.has(feature)) return cache.plans.get(feature);
  if (!safeSegment(feature)) {
    const invalid = { exists: true, ok: false, text: null };
    cache.plans.set(feature, invalid);
    return invalid;
  }
  const file = path.join(cache.projectRoot, 'agent-docs', 'doflow', feature, 'plan.md');
  let result;
  try {
    result = { exists: true, ok: true, text: cache.fsImpl.readFileSync(file, 'utf8') };
  } catch (error) {
    result = error?.code === 'ENOENT'
      ? { exists: false, ok: true, text: null }
      : { exists: true, ok: false, text: null };
  }
  cache.plans.set(feature, result);
  return result;
}

function planWithUncheckedTask(cache, taskId) {
  const features = listFeatureNames(cache);
  if (cache.featureListError) return { found: false, unreadable: true };
  for (const feature of features) {
    const plan = readPlan(cache, feature);
    if (!plan.ok) return { found: false, unreadable: true };
    if (!plan.exists) continue;
    UNCHECKED_TASK.lastIndex = 0;
    for (const match of plan.text.matchAll(UNCHECKED_TASK)) {
      if (match[1] === taskId) return { found: true, unreadable: false };
    }
  }
  return { found: false, unreadable: false };
}

function answer(state, reason, run, feature, since = null) {
  return { state, since, reason, run, feature };
}

/**
 * The one definition of whether a per-task record is still open work (IC-004).
 * Reads fail closed: an unreadable run, record, or relevant plan is never called finished.
 */
function workStatus({
  projectRoot, store, taskId, namespace = null, mtimeMs, cache, fsImpl,
}) {
  const project = path.resolve(projectRoot);
  const fileSystem = fsImpl || cache?.fsImpl || fs;
  const pass = cacheFor({ projectRoot: project, fsImpl: fileSystem, cache });
  const recordId = taskId;
  const workId = typeof taskId === 'string' ? taskId.replace(/_claims$/, '') : taskId;

  if (!safeSegment(workId)) return answer('undecidable', 'record-unreadable', null, null);

  // W1-W2: an exact run wins over the namespace and delimited prefixes, even when unreadable.
  const resolvedRun = resolveRun(pass, workId, namespace);
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
  if (!record.ok) return answer('undecidable', 'record-unreadable', resolvedRun.id, null);

  // W4: old timestamps never close a live or gate-paused run.
  if (run && RUN_OPEN_STATES.includes(run.state)) {
    return answer('open', 'run-open', resolvedRun.id, null);
  }

  // W5: feature metadata is ordered; folder-name inference is the final fallback.
  const feature = stringField(run, 'featureSlug')
    || stringField(record.value, 'featureSlug')
    || stringField(record.value, 'slug')
    || (safeSegment(namespace) ? namespace : null)
    || featureFromFolders(pass, workId);

  // W6-W7: only an existing plan participates; no plan is valid legacy state.
  if (feature) {
    const plan = readPlan(pass, feature);
    if (!plan.ok) return answer('undecidable', 'plan-unreadable', resolvedRun.id, feature);
    if (plan.exists && UNCHECKED.test(plan.text)) {
      return answer('open', 'plan-unchecked', resolvedRun.id, feature);
    }
  } else {
    // W8: an exact first token is enough to associate legacy work with an unchecked task.
    const unchecked = planWithUncheckedTask(pass, workId);
    if (unchecked.unreadable) return answer('undecidable', 'plan-unreadable', resolvedRun.id, null);
    if (unchecked.found) return answer('open', 'task-unchecked', resolvedRun.id, null);
  }

  // W9: invalid or absent legacy run timestamps are omitted; the record mtime remains authoritative.
  const runEnd = run ? Date.parse(run.updatedAt) : NaN;
  const since = Number.isFinite(runEnd) ? Math.max(runEnd, record.mtimeMs) : record.mtimeMs;
  return answer('finished', run ? 'run-finished' : 'no-run', resolvedRun.id, feature, since);
}

module.exports = { workStatus, createWorkCache, RUN_OPEN_STATES };
