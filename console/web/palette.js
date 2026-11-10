// The command palette (149 IC-021, DEC-011, DEC-037): a modal combobox that jumps to a screen, a run, a session lane or a
// Fleet project the page has already loaded. It never fetches: `targets()` reads what the shell holds in memory, and a
// choice only sets `location.hash` through `go`. keys.js opens it (Ctrl K or Cmd K); its own input handles the keys inside it,
// asking keys.js which key is "move" and which is "close". Nothing here runs at import time.

import { h, mount } from './dom.js';
import { isKey } from './keys.js';

/** At most this many options are listed. */
const MAX_OPTIONS = 50;

/** The order of the kinds in the list: screens first, then actions, runs, sessions and projects. */
const KIND_ORDER = Object.freeze(['screen', 'action', 'run', 'session', 'project']);

/**
 * The options for `query`: a case-insensitive substring match over `label` and `hint`, in kind order and, within a kind, in
 * the loaded order; at most 50. An empty query lists the screens and then the runs.
 * @param {ReadonlyArray<{ kind: string, label: string, hint: string, hash: string }>} list
 * @param {string} query
 */
function matchTargets(list, query) {
  const needle = query.trim().toLowerCase();
  const ordered = KIND_ORDER.flatMap((kind) => list.filter((target) => target.kind === kind));
  const hits = needle === ''
    ? ordered.filter((target) => target.kind === 'screen' || target.kind === 'run')
    : ordered.filter((target) => target.label.toLowerCase().includes(needle) || target.hint.toLowerCase().includes(needle));
  return hits.slice(0, MAX_OPTIONS);
}

/**
 * Builds the palette lazily on first open. `targets()` returns `{ kind, label, hint, hash }[]` from data the page holds;
 * `go(hash)` moves to a target (the shell sets `location.hash`). Returns `{ open, close, isOpen }`.
 * @param {object} options
 * @param {any} options.doc the document
 * @param {() => ReadonlyArray<{ kind: string, label: string, hint: string, hash: string }>} options.targets
 * @param {(hash: string) => void} options.go
 */
function createPalette(options) {
  const { doc, targets, go } = options;
  /** @type {any} */
  let overlay = null;
  /** @type {any} */
  let input = null;
  /** @type {any} */
  let list = null;
  /** @type {any} */
  let none = null;
  /** @type {any} */
  let opener = null;
  /** @type {Array<{ kind: string, label: string, hint: string, hash: string }>} */
  let shown = [];
  let active = 0;

  const optionId = (/** @type {number} */ index) => `palette-opt-${index}`;

  function render() {
    shown = matchTargets(targets(), String(input.value ?? ''));
    if (active >= shown.length) active = Math.max(0, shown.length - 1);
    const items = shown.map((target, index) => h('li', {
      id: optionId(index), class: 'palette__option', role: 'option', 'aria-selected': String(index === active), dataset: { kind: target.kind },
      on: { click: () => choose(index) },
    }, [h('span', { class: 'palette__label' }, target.label), h('span', { class: 'palette__hint' }, target.hint)]));
    mount(list, items);
    input.setAttribute('aria-expanded', String(shown.length > 0));
    if (shown.length > 0) input.setAttribute('aria-activedescendant', optionId(active));
    else input.removeAttribute('aria-activedescendant');
    if (shown.length === 0) list.setAttribute('hidden', '');
    else list.removeAttribute('hidden');
    if (shown.length > 0) none.setAttribute('hidden', '');
    else none.removeAttribute('hidden');
    const current = items[active];
    if (current && typeof current.scrollIntoView === 'function') current.scrollIntoView({ block: 'nearest' });
  }

  /** @param {number} index */
  function choose(index) {
    const target = shown[index];
    if (!target) return;
    close();
    go(target.hash);
  }

  /** @param {any} event */
  function onKeydown(event) {
    if (isKey(event, 'close')) {
      event.preventDefault();
      close();
    } else if (isKey(event, 'move') && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      if (shown.length === 0) return;
      active = (active + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(active);
    } else if (event.key === 'Tab') {
      // The input is the dialog's one tab stop: focus stays inside.
      event.preventDefault();
    }
  }

  function build() {
    input = h('input', {
      type: 'text', id: 'palette-input', class: 'palette__input', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'palette-list',
      'aria-autocomplete': 'list', 'aria-labelledby': 'palette-title', autocomplete: 'off', spellcheck: 'false', placeholder: 'Type part of a name',
      on: { keydown: onKeydown, input: () => { active = 0; render(); } },
    });
    list = h('ul', { id: 'palette-list', class: 'palette__list', role: 'listbox', 'aria-label': 'Matches' });
    none = h('p', { class: 'palette__none', hidden: true }, 'Nothing this page has loaded matches.');
    const panel = h('div', {
      class: 'palette__panel',
      // A press anywhere in the panel but the input keeps the focus in the input, so the keys keep working.
      on: { mousedown: (/** @type {any} */ event) => { if (event.target !== input) event.preventDefault(); } },
    }, [
      h('h2', { class: 'palette__title', id: 'palette-title' }, 'Go to a screen, run, session or project'),
      input,
      list,
      none,
      h('p', { class: 'palette__note' }, 'Lists what this page has already loaded.'),
    ]);
    return h('div', {
      class: 'palette', id: 'palette', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'palette-title',
      on: { click: (/** @type {any} */ event) => { if (event.target === overlay) close(); } },
    }, [panel]);
  }

  const isOpen = () => overlay !== null && overlay.getAttribute('hidden') === null;

  function open() {
    if (isOpen()) return;
    if (overlay === null) {
      overlay = build();
      doc.body.append(overlay);
    }
    opener = doc.activeElement;
    input.value = '';
    active = 0;
    render();
    overlay.removeAttribute('hidden');
    input.focus();
  }

  function close() {
    if (!isOpen()) return;
    overlay.setAttribute('hidden', '');
    const back = opener && typeof opener.focus === 'function' && doc.body.contains(opener) ? opener : null;
    opener = null;
    if (back) {
      back.focus();
      return;
    }
    // The opener was rebuilt while the palette was open (a poll re-mounted the view): the main region, then the heading.
    const fallback = doc.getElementById('main') ?? doc.querySelector('h1');
    if (fallback && typeof fallback.focus === 'function') fallback.focus();
  }

  return { open, close, isOpen };
}

export { MAX_OPTIONS, matchTargets, createPalette };
