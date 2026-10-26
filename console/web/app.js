// The Console client shell (D.2 note sections 6, 7 and 8): boot (theme first, then the launch-code
// exchange, then /api/info), the hash router with focus, the view lifecycle (loading, empty, error, loaded)
// over the poller, the global states (session, no-runtime, offline, stale), the connection pill and the
// theme control. The imported modules have no side effects; everything starts in the body below.

import { h, mount, icon, announce } from './dom.js';
import { createPoller, BACKOFF_MS } from './poll.js';
import {
  classify, clockTime, refreshReltimes, renderLoading, renderEmpty, renderError, renderFullPage, renderPill, createStaleBanner, errorTitle,
} from './states.js';
import { CORE_RANGE, parseRoute, titleFor, navFor } from './views.js';

// ---- 1. theme: the module's first statement, before the fragment is read or anything is fetched ----

applyTheme(readTheme());

function readTheme() {
  try {
    const stored = globalThis.localStorage.getItem('doflow-console-theme');
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** @param {any} choice */
function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
}

/** @param {any} fn */
const raf = (fn) => (globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(fn) : globalThis.setTimeout(fn, 0));

/** @param {any} choice @param {any} radios */
function chooseTheme(choice, radios) {
  const root = document.documentElement;
  root.classList.add('theme-switching');
  applyTheme(choice);
  try {
    globalThis.localStorage.setItem('doflow-console-theme', choice);
  } catch {
    // No storage: the choice holds for this page load only.
  }
  syncRadios(radios, choice);
  raf(() => raf(() => root.classList.remove('theme-switching')));
}

/** @param {any} radios @param {any} choice */
function syncRadios(radios, choice) {
  for (const radio of radios) {
    const on = radio.dataset.themeChoice === choice;
    radio.setAttribute('aria-checked', on ? 'true' : 'false');
    radio.setAttribute('tabindex', on ? '0' : '-1');
  }
}

/**
 * APG radio group: arrows move and select (wrapping), Home and End jump; Space and Enter click natively.
 * @param {any} group
 */
function setupThemeControl(group) {
  const radios = Array.from(group.querySelectorAll('[data-theme-choice]'));
  /** @type {Record<string, string>} */
  const icons = { light: 'sun', dark: 'moon', system: 'monitor' };
  for (const radio of radios) {
    if (!radio.querySelector('.icon')) radio.prepend(icon(icons[radio.dataset.themeChoice], 16));
    radio.addEventListener('click', () => chooseTheme(radio.dataset.themeChoice, radios));
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
      chooseTheme(radios[to].dataset.themeChoice, radios);
    });
  }
  syncRadios(radios, readTheme());
}

// ---- 2. the page, its state and the same-origin API ----

const app = /** @type {any} */ ({
  els: null,
  view: null,
  ready: false, // boot (exchange and /api/info) has finished
  info: null, // the last /api/info body
  exchange: 'none', // 'none' | 'ok' | 'used'
  sessionWorked: false,
  fatal: null, // { info, found }: a full page for every route (session error, no runtime)
  recovery: null, // the poller on /api/info that ends a no-runtime page
  banner: null, // the stale banner while the current view's data is stale
  tick: null,
  wasFull: false, // #main last held a full page (focus moves to the heading when a view replaces it)
});
let viewSeq = 0;

