// What waits for the person on this machine, for the shell's attention strip and the count on the Layers link. A pure function
// of the `machine` member the live store holds and of the stream's state: no DOM, no clock, no fetch.
//
// The honesty rules of the Layers page apply (derive/layers.js): a gate waiting for you is the only waiting DoFlow records, so
// that is all this counts. While nothing can be said the model says so with its reason (`unobserved`); it never reads "nothing
// waiting" from a stream that is down or from an activity section that failed, and a record held after the stream stopped says
// since when it is not observed. `clear` is said only by a followed, readable record that left no project out; one that left
// some out says "at least" (162 review B-1, B-2).

import { machineModel, sectionOf, streamState } from './layers.js';

const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Why the gates are not observed, per stream token (the code of an unreadable section is added by the words). @type {Readonly<Record<string, string>>} */
const UNOBSERVED_REASON = Object.freeze({
  down: 'the stream from the Console is down',
  refused: 'the Console refused this stream',
  unsupported: 'this browser cannot follow a stream',
  'core-lacks-channel': 'the DoFlow core is older than the stream',
  paused: 'updates are paused',
  unreadable: 'the activity of the projects is unreadable',
});

/** The awaiting runs of one activity item: the core's count, never fewer than the gates it listed (it lists at most 8 a project). @param {any} item */
const awaitingOf = (item) => {
  const listed = Array.isArray(item.gates) ? item.gates.length : 0;
  const counted = item.runs && Number.isInteger(item.runs.awaiting) ? item.runs.awaiting : 0;
  return Math.max(listed, counted);
};

/**
 * The attention model.
 *   `quiet`       nothing to say yet: the stream is connecting or paused and no record is held, or the activity has not arrived;
 *   `unobserved`  nothing can be said, with `reason` (a key of UNOBSERVED_REASON) and `code`; `held` is true when a record is held
 *                 but the stream is not followed now (the words then say since when): a held record is never read as clear;
 *   `partial`     the record is followed and counts no awaiting gate, but `missing` names what it did not observe;
 *   `clear`       a followed record of every summarized project holds no awaiting gate, and no project was left out;
 *   `waiting`     `count` awaiting runs (one gate each; the core's `runs.awaiting`, not the gates it lists) in `projects`
 *                 projects. `atLeast` when `missing` is not empty. `place` says where: `here` (all in the project the Console runs
 *                 in, the one the Now page lists), `other` (all in one other project, named by `label`), `several`, or `machine`
 *                 when the project list is unreadable and no project can be named. `target` is the hash that shows them: the run
 *                 when the only gate is here, the project's Layers page when they are all in one other project, else the Layers
 *                 machine page. `held` with `reason` and `code` when the record is not being followed right now.
 * `missing` lists `{ reason, n }`: `not-shown` (n projects past the 16 the core summarizes) and `store-unreadable` (n summarized
 * projects with a store that did not read).
 * @param {{ body: any, transport: { state: string, code: string | null } | null, error: string | null }} input
 */
