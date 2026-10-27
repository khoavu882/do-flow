'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const { workStatus, recordExtension, createWorkCache, refreshedWorkCache } = require('./work-status.ts');
const { projectKey } = require('../lifecycle/report-store.ts');
const { readEvents } = require('../lifecycle/event-store.ts');

const DAY = 86400000;
const HOUR = 3600000;
const BODY = /^FU-[0-9a-hjkmnp-tv-z]{6}\.txt$/;
const LOG = /[0-9]{13}-[A-Za-z0-9._-]+\.log/g;
const TMP = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json\.[0-9]+\.tmp$/;
const ruleOrder = ['verification-logs', 'task-evidence', 'task-readiness', 'task-research', 'task-outcome', 'task-retrieval', 'task-attempts', 'task-orchestration', 'runs-project', 'runs-user', 'advice-picks-project', 'advice-picks-user', 'lifecycle-events', 'report-bodies', 'session-dirs', 'project-dirs', 'recovery-user', 'recovery-project'];
const removableRules = new Set(['count-and-age','work','date-partition','recovery','lifecycle-settled','report-orphan','age']);
const SAFE_NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Open-log protection cannot vouch for a record store that holds a link, so the pass fails closed.
const LINKED = 'link-in-record-store';
function stopped(context: any) { return Boolean(context.shouldStop?.()); }
function budgetError() { return Object.assign(new Error('storage pass budget exhausted'), { code: 'EBUDGET', partial: true }); }
function projectRoot(roots: any) { return roots['project-state'] ? path.dirname(path.dirname(roots['project-state'])) : null; }
function safeStat(fsImpl: any, file: any) { try { return fsImpl.lstatSync(file); } catch { return null; } }
function names(fsImpl: any, dir: any) { return fsImpl.readdirSync(dir); }
function ageReason(store: any, entry: any, now: any, fsImpl: any, storeDir: any, shouldStop: any) {
  const limit = store.bound.maxAgeDays * DAY;
  if (store.rule === 'date-partition') {
    const date = entry.name.slice(0, 10);
    const time = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,10) !== date) return null;
    const cutoff = new Date(now - limit).toISOString().slice(0,10);
    return date < cutoff ? 'age' : null;
  }
  let newest = entry.stat.mtimeMs;
  if (store.rule === 'age') {
    try {
      for (const child of names(fsImpl, path.join(storeDir, entry.name))) {
        if (shouldStop?.()) return null;
        const st = safeStat(fsImpl, path.join(storeDir, entry.name, child));
        if (!st || st.isSymbolicLink()) return null;
        newest = Math.max(newest, st.mtimeMs);
      }
    } catch { return null; }
  }
  return now - newest > limit ? 'age' : null;
}
function workCandidates(store: any, entries: any, context: any) {
  const { fsImpl, storeDir, now, roots, settings, shouldStop } = context;
  const project = projectRoot(roots);
  if (!project) return [];
  const cache = context.cache || createWorkCache({ projectRoot: project, fsImpl });
  const recordMatch = new RegExp(store.match), extensionLength = recordExtension(store.match).length, selected: any[] = [];
  const visit = (dir: any, namespace: any = null) => {
    let children;
    try { children = names(fsImpl, dir); } catch { return true; }
    for (const name of children) {
      if (shouldStop?.()) return false;
      const file = path.join(dir, name), stat = safeStat(fsImpl, file);
      if (!stat || !stat.isFile()) continue;
      if (TMP.test(name) && now - stat.mtimeMs > settings.staleTmpHours * HOUR) {
        selected.push({ name: namespace ? `${namespace}/${name}` : name, reason: 'stale-tmp', bytes: stat.size, mtimeMs: stat.mtimeMs, recordStat: stat });
      } else if (recordMatch.test(name)) {
        const result = workStatus({ projectRoot: project, store: store.id, taskId: name.slice(0, -extensionLength), namespace, mtimeMs: stat.mtimeMs, cache, fsImpl, shouldStop });
        if (result.incomplete || shouldStop?.()) return false;
        if (result.state === 'finished' && now - result.since > store.bound.finishedDays * DAY)
          selected.push({ name: namespace ? `${namespace}/${name}` : name, reason: 'finished-work', bytes: stat.size, mtimeMs: result.since, recordStat: stat });
      }
    }
    return true;
  };
  if (!visit(storeDir)) return null;
  for (const entry of entries) {
    if (shouldStop?.()) return null;
    if (entry.stat.isDirectory() && !visit(path.join(storeDir, entry.name), entry.name)) return null;
  }
  return selected;
}
/** Revalidate the subject under its try-lock against its current run and plan, not the selection snapshot. */
function recordStillCandidate(store: any, candidate: any, info: any, context: any) {
  const { fsImpl, roots, now, settings, cache, shouldStop, storeDir } = context;
  const before = candidate.recordStat;
  if (!info.isFile() || !before || ['mtimeMs', 'ctimeMs', 'size', 'ino', 'dev'].some(key => info[key] !== before[key])) return false;
  if (candidate.reason === 'stale-tmp') return now - info.mtimeMs > settings.staleTmpHours * HOUR;
  const parts = candidate.name.split('/'), name = parts.at(-1), namespace = parts.length === 2 ? parts[0] : null;
  // workStatus reuses an orchestration record's parsed run. Re-read that subject here and reject
  // changes rather than mutating the snapshot used by the run's other records.
  if (store.id === 'task-orchestration' && !namespace && !name.endsWith('_claims.json')) {
    let current;
    try { current = JSON.parse(fsImpl.readFileSync(path.join(storeDir, name), 'utf8')); } catch { return false; }
    const snapshot = cache?.runs.get(name.slice(0, -5));
    if (!snapshot?.ok || JSON.stringify(current) !== JSON.stringify(snapshot.value)) return false;
  }
  const fresh = cache ? refreshedWorkCache(cache) : undefined;
  const status = workStatus({ projectRoot: projectRoot(roots), store: store.id, taskId: name.slice(0, -recordExtension(store.match).length), namespace, mtimeMs: info.mtimeMs, cache: fresh, fsImpl, shouldStop });
  return !status.incomplete && !shouldStop?.() && status.state === 'finished'
    && status.since === candidate.mtimeMs && now - status.since > store.bound.finishedDays * DAY;
}
function workStorePathStatus(store: any, roots: any, fsImpl: any) {
  const project = projectRoot(roots), root = roots[store.root];
  if (!project || !root) return 'missing';
  const paths = [path.join(project, '.doflow'), root];
  let current = root;
  for (const segment of store.path.split('/')) { current = path.join(current, segment); paths.push(current); }
  for (const candidate of paths) {
    let info;
    try { info = fsImpl.lstatSync(candidate); }
    catch (error: any) { return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' : 'inaccessible'; }
    if (info.isSymbolicLink()) return 'linked';
  }
  return 'safe';
}
function protectedLogs({ registry, roots, fsImpl, cache, shouldStop }: any) {
  const project = projectRoot(roots), protectedNames = new Set();
  if (!project) return { names: protectedNames, incomplete: false };
  const workCache = cache || createWorkCache({ projectRoot: project, fsImpl });
  for (const store of registry.stores.filter((s: any) => s.root === 'project-state' && s.entry === 'record' && s.rule === 'work')) {
    if (shouldStop?.()) return { names: protectedNames, incomplete: true };
    const pathStatus = workStorePathStatus(store, roots, fsImpl);
    if (pathStatus === 'missing') continue;
    if (pathStatus !== 'safe') return { names: protectedNames, incomplete: true, ...(pathStatus === 'linked' ? { reason: LINKED } : {}) };
    const dir = path.join(roots[store.root], ...store.path.split('/'));
    const recordMatch = new RegExp(store.match);
    let linked = false;
    const visit = (folder: any, namespace: any = null) => {
      let list;
      try { list = names(fsImpl, folder); }
      catch (error: any) { return error.code === 'ENOENT' || error.code === 'ENOTDIR'; }
      for (const name of list) {
        if (shouldStop?.()) return false;
        const file = path.join(folder, name);
        let stat;
        try { stat = fsImpl.lstatSync(file); }
        catch (error: any) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; return false; }
        if (stat.isSymbolicLink()) { linked = true; return false; }
        if (namespace === null && stat.isDirectory() && SAFE_NAMESPACE.test(name) && !name.includes('..')) {
          if (!visit(file, name)) return false;
          continue;
        }
        if (!stat.isFile() || !recordMatch.test(name)) continue;
        const status = workStatus({ projectRoot: project, store: store.id, taskId: name.slice(0, -recordExtension(store.match).length), namespace, mtimeMs: stat.mtimeMs, cache: workCache, fsImpl, shouldStop });
        if (status.incomplete || shouldStop?.()) return false;
        if (status.state === 'finished') continue;
        try {
          const text = fsImpl.readFileSync(file, 'utf8');
          if (shouldStop?.()) return false;
          const logPattern = new RegExp(LOG.source, 'g');
          let match;
          while ((match = logPattern.exec(text)) !== null) {
            if (shouldStop?.()) return false;
            protectedNames.add(match[0]);
          }
        } catch { return false; }
      }
      return true;
    };
    if (!visit(dir)) return { names: protectedNames, incomplete: true, ...(linked ? { reason: LINKED } : {}) };
  }
  return { names: protectedNames, incomplete: false };
}
const WORKER_UNIT = /^L\.([A-Za-z0-9][A-Za-z0-9_-]{0,55})\.([A-Za-z0-9][A-Za-z0-9_-]{0,55})\.([1-9][0-9]{0,3})\.json$/;
/** Every `<slug>.json` store file of `.doflow/state/<dir>` read by `read`; [] when the folder is
 * absent, null when a link sits on the path or any file cannot be read (the caller fails closed). */
