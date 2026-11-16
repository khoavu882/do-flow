// The words of the Console actions (feature 162, design IC-010, D13, D15; information design §10). Pure functions: no DOM, no
// fetch, no clock. `ACTION_WORDS` is keyed by action id (the runner's WRITE_SHAPE_IDS); `buildConfirmation` turns what a view drew
// into the spec views/confirm.js opens; `byWords`, `refusalWords`, `staleWords`, `appliedWords` and `normalizeText` are the rest of
// what the dialog and the `by` lines say. Every string here reaches the page as a text node; the project label, slug and ids are the
// Console's own closed-grammar fields (project.ts), never free text.

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const KEY16 = /^[0-9a-f]{16}$/;
const WORKER_RUN = /^w-[0-9a-f]{12}$/;
const DEVICE_BY = /^device\.(d-[0-9a-f]{12})$/;
/** IC-009: the longest note or reason, in code points. */
const TEXT_MAX = 500;

/** @param {any} value */
const isId = (value) => typeof value === 'string' && ID.test(value);
/** A revision the core can hold: `^(?:0|[1-9][0-9]{0,8})$` (IC-003). @param {any} value */
const isRevision = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 999999999;

/**
 * How a decider reads on the timeline and in the lists (IC-010): `autopilot`, `manual`, `console` and `device.d-<12 hex>`; null and
 * anything else is "decider not recorded".
 * @param {any} by
 */
function byWords(by) {
  if (by === 'autopilot') return 'by autopilot';
  if (by === 'manual') return 'manually';
  if (by === 'console') return 'from the Console on this machine';
  const device = typeof by === 'string' ? DEVICE_BY.exec(by) : null;
  return device ? `from paired device ${device[1]}` : 'decider not recorded';
}

/**
 * Who asked for a worker stop, from the worker status's `cancelBy` (`{ by, source, requestedAt }`): a Console or paired-device relay
 * label by its words, an agent by its name, a timeout by the deadline, anything else "requester not recorded". Null when no stop was asked.
 * @param {any} cancelBy
 */
function cancelWords(cancelBy) {
  if (cancelBy === null || cancelBy === undefined) return null;
  const who = typeof cancelBy === 'object' ? cancelBy : {};
  if (who.source === 'timeout') return 'by the deadline';
  if (who.source === 'operator') {
    const from = byWords(who.by);
    return from === 'decider not recorded' ? 'requester not recorded' : from;
  }
  // 162 review 8: the Console projects a name as bounded, masked display text (project.ts shownName), spaces included.
  if (who.source === 'user' && typeof who.by === 'string' && who.by !== '') return `by ${who.by}`;
  return 'requester not recorded';
}

/** The run in a sentence: `<slug>/<taskId>`, or the task id alone for a flat run. @param {{ slug: string | null, taskId: string }} ctx */
const runLabel = (ctx) => (ctx.slug === null ? ctx.taskId : `${ctx.slug}/${ctx.taskId}`);
/** "Design approval (gate-a)", or the id alone when the registry gave no name. @param {{ id: string, name: string | null }} gate */
const gateLabel = (gate) => (gate.name ? `${gate.name} (${gate.id})` : gate.id);

/**
 * The words of each action, keyed by the action id. `effect` is the sentence the dialog shows before the person confirms; `applied`
 * is the notice after a 200. The four effect sentences are the ones IC-010 gives.
 * @type {Readonly<Record<string, { effect: (ctx: any) => string, applied: (ctx: any) => string }>>}
 */
const ACTION_WORDS = Object.freeze({
  'decide-gate': Object.freeze({
    effect: (/** @type {any} */ ctx) => (ctx.decision === 'reject'
      ? `Reject ${gateLabel(ctx.gate)} of run ${runLabel(ctx)} in ${ctx.project}. The run ends as rejected. This cannot be undone.`
      : `Approve ${gateLabel(ctx.gate)} of run ${runLabel(ctx)} in ${ctx.project}. The run continues past this gate.`),
    applied: (/** @type {any} */ ctx) => `${ctx.decision === 'reject' ? 'Rejected' : 'Approved'}. The page shows the run’s new state.`,
  }),
  'close-run': Object.freeze({
    effect: (/** @type {any} */ ctx) => `Close run ${runLabel(ctx)} in ${ctx.project}${ctx.current ? `, now at ${ctx.current.id}` : ''}. It ends as closed where it stands. This cannot be undone.`,
    applied: () => 'Closed. The page shows the run’s new state.',
  }),
  'cancel-worker': Object.freeze({
    effect: (/** @type {any} */ ctx) => `Stop worker ${ctx.worker.runId} (${ctx.worker.harness ? `${ctx.worker.harness}, ` : ''}task ${ctx.worker.task}) of ${ctx.slug} in ${ctx.project}. Its processes get SIGTERM, then SIGKILL after 3 s. Edits it has not handed back stay in its own worktree and are not merged. This cannot be undone.`,
    applied: () => 'Stopped. The page shows the worker run’s new state.',
  }),
  // 165 design §10: the start confirmation; `model` null is the harness's own default.
  'start-session': Object.freeze({
    effect: (/** @type {any} */ ctx) => `Start ${ctx.harness} (${ctx.model ?? 'harness default'}) in ${ctx.project} / ${ctx.checkout}. It runs with ${ctx.harness}’s own permissions. Stop it from Layers.`,
    applied: () => 'Started. Layers shows the session and its output.',
  }),
});

