// The Console client shell (D.2 note sections 6, 7 and 8): boot (theme first, then the launch-code
// exchange, then /api/info), the hash router with focus, the view lifecycle (loading, empty, error, loaded)
// over the poller, the global states (session, no-runtime, offline, stale), the connection pill and the
// theme control. The imported modules have no side effects; everything starts in the body below.

import { h, mount, icon, announce, muteAnnouncements } from './dom.js';
import { notice } from './notices.js';
import { installShortcuts } from './keys.js';
import { createPalette } from './palette.js';
import { deriveSessions } from './derive/sessions.js';
import { laneTitle } from './views/sessions.js';
import { createPoller, BACKOFF_MS } from './poll.js';
import { createLiveAdapter } from './live.js';
import { createLiveStore } from './store.js';
import {
  classify, clockTime, refreshReltimes, renderLoading, renderEmpty, renderError, renderFullPage, renderPill, createStaleBanner, errorTitle, pairFailure,
} from './states.js';
import { parsePairFragment, createPairPage } from './views/pair.js';
import { CORE_RANGE, MANAGE_VIEWS, parseRoute, hashFor, baseRoute, titleFor, navFor } from './views.js';
import { createInspector, hidePanel } from './shell.js';
import { onRefetch, closeConfirm, isConfirmOpen } from './views/confirm.js';
import { readTheme, applyTheme, setupThemeControl } from './theme.js';
import { attentionModel, attentionWords, currentProject } from './derive/attention.js';

// ---- 1. theme: the module's first statement, before the fragment is read or anything is fetched ----

applyTheme(readTheme());

// ---- 2. the page, its state and the same-origin API ----

const app = /** @type {any} */ ({
  els: null,
  view: null,
  ready: false, // boot (exchange and /api/info) has finished
  info: null, // the last /api/info body
  exchange: 'none', // 'none' | 'ok' | 'used'
  sessionWorked: false,
  fatal: null, // { info, found }: a full page for every route (session error, no runtime, the pairing form)
  pair: null, // the pairing form's state while it shows: { code, ui, busy } (the code is memory only)
  recovery: null, // the poller on /api/info that ends a no-runtime page
  banner: null, // the stale banner while the current view's data is stale
  tick: null,
  shortcuts: null, // the keys.js handle
  hiddenAt: null, // when the tab was last hidden, or null
  wasFull: false, // #main last held a full page (focus moves to the heading when a view replaces it)
  liveStore: null, // the page's one live store (IC-017), made when the first live view starts
  inspector: null, // the shell's details region (IC-020), see shell.js
  palette: null, // the command palette (IC-021), see palette.js
  attention: null, // what the page holds of the `machine` channel for the attention strip, once it follows it
  loaded: { runs: null, sessions: null, layers: null }, // the latest Runs and Sessions bodies and Layers data: the palette's targets
});
let viewSeq = 0;

/** The screens, by their navigation labels and in the navigation's order. */
const SCREENS = Object.freeze([['Now', 'runs'], ['Sessions', 'sessions'], ['Layers', 'layers'], ['Follow-ups', 'followups'], ['Workflows', 'workflows'], ['Workers', 'workers'], ['Advice', 'advice'], ['Settings', 'settings'], ['Health', 'health'], ['More', 'more']]);

/**
 * What the command palette can reach (IC-021, DEC-011): the screens, then the runs (each with its Chain target, 150 IC-020),
 * session lanes and Layers projects of the
 * latest bodies this page has loaded. Labels are the ones the views show; every hash comes from `hashFor`, so a target that
 * cannot be linked is left out. Nothing is fetched.
 */
function paletteTargets() {
  /** @type {Array<{ kind: string, label: string, hint: string, hash: string }>} */
  const out = [];
  const add = (/** @type {string} */ kind, /** @type {string} */ label, /** @type {string} */ hint, /** @type {any} */ route) => {
    const hash = hashFor(route);
    if (hash !== null) out.push({ kind, label, hint, hash });
  };
  for (const [label, id] of SCREENS) add('screen', label, 'Screen', { id, params: {} });
  add('action', 'Compare workflow runs', 'Compare', { id: 'compare', params: {} });
  add('action', 'Sessions history', 'Sessions', { id: 'sessions', params: { mode: 'history' }, mode: 'history' });
  const { runs, sessions, layers } = app.loaded;
  for (const run of (runs && Array.isArray(runs.runs) ? runs.runs : [])) {
    if (typeof run.featureSlug !== 'string') continue;
    const workflow = run.workflowName || run.taskClass;
    add('run', `${run.featureSlug} / ${run.taskId}`, workflow ? `Run · ${workflow}` : 'Run', { id: 'run', params: { slug: run.featureSlug, taskId: run.taskId } });
    // 150 IC-020: the run's Session screen, beside its run target.
    add('session', `${run.featureSlug} / ${run.taskId}`, 'Chain', { id: 'session', params: { slug: run.featureSlug, taskId: run.taskId } });
  }
  if (sessions) {
    for (const row of deriveSessions(sessions, Date.now()).rows) {
      const where = row.kind === 'unplaced' ? 'another directory' : row.label;
      for (const lane of row.lanes.flatMap((/** @type {any} */ item) => [item, ...item.children])) {
        add('session', laneTitle(lane), `Session · ${where}`, { id: 'sessions', params: {}, lane: lane.key });
      }
    }
  }
  for (const project of layersProjects(layers)) {
    add('project', String(project.label ?? project.projectKey), 'Layers project', { id: 'layers-project', params: { project: project.projectKey } });
  }
  return out;
}

/** The projects of the latest `machine` member the Layers page held (its `projects` section), or none. @param {any} data */
function layersProjects(data) {
  const section = data && data.machine && data.machine.sections ? data.machine.sections.projects : null;
  return section && section.ok === true && Array.isArray(section.data.projects) ? section.data.projects : [];
}

