'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { loadStorageRegistry } = require('./registry.ts');

const RUN_STATES = new Set(['RUNNING', 'AWAITING_GATE', 'COMPLETED', 'REJECTED']);
const RUN_OPEN_STATES = Object.freeze(['RUNNING', 'AWAITING_GATE']);
const UNCHECKED = /^\s*- \[ \] /m;
const UNCHECKED_TASK = /^\s*- \[ \] (\S+)/gm;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The record extension a store declares in its `match` pattern: `.jsonl` for a JSON-lines store, else `.json`. */
function recordExtension(match: any): string {
  return typeof match === 'string' && /\\\.jsonl\$$/.test(match) ? '.jsonl' : '.json';
}

function workRecordStores(fsImpl: any): any[] {
  try {
    const registry = loadStorageRegistry({ repoRoot: REPO_ROOT, fsImpl });
    return registry.stores.filter((store: any) => store.root === 'project-state' && store.entry === 'record' && store.rule === 'work');
  } catch {
    return [];
  }
}

function recordStorePaths(fsImpl: any): Map<string, string> {
  return new Map(workRecordStores(fsImpl).map((store: any): [string, string] => [store.id, store.path]));
}

function recordStoreExtensions(fsImpl: any): Map<string, string> {
  return new Map(workRecordStores(fsImpl).map((store: any): [string, string] => [store.id, recordExtension(store.match)]));
}

