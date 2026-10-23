'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Which event files the retention switch may delete. `DOFLOW_RETENTION_HOURS` overrides the window;
 * when it is unset, the declared default applies only while the project's `prune` setting is on.
 * Events are grouped into deletion units, the follow-ups and goals they name
 * joined by any event that names more than one, and a unit goes only as a whole: when every item in
 * it is settled in the fold (a follow-up done or dismissed, a goal done) and its newest event is
 * older than the window. A unit whose removal would change anything else the fold shows (another
 * item, a feature, a release, a conflict) is kept, and so is a unit that an event of a type this
 * version does not know (written by a newer DoFlow) names by id.
 *
 * `parseWindow` remains pure. `retentionWindow` composes the resolver-owned default with the project's
 * prune setting; explicit values retain their existing meaning while pruning is off.
 */

const nodeFs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const { loadSettings } = require('../settings/resolve.ts');
const { foldInto, finalize, EVENT_TYPES } = require('./fold.ts');

const HOUR_MS = 3600000;

/** @returns {{state: 'off'} | {state: 'on', hours: number, ms: number} | {state: 'invalid', raw: string}} */
function parseWindow(env: Record<string, string | undefined> = process.env): { state: 'off' } | { state: 'on'; hours: number; ms: number } | { state: 'invalid'; raw: string } {
  const raw = env.DOFLOW_RETENTION_HOURS;
  if (raw === undefined || raw === '') return { state: 'off' };
  if (/^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(Number(raw))) {
    const hours = Number(raw);
    return { state: 'on', hours, ms: hours * HOUR_MS };
  }
  return { state: 'invalid', raw: String(raw) };
}

function invalidRaw(resolved: any, env: Record<string, string | undefined>): string {
  for (let i = resolved.candidates.length - 1; i >= 0; i -= 1) {
    const candidate = resolved.candidates[i];
    if (candidate.status !== 'invalid') continue;
    if (candidate.layer === 'env') return String(env.DOFLOW_RETENTION_HOURS ?? '');
    try {
      const raw = JSON.parse(candidate.display);
      if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
    } catch { /* a malformed whole-file candidate has no display value */ }
    return candidate.display || candidate.reason || candidate.code || '';
  }
  return '';
}

/** Composes the retention setting and prune gate through the shared settings resolver. */
function retentionWindow({ env = process.env, projectRoot, fsImpl = nodeFs }: any = {}): any {
  const parsed = parseWindow(env);
  if (parsed.state === 'invalid') return parsed;
  try {
    let settingsRegistry;
    if (fsImpl !== nodeFs) {
      const { loadSettingsRegistry } = require('../settings/registry.ts');
      const loaded = loadSettingsRegistry({ fsImpl });
      if (!loaded.ok) throw new Error(loaded.detail);
      settingsRegistry = loaded.registry;
    }
    const view = loadSettings({ projectRoot, env, fsImpl, ...(settingsRegistry ? { registry: settingsRegistry } : {}) });
    const retention = view.get('storage.retentionHours', 'project');
    if (retention.state === 'invalid') return { state: 'invalid', raw: invalidRaw(retention, env) };
    if (retention.explicit) {
      const hours = retention.value;
      return { state: 'on', hours, ms: hours * HOUR_MS, source: retention.origin.layer };
    }
    if (view.get('storage.prune', 'project').value !== 'on') return { state: 'off' };
    const hours = retention.value;
    return { state: 'on', hours, ms: hours * HOUR_MS, source: 'default' };
  } catch {
    // Preserve an explicit environment window when the resolver registry is unavailable.
    return parsed.state === 'on' ? { ...parsed, source: 'env' } : { state: 'off' };
  }
}

function isText(value: any): boolean { return typeof value === 'string' && value.trim() !== ''; }

/** The item keys an event names, or none when it is not about a follow-up or a goal. */
function itemsOf(event: any): string[] {
  const d = event.data;
  const ids = (list: any): string[] => (Array.isArray(list) && list.length > 0 && list.every(isText) ? list : []);
  switch (event.type) {
    case 'followup.added': return isText(d.id) ? [`followup:${d.id}`] : [];
    case 'followup.taken':
    case 'followup.promoted': return ids(d.ids).map((id: string) => `followup:${id}`);
    case 'followup.settled': return (isText(d.id) ? [d.id] : ids(d.ids)).map((id: string) => `followup:${id}`);
    case 'goal.added':
    case 'goal.item-added':
    case 'goal.checked':
    case 'goal.done':
    case 'goal.linked': return isText(d.goal) ? [`goal:${d.goal}`] : [];
    default: return [];
  }
}

/** Groups the items into units: items named together by one event share a unit. */
function unitsOf(events: any[], shouldStop?: () => boolean): any[] | null {
  const parent = new Map<string, string>();
  const find = (key: string): string | null => {
    while (parent.get(key) !== key) {
      if (shouldStop?.()) return null;
      parent.set(key, parent.get(parent.get(key) as string) as string);
      key = parent.get(key) as string;
    }
    return key;
  };
  const named: Array<{ event: any; items: string[] }> = [];
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
  const units = new Map<string, any>();
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

/**
 * Every string value and every object key in the data of the events whose type this version's fold
 * does not know (a newer DoFlow wrote them). The fold ignores them, so retention cannot tell what they change; a unit that
 * one of them names by id is kept whole rather than deleted from under it. Exact matches only:
 * keeping too little is a lost record, keeping too much only a file that stays.
 * @returns {Set<string>|null} null when `shouldStop` fired
 */
function unknownTypeStrings(events: any[], shouldStop?: () => boolean): Set<string> | null {
  const known = new Set<string>(EVENT_TYPES);
  const found = new Set<string>();
  for (const event of events) {
    if (shouldStop?.()) return null;
    if (known.has(event.type)) continue;
    const pending: any[] = [event.data];
    while (pending.length > 0) {
      if (shouldStop?.()) return null;
      const value = pending.pop();
      if (typeof value === 'string') found.add(value);
      else if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) found.add(key);
        pending.push(...Object.values(value));
      }
    }
  }
  return found;
}