/** Keeps the latest body of the views the palette reads. @param {string} id the view id @param {any} body */
function rememberLoaded(id, body) {
  if (id === 'runs' || id === 'sessions') app.loaded[id] = body;
  else if (id === 'layers' || id === 'layers-project') app.loaded.layers = body;
}

/** The page's one live store over one live adapter (IC-016, IC-017): every live view of this page shares it. */
function pageStore() {
  if (app.liveStore === null) app.liveStore = createLiveStore({ adapter: createLiveAdapter() });
  return app.liveStore;
}

const MIN_SKELETON_MS = 300;
/** A tab hidden longer than this refetches in full and says so once. */
const RESYNC_AFTER_MS = 30000;

/**
 * A failed call as `{ status, code, network }`; stays a plain object so classify() reads it.
 * @param {any} path
 */
async function apiGet(path) {
  let reply;
  try {
    reply = await globalThis.fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
  } catch {
    throw { status: null, code: null, network: true };
  }
  let body = null;
  try {
    body = await reply.json();
  } catch {
    // An empty or non-JSON body (421, a bare 500) carries no code.
  }
  if (!reply.ok) throw { status: reply.status, code: body && body.error && typeof body.error.code === 'string' ? body.error.code : null, network: false };
  return body;
}

const ctx = () => ({ exchange: app.exchange, sessionWorked: app.sessionWorked });

/**
 * The one-time launch-code exchange. The code was already removed from the address bar by the caller.
 * @param {any} code
 */
async function postSession(code) {
  let reply;
  try {
    reply = await globalThis.fetch('/api/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch {
    throw { status: null, code: null, network: true };
  }
  if (reply.status !== 204) throw { status: reply.status, code: null, network: false };
}

/**
 * The pairing exchange (160 IC-006): the one-use code and the device name. A refusal throws `{ status, code, network, retryAfter }`;
 * on 200 the cookie is already set and nothing is read from the body.
 * @param {string} code
 * @param {string} name
 */
async function postPair(code, name) {
  let reply;
  try {
    reply = await globalThis.fetch('/api/pair', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, code, name }),
    });
  } catch {
    throw { status: null, code: null, network: true };
  }
  if (reply.status === 200) return;
  let body = null;
  try {
    body = await reply.json();
  } catch {
    // An empty or non-JSON body carries no code.
  }
  const retry = reply.headers && typeof reply.headers.get === 'function' ? Number(reply.headers.get('Retry-After')) : 0;
  throw { status: reply.status, code: body && body.error && typeof body.error.code === 'string' ? body.error.code : null, network: false, retryAfter: Number.isFinite(retry) ? retry : 0 };
}

// ---- 3. rendering ----

const mainEl = () => app.els.main;

function nowMs() {
  return Date.now();
}

/**
 * The `data-focus-key` of the focused element or its nearest ancestor that has one, or null.
 * @param {any} el
 */
function focusKeyOf(el) {
  const owner = el && typeof el.closest === 'function' ? el.closest('[data-focus-key]') : null;
  return owner && owner.dataset && typeof owner.dataset.focusKey === 'string' ? owner.dataset.focusKey : null;
}

/** @param {any} root */
function headingOf(root) {
  return root ? root.querySelector('h1') : null;
}

function focusHeading() {
  const heading = headingOf(mainEl());
  if (heading) heading.focus({ preventScroll: true });
}

/**
 * The full page that applies to `view` now, or null.
 * @param {any} view
 */
function fullPageFor(view) {
  if (app.fatal) return app.fatal;
  if (!view.hasData && view.fail && view.fail.scope === 'offline') return { info: view.fail, found: null };
  return null;
}

/** @param {any} view @param {any} animate */
function buildRoot(view, animate) {
  const spec = view.route.view;
  const heading = spec.head(view.route.params);
  // A view may build its own head (the run view: crumb, title, meta, step) and says which parts the shell updates.
  const own = typeof heading.build === 'function' ? heading.build() : null;
  view.h1 = own ? own.h1 : h('h1', { class: heading.mono ? 'view-title mono' : 'view-title', tabindex: '-1' }, heading.text);
  view.metaEl = own ? own.meta : h('div', { class: 'view-meta' });
  view.stepEl = own ? own.step : null;
  view.body = h('div', { class: 'view-body' });
  view.root = h('div', { class: animate ? 'view view-enter' : 'view' }, [own ? own.root : h('div', { class: 'view-head' }, [view.h1, view.metaEl]), view.body]);
  view.painted = null;
  view.fullKey = null;
}

/** @param {any} view */
function updateMeta(view) {
  const spec = view.route.view;
  mount(view.metaEl, spec.meta(view.route.params, view.hasData ? view.data : null, nowMs(), { project: app.attention ? currentProject(app.attention.body) : null }));
  if (view.stepEl && spec.step) {
    const content = spec.step(view.route.params, view.hasData ? view.data : null);
    mount(view.stepEl, content);
    if (content === null) view.stepEl.setAttribute('hidden', '');
    else view.stepEl.removeAttribute('hidden');
  }
}

/** @param {any} view */
function bodyContent(view) {
  const spec = view.route.view;
  const holding = view.holdUntil !== null && nowMs() < view.holdUntil;
  if (!view.hasData && view.error) {
    return {
      key: `error:${view.error.key}`,
      nodes: () => renderError({
        info: view.error,
        noun: spec.noun,
        range: CORE_RANGE,
        onRetry: () => view.poller && view.poller.refreshNow(),
        onReload: () => globalThis.location.reload(),
      }),
    };
  }
  if (!view.hasData || holding) {
    return { key: `loading:${view.skeletonShown}`, nodes: () => renderLoading({ noun: spec.noun, skeleton: spec.skeleton, showSkeleton: view.skeletonShown }), busy: true };
  }
  if (spec.isEmpty(view.data, view.route.params)) {
    // `empty` may be a function of the data (a view with two empty panels).
    const empty = typeof spec.empty === 'function' ? spec.empty(view.data) : spec.empty;
    return { key: typeof spec.empty === 'function' ? `empty:${empty.title}` : 'empty', nodes: () => renderEmpty(empty) };
  }
  return { key: loadedKey(view), nodes: () => spec.render(view.data, view.route.params, view.local) };
}

