'use strict';

/**
 * The goal service (IC-022, FR-013, FR-014): add, item, check, link, list and done, over the
 * lifecycle event store. A goal is DoFlow's own record of one outcome and its checklist, independent
 * of any harness command that shares the name (NFR-004). Every function takes the IC-001 root, writes
 * only events and returns a result object without printing, as the follow-up service does.
 *
 *   - A refusal is returned `{ok:false, action, finding, message}` and never thrown (exit 1).
 *   - A caller mistake throws `FollowupUsageError` (exit 2), before anything is written.
 *   - Every free-text field is masked, one line and bounded (`oneLine`), before it is stored.
 *   - Progress is computed here from the fold and the derived feature statuses, never written, so it
 *     is the same on every harness and costs no model tokens (NFR-006).
 */

const nodeFs = require('node:fs');
const { isSafeSlug, invalidSlugRefusal } = require('../task-scope');
const { appendEvents, readFold } = require('./event-store');
const { deriveStatuses } = require('./status');
const { FollowupUsageError, oneLine, channelBy } = require('./followup');
const { goalView, goalConflicts, goalConflictNext } = require('./overview');

const GOAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GOAL_ID_MAX = 40;
const ITEM_ID = /^C[1-9][0-9]{0,5}$/;
/** Items one `goal.added` may carry: a checklist this long is a plan, not a goal. */
const ITEMS_MAX = 100;
/** Channels that name the user (DEC-004); `default` is the agent. */
const USER_CHANNELS = ['question', 'gate', 'prompt'];
/** Fold conflicts that are a refusal under their own name; any other conflict is an `illegal-transition`. */
const CONFLICT_FINDINGS = new Set(['goal-exists', 'unknown-goal', 'unknown-item', 'goal-already-linked', 'untracked-feature', 'evidence-required']);

function refusal(action, finding, message) { return { ok: false, action, finding, message }; }

function refusalFrom(action, failed) {
  const finding = failed.conflict && CONFLICT_FINDINGS.has(failed.conflict.code) ? failed.conflict.code : failed.finding;
  return refusal(action, finding, failed.message);
}

function goalIdOf(raw) {
  if (raw === undefined || raw === null || raw === '') throw new FollowupUsageError('--goal is required: a kebab-case goal id of at most 40 characters');
  const id = String(raw);
  if (id.length > GOAL_ID_MAX || !GOAL_ID.test(id)) {
    throw new FollowupUsageError(`--goal must be kebab-case (lowercase letters and digits joined by single dashes) and at most ${GOAL_ID_MAX} characters`);
  }
  return id;
}

function itemIdOf(raw) {
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  if (list.length !== 1) throw new FollowupUsageError('--item takes exactly one checklist id such as C3 for --action check');
  if (!ITEM_ID.test(String(list[0]))) throw new FollowupUsageError(`--item must be a checklist id such as C3 (got '${String(list[0]).slice(0, 40)}')`);
  return String(list[0]);
}

/** One masked, one-line, bounded text; a problem is a usage error naming the flag. */
function textOf(raw, label) {
  const problems = [];
  const text = raw === undefined ? null : oneLine(raw, label, problems);
  if (problems.length) throw new FollowupUsageError(problems.join('; '));
  return text;
}

function requiredText(raw, label) {
  if (raw === undefined || raw === null) throw new FollowupUsageError(`${label} is required`);
  return textOf(raw, label);
}

function unknownGoal(action, fold, id) {
  const known = fold.goals.map((g) => g.goal);
  return refusal(action, 'unknown-goal', `${id} is not a goal${known.length ? `; the goals are ${known.join(', ')}` : '; none has been added'}. Nothing was written.`);
}

/** The next free `C<n>`: one past the largest number in use, so an id is never reused. */
function nextItemId(goal) {
  let top = 0;
  for (const item of goal.items) {
    const m = /^C(\d+)$/.exec(item.id);
    if (m) top = Math.max(top, Number(m[1]));
  }
  return `C${top + 1}`;
}

const progressOf = (goal) => ({ met: goal.items.filter((i) => i.met).length, total: goal.items.length });

function checkLine(goalId, item) {
  return `Record a met item with evidence: doflow-run goal --action check --goal ${goalId} --item ${item} --evidence "<what shows it>"`;
}

function doneLine(goalId) {
  return `Every item of ${goalId} is met; ask the user, then: doflow-run goal --action done --goal ${goalId} --channel question`;
}

// ── add, item ──────────────────────────────────────────────────────────────────────────────────

