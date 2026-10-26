// Timeline derivation (IC-012 as the run view draws it, design note E.2 sections 5, 9.3 and 14.3): the segments of a
// shared time axis, annotate markers, the event list and the axis ticks. Pure functions: no DOM and no clock reads
// (the caller passes `nowMs`), so console/test/derive-activity.test.ts runs it in Node.

import { deriveRail, formatDuration, liveDuration, stateWord, kindWord, sinceStamp, clockHM } from './rail.js';
import { eventWords, isProgress } from './activity.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The tick steps of E.2 section 9.3, smallest first. */
const TICK_STEPS = Object.freeze([SECOND, 5 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY]);
/** One tick per this many pixels of track, at most. */
const TICK_PX = 96;
/** Annotate markers closer than this many pixels merge. */
const MERGE_PX = 6;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isObject = (/** @type {any} */ value) => value !== null && typeof value === 'object';
const timeOf = (/** @type {any} */ iso) => (typeof iso === 'string' ? Date.parse(iso) : Number.NaN);
const two = (/** @type {number} */ n) => String(n).padStart(2, '0');

/**
 * Where an event sits in the program: stage actions belong to stages, gate actions to gates.
 * @param {any} event
 * @returns {'stage' | 'gate' | null}
 */
function nodeTypeOf(event) {
  if (event.action === 'complete-stage' || event.action === 'skip-stage') return 'stage';
  if (event.action === 'decide-gate' || event.action === 'skip-gate') return 'gate';
  return null;
}

/**
 * The tone of an event's mark in the list (the rail's tones; muted for start, note and the end of the run).
 * @param {any} event
 */
function eventTone(event) {
  switch (event.action) {
    case 'complete-stage': return event.outcome === 'failed' ? 'failed' : event.outcome === 'unverified' ? 'unknown' : 'done';
    case 'decide-gate': return event.decision === 'reject' ? 'rejected' : 'awaiting';
    case 'skip-stage':
    case 'skip-gate': return 'skipped';
    default: return 'muted';
  }
}

/**
 * The timeline of one run.
 *  - `rows`: one per program node in program order, each `{ node, segments[] }` (`node` is the rail node); empty when
 *    the rail is degraded (the chart needs the program). A segment is `{ fromMs, toMs, kind }` with `kind`
 *    `stage`, `wait`, `skip` or `live`; it runs from the previous progress event to the node's own event (E.2 Q1).
 *  - `markers`: one per timed note, `{ atMs, nodeId }`.
 *  - `domain`: `{ startMs, endMs, live }`; `axisDomain` turns it into the drawn axis.
 *  - `untimed`: events without a usable time (placed nowhere). `other`: the count of events of other actions.
 *  - `list`: every event, newest first (journal order reversed), `{ at, words, durationMs, tone, action }`.
 *  - `available`: false when the timeline could not be read (`timeline` null).
 * @param {any} workflow
 * @param {any} row the run route's `run`
 * @param {any} timeline the timeline body, or null
 * @param {number} nowMs
 */
