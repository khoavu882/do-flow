// What waits for the person on this machine, for the shell's attention strip and the count on the Layers link. A pure function
// of the `machine` member the live store holds and of the stream's state: no DOM, no clock, no fetch.
//
// The honesty rules of the Layers page apply (derive/layers.js): a gate waiting for you is the only waiting DoFlow records, so
// that is all this counts. While nothing can be said the model says so with its reason (`unobserved`); it never reads "nothing
// waiting" from a stream that is down or from an activity section that failed. `clear` is said only by a held, readable record.

import { machineModel, streamState } from './layers.js';

const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Why the gates are not observed, per stream token (the code of an unreadable section is added by the words). @type {Readonly<Record<string, string>>} */
const UNOBSERVED_REASON = Object.freeze({
  down: 'the stream from the Console is down',
  refused: 'the Console refused this stream',
  unsupported: 'this browser cannot follow a stream',
  'core-lacks-channel': 'the DoFlow core is older than the stream',
  unreadable: 'the activity of the projects is unreadable',
});

/**
 * The attention model.
 *   `quiet`       nothing to say yet: the stream is connecting or paused and no record is held, or the activity has not arrived;
 *   `unobserved`  nothing can be said, with `reason` (a key of UNOBSERVED_REASON) and `code`;
 *   `clear`       a readable record holds no awaiting gate;
 *   `waiting`     `count` gates in `projects` projects; `target` is the hash that shows them: the run when the only gate is in
 *                 the project the Console runs in, else the Layers machine page.
 * `held` is true when the record is not being followed right now (stream down, refused, paused): the words then say as of when.
 * @param {{ body: any, transport: { state: string, code: string | null } | null, error: string | null }} input
 */
function attentionModel({ body, transport, error }) {
  const stream = streamState({ transport, errors: [error], hasData: body !== null && body !== undefined });
  const model = machineModel(body);
  const failing = ['down', 'refused', 'unsupported', 'core-lacks-channel'].includes(stream.token);
  if (!model.present) return failing ? { kind: 'unobserved', reason: stream.token, code: stream.code } : { kind: 'quiet' };
  if (model.activitySection.state === 'unreadable') return { kind: 'unobserved', reason: 'unreadable', code: model.activitySection.code };
  if (model.activitySection.state !== 'ok') return failing ? { kind: 'unobserved', reason: stream.token, code: stream.code } : { kind: 'quiet' };
  const held = stream.token !== 'following';
  const gates = model.gates;
  if (gates.length === 0) return { kind: 'clear', held };
  const projects = new Set(gates.map((/** @type {any} */ gate) => gate.projectKey)).size;
  const current = new Set(model.rows.filter((row) => row.current).map((row) => row.projectKey));
  const only = gates.length === 1 ? gates[0] : null;
  const target = only !== null && current.has(only.projectKey) && typeof only.slug === 'string' ? `#/run/${only.slug}/${only.taskId}` : '#/layers';
  return { kind: 'waiting', count: gates.length, projects, target, held };
}

/**
 * The words of a model: `{ state, count, where, link }`, or null when the strip shows nothing (`quiet`, `clear`).
 * `state` is the tint (`awaiting` or `unknown`); `asOf` is a clock time, said only for a held record.
 * @param {any} model @param {string | null} asOf
 */
function attentionWords(model, asOf = null) {
  if (model.kind === 'waiting') {
    const where = [model.projects > 1 ? `in ${model.projects} projects` : null, model.held && asOf ? `as of ${asOf}` : null].filter(Boolean).join(' · ');
    return { state: 'awaiting', count: `${plural(model.count, 'gate')} waiting for you`, where, link: { href: model.target, text: 'Review' }, badge: String(model.count) };
  }
  if (model.kind === 'unobserved') {
    const reason = UNOBSERVED_REASON[model.reason] ?? UNOBSERVED_REASON.down;
    return { state: 'unknown', count: 'Waiting gates not observed', where: `${reason}${model.code ? ` (${model.code})` : ''}`, link: { href: '#/layers', text: 'Details' }, badge: null };
  }
  return null;
}

export { UNOBSERVED_REASON, attentionModel, attentionWords };