/** IC-022 `add`: one `goal.added` event with the outcome and the checklist, ids `C1`, `C2`, ... */
function addGoal({ root, goal, statement, items, channel, now = new Date(), fsImpl = nodeFs }) {
  const id = goalIdOf(goal);
  const outcome = requiredText(statement, '--statement');
  const list = Array.isArray(items) ? items : items === undefined ? [] : [items];
  if (list.length === 0) throw new FollowupUsageError('--item is required for --action add: at least one checklist item (repeat --item for more)');
  if (list.length > ITEMS_MAX) throw new FollowupUsageError(`--item was given ${list.length} times; a goal starts with at most ${ITEMS_MAX} items`);
  const problems = [];
  const checklist = list.map((raw, index) => ({ id: `C${index + 1}`, text: oneLine(raw, `--item ${index + 1}`, problems) }));
  if (problems.length) throw new FollowupUsageError(problems.join('; '));
  const by = channelBy(channel);
  if (readFold(root, { fsImpl, now }).goals.some((g) => g.goal === id)) return refusal('add', 'goal-exists', `${id} already exists. Nothing was written.`);
  const out = appendEvents(root, [{ type: 'goal.added', by, data: { goal: id, outcome, items: checklist } }], { now, fsImpl });
  if (!out.ok) return refusalFrom('add', out);
  return {
    ok: true, action: 'add', goal: id, outcome, items: checklist, events: out.written.map((w) => w.file),
    next: [`Link a feature that serves it: doflow-run goal --action link --goal ${id} --slug <slug>`, checkLine(id, 'C1')],
  };
}

/** IC-022 `item`: one `goal.item-added` event; the id is the next free `C<n>`. */
function addItem({ root, goal, text, channel, now = new Date(), fsImpl = nodeFs }) {
  const id = goalIdOf(goal);
  const itemText = requiredText(text, '--text');
  const by = channelBy(channel);
  // The id is chosen before the lock, so a writer that took it first makes this call refuse; a retry picks the next one.
  for (let attempt = 0; ; attempt += 1) {
    const fold = readFold(root, { fsImpl, now });
    const found = fold.goals.find((g) => g.goal === id);
    if (!found) return unknownGoal('item', fold, id);
    const item = { id: nextItemId(found), text: itemText };
    const out = appendEvents(root, [{ type: 'goal.item-added', by, data: { goal: id, item } }], { now, fsImpl });
    if (out.ok) return { ok: true, action: 'item', goal: id, item, events: out.written.map((w) => w.file), next: [checkLine(id, item.id)] };
    const raced = out.conflict && out.conflict.code === 'illegal-transition' && /already has item/.test(out.conflict.reason);
    if (!raced || attempt >= 4) return refusalFrom('item', out);
  }
}

// ── check, link ────────────────────────────────────────────────────────────────────────────────

/** IC-022 `check`: `goal.checked` with `met: true`, or `met: false` under `--unmet`; evidence either way (DEC-015). */
function checkItem({ root, goal, item, evidence, unmet = false, channel, now = new Date(), fsImpl = nodeFs }) {
  const id = goalIdOf(goal);
  const itemId = itemIdOf(item);
  const proof = requiredText(evidence, '--evidence');
  const by = channelBy(channel);
  const before = readFold(root, { fsImpl, now });
  const found = before.goals.find((g) => g.goal === id);
  if (!found) return unknownGoal('check', before, id);
  if (!found.items.some((i) => i.id === itemId)) {
    return refusal('check', 'unknown-item', `${id} has no item ${itemId}; its items are ${found.items.map((i) => i.id).join(', ')}. Nothing was written.`);
  }
  const met = !unmet;
  const out = appendEvents(root, [{ type: 'goal.checked', by, data: { goal: id, item: itemId, met, evidence: proof } }], { now, fsImpl });
  if (!out.ok) return refusalFrom('check', out);
  const after = readFold(root, { fsImpl, now }).goals.find((g) => g.goal === id) || found;
  const progress = progressOf(after);
  const proposeDone = after.status === 'open' && progress.total > 0 && progress.met === progress.total;
  const unchecked = after.items.find((i) => !i.met);
  return {
    ok: true, action: 'check', goal: id, item: itemId, met, evidence: proof, progress, proposeDone, events: out.written.map((w) => w.file),
    next: proposeDone ? [doneLine(id)] : unchecked && after.status === 'open' ? [checkLine(id, unchecked.id)] : [],
  };
}

/** IC-022 `link`: one `goal.linked` event; a feature serves one goal at most (DEC-009). */
function linkFeature({ root, goal, slug, replace = false, channel, now = new Date(), fsImpl = nodeFs }) {
  const id = goalIdOf(goal);
  if (!slug) throw new FollowupUsageError('--slug is required for --action link');
  if (!isSafeSlug(slug)) throw new FollowupUsageError(invalidSlugRefusal(slug).message);
  const by = channelBy(channel);
  const fold = readFold(root, { fsImpl, now });
  if (!fold.goals.some((g) => g.goal === id)) return unknownGoal('link', fold, id);
  const feature = fold.features.find((f) => f.slug === slug);
  if (!feature) return refusal('link', 'untracked-feature', `${slug} is not a tracked feature, so no goal can link it; run doflow-run lifecycle --action init --slug ${slug} first. Nothing was written.`);
  if (feature.goal === id) return { ok: true, action: 'link', goal: id, slug, linked: 'already', replaced: null, events: [], next: [] };
  if (feature.goal && !replace) {
    return refusal('link', 'goal-already-linked', `${slug} already serves ${feature.goal}; a feature serves one goal at most. Pass --replace to move it to ${id}. Nothing was written.`);
  }
  const out = appendEvents(root, [{ type: 'goal.linked', by, data: { goal: id, slug, replace: Boolean(replace) } }], { now, fsImpl });
  if (!out.ok) return refusalFrom('link', out);
  return { ok: true, action: 'link', goal: id, slug, linked: 'new', replaced: feature.goal || null, events: out.written.map((w) => w.file), next: [] };
}