/** The notice after an applied action. @param {string} id @param {any} decision */
function appliedWords(id, decision) {
  const words = ACTION_WORDS[id];
  return words ? words.applied({ decision }) : 'Applied.';
}

/** What the dialog says when the Console could not say what happened (504, or no answer): the page's own record is the truth. */
const UNKNOWN_WORDS = 'The outcome is unknown. The page shows the run as it is now.';
/** "Review again" found the page still holding the revision the dialog was opened with (its refetch failed): it builds nothing from it. */
const REREAD_WORDS = 'The page has not read the run again yet. Close this and decide from the page once it shows the new state.';

/**
 * One sentence for each error code of IC-002 (the `error.code` of a refusal). The 409 `stale` has its own words (`staleWords`); its
 * entry here is the fallback for a reply that carried no current state.
 * @type {Readonly<Record<string, string>>}
 */
const REFUSAL_WORDS = Object.freeze({
  usage: 'The Console did not accept the request. Nothing was applied.',
  unauthenticated: 'This page is not signed in to the Console. Reload the page, then try again.',
  'device-unpaired': 'This device is not paired with the Console. Pair it again from the Android app.',
  'device-revoked': 'This device’s pairing was revoked. Pair it again from the Android app.',
  'device-expired': 'This device’s pairing expired. Pair it again from the Android app.',
  'phone-scope': 'This device may only read. Pair a control device from the Android app to act.',
  'action-transport': 'Actions are accepted only over the Android app’s own connection, not from this page.',
  'forbidden-origin': 'The Console refused the request because it did not come from its own page.',
  'unsupported-media': 'The Console refused the request because it was not sent as JSON.',
  'project-not-found': 'The Console no longer lists this project. Nothing was applied.',
  'run-not-found': 'The run is no longer there. Nothing was applied.',
  stale: 'This changed since you opened it. Nothing was applied.',
  'cancel-in-progress': 'Another stop of this worker is already in progress. Nothing was applied.',
  'ambiguous-run': 'More than one run matches. Decide it in a terminal in that project. Nothing was applied.',
  'request-reused': 'This confirmation was already used for a different request. Open it again.',
  'action-rate-limited': 'Too many actions in a short time. Wait a moment, then try again.',
  'action-busy': 'The Console is busy with another action. Try again in a moment.',
  'core-lacks-action': 'The installed DoFlow core cannot take this action. Update the core, then reload this page.',
  'core-error': 'The DoFlow core could not complete the action. The page shows the run as it is now.',
  'core-contract-mismatch': 'The DoFlow core answered in a form the Console does not know. The page shows the run as it is now.',
  'core-unreachable': 'The Console could not reach the DoFlow core. Nothing was applied.',
  'action-log-unwritable': 'The Console could not record this attempt, so it did not run. Nothing was applied.',
  'action-timeout': UNKNOWN_WORDS,
});

/** @param {any} code */
function refusalWords(code) {
  if (typeof code !== 'string') return 'The Console did not accept the request. Nothing was applied.';
  return REFUSAL_WORDS[code] ?? `The Console refused the action (${code}). Nothing was applied.`;
}

/** The run states of a `current` in words. @type {Readonly<Record<string, string>>} */
const RUN_STATE_WORDS = Object.freeze({ RUNNING: 'running', COMPLETED: 'completed', REJECTED: 'rejected', CLOSED: 'closed' });

/**
 * The lines of the stale state (a 409 `stale`): that it changed, the current state in words when the reply carried one, and that
 * nothing was applied. `current` is `{state, revision, awaitingGate}` for a run, `{state: 'ended', endState}` or
 * `{state: 'cancelling', requestedAt}` for a worker.
 * @param {string} id @param {any} current
 * @returns {string[]}
 */
