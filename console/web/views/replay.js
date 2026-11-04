// The replay bar (E.4; design.md section 7 V5): a native range input over the merged event list with a tick per event, play
// and pause, previous and next event, speed 1x, 4x and 16x, and Back to live. While scrubbed it shows a banner (the moment
// and "event n of m") and draws the run view or the graph from `viewAt`, the body folded up to that event. Polling goes on
// underneath: a new body re-mounts this wrapper, which keeps the position, the speed and the play state in `local.replay`.
// Elements are built with `h`, `icon` and `mount` only; the only style the code writes is `setProperty('--r-...')` (IC-007).

import { h, icon, mount, announce } from '../dom.js';
import { sinceStamp } from '../derive/rail.js';
import { SPEEDS, mergeEvents, viewAt, clampIndex, stepIndex, stepDelay, bannerWords, eventLabel } from '../derive/replay.js';

/** The bar draws at most this many ticks; a longer list shows every n-th one. */
const TICK_LIMIT = 200;

/** Whether the person has scrubbed away from live: the 1 s tick of the view stops then, because the page shows a past moment. @param {any} local */
function isReplaying(local) {
  return Boolean(local && local.replay && local.replay.index !== null);
}

/** @param {any} memory */
function stopTimer(memory) {
  if (memory.timer !== null) globalThis.clearTimeout(memory.timer);
  memory.timer = null;
}

/** Lets go of the play timer and the play state (the view's teardown). @param {any} local */
function releaseReplay(local) {
  if (!local || !local.replay) return;
  stopTimer(local.replay);
  local.replay.playing = false;
}

/**
 * Runs `fn` with the clock reading `ms`: the rail and the graph read `Date.now()` for their durations and stamps, and a past
 * moment must not read as days old. Restored even when `fn` throws. A null moment leaves the clock alone.
 * @param {number | null} ms
 * @param {() => any} fn
 */
