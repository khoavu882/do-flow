// The Fleet transport (V.10; IC-025; design ui/V8.md 7b.2, 7b.3, 7b.6). One EventSource per page, opened on a Fleet route and
// closed when the person leaves it or the tab is hidden. After 3 stream errors in a row, when EventSource is missing, or when
// the Console answers 429 (stream-limit), the page polls /api/fleet every 5 s and /api/transcript every 2 s from the last
// cursor; every view renders the same, only the mode changes. A pushed stream is tried again every 60 s while the tab is
// visible. Transcript text only passes through the handlers: nothing here keeps it, and nothing here touches a storage API
// (IC-026). The clock, the visibility source, EventSource and the fetches are injected, so the module is exercised with a
// fake clock and a fake EventSource. It answers the poller interface of the shell (poll.js) so the connection pill, the stale
// banner and "Try again" work unchanged: `isStale()`, `lastSuccessAt`, `lastFailure`, `nextAt`, `misses`, `refreshNow()`.

/** Stream errors in a row before the page polls. */
const FALLBACK_AFTER = 3;
const FLEET_POLL_MS = 5000;
const TRANSCRIPT_POLL_MS = 2000;
/** A pushed stream is tried again this often while the page polls. */
const RETRY_PUSH_MS = 60000;
/** Push counts as stale when the connection has been broken this long (the server keeps a 15 s keepalive that EventSource does not show). */
const STALE_PUSH_MS = 20000;
/** A missed poll count that makes polled data stale. */
const STALE_MISSES = 3;
/** Wait before the page reopens a stream the browser gave up on. */
const REOPEN_MS = 5000;

/** Server error codes that mean the target is gone: the stream ends, the view says so, polling would only repeat it. */
const GONE_CODES = Object.freeze(['project-not-found', 'agent-not-in-project', 'session-not-in-project']);

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

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
 * The status of the stream route without keeping a stream: the request is aborted as soon as the head is in. Used once, after
 * the browser gave up on a stream, to tell 429 (another tab holds the push) from any other refusal.
 * @param {string} url
 */
async function defaultProbe(url) {
  const controller = new AbortController();
  try {
    const reply = await globalThis.fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'text/event-stream' } });
    let code = null;
    if (!reply.ok) {
      try {
        const body = await reply.json();
        code = body && body.error && typeof body.error.code === 'string' ? body.error.code : null;
      } catch {
        // No body: the status stands alone.
      }
    }
    return { status: reply.status, code };
  } finally {
    controller.abort();
  }
}

/** @param {string} path */
async function defaultFetchJson(path) {
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
    // An empty or non-JSON body carries no code.
  }
  if (!reply.ok) throw { status: reply.status, code: body && body.error && typeof body.error.code === 'string' ? body.error.code : null, network: false };
  return body;
}

/**
 * @param {object} options
 * @param {string | null} options.project the project key of the route, or null on the project list
 * @param {string | null} options.agent the selected agent key, or null
 * @param {{ resync?(): void, snapshot(body: any): void, fleet(delta: any): void, transcript(body: any, meta: { resumed: boolean }): void, streamError(info: any): void, mode(state: { mode: string, reason: string | null, at: number }): void, failure(error: any): void }} options.handlers
 * @param {any} [options.EventSource] the constructor (default: the page's)
 * @param {(path: string) => Promise<any>} [options.fetchJson] rejects with `{ status, code, network }`
 * @param {(url: string) => Promise<{ status: number, code: string | null }>} [options.probe]
 * @param {{ now(): number, setTimeout(fn: () => void, ms: number): any, clearTimeout(handle: any): void }} [options.clock]
 * @param {{ hidden(): boolean, subscribe(listener: () => void): () => void }} [options.visibility]
 */
