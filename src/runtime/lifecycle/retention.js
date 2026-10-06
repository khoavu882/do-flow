'use strict';

/**
 * Which event files the retention switch may delete. `DOFLOW_RETENTION_HOURS` is the window; unset
 * keeps everything. Events are grouped into deletion units, the follow-ups and goals they name
 * joined by any event that names more than one, and a unit goes only as a whole: when every item in
 * it is settled in the fold (a follow-up done or dismissed, a goal done) and its newest event is
 * older than the window. A unit whose removal would change anything else the fold shows (another
 * item, a feature, a release, a conflict) is kept.
 *
 * Pure: no file, clock or git access.
 */

const { isDeepStrictEqual } = require('node:util');
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
function unitsOf(events) {
  const parent = new Map();
  const find = (key) => {
    while (parent.get(key) !== key) {
      parent.set(key, parent.get(parent.get(key)));
      key = parent.get(key);
    }
    return key;
  };
  const named = events.map((event) => ({ event, items: [...new Set(itemsOf(event))] }));
  for (const { items } of named) {
    for (const key of items) if (!parent.has(key)) parent.set(key, key);
    for (const key of items.slice(1)) parent.set(find(key), find(items[0]));
  }
  const units = new Map();
  for (const { event, items } of named) {
    if (items.length === 0) continue;
    const head = find(items[0]);
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
function refoldEqual(events, full, removed, now) {
  const gone = new Set(removed.flatMap((u) => u.events.map((e) => e.id)));
  const keys = new Set(removed.flatMap((u) => [...u.items]));
  const expected = {
    ...full,
    followups: full.followups.filter((f) => !keys.has(`followup:${f.id}`)),
    goals: full.goals.filter((g) => !keys.has(`goal:${g.goal}`)),
    conflicts: full.conflicts.filter((c) => !gone.has(c.event)),
  };
  const kept = finalize(foldInto(events.filter((e) => !gone.has(e.id)), { now }));
  return isDeepStrictEqual(comparable(kept), comparable(expected));
}

/**
 * @param {Object[]} events IC-002 envelopes, as readEvents returns them
 * @param {{now: Date, windowMs: number}} options
 * @returns {{files: string[], units: Array<{items: string[], newestAt: string, files: string[]}>}}
 *   files: `<id>.json` names, sorted
 */
function selectExpired(events, { now, windowMs }) {
  const state = foldInto(events, { now });
  const cutoff = now.getTime() - windowMs;
  const candidates = unitsOf(events)
    .map((unit) => {
      const newest = unit.events.reduce((max, e) => (Date.parse(e.at) > Date.parse(max) ? e.at : max), unit.events[0].at);
      return { ...unit, newestAt: newest };
    })
    .filter((unit) => [...unit.items].every((key) => isSettled(state, key)) && Date.parse(unit.newestAt) < cutoff);

  const full = finalize(state);
  let selected = candidates;
  if (!refoldEqual(events, full, candidates, now)) {
    // Oldest first: a unit is taken when it still passes together with those already taken.
    selected = [];
    const ordered = [...candidates].sort((a, b) => Date.parse(a.newestAt) - Date.parse(b.newestAt));
    for (const unit of ordered) if (refoldEqual(events, full, [...selected, unit], now)) selected.push(unit);
  }
  const units = selected.map((unit) => ({
    items: [...unit.items].sort(),
    newestAt: unit.newestAt,
    files: unit.events.map((e) => `${e.id}.json`).sort(),
  }));
  return { files: units.flatMap((u) => u.files).sort(), units };
}

module.exports = { parseWindow, selectExpired };