function attentionModel({ body, transport, error }) {
  const stream = streamState({ transport, errors: [error], hasData: body !== null && body !== undefined });
  const model = machineModel(body);
  const failing = ['down', 'refused', 'unsupported', 'core-lacks-channel'].includes(stream.token);
  if (!model.present) return failing ? { kind: 'unobserved', reason: stream.token, code: stream.code, held: false } : { kind: 'quiet' };
  if (model.activitySection.state === 'unreadable') return { kind: 'unobserved', reason: 'unreadable', code: model.activitySection.code, held: false };
  if (model.activitySection.state !== 'ok') return failing ? { kind: 'unobserved', reason: stream.token, code: stream.code, held: false } : { kind: 'quiet' };
  const held = stream.token !== 'following';
  const activity = sectionOf(body, 'activity').data;
  const items = Array.isArray(activity.items) ? activity.items : [];
  const notShown = activity.limits && Number.isInteger(activity.limits.notShown) ? activity.limits.notShown : 0;
  // Any store of a summarized project that did not read: the count is not said to be whole (162 review B-1).
  const unreadable = items.filter((/** @type {any} */ item) => Array.isArray(item.unreadable) && item.unreadable.length > 0).length;
  const missing = [
    ...(notShown > 0 ? [{ reason: 'not-shown', n: notShown }] : []),
    ...(unreadable > 0 ? [{ reason: 'store-unreadable', n: unreadable }] : []),
  ];
  const waitingItems = items.filter((/** @type {any} */ item) => awaitingOf(item) > 0);
  const count = waitingItems.reduce((/** @type {number} */ sum, /** @type {any} */ item) => sum + awaitingOf(item), 0);
  if (count === 0) {
    if (held) return { kind: 'unobserved', reason: stream.token, code: stream.code, held: true };
    return missing.length > 0 ? { kind: 'partial', missing } : { kind: 'clear' };
  }
  const keys = [...new Set(waitingItems.map((/** @type {any} */ item) => item.projectKey))];
  const listed = model.projectsSection.state === 'ok';
  const current = new Set(model.rows.filter((row) => row.current).map((row) => row.projectKey));
  const place = !listed ? 'machine' : keys.length > 1 ? 'several' : current.has(keys[0]) ? 'here' : 'other';
  const row = place === 'other' ? model.rows.find((item) => item.projectKey === keys[0]) : null;
  const only = count === 1 && model.gates.length === 1 ? model.gates[0] : null;
  const target = place === 'other' ? `#/layers/${keys[0]}`
    : place === 'here' && only !== null && typeof only.slug === 'string' ? `#/run/${only.slug}/${only.taskId}` : '#/layers';
  return {
    kind: 'waiting', count, atLeast: missing.length > 0, missing, projects: keys.length, place,
    label: row && typeof row.label === 'string' ? row.label : null, target,
    held, reason: held ? stream.token : null, code: held ? stream.code : null,
  };
}

/** What a record did not observe, in words. @param {Array<{ reason: string, n: number }>} missing */
function missingWords(missing) {
  return missing.map(({ reason, n }) => (reason === 'not-shown'
    ? `${plural(n, 'project')} not summarized`
    : `${plural(n, 'project')} with an unreadable store`)).join(', ');
}

/** Why a stream is not followed, in words with its code. @param {string} reason @param {string | null} code */
function reasonWords(reason, code) {
  return `${UNOBSERVED_REASON[reason] ?? UNOBSERVED_REASON.down}${code ? ` (${code})` : ''}`;
}

/**
 * The words of a model: `{ state, count, where, link, badge }`, or null when the strip shows nothing (`quiet`, `clear`).
 * `state` is the tint (`awaiting` or `unknown`); `asOf` is the clock time of the held record, said only when it is held.
 * @param {any} model @param {string | null} asOf
 */
function attentionWords(model, asOf = null) {
  if (model.kind === 'waiting') {
    // The count is of the whole machine, and says so: the Now page lists one project (it names it), so the two never read as one scope.
    const place = model.place === 'machine' ? '' : model.place === 'several' ? `, in ${model.projects} projects` : model.place === 'here' ? ', in this project' : `, in ${model.label ?? 'another project'}`;
    const held = model.held ? `${asOf ? `as of ${asOf}, not observed since` : 'not observed now'}: ${reasonWords(model.reason, model.code)}` : null;
    const where = [`on this machine${place}`, model.atLeast ? `not fully observed: ${missingWords(model.missing)}` : null, held].filter(Boolean).join(' · ');
    const count = `${model.atLeast ? 'At least ' : ''}${plural(model.count, 'gate')} waiting for you`;
    return { state: 'awaiting', count, where, link: { href: model.target, text: 'Review' }, badge: `${model.count}${model.atLeast ? '+' : ''}` };
  }
  if (model.kind === 'partial') {
    return { state: 'unknown', count: 'Gates on this machine not fully observed', where: missingWords(model.missing), link: { href: '#/layers', text: 'Details' }, badge: null };
  }
  if (model.kind === 'unobserved') {
    const count = model.held && asOf ? `Waiting gates not observed since ${asOf}` : 'Waiting gates not observed';
    return { state: 'unknown', count, where: reasonWords(model.reason, model.code), link: { href: '#/layers', text: 'Details' }, badge: null };
  }
  return null;
}

/** The label of the project the Console runs in, from the `machine` member's project list, or null when it does not say. @param {any} body */
function currentProject(body) {
  const row = machineModel(body).rows.find((item) => item.current);
  return row && typeof row.label === 'string' && row.label !== '' ? row.label : null;
}

export { UNOBSERVED_REASON, attentionModel, attentionWords, currentProject };
