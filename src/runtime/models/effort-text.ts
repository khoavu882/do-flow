'use strict';

// 178 IC-005 (design §8.1, D8): the one rendering of an effort plan (`effortPlanFor`'s answer), for the brief's Effort line
// and, through the shared fixture test/fixtures/models/effort-text.json, the Console's copy in
// console/web/derive/effort-text.js. It says where a passed effort came from, or why none is passed. Harness ids, levels
// and variable names come from the plan and `worker` (data); this module holds none. Pure.

type Slots = { h: string; w: string; l: string; origin: string };

/** Why the session gave no level, one phrase per SessionReason (`plan.session.reason`). */
const SESSION_PHRASES: Record<string, (s: Slots) => string> = {
  'worker-role': () => 'this is a worker session, which forwards no effort',
  'no-session-harness': () => 'no harness session to follow',
  'several-markers': () => 'more than one harness session is marked',
  contradicted: ({ h }) => `the marked session is ${h}, not the declared main harness`,
  'no-source': ({ h }) => `${h} declares no source for its session's effort`,
  'mode-unknown': ({ h, origin }) => `the login mode of ${h} is unknown, and ${origin} is evidenced for one login mode only`,
  'mode-not-evidenced': ({ h, origin }) => `${origin} is not evidenced for the login mode of ${h}`,
  'not-set': ({ h, origin }) => `${origin} is not set in the ${h} session`,
  'level-not-declared': ({ h, origin }) => `${origin} in the ${h} session is not a level ${h} declares`,
};

/** Why a known session level is not passed, one phrase per NoneReason other than `session-unknown`. */
const NONE_PHRASES: Record<string, (s: Slots) => string> = {
  'worker-takes-no-effort': ({ w }) => `${w} takes no effort argument`,
  'needs-model': ({ w }) => `${w} takes an effort only with a model, and none is bound`,
  'no-lower-level': ({ w, h, l }) => `${w} has no level at or below the ${h} session's ${l}`,
  'no-ordered-list': ({ w, h, l }) => `${w} has no ${l}, and ${h} lists its levels per model, so no lower level is known`,
};

const EFFORT_UNCHECKED_NOTE = 'effort unchecked';

/**
 * The text of a plan: `<level> (tier binding)`; `<level>, the <h> session's level (<origin>)`, or mapped down from the
 * session's level, with ` [effort unchecked]` for a per-model worker list; or `harness default (<why>)`. `code: true`
 * wraps levels, harness ids and variable names in backticks. `worker` is the worker harness id.
 */
function effortText(plan: any, { code = false, worker }: { code?: boolean; worker: string }): string {
  const c = (value: unknown) => (code ? `\`${value}\`` : String(value));
  if (plan.source === 'binding') return `${c(plan.pass)} (tier binding)`;
  if (plan.source === 'session') {
    const note = plan.check === 'unchecked' ? ` [${EFFORT_UNCHECKED_NOTE}]` : '';
    if (plan.mapped) {
      return `${c(plan.pass)}, mapped down from the ${c(plan.harness)} session's ${c(plan.mapped.from)} (${c(plan.origin)}; ${c(worker)} has no ${c(plan.mapped.from)})${note}`;
    }
    return `${c(plan.pass)}, the ${c(plan.harness)} session's level (${c(plan.origin)})${note}`;
  }
  const session = plan.session ?? {};
  const slots: Slots = { h: c(session.harness), w: c(worker), l: c(session.level), origin: c(session.origin) };
  const phrase = plan.reason === 'session-unknown' ? SESSION_PHRASES[session.reason] : NONE_PHRASES[plan.reason];
  return `harness default (${phrase ? phrase(slots) : plan.reason === 'session-unknown' ? session.reason : plan.reason})`;
}

module.exports = { effortText };
