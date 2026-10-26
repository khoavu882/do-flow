// The five global states of the shell (D.2 note section 6): loading, empty, error, stale and no-runtime,
// the connection pill, and the copy table of 6.6. Renderers return element trees built with `h`; every
// string is text. No server text is ever shown: the error copy below is the only prose on screen.

import { h, mount, icon, announce } from './dom.js';

// ---- time -------------------------------------------------------------------------------------------

/**
 * Whole seconds under a minute, then whole minutes, then hours from 60 min and days from 24 h: "12 s", "3 min", "5 h", "2 d".
 * @param {any} ms
 */
function ageUnits(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return minutes < 1440 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 1440)} d`;
}

/**
 * "just now", "12 s ago", "3 min ago".
 * @param {any} ms
 */
function ageText(ms) {
  return ms < 5000 ? 'just now' : `${ageUnits(ms)} ago`;
}

const two = (/** @type {number} */ n) => String(n).padStart(2, '0');

/**
 * Local HH:MM:SS.
 * @param {any} ms
 */
function clockTime(ms) {
  const date = new Date(ms);
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/**
 * A time that reads relative when fresh and absolute when its view is stale (app.css swaps the two on
 * `#main[data-stale]`, so stale data never reads "ago"). `refreshReltimes` keeps the relative part current.
 * @param {any} nowMs
 * @param {any} iso
 */
function reltime(iso, nowMs) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return h('span', { class: 'reltime' }, 'time unknown');
  return h('span', { class: 'reltime', dataset: { ts: ms } }, [
    h('span', { class: 'reltime__rel' }, ageText(nowMs - ms)),
    h('span', { class: 'reltime__abs' }, `at ${clockTime(ms)}`),
  ]);
}

/** @param {any} root @param {any} nowMs */
function refreshReltimes(root, nowMs) {
  for (const el of root.querySelectorAll('.reltime[data-ts]')) {
    const rel = el.querySelector('.reltime__rel');
    if (rel) rel.textContent = ageText(nowMs - Number(el.dataset.ts));
  }
}

// ---- failures ---------------------------------------------------------------------------------------

/**
 * Sorts a failed call (`{ status, code, network }`) into the rows of 6.6. `scope`: `session` and `runtime`
 * and `offline` are full pages, `inline` stays in the view. `auto`: retried on the poller's backoff.
 * `ctx.exchange` is `used` when this page load's launch-code exchange was refused, `ok` when it worked, and
 * `none` when there was none; `ctx.sessionWorked` is true once any call of this page load was answered.
 * @param {any} [ctx]
 * @param {any} error
 */
function classify(error, ctx = {}) {
  const { status = null, code = null, network = false } = error ?? {};
  if (network || status === null) return { scope: 'offline', key: 'offline', auto: true, status: null, code: null };
  if (status === 401) {
    const key = ctx.exchange === 'used' ? 'session-used' : ctx.sessionWorked ? 'session-ended' : 'session-unauth';
    return { scope: 'session', key, auto: false, status, code };
  }
  if (status === 403) return { scope: 'session', key: 'forbidden-origin', auto: false, status, code };
  if (status === 503 && (code === 'core-unreachable' || code === 'core-version')) {
    return { scope: 'runtime', key: code === 'core-version' ? 'runtime-range' : 'runtime-missing', auto: true, status, code };
  }
  if (status === 502 && code === 'core-contract-mismatch') return { scope: 'inline', key: 'contract-mismatch', auto: true, status, code };
  if (status === 502 && code === 'cannot-list-checkouts') return { scope: 'inline', key: 'cannot-list', auto: true, status, code };
  if (status === 404 && code === 'run-not-found') return { scope: 'inline', key: 'run-not-found', auto: false, status, code };
  if (status === 404) return { scope: 'inline', key: 'not-found', auto: false, status, code };
  if (status === 400 || status === 415 || status === 421 || status === 405) return { scope: 'inline', key: 'refused', auto: false, status, code };
  return { scope: 'inline', key: 'core-error', auto: true, status, code };
}

const RUN_HINT_USED = 'Open the new link it prints.';

/**
 * The copy table of 6.6. `title` may use the view noun; `command` is a command block; `then` the line under
 * it; `hint` is a muted line with an inline command (`[before, command, after]`).
 */