/**
 * The paint key of a loaded body. A `live: true` view (V.10) has one key for as long as it is loaded: it is mounted once and
 * every later change of its data reaches `spec.update`, so scroll, focus and open disclosures survive (V8 7b.2, N-6).
 * @param {any} view
 */
function loadedKey(view) {
  return view.route.view.live === true ? 'data:live' : `data:${view.dataText}`;
}

/**
 * Paints the current state of `view` into #main, keeping what is unchanged and the focus rules of 6.
 * @param {any} view
 */
function paint(view) {
  if (view !== app.view) return;
  const main = mainEl();
  const active = document.activeElement;
  const focusWasIn = active === document.body || active === null || main.contains(active);

  const full = fullPageFor(view);
  if (full) {
    const key = `${full.info.key}:${full.found ?? ''}`;
    if (view.fullKey !== key) {
      mount(main, full.info.scope === 'pair' && app.pair
        ? app.pair.ui.node
        : renderFullPage({
          info: full.info,
          range: CORE_RANGE,
          found: full.found ?? 'nothing',
          onCheck: () => (app.fatal ? app.recovery && app.recovery.refreshNow() : view.poller && view.poller.refreshNow()),
        }));
      view.fullKey = key;
      app.wasFull = true;
      view.root = null;
      main.classList.remove('page--wide');
      main.removeAttribute('aria-busy');
      if (focusWasIn) focusHeading();
      refreshStatus();
    }
    return;
  }

  if (view.root === null || !main.contains(view.root)) {
    buildRoot(view, view.animate);
    view.fullKey = null;
    mount(main, view.root);
    main.classList.toggle('page--wide', view.route.view.wide === true);
    updateMeta(view);
    if (app.wasFull && focusWasIn) focusHeading();
    app.wasFull = false;
  }
  const next = bodyContent(view);
  if (next.busy) main.setAttribute('aria-busy', 'true');
  else main.removeAttribute('aria-busy');
  if (view.painted !== next.key) {
    // The view's panel sits in the inspector (D.2) and is rebuilt with the body, so focus inside it counts too.
    const panel = app.els.inspector;
    const before = document.activeElement;
    const inPanel = Boolean(panel) && panel.contains(before);
    const hadFocus = view.body.contains(before) || inPanel;
    const focusKey = focusKeyOf(before);
    mount(view.body, next.nodes());
    view.painted = next.key;
    const after = document.activeElement;
    const kept = view.body.contains(after) || (inPanel && after === before && panel.contains(after));
    if (hadFocus && !kept) {
      // E.1 8.4: the element with the same data-focus-key takes the focus back; the heading is the fallback, or the
      // inspector's own close control when the open dialog already holds the focus.
      const again = focusKey === null ? null : view.body.querySelector(`[data-focus-key="${focusKey}"]`) ?? (inPanel ? panel.querySelector(`[data-focus-key="${focusKey}"]`) : null);
      if (again) again.focus({ preventScroll: true });
      else if (!(inPanel && panel.contains(after))) view.h1.focus({ preventScroll: true });
    }
  }
  if (view.hasData) updateMeta(view);
  else if (view.skeletonShown && view.route.view.headSkeleton && view.stepEl) {
    // The loading skeleton of a view with its own head fills the head's slots, not the body (R3-3).
    const blocks = view.route.view.headSkeleton();
    mount(view.metaEl, blocks.meta);
    mount(view.stepEl, blocks.step);
    view.stepEl.removeAttribute('hidden');
  }
  refreshStatus();
}

// ---- 4. status: connection pill, stale banner, countdowns (one shared 1 s timer) ----

/** @param {any} view @param {any} now */
function pillFor(view, now) {
  if (app.fatal) {
    return app.fatal.info.scope === 'runtime'
      ? { state: 'failed', long: 'Core unreachable', short: 'No core' }
      : { state: 'failed', long: 'No session', short: 'No session' };
  }
  const poller = view && view.poller;
  if (!app.ready || !poller) return { state: 'unknown', long: 'Connecting', short: 'Connecting' };
  const stale = poller.isStale();
  const offline = poller.lastFailure !== null && classify(poller.lastFailure, ctx()).scope === 'offline';
  if (view.paused) {
    // A pause never hides a known failure: the pill names it next to Paused until a fetch succeeds.
    if (stale) return { state: 'stale', long: `Paused · Stale · ${clockTime(poller.lastSuccessAt)}`, short: 'Paused · Stale' };
    if (offline) return { state: 'unknown', long: 'Paused · Offline', short: 'Paused · Offline' };
    if (poller.lastFailure !== null) return { state: 'unknown', long: 'Paused · Retrying', short: 'Paused · Retrying' };
    const at = poller.lastSuccessAt;
    return { state: 'paused', long: at === null ? 'Paused' : `Paused · ${clockTime(at)}`, short: 'Paused' };
  }
  if (offline && (!view.hasData || stale)) return { state: 'unknown', long: 'Offline', short: 'Offline' };
  if (stale) return { state: 'stale', long: `Stale · ${clockTime(poller.lastSuccessAt)}`, short: 'Stale' };
  if (poller.lastFailure !== null) return { state: 'unknown', long: 'Retrying', short: 'Retrying' };
  if (poller.lastSuccessAt === null) return { state: 'unknown', long: 'Connecting', short: 'Connecting' };
  const age = Math.max(0, now - poller.lastSuccessAt);
  const text = age < 5000 ? 'just now' : `${age < 60000 ? `${Math.floor(age / 1000)} s` : `${Math.floor(age / 60000)} min`} ago`;
  // A live view's connector (IC-018, DEC-033) names its mode; a plain poller has no `live` or `polling` mode; Layers' stream names `down`.
  if (poller.mode === 'live') return { state: 'done', long: `Live · last change ${text}`, short: 'Live' };
  if (poller.mode === 'down') return { state: 'stale', long: `Stream down · last record ${text}`, short: 'Down' };
  if (poller.mode === 'polling') return { state: 'unknown', long: `Polling · Updated ${text}`, short: 'Polling' };
  return { state: 'done', long: `Updated ${text}`, short: text };
}