function atMoment(ms, fn) {
  if (ms === null) return fn();
  const real = Date.now;
  Date.now = () => ms;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

/**
 * The view with its replay bar.
 * @param {any} data the run route's body
 * @param {any} local the view instance's own memory
 * @param {(view: any) => any} draw renders the view body from a body of the run route's shape
 * @param {{ place: 'above' | 'below' | 'before-timeline', enabled?: boolean }} options where the bar sits relative to the body, and whether this body can be replayed
 */
function withReplay(data, local, draw, { place, enabled = true }) {
  const memory = local.replay ?? (local.replay = { index: null, playing: false, speed: 1, timer: null });
  stopTimer(memory);
  const events = enabled ? mergeEvents(data.timeline ?? null, data.tasks ?? null) : [];
  const count = events.length;
  if (count === 0) {
    memory.index = null;
    memory.playing = false;
    return draw(data);
  }
  if (memory.index !== null) memory.index = clampIndex(memory.index, count);

  const host = h('div', { class: 'replay-host' });
  const banner = h('div', { class: 'replay__banner', hidden: true });
  const readout = h('p', { class: 'replay__read' });
  /** @type {any} */
  const range = h('input', { type: 'range', class: 'replay__range', min: 0, max: count - 1, step: 1, 'aria-label': 'Replay position', dataset: { focusKey: 'replay-range' } });

  const stride = Math.max(1, Math.ceil(count / TICK_LIMIT));
  const ticks = h('div', { class: 'replay__ticks', 'aria-hidden': 'true' }, events.map((event, i) => {
    if (i % stride !== 0 && i !== count - 1) return null;
    const tick = h('span', { class: 'replay__tick', dataset: { source: event.source, untimed: event.untimed ? 'true' : null } });
    tick.style.setProperty('--r-at', String(count === 1 ? 0 : i / (count - 1)));
    return tick;
  }));

  const button = (/** @type {string} */ key, /** @type {string} */ label, /** @type {string} */ glyph, /** @type {() => void} */ click) =>
    h('button', { type: 'button', class: 'btn btn--secondary replay__btn', 'aria-label': label, dataset: { focusKey: `replay-${key}` }, on: { click } }, icon(glyph, 16));
  const prev = button('prev', 'Previous event', 'step-back', () => { stopPlaying(); seek(stepIndex(memory.index ?? count - 1, count, -1), true); if (prev.getAttribute('disabled') !== null) range.focus({ preventScroll: true }); });
  const play = button('play', 'Play', 'play', () => (memory.playing ? pause(false) : start()));
  const next = button('next', 'Next event', 'step-forward', () => { stopPlaying(); seek(stepIndex(memory.index ?? count - 1, count, 1), true); if (next.getAttribute('disabled') !== null) range.focus({ preventScroll: true }); });
  const speeds = SPEEDS.map((speed) => h('button', {
    type: 'button', class: 'btn btn--secondary replay__speed', 'aria-pressed': 'false', dataset: { speed, focusKey: `replay-speed-${speed}` },
    on: { click: () => { memory.speed = speed; if (memory.playing) { stopTimer(memory); schedule(); } sync(); } },
  }, `${speed}x`));
  const live = h('button', { type: 'button', class: 'btn btn--secondary replay__live', dataset: { focusKey: 'replay-live' }, on: { click: () => backToLive() } }, 'Back to live');

  const bar = h('section', { class: 'replay', 'aria-label': 'Replay', dataset: { mode: 'live' } }, [
    h('div', { class: 'replay__head' }, [h('h2', { class: 'replay__title' }, 'Replay'), readout]),
    h('div', { class: 'replay__scrub' }, [range, ticks]),
    h('div', { class: 'replay__controls' }, [prev, play, next, h('div', { class: 'replay__speeds', role: 'group', 'aria-label': 'Speed' }, speeds), live]),
  ]);

  /** The folded state drawn last, for the banner and the readout. @type {any} */
  let shown = null;

  function sync() {
    const at = memory.index;
    const replaying = at !== null;
    bar.dataset.mode = replaying ? 'replay' : 'live';
    range.value = String(at ?? count - 1);
    if (replaying && shown) {
      const stamp = shown.moment === null ? null : sinceStamp(shown.moment, Date.now());
      const words = bannerWords({ event: shown.event, index: at, count }, stamp);
      range.setAttribute('aria-valuetext', `Event ${at + 1} of ${count}: ${eventLabel(shown.event)}`);
      readout.textContent = `Event ${at + 1} of ${count}`;
      mount(banner, [icon('replay', 20), h('p', { class: 'replay__bannertext' }, words)]);
      banner.removeAttribute('hidden');
    } else {
      range.setAttribute('aria-valuetext', `Live, ${count} events`);
      readout.textContent = `Live · ${count} ${count === 1 ? 'event' : 'events'}`;
      mount(banner, []);
      banner.setAttribute('hidden', '');
    }
    const label = memory.playing ? 'Pause' : 'Play';
    play.setAttribute('aria-label', label);
    mount(play, icon(memory.playing ? 'pause' : 'play', 16));
    if (at !== null && at <= 0) prev.setAttribute('disabled', ''); else prev.removeAttribute('disabled');
    if (at === null || at >= count - 1) next.setAttribute('disabled', ''); else next.removeAttribute('disabled');
    if (replaying) live.removeAttribute('disabled'); else live.setAttribute('disabled', '');
    speeds.forEach((el, i) => el.setAttribute('aria-pressed', SPEEDS[i] === memory.speed ? 'true' : 'false'));
  }

  /** @param {any} viewData */
  function bodyAt(viewData) {
    const body = draw(viewData);
    if (place !== 'before-timeline') return body;
    const parts = Array.isArray(body) ? body : [body];
    const timelineAt = parts.findIndex((part) => typeof part?.className === 'string' && part.className.split(/\s+/).includes('timeline'));
    const at = timelineAt < 0 ? parts.length : timelineAt;
    return { before: parts.slice(0, at), after: parts.slice(at) };
  }

  if (place === 'before-timeline') host.append(banner, bar);

  /** @param {any} viewData */
  function renderBody(viewData) {
    const body = bodyAt(viewData);
    if (place !== 'before-timeline') { mount(host, body); return; }
    // Keep the control subtree connected while replacing the surrounding view.
    // Detaching it would break keyboard focus and an active pointer drag.
    for (const child of Array.from(host.children)) {
      if (child !== banner && child !== bar) child.remove();
    }
    for (const child of body.before) host.insertBefore(child, bar);
    for (const child of body.after) host.append(child);
  }

  function paint() {
    const at = memory.index;
    if (at === null) {
      shown = null;
      renderBody(data);
    } else {
      const view = viewAt(data, events, at);
      shown = view.state;
      atMoment(view.state.moment, () => renderBody(view.data));
    }
    sync();
  }

  /** @param {number} index @param {boolean} speak */
  function seek(index, speak) {
    memory.index = clampIndex(index, count);
    paint();
    if (speak && shown) announce(bannerWords({ event: shown.event, index: memory.index, count }, shown.moment === null ? null : sinceStamp(shown.moment, Date.now())));
  }

  function stopPlaying() {
    memory.playing = false;
    stopTimer(memory);
  }

  /** @param {boolean} speak */
  function pause(speak) {
    stopPlaying();
    sync();
    if (speak) announce('Replay reached the latest event.');
  }

  function schedule() {
    memory.timer = globalThis.setTimeout(step, stepDelay(memory.speed));
  }

  function step() {
    memory.timer = null;
    if (!memory.playing) return;
    // The view was left or re-drawn: this closure's host is gone, and the new one carries the play on.
    if (host.isConnected === false) return;
    memory.index = stepIndex(memory.index ?? 0, count, 1);
    paint();
    if (memory.index >= count - 1) pause(true);
    else schedule();
  }

  function start() {
    memory.playing = true;
    if (memory.index === null || memory.index >= count - 1) memory.index = 0;
    paint();
    schedule();
  }

  function backToLive() {
    stopPlaying();
    memory.index = null;
    paint();
    announce('Back to live.');
    range.focus({ preventScroll: true });
  }

  range.addEventListener('input', () => { stopPlaying(); seek(Number(range.value), true); });

  paint();
  // A poll re-mounted the view while playing: this closure takes the play over.
  if (memory.playing) schedule();
  if (place === 'before-timeline') return [host];
  return place === 'below' ? [banner, host, bar] : [banner, bar, host];
}

export { withReplay, isReplaying, releaseReplay };