function stateStores(project: string, dir: string, read: (file: string, fsImpl: any) => any, fsImpl: any, shouldStop: any): any[] | null {
  let current = project;
  for (const segment of ['.doflow', 'state', dir]) {
    current = path.join(current, segment);
    let info;
    try { info = fsImpl.lstatSync(current); }
    catch (error: any) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []; return null; }
    if (info.isSymbolicLink() || !info.isDirectory()) return null;
  }
  const stores: any[] = [];
  let list;
  try { list = names(fsImpl, current); } catch { return null; }
  for (const name of list) {
    if (shouldStop?.()) return null;
    if (!name.endsWith('.json')) continue;
    const info = safeStat(fsImpl, path.join(current, name));
    if (!info || info.isSymbolicLink() || !info.isFile()) return null;
    try { stores.push(read(path.join(current, name), fsImpl)); } catch { return null; }
  }
  return stores;
}
/**
 * Protect kind `unfinished-run` (row 120 IC-005): of the candidate names `L.<run>.<lineage>.<attempt>.json`,
 * the ones to keep. A name is released only when this project's worker run store holds at least one
 * run whose `identity` is that unit and every such run is terminal, and no dispatch naming one of
 * those runs (`workerRunId`) is still open. Terminal is the one end phase each store has: a worker
 * run's `phase: 'ended'` (run-store.ts PHASES, which `transition` never leaves) and a dispatch's
 * `phase: 'ended'` (dispatch/store.ts NEXT_PHASES, add-only once reached). Everything else is kept
 * (fail closed): an unparsable name, no project, an unknown unit (another project's file, or a run
 * record pruned first), a link on a store path or any store file that cannot be read.
 */
