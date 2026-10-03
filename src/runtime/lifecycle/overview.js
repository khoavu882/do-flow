'use strict';

/**
 * `lifecycle --action overview | init | status` (IC-007, IC-008, IC-021): the project's open
 * follow-ups, intents, goals and feature statuses, and the writes that tie a new feature to them.
 * Each function returns a result object without printing. The overview is read-only: it creates no
 * folder and writes no file.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { isSafeSlug, invalidSlugRefusal } = require('../task-scope');
const { withDerivedDone } = require('./fold');
const { appendEvents, readFold } = require('./event-store');
const { deriveStatuses, bucketize, behindNote } = require('./status');
const { FollowupUsageError, parseIds } = require('./followup');

/** The failure store, or null when its module cannot be loaded: the overview then reports no failures. */
function failureStoreOrNull() {
  try { return require('../failure/store'); } catch { return null; }
}

const DISCOVERY_SHOWN = 15;
const MAINTAIN_SHOWN = 50;

const refusal = (action, finding, message) => ({ ok: false, action, finding, message });

function statusMap(derived) {
  return Object.fromEntries(Object.entries(derived.statuses).map(([slug, entry]) => [slug, entry.status]));
}

/** The new and regressed failure entries inside the DoFlow repository, else null. */
function failureEntries(root) {
  const failureStore = failureStoreOrNull();
  if (failureStore === null || !failureStore.isDoflowRepo(root)) return null;
  return failureStore.loadEntries().entries.filter((e) => failureStore.SHOWN_BY_DEFAULT.has(e.status)).map(failureStore.listedEntry);
}

/** Reports first, then the oldest first; the id keeps equal instants in a stable order. */
function byDiscoveryOrder(a, b) {
  const report = (b.source.kind === 'report') - (a.source.kind === 'report');
  if (report !== 0) return report;
  const delta = Date.parse(a.history[0].at) - Date.parse(b.history[0].at);
  return delta !== 0 ? delta : (a.id < b.id ? -1 : 1);
}

function shownItem(item, pending) {
  const shown = {
    id: item.id, statement: item.statement, source: item.source, state: item.state,
    promoted: Boolean(item.intent), intent: item.intent, added: item.added,
  };
  if (pending !== undefined) shown.pending = pending;
  return shown;
}

/** Progress, linked features by status and the nudges of one open goal (IC-022). */
function goalView(goal, features, statuses) {
  const linked = features.filter((f) => f.goal === goal.goal).map((f) => f.slug);
  const buckets = bucketize(Object.fromEntries(linked.map((slug) => [slug, statuses.statuses[slug] || { status: 'unknown' }])), linked);
  const met = goal.items.filter((i) => i.met).length;
  const nudges = [];
  if (buckets.finished.length) {
    const who = buckets.finished.length === 1 ? `linked feature ${buckets.finished[0]} is finished` : `linked features ${buckets.finished.join(', ')} are finished`;
    for (const item of goal.items.filter((i) => !i.met)) nudges.push(`${item.id} is unchecked and ${who}`);
  }
  return {
    goal: goal.goal, outcome: goal.outcome,
    items: { met, total: goal.items.length },
    proposeDone: goal.items.length > 0 && met === goal.items.length,
    features: buckets,
    nudges,
  };
}

