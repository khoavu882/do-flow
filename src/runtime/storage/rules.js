'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { workStatus, createWorkCache, refreshedWorkCache } = require('./work-status');
const { projectKey } = require('../lifecycle/report-store.ts');
const { readEvents } = require('../lifecycle/event-store');

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
function stopped(context) { return Boolean(context.shouldStop?.()); }
function budgetError() { return Object.assign(new Error('storage pass budget exhausted'), { code: 'EBUDGET', partial: true }); }
function projectRoot(roots) { return roots['project-state'] ? path.dirname(path.dirname(roots['project-state'])) : null; }
function safeStat(fsImpl, file) { try { return fsImpl.lstatSync(file); } catch { return null; } }
function names(fsImpl, dir) { return fsImpl.readdirSync(dir); }
function ageReason(store, entry, now, fsImpl, storeDir, shouldStop) {
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
function workCandidates(store, entries, context) {
  const { fsImpl, storeDir, now, roots, settings, shouldStop } = context;
  const project = projectRoot(roots);
  if (!project) return [];
  const cache = context.cache || createWorkCache({ projectRoot: project, fsImpl });
  const recordMatch = new RegExp(store.match), selected = [];
  const visit = (dir, namespace = null) => {
    let children;
    try { children = names(fsImpl, dir); } catch { return true; }
    for (const name of children) {
      if (shouldStop?.()) return false;
      const file = path.join(dir, name), stat = safeStat(fsImpl, file);
      if (!stat || !stat.isFile()) continue;
      if (TMP.test(name) && now - stat.mtimeMs > settings.staleTmpHours * HOUR) {
        selected.push({ name: namespace ? `${namespace}/${name}` : name, reason: 'stale-tmp', bytes: stat.size, mtimeMs: stat.mtimeMs, recordStat: stat });
      } else if (recordMatch.test(name)) {
        const result = workStatus({ projectRoot: project, store: store.id, taskId: name.slice(0, -5), namespace, mtimeMs: stat.mtimeMs, cache, fsImpl, shouldStop });
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
function recordStillCandidate(store, candidate, info, context) {
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
  const status = workStatus({ projectRoot: projectRoot(roots), store: store.id, taskId: name.slice(0, -5), namespace, mtimeMs: info.mtimeMs, cache: fresh, fsImpl, shouldStop });
  return !status.incomplete && !shouldStop?.() && status.state === 'finished'
    && status.since === candidate.mtimeMs && now - status.since > store.bound.finishedDays * DAY;
}
function workStorePathStatus(store, roots, fsImpl) {
  const project = projectRoot(roots), root = roots[store.root];
  if (!project || !root) return 'missing';
  const paths = [path.join(project, '.doflow'), root];
  let current = root;
  for (const segment of store.path.split('/')) { current = path.join(current, segment); paths.push(current); }
  for (const candidate of paths) {
    let info;
    try { info = fsImpl.lstatSync(candidate); }
    catch (error) { return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' : 'inaccessible'; }
    if (info.isSymbolicLink()) return 'linked';
  }
  return 'safe';
}
function protectedLogs({ registry, roots, fsImpl, cache, shouldStop }) {
  const project = projectRoot(roots), protectedNames = new Set();
  if (!project) return { names: protectedNames, incomplete: false };
  const workCache = cache || createWorkCache({ projectRoot: project, fsImpl });
  for (const store of registry.stores.filter((s) => s.root === 'project-state' && s.entry === 'record' && s.rule === 'work')) {
    if (shouldStop?.()) return { names: protectedNames, incomplete: true };
    const pathStatus = workStorePathStatus(store, roots, fsImpl);
    if (pathStatus === 'missing') continue;
    if (pathStatus !== 'safe') return { names: protectedNames, incomplete: true, ...(pathStatus === 'linked' ? { reason: LINKED } : {}) };
    const dir = path.join(roots[store.root], ...store.path.split('/'));
    const recordMatch = new RegExp(store.match);
    let linked = false;
    const visit = (folder, namespace = null) => {
      let list;
      try { list = names(fsImpl, folder); }
      catch (error) { return error.code === 'ENOENT' || error.code === 'ENOTDIR'; }
      for (const name of list) {
        if (shouldStop?.()) return false;
        const file = path.join(folder, name);
        let stat;
        try { stat = fsImpl.lstatSync(file); }
        catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; return false; }
        if (stat.isSymbolicLink()) { linked = true; return false; }
        if (namespace === null && stat.isDirectory() && SAFE_NAMESPACE.test(name) && !name.includes('..')) {
          if (!visit(file, name)) return false;
          continue;
        }
        if (!stat.isFile() || !recordMatch.test(name)) continue;
        const status = workStatus({ projectRoot: project, store: store.id, taskId: name.slice(0, -5), namespace, mtimeMs: stat.mtimeMs, cache: workCache, fsImpl, shouldStop });
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
function lifecyclePathsSafe(project, fsImpl) {
  for (const rel of [path.join('.doflow'), path.join('.doflow', 'state'), path.join('.doflow', 'state', 'lifecycle'), path.join('.doflow', 'state', 'lifecycle', 'events')]) {
    try { if (fsImpl.lstatSync(path.join(project, rel)).isSymbolicLink()) return false; }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return false; if (rel !== path.join('.doflow', 'state', 'lifecycle', 'events')) return false; }
  }
  return true;
}
function definitelyMissing(fsImpl, target) {
  try { fsImpl.lstatSync(target); return false; }
  catch (error) { return error.code === 'ENOENT' || error.code === 'ENOTDIR'; }
}
function reportCandidates(store, entries, context) {
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
    } catch (error) { if (error.partial) throw error; continue; }
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
function selectCandidates(store, entries, context) {
  const { now, fsImpl, storeDir, roots, shouldStop } = context;
  switch (store.rule) {
    case 'count-and-age': {
      const ordered = [...entries].sort((a, b) => Number(b.name.slice(0, 13)) - Number(a.name.slice(0, 13)) || a.name.localeCompare(b.name));
      if (stopped(context)) return null;
      const selected = [];
      for (let index = 0; index < ordered.length; index += 1) {
        if (shouldStop?.()) return null;
        const entry = ordered[index], time = Number(entry.name.slice(0, 13));
        if (index >= store.bound.keepNewest || now - time > store.bound.maxAgeDays * DAY)
          selected.push({ name: entry.name, reason: index >= store.bound.keepNewest ? 'count' : 'age', bytes: entry.stat.size, mtimeMs: time });
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
module.exports={selectCandidates,recordStillCandidate,protectedLogs,removableRules,ruleOrder,projectRoot,BODY};