function createFleetStream(options) {
  const { handlers } = options;
  const clock = options.clock ?? defaultClock;
  const visibility = options.visibility ?? defaultVisibility;
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const probe = options.probe ?? defaultProbe;
  const SourceCtor = 'EventSource' in options ? options.EventSource : globalThis.EventSource;

  let project = options.project;
  let agent = options.agent;
  let running = false;
  let paused = false; // the person paused the view: it is treated like a hidden tab until `resume`
  let ended = false; // the target is gone: nothing more is opened
  let generation = 0;
  /** @type {any} */
  let source = null;
  let trial = false; // `source` is a push attempt made while polling; its first frame ends the polling
  let mode = 'connecting';
  /** @type {string | null} */
  let reason = null;
  let errors = 0;
  let misses = 0;
  /** @type {number | null} */
  let lastFrameAt = null;
  /** @type {number | null} */
  let brokenSince = null;
  /** @type {any} */
  let lastFailure = null;
  /** @type {string | null} */
  let cursor = null;
  let resumed = false;
  let resuming = false;
  let dropped = false; // the connection broke after frames arrived: the next frame follows a reconnect, whatever `mode` says
  /** @type {string | null} */
  let discovered = null;
  let fleetBusy = false;
  let transcriptBusy = false;
  /** @type {any} */
  let fleetTimer = null;
  /** @type {any} */
  let transcriptTimer = null;
  /** @type {any} */
  let retryTimer = null;
  /** @type {number | null} */
  let nextAt = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;

  const urlKey = () => project ?? discovered;
  const streamUrl = () => `/api/stream?project=${urlKey()}${agent ? `&agent=${agent}` : ''}`;
  const hidden = () => visibility.hidden() || paused;
  /** The page polls: in fallback, under the stream limit, or while it waits for a project key to open a stream on. */
  const polling = () => mode === 'fallback' || mode === 'limit' || reason === 'no-project';

  /** @param {string} next @param {string | null} [why] */
  function setMode(next, why = null) {
    if (mode === next && reason === why) return;
    mode = next;
    reason = why;
    handlers.mode({ mode, reason, at: clock.now() });
  }

  function clearPolls() {
    for (const handle of [fleetTimer, transcriptTimer]) if (handle !== null) clock.clearTimeout(handle);
    fleetTimer = null;
    transcriptTimer = null;
    nextAt = null;
  }

  function clearRetry() {
    if (retryTimer !== null) clock.clearTimeout(retryTimer);
    retryTimer = null;
  }

  function closeSource() {
    if (source !== null) {
      const old = source;
      source = null;
      try {
        old.close();
      } catch {
        // Already closed.
      }
    }
    trial = false;
  }

  /** A frame (a data event) arrived: the connection is alive. */
  function frame() {
    // A frame after an earlier one while the connection was not pushing: the snapshot that follows is a full refetch.
    if (lastFrameAt !== null && (resuming || dropped || mode !== 'push' || trial) && handlers.resync) handlers.resync();
    dropped = false;
    lastFrameAt = clock.now();
    resuming = false;
    errors = 0;
    brokenSince = null;
    if (trial) {
      // The push attempt made while polling worked: the polls end.
      trial = false;
      clearPolls();
      clearRetry();
      misses = 0;
      setMode('push');
    } else if (mode !== 'push') setMode('push');
  }

  // ---- push ----------------------------------------------------------------------------------------

  /** @param {boolean} asTrial */
  function openSource(asTrial) {
    if (!running || ended || hidden() || SourceCtor === undefined || urlKey() === null) return;
    closeSource();
    trial = asTrial;
    if (!asTrial) setMode('connecting');
    const mine = generation;
    const es = new SourceCtor(streamUrl());
    source = es;
    es.addEventListener('open', () => {
      if (mine === generation && source === es) brokenSince = null;
    });
    for (const name of ['snapshot', 'fleet', 'transcript']) {
      es.addEventListener(name, (/** @type {any} */ event) => {
        if (mine !== generation || source !== es) return;
        let body;
        try {
          body = JSON.parse(event.data);
        } catch {
          return;
        }
        frame();
        if (name === 'snapshot') handlers.snapshot(body);
        else if (name === 'fleet') handlers.fleet(body);
        else {
          if (body && typeof body.cursor === 'string') cursor = body.cursor;
          handlers.transcript(body, { resumed });
          resumed = false;
        }
      });
    }
    es.addEventListener('error', (/** @type {any} */ event) => {
      if (mine !== generation || source !== es) return;
      if (event && typeof event.data === 'string') {
        serverError(event.data);
        return;
      }
      connectionError(es);
    });
  }

  /** An `event: error` the Console sent: `{code, verb, exit}`. @param {string} data */
  function serverError(data) {
    let info;
    try {
      info = JSON.parse(data);
    } catch {
      return;
    }
    handlers.streamError(info);
    if (info && GONE_CODES.includes(info.code)) {
      ended = true;
      closeSource();
      clearPolls();
      clearRetry();
    }
  }

  /** The connection failed. @param {any} es */
  function connectionError(es) {
    if (trial) {
      // A trial that fails leaves the polling as it is; the next trial is a minute away.
      closeSource();
      scheduleTrial();
      return;
    }
    if (brokenSince === null) brokenSince = clock.now();
    dropped = true;
    if (es.readyState === CLOSED) {
      // The browser gave up (a refusal, not a dropped connection): ask once whether it was the stream limit.
      closeSource();
      const mine = generation;
      probe(streamUrl()).then(
        (answer) => {
          if (mine !== generation || !running) return;
          if (answer.status === 429) startFallback('stream-limit');
          else countError();
        },
        () => {
          if (mine === generation && running) countError();
        },
      );
      return;
    }
    countError();
  }

  function countError() {
    errors += 1;
    if (errors >= FALLBACK_AFTER) {
      closeSource();
      startFallback('errors');
      return;
    }
    if (source === null) {
      // Reopen after the Console's own retry delay.
      const mine = generation;
      clearRetry();
      retryTimer = clock.setTimeout(() => {
        retryTimer = null;
        if (mine === generation) openSource(false);
      }, REOPEN_MS);
    }
  }

  // ---- polling -------------------------------------------------------------------------------------

  /** @param {string} why */
  function startFallback(why) {
    if (ended) return;
    closeSource();
    clearRetry();
    clearPolls();
    errors = 0;
    misses = 0;
    brokenSince = null;
    if (why === 'no-project') setMode('connecting', why);
    else setMode(why === 'stream-limit' ? 'limit' : 'fallback', why);
    if (!running || hidden()) return;
    pollFleet();
    if (agent) pollTranscript();
    if (why !== 'no-eventsource' && why !== 'no-project') scheduleTrial();
  }

  function scheduleTrial() {
    clearRetry();
    if (!running || ended || SourceCtor === undefined || urlKey() === null) return;
    const mine = generation;
    retryTimer = clock.setTimeout(() => {
      retryTimer = null;
      if (mine !== generation || !running || hidden() || !polling()) return;
      openSource(true);
      scheduleTrial();
    }, RETRY_PUSH_MS);
  }

  function pollFleet() {
    if (!running || ended || hidden() || fleetBusy || !polling()) return;
    fleetBusy = true;
    const mine = generation;
    fetchJson('/api/fleet').then(
      (body) => {
        if (mine !== generation) return;
        fleetBusy = false;
        misses = 0;
        lastFailure = null;
        if (resuming && lastFrameAt !== null && handlers.resync) handlers.resync();
        lastFrameAt = clock.now();
        resuming = false;
        handlers.snapshot(body);
        if (discovered === null && body && Array.isArray(body.projects) && body.projects.length > 0) {
          discovered = body.projects[0].projectKey;
          if (reason === 'no-project') {
            // A key to open the stream on: the polls end and the stream takes over.
            clearPolls();
            setMode('connecting');
            openSource(false);
            return;
          }
        }
        scheduleFleet();
      },
      (error) => {
        if (mine !== generation) return;
        fleetBusy = false;
        misses += 1;
        lastFailure = error;
        handlers.failure(error);
        scheduleFleet();
      },
    );
  }

  function scheduleFleet() {
    if (fleetTimer !== null) clock.clearTimeout(fleetTimer);
    fleetTimer = null;
    if (!running || ended || hidden() || !polling()) return;
    const mine = generation;
    nextAt = clock.now() + FLEET_POLL_MS;
    fleetTimer = clock.setTimeout(() => {
      fleetTimer = null;
      nextAt = null;
      if (mine === generation) pollFleet();
    }, FLEET_POLL_MS);
  }

  function pollTranscript() {
    if (!running || ended || hidden() || transcriptBusy || !agent || urlKey() === null || !polling()) return;
    transcriptBusy = true;
    const mine = generation;
    fetchJson(`/api/transcript?project=${urlKey()}&agent=${agent}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).then(
      (body) => {
        if (mine !== generation) return;
        transcriptBusy = false;
        if (body && typeof body.cursor === 'string') cursor = body.cursor;
        lastFrameAt = clock.now();
        handlers.transcript(body, { resumed: false });
        scheduleTranscript();
      },
      (error) => {
        if (mine !== generation) return;
        transcriptBusy = false;
        handlers.failure(error);
        scheduleTranscript();
      },
    );
  }

  function scheduleTranscript() {
    if (transcriptTimer !== null) clock.clearTimeout(transcriptTimer);
    transcriptTimer = null;
    if (!running || ended || hidden() || !agent || !polling()) return;
    const mine = generation;
    transcriptTimer = clock.setTimeout(() => {
      transcriptTimer = null;
      if (mine === generation) pollTranscript();
    }, TRANSCRIPT_POLL_MS);
  }

  // ---- the page -------------------------------------------------------------------------------------

  /** Opens whatever the current mode needs. */
  function connect() {
    if (!running || ended || hidden()) return;
    if (SourceCtor === undefined) {
      startFallback('no-eventsource');
      return;
    }
    if (mode === 'fallback' || mode === 'limit') {
      startFallback(reason ?? 'errors');
      return;
    }
    if (urlKey() === null) {
      // No project key yet (the project list): read the fleet once, then open the stream on a listed key.
      startFallback('no-project');
      return;
    }
    openSource(false);
  }

  /** Nothing open, nothing scheduled (a hidden tab, or the person's pause). */
  function suspend() {
    generation += 1;
    closeSource();
    clearPolls();
    clearRetry();
    fleetBusy = false;
    transcriptBusy = false;
  }

  function onVisibility() {
    if (!running) return;
    if (hidden()) {
      suspend();
      return;
    }
    // Back: the next transcript batch may start from the transcript's last records, so the panel drops what it already holds.
    resumed = agent !== null;
    resuming = true;
    errors = 0;
    brokenSince = null;
    if (mode === 'push') setMode('connecting');
    connect();
  }

  return {
    start() {
      if (running) return;
      running = true;
      unsubscribe = visibility.subscribe(onVisibility);
      connect();
    },
    stop() {
      running = false;
      generation += 1;
      closeSource();
      clearPolls();
      clearRetry();
      fleetBusy = false;
      transcriptBusy = false;
      resuming = false;
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    },
    /** The person pauses the view: the stream closes and nothing is polled. */
    pause() {
      if (!running || paused) return;
      paused = true;
      suspend();
    },
    /** The person resumes: the state is refetched in full (a new stream starts with a snapshot; polling reads /api/fleet at once). */
    resume() {
      if (!running || !paused) return;
      paused = false;
      if (visibility.hidden()) return;
      onVisibility();
    },
    /** Selects another agent (or none): the stream is closed and a new one opened for it; the panel starts from the transcript's last records. */
    retarget(/** @type {string | null} */ next, /** @type {string | null} */ nextProject = project) {
      if (!running) return;
      project = nextProject;
      agent = next;
      cursor = null;
      resumed = false;
      generation += 1;
      closeSource();
      clearPolls();
      clearRetry();
      fleetBusy = false;
      transcriptBusy = false;
      ended = false;
      errors = 0;
      connect();
    },
    /** "Try again": polls at once when polling, or reopens a stream that is not open. False when there is nothing to do. */
    refreshNow() {
      if (!running) return false;
      if (polling()) {
        if (fleetBusy) return false;
        misses = 0;
        pollFleet();
        if (agent) pollTranscript();
        return true;
      }
      if (source === null && !ended) {
        errors = 0;
        openSource(false);
        return true;
      }
      return false;
    },
    /** The stale rule of 7b.6: under push the connection has been broken for 20 s; under polling 3 polls in a row missed. */
    isStale() {
      if (!running || hidden() || resuming || lastFrameAt === null) return false;
      if (polling()) return misses >= STALE_MISSES;
      return brokenSince !== null && clock.now() - brokenSince > STALE_PUSH_MS;
    },
    get running() { return running; },
    get paused() { return paused; },
    get inFlight() { return fleetBusy || transcriptBusy; },
    get misses() { return misses; },
    /** The last time the data was known to be current: now while the stream is open (the Console pushes within 5 s), else the last frame. */
    get lastSuccessAt() {
      if (mode === 'push' && source !== null && source.readyState === OPEN) return clock.now();
      return lastFrameAt;
    },
    get lastFrameAt() { return lastFrameAt; },
    get lastFailure() { return lastFailure; },
    get nextAt() { return nextAt; },
    get mode() { return mode; },
    get reason() { return reason; },
    get ended() { return ended; },
    get trial() { return trial; },
  };
}

export { FALLBACK_AFTER, FLEET_POLL_MS, TRANSCRIPT_POLL_MS, RETRY_PUSH_MS, STALE_PUSH_MS, STALE_MISSES, REOPEN_MS, GONE_CODES, CONNECTING, OPEN, CLOSED, createFleetStream };
