// The shell's inspector (feature 149, IC-020, DEC-036): one details region whose mode follows the viewport width.
//   dock    1280 px and wider: a column of the shell grid, present on every inspectable view (the empty note while nothing
//           is open), a complementary landmark that never takes or traps focus;
//   drawer  768 to 1279 px: fixed at the right over the canvas, with the scrim; a modal dialog while open;
//   sheet   below 768 px: fixed at the bottom over the canvas, with the scrim; a modal dialog while open.
// The canvas never reflows: the docked column exists whether or not anything is open, and the drawer and sheet overlay it.
// Escape is keys.js's `close` entry, asked through `isKey`; the listener sits on the inspector, never on the document
// (only keys.js binds the document). Nothing here runs at import time.

import { h, icon, mount } from './dom.js';
import { isKey } from './keys.js';

const DOCK_QUERY = '(min-width: 1280px)';
const DRAWER_QUERY = '(min-width: 768px)';
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';
const DEFAULT_TITLE = 'Details';

/** @param {any} node @param {boolean} hide */
function setHidden(node, hide) {
  if (!node) return;
  if (hide) node.setAttribute('hidden', '');
  else node.removeAttribute('hidden');
}

/** @param {any} node */
const focusable = (node) => Boolean(node && typeof node.focus === 'function');

/**
 * Wires the inspector of index.html. Returns `{ open, close, isOpen, mode, setInspectable }`:
 *   open({ title, body, owner, onClose }) shows `body` (a node, text or an array of them, as `mount` takes) under the heading
 *     `title`. `owner` is the control that opened it, where focus returns on close (default: the element focused at open).
 *     Opening again replaces the content and calls the previous `onClose`. As drawer or sheet, focus moves to the close button.
 *   close() empties it and calls `onClose`; as drawer or sheet, focus returns to the owner, or to #main when the owner is gone.
 *   setInspectable(on) marks the shell for the current view: the docked column is present exactly on inspectable views.
 * @param {object} options
 * @param {any} options.doc the document
 * @param {any} options.shell `#shell`
 * @param {any} options.el `#inspector`
 * @param {any} options.main `#main`, where focus goes when the owner no longer exists
 * @param {((query: string) => any) | undefined} [options.matchMedia] absent: always docked
 */
