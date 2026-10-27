// The poller (D.2 note sections 6.4 and 6.5). One poller per view instance: it fetches on an interval,
// pauses while the tab is hidden, backs off 5/10/30 s after failures, and answers the stale rule.
// Feature 133 adds live discipline to the refresh interval only: it grows x10 while nothing is running (`isActive`),
// is at least nodes/1000 s for a large graph (`size`), and the person can pause polling (`pause` / `resume`).
// Nothing here runs at import time; the clock, the visibility source and the activity sources are injectable.

/** Delay before the next attempt after the 1st, 2nd and 3rd-or-later failure in a row. */
const BACKOFF_MS = Object.freeze([5000, 10000, 30000]);
/** The data of a view is stale after this many failures in a row ... */
const STALE_MISSES = 3;
/** ... or when its last success is older than this (plus any deliberate extra wait, see `extraWaitMs`). */
const STALE_AGE_MS = 15000;
/** The refresh interval is this many times longer while nothing is running. */
const IDLE_FACTOR = 10;

const defaultClock = {
  now: () => Date.now(),
  setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (/** @type {any} */ handle) => globalThis.clearTimeout(handle),
};

const defaultVisibility = {
  hidden: () => document.hidden === true,
  subscribe(/** @type {() => void} */ listener) {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
};

/**
 * @param {object} options
 * @param {() => Promise<any>} options.fetchOnce resolves with the data, or rejects with the failure
 * @param {number} options.intervalMs delay after a success
 * @param {(data: any) => void} [options.onSuccess]
 * @param {(error: any) => void} [options.onFailure]
 * @param {(error: any) => boolean} [options.retry] false ends polling after that failure (default: always retry)
 * @param {{ now(): number, setTimeout(fn: () => void, ms: number): any, clearTimeout(handle: any): void }} [options.clock]
 * @param {{ hidden(): boolean, subscribe(listener: () => void): () => void }} [options.visibility]
 * @param {() => boolean} [options.isActive] false while nothing is running: the refresh interval is x10 (default: always active)
 * @param {() => number} [options.size] graph size in nodes: the refresh interval is at least size/1000 s (default 0)
 */
function createPoller(options) {
  const { fetchOnce, intervalMs, onSuccess = () => {}, onFailure = () => {}, retry = () => true } = options;
  const clock = options.clock ?? defaultClock;
  const visibility = options.visibility ?? defaultVisibility;
  const isActive = options.isActive ?? (() => true);
  const size = options.size ?? (() => 0);

  let running = false;
  let paused = false;
  let staleAtPause = false; // the stale rule's answer when the person paused: a pause neither hides nor creates it
  let keepStale = false; // resumed from a stale pause: stale until a fetch succeeds
  let inFlight = false;
  let resuming = false;
  /** @type {any} */
  let timer = null;
  /** @type {number | null} */
  let nextAt = null;
  let generation = 0;
  let misses = 0;
  let backoffStep = 0;
  /** How much longer than the base the last success waited on purpose (idle or a large graph): the stale age allows for it. */
  let extraWaitMs = 0;
  /** @type {number | null} */
  let lastSuccessAt = null;
  /** @type {any} */
  let lastFailure = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;

  /** The delay after a success: the base, at least nodes/1000 s (= nodes ms), x10 while idle. Failure backoff is not scaled. */
  function refreshDelay() {
    const nodes = Number(size());
    const scaled = Math.max(intervalMs, Number.isFinite(nodes) && nodes > 0 ? nodes : 0);
    return isActive() ? scaled : scaled * IDLE_FACTOR;
  }

  function clearTimer() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    nextAt = null;
  }

  // While hidden nothing is scheduled; the visibility listener polls once on return.
  /** @param {any} ms */
  function schedule(ms) {
    clearTimer();
    if (!running || paused || visibility.hidden()) return;
    nextAt = clock.now() + ms;
    timer = clock.setTimeout(() => {
      timer = null;
      nextAt = null;
      pollNow();
    }, ms);
  }

  function pollNow() {
    clearTimer();
    if (!running || inFlight) return;
    inFlight = true;
    const mine = generation;
    let attempt;
    try {
      attempt = Promise.resolve(fetchOnce());
    } catch (error) {
      attempt = Promise.reject(error);
    }
    attempt.then(
      (data) => settle(mine, true, data),
      (error) => settle(mine, false, error),
    );
  }

  /** @param {any} mine @param {any} ok @param {any} value */
  function settle(mine, ok, value) {
    if (mine !== generation) return;
    inFlight = false;
    resuming = false;
    if (ok) {
      keepStale = false;
      misses = 0;
      backoffStep = 0;
      lastFailure = null;
      lastSuccessAt = clock.now();
      onSuccess(value);
      const wait = refreshDelay();
      extraWaitMs = Math.max(0, wait - intervalMs);
      schedule(wait);
      return;
    }
    misses += 1;
    lastFailure = value;
    // The retry is scheduled before the handler runs, so the handler can read `nextAt`; a handler that
    // ends polling (stop) clears it.
    if (retry(value)) {
      const delay = BACKOFF_MS[Math.min(backoffStep, BACKOFF_MS.length - 1)];
      backoffStep += 1;
      schedule(delay);
    }
    onFailure(value);
  }

  /** The stale rule itself. */
  function rawStale() {
    if (visibility.hidden() || resuming || lastSuccessAt === null) return false;
    return misses >= STALE_MISSES || clock.now() - lastSuccessAt > STALE_AGE_MS + extraWaitMs;
  }

  function onVisibility() {
    if (!running) return;
    if (visibility.hidden()) {
      clearTimer();
      return;
    }
    if (inFlight || paused) return;
    resuming = true;
    pollNow();
  }

  return {
    /**
     * Starts polling: the first fetch is at once (or on return, when the tab starts hidden), or after
     * `firstDelayMs` when given (a recovery poll that follows a failure just seen).
     */
    start(/** @type {number | undefined} */ firstDelayMs) {
      if (running) return;
      running = true;
      unsubscribe = visibility.subscribe(onVisibility);
      if (firstDelayMs !== undefined) schedule(firstDelayMs);
      else if (!visibility.hidden() && !paused) pollNow();
    },
    /** Ends polling; a fetch still in flight is ignored when it settles. */
    stop() {
      running = false;
      generation += 1;
      inFlight = false;
      resuming = false;
      clearTimer();
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    },
    /** The person pauses polling: nothing is scheduled; a fetch in flight settles and is kept. An explicit `refreshNow` still fetches once. */
    pause() {
      if (!running || paused) return;
      staleAtPause = rawStale();
      paused = true;
      clearTimer();
    },
    /** Polling resumes with a full fetch at once (no server replays what was missed). */
    resume() {
      if (!running || !paused) return;
      paused = false;
      keepStale = staleAtPause;
      staleAtPause = false;
      if (inFlight || visibility.hidden()) return;
      resuming = !keepStale;
      pollNow();
    },
    /** "Try again" / "Try now" / "Check now": fetch at once and restart the backoff. False when busy or stopped. */
    refreshNow() {
      if (!running || inFlight) return false;
      backoffStep = 0;
      pollNow();
      return true;
    },
    /** The stale rule of 6.4. Not evaluated while the tab is hidden or the poll after a return is in flight. */
    isStale() {
      if (!running) return false;
      if (paused) return staleAtPause;
      if (keepStale) return true;
      return rawStale();
    },
    get active() { return running; },
    get paused() { return paused; },
    get inFlight() { return inFlight; },
    get misses() { return misses; },
    get lastSuccessAt() { return lastSuccessAt; },
    get lastFailure() { return lastFailure; },
    /** Epoch ms of the scheduled attempt, or null (in flight, paused, or ended). */
    get nextAt() { return nextAt; },
  };
}

export { BACKOFF_MS, STALE_MISSES, STALE_AGE_MS, IDLE_FACTOR, createPoller };
