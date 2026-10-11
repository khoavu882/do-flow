'use strict';

/**
 * Which event files the retention switch may delete. `DOFLOW_RETENTION_HOURS` overrides the window;
 * when it is unset, the declared default applies only while the project's `prune` setting is on.
 * Events are grouped into deletion units, the follow-ups and goals they name
 * joined by any event that names more than one, and a unit goes only as a whole: when every item in
 * it is settled in the fold (a follow-up done or dismissed, a goal done) and its newest event is
 * older than the window. A unit whose removal would change anything else the fold shows (another
 * item, a feature, a release, a conflict) is kept.
 *
 * `parseWindow` remains pure. `retentionWindow` composes its unset case with the declared storage
 * default and the project's prune setting; explicit environment values retain their existing meaning.
 */

const nodeFs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const { REPO_ROOT } = require('../../helper/repo-root');
const { loadStorageRegistry } = require('../storage/registry');
const { resolveRoots, readPruneSetting } = require('../storage/roots');
const { foldInto, finalize } = require('./fold');

const HOUR_MS = 3600000;

/** @returns {{state: 'off'} | {state: 'on', hours: number, ms: number} | {state: 'invalid', raw: string}} */
function parseWindow(env = process.env) {
  const raw = env.DOFLOW_RETENTION_HOURS;
  if (raw === undefined || raw === '') return { state: 'off' };
  if (/^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(Number(raw))) {
    const hours = Number(raw);
    return { state: 'on', hours, ms: hours * HOUR_MS };
  }
  return { state: 'invalid', raw: String(raw) };
}

/** Composes IC-013's explicit environment override with the declared lifecycle default. */
function retentionWindow({ env = process.env, projectRoot, registry, fsImpl = nodeFs } = {}) {
  const parsed = parseWindow(env);
  if (parsed.state === 'invalid') return parsed;
  if (parsed.state === 'on') return { ...parsed, source: 'env' };
  let activeRegistry;
  try {
    activeRegistry = registry || loadStorageRegistry({ repoRoot: REPO_ROOT, fsImpl });
  } catch {
    return { state: 'off' };
  }
  const roots = resolveRoots({ registry: activeRegistry, projectRoot, env });
  if (readPruneSetting({ registry: activeRegistry, roots, rootId: 'project-state', fsImpl }).setting !== 'on') return { state: 'off' };
  const lifecycleStore = activeRegistry.stores.find((store) => store.id === 'lifecycle-events');
  if (!lifecycleStore) throw new Error('Storage registry has no lifecycle-events store');
  const hours = lifecycleStore.bound.defaultHours;
  return { state: 'on', hours, ms: hours * HOUR_MS, source: 'default' };
}

function isText(value) { return typeof value === 'string' && value.trim() !== ''; }

/** The item keys an event names, or none when it is not about a follow-up or a goal. */
function itemsOf(event) {
  const d = event.data;
  const ids = (list) => (Array.isArray(list) && list.length > 0 && list.every(isText) ? list : []);
  switch (event.type) {
    case 'followup.added': return isText(d.id) ? [`followup:${d.id}`] : [];
    case 'followup.taken':
    case 'followup.promoted': return ids(d.ids).map((id) => `followup:${id}`);
    case 'followup.settled': return (isText(d.id) ? [d.id] : ids(d.ids)).map((id) => `followup:${id}`);
    case 'goal.added':
    case 'goal.item-added':
    case 'goal.checked':
    case 'goal.done':
    case 'goal.linked': return isText(d.goal) ? [`goal:${d.goal}`] : [];
    default: return [];
  }
}

/** Groups the items into units: items named together by one event share a unit. */
function unitsOf(events, shouldStop) {
  const parent = new Map();
  const find = (key) => {
    while (parent.get(key) !== key) {
      if (shouldStop?.()) return null;
      parent.set(key, parent.get(parent.get(key)));
      key = parent.get(key);
    }
    return key;
  };
  const named = [];
  for (const event of events) {
    if (shouldStop?.()) return null;
    named.push({ event, items: [...new Set(itemsOf(event))] });
  }
  for (const { items } of named) {
    if (shouldStop?.()) return null;
    for (const key of items) if (!parent.has(key)) parent.set(key, key);
    for (const key of items.slice(1)) {
      const root = find(key), head = find(items[0]);
      if (root === null || head === null) return null;
      parent.set(root, head);
    }
  }
  const units = new Map();
  for (const { event, items } of named) {
    if (shouldStop?.()) return null;
    if (items.length === 0) continue;
    const head = find(items[0]);
    if (head === null) return null;
    if (!units.has(head)) units.set(head, { items: new Set(), events: [] });
    const unit = units.get(head);
    for (const key of items) unit.items.add(key);
    unit.events.push(event);
  }
  return [...units.values()];
}

