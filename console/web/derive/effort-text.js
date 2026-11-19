// The one rendering of an effort plan in the Console (feature 178, IC-005, D8): the words of the brief's Effort line in the core,
// here for the start form's model note. The Console imports nothing from the core, so this is a copy of `effortText` in
// src/runtime/models/effort-text.ts; test/fixtures/models/effort-text.json, read by a core test and by console/test/effort-text.test.ts,
// holds the two equal. A plan is `{ pass, source: 'binding' }`, `{ pass, source: 'session', harness, level, origin, mapped, check }` or
// `{ pass: null, source: 'none', reason, session: { harness, reason, level, origin } }`. Harness ids, levels and variable names come
// from the plan and `worker`. Pure: no DOM, no fetch.

/** @typedef {{ h: string, w: string, l: string, origin: string }} Slots */

/** Why the session gave no level, one phrase per SessionReason (`plan.session.reason`). @type {Readonly<Record<string, (s: Slots) => string>>} */
const SESSION_PHRASES = Object.freeze({
  'worker-role': () => 'this is a worker session, which forwards no effort',
  'no-session-harness': () => 'no harness session to follow',
  'several-markers': () => 'more than one harness session is marked',
  contradicted: (/** @type {Slots} */ { h }) => `the marked session is ${h}, not the declared main harness`,
  'no-source': (/** @type {Slots} */ { h }) => `${h} declares no source for its session's effort`,
  'mode-unknown': (/** @type {Slots} */ { h, origin }) => `the login mode of ${h} is unknown, and ${origin} is evidenced for one login mode only`,
  'mode-not-evidenced': (/** @type {Slots} */ { h, origin }) => `${origin} is not evidenced for the login mode of ${h}`,
  'not-set': (/** @type {Slots} */ { h, origin }) => `${origin} is not set in the ${h} session`,
  'level-not-declared': (/** @type {Slots} */ { h, origin }) => `${origin} in the ${h} session is not a level ${h} declares`,
});

/** Why a known session level is not passed, one phrase per NoneReason other than `session-unknown`. @type {Readonly<Record<string, (s: Slots) => string>>} */
const NONE_PHRASES = Object.freeze({
  'worker-takes-no-effort': (/** @type {Slots} */ { w }) => `${w} takes no effort argument`,
  'needs-model': (/** @type {Slots} */ { w }) => `${w} takes an effort only with a model, and none is bound`,
  'no-lower-level': (/** @type {Slots} */ { w, h, l }) => `${w} has no level at or below the ${h} session's ${l}`,
  'no-ordered-list': (/** @type {Slots} */ { w, h, l }) => `${w} has no ${l}, and ${h} lists its levels per model, so no lower level is known`,
});

const EFFORT_UNCHECKED_NOTE = 'effort unchecked';

/**
 * The text of a plan: `<level> (tier binding)`; `<level>, the <h> session's level (<origin>)`, or mapped down from the session's level,
 * with ` [effort unchecked]` for a per-model worker list; or `harness default (<why>)`. `code: true` wraps levels, harness ids and
 * variable names in backticks. `worker` is the worker harness id.
 * @param {any} plan @param {{ code?: boolean, worker: string }} options
 * @returns {string}
 */
function effortText(plan, { code = false, worker }) {
  /** @param {unknown} value */
  const c = (value) => (code ? `\`${value}\`` : String(value));
  if (plan.source === 'binding') return `${c(plan.pass)} (tier binding)`;
  if (plan.source === 'session') {
    const note = plan.check === 'unchecked' ? ` [${EFFORT_UNCHECKED_NOTE}]` : '';
    if (plan.mapped) {
      return `${c(plan.pass)}, mapped down from the ${c(plan.harness)} session's ${c(plan.mapped.from)} (${c(plan.origin)}; ${c(worker)} has no ${c(plan.mapped.from)})${note}`;
    }
    return `${c(plan.pass)}, the ${c(plan.harness)} session's level (${c(plan.origin)})${note}`;
  }
  const session = plan.session ?? {};
  /** @type {Slots} */
  const slots = { h: c(session.harness), w: c(worker), l: c(session.level), origin: c(session.origin) };
  const phrase = plan.reason === 'session-unknown' ? SESSION_PHRASES[session.reason] : NONE_PHRASES[plan.reason];
  return `harness default (${phrase ? phrase(slots) : plan.reason === 'session-unknown' ? session.reason : plan.reason})`;
}

export { effortText };