/** @param {any} on @param {any} view @param {any} now */
function setStale(on, view, now) {
  const main = mainEl();
  if (on && app.banner === null) {
    const since = view.poller.lastSuccessAt;
    app.banner = createStaleBanner({ sinceMs: since, onTry: () => view.poller && view.poller.refreshNow() });
    app.els.bannerSlot.append(app.banner.node);
    main.dataset.stale = 'true';
    if (app.els.inspector) app.els.inspector.dataset.stale = 'true';
    notice('stale', clockTime(since));
  } else if (!on && app.banner !== null) {
    app.banner.leave();
    app.banner = null;
    delete main.dataset.stale;
    if (app.els.inspector) delete app.els.inspector.dataset.stale;
    if (!view.paused) notice('fresh');
  }
  if (on && app.banner) {
    const failure = view.poller.lastFailure;
    const why = failure === null ? 'slow' : classify(failure, ctx()).scope === 'offline' ? 'offline' : 'error';
    app.banner.update(now, why);
  }
}

// ---- 4b. the pause control (feature 133, FR-2) ----

/** Whether the person can pause this view: it reads through a data poller or stream, not the heartbeat of a static page. @param {any} view */
const pausable = (view) => Boolean(view && view.poller && !view.heartbeat && !app.fatal && view.route.id !== 'not-found');

/** Shows, hides and labels the control to match the view. @param {any} view */
function syncPauseControl(view) {
  const button = app.els.pause;
  if (!button) return;
  const show = pausable(view);
  if (show) button.removeAttribute('hidden');
  else button.setAttribute('hidden', '');
  const on = show && view.paused === true;
  button.setAttribute('aria-pressed', on ? 'true' : 'false');
  const label = button.querySelector('.pause__label');
  const text = on ? 'Resume updates' : 'Pause updates';
  if (label && label.textContent !== text) label.textContent = text;
  const mark = on ? 'play' : 'pause';
  if (button.dataset.mark !== mark) {
    button.dataset.mark = mark;
    const old = button.querySelector('.icon');
    if (old) old.remove();
    button.prepend(icon(mark, 16));
  }
}

/** Pauses or resumes the current view; false when it cannot be paused. */
function togglePause() {
  const view = app.view;
  if (!pausable(view)) return false;
  if (view.paused) {
    view.paused = false;
    view.resync = true; // the refetch that follows is a full state, not a stream of changes
    view.poller.resume();
    notice('resumed');
  } else {
    view.paused = true;
    view.poller.pause();
    notice('paused');
  }
  refreshStatus();
  return true;
}

/** @param {any} view @param {any} now */
function updateCountdowns(view, now) {
  const poller = app.fatal ? app.recovery : view && view.poller;
  for (const el of mainEl().querySelectorAll('.countdown')) {
    const at = poller ? poller.nextAt : null;
    const text = at === null ? 'Checking now' : `${el.dataset.lead} ${Math.max(0, Math.ceil((at - now) / 1000))} s`;
    if (el.textContent !== text) el.textContent = text;
  }
}

function refreshStatus() {
  if (!app.els) return;
  const view = app.view;
  const now = nowMs();
  renderPill(app.els.conn, pillFor(view, now));
  const stale = Boolean(view && view.poller && !app.fatal && view.poller.isStale());
  if (view) setStale(stale, view, now);
  syncPauseControl(view);
  paintAttention();
  if (view) updateCountdowns(view, now);
  refreshReltimes(mainEl(), now);
  const spec = view && view.route.view;
  if (spec && spec.tick && view.hasData && !app.fatal && view.painted === loadedKey(view)) spec.tick(mainEl(), now, view.local);
}

function startTick() {
  if (app.tick !== null) return;
  app.tick = globalThis.setInterval(refreshStatus, 1000);
}

function stopTick() {
  if (app.tick !== null) globalThis.clearInterval(app.tick);
  app.tick = null;
}

// ---- 5. the view lifecycle ----

function teardownView() {
  const view = app.view;
  if (!view) return;
  if (view.route.view.teardown) view.route.view.teardown(view.local);
  if (view.poller) view.poller.stop();
  if (view.skeletonTimer) globalThis.clearTimeout(view.skeletonTimer);
  if (view.holdTimer) globalThis.clearTimeout(view.holdTimer);
  if (app.banner) {
    app.banner.node.remove();
    app.banner = null;
  }
  delete mainEl().dataset.stale;
  if (app.els.inspector) delete app.els.inspector.dataset.stale;
  // The open details belong to the view that is going away: they close without calling back into it.
  hidePanel(app.inspector, view.local);
}

/**
 * Marks the current navigation link. A Manage view is reached through More on a phone (its own link shows from 768 px), so
 * the More link is then current too, as `true`: the current item of the set, not the page itself.
 * @param {any} href @param {boolean} [manage]
 */
function setNav(href, manage = false) {
  for (const link of app.els.navLinks) {
    const own = link.getAttribute('href');
    if (own === href) link.setAttribute('aria-current', 'page');
    else if (manage && own === '#/more') link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  }
}

// ---- 5a. the attention strip: what waits for the person on this machine, on every view ----

/**
 * Follows the `machine` channel of the page's live store once the session works, for as long as the page lives. The store
 * shares its one connection with the views, so this adds a channel, never a stream; it makes no GET and runs no poll.
 */
