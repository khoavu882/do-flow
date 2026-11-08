// The live transport adapter (feature 149, IC-016; FR-016). The only web module that opens the live stream `/api/live`;
// the Fleet keeps its own source in stream.js (DEC-005). `open(channels, since)` opens one EventSource on the relative URL,
// every unnamed `message` is parsed and checked against the envelope grammar (IC-002, IC-003, IC-012) and a failing one is
// dropped (DEC-028: frames are never named events). The one named event is the server's `keepalive`, which carries no frame.
// The SSE `id:` vector is the browser's business (IC-013); the store reads the envelope's own `id`. Connection states go to
// the state listeners as `{ state, code, at }`. Every error while the browser reconnects is one `retrying`; an error after the
// browser gave up probes the URL once to tell the stream limit (429) and an old core (503, DEC-013) from a refusal of the
// session (401, 403) and from anything else (`closed`). A source that hears nothing (no open, message or keepalive) for
// SILENT_MS, as when the server is frozen with the socket still open, is closed and reported `closed` with code `silent` and
// `at` the last time it heard something; no probe is made. After `closed`, `refused` or `unsupported` nothing is reopened
// here: the store decides (IC-017, DEC-041). The constructor, the probe and the clock are injected, like createFleetStream.
// Nothing here keeps a frame or touches a storage API.

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

const LIVE_PATH = '/api/live';

/** IC-016: the transport state words. */
const LIVE_STATES = Object.freeze(['connecting', 'open', 'retrying', 'refused', 'unsupported', 'closed']);
/** IC-012: the frame types the browser receives. IC-002's reserved `append` is never sent in this feature and is dropped. */
const FRAME_TYPES = Object.freeze(['snapshot', 'patch', 'reset', 'error', 'gone']);
/** The code of `unsupported` when the page has no EventSource constructor. */
const NO_EVENTSOURCE = 'no-eventsource';
/** A source that hears no open, message or keepalive for this long is closed (`closed` `silent`); the server's keepalive is 15 s. */
const SILENT_MS = 30000;

/** IC-003: the core's ID_PATTERN with the dot of the Console's PARAM_PATTERN (console/src/live.ts CHANNEL_ID). */
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,55}$/;
/** src/runtime/worker/run-store.ts RUN_ID (console/src/live.ts RUN_ID). */
const RUN_ID = /^w-[0-9a-f]{12}$/;
/** IC-002: `<epoch>-<n>`, 8 lowercase hex and a decimal from 1 (DEC-026). */
const FRAME_ID = /^[0-9a-f]{8}-[1-9][0-9]{0,15}$/;

/**
 * @typedef {{ v: 1, ch: string, id: string, type: string, at: string, data: Record<string, any> }} LiveEnvelope
 * @typedef {{ state: string, code: string | null, at: number }} LiveState
 */

/** True when `text` is a channel of IC-003. @param {unknown} text */
function isChannel(text) {
  if (typeof text !== 'string') return false;
  if (text === 'now') return true;
  const parts = text.split(':');
  if (parts[0] === 'run') return parts.length === 3 && CHANNEL_ID.test(parts[1]) && CHANNEL_ID.test(parts[2]);
  if (parts[0] === 'tasks') return parts.length === 2 && CHANNEL_ID.test(parts[1]);
  if (parts[0] === 'worker') return parts.length === 2 && RUN_ID.test(parts[1]);
  return false;
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * The envelope a message's data holds, or null when the data is not one JSON object with `v` 1, an IC-003 `ch`, an IC-002
 * `id`, an IC-012 `type`, a string `at` and an object `data`.
 * @param {unknown} text
 * @returns {LiveEnvelope | null}
 */
function parseEnvelope(text) {
  if (typeof text !== 'string') return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(value)) return null;
  if (value.v !== 1 || !isChannel(value.ch) || typeof value.id !== 'string' || !FRAME_ID.test(value.id)) return null;
  if (typeof value.type !== 'string' || !FRAME_TYPES.includes(value.type) || typeof value.at !== 'string' || !isPlainObject(value.data)) return null;
  return /** @type {LiveEnvelope} */ (value);
}

/**
 * The relative stream URL: the comma-joined channels and, when given, the IC-013 vector, each encoded.
 * @param {string[]} channels
 * @param {string | null | undefined} since
 */
function liveUrl(channels, since) {
  const query = `ch=${encodeURIComponent(channels.join(','))}${typeof since === 'string' && since !== '' ? `&since=${encodeURIComponent(since)}` : ''}`;
  return `${LIVE_PATH}?${query}`;
}

const defaultClock = { now: () => Date.now() };

/**
 * The status of the live route without keeping a stream: the request is aborted as soon as the head is in, and the JSON
 * body's `error.code` is read when the reply is not ok.
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

/**
 * The state a probe answer names after the browser gave up on the stream.
 * @param {{ status: number, code?: string | null }} answer
 * @returns {{ state: string, code: string | null }}
 */
function stateOfProbe(answer) {
  const status = answer ? answer.status : null;
  if (status === 429) return { state: 'refused', code: 'stream-limit' };
  if (status === 503) return { state: 'unsupported', code: 'live-unavailable' };
  if (status === 401 || status === 403) return { state: 'refused', code: typeof answer.code === 'string' ? answer.code : null };
  return { state: 'closed', code: null };
}

