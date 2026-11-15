// The theme choice (Light, Dark, System) and its control. The app bar holds one control from 768 px (index.html) and the More
// page builds another, the only one a phone shows; a choice made in one is shown by every control on the page. The choice is
// kept in localStorage under `doflow-console-theme` inside try/catch: without storage it holds for this page load only.
// Nothing here runs at import time.

import { h, icon } from './dom.js';

const STORAGE_KEY = 'doflow-console-theme';
/** The choices in the order the control shows them, with their words and icons. */
const THEME_CHOICES = Object.freeze([
  { id: 'light', label: 'Light', mark: 'sun' },
  { id: 'dark', label: 'Dark', mark: 'moon' },
  { id: 'system', label: 'System', mark: 'monitor' },
]);

/** The stored choice: `light`, `dark` or `system` (nothing stored, or no storage). */
function readTheme() {
  try {
    const stored = globalThis.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Sets the theme on the root element: System removes the attribute, so the media query decides. @param {any} choice */
function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
}

/** Marks the radio of `choice` in every theme control of the page. @param {any} choice */
function syncThemeControls(choice) {
  for (const radio of /** @type {any[]} */ (Array.from(document.querySelectorAll('[data-theme-choice]')))) {
    const on = radio.dataset.themeChoice === choice;
    radio.setAttribute('aria-checked', on ? 'true' : 'false');
    radio.setAttribute('tabindex', on ? '0' : '-1');
  }
}

/** Applies and stores a choice with transitions off, then marks every control. @param {any} choice */
function chooseTheme(choice) {
  const root = document.documentElement;
  root.classList.add('theme-switching');
  applyTheme(choice);
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // No storage: the choice holds for this page load only.
  }
  syncThemeControls(choice);
  // Reading a layout value applies the new theme while transitions are off; the class goes on the next task, with no frame callback.
  void root.offsetWidth;
  globalThis.setTimeout(() => root.classList.remove('theme-switching'), 0);
}

/**
 * Wires one theme control. APG radio group: arrows move and select (wrapping), Home and End jump; Space and Enter click natively.
 * @param {any} group the `.theme` element
 */
function setupThemeControl(group) {
  if (!group) return;
  const radios = Array.from(group.querySelectorAll('[data-theme-choice]'));
  const marks = Object.fromEntries(THEME_CHOICES.map((choice) => [choice.id, choice.mark]));
  // The applied theme, not the stored one: without storage a choice made on this page lives only on the root element.
  const applied = document.documentElement.dataset.theme;
  const current = applied === 'light' || applied === 'dark' ? applied : 'system';
  for (const radio of radios) {
    if (!radio.querySelector('.icon')) radio.prepend(icon(marks[radio.dataset.themeChoice], 16));
    radio.addEventListener('click', () => chooseTheme(radio.dataset.themeChoice));
    radio.addEventListener('keydown', (/** @type {any} */ event) => {
      const at = radios.indexOf(radio);
      /** @type {Record<string, number>} */
      const steps = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
      const move = steps[event.key];
      let to = null;
      if (move !== undefined) to = (at + move + radios.length) % radios.length;
      else if (event.key === 'Home') to = 0;
      else if (event.key === 'End') to = radios.length - 1;
      if (to === null) return;
      event.preventDefault();
      radios[to].focus();
      chooseTheme(radios[to].dataset.themeChoice);
    });
    const on = radio.dataset.themeChoice === current;
    radio.setAttribute('aria-checked', on ? 'true' : 'false');
    radio.setAttribute('tabindex', on ? '0' : '-1');
  }
}

/** A wired theme control with its words shown, as the More page holds it. */
function buildThemeControl() {
  const group = h('div', { class: 'theme theme--labelled', role: 'radiogroup', 'aria-label': 'Theme' }, THEME_CHOICES.map((choice) => h('button', {
    type: 'button', role: 'radio', class: 'theme__opt', 'aria-checked': 'false', tabindex: '-1', dataset: { themeChoice: choice.id },
  }, h('span', { class: 'theme__label' }, choice.label))));
  setupThemeControl(group);
  return group;
}

export { THEME_CHOICES, readTheme, applyTheme, chooseTheme, setupThemeControl, buildThemeControl };