/** @type {Record<string, any>} */
const ERROR_COPY = Object.freeze({
  'session-used': { title: 'This link has already been used', sentence: 'Each link printed by `doflow ui` opens the Console once.', command: 'doflow ui', then: RUN_HINT_USED },
  'session-unauth': { title: 'Open the Console from its link', sentence: 'The Console answers only browsers that arrived through the link `doflow ui` prints.', command: 'doflow ui' },
  'session-ended': { title: 'This Console session has ended', sentence: 'Sessions last as long as the `doflow ui` process that made them.', command: 'doflow ui', then: RUN_HINT_USED },
  'forbidden-origin': { title: 'This page is not on the Console’s address', sentence: 'The Console only answers pages served from its own loopback address.', command: 'doflow ui', then: 'Open the link it prints.' },
  offline: { title: 'The Console has stopped', sentence: 'The `doflow ui` process that served this page is not answering.', command: 'doflow ui', then: RUN_HINT_USED },
  'core-error': { title: (/** @type {string} */ noun) => `Could not load ${noun}`, sentence: 'DoFlow returned an error while reading this data.', hint: () => ['', 'doflow doctor', ' checks the install.'] },
  'contract-mismatch': {
    title: (/** @type {string} */ noun) => `Could not read ${noun}`,
    sentence: 'DoFlow sent data in a shape this Console does not read. The Console and the core may be out of step.',
    hint: (/** @type {string} */ range) => ['', 'doflow --version', ` shows the version. The Console needs ${range}.`],
  },
  'cannot-list': { title: () => 'Could not list this project’s checkouts', sentence: 'Git did not answer for this project.', hint: () => ['', 'git worktree list', ' shows them.'] },
  'run-not-found': { title: () => 'This run is not in the record', sentence: 'It may have been removed, or its checkout deleted.', link: 'Back to Runs' },
  'not-found': { title: () => 'This page does not exist', sentence: 'The address does not match any Console view.', link: 'Back to Runs' },
  refused: { title: () => 'The Console refused this request', sentence: 'This is a bug in the Console page. Reload; if it happens again, run `doflow ui` again.', reload: true },
});

/** The two no-runtime variants (6.5). */
/** @type {Record<string, any>} */
const RUNTIME_COPY = Object.freeze({
  'runtime-missing': {
    title: 'DoFlow is not reachable',
    body: 'The Console reads everything through the DoFlow command line, and it cannot run it right now. It may have been moved, removed or updated while the Console was open.',
    command: 'npm install -g @khoavu882/doflow',
    then: 'Then run `doflow ui` again, or wait: the Console checks again on its own.',
  },
  'runtime-range': {
    title: 'This DoFlow version does not fit the Console',
    body: 'The Console needs a DoFlow core in the range below and found a different one.',
    command: 'doflow --version',
    then: 'Install a core in the range above, then run `doflow ui` again.',
  },
});

// ---- pieces -----------------------------------------------------------------------------------------

/**
 * Text with `code` spans for the parts between backticks.
 * @param {any} text
 */
function inline(text) {
  return text.split('`').map((/** @type {string} */ part, /** @type {number} */ index) => (index % 2 === 1 ? h('code', { class: 'mono' }, part) : part));
}

function cmdKey() {
  const platform = String((globalThis.navigator && ((/** @type {any} */ (globalThis.navigator)).userAgentData?.platform ?? globalThis.navigator.platform)) ?? '');
  return /mac|iphone|ipad/i.test(platform) ? 'Cmd+C' : 'Ctrl+C';
}

/** @param {any} node */
function selectContents(node) {
  try {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = /** @type {Selection} */ (globalThis.getSelection());
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // No selection API: the label still tells the person to copy by hand.
  }
}

/**
 * The shared command block: the command, and a Copy button that confirms in place. With `name` the button's accessible
 * name is "Copy <name>" (its visible label stays "Copy"), so two blocks on one page are told apart.
 * @param {any} text
 * @param {string} [name]
 */
function commandBlock(text, name) {
  const code = h('code', { class: 'cmd__text' }, text);
  const label = h('span', { class: 'cmd__label' }, 'Copy');
  const button = h('button', { type: 'button', class: 'btn btn--ghost cmd__copy', 'aria-label': name ? `Copy ${name}` : null }, [icon('copy', 16), label]);
  /** @type {any} */
  let restore = null;
  const rest = (/** @type {string} */ face, /** @type {string} */ name, /** @type {number} */ ms) => {
    button.replaceChildren(icon(face, 16), label);
    label.textContent = name;
    if (restore !== null) globalThis.clearTimeout(restore);
    restore = globalThis.setTimeout(() => {
      restore = null;
      button.replaceChildren(icon('copy', 16), label);
      label.textContent = 'Copy';
    }, ms);
  };
  button.addEventListener('click', async () => {
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error('no clipboard');
      await globalThis.navigator.clipboard.writeText(text);
      rest('check', 'Copied', 2000);
      announce('Command copied');
    } catch {
      selectContents(code);
      rest('copy', `Press ${cmdKey()}`, 4000);
    }
  });
  return h('div', { class: 'cmd' }, [code, button]);
}