/**
 * @param {object} [options]
 * @param {any} [options.EventSource] the constructor (default: the page's)
 * @param {(url: string) => Promise<{ status: number, code: string | null }>} [options.probe]
 * @param {{ now(): number, setTimeout?(fn: () => void, ms: number): any, clearTimeout?(handle: any): void }} [options.clock]
 *   without setTimeout and clearTimeout the silence timer is the global one, unref'd where the runtime has that
 */
function createLiveAdapter(options = {}) {
  /** @type {{ now(): number, setTimeout?: (fn: () => void, ms: number) => any, clearTimeout?: (handle: any) => void }} */
  const clock = options.clock ?? defaultClock;
  const probe = options.probe ?? defaultProbe;
  const SourceCtor = 'EventSource' in options ? options.EventSource : globalThis.EventSource;
  const { setTimeout: setOwn, clearTimeout: clearOwn } = clock;
  /** @param {() => void} fn @param {number} ms */
  const later = (fn, ms) => {
    if (typeof setOwn === 'function' && typeof clearOwn === 'function') return setOwn.call(clock, fn, ms);
    const handle = /** @type {any} */ (globalThis.setTimeout(fn, ms));
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  };
  /** @param {any} handle */
  const cancel = (handle) => {
    if (typeof setOwn === 'function' && typeof clearOwn === 'function') clearOwn.call(clock, handle);
    else globalThis.clearTimeout(handle);
  };

  /** @type {Set<(envelope: LiveEnvelope) => void>} */
  const frameListeners = new Set();
  /** @type {Set<(state: LiveState) => void>} */
  const stateListeners = new Set();
  let generation = 0;
  /** @type {any} */
  let source = null;
  /** @type {any} the silence timer of the current source */
  let silentTimer = null;
  /** When the current source last heard an open, a message or a keepalive (or was created). */
  let heardAt = 0;

  /**
   * Tells the state listeners. Not de-duplicated: every `error` while the browser reconnects is one `retrying`, because the
   * store counts them (IC-016, IC-017: three in a row without a frame are a refusal).
   * @param {string} state @param {string | null} [code] @param {number} [at]
   */
  function setState(state, code = null, at = clock.now()) {
    const payload = { state, code, at };
    for (const listener of [...stateListeners]) listener(payload);
  }

  function disarm() {
    if (silentTimer !== null) cancel(silentTimer);
    silentTimer = null;
  }

  /** Closes the current source, if any, and makes every pending event, probe and timer of earlier opens stale. */
  function stop() {
    generation += 1;
    disarm();
    if (source !== null) {
      const old = source;
      source = null;
      try {
        old.close();
      } catch {
        // Already closed.
      }
    }
  }

  return {
    /**
     * Opens the stream on `channels` from `since`, closing any current one first.
     * @param {string[]} channels
     * @param {string | null} [since]
     */
    open(channels, since = null) {
      stop();
      const mine = generation;
      if (typeof SourceCtor !== 'function') {
        setState('unsupported', NO_EVENTSOURCE);
        return;
      }
      const url = liveUrl(channels, since);
      setState('connecting');
      const es = new SourceCtor(url);
      source = es;
      const current = () => mine === generation && source === es;
      // Heard: an open, a message (valid or not) or a keepalive restarts the silence timer of this source.
      const heard = () => {
        heardAt = clock.now();
        disarm();
        silentTimer = later(() => {
          silentTimer = null;
          if (!current()) return;
          // Nothing for SILENT_MS on a socket the browser still holds open: a frozen server. Closed; the store reopens.
          source = null;
          try {
            es.close();
          } catch {
            // Already closed.
          }
          setState('closed', 'silent', heardAt);
        }, SILENT_MS);
      };
      heard();
      es.addEventListener('open', () => {
        if (!current()) return;
        heard();
        setState('open');
      });
      es.addEventListener('message', (/** @type {any} */ event) => {
        if (!current()) return;
        heard();
        const envelope = parseEnvelope(event ? event.data : undefined);
        if (envelope === null) return;
        for (const listener of [...frameListeners]) listener(envelope);
      });
      es.addEventListener('keepalive', () => {
        if (current()) heard();
      });
      es.addEventListener('error', () => {
        if (!current()) return;
        if (es.readyState !== CLOSED) {
          // The browser reconnects by itself after the server's `retry:` delay, with Last-Event-ID.
          setState('retrying');
          return;
        }
        // The browser gave up: ask once why, then leave the reopening to the store.
        source = null;
        disarm();
        try {
          es.close();
        } catch {
          // Already closed.
        }
        probe(url).then(
          (answer) => {
            if (mine !== generation) return;
            const next = stateOfProbe(answer);
            setState(next.state, next.code);
          },
          () => {
            if (mine === generation) setState('closed');
          },
        );
      });
    },
    /** Closes the stream. Silent: no state is reported, and nothing of the closed stream is reported later. */
    close() {
      stop();
    },
    /** @param {(envelope: LiveEnvelope) => void} listener @returns {() => void} */
    onFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    /** @param {(state: LiveState) => void} listener @returns {() => void} */
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  };
}

export { CONNECTING, OPEN, CLOSED, LIVE_PATH, LIVE_STATES, FRAME_TYPES, NO_EVENTSOURCE, SILENT_MS, CHANNEL_ID, RUN_ID, FRAME_ID, isChannel, parseEnvelope, liveUrl, stateOfProbe, createLiveAdapter };