function isSettled(state: any, key: string): boolean {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'followup') {
    const item = state.items.get(id);
    return Boolean(item) && (item.state === 'done' || item.state === 'dismissed');
  }
  const goal = state.goals.get(id);
  return Boolean(goal) && goal.status === 'done';
}

/** The parts of a fold that removing a unit must leave unchanged. */
function comparable(result: any): any {
  const { followups, features, merged, goals, releases, conflicts } = result;
  return { followups, features, merged, goals, releases, conflicts };
}

/** Whether dropping `removed` units changes nothing but the removed items themselves. */
function refoldEqual(events: any[], full: any, removed: any[], now: Date, shouldStop?: () => boolean): boolean | null {
  if (shouldStop?.()) return null;
  const gone = new Set<string>(), keys = new Set<string>();
  for (const unit of removed) {
    if (shouldStop?.()) return null;
    for (const event of unit.events) gone.add(event.id);
    for (const key of unit.items) keys.add(key);
  }
  const expected = {
    ...full,
    followups: full.followups.filter((f: any) => !keys.has(`followup:${f.id}`)),
    goals: full.goals.filter((g: any) => !keys.has(`goal:${g.goal}`)),
    conflicts: full.conflicts.filter((c: any) => !gone.has(c.event)),
  };
  const remaining: any[] = [];
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
function selectExpired(events: any[], { now, windowMs, shouldStop }: any = {}): any {
  const incomplete = (): any => ({ files: [], units: [], incomplete: true });
  if (shouldStop?.()) return incomplete();
  const state = foldInto(events, { now, shouldStop });
  if (state.incomplete || shouldStop?.()) return incomplete();
  const cutoff = now.getTime() - windowMs;
  const served = new Set<string>();
  for (const feature of state.tracked.values()) {
    if (shouldStop?.()) return incomplete();
    if (feature.goal) served.add(feature.goal);
  }
  const named = unitsOf(events, shouldStop);
  if (!named || shouldStop?.()) return incomplete();
  const mentioned = unknownTypeStrings(events, shouldStop);
  if (!mentioned || shouldStop?.()) return incomplete();
  // Selected exactly as 5bc9407b did (every settled, expired, unserved unit is a candidate), and only
  // then are the units an unknown-type event names dropped. Protection removes units from that
  // selection; it never changes which of the others are picked, so what is deleted is always a subset
  // of what base would delete on the same events.
  const candidates: any[] = [];
  for (const unit of named) {
    if (shouldStop?.()) return incomplete();
    const newest = unit.events.reduce((max: string, event: any) => (Date.parse(event.at) > Date.parse(max) ? event.at : max), unit.events[0].at);
    if (shouldStop?.()) return incomplete();
    let eligible = Date.parse(newest) < cutoff;
    if (eligible) for (const key of unit.items) {
      if (shouldStop?.()) return incomplete();
      if (!isSettled(state, key) || (key.startsWith('goal:') && served.has(key.slice('goal:'.length)))) { eligible = false; break; }
    }
    if (eligible) candidates.push({ ...unit, newestAt: newest });
  }
  const full = finalize(state);
  /** The refold-safe subset of `list`: all of it when that holds, else the oldest-first greedy pass. */
  const safeSubset = (list: any[]): any[] | null => {
    const allSafe = refoldEqual(events, full, list, now, shouldStop);
    if (allSafe === null || shouldStop?.()) return null;
    if (allSafe) return list;
    const chosen: any[] = [];
    const ordered = [...list].sort((a: any, b: any) => Date.parse(a.newestAt) - Date.parse(b.newestAt));
    if (shouldStop?.()) return null;
    for (const unit of ordered) {
      if (shouldStop?.()) return null;
      const safe = refoldEqual(events, full, [...chosen, unit], now, shouldStop);
      if (safe === null) return null;
      if (safe) chosen.push(unit);
    }
    return chosen;
  };
  const baseSelected = safeSubset(candidates);
  if (!baseSelected) return incomplete();
  const unprotected = baseSelected.filter((unit: any) => ![...unit.items].some((key: string) => mentioned.has(key.slice(key.indexOf(':') + 1))));
  // Dropping units can leave a set the refold no longer accepts; check it again, inside the subset.
  const selected = unprotected.length === baseSelected.length ? baseSelected : safeSubset(unprotected);
  if (!selected) return incomplete();
  const units: any[] = [];
  for (const unit of selected) {
    if (shouldStop?.()) return incomplete();
    units.push({ items: [...unit.items].sort(), newestAt: unit.newestAt, files: unit.events.map((event: any) => `${event.id}.json`).sort() });
  }
  if (shouldStop?.()) return incomplete();
  return { files: units.flatMap((unit: any) => unit.files).sort(), units };
}

module.exports = { parseWindow, retentionWindow, selectExpired };