/** @param {any} kind @param {any} text @param {any} onClick @param {any} [face] */
function button(kind, text, onClick, face) {
  return h('button', { type: 'button', class: `btn btn--${kind}`, on: { click: onClick } }, [face ? icon(face, 16) : null, text]);
}

/** A skeleton block; the caller sizes it with a class in app.css. */
const skel = (cls = '') => h('div', { class: `skel ${cls}`.trim(), 'aria-hidden': 'true' });

// ---- the states -------------------------------------------------------------------------------------

/**
 * Loading (6.1): the visually hidden "Loading <noun>" text always; the skeleton only once `showSkeleton`.
 * @param {any} options
 */
function renderLoading({ noun, skeleton, showSkeleton }) {
  return [h('p', { class: 'vh' }, `Loading ${noun}`), showSkeleton ? skeleton() : null];
}

/**
 * Empty (6.2): the centred panel.
 * @param {any} options
 */
function renderEmpty({ title, sentence, command, note }) {
  return h('section', { class: 'empty' }, [
    icon('empty-rail', 96),
    h('h2', { class: 'empty__title' }, title),
    h('p', { class: 'empty__sentence' }, sentence),
    command ? commandBlock(command) : null,
    note ? h('p', { class: 'empty__note' }, note) : null,
  ]);
}

/**
 * The h2 text of an inline error (also what the polite announcement leads with).
 * @param {any} info
 * @param {any} noun
 */
function errorTitle(info, noun) {
  const title = ERROR_COPY[info.key].title;
  return typeof title === 'function' ? title(noun) : title;
}

/**
 * Inline error (6.3). `noun`: the view noun; `range`: the core range (CORE_RANGE); `onRetry` for auto-retry rows, `onReload`. The countdown
 * element is `.countdown` (the shell's 1 s timer writes it from the poller).
 * @param {any} options
 */
function renderError({ info, noun, range, onRetry, onReload }) {
  const copy = ERROR_COPY[info.key];
  const hint = copy.hint ? copy.hint(range) : null;
  const title = errorTitle(info, noun);
  const actions = [];
  if (info.auto) {
    actions.push(button('secondary', 'Try again', onRetry, 'refresh'), h('span', { class: 'countdown', dataset: { lead: 'Trying again in' } }));
  }
  if (copy.link) actions.push(h('a', { class: 'btn btn--secondary', href: '#/' }, copy.link));
  if (copy.reload) actions.push(button('secondary', 'Reload', onReload));
  const chip = info.code ? `${info.code} · ${info.status}` : String(info.status);
  return h('section', { class: 'state-panel', dataset: { kind: 'error' } }, [
    h('div', { class: 'state-panel__head' }, [icon('failed', 20), h('h2', { class: 'state-panel__title' }, title)]),
    h('p', { class: 'state-panel__sentence' }, inline(copy.sentence)),
    hint ? h('p', { class: 'hint' }, [hint[0], h('code', { class: 'mono' }, hint[1]), hint[2]]) : null,
    actions.length ? h('div', { class: 'state-panel__actions' }, actions) : null,
    h('p', { class: 'code-chip' }, chip),
  ]);
}

/**
 * A full page (6.5, 6.6): session pages, the offline page and the two no-runtime variants. The page owns
 * the h1 (focus target). `facts` is `[[term, value], ...]`; `foot` adds the auto-check line and "Check now".
 * @param {any} options
 */