const MIN_SKELETON_MS = 300;

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
  mount(view.metaEl, spec.meta(view.route.params, view.hasData ? view.data : null, nowMs()));
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
  if (spec.isEmpty(view.data)) return { key: 'empty', nodes: () => renderEmpty(spec.empty) };
  return { key: `data:${view.dataText}`, nodes: () => spec.render(view.data, view.route.params, view.local) };
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
      mount(main, renderFullPage({
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
    const hadFocus = view.body.contains(document.activeElement);
    const focusKey = focusKeyOf(document.activeElement);
    mount(view.body, next.nodes());
    view.painted = next.key;
    if (hadFocus && !view.body.contains(document.activeElement)) {
      // E.1 8.4: the element with the same data-focus-key takes the focus back; the heading is the fallback.
      const again = focusKey === null ? null : view.body.querySelector(`[data-focus-key="${focusKey}"]`);
      (again ?? view.h1).focus({ preventScroll: true });
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
  if (offline && (!view.hasData || stale)) return { state: 'unknown', long: 'Offline', short: 'Offline' };
  if (stale) return { state: 'stale', long: `Stale · ${clockTime(poller.lastSuccessAt)}`, short: 'Stale' };
  if (poller.lastFailure !== null) return { state: 'unknown', long: 'Retrying', short: 'Retrying' };
  if (poller.lastSuccessAt === null) return { state: 'unknown', long: 'Connecting', short: 'Connecting' };
  const age = Math.max(0, now - poller.lastSuccessAt);
  const text = age < 5000 ? 'just now' : `${age < 60000 ? `${Math.floor(age / 1000)} s` : `${Math.floor(age / 60000)} min`} ago`;
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
    announce(`Data is out of date. Last updated ${clockTime(since)}.`);
  } else if (!on && app.banner !== null) {
    app.banner.leave();
    app.banner = null;
    delete main.dataset.stale;
    announce('Up to date again.');
  }
  if (on && app.banner) {
    const failure = view.poller.lastFailure;
    const why = failure === null ? 'slow' : classify(failure, ctx()).scope === 'offline' ? 'offline' : 'error';
    app.banner.update(now, why);
  }
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
  if (view) updateCountdowns(view, now);
  refreshReltimes(mainEl(), now);
  const spec = view && view.route.view;
  if (spec && spec.tick && view.hasData && !app.fatal && view.painted === `data:${view.dataText}`) spec.tick(mainEl(), now, view.local);
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
}

/** @param {any} href */
function setNav(href) {
  for (const link of app.els.navLinks) {
    if (link.getAttribute('href') === href) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
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
    local: {}, // the view's own memory (E.1): what its render, load and tick keep between polls
    root: null,
    painted: null,
    fullKey: null,
    animate: animate && !first,
  };
  app.view = view;
  globalThis.document.title = titleFor(route);
  const navHref = navFor(route);
  setNav(navHref === null ? null : navHref === 'workflows' ? '#/workflows' : '#/');
  paint(view);
  if (!first && focus) {
    globalThis.scrollTo(0, 0);
    focusHeading();
  }
  if (app.ready) beginView(view);
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
  if (path === null) {
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
  const poller = createPoller({
    fetchOnce: () => (!heartbeat && view.route.view.load ? view.route.view.load(view.local, apiGet) : apiGet(path)),
    intervalMs,
    onSuccess: (body) => onData(view, body, heartbeat),
    onFailure: (error) => onFail(view, error, heartbeat),
    retry: (error) => {
      const info = classify(error, ctx());
      if (info.scope === 'session' || info.scope === 'runtime') return false;
      return heartbeat || view.hasData || info.auto;
    },
  });
  view.poller = poller;
  poller.start();
}

/** @param {any} view @param {any} body @param {any} heartbeat */
function onData(view, body, heartbeat) {
  if (view !== app.view) return;
  app.sessionWorked = true;
  view.fail = null;
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
  view.hasData = true;
  view.data = body;
  view.dataText = text;
  if (view.skeletonTimer) {
    globalThis.clearTimeout(view.skeletonTimer);
    view.skeletonTimer = null;
  }
  globalThis.document.title = titleFor(view.route, body);
  if (changed) paint(view);
  else refreshStatus();
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
  announce('DoFlow is reachable again.');
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

/** @param {any} code */
async function finishBoot(code) {
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
  const root = document.documentElement;
  try {
    app.els = {
      main: document.getElementById('main'),
      conn: document.getElementById('conn'),
      coreVersion: document.getElementById('core-version'),
      bannerSlot: document.getElementById('banner-slot'),
      navLinks: Array.from(document.querySelectorAll('.nav__link')),
    };
    const brand = document.querySelector('.brand');
    if (brand && !brand.querySelector('.icon')) brand.prepend(icon('brand', 28));
    setupThemeControl(document.querySelector('.theme'));
    const skip = document.querySelector('.skip');
    if (skip) {
      skip.addEventListener('click', (event) => {
        event.preventDefault();
        focusHeading();
      });
    }
    renderPill(app.els.conn, { state: 'unknown', long: 'Connecting', short: 'Connecting' });
    globalThis.addEventListener('hashchange', () => startView(parseRoute(globalThis.location.hash), { first: false, animate: true }));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopTick();
      else {
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
  return finishBoot(code);
}

boot();