function nextLines({ shown, open, items, intents, goals, maintain, pendingItems, failures }) {
  const next = [];
  if (shown < open) next.push('List the rest: doflow-run followup --action list');
  if (items.length) next.push(`Take items into the new feature when its folder exists: doflow-run lifecycle --action init --slug <slug> --take ${items[0].id}`);
  if (intents.length) {
    next.push(`Start from a promoted intent: /do-brainstorm --intent ${intents[0].path}, then doflow-run lifecycle --action init --slug <slug> --intent ${intents[0].path}`);
  }
  if (goals.length) next.push(`Link the new feature to a goal: add --goal ${goals[0].goal} to the init line`);
  if (maintain && pendingItems.length) {
    const id = pendingItems[0].id;
    const unpromoted = pendingItems.find((i) => !i.promoted);
    next.push(
      `Keep open: doflow-run followup --action settle --ids ${id} --as kept --reason "<why it stays>" --channel question`,
      `Dismiss: doflow-run followup --action settle --ids ${id} --as dismissed --reason "<why>" --channel question`,
      ...(unpromoted ? [`Promote to a new intent: doflow-run followup --action promote --ids ${unpromoted.id} --title "<intent title>" --channel question`] : []),
      `Start a fix: doflow-run followup --action settle --ids ${id} --as fix --reason "<where it is routed>" --channel question`,
      `Done outside a feature: doflow-run followup --action settle --ids ${id} --as done --evidence "<what shows it>" --channel question`,
    );
  }
  if (failures && failures.length) {
    next.push('Settle a failure entry: doflow-run failure --action settle --fp <fp> --as noise|fixed|imported --reason "<why>"');
  }
  if (maintain) {
    for (const goal of goals.filter((g) => g.proposeDone)) {
      next.push(`Every item of ${goal.goal} is met; ask the user, then: doflow-run goal --action done --goal ${goal.goal} --channel question`);
    }
  }
  return next;
}

/**
 * IC-007.
 * @param {Object} options
 * @param {string} options.root the IC-001 root
 * @param {boolean} [options.maintain] the `/do maintain` view: up to 50 items and `pending`
 * @param {string} [options.since] ISO time; with `maintain`, an open item with no settlement at or after it is pending
 */
function buildOverview({ root, maintain = false, since, now = new Date(), fsImpl = nodeFs }) {
  let sinceMs = null;
  if (since !== undefined && since !== null) {
    sinceMs = Date.parse(since);
    if (!Number.isFinite(sinceMs)) throw new FollowupUsageError(`--since must be an ISO time such as 2026-10-05T09:00:00Z (got '${since}')`);
  }
  const fold = readFold(root, { fsImpl, now });
  const derived = deriveStatuses({ root, fold });
  const followups = withDerivedDone(fold.followups, statusMap(derived));
  const open = followups.filter((item) => item.state === 'open');
  const limit = maintain ? MAINTAIN_SHOWN : DISCOVERY_SHOWN;
  const ordered = [...open].sort(byDiscoveryOrder);
  // A promotion settles an item for the maintain loop as much as a settlement does: it stays open with an intent.
  const settledSince = (item) => item.history.some((h) => (h.type === 'followup.settled' || h.type === 'followup.promoted') && (sinceMs === null || Date.parse(h.at) >= sinceMs));
  const pendingOf = (item) => !settledSince(item);
  const items = ordered.slice(0, limit).map((item) => shownItem(item, maintain ? pendingOf(item) : undefined));

  const intentGroups = new Map();
  for (const item of open.filter((i) => i.intent)) {
    if (!intentGroups.has(item.intent)) intentGroups.set(item.intent, []);
    intentGroups.get(item.intent).push(item.id);
  }
  const intents = [...intentGroups].map(([intentPath, ids]) => ({ path: intentPath, items: ids }));
  const goals = fold.goals.filter((g) => g.status === 'open').map((g) => goalView(g, fold.features, derived));

  const result = {
    ok: true,
    mode: maintain ? 'maintain' : 'discovery',
    releaseMode: derived.releaseMode,
    integrationRef: derived.integrationRef,
    followups: { open: open.length, shown: items.length, items },
    intents,
    goals,
    features: derived.features,
    conflicts: fold.conflicts,
    unreadable: fold.unreadable,
    // Failure entries come from the machine-wide failure store, which only the DoFlow repository's own
    // maintain view reads (IC-023); nothing in the project store feeds it. Read-only: the overview
    // never rotates the failure files, which is the `failure` verb's step.
    failures: maintain ? failureEntries(root) : null,
  };
  if (derived.reason) result.reason = derived.reason;
  if (derived.integrationBehind > 0) Object.assign(result, { integrationBehind: derived.integrationBehind, note: behindNote(derived.integrationRef, derived.integrationBehind) });
  if (maintain) result.pending = open.filter(pendingOf).length;
  result.next = nextLines({ shown: items.length, open: open.length, items, intents, goals, maintain, pendingItems: items.filter((i) => i.pending), failures: result.failures });
  return result;
}