function startAttention() {
  if (app.attention !== null || !app.els || !app.els.attention) return;
  const store = pageStore();
  const held = { body: /** @type {any} */ (null), error: /** @type {string | null} */ (null), transport: { state: store.status().transport, code: /** @type {string | null} */ (null) }, frameAt: /** @type {number | null} */ (null), key: '', project: /** @type {string | null} */ (null) };
  app.attention = held;
  store.onTransport((/** @type {any} */ event) => {
    held.transport = { state: event.state, code: typeof event.code === 'string' ? event.code : null };
    paintAttention();
  });
  store.subscribe('machine', (/** @type {any} */ event) => {
    if (!event) return;
    if (event.kind === 'state') {
      const member = event.state && typeof event.state === 'object' ? event.state.machine : undefined;
      if (member && member.status === 200 && member.body && typeof member.body === 'object') {
        held.body = member.body;
        held.error = null;
        held.frameAt = nowMs();
      } else {
        held.error = member && member.body && member.body.error && typeof member.body.error.code === 'string' ? member.body.error.code : 'no-member';
      }
    } else if (event.kind === 'error') held.error = event.code ?? 'unknown';
    else if (event.kind === 'gone') held.error = 'gone';
    else return; // a `reset` keeps what is held; the snapshot that follows replaces it
    paintAttention();
  });
  paintAttention();
}

/**
 * Draws the strip and the count on the Layers link from what is held. The strip is hidden while there is nothing to say, on
 * the Layers machine page (it leads with the same gates) and under a full page.
 */
function paintAttention() {
  const held = app.attention;
  const strip = app.els && app.els.attention;
  if (!held || !strip) return;
  const model = attentionModel({ body: held.body, transport: held.transport, error: held.error });
  const words = attentionWords(model, held.frameAt === null ? null : clockTime(held.frameAt));
  const onLayers = Boolean(app.view) && app.view.route.id === 'layers';
  const show = words !== null && !onLayers && !app.fatal;
  const project = currentProject(held.body);
  const key = JSON.stringify([words, show, project]);
  if (held.key === key) return;
  // The Now page names the project it lists: its head is drawn again when the page learns the label.
  if (held.project !== project && app.view && app.view.route.id === 'runs' && app.view.hasData) {
    held.project = project;
    updateMeta(app.view);
  }
  held.project = project;
  held.key = key;
  if (show) {
    strip.dataset.state = words.state;
    mount(strip, [
      icon(words.state === 'awaiting' ? 'awaiting' : 'unknown', 16),
      h('span', { class: 'attention__count' }, words.count),
      words.where === '' ? null : h('span', { class: 'attention__where' }, words.where),
      h('a', { class: 'attention__link', href: words.link.href }, words.link.text),
    ]);
    strip.removeAttribute('hidden');
  } else {
    mount(strip, []);
    strip.setAttribute('hidden', '');
  }
  const link = app.els.navLinks.find((/** @type {any} */ item) => item.getAttribute('href') === '#/layers');
  if (!link) return;
  const old = link.querySelector('.navrail__badge');
  if (old) old.remove();
  // The digit is for the eye; the link's name says the count once, in the strip's words (162 review B-8).
  if (words !== null && words.badge !== null) link.append(h('span', { class: 'navrail__badge' }, [h('span', { 'aria-hidden': 'true' }, words.badge), h('span', { class: 'vh' }, ` ${words.count}`)]));
}

/**
 * Starts the view for `route`: head and title at once; the fetch starts when boot is done.
 * @param {any} route
 * @param {any} options
 */
function startView(route, { first = false, animate = false, focus = true } = {}) {
  teardownView();
  const view = {
    id: (viewSeq += 1),
    route,
    hasData: false,
    data: null,
    dataText: null,
    error: null,
    fail: null,
    poller: null,
    heartbeat: false,
    skeletonShown: false,
    skeletonTimer: null,
    holdUntil: null,
    holdTimer: null,
    announcedError: null,
    // The view's own memory (E.1): what its render, load and tick keep between polls; its panel opens in `inspector` (D.2);
    // `route` is the current route with its selection (IC-019) and `link` writes a selection to the address.
    local: { inspector: app.inspector, route, link: /** @type {any} */ (null), apiGet, info: () => app.info, retry: () => view.poller && /** @type {any} */ (view.poller).refreshNow() },
    root: null,
    painted: null,
    fullKey: null,
    animate: animate && !first,
  };
  view.local.link = (/** @type {any} */ patch) => linkSelection(view, patch);
  app.view = view;
  globalThis.document.title = titleFor(route);
  if (app.inspector) app.inspector.setInspectable(route.view.inspectable === true);
  const navHref = navFor(route);
  setNav(navHref === null ? null : navHref === 'runs' ? '#/' : `#/${navHref}`, MANAGE_VIEWS.includes(route.id));
  paintAttention();
  paint(view);
  if (!first && focus) {
    globalThis.scrollTo(0, 0);
    focusHeading();
  }
  if (app.ready) beginView(view);
}

/**
 * A view's selection becomes the address (IC-019, DEC-034; 150 IC-015): `patch` is `{ sel }`, `{ task }`, `{ lane }`,
 * `{ node }` or `{ node, tab }`, or null for none.
 * The view has already shown it; this records the route and sets `location.hash` (a history entry), whose `hashchange`
 * then names the route the view is on and does nothing. A selection that has no hash (a lane with an absent part) leaves
 * the address at the base route and returns false.
 * @param {any} view @param {any} patch
 */
function linkSelection(view, patch) {
  if (view !== app.view) return false;
  const base = baseRoute(view.route);
  const target = patch === null ? base : { ...base, ...patch };
  const linked = hashFor(target) !== null;
  const next = linked ? target : base;
  const hash = hashFor(next);
  view.route = next;
  view.local.route = next;
  if (hash !== null && globalThis.location.hash !== hash) globalThis.location.hash = hash;
  return linked;
}