function staleWords(id, current) {
  const noun = id === 'cancel-worker' ? 'worker run' : 'run';
  const lines = [`This ${noun} changed since you opened it.`];
  if (current && typeof current === 'object') {
    if (id === 'cancel-worker') {
      if (current.state === 'ended') lines.push(`It has already ended${typeof current.endState === 'string' ? ` (${current.endState})` : ''}.`);
      else if (current.state === 'cancelling') lines.push('A stop is already in progress.');
    } else if (current.state === 'AWAITING_GATE') {
      const gate = current.awaitingGate && typeof current.awaitingGate === 'object' ? current.awaitingGate : null;
      lines.push(gate && isId(gate.gateId) ? `It is now waiting at ${gateLabel({ id: gate.gateId, name: typeof gate.name === 'string' && gate.name !== '' ? gate.name : null })}.` : 'It is now waiting at a gate.');
    } else if (typeof current.state === 'string' && RUN_STATE_WORDS[current.state]) lines.push(`It is now ${RUN_STATE_WORDS[current.state]}.`);
  }
  lines.push('Nothing was applied.');
  return lines;
}

/**
 * IC-009 as the Console applies it (162 review 6: the same vectors, test/helpers/text-vectors.ts): null for a lone surrogate; NFC;
 * tab, CR and LF become a space; C0, DEL, C1, U+200B-U+200F, U+202A-U+202E, U+2066-U+2069
 * and U+FEFF are removed; runs of spaces collapse; trimmed. The Console normalizes again and refuses more than 500 code points.
 * @param {any} value
 */