function unfinishedRuns({ roots, fsImpl, names: candidates, shouldStop }: any): { names: Set<string>; incomplete: boolean } {
  const all = new Set<string>(candidates);
  const project = projectRoot(roots);
  if (!project) return { names: all, incomplete: false };
  const { readRuns } = require('../worker/run-store.ts');
  const { readDispatch } = require('../dispatch/store.ts');
  const runStores = stateStores(project, 'worker-runs', (file, impl) => ({ runs: readRuns(file, impl) }), fsImpl, shouldStop);
  if (shouldStop?.()) return { names: all, incomplete: true };
  const dispatchStores = runStores && stateStores(project, 'dispatch', readDispatch, fsImpl, shouldStop);
  if (shouldStop?.()) return { names: all, incomplete: true };
  if (!runStores || !dispatchStores) return { names: all, incomplete: false };
  const units = new Map<string, { ended: boolean; runIds: string[] }>();
  for (const store of runStores) for (const [runId, run] of Object.entries(store.runs) as [string, any][]) {
    const id = run?.identity;
    if (!id || typeof id.run !== 'string' || typeof id.lineage !== 'string' || typeof id.attempt !== 'string') continue;
    const key = `${id.run}.${id.lineage}.${id.attempt}`;
    const unit = units.get(key) || { ended: true, runIds: [] };
    unit.ended = unit.ended && run.phase === 'ended';
    unit.runIds.push(runId);
    units.set(key, unit);
  }
  const openRuns = new Set<string>();
  for (const store of dispatchStores) for (const dispatch of Object.values(store.dispatches) as any[]) {
    if (dispatch.phase !== 'ended' && typeof dispatch.workerRunId === 'string') openRuns.add(dispatch.workerRunId);
  }
  const kept = new Set<string>();
  for (const name of candidates) {
    const match = WORKER_UNIT.exec(name);
    const unit = match && units.get(`${match[1]}.${match[2]}.${match[3]}`);
    if (!unit || !unit.ended || unit.runIds.some((runId) => openRuns.has(runId))) kept.add(name);
  }
  return { names: kept, incomplete: false };
}
function lifecyclePathsSafe(project: any, fsImpl: any) {
  for (const rel of [path.join('.doflow'), path.join('.doflow', 'state'), path.join('.doflow', 'state', 'lifecycle'), path.join('.doflow', 'state', 'lifecycle', 'events')]) {
    try { if (fsImpl.lstatSync(path.join(project, rel)).isSymbolicLink()) return false; }
    catch (error: any) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return false; if (rel !== path.join('.doflow', 'state', 'lifecycle', 'events')) return false; }
  }
  return true;
}
function definitelyMissing(fsImpl: any, target: any) {
  try { fsImpl.lstatSync(target); return false; }
  catch (error: any) { return error.code === 'ENOENT' || error.code === 'ENOTDIR'; }
}
function reportCandidates(store: any, entries: any, context: any) {
  const { fsImpl, storeDir, roots, now, settings, shouldStop } = context;
  const project = projectRoot(roots);
  const key = project && projectKey(project, fsImpl), selected = [];
  for (const entry of entries) {
    if (shouldStop?.()) throw budgetError();
    const folder = path.join(storeDir, entry.name);
    let children, bodyNames = [];
    try {
      children = names(fsImpl, folder);
      for (const name of children) {
        if (shouldStop?.()) throw budgetError();
        if (BODY.test(name) && safeStat(fsImpl, path.join(folder, name))?.isFile()) bodyNames.push(name);
      }
    } catch (error: any) { if (error.partial) throw error; continue; }
    if (entry.name === key) {
      const lifecycle = path.join(project, '.doflow/state/lifecycle');
      if (!safeStat(fsImpl, path.join(lifecycle, 'migrated.json'))?.isFile() || !lifecyclePathsSafe(project, fsImpl)) continue;
      let snapshot;
      try { snapshot = readEvents(project, { fsImpl, lockFallback: false, shouldStop }); }
      catch { continue; }
      if (snapshot.incomplete) throw budgetError();
      if (snapshot.unreadable.length) continue;
      const eventIds = new Set();
      for (const event of snapshot.events) {
        if (shouldStop?.()) throw budgetError();
        const ids = [event.data.id, ...(Array.isArray(event.data.ids) ? event.data.ids : [])];
        for (const id of ids) {
          if (shouldStop?.()) throw budgetError();
          if (typeof id === 'string' && /^FU-[0-9a-hjkmnp-tv-z]{6}$/.test(id)) eventIds.add(id);
        }
      }
      for (const body of bodyNames) {
        if (shouldStop?.()) throw budgetError();
        const stat = safeStat(fsImpl, path.join(folder, body));
        if (stat && !eventIds.has(body.slice(0, -4)) && now - stat.mtimeMs > settings.orphanGraceHours * HOUR)
          selected.push({ name: `${entry.name}/${body}`, reason: 'orphan-body', bytes: stat.size, mtimeMs: stat.mtimeMs });
      }
    } else {
      const marker = path.join(folder, '.root');
      if (!safeStat(fsImpl, marker)?.isFile() || !bodyNames.length) continue;
      let validFolder = true;
      for (const name of children) {
        if (shouldStop?.()) throw budgetError();
        if (name !== '.root' && !bodyNames.includes(name)) { validFolder = false; break; }
      }
      if (!validFolder) continue;
      let root;
      try { root = fsImpl.readFileSync(marker, 'utf8').trim(); } catch { continue; }
      if (!path.isAbsolute(root) || !definitelyMissing(fsImpl, root)) continue;
      let newest = -Infinity;
      for (const body of bodyNames) {
        if (shouldStop?.()) throw budgetError();
        const stat = safeStat(fsImpl, path.join(folder, body));
        if (!stat) { newest = Infinity; break; }
        newest = Math.max(newest, stat.mtimeMs);
      }
      if (now - newest > store.bound.foreignMaxAgeDays * DAY)
        selected.push({ name: entry.name, reason: 'foreign-root-gone', bytes: entry.stat.size, mtimeMs: newest });
    }
  }
  return selected;
}
function selectCandidates(store: any, entries: any, context: any) {
  const { now, fsImpl, storeDir, roots, shouldStop } = context;
  switch (store.rule) {
    case 'count-and-age': {
      const hasTimestamp = (entry: any) => /^[0-9]{13}/.test(entry.name);
      const entryTime = (entry: any) => hasTimestamp(entry) ? Number(entry.name.slice(0, 13)) : entry.stat.mtimeMs;
      const ordered = [...entries].sort((a, b) => entryTime(b) - entryTime(a) || a.name.localeCompare(b.name));
      if (stopped(context)) return null;
      const selected = [];
      for (let index = 0; index < ordered.length; index += 1) {
        if (shouldStop?.()) return null;
        const entry = ordered[index], time = entryTime(entry);
        const beyondCount = index >= store.bound.keepNewest, beyondAge = now - time > store.bound.maxAgeDays * DAY;
        // Preserve timestamped stores' count-or-age policy; mtime entries must exceed both bounds unless bound.either is set.
        const eitherBound = hasTimestamp(entry) || store.bound?.either === true;
        if (eitherBound ? beyondCount || beyondAge : beyondCount && beyondAge)
          selected.push({ name: entry.name, reason: beyondCount ? 'count' : 'age', bytes: entry.stat.size, mtimeMs: time });
      }
      return selected;
    }
    case 'date-partition':
    case 'age': {
      const selected = [];
      for (const entry of entries) {
        if (shouldStop?.()) return null;
        const reason = ageReason(store, entry, now, fsImpl, storeDir, shouldStop);
        if (shouldStop?.()) return null;
        if (reason) selected.push({ name: entry.name, reason, bytes: entry.stat.size, mtimeMs: entry.stat.mtimeMs });
      }
      return selected;
    }
    case 'work': return workCandidates(store, entries, context);
    case 'report-orphan': return reportCandidates(store, entries, context);
    case 'recovery': {
      const root = roots[store.root]; let ledger;
      try { ledger = JSON.parse(fsImpl.readFileSync(path.join(root, 'ledger.json'), 'utf8')); if (!ledger || typeof ledger !== 'object' || typeof ledger.lastRecoveryId !== 'string') return []; } catch { return []; }
      const ordered = [...entries].sort((a, b) => b.name.localeCompare(a.name));
      if (stopped(context)) return null;
      const selected = [];
      for (let index = store.bound.keepNewest; index < ordered.length; index += 1) {
        if (shouldStop?.()) return null;
        const entry = ordered[index];
        if (entry.name.slice(0, -5) !== ledger.lastRecoveryId)
          selected.push({ name: entry.name, reason: 'count', bytes: entry.stat.size, mtimeMs: entry.stat.mtimeMs });
      }
      return selected;
    }
    case 'lifecycle-settled': return [];
    case 'existing': case 'control': return [];
    default: throw new Error(`Unknown storage rule '${store.rule}'`);
  }
}
module.exports={selectCandidates,recordStillCandidate,protectedLogs,unfinishedRuns,removableRules,ruleOrder,projectRoot,BODY};