function createWorkCache({ projectRoot, fsImpl = fs }: { projectRoot: string; fsImpl?: any }): any {
  return {
    projectRoot: path.resolve(projectRoot),
    fsImpl,
    recordStorePaths: recordStorePaths(fsImpl),
    recordExtensions: recordStoreExtensions(fsImpl),
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
function refreshedWorkCache(cache: any): any {
  return { ...cache, runNames: null, runListError: false, featureNames: null, featureListError: false,
    runs: new Map(), plans: new Map() };
}

function cacheFor({ projectRoot, fsImpl, cache }: { projectRoot: string; fsImpl: any; cache?: any }): any {
  const resolved = path.resolve(projectRoot);
  if (cache && cache.projectRoot === resolved && cache.fsImpl === fsImpl
      && cache.recordStorePaths instanceof Map && cache.runs instanceof Map && cache.plans instanceof Map) return cache;
  return createWorkCache({ projectRoot: resolved, fsImpl });
}

function stateRoot(projectRoot: string): string {
  return path.join(projectRoot, '.doflow', 'state');
}

function safeSegment(value: any): boolean {
  return typeof value === 'string' && SAFE_SEGMENT.test(value) && !value.includes('..');
}

function listRunNames(cache: any, shouldStop?: () => boolean): { names: string[]; incomplete: boolean } {
  if (shouldStop?.()) return { names: [], incomplete: true };
  if (cache.runNames !== null) return { names: cache.runNames, incomplete: false };
  const dir = path.join(stateRoot(cache.projectRoot), 'orchestration');
  let entries: any[];
  try { entries = cache.fsImpl.readdirSync(dir, { withFileTypes: true }); }
  catch (error: any) {
    if (error?.code === 'ENOENT') entries = [];
    else { cache.runNames = []; cache.runListError = true; return { names: cache.runNames, incomplete: false }; }
  }
  if (shouldStop?.()) return { names: [], incomplete: true };
  const names: string[] = [];
  for (const entry of entries) {
    if (shouldStop?.()) return { names: [], incomplete: true };
    if (entry.name.endsWith('.json')) names.push(entry.name.slice(0, -5));
  }
  if (shouldStop?.()) return { names: [], incomplete: true };
  cache.runNames = names;
  return { names, incomplete: false };
}

function readRun(cache: any, runId: string): any {
  if (cache.runs.has(runId)) return cache.runs.get(runId);
  const file = path.join(stateRoot(cache.projectRoot), 'orchestration', `${runId}.json`);
  let result: any;
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

function resolveRun(cache: any, taskId: string, namespace: any, shouldStop?: () => boolean): any {
  const listed = listRunNames(cache, shouldStop);
  if (listed.incomplete) return { id: null, unreadable: false, incomplete: true };
  if (cache.runListError) return { id: null, unreadable: true };
  let exact = false, namespaced = false, prefix: string | null = null;
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

function parseJsonLines(text: string): any {
  const lines = text.split('\n').filter((line: string) => line.trim() !== '');
  if (lines.length === 0) throw new Error('empty JSON-lines record');
  const values = lines.map((line: string) => JSON.parse(line));
  return values[values.length - 1];
}

function readRecord({ projectRoot, storePath, recordId, namespace, mtimeMs, fsImpl, extension = '.json' }: any): any {
  const storeSegments = typeof storePath === 'string' && storePath !== '' ? storePath.split('/') : [];
  if (typeof storePath !== 'string' || storeSegments.some((segment: string) => !safeSegment(segment))
      || !safeSegment(recordId)
      || (namespace !== null && namespace !== undefined && !safeSegment(namespace))) {
    return { ok: false };
  }
  const file = path.join(stateRoot(projectRoot), ...storeSegments, ...(namespace ? [namespace] : []), `${recordId}${extension}`);
  try {
    const text = fsImpl.readFileSync(file, 'utf8');
    // A `.jsonl` record is one JSON value per line, appended over time: every line must parse (fail
    // closed otherwise) and the last one is the record's current value.
    const value = extension === '.jsonl' ? parseJsonLines(text) : JSON.parse(text);
    const mtime = mtimeMs === undefined ? fsImpl.statSync(file).mtimeMs : mtimeMs;
    if (!Number.isFinite(mtime)) return { ok: false };
    return { ok: true, value, mtimeMs: mtime };
  } catch {
    return { ok: false };
  }
}

function listFeatureNames(cache: any, shouldStop?: () => boolean): { names: string[]; incomplete: boolean } {
  if (shouldStop?.()) return { names: [], incomplete: true };
  if (cache.featureNames !== null) return { names: cache.featureNames, incomplete: false };
  const dir = path.join(cache.projectRoot, 'agent-docs', 'doflow');
  let entries: any[];
  try { entries = cache.fsImpl.readdirSync(dir, { withFileTypes: true }); }
  catch (error: any) {
    if (error?.code === 'ENOENT') entries = [];
    else { cache.featureNames = []; cache.featureListError = true; return { names: cache.featureNames, incomplete: false }; }
  }
  if (shouldStop?.()) return { names: [], incomplete: true };
  const names: string[] = [];
  for (const entry of entries) {
    if (shouldStop?.()) return { names: [], incomplete: true };
    if (entry.isDirectory() && safeSegment(entry.name)) names.push(entry.name);
  }
  if (shouldStop?.()) return { names: [], incomplete: true };
  cache.featureNames = names;
  return { names, incomplete: false };
}

function featureFromFolders(cache: any, taskId: string, shouldStop?: () => boolean): { feature: string | null; incomplete: boolean } {
  const listed = listFeatureNames(cache, shouldStop);
  if (listed.incomplete) return { feature: null, incomplete: true };
  let best: string | null = null;
  for (const name of listed.names) {
    if (shouldStop?.()) return { feature: null, incomplete: true };
    if ((taskId === name || taskId.startsWith(`${name}-`) || taskId.startsWith(`${name}.`))
      && (!best || name.length > best.length || (name.length === best.length && name < best))) best = name;
  }
  return { feature: best, incomplete: false };
}

function stringField(record: any, field: string): string | null {
  const value = record && typeof record === 'object' ? record[field] : null;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** true, false when the folder is definitely absent, or null when it cannot be told. */
function folderExists(fsImpl: any, folder: string): boolean | null {
  try { fsImpl.lstatSync(folder); return true; }
  catch (error: any) { return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? false : null; }
}

function readPlan(cache: any, feature: string, shouldStop?: () => boolean): any {
  if (shouldStop?.()) return { exists: false, ok: false, text: null, incomplete: true };
  if (cache.plans.has(feature)) return cache.plans.get(feature);
  if (!safeSegment(feature)) {
    const invalid = { exists: true, ok: false, text: null };
    cache.plans.set(feature, invalid);
    return invalid;
  }
  const folder = path.join(cache.projectRoot, 'agent-docs', 'doflow', feature);
  let result: any;
  try {
    result = { exists: true, ok: true, text: cache.fsImpl.readFileSync(path.join(folder, 'plan.md'), 'utf8'), folder: true };
  } catch (error: any) {
    result = error?.code === 'ENOENT'
      ? { exists: false, ok: true, text: null, folder: folderExists(cache.fsImpl, folder) }
      : { exists: true, ok: false, text: null };
  }
  if (result.folder === null) result = { exists: true, ok: false, text: null };
  if (shouldStop?.()) return { exists: result.exists, ok: result.ok, text: null, incomplete: true };
  cache.plans.set(feature, result);
  return result;
}

function planWithUncheckedTask(cache: any, taskId: string, shouldStop?: () => boolean): any {
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
    let match: RegExpExecArray | null;
    while ((match = UNCHECKED_TASK.exec(plan.text)) !== null) {
      if (shouldStop?.()) return { found: false, unreadable: false, incomplete: true };
      if (match[1] === taskId) return { found: true, unreadable: false };
    }
    if (shouldStop?.()) return { found: false, unreadable: false, incomplete: true };
  }
  return { found: false, unreadable: false };
}

/** IC-028: why a task-attempts ledger is open work, or null when it holds neither an active or
 * uncleared cancelled attempt nor a run whose control is other than `running`. A cancel a resume has
 * cleared (the same `clearedCancels` the resume report uses) is settled work, not open work. */
function openLedgerReason(ledger: any): string | null {
  const tasks = ledger && typeof ledger.tasks === 'object' && ledger.tasks ? Object.entries<any>(ledger.tasks) : [];
  let cleared: Set<any> | null = null;
  for (const [, entry] of tasks) {
    const attempts: any[] = entry && Array.isArray(entry.attempts) ? entry.attempts : [];
    for (const a of attempts) {
      if (!a) continue;
      if (a.state === 'active') return 'attempt-open';
      if (a.state !== 'cancelled') continue;
      // Loaded only when a cancelled attempt exists: task-run is a heavy module for a storage pass.
      // Paired by the attempt object, not by (task, token): a malformed ledger can repeat or omit
      // tokens, and an uncleared cancel must never be taken for a cleared one.
      if (cleared === null) cleared = new Set(require('../task-run.ts').clearedCancels(ledger).map((c: any) => c.attempt));
      if (!cleared.has(a)) return 'attempt-open';
    }
  }
  const runs = ledger && typeof ledger.runs === 'object' && ledger.runs ? Object.values<any>(ledger.runs) : [];
  if (runs.some((run: any) => !run || run.control !== 'running')) return 'run-control-open';
  return null;
}

/** IC-037: the dispatch run states that settle a dispatch store; any other run state is open. */
const DISPATCH_RUN_SETTLED = Object.freeze(['completed', 'cancelled']);

function answer(state: string, reason: string, run: any, feature: any, since: number | null = null): any {
  return { state, since, reason, run, feature };
}

function incompleteAnswer(run: any = null, feature: any = null): any {
  return { ...answer('undecidable', 'pass-budget-exhausted', run, feature), incomplete: true };
}

/**
 * A loop run record (`roadmap/runs/<runId>.json`) is open while its `closedAt` is null (the loop
 * resumes any such run), while it is the newest record in `runs/`, while a merge intent in
 * `roadmap/intents/` names its `runId`, or while `roadmap/lease.json` names it. Any other record is
 * finished as of its mtime. An unreadable source is never called finished.
 */
function roadmapRunStatus(project: string, fileSystem: any, runId: any, mtimeMs: any): any {
  if (!safeSegment(runId)) return answer('undecidable', 'record-unreadable', null, null);
  const dir = path.join(stateRoot(project), 'roadmap');
  const unreadable = () => answer('undecidable', 'record-unreadable', runId, null);
  let record: any;
  try { record = JSON.parse(fileSystem.readFileSync(path.join(dir, 'runs', `${runId}.json`), 'utf8')); }
  catch { return unreadable(); }
  if (!record || typeof record !== 'object' || !Object.hasOwn(record, 'closedAt')) return unreadable();
  if (record.closedAt === null) return answer('open', 'roadmap-run-open', runId, null);
  const list = (folder: string): string[] | null => {
    try { return fileSystem.readdirSync(folder); } catch (error: any) { return error.code === 'ENOENT' ? [] : null; }
  };
  const runs = list(path.join(dir, 'runs'));
  if (runs === null) return unreadable();
  let newest: { name: string; mtimeMs: number } | null = null;
  for (const name of runs) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name)) continue;
    let stat: any;
    try { stat = fileSystem.statSync(path.join(dir, 'runs', name)); } catch { return unreadable(); }
    if (!newest || stat.mtimeMs > newest.mtimeMs || (stat.mtimeMs === newest.mtimeMs && name > newest.name)) newest = { name, mtimeMs: stat.mtimeMs };
  }
  const open = answer('open', 'roadmap-run-open', runId, null);
  if (newest?.name === `${runId}.json`) return open;
  const intents = list(path.join(dir, 'intents'));
  if (intents === null) return unreadable();
  for (const name of intents) {
    if (!name.endsWith('.json')) continue;
    try { if (JSON.parse(fileSystem.readFileSync(path.join(dir, 'intents', name), 'utf8'))?.runId === runId) return open; }
    catch { return unreadable(); }
  }
  try { if (JSON.parse(fileSystem.readFileSync(path.join(dir, 'lease.json'), 'utf8'))?.runId === runId) return open; }
  catch (error: any) { if (error.code !== 'ENOENT') return unreadable(); }
  return answer('finished', 'roadmap-run-finished', runId, null, Number.isFinite(mtimeMs) ? mtimeMs : null);
}

/**
 * The one definition of whether a per-task record is still open work (IC-004).
 * Reads fail closed: an unreadable run, record, or relevant plan is never called finished. An
 * optional pass deadline makes discovery cancellable; incomplete results must not be treated as
 * finished by storage selection.
 */
function workStatus({
  projectRoot, store, taskId, namespace = null, mtimeMs, cache, fsImpl, shouldStop,
}: any): any {
  const recordId = taskId;
  const workId = typeof taskId === 'string' ? taskId.replace(/_claims$/, '') : taskId;

  // Roadmap archive location is authoritative: open intents never age out, while archived
  // intents use their own mtime and do not depend on the feature plan remaining on disk.
  if (store === 'roadmap' && namespace === 'intents')
    return answer('open', 'roadmap-intent-open', workId, null);
  if (store === 'roadmap' && namespace === 'done')
    return answer('finished', 'roadmap-intent-done', workId, null, Number.isFinite(mtimeMs) ? mtimeMs : null);
  // The tripwire's remembered event ids are tiny and bounded by those ids: kept.
  if (store === 'roadmap' && namespace === 'tripwire')
    return answer('open', 'roadmap-tripwire-kept', workId, null);

  const project = path.resolve(projectRoot);
  const fileSystem = fsImpl || cache?.fsImpl || fs;
  if (store === 'roadmap' && namespace === 'runs') return roadmapRunStatus(project, fileSystem, workId, mtimeMs);
  const pass = cacheFor({ projectRoot: project, fsImpl: fileSystem, cache });

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
  let record: any;
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
    record = readRecord({ projectRoot: project, storePath, recordId, namespace, mtimeMs, fsImpl: fileSystem,
      extension: pass.recordExtensions?.get(store) || '.json' });
  }
  if (shouldStop?.()) return incompleteAnswer(resolvedRun.id);
  if (!record.ok) return answer('undecidable', 'record-unreadable', resolvedRun.id, null);

  // W4: old timestamps never close a live or gate-paused run.
  if (run && RUN_OPEN_STATES.includes(run.state)) {
    return answer('open', 'run-open', resolvedRun.id, null);
  }

  // IC-028: a task-attempts ledger stays open while any attempt is active or cancelled and not cleared
  // by a resume, or any run is not `running`, so a paused or cancelled run whose boxes are all ticked
  // is never pruned.
  if (store === 'task-attempts') {
    const ledgerOpen = openLedgerReason(record.value);
    if (ledgerOpen) return answer('open', ledgerOpen, resolvedRun.id, null);
  }

  // IC-037 (mirrors IC-028): a dispatch store stays open while its run is not `completed` or
  // `cancelled`, so a paused, blocked or resume-required run on a fully ticked plan keeps the
  // record that names its kept worktrees.
  if (store === 'dispatch') {
    const dispatchRun = record.value && typeof record.value === 'object' ? record.value.run : null;
    if (dispatchRun !== null && dispatchRun !== undefined && !DISPATCH_RUN_SETTLED.includes(dispatchRun?.state)) {
      return answer('open', 'dispatch-run-open', resolvedRun.id, null);
    }
  }

  // W5: feature metadata is ordered; folder-name inference is the final fallback.
  let feature: string | null = stringField(run, 'featureSlug')
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

module.exports = { workStatus, recordExtension, createWorkCache, refreshedWorkCache, RUN_OPEN_STATES };