function deriveTimeline(workflow, row, timeline, nowMs) {
  const available = isObject(timeline);
  /** @type {any[]} */
  const events = available && Array.isArray(timeline.events) ? timeline.events.filter(isObject) : [];
  const rail = deriveRail(workflow, row, available ? timeline : null, nowMs);
  const live = row.state === 'RUNNING' || row.state === 'AWAITING_GATE';

  // The time each progress event closed from: the previous progress event's time (null when either side is unknown).
  /** @type {Array<{ index: number, fromMs: number, toMs: number }>} */
  const closed = [];
  let previous = Number.NaN;
  let lastProgress = -1;
  events.forEach((event, index) => {
    if (!isProgress(event)) return;
    const at = timeOf(event.at);
    closed.push({ index, fromMs: previous, toMs: at });
    previous = at;
    lastProgress = index;
  });
  const closedBy = new Map(closed.map((entry) => [entry.index, entry]));

  /** @type {Array<any>} */
  const rows = rail.degraded === null ? rail.nodes.map((/** @type {any} */ node) => ({ node, segments: /** @type {any[]} */ ([]) })) : [];
  if (rail.degraded === null) {
    events.forEach((event, index) => {
      const type = nodeTypeOf(event);
      if (type === null || typeof event.node !== 'string') return;
      const target = rows.find((entry) => entry.node.type === type && entry.node.id === event.node);
      const span = closedBy.get(index);
      if (!target || !span || !Number.isFinite(span.toMs)) return;
      if (event.action === 'skip-stage' || event.action === 'skip-gate') target.segments.push({ fromMs: span.toMs, toMs: span.toMs, kind: 'skip' });
      else if (Number.isFinite(span.fromMs)) target.segments.push({ fromMs: Math.min(span.fromMs, span.toMs), toMs: span.toMs, kind: type === 'gate' ? 'wait' : 'stage' });
    });
    const cursor = rows[rail.cursor];
    if (live && cursor && Number.isFinite(previous) && lastProgress >= 0) cursor.segments.push({ fromMs: previous, toMs: Math.max(previous, nowMs), kind: 'live' });
  }

  /** @type {Array<{ atMs: number, nodeId: string | null }>} */
  const markers = [];
  let untimed = 0;
  const timed = [];
  for (const event of events) {
    const at = timeOf(event.at);
    if (!Number.isFinite(at)) {
      untimed += 1;
      continue;
    }
    timed.push(at);
    if (event.action === 'annotate') markers.push({ atMs: at, nodeId: typeof event.node === 'string' ? event.node : null });
  }

  const startedMs = timeOf(available ? timeline.startedAt : null);
  const rowStart = timeOf(row.startedAt);
  const startMs = Number.isFinite(startedMs) ? startedMs : timed.length > 0 ? Math.min(...timed) : Number.isFinite(rowStart) ? rowStart : nowMs;
  const lastTimed = timed.length > 0 ? Math.max(...timed) : startMs;
  const endMs = live ? Math.max(nowMs, startMs) : Math.max(lastTimed, startMs);

  const list = events.map((event, index) => {
    const span = closedBy.get(index);
    const duration = span && nodeTypeOf(event) !== null && event.action !== 'skip-stage' && event.action !== 'skip-gate' && Number.isFinite(span.fromMs) && Number.isFinite(span.toMs)
      ? Math.max(0, span.toMs - span.fromMs) : null;
    return { at: event.at ?? null, action: event.action, words: eventWords(event), durationMs: duration, tone: eventTone(event) };
  }).reverse();

  return {
    rows,
    markers,
    domain: { startMs, endMs, live },
    untimed,
    other: available && Number.isInteger(timeline.otherEvents) ? timeline.otherEvents : 0,
    list,
    degraded: rail.degraded,
    available,
    rail,
  };
}

/**
 * The smallest tick step that gives at most `floor(trackPx / 96)` ticks over `spanMs`; the largest step when none does.
 * @param {number} spanMs
 * @param {number} trackPx
 */
function tickStep(spanMs, trackPx) {
  const most = Math.max(1, Math.floor(trackPx / TICK_PX));
  for (const step of TICK_STEPS) if (Math.floor(Math.max(0, spanMs) / step) <= most) return step;
  return TICK_STEPS[TICK_STEPS.length - 1];
}

/**
 * The drawn axis (E.2 section 9.3): a live run ends at now plus 10 % of its span, rounded up to a whole step; a finished
 * run ends at its last event; a span of 0 is 1 s.
 * @param {{ startMs: number, endMs: number, live: boolean }} domain
 * @param {number} nowMs
 * @param {number} trackPx
 * @returns {{ startMs: number, endMs: number, step: number, live: boolean }}
 */
function axisDomain(domain, nowMs, trackPx) {
  const { startMs, live } = domain;
  const spanMs = Math.max(0, (live ? Math.max(nowMs, domain.endMs) : domain.endMs) - startMs);
  if (!live) {
    const span = spanMs === 0 ? SECOND : spanMs;
    return { startMs, endMs: startMs + span, step: tickStep(span, trackPx), live };
  }
  const grown = Math.max(SECOND, spanMs * 1.1);
  const step = tickStep(grown, trackPx);
  return { startMs, endMs: startMs + Math.ceil(grown / step) * step, step, live };
}

/**
 * A time as a fraction of the axis: 0 to 1, four decimals, clamped.
 * @param {{ startMs: number, endMs: number }} domain
 * @param {number} ms
 */
function position(domain, ms) {
  const span = domain.endMs - domain.startMs;
  if (!(span > 0)) return 0;
  return Math.round(Math.min(1, Math.max(0, (ms - domain.startMs) / span)) * 10000) / 10000;
}

/**
 * The tick marks: whole steps on the local clock inside the axis. The label is `HH:MM:SS` under 1 min, `HH:MM` under
 * 1 d, "24 Oct" from 1 d, and a tick on a local midnight always reads as its date.
 * @param {{ startMs: number, endMs: number, step: number }} domain
 * @returns {Array<{ atMs: number, fraction: number, label: string }>}
 */
