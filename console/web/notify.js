// Now's browser side (180 C3, design §2; FR-A4..A6): the look this browser keeps and the opt-in notification. The only file
// that names the browser's notification API, so the permission prompt has one audited place: `ask()` is called from the
// switch's click handler only. Both keys live in localStorage inside try/catch, as theme.js does: without storage they hold for
// this page load only. A notification says the project label, the run's slug and the gate name, from the masked envelope; nothing
// is sent anywhere else. Nothing here runs at import time.

import { lookKey } from './derive/digest.js';

const SEEN_KEY = 'doflow-console-now-seen';
const NOTIFY_KEY = 'doflow-console-notify';

/** What this load holds when storage refuses. */
const held = { seen: /** @type {any} */ (null), on: false };
/** The runs a notification was raised for while they wait (one each). */
const raised = new Set();

/** The stored look, as parsed (digest.js checks its shape), or null. */
function readSeen() {
  let text;
  try {
    text = globalThis.localStorage.getItem(SEEN_KEY);
  } catch {
    return held.seen;
  }
  if (text === null) return held.seen;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @param {{ at: number, states: Record<string, string> }} look */
function writeSeen(look) {
  held.seen = look;
  try {
    globalThis.localStorage.setItem(SEEN_KEY, JSON.stringify(look));
  } catch {
    // No storage: the look holds for this page load only.
  }
}

/** Whether the person switched notifications on. */
function notifyOn() {
  try {
    const stored = globalThis.localStorage.getItem(NOTIFY_KEY);
    return stored === null ? held.on : stored === 'on';
  } catch {
    return held.on;
  }
}

/** @param {boolean} on */
function setNotify(on) {
  held.on = on;
  try {
    globalThis.localStorage.setItem(NOTIFY_KEY, on ? 'on' : 'off');
  } catch {
    // No storage: the switch holds for this page load only.
  }
}

/** Whether this browser has notifications (a secure context: loopback or the LAN TLS mode). */
const canNotify = () => typeof globalThis.Notification === 'function';

/** `granted`, `denied`, `default`, or `unsupported`. */
const permission = () => (canNotify() ? String(globalThis.Notification.permission) : 'unsupported');

/** Switched on and allowed. */
const notifyActive = () => canNotify() && permission() === 'granted' && notifyOn();

/**
 * Asks the browser's permission, from a click only (a prompt without a gesture is refused), and switches on when granted. The
 * request is made before any await, inside the click's activation. Resolves to the permission.
 * @returns {Promise<string>}
 */
function ask() {
  if (!canNotify()) return Promise.resolve('unsupported');
  return new Promise((resolve) => {
    // Older browsers answer through the callback and return nothing.
    const answer = globalThis.Notification.requestPermission(resolve);
    if (answer && typeof answer.then === 'function') answer.then(resolve, () => resolve(permission()));
  }).then((value) => {
    if (value === 'granted') setNotify(true);
    return String(value);
  });
}

/** The words of a notification: project label, slug and gate name. @param {any} row */
const bodyOf = (row) => [row.projectLabel, row.slug, row.gateName].filter((part) => typeof part === 'string' && part !== '').join(' · ');

/**
 * One notification per run that waits at a gate now, did not wait at the last look and has none raised yet, while the tab is
 * hidden and notifications are on and allowed. Returns how many were raised.
 * @param {any[]} rows the open runs of every shown project @param {any} seen the stored look
 */
function notifyWaiting(rows, seen) {
  const waiting = rows.filter((row) => row.state === 'AWAITING_GATE');
  const now = new Set(waiting.map(lookKey));
  for (const key of [...raised]) if (!now.has(key)) raised.delete(key);
  if (!notifyActive() || globalThis.document.hidden !== true) return 0;
  const before = seen && typeof seen === 'object' && seen.states && typeof seen.states === 'object' ? seen.states : {};
  let count = 0;
  for (const row of waiting) {
    const key = lookKey(row);
    if (raised.has(key) || before[key] === 'AWAITING_GATE') continue;
    raised.add(key);
    try {
      const note = new globalThis.Notification('Waiting for you', { body: bodyOf(row) });
      note.addEventListener('click', () => { globalThis.focus(); note.close(); });
      count += 1;
    } catch {
      // A browser that shows notifications only from a service worker refuses the constructor: nothing is raised.
    }
  }
  return count;
}

/** For tests: a fresh module state, as after a reload. */
function resetNotify() {
  held.seen = null;
  held.on = false;
  raised.clear();
}

export { SEEN_KEY, NOTIFY_KEY, readSeen, writeSeen, notifyOn, setNotify, canNotify, permission, notifyActive, ask, notifyWaiting, resetNotify };
