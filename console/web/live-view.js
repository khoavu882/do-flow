// The live view connector (feature 149, IC-018; FR-017, FR-018, FR-019, DEC-013, DEC-016, DEC-033, DEC-039). It gives the
// Runs, Run, Tasks and Sessions views one object that answers the poller interface the shell reads (app.js startPoller), plus
// `mode` (`connecting`, `live`, `polling`) and `intervalMs`, so the pill, the stale banner, "Try again" and the pause control
// work unchanged. The data comes from the page's one live store (store.js, IC-017) while the stream is up, and from the view's
// GET through createPoller (poll.js) while it is not.
//
// - Start: the store subscription and the view's GET run at the same time. The GET is the first answer of a poller with the
//   view's interval, `retry`, `active` and `size`; the first `state` of the channel stops that poller, so a GET answer that
//   arrives after a snapshot is ignored (DEC-039), and no GET timer runs while live. A channel that already holds a state
//   answers at once and no GET is made.
// - Live: the view's member of the channel state (IC-012) with status 200 goes to `onData` (wrapped when the view wraps its GET
//   body); any other status goes to `onFailure({ status, code, network: false })`, as a failed GET does. A state whose member
//   is the same object as the last one delivered (copy-on-write: a patch of another member) delivers nothing.
// - Polling: on a transport `refused`, `unsupported` (an old core, or no stream support in the page) or `closed`, on a channel
//   `error`, `reset` or `gone`, or on a state without the member, the poller runs over the view's GET; the subscription stays,
//   so the store's own reopening can bring the view back: the next `state`, or an open stream over a channel whose state the
//   store kept (a reopen with `since` sends nothing when nothing moved), stops the poller. Entering polling says `push-lost`
//   with the interval in seconds; returning says `push-back`.
// - `lastSuccessAt` is the time of the newest applied frame or successful fetch, never the time of reading (FR-018). Live
//   stale rule: data has arrived and the connection has not been open for 20000 ms (a hidden tab or a pause does not count).
//   Polling: poll.js's rule, except while the poller that took over from live data has had no success yet (its first GET
//   hangs on a frozen server): then the live rule goes on, counted from when the connection stopped being open.
// - Pause and resume reach the store (it closes the stream and reopens with `since`) and the poller. Back from a pause or a
//   hidden tab while live, the view's GET is read once, as poll.js reads once on return, so the shell's full-refresh rule
//   (`resync`) meets a full state even when the reopened stream has nothing to send.

import { createPoller } from './poll.js';
import { notice } from './notices.js';
import { isChannel } from './live.js';

/** Live stale rule: the connection has not been open for this long after data had arrived. */
const LIVE_STALE_MS = 20000;
/** Transport states that end live mode. */
const DOWN_STATES = Object.freeze(['refused', 'unsupported', 'closed']);
/** Transport states in which nothing is expected: they never count against the live stale rule. */
const AWAY_STATES = Object.freeze(['idle', 'hidden', 'paused']);

/**
 * @typedef {object} LiveViewConfig
 * @property {(params: any) => string} channel the IC-003 channel the view reads
 * @property {string} member the member of the channel state that equals the view's GET reply (IC-012)
 * @property {number} intervalMs the poll interval while polling
 * @property {(local: any, body: any, fetchJson: (path: string) => Promise<any>) => any} [wrap] turns a member body into the
 *   view's data as its GET read does; may return a promise
 */

/**
 * @typedef {object} ConnectHooks
 * @property {(path: string) => Promise<any>} fetchJson the shell's same-origin GET
 * @property {(body: any) => void} onData
 * @property {(error: any) => void} onFailure
 * @property {() => void} [onResync]
 * @property {() => any} store the page's one live store (created on first use)
 * @property {() => Promise<any>} fetchOnce the view's GET read, as its poller makes it
 * @property {(error: any) => boolean} [retry]
 * @property {() => boolean} [isActive]
 * @property {() => number} [size]
 */

/** @param {number | null} a @param {number | null} b */
const newest = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b));

/**
 * The `connect(local, params, hooks)` of one view (views.js) over `config`.
 * @param {LiveViewConfig} config
 */