function tickMarks(domain) {
  const { startMs, endMs, step } = domain;
  /** @type {Array<{ atMs: number, fraction: number, label: string }>} */
  const marks = [];
  const origin = new Date(startMs);
  const base = new Date(origin.getFullYear(), origin.getMonth(), origin.getDate());
  const first = step >= DAY ? 1 : Math.floor((startMs - base.getTime()) / step) + 1;
  for (let k = first; k < first + 10_000; k += 1) {
    const at = step >= DAY ? new Date(base.getFullYear(), base.getMonth(), base.getDate() + k * Math.round(step / DAY)).getTime() : base.getTime() + k * step;
    if (at <= startMs) continue;
    if (at > endMs) break;
    const date = new Date(at);
    const midnight = date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0;
    const label = midnight || step >= DAY ? `${date.getDate()} ${MONTHS[date.getMonth()]}`
      : step < MINUTE ? `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}` : `${two(date.getHours())}:${two(date.getMinutes())}`;
    marks.push({ atMs: at, fraction: position(domain, at), label });
  }
  return marks;
}

/**
 * Markers of one node that are less than 6 px apart on the track merge into the first of them.
 * @param {Array<{ atMs: number, nodeId: string | null }>} markers
 * @param {{ startMs: number, endMs: number }} domain
 * @param {number} trackPx
 */
function mergeMarkers(markers, domain, trackPx) {
  const span = domain.endMs - domain.startMs;
  if (!(span > 0) || !(trackPx > 0)) return [...markers].sort((a, b) => a.atMs - b.atMs);
  /** @type {Map<string | null, number>} */
  const lastKept = new Map();
  /** @type {Array<{ atMs: number, nodeId: string | null }>} */
  const kept = [];
  for (const marker of [...markers].sort((a, b) => a.atMs - b.atMs)) {
    const last = lastKept.get(marker.nodeId);
    if (last !== undefined && ((marker.atMs - last) / span) * trackPx < MERGE_PX) continue;
    lastKept.set(marker.nodeId, marker.atMs);
    kept.push(marker);
  }
  return kept;
}

/**
 * The words in a row's duration column and in the accessible copy of the chart (E.2 sections 9.2 and 14.3).
 * With `stale` no figure grows: a live row reads "since HH:MM".
 * @param {any} entry a row of `deriveTimeline`
 * @param {{ nowMs: number, stale: boolean, staleRun: boolean }} context
 * @returns {{ dur: string, copy: string }}
 */
function rowCopy(entry, { nowMs, stale, staleRun }) {
  const { node, segments } = entry;
  const stamp = (/** @type {number} */ ms) => sinceStamp(ms, nowMs);
  const isGate = node.type === 'gate';
  const head = `${node.id}. ${kindWord(node)}. ${stateWord(node)}.`;
  const live = segments.find((/** @type {any} */ s) => s.kind === 'live');
  if (node.state === 'pending') return { dur: 'not started', copy: `${head} Not started.` };
  if (node.state === 'not-reached') return { dur: 'not reached', copy: `${head} Not reached.` };
  if (node.state === 'skipped') {
    const skip = segments.find((/** @type {any} */ s) => s.kind === 'skip');
    return { dur: 'skipped', copy: skip ? `${head} Skipped at ${clockHM(skip.toMs)}.` : `${head} Skipped.` };
  }
  if (live) {
    if (staleRun) return { dur: `no update since ${stamp(live.fromMs)}`, copy: `${head} No update since ${stamp(live.fromMs)}.` };
    if (stale) return { dur: `since ${stamp(live.fromMs)}`, copy: `${head} ${isGate ? 'Waiting' : 'Running'} since ${stamp(live.fromMs)}.` };
    const so = liveDuration(Math.max(0, nowMs - live.fromMs));
    return { dur: isGate ? `waiting ${so}` : `${so} so far`, copy: isGate ? `${head} Waiting since ${stamp(live.fromMs)}, ${so}.` : `${head} From ${stamp(live.fromMs)}, ${so} so far.` };
  }
  const done = segments.filter((/** @type {any} */ s) => s.kind === 'stage' || s.kind === 'wait');
  const last = done[done.length - 1];
  if (!last) return { dur: 'time not recorded', copy: `${head} Time not recorded.` };
  const length = formatDuration(last.toMs - last.fromMs) ?? 'time not recorded';
  const imported = node.synthetic === true ? ', imported' : '';
  if (isGate) {
    const tail = node.state === 'rejected' ? ', rejected' : node.forced ? ', forced' : '';
    return { dur: `waited ${length}${tail}`, copy: `${head} Waited ${length}, from ${stamp(last.fromMs)} to ${stamp(last.toMs)}.` };
  }
  return { dur: `${length}${imported}`, copy: `${head} From ${stamp(last.fromMs)} to ${stamp(last.toMs)}, ${length}.` };
}

export { TICK_STEPS, deriveTimeline, tickStep, axisDomain, position, tickMarks, mergeMarkers, rowCopy };