/** @param {any} view */
function beginView(view) {
  if (view !== app.view || app.fatal) {
    if (view === app.view) paint(view);
    return;
  }
  const spec = view.route.view;
  if (view.route.id === 'not-found') {
    view.error = classify({ status: 404, code: 'not-found' }, ctx());
    paint(view);
    startHeartbeat(view);
    return;
  }
  const path = spec.api(view.route.params);
  if (path === null && typeof spec.load !== 'function') {
    view.hasData = true;
    view.data = {};
    paint(view);
    startHeartbeat(view);
    return;
  }
  view.skeletonTimer = globalThis.setTimeout(() => {
    view.skeletonTimer = null;
    if (view.hasData || view !== app.view) return;
    view.skeletonShown = true;
    view.skeletonShownAt = nowMs();
    paint(view);
  }, MIN_SKELETON_MS);
  startPoller(view, path, spec.pollMs, false);
  paint(view);
}

/** @param {any} view */
function startHeartbeat(view) {
  startPoller(view, '/api/info', 5000, true);
}

/** @param {any} view @param {any} path @param {any} intervalMs @param {any} heartbeat */
function startPoller(view, path, intervalMs, heartbeat) {
  if (view.poller) view.poller.stop();
  view.heartbeat = heartbeat;
  view.paused = false;
  const spec = view.route.view;
  const fetchOnce = () => (!heartbeat && view.route.view.load ? view.route.view.load(view.local, apiGet) : apiGet(path));
  const retry = (/** @type {any} */ error) => {
    const info = classify(error, ctx());
    if (info.scope === 'session' || info.scope === 'runtime') return false;
    return heartbeat || view.hasData || info.auto;
  };
  // Activity-aware refresh (feature 133): a heartbeat and a view without the hooks stay at the base interval.
  const isActive = () => heartbeat || !view.hasData || typeof spec.active !== 'function' || spec.active(view.data, nowMs());
  const size = () => (heartbeat || !view.hasData || typeof spec.size !== 'function' ? 0 : spec.size(view.data));
  if (!heartbeat && typeof spec.connect === 'function') {
    // A live view reads through the page's live store (live-view.js for the views that fall back to a GET, the stream-only
    // connector of Layers) and answers the poller interface, so the pill, the stale banner and "Try again" work unchanged. The
    // poll hooks are what the connector's own fallback poller uses; the Layers connector ignores them.
    const stream = spec.connect(view.local, view.route.params, {
      fetchJson: apiGet,
      onData: (/** @type {any} */ body) => onData(view, body, false),
      onFailure: (/** @type {any} */ error) => onFail(view, error, false),
      onResync: () => { view.resync = true; },
      store: pageStore,
      fetchOnce,
      retry,
      isActive,
      size,
    });
    view.poller = stream;
    stream.start();
    return;
  }
  const poller = createPoller({
    fetchOnce,
    intervalMs,
    onSuccess: (body) => onData(view, body, heartbeat),
    onFailure: (error) => onFail(view, error, heartbeat),
    retry,
    isActive,
    size,
  });
  view.poller = poller;
  poller.start();
}

/** @param {any} view @param {any} body @param {any} heartbeat */
function onData(view, body, heartbeat) {
  if (view !== app.view) return;
  app.sessionWorked = true;
  view.fail = null;
  startAttention();
  if (heartbeat) {
    if (body && body.core) {
      app.info = body;
      showCoreVersion();
      if (body.core.inRange === false) {
        enterRuntime({ scope: 'runtime', key: 'runtime-range', auto: true, status: 503, code: 'core-version' }, String(body.core.version ?? 'unknown'));
        return;
      }
    }
    refreshStatus();
    return;
  }
  const keyOf = view.route.view.dataKey;
  const text = keyOf ? keyOf(body) : JSON.stringify(body);
  const changed = text !== view.dataText;
  view.error = null;
  view.announcedError = null;
  if (view.holdUntil === null && view.skeletonShown && !view.hasData) {
    view.holdUntil = view.skeletonShownAt + MIN_SKELETON_MS;
    const wait = Math.max(0, view.holdUntil - nowMs());
    view.holdTimer = globalThis.setTimeout(() => {
      view.holdTimer = null;
      view.holdUntil = null;
      paint(view);
    }, wait);
  }
  const hadData = view.hasData;
  view.hasData = true;
  view.data = body;
  view.dataText = text;
  rememberLoaded(view.route.view.id, body);
  if (view.skeletonTimer) {
    globalThis.clearTimeout(view.skeletonTimer);
    view.skeletonTimer = null;
  }
  globalThis.document.title = titleFor(view.route, body);
  const spec = view.route.view;
  // The first data after a reconnect or a resume is a full refetch: what it shows as changed is not news, so the per-item
  // announcements are held and one summary is said instead (feature 133, FR-3).
  const resync = view.resync === true && hadData;
  view.resync = false;
  if (resync) muteAnnouncements(true);
  try {
    if (changed && spec.live === true && view.painted === loadedKey(view) && view.root && mainEl().contains(view.root) && !spec.isEmpty(body, view.route.params)) {
      // A live view is patched, never re-mounted (N-6).
      spec.update(view.local, body, view.route.params);
      updateMeta(view);
      refreshStatus();
    } else if (changed) paint(view);
    else refreshStatus();
  } finally {
    if (resync) muteAnnouncements(false);
  }
  if (resync) notice('resynced');
}

/** @param {any} view @param {any} error @param {any} heartbeat */
function onFail(view, error, heartbeat) {
  if (view !== app.view) return;
  const info = classify(error, ctx());
  if (info.scope === 'session') {
    enterSession(info);
    return;
  }
  if (info.scope === 'runtime') {
    enterRuntime(info, info.key === 'runtime-range' ? 'unknown' : 'nothing');
    return;
  }
  view.fail = info;
  if (heartbeat) {
    refreshStatus();
    return;
  }
  if (info.scope === 'inline' && !view.hasData) {
    view.error = info;
    if (!info.auto) {
      // A definitive answer ends data polling; /api/info stands in so the pill stays honest.
      view.poller.stop();
      startHeartbeat(view);
    }
    announceError(view, info);
  }
  paint(view);
}

