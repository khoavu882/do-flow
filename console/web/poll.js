// The poller (D.2 note sections 6.4 and 6.5). One poller per view instance: it fetches on an interval,
// pauses while the tab is hidden, backs off 5/10/30 s after failures, and answers the stale rule.
// Nothing here runs at import time; the clock and the visibility source are injectable.

/** Delay before the next attempt after the 1st, 2nd and 3rd-or-later failure in a row. */
const BACKOFF_MS = Object.freeze([5000, 10000, 30000]);
/** The data of a view is stale after this many failures in a row ... */
const STALE_MISSES = 3;
/** ... or when its last success is older than this. */
const STALE_AGE_MS = 15000;

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
 */
function createPoller(options) {
  const { fetchOnce, intervalMs, onSuccess = () => {}, onFailure = () => {}, retry = () => true } = options;
  const clock = options.clock ?? defaultClock;
  const visibility = options.visibility ?? defaultVisibility;

  let running = false;
  let inFlight = false;
  let resuming = false;
  /** @type {any} */
  let timer = null;
  /** @type {number | null} */
  let nextAt = null;
  let generation = 0;
  let misses = 0;
  let backoffStep = 0;
  /** @type {number | null} */
  let lastSuccessAt = null;
  /** @type {any} */
  let lastFailure = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;

  function clearTimer() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    nextAt = null;
  }

  // While hidden nothing is scheduled; the visibility listener polls once on return.
  /** @param {any} ms */
  function schedule(ms) {
    clearTimer();
    if (!running || visibility.hidden()) return;
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
      misses = 0;
      backoffStep = 0;
      lastFailure = null;
      lastSuccessAt = clock.now();
      onSuccess(value);
      schedule(intervalMs);
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

  function onVisibility() {
    if (!running) return;
    if (visibility.hidden()) {
      clearTimer();
      return;
    }
    if (inFlight) return;
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
      else if (!visibility.hidden()) pollNow();
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
    /** "Try again" / "Try now" / "Check now": fetch at once and restart the backoff. False when busy or stopped. */
    refreshNow() {
      if (!running || inFlight) return false;
      backoffStep = 0;
      pollNow();
      return true;
    },
    /** The stale rule of 6.4. Not evaluated while the tab is hidden or the poll after a return is in flight. */
    isStale() {
      if (!running || visibility.hidden() || resuming || lastSuccessAt === null) return false;
      return misses >= STALE_MISSES || clock.now() - lastSuccessAt > STALE_AGE_MS;
    },
    get active() { return running; },
    get inFlight() { return inFlight; },
    get misses() { return misses; },
    get lastSuccessAt() { return lastSuccessAt; },
    get lastFailure() { return lastFailure; },
    /** Epoch ms of the scheduled attempt, or null (in flight, paused, or ended). */
    get nextAt() { return nextAt; },
  };
}

export { BACKOFF_MS, STALE_MISSES, STALE_AGE_MS, createPoller };
