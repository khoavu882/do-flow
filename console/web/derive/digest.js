// "Since you looked" on Now (180 C3, design §2; FR-A2, FR-A4): the rows of every shown project, keyed `<projectKey>:<taskId>`, and
// how they differ from the look this browser kept. A look is `{ at, states: { [key]: state } }` of at most LOOK_LIMIT keys, newest
// first. Pure functions over the `machine` member and the `now` runs: no DOM, no clock, no storage (notify.js keeps the look).

import { sectionOf } from './layers.js';

/** The most runs a look keeps. */
const LOOK_LIMIT = 200;

/** @param {{ projectKey: string, taskId: string }} row */
const lookKey = (row) => `${row.projectKey}:${row.taskId}`;

/** @param {any} iso */
const timeOf = (iso) => {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : -Infinity;
};

/** The rows a look can hold: the LOOK_LIMIT newest by `updatedAt` (an unknown time last, then by key). @param {any[]} rows */
function newestRows(rows) {
  return [...rows]
    .sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt) || (lookKey(a) < lookKey(b) ? -1 : lookKey(a) > lookKey(b) ? 1 : 0))
    .slice(0, LOOK_LIMIT);
}

/** A stored look, or null when it is missing, malformed or later than `nowMs`. @param {any} seen @param {number} nowMs */
function lookOf(seen, nowMs) {
  if (!seen || typeof seen !== 'object' || Array.isArray(seen)) return null;
  if (typeof seen.at !== 'number' || !Number.isFinite(seen.at) || seen.at > nowMs) return null;
  const states = seen.states;
  if (!states || typeof states !== 'object' || Array.isArray(states)) return null;
  if (!Object.values(states).every((state) => typeof state === 'string')) return null;
  return { at: seen.at, states };
}

/**
 * What moved since the look: runs that `appeared` (`{ key, to, row }`), `changed` state (`{ key, from, to, row }`) or `left`
 * (`{ key, projectKey, taskId, from }`). Without a usable look nothing is listed (`since` null): a first visit has no news.
 * @param {any} seen the stored look @param {any[]} rows @param {number} nowMs
 */
function sinceLooked(seen, rows, nowMs) {
  const look = lookOf(seen, nowMs);
  if (look === null) return { since: null, appeared: [], changed: [], left: [] };
  const appeared = [];
  const changed = [];
  for (const row of newestRows(rows)) {
    const key = lookKey(row);
    const from = Object.hasOwn(look.states, key) ? look.states[key] : null;
    if (from === null) appeared.push({ key, to: row.state, row });
    else if (from !== row.state) changed.push({ key, from, to: row.state, row });
  }
  const listed = new Set(rows.map(lookKey));
  const left = Object.keys(look.states).filter((key) => !listed.has(key)).map((key) => {
    const cut = key.indexOf(':');
    return { key, projectKey: key.slice(0, cut), taskId: key.slice(cut + 1), from: look.states[key] };
  });
  return { since: look.at, appeared, changed, left };
}

/** The look of these rows at `nowMs`. @param {any[]} rows @param {number} nowMs */
function nextSeen(rows, nowMs) {
  /** @type {Record<string, string>} */
  const states = {};
  for (const row of newestRows(rows)) states[lookKey(row)] = row.state;
  return { at: nowMs, states };
}

/** The current project's `now` runs as rows. @param {any[]} runs @param {string} projectKey @param {string} label */
function ownRows(runs, projectKey, label) {
  return runs.map((run) => ({ projectKey, projectLabel: label, taskId: run.taskId, slug: run.featureSlug ?? null, state: run.state, updatedAt: run.updatedAt ?? null, gateName: null }));
}

/** The labels of the project list, by key. @param {any} machine */
function labelsOf(machine) {
  const section = sectionOf(machine, 'projects');
  const projects = section.state === 'ok' && Array.isArray(section.data.projects) ? section.data.projects : [];
  return { projects, labels: new Map(projects.map((/** @type {any} */ p) => [p.projectKey, String(p.label)])) };
}

/** The activity items of the `machine` member. @param {any} machine */
function itemsOf(machine) {
  const section = sectionOf(machine, 'activity');
  return section.state === 'ok' && Array.isArray(section.data.items) ? section.data.items : [];
}

/** One `openRuns` entry as a row. @param {any} run @param {string} projectKey @param {string} label */
const openRow = (run, projectKey, label) => ({
  projectKey, projectLabel: label, taskId: run.taskId, slug: run.slug, state: run.state, updatedAt: run.updatedAt, gateName: run.gateName,
  workflowName: run.workflowName, step: run.step,
});

/** The open runs of every shown project, the current one too (the notification reads them). @param {any} machine */
function machineRows(machine) {
  const { labels } = labelsOf(machine);
  return itemsOf(machine).flatMap((/** @type {any} */ item) => (Array.isArray(item.openRuns)
    ? item.openRuns.map((/** @type {any} */ run) => openRow(run, item.projectKey, labels.get(item.projectKey) ?? item.projectKey.slice(0, 8)))
    : []));
}

/**
 * What Now adds from the `machine` member: the current project, the other shown projects' open runs as rows, the projects an
 * older core gave counts only for (no `openRuns`), and how many projects the core did not summarize. Null without a readable
 * project list that names the current project: the current project's rows could not be told from the others.
 * @param {any} machine
 */
function machineRuns(machine) {
  const { projects, labels } = labelsOf(machine);
  const current = projects.find((/** @type {any} */ p) => p.current === true);
  if (!current) return null;
  const currentKey = current.projectKey;
  const items = itemsOf(machine).filter((/** @type {any} */ item) => item.projectKey !== currentKey);
  const activity = sectionOf(machine, 'activity');
  const limits = activity.state === 'ok' ? activity.data.limits : null;
  return {
    currentKey,
    currentLabel: String(current.label),
    others: machineRows(machine).filter((/** @type {any} */ row) => row.projectKey !== currentKey),
    countsOnly: items.filter((/** @type {any} */ item) => !Array.isArray(item.openRuns) && (item.runs.open > 0 || item.runs.awaiting > 0))
      .map((/** @type {any} */ item) => ({ projectKey: item.projectKey, label: labels.get(item.projectKey) ?? item.projectKey.slice(0, 8), open: item.runs.open, awaiting: item.runs.awaiting })),
    notShown: limits && Number.isInteger(limits.notShown) ? limits.notShown : 0,
  };
}

export { LOOK_LIMIT, lookKey, sinceLooked, nextSeen, ownRows, machineRows, machineRuns };
