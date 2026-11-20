// The failure explainer (180 IC-180-B3, design §3, FR-B3): why a run stopped, read from its own record, and the one command to
// run next, from a fixed table. A REJECTED run gives its rejecting gate decision, a run CLOSED before its last step gives the
// close, a RUNNING run silent for over a day (the home's stale rule) gives its last update. Every reason field is a recorded
// value or null; nothing is composed. Pure: no DOM, no clock reads (the caller passes `nowMs`), no storage.

import { runToken } from './rail.js';
// A task id or slug of any other shape is left out of a command.
import { PARAM_PATTERN as ID } from '../routes.js';

/** The next command per reason: an orchestrate action that only reads, and why to run it (derive-explain.test.ts checks the actions). */
const NEXT = Object.freeze({
  rejected: Object.freeze({ action: 'timeline', why: 'Lists every recorded step and decision of this run, the rejection included.' }),
  closed: Object.freeze({ action: 'status', why: 'Shows the step the run was closed at and the steps it did not reach.' }),
  stale: Object.freeze({ action: 'status', why: 'Shows the stage the run is at, as its record says.' }),
});

/** The newest timeline event of `action` that passes `match`, or null. @param {any} timeline @param {string} action @param {(event: any) => boolean} [match] */
function lastEvent(timeline, action, match = () => true) {
  const events = timeline && Array.isArray(timeline.events) ? timeline.events : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event && event.action === action && match(event)) return event;
  }
  return null;
}

const orNull = (/** @type {any} */ value) => (typeof value === 'string' ? value : null);

/**
 * Why `run` stopped and what to run next, or null for a run that did not stop early (running and fresh, waiting at a gate,
 * completed, or closed after its last step). `reason`: `{ kind, text, by, at }` with `text` the recorded node (the gate, the
 * step closed at, or the current stage), `by` the recorded decider, `at` the recorded time; a field the record lacks is null.
 * @param {any} run the run route's `run`
 * @param {any} timeline the timeline body, or null
 * @param {number} nowMs
 * @returns {null | { state: string, reason: { kind: string, text: string | null, by: string | null, at: string | null }, next: { command: string, why: string } }}
 */
function explain(run, timeline, nowMs) {
  if (!run || typeof run.taskId !== 'string' || !ID.test(run.taskId)) return null;
  /** @type {any} */
  let reason = null;
  if (run.state === 'REJECTED') {
    const entry = lastEvent(timeline, 'decide-gate', (event) => event.decision === 'reject');
    reason = { kind: 'rejected', text: orNull(entry && entry.node), by: orNull(entry && entry.by), at: orNull(entry && entry.at) };
  } else if (run.state === 'CLOSED') {
    const progress = run.progress;
    // The record carries no terminal stage here; a close before the program's last node is a close before it.
    const early = !progress || !(progress.done >= progress.total);
    if (!early) return null;
    const entry = lastEvent(timeline, 'close-run');
    reason = { kind: 'closed', text: orNull(entry && entry.node), by: orNull(entry && entry.by), at: orNull(entry && entry.at) };
  } else if (runToken(run, nowMs) === 'stale') {
    reason = { kind: 'stale', text: orNull(run.current && run.current.id), by: null, at: orNull(run.updatedAt) };
  } else {
    return null;
  }
  const next = NEXT[/** @type {'rejected'} */ (reason.kind)];
  const slug = typeof run.featureSlug === 'string' && ID.test(run.featureSlug) ? ` --slug ${run.featureSlug}` : '';
  return { state: run.state, reason, next: { command: `doflow orchestrate --action ${next.action} --task-id ${run.taskId}${slug}`, why: next.why } };
}

export { NEXT, explain };