function normalizeText(value) {
  const raw = String(value ?? '');
  // A lone surrogate has no UTF-8 form; the Console refuses it (src/actions.ts), so the page does too.
  if (LONE_SURROGATE.test(raw)) return null;
  return raw
    .normalize('NFC')
    .replace(/[\r\n\t]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * The state of a text field: the normalized text, its length in code points, whether the verb button may use it (a required text has
 * at least one, no text has more than `max`), and whether it is over. @param {{ required: boolean, max: number }} rule @param {any} value
 */
function textState(rule, value) {
  const normalized = normalizeText(value);
  if (normalized === null) return { text: '', count: 0, ok: false, over: false };
  const text = normalized;
  const count = [...text].length;
  const over = count > rule.max;
  return { text, count, ok: !over && (!rule.required || count > 0), over };
}

/**
 * The confirmation spec of one action, from what a view drew, or null when a field the request carries is missing or malformed
 * (the view then shows no button). The body is IC-002's without `requestId` and without the typed text (the field named by
 * `text.field` starts as null; the dialog fills it). `expect` is what the page drew (D2, D15); a worker cancel has none (D16).
 * @param {string} id the action id
 * @param {any} ctx decide-gate: { projectKey, project, slug, taskId, gate: {id, name}, decision, revision };
 *   close-run: { projectKey, project, slug, taskId, current: {type, id} | null, revision };
 *   cancel-worker: { projectKey, project, slug, worker: {runId, harness, task} };
 *   start-session (165): { projectKey, project, checkout, worktreeKey, harness, model, entry, prompt }
 * @returns {{ actionId: string, title: string, effect: string, verb: string, tone: 'approve' | 'danger', text: { field: string, required: boolean, max: number, label: string } | null, expect: { revision: number } | null, body: Record<string, any>, decision: string | null, unknown?: string } | null}
 */
function buildConfirmation(id, ctx) {
  if (!ACTION_WORDS[id] || !ctx || typeof ctx !== 'object') return null;
  if (typeof ctx.projectKey !== 'string' || !KEY16.test(ctx.projectKey)) return null;
  const project = typeof ctx.project === 'string' && ctx.project !== '' ? ctx.project : ctx.projectKey.slice(0, 8);
  if (id === 'start-session') return buildStartConfirmation(ctx, project);
  const slug = ctx.slug === null || ctx.slug === undefined ? null : ctx.slug;
  if (slug !== null && !isId(slug)) return null;
  const base = { v: 1, projectKey: ctx.projectKey, slug };
  if (id === 'decide-gate') {
    if (!isId(ctx.taskId) || !ctx.gate || !isId(ctx.gate.id) || (ctx.decision !== 'approve' && ctx.decision !== 'reject') || !isRevision(ctx.revision)) return null;
    const gate = { id: ctx.gate.id, name: typeof ctx.gate.name === 'string' && ctx.gate.name !== '' ? ctx.gate.name : null };
    const view = { ...ctx, project, slug, gate };
    const approve = ctx.decision === 'approve';
    return {
      actionId: id,
      title: `${approve ? 'Approve' : 'Reject'} ${gate.name ?? gate.id}`,
      effect: ACTION_WORDS[id].effect(view),
      verb: `${approve ? 'Approve' : 'Reject'} ${gate.id}`,
      tone: approve ? 'approve' : 'danger',
      text: { field: 'note', required: false, max: TEXT_MAX, label: 'Note (optional)' },
      expect: { revision: ctx.revision },
      body: { ...base, taskId: ctx.taskId, gateId: gate.id, decision: ctx.decision, note: null, expect: { revision: ctx.revision } },
      decision: ctx.decision,
    };
  }
  if (id === 'close-run') {
    if (!isId(ctx.taskId) || !isRevision(ctx.revision)) return null;
    const current = ctx.current && isId(ctx.current.id) ? { id: ctx.current.id } : null;
    return {
      actionId: id,
      title: `Close run ${runLabel({ slug, taskId: ctx.taskId })}`,
      effect: ACTION_WORDS[id].effect({ project, slug, taskId: ctx.taskId, current }),
      verb: 'Close run',
      tone: 'danger',
      text: { field: 'note', required: true, max: TEXT_MAX, label: 'Why is this run closed? (required)' },
      expect: { revision: ctx.revision },
      body: { ...base, taskId: ctx.taskId, note: null, expect: { revision: ctx.revision } },
      decision: null,
    };
  }
  // cancel-worker: its feature is part of the request (the worker run store is per feature).
  const worker = ctx.worker;
  if (slug === null || !worker || typeof worker.runId !== 'string' || !WORKER_RUN.test(worker.runId) || !isId(worker.task)) return null;
  const harness = typeof worker.harness === 'string' && worker.harness !== '' ? worker.harness : null;
  return {
    actionId: id,
    title: `Stop worker ${worker.runId}`,
    effect: ACTION_WORDS[id].effect({ project, slug, worker: { runId: worker.runId, harness, task: worker.task } }),
    verb: 'Stop worker',
    tone: 'danger',
    text: { field: 'reason', required: true, max: TEXT_MAX, label: 'Why is this worker stopped? (required)' },
    expect: null,
    body: { ...base, runId: worker.runId, reason: null },
    decision: null,
  };
}

/**
 * 165 design §10 state 3: the start confirmation. It has no text field (`text: null`: the start form holds the prompt), no `expect`, and its
 * body is complete but for the request id. `ctx` is `{ projectKey, project, checkout, worktreeKey, harness, model, entry, prompt }`.
 * @param {any} ctx @param {string} project
 */
function buildStartConfirmation(ctx, project) {
  const model = ctx.model === null || ctx.model === undefined ? null : ctx.model;
  if (!KEY16.test(String(ctx.worktreeKey)) || !isId(ctx.harness)) return null;
  if (model !== null && (typeof model !== 'string' || model === '')) return null;
  if (ctx.entry !== 'do' && ctx.entry !== 'none') return null;
  if (typeof ctx.prompt !== 'string' || ctx.prompt === '') return null;
  const checkout = typeof ctx.checkout === 'string' && ctx.checkout !== '' ? ctx.checkout : ctx.worktreeKey.slice(0, 8);
  return {
    actionId: 'start-session',
    title: `Start ${ctx.harness}`,
    effect: ACTION_WORDS['start-session'].effect({ harness: ctx.harness, model, project, checkout }),
    verb: `Start ${ctx.harness}`,
    tone: /** @type {'approve'} */ ('approve'),
    text: null,
    expect: null,
    unknown: 'No answer; check Sessions before trying again.',
    body: { v: 1, projectKey: ctx.projectKey, worktreeKey: ctx.worktreeKey, harness: ctx.harness, model, entry: ctx.entry, prompt: ctx.prompt },
    decision: null,
  };
}

/** The reason line shown where a command block stays because the action is not allowed here, by the reason `GET /api/actions` gave. @type {Readonly<Record<string, string>>} */
const NOT_ALLOWED_WORDS = Object.freeze({
  'phone-scope': 'Actions need a control device paired from the Android app.',
  'action-transport': 'Actions run only over the Android app’s own connection, not from this page.',
  'core-lacks-action': 'The installed DoFlow core cannot take this action. Update the core to enable it.',
  'action-log-unwritable': 'Actions are off: the Console cannot write its action log.',
});

/** @param {any} reason */
const notAllowedWords = (reason) => (typeof reason === 'string' ? NOT_ALLOWED_WORDS[reason] ?? null : null);

export {
  TEXT_MAX, ACTION_WORDS, REFUSAL_WORDS, UNKNOWN_WORDS, REREAD_WORDS, NOT_ALLOWED_WORDS, byWords, cancelWords, refusalWords, staleWords, appliedWords, normalizeText, textState, buildConfirmation, notAllowedWords,
};