function isSettled(state, key) {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'followup') {
    const item = state.items.get(id);
    return Boolean(item) && (item.state === 'done' || item.state === 'dismissed');
  }
  const goal = state.goals.get(id);
  return Boolean(goal) && goal.status === 'done';
}

/** The parts of a fold that removing a unit must leave unchanged. */
function comparable(result) {
  const { followups, features, merged, goals, releases, conflicts } = result;
  return { followups, features, merged, goals, releases, conflicts };
}

/** Whether dropping `removed` units changes nothing but the removed items themselves. */
function refoldEqual(events, full, removed, now, shouldStop) {
  if (shouldStop?.()) return null;
  const gone = new Set(), keys = new Set();
  for (const unit of removed) {
    if (shouldStop?.()) return null;
    for (const event of unit.events) gone.add(event.id);
    for (const key of unit.items) keys.add(key);
  }
  const expected = {
    ...full,
    followups: full.followups.filter((f) => !keys.has(`followup:${f.id}`)),
    goals: full.goals.filter((g) => !keys.has(`goal:${g.goal}`)),
    conflicts: full.conflicts.filter((c) => !gone.has(c.event)),
  };
  const remaining = [];
  for (const event of events) {
    if (shouldStop?.()) return null;
    if (!gone.has(event.id)) remaining.push(event);
  }
  const state = foldInto(remaining, { now, shouldStop });
  if (state.incomplete) return null;
  return isDeepStrictEqual(comparable(finalize(state)), comparable(expected));
}

/**
 * @param {Object[]} events IC-002 envelopes, as readEvents returns them
 * @param {{now: Date, windowMs: number, shouldStop?: Function}} options
 * @returns {{files: string[], units: Array<{items: string[], newestAt: string, files: string[]}>, incomplete?: true}}
 *   files: `<id>.json` names, sorted
 */
function selectExpired(events, { now, windowMs, shouldStop } = {}) {
  const incomplete = () => ({ files: [], units: [], incomplete: true });
  if (shouldStop?.()) return incomplete();
  const state = foldInto(events, { now, shouldStop });
  if (state.incomplete || shouldStop?.()) return incomplete();
  const cutoff = now.getTime() - windowMs;
  const served = new Set();
  for (const feature of state.tracked.values()) {
    if (shouldStop?.()) return incomplete();
    if (feature.goal) served.add(feature.goal);
  }
  const named = unitsOf(events, shouldStop);
  if (!named || shouldStop?.()) return incomplete();
  const candidates = [];
  for (const unit of named) {
    if (shouldStop?.()) return incomplete();
    const newest = unit.events.reduce((max, event) => (Date.parse(event.at) > Date.parse(max) ? event.at : max), unit.events[0].at);
    if (shouldStop?.()) return incomplete();
    let eligible = Date.parse(newest) < cutoff;
    if (eligible) for (const key of unit.items) {
      if (shouldStop?.()) return incomplete();
      if (!isSettled(state, key) || (key.startsWith('goal:') && served.has(key.slice('goal:'.length)))) { eligible = false; break; }
    }
    if (eligible) candidates.push({ ...unit, newestAt: newest });
  }
  const full = finalize(state);
  let selected = candidates;
  const allSafe = refoldEqual(events, full, candidates, now, shouldStop);
  if (allSafe === null || shouldStop?.()) return incomplete();
  if (!allSafe) {
    selected = [];
    const ordered = [...candidates].sort((a, b) => Date.parse(a.newestAt) - Date.parse(b.newestAt));
    if (shouldStop?.()) return incomplete();
    for (const unit of ordered) {
      if (shouldStop?.()) return incomplete();
      const safe = refoldEqual(events, full, [...selected, unit], now, shouldStop);
      if (safe === null) return incomplete();
      if (safe) selected.push(unit);
    }
  }
  const units = [];
  for (const unit of selected) {
    if (shouldStop?.()) return incomplete();
    units.push({ items: [...unit.items].sort(), newestAt: unit.newestAt, files: unit.events.map((event) => `${event.id}.json`).sort() });
  }
  if (shouldStop?.()) return incomplete();
  return { files: units.flatMap((unit) => unit.files).sort(), units };
}

module.exports = { parseWindow, retentionWindow, selectExpired };