function renderFullPage({ info, range, found, onCheck }) {
  if (info.scope === 'runtime') {
    const copy = RUNTIME_COPY[info.key];
    const facts = [['Needs', `doflow core ${range}`], ['Found', found]];
    return h('section', { class: 'full-state', dataset: { kind: 'no-runtime', variant: info.key } }, [
      icon('no-runtime', 48),
      h('p', { class: 'eyebrow' }, 'No runtime'),
      h('h1', { class: 'full-state__title', tabindex: '-1' }, copy.title),
      h('p', { class: 'full-state__body' }, copy.body),
      h('dl', { class: 'facts' }, facts.map(([term, value]) => h('div', { class: 'facts__row' }, [h('dt', {}, term), h('dd', {}, value)]))),
      commandBlock(copy.command),
      h('p', { class: 'hint' }, inline(copy.then)),
      h('p', { class: 'full-state__foot' }, [h('span', { class: 'countdown', dataset: { lead: 'Checking again in' } }), button('secondary', 'Check now', onCheck, 'refresh')]),
    ]);
  }
  const copy = ERROR_COPY[info.key];
  const chip = info.status === null ? null : info.code ? `${info.code} · ${info.status}` : String(info.status);
  return h('section', { class: 'full-state', dataset: { kind: 'session', variant: info.key } }, [
    icon('failed', 48),
    h('h1', { class: 'full-state__title', tabindex: '-1' }, copy.title),
    h('p', { class: 'full-state__body' }, inline(copy.sentence)),
    copy.command ? commandBlock(copy.command) : null,
    copy.then ? h('p', { class: 'hint' }, copy.then) : null,
    info.scope === 'offline'
      ? h('p', { class: 'full-state__foot' }, [h('span', { class: 'countdown', dataset: { lead: 'Checking again in' } }), button('secondary', 'Check now', onCheck, 'refresh')])
      : null,
    chip ? h('p', { class: 'code-chip' }, chip) : null,
  ]);
}

// ---- the connection pill ---------------------------------------------------------------------------

/** @type {Record<string, string>} */
const PILL_ICON = { unknown: 'unknown', done: 'check', stale: 'stale', failed: 'failed' };

/**
 * Writes the pill; rebuilds nothing when state and text are unchanged.
 * @param {any} conn
 * @param {any} options
 */
function renderPill(conn, { state, long, short }) {
  const first = conn.dataset.state !== state || !conn.querySelector('.icon');
  if (first) {
    conn.dataset.state = state;
    mount(conn, [icon(PILL_ICON[state], 12), h('span', { class: 'conn__long' }), h('span', { class: 'conn__short' })]);
  }
  const longEl = conn.querySelector('.conn__long');
  const shortEl = conn.querySelector('.conn__short');
  if (longEl.textContent !== long) longEl.textContent = long;
  if (shortEl.textContent !== short) shortEl.textContent = short;
}

// ---- the stale banner ------------------------------------------------------------------------------

/** @type {Record<string, string>} */
const STALE_CAUSE = Object.freeze({
  offline: 'The Console server is not answering.',
  error: 'DoFlow returned an error.',
  slow: 'Updates are slow to arrive.',
});

/**
 * The stale banner (6.4): `{ node, update(nowMs, cause), leave(done) }`.
 * @param {any} options
 */
function createStaleBanner({ sinceMs, onTry }) {
  const age = h('span', { class: 'banner__age' });
  const cause = h('span', { class: 'banner__cause' });
  const banner = h('div', { class: 'banner', dataset: { kind: 'stale' } }, [
    icon('stale', 20),
    h('p', { class: 'banner__text' }, ['Not updated since ', h('code', { class: 'mono' }, clockTime(sinceMs)), ' (', age, ' ago). ', cause]),
    button('secondary', 'Try now', onTry),
  ]);
  const node = h('div', { class: 'banner-wrap' }, banner);
  return {
    node,
    update(/** @type {number} */ nowMs, /** @type {string} */ why) {
      const text = ageUnits(nowMs - sinceMs);
      if (age.textContent !== text) age.textContent = text;
      const sentence = STALE_CAUSE[why] ?? STALE_CAUSE.slow;
      if (cause.textContent !== sentence) cause.textContent = sentence;
    },
    /** Fades out, then removes the node (also after a timeout, so a 0 ms duration still removes it). */
    leave() {
      banner.classList.add('banner--leaving');
      let gone = false;
      const remove = () => {
        if (gone) return;
        gone = true;
        node.remove();
      };
      banner.addEventListener('animationend', remove);
      globalThis.setTimeout(remove, 200);
    },
  };
}

export {
  ageText, ageUnits, clockTime, reltime, refreshReltimes,
  classify, errorTitle, ERROR_COPY, RUNTIME_COPY, STALE_CAUSE,
  commandBlock, button, skel,
  renderLoading, renderEmpty, renderError, renderFullPage, renderPill, createStaleBanner,
};
