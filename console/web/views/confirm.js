// The one confirmation dialog of the Console actions (feature 162, design IC-010, D13, §10). `openConfirm(spec)` shows what the action
// will do, takes the note or reason, and posts only when the person presses the verb button: nothing else in the page calls
// `postAction` (web-safety.test.ts), and a deep link or a notice may open the dialog but never press that button. The spec comes from
// derive/actions.js `buildConfirmation`; its `expect` and a fresh `requestId` are fixed when the dialog opens, so a second press, a
// retry by the transport or a second device cannot apply the action twice (the Console and the core refuse it as stale).
//
// A modal dialog (`role="dialog" aria-modal="true"`), a sheet below 768 px and a centred panel above (app.css `.confirm`). Focus
// starts on Cancel, Escape closes, Tab and Shift+Tab wrap (the pattern of shell.js); a route change closes it (app.js), and while it is
// open the global shortcuts do nothing (keys.js `blocked`). On close focus goes back to the opener while it is on the page, else to
// `#main`, then the `h1` (keys.js's fallback). The states: ready, sending, applied, stale (the current state in words, "Nothing was
// applied.", "Review again"), refused (the code in words) and unknown (a 504, or no answer: the outcome cannot be told, and the page
// shows the run as it is now). An applied, unknown or stale outcome makes the page refetch at once (`onRefetch`); "Review again" waits
// for that answer and builds from the refreshed row, never from the revision this dialog was opened with. Every string is a text node.
//
// 165 (the start of a session): a spec with `text: null` has no field (its body is complete: the start form already holds the prompt), a
// spec may carry the `requestId` of an earlier unanswered attempt (a retry after a 504 reuses it, so the core replays the start), its own
// `unknown` words and a `refusal(code, reply)` that returns the lines of a refusal; the options `onSend` and `onReply(reply, state)` tell
// the page that the one write began and what came back.

import { h, mount } from '../dom.js';
import { isKey } from '../keys.js';
import { postAction, loadActions, actionPower, onActions } from '../actions.js';
import { textState, refusalWords, staleWords, appliedWords, notAllowedWords, UNKNOWN_WORDS, REREAD_WORDS } from '../derive/actions.js';

let opened = 0;
/** @type {{ close: () => void } | null} */
let active = null;
/** @type {(() => Promise<boolean> | boolean | void) | null} */
let refetchListener = null;

/**
 * 162: who refetches what the page shows after an action that may have changed it: applied, unknown (504, no answer) or stale (162
 * review B-6). The page's one listener (the last set); it answers whether the page has the refreshed data (a promise, once it does).
 * @param {() => Promise<boolean> | boolean | void} listener @returns {() => void} the call that stops telling it
 */
function onRefetch(listener) {
  refetchListener = listener;
  return () => { if (refetchListener === listener) refetchListener = null; };
}