function connectLive(config) {
  /** @param {any} local @param {any} params @param {ConnectHooks} hooks */
  return (local, params, hooks) => createLiveView(config, local, params, hooks);
}

/**
 * @param {LiveViewConfig} config
 * @param {any} local
 * @param {any} params
 * @param {ConnectHooks} hooks
 */
function createLiveView(config, local, params, hooks) {
  const { member, intervalMs, wrap } = config;
  const { fetchJson, onData, onFailure, fetchOnce } = hooks;
  const channel = config.channel(params);
  const now = () => Date.now();

  let running = false;
  let stopped = false;
  let paused = false;
  /** @type {'connecting' | 'live' | 'polling'} */
  let mode = 'connecting';
  /** @type {any} */
  let store = null;
  /** @type {ReturnType<typeof createPoller> | null} */
  let poller = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  /** @type {(() => void) | null} */
  let unTransport = null;
  let transport = 'idle';
  let hadData = false;
  /** @type {number | null} */
  let frameAt = null;
  /** @type {number | null} */
  let fetchAt = null;
  /** @type {any} */
  let liveFailure = null;
  let liveMisses = 0;
  /** @type {any} the member object delivered last */
  let lastMember;
  /** Bumped by every delivery: a slower answer (an async wrap, a live GET) of an earlier moment is dropped. */
  let deliverSeq = 0;
  let refetching = false;
  /** @type {number | null} when the connection last stopped being open while it was expected to be */
  let downSince = null;
  /** The channel holds a state the store keeps (a `state` came, and no `error`, `reset` or `gone` since). */
  let channelOk = false;
  /** The poller now running has answered once (poll.js's stale rule needs a success first). */
  let polledOk = false;

  /** @param {any} data */
  function apply(data) {
    deliverSeq += 1;
    onData(data);
  }

  /** A member body to the view, wrapped as its GET read wraps it. @param {any} body */
  function deliver(body) {
    deliverSeq += 1;
    const seq = deliverSeq;
    const data = wrap ? wrap(local, body, fetchJson) : body;
    if (data && typeof data.then === 'function') {
      data.then((/** @type {any} */ value) => {
        if (!stopped && seq === deliverSeq) onData(value);
      }, () => {});
    } else onData(data);
  }

  /** The poller over the view's GET: the first paint, and polling mode. */
  function startPoller() {
    if (poller !== null) poller.stop();
    polledOk = false;
    const mine = createPoller({
      fetchOnce,
      intervalMs,
      onSuccess: (data) => {
        if (stopped || poller !== mine) return;
        fetchAt = now();
        hadData = true;
        polledOk = true;
        apply(data);
      },
      onFailure: (error) => {
        if (!stopped && poller === mine) onFailure(error);
      },
      retry: hooks.retry,
      isActive: hooks.isActive,
      size: hooks.size,
    });
    poller = mine;
    if (paused) {
      mine.start(intervalMs);
      mine.pause();
    } else mine.start();
  }

  function goLive() {
    if (mode === 'live') return;
    const was = mode;
    mode = 'live';
    if (poller !== null) poller.stop();
    poller = null;
    if (was === 'polling') notice('push-back');
  }

  function enterPolling() {
    if (stopped || mode === 'polling') return;
    mode = 'polling';
    liveFailure = null;
    liveMisses = 0;
    lastMember = undefined;
    if (poller === null) startPoller();
    notice('push-lost', String(intervalMs / 1000));
  }

  /** One read of the view's GET while live (back from a pause or a hidden tab, or "Try again"). */
  function refetch() {
    if (refetching || stopped) return false;
    refetching = true;
    const seq = deliverSeq;
    let attempt;
    try {
      attempt = Promise.resolve(fetchOnce());
    } catch (error) {
      attempt = Promise.reject(error);
    }
    attempt.then(
      (data) => {
        refetching = false;
        if (stopped || mode !== 'live' || seq !== deliverSeq) return;
        fetchAt = now();
        hadData = true;
        liveFailure = null;
        liveMisses = 0;
        apply(data);
      },
      (error) => {
        refetching = false;
        if (!stopped && mode === 'live' && seq === deliverSeq) onFailure(error);
      },
    );
    return true;
  }

  /** @param {{ kind: string, state: any, code: string | null }} event */
  function onLive(event) {
    if (stopped || !event) return;
    if (event.kind !== 'state') {
      channelOk = false;
      enterPolling();
      return;
    }
    const entry = event.state && typeof event.state === 'object' ? event.state[member] : undefined;
    if (!entry || typeof entry !== 'object' || typeof entry.status !== 'number') {
      channelOk = false;
      enterPolling();
      return;
    }
    channelOk = true;
    goLive();
    if (entry === lastMember) return;
    lastMember = entry;
    if (entry.status === 200) {
      liveFailure = null;
      liveMisses = 0;
      frameAt = now();
      hadData = true;
      deliver(entry.body);
      return;
    }
    const body = entry.body;
    const code = body && body.error && typeof body.error.code === 'string' ? body.error.code : null;
    liveFailure = { status: entry.status, code, network: false };
    liveMisses += 1;
    deliverSeq += 1;
    onFailure(liveFailure);
  }

  /** @param {{ state: string, code: string | null, at: any }} event */
  function onTransport(event) {
    if (stopped || !event) return;
    const was = transport;
    transport = event.state;
    if (event.state === 'open' || AWAY_STATES.includes(event.state)) downSince = null;
    else if (downSince === null) downSince = typeof event.at === 'number' ? event.at : now();
    if (DOWN_STATES.includes(event.state)) {
      enterPolling();
      return;
    }
    // A reopen with `since` after `closed` or a refusal sends nothing when the channel did not move (IC-013): an open stream
    // over a channel whose state is intact is the recovery, so the view is live again without waiting for a change.
    if (event.state === 'open' && mode === 'polling' && channelOk) {
      goLive();
      return;
    }
    if ((was === 'hidden' || was === 'paused') && !AWAY_STATES.includes(event.state) && mode === 'live') refetch();
  }

  return {
    start() {
      if (running || stopped) return;
      running = true;
      store = hooks.store();
      const valid = isChannel(channel);
      transport = store.status().transport;
      unTransport = store.onTransport(onTransport);
      if (valid) unsubscribe = store.subscribe(channel, onLive); // a channel holding a state answers at once
      if (mode === 'connecting') startPoller(); // the first paint
      if (!valid || DOWN_STATES.includes(transport)) enterPolling();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      running = false;
      if (poller !== null) poller.stop();
      poller = null;
      if (unsubscribe) unsubscribe();
      if (unTransport) unTransport();
      unsubscribe = null;
      unTransport = null;
      // The store is the page's: a pause of this view ends with it.
      if (paused && store) store.resume();
    },
    pause() {
      if (!running || paused) return;
      paused = true;
      if (poller !== null) poller.pause();
      store.pause();
    },
    resume() {
      if (!running || !paused) return;
      paused = false;
      if (poller !== null) poller.resume();
      store.resume();
    },
    /** "Try again": the poller's refresh while polling; one GET while live. False when busy or stopped. */
    refreshNow() {
      if (!running) return false;
      if (mode === 'live') return refetch();
      return poller !== null ? poller.refreshNow() : false;
    },
    isStale() {
      if (!running) return false;
      if (mode !== 'live') {
        // Polling took over from data that had arrived and has not answered yet: the live rule still holds.
        if (hadData && !polledOk) return !paused && downSince !== null && now() - downSince > LIVE_STALE_MS;
        return poller !== null ? poller.isStale() : false;
      }
      if (paused || !hadData || downSince === null) return false;
      return now() - downSince > LIVE_STALE_MS;
    },
    get mode() { return mode; },
    get intervalMs() { return intervalMs; },
    get active() { return running; },
    get paused() { return paused; },
    get inFlight() { return mode === 'live' ? refetching : poller !== null && poller.inFlight; },
    get misses() { return mode === 'live' ? liveMisses : poller !== null ? poller.misses : 0; },
    get lastSuccessAt() { return newest(frameAt, fetchAt); },
    get lastFailure() { return mode === 'live' ? liveFailure : poller !== null ? poller.lastFailure : null; },
    get nextAt() { return mode !== 'live' && poller !== null ? poller.nextAt : null; },
  };
}

export { LIVE_STALE_MS, connectLive };