/** @param {any} view @param {any} info */
function announceError(view, info) {
  if (view.announcedError === info.key) return;
  view.announcedError = info.key;
  const title = errorTitle(info, view.route.view.noun);
  const at = view.poller && view.poller.nextAt;
  if (!info.auto || !at) announce(`${title}.`);
  else announce(`${title}. Trying again in ${Math.max(0, Math.ceil((at - nowMs()) / 1000))} s.`);
}

// ---- 6. full-page states ----

function stopAllPolling() {
  if (app.view && app.view.poller) app.view.poller.stop();
  if (app.recovery) app.recovery.stop();
  app.recovery = null;
}

/** @param {any} info */
function enterSession(info) {
  stopAllPolling();
  app.fatal = { info, found: null };
  if (app.view) paint(app.view);
}

/**
 * The pairing form (160 IC-009) as the page's full state. The code stays in `app.pair` (memory only); a click posts it
 * once, a refusal is shown in the form, and success carries on with the normal boot.
 * @param {{ code: string, fingerprint: string }} pairing
 */
function enterPair(pairing) {
  stopAllPolling();
  const ui = createPairPage({ fingerprint: pairing.fingerprint, onPair: () => submitPair() });
  app.pair = { code: pairing.code, ui, busy: false, dead: false };
  app.fatal = { info: { scope: 'pair', key: 'pair', auto: false, status: null, code: null }, found: null };
  if (app.view) paint(app.view);
}

async function submitPair() {
  const pair = app.pair;
  if (!pair || pair.busy || pair.dead) return;
  pair.busy = true;
  pair.ui.setState({ busy: true, failure: null });
  try {
    await postPair(pair.code, pair.ui.name());
  } catch (error) {
    const failure = pairFailure(error);
    pair.busy = false;
    pair.dead = failure.final;
    pair.ui.setState({ busy: false, failure });
    return;
  }
  app.pair = null;
  app.fatal = null;
  await loadInfo();
}

/**
 * No runtime: a full page on every route; /api/info is retried on 5, 10, 30, 30 ... s until the core fits.
 * @param {any} info
 * @param {any} found
 */
function enterRuntime(info, found) {
  if (app.view && app.view.poller) app.view.poller.stop();
  const changed = !app.fatal || app.fatal.info.key !== info.key || app.fatal.found !== found;
  app.fatal = { info, found };
  if (app.recovery === null) {
    app.recovery = createPoller({
      fetchOnce: async () => {
        const body = await apiGet('/api/info');
        if (body && body.core && body.core.inRange === false) throw { status: 503, code: 'core-version', network: false, found: String(body.core.version ?? 'unknown') };
        return body;
      },
      intervalMs: 5000,
      onSuccess: (body) => recover(body),
      onFailure: (error) => {
        const next = classify(error, ctx());
        if (next.scope === 'session') enterSession(next);
        else if (next.scope === 'runtime') enterRuntime(next, error.found ?? (next.key === 'runtime-range' ? 'unknown' : 'nothing'));
      },
      retry: (error) => classify(error, ctx()).scope !== 'session',
    });
    app.recovery.start(BACKOFF_MS[0]);
  }
  if (changed && app.view) paint(app.view);
}

/** @param {any} body */
function recover(body) {
  if (app.recovery) app.recovery.stop();
  app.recovery = null;
  app.fatal = null;
  app.info = body;
  app.sessionWorked = true;
  showCoreVersion();
  notice('core-back');
  if (app.view) startView(app.view.route, { first: false, animate: false, focus: false });
}

function showCoreVersion() {
  const version = app.info && app.info.core && app.info.core.version;
  app.els.coreVersion.textContent = version ? `core ${version}` : '';
}

// ---- 7. boot ----

/** The launch code from `#c=<64 hex>`, removed from the address bar and history at once (even if the exchange fails). */
function takeFragmentCode() {
  const hash = globalThis.location.hash;
  if (!hash.startsWith('#c=')) return null;
  globalThis.history.replaceState(null, '', `${globalThis.location.pathname}${globalThis.location.search}#/`);
  const match = /^#c=([0-9a-f]{64})$/.exec(hash);
  return match ? match[1] : null;
}

/**
 * The pairing code and fingerprint from `#pair=<26 base32>&fp=<64 hex>&v=1`, removed from the address bar and history at
 * once (even when it does not parse), or null. They are kept in memory only.
 */
function takePairing() {
  const hash = globalThis.location.hash;
  if (!hash.startsWith('#pair=')) return null;
  globalThis.history.replaceState(null, '', `${globalThis.location.pathname}${globalThis.location.search}#/`);
  return parsePairFragment(hash);
}

/** @param {any} code @param {any} pairing */
async function finishBoot(code, pairing) {
  if (code !== null) {
    try {
      await postSession(code);
      app.exchange = 'ok';
      app.sessionWorked = true;
    } catch (error) {
      app.exchange = 'used';
      const info = classify(error, { exchange: 'used', sessionWorked: false });
      if (info.scope === 'session') {
        enterSession(info);
        app.ready = true;
        return;
      }
    }
  }
  if (pairing !== null) {
    enterPair(pairing);
    app.ready = true;
    return;
  }
  await loadInfo();
}

/** The first `/api/info` of the page: the core version and the session check; then the view begins. */
async function loadInfo() {
  try {
    const body = await apiGet('/api/info');
    app.sessionWorked = true;
    app.info = body;
    showCoreVersion();
    if (body.core && body.core.inRange === false) enterRuntime({ scope: 'runtime', key: 'runtime-range', auto: true, status: 503, code: 'core-version' }, String(body.core.version ?? 'unknown'));
  } catch (error) {
    const info = classify(error, ctx());
    if (info.scope === 'session') enterSession(info);
    else if (info.scope === 'runtime') enterRuntime(info, info.key === 'runtime-range' ? 'unknown' : 'nothing');
    // Offline or an inline error: the view's own fetch reports it with its own state.
  }
  app.ready = true;
  if (app.view && !app.fatal) beginView(app.view);
}