// ── init ───────────────────────────────────────────────────────────────────────────────────────

/**
 * IC-008: tracks a feature, optionally taking items and linking a goal, in one all-or-nothing write.
 * The feature folder is looked for under the IC-001 root itself, never in the current worktree, so a
 * folder that exists only in a linked worktree is refused.
 */
function initFeature({ root, slug, take, intent, goal, now = new Date(), fsImpl = nodeFs }) {
  if (!slug) throw new FollowupUsageError('--slug is required for --action init');
  const bad = invalidSlugRefusal(slug);
  if (bad) throw new FollowupUsageError(bad.message);
  const folder = path.join(root, 'agent-docs', 'doflow', slug);
  let isFolder = false;
  try { isFolder = fsImpl.statSync(folder).isDirectory(); } catch { /* absent */ }
  if (!isFolder) {
    return refusal('init', 'no-feature-folder', `agent-docs/doflow/${slug} does not exist under the store root ${root}; a folder that exists only in a linked worktree does not count. Nothing was written.`);
  }
  const wanted = take === undefined || take === null ? [] : parseIds(take, '--take');
  const fold = readFold(root, { fsImpl, now });
  const tracked = fold.features.find((f) => f.slug === slug);
  const ids = [...wanted];
  if (intent) {
    for (const item of fold.followups) if (item.state === 'open' && item.intent === intent && !ids.includes(item.id)) ids.push(item.id);
  }
  const drafts = [];
  if (!tracked) drafts.push({ type: 'feature.tracked', by: 'agent', data: { slug } });
  if (ids.length) drafts.push({ type: 'followup.taken', by: 'agent', data: { ids, feature: slug } });
  if (goal) {
    const current = tracked && tracked.goal;
    if (current && current !== goal) return refusal('init', 'goal-already-linked', `${slug} already serves ${current}; link it with --replace through the goal verb instead. Nothing was written.`);
    if (current !== goal) drafts.push({ type: 'goal.linked', by: 'agent', data: { goal, slug, replace: false } });
  }
  const next = [];
  if (intent && ids.length === 0) next.push(`No open follow-up names ${intent}; nothing was taken from it`);
  let events = [];
  if (drafts.length) {
    const out = appendEvents(root, drafts, { now, fsImpl });
    if (!out.ok) {
      const code = out.conflict && ['unknown-id', 'untracked-feature', 'goal-already-linked', 'unknown-goal'].includes(out.conflict.code) ? out.conflict.code : out.finding;
      return refusal('init', code, out.message);
    }
    events = out.written.map((w) => w.file);
  }
  return { ok: true, action: 'init', slug, tracked: tracked ? 'already' : 'new', taken: ids, goal: goal || (tracked && tracked.goal) || null, events, next };
}

// ── status ─────────────────────────────────────────────────────────────────────────────────────

/** IC-021 `status`: the derived status of one tracked feature. */
function featureStatus({ root, slug, now = new Date(), fsImpl = nodeFs }) {
  if (!slug) throw new FollowupUsageError('--slug is required for --action status');
  if (!isSafeSlug(slug)) throw new FollowupUsageError(invalidSlugRefusal(slug).message);
  const fold = readFold(root, { fsImpl, now });
  if (!fold.features.some((f) => f.slug === slug)) {
    return refusal('status', 'untracked-feature', `${slug} is not a tracked feature, so no status is derived for it; run doflow-run lifecycle --action init --slug ${slug} first.`);
  }
  const derived = deriveStatuses({ root, fold });
  const entry = derived.statuses[slug];
  const result = {
    ok: true, action: 'status', slug, status: entry.status, integrationRef: derived.integrationRef,
    evidence: entry.evidence, release: entry.release,
    takenItems: fold.followups.filter((item) => item.takenBy === slug && item.state === 'taken').map((item) => item.id),
  };
  if (derived.reason) result.reason = derived.reason;
  if (derived.integrationBehind > 0) Object.assign(result, { integrationBehind: derived.integrationBehind, note: behindNote(derived.integrationRef, derived.integrationBehind) });
  return result;
}

module.exports = { buildOverview, initFeature, featureStatus, DISCOVERY_SHOWN, MAINTAIN_SHOWN };
