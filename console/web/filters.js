// Saved filters (180 IC-180-B2, design §3, FR-B2): on Now and Sessions the filter shown (the chips, and on Now the project scope)
// can be kept under a name, applied with one click or from the command palette, and deleted. They live in this browser's storage
// only, under `doflow-console-filters` (`{ v: 1, views: { runs: [...], sessions: [...] } }`), read and written inside try/catch
// as theme.js does: a browser that refuses storage (a private window) keeps them for this page load only. Not used by Layers.
// Nothing here runs at import time.

import { h, icon, announce } from './dom.js';

const FILTERS_KEY = 'doflow-console-filters';
/** At most this many per view. */
const MAX_SAVED = 12;
/** A name is 1 to this many characters. */
const NAME_MAX = 40;
/** The views that keep filters, and the screen each one is. */
const VIEWS = Object.freeze({ runs: { name: 'Now', hash: '#/' }, sessions: { name: 'Sessions', hash: '#/sessions' } });
const SCOPES = ['every', 'this'];
/** A chip id: the ids Now and Sessions use (`needs`, `conflicts`, ...). */
const CHIP = /^[a-z][a-z-]{0,39}$/;
/** Control, format, line and paragraph separators, unassigned and private-use characters are not printable. */
const UNPRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/u;

/** What this load holds when storage refuses; `failed` once a write was refused, so a read does not return an older stored value. */
const held = { doc: /** @type {any} */ (null), failed: false };
/** A filter asked for from the palette, per view, until the view takes it. */
const pending = /** @type {Record<string, any>} */ ({});
/** The mounted view's redraw, per view. */
const followers = /** @type {Record<string, () => void>} */ ({});

/** For tests: a fresh module state, as after a reload. */
function resetFilters() {
  held.doc = null;
  held.failed = false;
  for (const key of Object.keys(pending)) delete pending[key];
  for (const key of Object.keys(followers)) delete followers[key];
}

/** The name, trimmed, when it is 1-40 printable characters; else null. @param {any} name */
function validName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  const length = [...trimmed].length;
  return length >= 1 && length <= NAME_MAX && !UNPRINTABLE.test(trimmed) ? trimmed : null;
}

/** A filter in its one stored form, or null: `{ chips }`, plus `scope` when it has one. @param {any} filter */
function normal(filter) {
  if (!filter || typeof filter !== 'object' || !Array.isArray(filter.chips) || !filter.chips.every((/** @type {any} */ chip) => typeof chip === 'string' && CHIP.test(chip))) return null;
  if (filter.scope !== undefined && !SCOPES.includes(filter.scope)) return null;
  return filter.scope === undefined ? { chips: [...filter.chips] } : { chips: [...filter.chips], scope: filter.scope };
}

/** The saved filters of every view, with bad entries dropped and each list cut to 12. */
function readAll() {
  /** @type {any} */
  let doc = held.doc;
  if (!held.failed) {
    try {
      const text = globalThis.localStorage.getItem(FILTERS_KEY);
      if (text !== null) doc = JSON.parse(text);
    } catch {
      // No storage or a value that is not JSON: what this load holds.
    }
  }
  /** @type {Record<string, Array<{ name: string, filter: any }>>} */
  const views = {};
  for (const view of Object.keys(VIEWS)) {
    const list = doc && doc.v === 1 && doc.views && Array.isArray(doc.views[view]) ? doc.views[view] : [];
    views[view] = list.flatMap((/** @type {any} */ item) => {
      const name = item && validName(item.name);
      const filter = item && normal(item.filter);
      return name !== null && filter !== null ? [{ name, filter }] : [];
    }).slice(0, MAX_SAVED);
  }
  return views;
}

/** @param {Record<string, any[]>} views */
function writeAll(views) {
  held.doc = { v: 1, views };
  try {
    globalThis.localStorage.setItem(FILTERS_KEY, JSON.stringify(held.doc));
  } catch {
    // No storage: the filters hold for this page load only.
    held.failed = true;
  }
}

/** The saved filters of `view`, oldest first. @param {string} view */
function saved(view) {
  return Object.hasOwn(VIEWS, view) ? readAll()[view] : [];
}

/**
 * Saves `filter` under `name` for `view`. The same name replaces its filter in place. Answers `saved`, `replaced`, `name` (the
 * name breaks the rule), `full` (12 are saved), or `view` (a view that keeps no filters).
 * @param {string} view @param {any} name @param {any} filter
 */