function boot() {
  const code = takeFragmentCode();
  const pairing = code === null ? takePairing() : null;
  const root = document.documentElement;
  try {
    app.els = {
      main: document.getElementById('main'),
      conn: document.getElementById('conn'),
      coreVersion: document.getElementById('core-version'),
      bannerSlot: document.getElementById('banner-slot'),
      pause: document.getElementById('pause'),
      navLinks: Array.from(document.querySelectorAll('.navrail__link')),
      shell: document.getElementById('shell'),
      attention: document.getElementById('attention'),
      inspector: document.getElementById('inspector'),
    };
    const brand = document.querySelector('.brand');
    if (brand && !brand.querySelector('.icon')) brand.prepend(icon('brand', 28));
    /** @type {Record<string, string>} */
    const railIcons = { '#/': 'rail-now', '#/sessions': 'rail-sessions', '#/workflows': 'rail-workflows', '#/layers': 'rail-layers', '#/workers': 'rail-workers', '#/advice': 'rail-advice', '#/followups': 'rail-followups', '#/settings': 'rail-settings', '#/health': 'rail-health', '#/more': 'rail-more' };
    for (const link of app.els.navLinks) {
      const name = railIcons[link.getAttribute('href')];
      if (name && !link.querySelector('.icon')) link.prepend(icon(name, 20));
    }
    if (app.els.shell && app.els.inspector) {
      const matchMedia = typeof globalThis.matchMedia === 'function' ? (/** @type {string} */ query) => globalThis.matchMedia(query) : undefined;
      app.inspector = createInspector({ doc: document, shell: app.els.shell, el: app.els.inspector, main: app.els.main, matchMedia });
    }
    setupThemeControl(document.querySelector('.theme'));
    // 162: an applied action, an unknown outcome or a stale refusal makes what the view shows old; its poller refetches at once (the
    // server has dropped its cache of the run). The answer says when the view holds the refreshed data, for "Review again".
    onRefetch(() => new Promise((resolve) => {
      const poller = app.view && app.view.poller;
      if (!poller || typeof poller.refreshAfterAction !== 'function' || !poller.refreshAfterAction(resolve)) resolve(false);
    }));
    if (app.els.pause) app.els.pause.addEventListener('click', () => togglePause());
    // The one shortcut registry (keys.js) binds the document once; each entry's action is a plain call into the shell.
    const go = (/** @type {string} */ hash) => () => { globalThis.location.hash = hash; };
    // The palette and the help list are never open together: each opening closes the other (IC-021).
    app.palette = createPalette({ doc: document, targets: paletteTargets, go: (hash) => { globalThis.location.hash = hash; } });
    app.shortcuts = installShortcuts({
      doc: document,
      // The action confirmation is modal: no shortcut runs under it, and the palette and help cannot open over it (162 review B-4).
      blocked: isConfirmOpen,
      actions: {
        palette: () => { app.shortcuts.closeHelp(); app.palette.open(); },
        help: () => { app.palette.close(); },
        pause: () => { togglePause(); }, 'go.runs': go('#/'), 'go.workflows': go('#/workflows'), 'go.sessions': go('#/sessions'), 'go.layers': go('#/layers'),
      },
    });
    const skip = document.querySelector('.skip');
    if (skip) {
      skip.addEventListener('click', (event) => {
        event.preventDefault();
        focusHeading();
      });
    }
    renderPill(app.els.conn, { state: 'unknown', long: 'Connecting', short: 'Connecting' });
    globalThis.addEventListener('hashchange', () => {
      // A route change (a link, Back) closes the action confirmation first: it belongs to the page it was opened on (162 review B-4).
      closeConfirm();
      const route = parseRoute(globalThis.location.hash);
      const view = app.view;
      const spec = route.view;
      const own = view ? hashFor(view.route) : null;
      // The address now names the route the view is on: a selection the view made itself (linkSelection).
      if (view && !app.fatal && own !== null && own === hashFor(route)) return;
      // A live view (Layers) patches its mounted body, so it reroutes only once loaded; the Run, Tasks, Sessions and Session
      // views keep the selection in their memory, which their next render reads too.
      const ready = spec.live !== true || (Boolean(view) && view.hasData && view.painted === loadedKey(view));
      if (view && !app.fatal && ready && typeof spec.reroute === 'function' && view.route.view === spec
        && hashFor(baseRoute(view.route)) === hashFor(baseRoute(route))) {
        // Between two routes of one view and one base route (the selection changed: a Session node or worker tab too): the
        // body is kept, so the focus stays.
        view.route = route;
        view.local.route = route;
        globalThis.document.title = titleFor(route, view.hasData ? view.data : null);
        spec.reroute(view.local, route.params, view.data);
        if (view.hasData) updateMeta(view);
        refreshStatus();
        return;
      }
      startView(route, { first: false, animate: true });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        app.hiddenAt = nowMs();
        stopTick();
      } else {
        // A long absence ends in a full refetch whose per-item changes are not announced one by one (FR-3).
        if (app.view && app.hiddenAt !== null && nowMs() - app.hiddenAt > RESYNC_AFTER_MS) app.view.resync = true;
        app.hiddenAt = null;
        startTick();
        // After the poller's own listener has marked its resume poll, so a return never flashes stale.
        Promise.resolve().then(refreshStatus);
      }
    });
    startView(parseRoute(globalThis.location.hash), { first: true });
    if (!document.hidden) startTick();
  } finally {
    root.classList.remove('booting');
  }
  return finishBoot(code, pairing);
}

boot();
