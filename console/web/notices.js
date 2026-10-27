// The notifications of the shell (feature 133, FR-3): a small fixed set, spoken through the polite live region (there is no toast
// UI). A key outside the set is dropped, and a system notice is not repeated within NOTICE_GAP_MS, so a flapping connection or a
// reconnect says each thing once. The person's own pause and resume are always spoken. Nothing here runs at import time.

import { announce } from './dom.js';

/** Notice key to the sentence; `{0}` is the one detail a notice may carry. */
const NOTICES = Object.freeze({
  stale: 'Data is out of date. Last updated {0}.',
  fresh: 'Up to date again.',
  paused: 'Updates paused.',
  resumed: 'Updates resumed.',
  resynced: 'Reconnected. The view was refreshed in full.',
  'core-back': 'DoFlow is reachable again.',
  'push-lost': 'Push unavailable; polling every 5 seconds.',
  'push-back': 'Push restored.',
});

/** Keys caused by the person; they are never held back. */
const OWN_KEYS = Object.freeze(['paused', 'resumed']);
const NOTICE_GAP_MS = 10_000;

/** @type {Map<string, number>} */
const lastAt = new Map();

/**
 * @param {keyof typeof NOTICES} key
 * @param {string} [detail]
 * @param {number} [now] epoch ms (tests pass it)
 * @returns {boolean} whether the notice was spoken
 */
function notice(key, detail = '', now = Date.now()) {
  const template = NOTICES[key];
  if (template === undefined) return false;
  const last = lastAt.get(key);
  if (!OWN_KEYS.includes(key) && last !== undefined && now - last < NOTICE_GAP_MS) return false;
  lastAt.set(key, now);
  announce(template.replace('{0}', detail));
  return true;
}

/** For tests: a fresh memory, as after a reload. */
function resetNotices() {
  lastAt.clear();
}

export { NOTICES, NOTICE_GAP_MS, notice, resetNotices };