function save(view, name, filter) {
  if (!Object.hasOwn(VIEWS, view)) return 'view';
  const valid = validName(name);
  const value = normal(filter);
  if (valid === null || value === null) return 'name';
  const views = readAll();
  const list = views[view];
  const at = list.findIndex((item) => item.name === valid);
  if (at >= 0) list[at] = { name: valid, filter: value };
  else if (list.length >= MAX_SAVED) return 'full';
  else list.push({ name: valid, filter: value });
  writeAll(views);
  return at >= 0 ? 'replaced' : 'saved';
}

/** Deletes the filter `name` of `view`; false when there is none. @param {string} view @param {string} name */
function remove(view, name) {
  if (!Object.hasOwn(VIEWS, view)) return false;
  const views = readAll();
  const kept = views[view].filter((item) => item.name !== name);
  if (kept.length === views[view].length) return false;
  views[view] = kept;
  writeAll(views);
  return true;
}

/** Asks `view` to show `filter`: the mounted view is told at once; else the view takes it when it mounts. @param {string} view @param {any} filter */
function request(view, filter) {
  pending[view] = normal(filter);
  if (typeof followers[view] === 'function') followers[view]();
}

/** The filter asked for `view`, once, or null. @param {string} view */
function take(view) {
  const filter = pending[view] ?? null;
  delete pending[view];
  return filter;
}

/** The mounted view's redraw for a request; the latest mount replaces the one before. @param {string} view @param {() => void} fn */
function follow(view, fn) {
  followers[view] = fn;
}

/** The palette's entries: one per saved filter, "Filter: <name>"; choosing one asks its view for it, then goes there. */
function filterTargets() {
  return Object.entries(VIEWS).flatMap(([view, spec]) => saved(view).map((item) => ({
    kind: 'filter', label: `Filter: ${item.name}`, hint: `Saved filter · ${spec.name}`, hash: spec.hash, apply: () => request(view, item.filter),
  })));
}

/**
 * The saved filters of `view` as chips (pressed when it is the filter shown), each with its Delete button, and the field that
 * saves the filter shown. `current()` is the filter shown; `apply(filter, focusKey)` shows one and keeps the focus on the chip
 * pressed; `redraw(focusKey)` rebuilds this bar.
 * @param {string} view
 * @param {{ current: () => any, apply: (filter: any, focusKey: string) => void, redraw: (focusKey: string) => void }} options
 */
function savedBar(view, { current, apply, redraw }) {
  const shown = JSON.stringify(normal(current()));
  const chips = saved(view).flatMap((item, index) => [
    h('button', {
      type: 'button', class: 'chip', 'aria-pressed': JSON.stringify(item.filter) === shown ? 'true' : 'false', dataset: { focusKey: `saved:${index}` },
      on: { click: () => apply(item.filter, `saved:${index}`) },
    }, item.name),
    h('button', {
      type: 'button', class: 'btn btn--ghost', 'aria-label': `Delete the saved filter ${item.name}`, dataset: { focusKey: `saved-delete:${index}` },
      on: { click: () => { remove(view, item.name); redraw('saved-name'); announce(`Deleted the saved filter ${item.name}.`); } },
    }, icon('close', 16)),
  ]);
  const input = h('input', {
    type: 'text', class: 'pair__input', maxlength: String(NAME_MAX), autocomplete: 'off', spellcheck: 'false', placeholder: 'Name this filter',
    'aria-label': 'Name of the filter to save', dataset: { focusKey: 'saved-name' },
  });
  const note = h('span', { role: 'status' });
  const submit = (/** @type {any} */ event) => {
    event.preventDefault();
    const result = save(view, input.value, current());
    if (result === 'name') note.textContent = `Give it a name of 1 to ${NAME_MAX} characters, on one line.`;
    else if (result === 'full') note.textContent = `${MAX_SAVED} filters are saved here, the most there can be. Delete one first.`;
    else {
      redraw('saved-name');
      announce(result === 'replaced' ? 'Saved filter replaced.' : 'Filter saved.');
    }
  };
  return h('form', { class: 'saved-filters', role: 'group', 'aria-label': 'Saved filters', on: { submit } }, [
    ...chips, input, h('button', { type: 'submit', class: 'btn btn--ghost', dataset: { focusKey: 'saved-add' } }, 'Save filter'), note,
  ]);
}

export { FILTERS_KEY, MAX_SAVED, NAME_MAX, validName, saved, save, remove, request, take, follow, filterTargets, savedBar, resetFilters };
