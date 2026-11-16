// The More page (`#/more`): the destinations a phone's tab bar has no room for, the theme control (the app bar shows it only
// from 768 px) and what this Console runs on. It reads nothing: the links are the same hashes the rail holds from 768 px, and
// the core version is the one the shell already read from /api/info. Every string is a text node.

import { h, icon } from '../dom.js';
import { buildThemeControl } from '../theme.js';

/** The Manage destinations, in the rail's order, each with the icon the rail shows and one line on what it answers. */
const MORE_LINKS = Object.freeze([
  { href: '#/followups', label: 'Follow-ups', mark: 'rail-followups', hint: 'Work that was put off, and who owns it' },
  { href: '#/workflows', label: 'Workflows', mark: 'rail-workflows', hint: 'The steps each kind of work goes through' },
  { href: '#/workers', label: 'Workers', mark: 'rail-workers', hint: 'What each coding tool can do as a worker' },
  { href: '#/advice', label: 'Advice', mark: 'rail-advice', hint: 'What the decision model picked, and what was done with it' },
  { href: '#/settings', label: 'Settings', mark: 'rail-settings', hint: 'The values DoFlow resolves, and the layer each comes from' },
  { href: '#/health', label: 'Health', mark: 'rail-health', hint: 'Doctor findings and the state stores' },
]);

/** Records that have no tab of their own. */
const RECORD_LINKS = Object.freeze([
  { href: '#/sessions/history', label: 'Session history', mark: 'rail-sessions', hint: 'Finished sessions of the last 30 days' },
  { href: '#/compare', label: 'Compare runs', mark: 'rail-now', hint: 'Two runs side by side: stages, durations and tokens' },
]);

/** @param {{ href: string, label: string, mark: string, hint: string }} link */
const item = (link) => h('li', {}, h('a', { class: 'more__item', href: link.href, dataset: { focusKey: `more:${link.href}` } }, [
  icon(link.mark, 20),
  h('span', { class: 'more__text' }, [h('span', { class: 'more__label' }, link.label), h('span', { class: 'more__hint' }, link.hint)]),
  icon('chevron-right', 16),
]));

/** @param {string} id @param {string} title @param {any} body */
const section = (id, title, body) => h('section', { class: 'more__section', 'aria-labelledby': `more-${id}` }, [h('h2', { class: 'more__title', id: `more-${id}` }, title), body]);

/**
 * @param {any} data unused: the page reads nothing
 * @param {any} params
 * @param {{ info?: () => any }} local `info()` is the last /api/info body, or null
 */
function renderMore(data, params, local) {
  const info = local && typeof local.info === 'function' ? local.info() : null;
  const version = info && info.core && typeof info.core.version === 'string' ? info.core.version : null;
  return h('div', { class: 'more' }, [
    section('manage', 'Manage', h('ul', { class: 'more__list' }, MORE_LINKS.map(item))),
    section('records', 'Records', h('ul', { class: 'more__list' }, RECORD_LINKS.map(item))),
    section('theme', 'Theme', buildThemeControl()),
    section('about', 'This Console', h('dl', { class: 'more__facts' }, [
      h('dt', {}, 'DoFlow core'),
      h('dd', { class: version === null ? null : 'mono' }, version ?? 'not read yet'),
    ])),
  ]);
}

export { MORE_LINKS, RECORD_LINKS, renderMore };