function createInspector(options) {
  const { doc, shell, el, main } = options;
  const title = el.querySelector('.inspector__title');
  const body = el.querySelector('.inspector__body');
  const empty = el.querySelector('.inspector__empty');
  const closeButton = el.querySelector('.inspector__close');
  if (closeButton) {
    if (!closeButton.querySelector('.icon')) closeButton.prepend(icon('close', 16));
    closeButton.addEventListener('click', () => close());
  }
  const scrim = h('div', { class: 'inspector__scrim', hidden: true, on: { click: () => close() } });
  shell.append(scrim);

  const lists = typeof options.matchMedia === 'function' ? [options.matchMedia(DOCK_QUERY), options.matchMedia(DRAWER_QUERY)] : [];
  const readMode = () => (lists.length === 0 || lists[0].matches ? 'dock' : lists[1].matches ? 'drawer' : 'sheet');
  let mode = readMode();
  /** @type {{ onClose: any, opener: any } | null} */
  let current = null;

  function sync() {
    const open = current !== null;
    const modal = open && mode !== 'dock';
    el.dataset.mode = mode;
    // Docked, the column follows the view, open or not; as drawer or sheet it shows only while open.
    setHidden(el, mode === 'dock' ? shell.dataset.inspectable !== 'true' : !open);
    setHidden(empty, open);
    setHidden(scrim, !modal);
    if (modal) {
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
    } else {
      el.removeAttribute('role');
      el.removeAttribute('aria-modal');
    }
  }

  for (const list of lists) {
    if (list && typeof list.addEventListener === 'function') list.addEventListener('change', onModeChange);
  }

  // Open across a change into drawer or sheet, it becomes a modal dialog: focus moves in, to the close button as on open,
  // unless it is already inside. The owner kept from open is where close returns it.
  function onModeChange() {
    mode = readMode();
    sync();
    if (current !== null && mode !== 'dock' && !el.contains(doc.activeElement) && focusable(closeButton)) closeButton.focus();
  }

  /** @param {{ title?: any, body?: any, owner?: any, onClose?: any }} [spec] */
  function open(spec = {}) {
    const previous = current;
    const opener = focusable(spec.owner) ? spec.owner : previous ? previous.opener : doc.activeElement;
    // The replaced content's owner hears it closed first; a close() it makes from there is a no-op.
    current = null;
    if (previous && typeof previous.onClose === 'function') previous.onClose();
    current = { onClose: spec.onClose ?? null, opener };
    if (title) title.textContent = String(spec.title ?? DEFAULT_TITLE);
    if (body) mount(body, spec.body ?? []);
    sync();
    if (mode !== 'dock' && focusable(closeButton)) closeButton.focus();
  }

  function close() {
    if (current === null) return;
    const { onClose, opener } = current;
    const modal = mode !== 'dock';
    current = null;
    if (title) title.textContent = DEFAULT_TITLE;
    if (body) mount(body, []);
    sync();
    if (modal) {
      const back = focusable(opener) && opener !== doc.body && doc.body.contains(opener) && !el.contains(opener) ? opener : main;
      if (focusable(back)) back.focus();
    }
    if (typeof onClose === 'function') onClose();
  }

  /** Tab and Shift+Tab wrap inside the dialog. @param {any} event */
  function trap(event) {
    const items = Array.from(el.querySelectorAll(FOCUSABLE)).filter((/** @type {any} */ node) => node.getAttribute('tabindex') !== '-1'
      && node.getAttribute('disabled') === null && !node.closest('[hidden]'));
    const active = doc.activeElement;
    const inside = el.contains(active);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && (!inside || active === items[0])) {
      event.preventDefault();
      items[items.length - 1].focus();
    } else if (!event.shiftKey && (!inside || active === items[items.length - 1])) {
      event.preventDefault();
      items[0].focus();
    }
  }

  el.addEventListener('keydown', (/** @type {any} */ event) => {
    if (event.defaultPrevented || current === null) return;
    if (isKey(event, 'close')) {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab' && mode !== 'dock') trap(event);
  });

  /** @param {boolean} on */
  function setInspectable(on) {
    shell.dataset.inspectable = on ? 'true' : 'false';
    sync();
  }

  sync();
  return { open, close, isOpen: () => current !== null, mode: () => mode, setInspectable };
}

/**
 * Shows a view's panel in the inspector (149 D.2, DEC-010). `local` is the view's own memory, kept across the re-mount of a
 * poll, so a view re-shows its open panel on every re-mount. `spec.onClose` runs only when the inspector closes this showing
 * (its close control, Escape or the scrim), never when a later showing replaces it or `hidePanel` takes it away.
 * Without an inspector (a page without the shell) nothing is shown.
 * @param {any} inspector @param {any} local @param {{ title?: any, body?: any, owner?: any, onClose?: () => void }} spec
 */
function showPanel(inspector, local, spec) {
  if (!inspector) return;
  const seq = (local.inspectorSeq = (local.inspectorSeq ?? 0) + 1);
  inspector.open({ ...spec, onClose: () => { if (local.inspectorSeq === seq && typeof spec.onClose === 'function') spec.onClose(); } });
}

/** The view takes its panel away itself (a toggle, its own close control, a route change): its `onClose` is not called. @param {any} inspector @param {any} local */
function hidePanel(inspector, local) {
  if (!inspector) return;
  local.inspectorSeq = (local.inspectorSeq ?? 0) + 1;
  inspector.close();
}

export { DOCK_QUERY, DRAWER_QUERY, createInspector, showPanel, hidePanel };
