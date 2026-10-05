'use strict';

/**
 * The fold (IC-003, IC-004): every lifecycle event file, ordered by `at` then `id`, reduced to the
 * follow-ups, tracked features, goals and release records they describe. The function is pure: no
 * file or git access, so two clones holding the same files produce the same result, and a writer
 * can test one more event against the state it would join (`applyEvent`) before anything is
 * written. A transition that is illegal at its place in the order is not applied and is listed in
 * `conflicts` as `{event, type, reason}`; `code` is the same finding as a word for the callers that
 * must refuse a write with it.
 *
 * "A taken item whose feature finished is done" is NOT decided here: it needs git (IC-021), so the
 * fold leaves such an item `taken` and `withDerivedDone` applies the derived statuses on read.
 */

const SETTLE_AS = ['kept', 'dismissed', 'fix', 'done'];

function byOrder(a, b) {
  const delta = Date.parse(a.at) - Date.parse(b.at);
  if (delta !== 0) return delta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function isText(value) { return typeof value === 'string' && value.trim() !== ''; }
function isIdList(value) { return Array.isArray(value) && value.length > 0 && value.every(isText); }

/** DEC-045: an event dated further ahead than this stays out of the fold and is listed as a conflict. */
const FUTURE_LIMIT_MS = 24 * 60 * 60 * 1000;

function newState({ now = new Date() } = {}) {
  return {
    cutoff: now.getTime() + FUTURE_LIMIT_MS,
    items: new Map(),
    final: new Set(),
    tracked: new Map(),
    merged: new Map(),
    goals: new Map(),
    releases: new Map(),
    conflicts: [],
    newestAt: null,
  };
}

function conflict(event, code, reason) {
  return { event: event.id, type: event.type, reason, code };
}

function touch(item, event) {
  item.history.push({ event: event.id, type: event.type, at: event.at, by: event.by });
}

function itemFor(state, event, id) {
  const item = state.items.get(id);
  if (!item) return { problem: conflict(event, 'unknown-id', `${id} is not a follow-up`) };
  if (state.final.has(id)) return { problem: conflict(event, 'illegal-transition', `${id} is done and accepts no later event`) };
  return { item };
}

// ── follow-ups ─────────────────────────────────────────────────────────────────────────────────

function applyAdded(state, event) {
  const d = event.data;
  if (!isText(d.id) || !isText(d.statement) || !d.source || typeof d.source !== 'object' || !isText(d.source.kind)) {
    return [conflict(event, 'malformed', 'followup.added needs id, statement and source.kind')];
  }
  if (state.items.has(d.id)) return [conflict(event, 'illegal-transition', `${d.id} was already added`)];
  const item = {
    id: d.id,
    statement: d.statement,
    source: d.source,
    state: 'open',
    takenBy: null,
    intent: null,
    fix: null,
    added: event.at.slice(0, 10),
    excerpt: typeof d.excerpt === 'string' ? d.excerpt : null,
    body: null,
    history: [],
  };
  if (d.source.kind === 'report') {
    item.bodyRef = typeof d.bodyRef === 'string' ? d.bodyRef : null;
    item.bodyBytes = Number.isInteger(d.bodyBytes) ? d.bodyBytes : null;
  }
  touch(item, event);
  state.items.set(d.id, item);
  return [];
}

function applyTaken(state, event) {
  const d = event.data;
  if (!isIdList(d.ids) || !isText(d.feature)) return [conflict(event, 'malformed', 'followup.taken needs ids and feature')];
  const problems = [];
  for (const id of d.ids) {
    const { item, problem } = itemFor(state, event, id);
    if (problem) { problems.push(problem); continue; }
    if (item.state !== 'open') { problems.push(conflict(event, 'illegal-transition', `${id} is ${item.state}; only an open item can be taken`)); continue; }
    if (!state.tracked.has(d.feature)) { problems.push(conflict(event, 'untracked-feature', `${d.feature} is not a tracked feature`)); continue; }
    item.state = 'taken';
    item.takenBy = d.feature;
    touch(item, event);
  }
  return problems;
}

function settleOne(state, event, id) {
  const d = event.data;
  const { item, problem } = itemFor(state, event, id);
  if (problem) return problem;
  const refuse = (reason) => conflict(event, 'illegal-transition', reason);
  switch (d.as) {
    case 'kept':
      // IC-003: a reason is required when a taken item is released or a dismissed one reopens, not for an open one.
      if (item.state !== 'open' && !isText(d.reason)) return conflict(event, 'reason-required', `settling ${id} as kept needs a reason`);
      if (item.state === 'taken') item.takenBy = null;
      item.state = 'open';
      break;
    case 'dismissed':
      if (item.state !== 'open') return refuse(`${id} is ${item.state}; only an open item can be dismissed`);
      if (!isText(d.reason)) return conflict(event, 'reason-required', `dismissing ${id} needs a reason`);
      item.state = 'dismissed';
      break;
    case 'fix':
      if (item.state !== 'open') return refuse(`${id} is ${item.state}; only an open item can be routed to a fix`);
      if (!isText(d.reason)) return conflict(event, 'reason-required', `routing ${id} to a fix needs a reason naming where`);
      item.fix = d.reason;
      break;
    case 'done':
      if (item.state !== 'open') return refuse(`${id} is ${item.state}; only an open item can be settled as done`);
      if (!isText(d.evidence)) return conflict(event, 'evidence-required', `settling ${id} as done needs evidence`);
      item.state = 'done';
      state.final.add(id);
      break;
    default:
      return conflict(event, 'malformed', `followup.settled needs as to be one of ${SETTLE_AS.join(', ')}`);
  }
  touch(item, event);
  return null;
}

function applySettled(state, event) {
  const d = event.data;
  // The legacy single-id shape (`id`) and the batch shape (`ids`) both fold; the verb writes one event per id.
  const ids = isText(d.id) ? [d.id] : d.ids;
  if (!isIdList(ids)) return [conflict(event, 'malformed', 'followup.settled needs an id')];
  return ids.map((id) => settleOne(state, event, id)).filter(Boolean);
}

function applyPromoted(state, event) {
  const d = event.data;
  if (!isIdList(d.ids) || !isText(d.intent)) return [conflict(event, 'malformed', 'followup.promoted needs ids and intent')];
  const problems = [];
  for (const id of d.ids) {
    const { item, problem } = itemFor(state, event, id);
    if (problem) { problems.push(problem); continue; }
    if (item.state !== 'open') { problems.push(conflict(event, 'illegal-transition', `${id} is ${item.state}; only an open item can be promoted`)); continue; }
    if (item.intent) { problems.push(conflict(event, 'intent-exists', `${id} was already promoted to ${item.intent}`)); continue; }
    item.intent = d.intent;
    touch(item, event);
  }
  return problems;
}

// ── features, goals, releases ──────────────────────────────────────────────────────────────────

function applyTracked(state, event) {
  const slug = event.data.slug;
  if (!isText(slug)) return [conflict(event, 'malformed', 'feature.tracked needs a slug')];
  // The earliest event counts; a later one from another clone changes nothing and is no conflict.
  if (!state.tracked.has(slug)) state.tracked.set(slug, { slug, trackedAt: event.at, goal: null });
  return [];
}

function applyMerged(state, event) {
  const { slug, reason } = event.data;
  if (!isText(slug)) return [conflict(event, 'malformed', 'feature.merged needs a slug')];
  if (!state.merged.has(slug)) state.merged.set(slug, { slug, reason: typeof reason === 'string' ? reason : '', at: event.at });
  return [];
}

function goalFor(state, event, id) {
  const goal = state.goals.get(id);
  return goal ? { goal } : { problem: conflict(event, 'unknown-goal', `${id} is not a goal`) };
}

function applyGoalAdded(state, event) {
  const d = event.data;
  if (!isText(d.goal) || !Array.isArray(d.items)) return [conflict(event, 'malformed', 'goal.added needs goal and items')];
  // A second `goal.added` for one id, as another clone may write, loses: the first wins.
  if (state.goals.has(d.goal)) return [conflict(event, 'goal-exists', `${d.goal} already exists`)];
  state.goals.set(d.goal, {
    goal: d.goal,
    outcome: typeof d.outcome === 'string' ? d.outcome : '',
    status: 'open',
    reason: null,
    added: event.at.slice(0, 10),
    items: d.items.filter((i) => i && isText(i.id)).map((i) => ({ id: i.id, text: String(i.text ?? ''), met: false, evidence: null })),
  });
  return [];
}

function applyGoalItemAdded(state, event) {
  const d = event.data;
  const { goal, problem } = goalFor(state, event, d.goal);
  if (problem) return [problem];
  if (!d.item || !isText(d.item.id)) return [conflict(event, 'malformed', 'goal.item-added needs item.id')];
  if (goal.items.some((i) => i.id === d.item.id)) return [conflict(event, 'illegal-transition', `${d.goal} already has item ${d.item.id}`)];
  goal.items.push({ id: d.item.id, text: String(d.item.text ?? ''), met: false, evidence: null });
  return [];
}

function applyGoalChecked(state, event) {
  const d = event.data;
  const { goal, problem } = goalFor(state, event, d.goal);
  if (problem) return [problem];
  const item = goal.items.find((i) => i.id === d.item);
  if (!item) return [conflict(event, 'unknown-item', `${d.goal} has no item ${d.item}`)];
  if (!isText(d.evidence)) return [conflict(event, 'evidence-required', 'goal.checked needs evidence')];
  item.met = d.met === true;
  item.evidence = d.evidence;
  return [];
}

function applyGoalLinked(state, event) {
  const d = event.data;
  const { problem } = goalFor(state, event, d.goal);
  if (problem) return [problem];
  const feature = state.tracked.get(d.slug);
  if (!feature) return [conflict(event, 'untracked-feature', `${d.slug} is not a tracked feature`)];
  if (feature.goal && feature.goal !== d.goal && d.replace !== true) {
    return [conflict(event, 'goal-already-linked', `${d.slug} already serves ${feature.goal}`)];
  }
  feature.goal = d.goal;
  return [];
}

function applyGoalDone(state, event) {
  const d = event.data;
  const { goal, problem } = goalFor(state, event, d.goal);
  if (problem) return [problem];
  goal.status = 'done';
  goal.reason = typeof d.reason === 'string' && d.reason !== '' ? d.reason : null;
  return [];
}

function applyReleaseRecorded(state, event) {
  const d = event.data;
  if (!isText(d.tag)) return [conflict(event, 'malformed', 'release.recorded needs a tag')];
  let release = state.releases.get(d.tag);
  if (!release) {
    release = { tag: d.tag, commit: null, features: new Map(), excluded: new Set() };
    state.releases.set(d.tag, release);
  }
  if (isText(d.commit)) release.commit = d.commit;
  for (const f of Array.isArray(d.features) ? d.features : []) {
    if (f && isText(f.slug) && !release.features.has(f.slug)) release.features.set(f.slug, { slug: f.slug, evidence: f.evidence ?? null, ref: f.ref ?? null });
  }
  for (const slug of Array.isArray(d.excluded) ? d.excluded : []) if (isText(slug)) release.excluded.add(slug);
  return [];
}

const APPLY = {
  'followup.added': applyAdded,
  'followup.taken': applyTaken,
  'followup.settled': applySettled,
  'followup.promoted': applyPromoted,
  'feature.tracked': applyTracked,
  'feature.merged': applyMerged,
  'goal.added': applyGoalAdded,
  'goal.item-added': applyGoalItemAdded,
  'goal.checked': applyGoalChecked,
  'goal.linked': applyGoalLinked,
  'goal.done': applyGoalDone,
  'release.recorded': applyReleaseRecorded,
};

/** The event types this fold understands; any other type is kept out of the state, not a conflict. */
const EVENT_TYPES = Object.keys(APPLY);

/**
 * Applies one event to a state, recording what is illegal. Callers that write use the returned
 * conflicts to refuse before anything is written.
 * @returns {Array<{event:string,type:string,reason:string,code:string}>} the conflicts this event raised
 */
function applyEvent(state, event, { checkFuture = true } = {}) {
  const at = Date.parse(event.at);
  if (checkFuture && at > state.cutoff) {
    // Left out of the stamping floor and of every tracking bound: one wrong clock must not move them.
    const raised = [conflict(event, 'future-event', 'dated more than 24 hours in the future; left out of the fold')];
    state.conflicts.push(...raised);
    return raised;
  }
  if (state.newestAt === null || at > state.newestAt) state.newestAt = at;
  const apply = APPLY[event.type];
  if (!apply) return [];
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const raised = apply(state, { ...event, data });
  state.conflicts.push(...raised);
  return raised;
}

/** @param {Array<Object>} events IC-002 envelopes, in any order */
function foldInto(events, options = {}) {
  const state = newState(options);
  for (const event of [...events].sort(byOrder)) applyEvent(state, event);
  return state;
}

/** The result of a fold, as plain data. `hasBody(item)` tells a report whose body is on this machine. */
function finalize(state, { hasBody = () => false } = {}) {
  const followups = [...state.items.values()].map((item) => (
    item.source.kind === 'report' ? { ...item, body: hasBody(item) ? 'on-this-machine' : 'not-on-this-machine' } : item));
  const releases = [...state.releases.values()].map((r) => {
    const excluded = [...r.excluded];
    return { tag: r.tag, commit: r.commit, features: [...r.features.values()].filter((f) => !r.excluded.has(f.slug)), excluded };
  });
  return {
    followups,
    features: [...state.tracked.values()].map((f) => ({ ...f })),
    merged: [...state.merged.values()],
    goals: [...state.goals.values()],
    releases,
    conflicts: state.conflicts,
    newestAt: state.newestAt === null ? null : new Date(state.newestAt).toISOString(),
  };
}

/** @returns {ReturnType<typeof finalize>} */
function foldEvents(events, options = {}) {
  return finalize(foldInto(events, options), options);
}

/**
 * A taken item whose feature derives `finished` (IC-021) shows as `done`. Derived on read and never
 * written: a later read that derives anything else shows the item as `taken` again (design R9).
 * @param {Array<Object>} followups folded items
 * @param {Object<string,string>|Map<string,string>} statuses feature slug to derived status
 */
function withDerivedDone(followups, statuses) {
  const statusOf = (slug) => (statuses instanceof Map ? statuses.get(slug) : statuses[slug]);
  return followups.map((item) => (
    item.state === 'taken' && statusOf(item.takenBy) === 'finished' ? { ...item, state: 'done', derived: true } : item));
}

module.exports = { foldEvents, foldInto, finalize, applyEvent, newState, withDerivedDone, byOrder, EVENT_TYPES, SETTLE_AS };
