// The one keyboard-shortcut registry (feature 133, FR-6; design.md D7). Every key binding of the Console is named here: the global
// ones (go to a view, pause, help), the view-scoped Escape that closes a panel (views ask `isKey(event, 'close')`), and the
// roving-tabindex arrow groups, which stay with their widgets and are listed so the `?` help shows them. The help overlay is built
// from this table, so the list cannot differ from what is bound. Nothing here runs at import time.

import { h, icon } from './dom.js';

/**
 * `keys` is the key (`event.key`) or, with `chord: true`, the sequence (the first key arms the chord, the second completes it).
 * `scope`: `global` (document-wide, ignored while typing), `view` (bound by the view that owns the widget), `widget` (an arrow group).
 * @type {ReadonlyArray<{ id: string, scope: 'global' | 'view' | 'widget', keys: string[], chord?: boolean, label: string, where?: string }>}
 */
const SHORTCUTS = Object.freeze([
  { id: 'help', scope: 'global', keys: ['?'], label: 'Show or hide this list' },
  { id: 'pause', scope: 'global', keys: ['p'], label: 'Pause or resume updates for this view' },
  { id: 'go.runs', scope: 'global', keys: ['g', 'r'], chord: true, label: 'Go to Runs' },
  { id: 'go.workflows', scope: 'global', keys: ['g', 'w'], chord: true, label: 'Go to Workflows' },
  { id: 'go.sessions', scope: 'global', keys: ['g', 's'], chord: true, label: 'Go to Sessions' },
  { id: 'go.fleet', scope: 'global', keys: ['g', 'f'], chord: true, label: 'Go to Fleet' },
  { id: 'close', scope: 'view', keys: ['Escape'], label: 'Close the open details panel (or this list)', where: 'Run rail, Tasks board, Sessions, Fleet' },
  { id: 'move', scope: 'widget', keys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'], label: 'Move between items; the focused item is the one tab stop', where: 'Run rail, Tasks board, Sessions, Fleet tree, theme control, filter chips' },
]);

/** How long the first key of a chord waits for the second. */
const CHORD_MS = 1500;

/**
 * Whether `event` is the (single) key of the view-scoped entry `id`.
 * @param {any} event
 * @param {string} id
 */
function isKey(event, id) {
  const entry = SHORTCUTS.find((item) => item.id === id && !item.chord);
  return entry !== undefined && entry.keys.includes(event.key);
}

/** Printed form of a key. @param {string} key */
const keyName = (key) => ({ Escape: 'Esc', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }[/** @type {'Escape'} */ (key)] ?? key);

/** The help list as element data: rows grouped by scope. */
function helpRows() {
  /** @type {Record<string, string>} */
  const titles = { global: 'Anywhere', view: 'In a view', widget: 'In a list, rail or board' };
  return ['global', 'view', 'widget'].map((scope) => ({
    title: titles[scope],
    items: SHORTCUTS.filter((item) => item.scope === scope).map((item) => ({
      id: item.id,
      label: item.label,
      where: item.where ?? '',
      keys: item.chord ? [item.keys.join(' then ')] : item.keys.map(keyName),
    })),
  }));
}

/** Typing in a field must never trigger a shortcut. @param {any} target */
function isTyping(target) {
  if (!target) return false;
  const tag = String(target.tagName ?? '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
}

/**
 * Binds the global shortcuts to `doc`. `actions` maps an entry id to what it does; an id without an action is ignored. Returns
 * `{ openHelp, closeHelp, helpOpen, destroy }`.
 * @param {object} options
 * @param {any} options.doc the document
 * @param {Record<string, () => void>} options.actions
 * @param {(fn: () => void, ms: number) => any} [options.setTimer]
 * @param {(handle: any) => void} [options.clearTimer]
 */
function installShortcuts(options) {
  const { doc, actions } = options;
  const setTimer = options.setTimer ?? ((/** @type {() => void} */ fn, /** @type {number} */ ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((/** @type {any} */ handle) => globalThis.clearTimeout(handle));
  /** @type {any} */
  let overlay = null;
  /** @type {any} */
  let opener = null;
  /** @type {any} */
  let closeButton = null;
  /** @type {any} */
  let armed = null;

  function disarm() {
    if (armed !== null) clearTimer(armed);
    armed = null;
  }

  function build() {
    const groups = helpRows().map((group, index) => h('section', { class: 'help__group', 'aria-labelledby': `help-g${index}` }, [
      h('h3', { class: 'help__group-title', id: `help-g${index}` }, group.title),
      h('dl', { class: 'help__list' }, group.items.flatMap((item) => [
        h('dt', { class: 'help__keys' }, item.keys.map((key) => h('kbd', { class: 'help__key' }, key))),
        h('dd', { class: 'help__label' }, item.where === '' ? item.label : `${item.label} (${item.where})`),
      ])),
    ]));
    closeButton = h('button', { type: 'button', class: 'btn btn--ghost help__close', on: { click: () => closeHelp() } }, [icon('close', 16), h('span', { class: 'vh' }, 'Close the shortcut list')]);
    return h('div', { class: 'help', id: 'help', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'help-title' }, [
      h('div', { class: 'help__panel' }, [
        h('div', { class: 'help__head' }, [h('h2', { class: 'help__title', id: 'help-title' }, 'Keyboard shortcuts'), closeButton]),
        h('p', { class: 'help__note' }, 'Shortcuts are off while you type in a field.'),
        ...groups,
      ]),
    ]);
  }

  const helpOpen = () => overlay !== null && overlay.getAttribute('hidden') === null;

  function openHelp() {
    if (overlay === null) {
      overlay = build();
      doc.body.append(overlay);
    }
    opener = doc.activeElement;
    overlay.removeAttribute('hidden');
    closeButton.focus();
  }

  function closeHelp() {
    if (!helpOpen()) return;
    overlay.setAttribute('hidden', '');
    const back = opener && typeof opener.focus === 'function' && doc.body.contains(opener) ? opener : null;
    opener = null;
    if (back) back.focus();
  }

  

  /** @param {any} event */
  function onKeydown(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (helpOpen()) {
      // The dialog is modal: Escape or ? close it, Tab stays on its one control, nothing else reaches the page.
      if (event.key === 'Escape' || event.key === '?') {
        event.preventDefault();
        closeHelp();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        closeButton.focus();
      }
      return;
    }
    if (isTyping(event.target)) return;
    if (armed !== null) {
      disarm();
      const hit = SHORTCUTS.find((item) => item.chord === true && item.keys[1] === event.key);
      if (hit && actions[hit.id]) {
        event.preventDefault();
        actions[hit.id]();
        return;
      }
    }
    if (SHORTCUTS.some((item) => item.chord === true && item.keys[0] === event.key)) {
      armed = setTimer(() => { armed = null; }, CHORD_MS);
      return;
    }
    const hit = SHORTCUTS.find((item) => item.scope === 'global' && !item.chord && item.keys[0] === event.key);
    if (!hit) return;
    if (hit.id === 'help') {
      event.preventDefault();
      openHelp();
    } else if (actions[hit.id]) {
      event.preventDefault();
      actions[hit.id]();
    }
  }

  doc.addEventListener('keydown', onKeydown);
  return {
    openHelp,
    closeHelp,
    helpOpen,
    destroy() {
      disarm();
      doc.removeEventListener('keydown', onKeydown);
    },
  };
}

export { SHORTCUTS, CHORD_MS, isKey, helpRows, installShortcuts };