/** Tells the page to refetch; resolves true once it holds the refreshed data, false when it could not. */
function askRefetch() {
  if (refetchListener === null) return Promise.resolve(false);
  try {
    return Promise.resolve(refetchListener()).then((answer) => answer === true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * A fresh request id: 16 random bytes as base64url, 22 characters, the first always a letter or digit (`^[A-Za-z0-9][A-Za-z0-9_-]{21}$`):
 * start-session hands the id to the core as a `--request-id` flag value and the CLI refuses a value that begins with `-`. A leading
 * `-` or `_` (index 62 or 63 of the alphabet) becomes `A` or `B`, which costs 1 bit of the 128, not the rule.
 * @param {{ getRandomValues: (bytes: Uint8Array) => Uint8Array } | undefined} [source] `crypto` by default
 */
function newRequestId(source) {
  const random = source ?? globalThis.crypto;
  const bytes = new Uint8Array(16);
  random.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const id = globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return id.replace(/^[-_]/, (lead) => (lead === '-' ? 'A' : 'B'));
}

/**
 * Opens the dialog for `spec` (see derive/actions.js `buildConfirmation`; a view may add `reopen()`, which returns a fresh spec
 * from the page's current row, or null, for "Review again"). Any dialog already open is closed first. Returns `{ el, close, state }`.
 * @param {any} spec
 * @param {{ host?: any, random?: any, onClose?: (state: string) => void, onSend?: (...a: any[]) => any, onReply?: (...a: any[]) => any }} [options]
 */
function openConfirm(spec, options = {}) {
  if (active) active.close();
  const doc = globalThis.document;
  const host = options.host ?? doc.body;
  /** @type {any} */
  const opener = doc.activeElement;
  const id = `confirm-${(opened += 1)}`;
  // Fixed now: what the page drew, and the id this confirmation is known by.
  const requestId = typeof spec.requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{21}$/.test(spec.requestId) ? spec.requestId : newRequestId(options.random);
  const base = JSON.parse(JSON.stringify(spec.body));
  const expect = spec.expect === null ? null : { revision: spec.expect.revision };
  const rule = spec.text;

  let state = 'ready';
  let closed = false;
  let typed = '';
  /** The page's refetch after an outcome that may have changed the row; "Review again" waits for it. @type {Promise<boolean>} */
  let refreshed = Promise.resolve(false);
  let reviewing = false;

  const title = h('h2', { class: 'confirm__title', id: `${id}-title` }, spec.title);
  const effect = h('p', { class: 'confirm__effect', id: `${id}-effect` }, spec.effect);
  const area = h('textarea', {
    class: 'confirm__input', id: `${id}-text`, rows: 3, 'aria-describedby': `${id}-count`, 'aria-required': rule !== null && rule.required ? 'true' : 'false', autocomplete: 'off',
    on: { input: () => { typed = String(area.value ?? ''); paint(); } },
  });
  const count = h('span', { class: 'confirm__count', id: `${id}-count`, dataset: { over: null } });
  const field = h('div', { class: 'confirm__field', hidden: rule === null }, rule === null ? [] : [h('label', { class: 'confirm__label', for: `${id}-text` }, rule.label), area, count]);
  const result = h('div', { class: 'confirm__result', role: 'status', 'aria-live': 'polite' });
  const cancel = h('button', { type: 'button', class: 'btn btn--secondary confirm__cancel', on: { click: () => close() } }, 'Cancel');
  const review = h('button', { type: 'button', class: 'btn btn--secondary confirm__review', hidden: true, on: { click: () => reviewAgain() } }, 'Review again');
  const verb = h('button', { type: 'button', class: 'btn btn--act confirm__verb', dataset: { tone: spec.tone }, on: { click: () => send() } }, spec.verb);
  const panel = h('div', { class: 'confirm__panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-effect` }, [
    title, effect, field, result, h('div', { class: 'confirm__actions' }, [cancel, review, verb]),
  ]);
  const scrim = h('div', { class: 'confirm__scrim', on: { click: () => { if (state !== 'sending') close(); } } });
  const root = h('div', { class: 'confirm', dataset: { state, action: spec.actionId } }, [scrim, panel]);

  /** @param {any} el @param {string} name @param {boolean} on */
  const setAttr = (el, name, on) => {
    if (on) el.setAttribute(name, '');
    else el.removeAttribute(name);
  };

  /** What the typed text allows: a spec with no field has nothing to type, so the verb is open. */
  const textOf = () => (rule === null ? { text: '', count: 0, ok: true, over: false } : textState(rule, typed));

  function paint() {
    const text = textOf();
    const settled = state !== 'ready' && state !== 'sending';
    root.dataset.state = state;
    if (rule !== null) count.textContent = `${text.count} / ${rule.max}`;
    if (text.over) count.dataset.over = 'true';
    else delete count.dataset.over;
    setAttr(area, 'disabled', state !== 'ready');
    setAttr(field, 'hidden', settled || rule === null);
    setAttr(verb, 'hidden', settled);
    setAttr(verb, 'disabled', state !== 'ready' || !text.ok);
    setAttr(cancel, 'disabled', state === 'sending');
    setAttr(review, 'hidden', state !== 'stale');
    setAttr(review, 'disabled', reviewing);
    cancel.textContent = settled ? 'Close' : 'Cancel';
  }

  /** @param {string[]} lines */
  function say(lines) {
    mount(result, lines.map((line) => h('p', { class: 'confirm__line' }, line)));
  }

  /** @type {string[]} */
  let staleLines = [];

  /** @param {any} reply the transport's reply, or null when it failed */
  function settle(reply) {
    const code = reply && reply.body && reply.body.error && typeof reply.body.error.code === 'string' ? reply.body.error.code : null;
    if (reply === null || reply.status === 504 || code === 'action-timeout') {
      state = 'unknown';
      say([typeof spec.unknown === 'string' ? spec.unknown : UNKNOWN_WORDS]);
      refreshed = askRefetch();
    } else if (reply.status === 200 && code === null) {
      state = 'applied';
      say([appliedWords(spec.actionId, spec.decision, reply)]);
      refreshed = askRefetch();
    } else if (reply.status === 409 && code === 'stale') {
      state = 'stale';
      staleLines = staleWords(spec.actionId, reply.body.current);
      say(staleLines);
      refreshed = askRefetch();
    } else {
      state = 'refused';
      const wait = reply.status === 429 && reply.headers && /^[0-9]{1,4}$/.test(String(reply.headers['retry-after'] ?? '')) ? [`Try again in ${reply.headers['retry-after']} s.`] : [];
      say(typeof spec.refusal === 'function' ? spec.refusal(code, reply) : [refusalWords(code), ...wait]);
    }
    if (typeof options.onReply === 'function') options.onReply(reply, state);
    paint();
    if (!closed) cancel.focus();
  }

  /** The only write of the page: it runs from the verb button's click and from nowhere else. */
  async function send() {
    const text = textOf();
    if (state !== 'ready' || !text.ok) return;
    state = 'sending';
    say(['Sending…']);
    paint();
    if (typeof options.onSend === 'function') options.onSend();
    const body = { ...base, requestId };
    if (rule !== null) body[rule.field] = text.text === '' ? null : text.text;
    if (expect !== null) body.expect = { ...expect };
    /** @type {any} */
    let reply = null;
    try {
      reply = await postAction(spec.actionId, body);
    } catch {
      reply = null;
    }
    if (closed) return;
    settle(reply);
  }

  function close() {
    if (closed) return;
    closed = true;
    if (active === handle) active = null;
    root.remove();
    // The opener while it is on the page; else, as keys.js's help list does, `#main` and then the view heading (162 review B-5).
    const back = opener && opener !== doc.body && typeof opener.focus === 'function' && opener.isConnected === true ? opener : doc.getElementById('main') ?? doc.querySelector('h1');
    if (back && typeof back.focus === 'function') back.focus();
    if (typeof options.onClose === 'function') options.onClose(state);
  }

  /**
   * The row changed under the dialog: once the page's refetch has answered, close it and open the spec the view builds from its
   * refreshed row. A row that still holds the revision this dialog was opened with is not built from: the dialog stays and says so.
   */
  async function reviewAgain() {
    if (state !== 'stale' || reviewing) return;
    reviewing = true;
    paint();
    await refreshed;
    reviewing = false;
    if (closed) return;
    const next = typeof spec.reopen === 'function' ? spec.reopen() : null;
    if (next && expect !== null && next.expect && next.expect.revision === expect.revision) {
      say([...staleLines, REREAD_WORDS]);
      paint();
      return;
    }
    close();
    if (next) openConfirm(next, options);
  }

  /** What Tab can reach, in order: the text field only while the dialog is still asking for it. */
  const items = () => [(state === 'ready' || state === 'sending') && rule !== null ? area : null, cancel, review, verb].filter((el) => el !== null && el.getAttribute('disabled') === null && el.getAttribute('hidden') === null);

  root.addEventListener('keydown', (/** @type {any} */ event) => {
    if (event.defaultPrevented) return;
    if (isKey(event, 'close')) {
      event.preventDefault();
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      if (state !== 'sending') close();
    } else if (event.key === 'Tab') {
      const list = items();
      const at = list.indexOf(doc.activeElement);
      if (list.length === 0) event.preventDefault();
      else if (event.shiftKey && (at === -1 || at === 0)) {
        event.preventDefault();
        list[list.length - 1].focus();
      } else if (!event.shiftKey && (at === -1 || at === list.length - 1)) {
        event.preventDefault();
        list[0].focus();
      }
    }
  });

  const handle = { el: root, close, state: () => state, requestId };
  active = handle;
  paint();
  host.append(root);
  cancel.focus();
  return handle;
}

/** Closes the dialog that is open, if any. */
function closeConfirm() {
  if (active) active.close();
}

/** Whether a confirmation dialog is open. */
const isConfirmOpen = () => active !== null;

// ---- the buttons that open it ---------------------------------------------------------------------------------------

/** @type {Set<{ el: any, paint: () => void }>} */
const areas = new Set();
/** @type {(() => void) | null} */
let stopListening = null;

/** Forgets every area taken off the page: the shell runs it after each paint, so a long-open page holds no detached node. */
function pruneActionAreas() {
  for (const area of [...areas]) if (area.el.isConnected === false) areas.delete(area);
}

/** Repaints every area still on the page when the page learns what it may do. */
function paintAreas() {
  pruneActionAreas();
  for (const area of areas) area.paint();
}

/**
 * A place on the page that shows action buttons or, where the action is not allowed, what it shows today. `build()` returns its
 * content from `actionPower(...)`, so it is drawn once now and again when `GET /api/actions` answers (the page asks once per load).
 * @param {() => any} build the nodes of the area (a node, an array or null)
 * @param {string} [className]
 */
function actionArea(build, className = 'acts') {
  const el = h('div', { class: className });
  const area = { el, paint: () => mount(el, build()) };
  areas.add(area);
  if (stopListening === null) stopListening = onActions(paintAreas);
  area.paint();
  void loadActions();
  return el;
}

/** Forgets every area and stops listening: the teardown of a view, and of a test. */
function releaseActionAreas() {
  areas.clear();
  if (stopListening !== null) stopListening();
  stopListening = null;
}

/**
 * The button of action `id` when the page may take it and `make()` can build its confirmation, else null. `make` is read when the
 * button is pressed and again by "Review again", so a poll that replaced the row in between is what the dialog is built from.
 * @param {{ id: string, label: string, tone: 'approve' | 'danger', make: () => any }} item
 */
function actionButton(item) {
  if (!actionPower(item.id).allowed || item.make() === null) return null;
  const open = () => {
    const spec = item.make();
    if (spec) openConfirm({ ...spec, reopen: item.make });
  };
  return h('button', { type: 'button', class: 'btn btn--act', dataset: { tone: item.tone, action: item.id }, on: { click: open } }, item.label);
}

/**
 * The one muted line that says why no button is drawn: the reason `GET /api/actions` gave for the first of `ids` that is not allowed.
 * Null while the page has not heard, when it failed, and when every action is allowed.
 * @param {string[]} ids
 */
function notAllowedLine(ids) {
  for (const id of ids) {
    const { allowed, reason } = actionPower(id);
    if (allowed) continue;
    const words = notAllowedWords(reason);
    if (words !== null) return h('p', { class: 'acts__reason' }, words);
  }
  return null;
}

export { newRequestId, onRefetch, openConfirm, closeConfirm, isConfirmOpen, actionArea, pruneActionAreas, releaseActionAreas, actionButton, notAllowedLine };