// ── list ───────────────────────────────────────────────────────────────────────────────────────

/** IC-022 progress for one goal: items, `progress`, `proposeDone`, linked features by status and the nudges. */
function progressView(goal, fold, statuses, conflicts = []) {
  const view = goalView(goal, fold.features, statuses, conflicts);
  return {
    goal: goal.goal, outcome: goal.outcome, status: goal.status,
    items: goal.items.map((i) => ({ id: i.id, text: i.text, met: i.met, evidence: i.evidence })),
    progress: view.items, proposeDone: view.proposeDone, features: view.features, nudges: view.nudges,
    ...(view.conflicts ? { conflicts: view.conflicts } : {}),
    ...(goal.status === 'done' ? { reason: goal.reason } : {}),
  };
}

/** IC-022 `list`: every goal, or the one named, with its progress. Reads git only when a goal has a linked feature. */
function listGoals({ root, goal, now = new Date(), fsImpl = nodeFs }) {
  const id = goal === undefined ? null : goalIdOf(goal);
  const fold = readFold(root, { fsImpl, now });
  const shown = id === null ? fold.goals : fold.goals.filter((g) => g.goal === id);
  if (id !== null && shown.length === 0) return unknownGoal('list', fold, id);
  const linked = new Set(fold.features.filter((f) => shown.some((g) => g.goal === f.goal)).map((f) => f.slug));
  const statuses = linked.size ? deriveStatuses({ root, fold }) : { statuses: {} };
  const conflictsByGoal = goalConflicts(root, fold, fsImpl);
  const goals = shown.map((g) => progressView(g, fold, statuses, conflictsByGoal.get(g.goal)));
  const next = [];
  for (const g of goals.filter((x) => x.status === 'open')) {
    if (g.proposeDone) next.push(doneLine(g.goal));
    else {
      const unchecked = g.items.find((i) => !i.met);
      if (unchecked) next.push(checkLine(g.goal, unchecked.id));
    }
  }
  for (const g of goals.filter((x) => x.conflicts)) next.push(...goalConflictNext(g.goal, g.conflicts));
  const result = { ok: true, action: 'list', goals, conflicts: fold.conflicts, unreadable: fold.unreadable, unreadableReasons: fold.unreadableReasons, next };
  if (statuses.reason) result.reason = statuses.reason;
  return result;
}

// ── done ───────────────────────────────────────────────────────────────────────────────────────

/**
 * IC-022 `done`: one `goal.done` event. Only the user closes a goal (DEC-004), so `default` is
 * refused; with unmet items it is refused unless `--reason` says why the user closes it anyway.
 */
function doneGoal({ root, goal, reason, channel, now = new Date(), fsImpl = nodeFs }) {
  const id = goalIdOf(goal);
  const why = textOf(reason, '--reason');
  const by = channelBy(channel);
  if (!USER_CHANNELS.includes(channel)) {
    return refusal('done', 'not-user', `only the user marks a goal done: pass --channel question, gate or prompt once the user has said so (got ${channel ? `'${channel}'` : 'no channel'}). Nothing was written.`);
  }
  const fold = readFold(root, { fsImpl, now });
  const found = fold.goals.find((g) => g.goal === id);
  if (!found) return unknownGoal('done', fold, id);
  if (found.status === 'done') return refusal('done', 'already-done', `${id} is already done. Nothing was written.`);
  const unmet = found.items.filter((i) => !i.met).map((i) => i.id);
  if (unmet.length && !why) {
    return refusal('done', 'items-unmet', `${id} has unmet items (${unmet.join(', ')}); check them with evidence, or pass --reason to say why the user closes it anyway. Nothing was written.`);
  }
  const out = appendEvents(root, [{ type: 'goal.done', by, data: { goal: id, reason: why } }], { now, fsImpl });
  if (!out.ok) return refusalFrom('done', out);
  return { ok: true, action: 'done', goal: id, reason: why, unmet, events: out.written.map((w) => w.file), next: [] };
}

module.exports = {
  addGoal, addItem, checkItem, linkFeature, listGoals, doneGoal,
  GOAL_ID_MAX, ITEMS_MAX, USER_CHANNELS,
};
