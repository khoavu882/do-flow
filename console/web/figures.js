// Shared figure words and section states of the management screens (feature 151, IC-016; FR-002, FR-026, FR-029).
//
// One way to write a figure: `unknown` when the core did not report it, "no data (n=0)" when it reported zero samples, and
// the value with its n otherwise. The words are the core report's own (`ratio`, src/runtime/advice/report.ts), so a figure
// reads the same on the page as in `doflow advise --action report`. A missing value is never written as 0.
//
// One way to show a part of a sectioned route (IC-012: `{ok: true, data, at}` or `{ok: false, code}`): ready with its age,
// not in this core, or an inline error with Retry. Every string reaches the page as a text node (NFR-005).
//
// CORE_RANGE is read from views.js only inside a call: views.js imports the screens that import this module, so in the
// page's order (views.js first) this module's body runs before views.js's.

import { h, icon } from './dom.js';
import { ERROR_COPY, errorTitle, errorSentence, inline, button, reltime } from './states.js';
import { CORE_RANGE } from './views.js';

const UNKNOWN = 'unknown';
const NO_DATA = 'no data (n=0)';

/** @param {unknown} value @returns {value is number} */
const isCount = (value) => Number.isInteger(value) && /** @type {number} */ (value) >= 0;

/**
 * A count: the integer as text, or `unknown` for null, undefined or anything that is not a count.
 * @param {unknown} value
 */
function countText(value) {
  return isCount(value) ? String(value) : UNKNOWN;
}

/**
 * An agreement figure `{n, agree}` as the report writes it: `unknown` for null, "no data (n=0)" for n 0, else
 * "<agree> of <n> (<pct>%), n=<n>".
 * @param {any} part
 */
function ratioText(part) {
  if (part === null || typeof part !== 'object' || !isCount(part.n) || !isCount(part.agree)) return UNKNOWN;
  if (part.n === 0) return NO_DATA;
  return `${part.agree} of ${part.n} (${Math.round((part.agree / part.n) * 100)}%), n=${part.n}`;
}

/**
 * A value with its sample count: "no data (n=0)" for n 0 (the report's rule: zero samples is known), `unknown` for a null
 * value, else "<value>, n=<n>" (an n the core did not report reads `n=unknown`).
 * @param {unknown} value
 * @param {unknown} n
 */
function figureText(value, n) {
  if (n === 0) return NO_DATA;
  if (value === null || value === undefined) return UNKNOWN;
  return `${String(value)}, n=${countText(n)}`;
}

/**
 * A figure's text in a `span.figure`; `data-figure` is `unknown`, `no-data` or `value`.
 * @param {string} text
 */
function figure(text) {
  const kind = text === UNKNOWN ? 'unknown' : text === NO_DATA ? 'no-data' : 'value';
  return h('span', { class: 'figure', dataset: { figure: kind } }, String(text));
}

/** A failed section's code as its ERROR_COPY key: the copy `classify` gives the same code as a whole-route answer. */
/** @type {Readonly<Record<string, string>>} */
const SECTION_KEYS = Object.freeze({
  'core-error': 'core-error',
  'core-contract-mismatch': 'contract-mismatch',
  // A full page when a whole route says it; one part of a screen cannot be a full page, so it reads as a failed read.
  'core-unreachable': 'core-error',
  usage: 'refused',
});

/**
 * An inline error for a failed section: its ERROR_COPY title, sentence and hint, Retry, and the code.
 * @param {string} code @param {string} noun @param {() => void} onRetry
 */
function sectionError(code, noun, onRetry) {
  const key = Object.hasOwn(SECTION_KEYS, code) ? SECTION_KEYS[code] : 'core-error';
  const info = { key };
  const copy = ERROR_COPY[key];
  const hint = copy.hint ? copy.hint(CORE_RANGE) : null;
  return h('section', { class: 'state-panel', dataset: { kind: 'error', state: 'error' } }, [
    h('div', { class: 'state-panel__head' }, [icon('failed', 20), h('h3', { class: 'state-panel__title' }, errorTitle(info, noun))]),
    h('p', { class: 'state-panel__sentence' }, inline(errorSentence(info, noun))),
    hint ? h('p', { class: 'hint' }, [hint[0], h('code', { class: 'mono' }, hint[1]), hint[2]]) : null,
    h('div', { class: 'state-panel__actions' }, button('secondary', 'Retry', () => onRetry(), 'refresh')),
    h('p', { class: 'code-chip' }, code),
  ]);
}

/**
 * One part of a sectioned route. `ok`: `render(data)` and "Read <reltime>" from `at`; `core-lacks-verb`: "This DoFlow core
 * does not provide <noun>." with `data-state="not-in-core"`; any other code (or a missing section, a body this page does not
 * read): an inline error with its ERROR_COPY entry and Retry, which calls `onRetry`. `nowMs` defaults to the clock.
 * @param {any} section
 * @param {{ noun: string, render: (data: any) => any, onRetry: () => void, nowMs?: number }} options
 */
function renderSection(section, { noun, render, onRetry, nowMs = Date.now() }) {
  if (typeof render !== 'function' || typeof onRetry !== 'function') throw new TypeError('renderSection(section, { noun, render, onRetry, nowMs })');
  const ok = section !== null && typeof section === 'object';
  if (ok && section.ok === true) {
    return h('div', { dataset: { state: 'ready' } }, [h('p', { class: 'hint' }, ['Read ', reltime(section.at, nowMs)]), render(section.data)]);
  }
  const code = ok && typeof section.code === 'string' ? section.code : 'core-contract-mismatch';
  if (code === 'core-lacks-verb') return h('p', { dataset: { state: 'not-in-core' } }, errorSentence({ key: code }, noun));
  return sectionError(code, noun, onRetry);
}

export { UNKNOWN, NO_DATA, countText, ratioText, figureText, figure, renderSection };
