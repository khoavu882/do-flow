// The live client store (feature 149, IC-017; FR-016 to FR-019, DEC-016, DEC-041, DEC-042). It applies the envelopes of the
// live adapter (live.js, IC-016) per channel and shares one adapter connection among every channel the page subscribes to.
// The adapter, the clock and the visibility source are injected, so the module runs on a fake clock with a fake adapter.
// Everything is held in memory only: nothing here touches a storage API.
//
// Channels and the connection
// - One connection carries the union of subscribed channels, in the order they were first subscribed. A change of the union
//   (a new channel, the last unsubscribe of a channel, a `gone`) closes and reopens it 50 ms after the first change, so changes
//   inside those 50 ms make one reopen. The very first open waits the same 50 ms. When the union is empty at that moment the
//   adapter is closed and nothing is opened.
// - The union holds at most 8 channels (DEC-042, IC-011). A channel subscribed beyond that is kept out of the union and its
//   listeners hear `error` `too-many-channels`; it joins the union, in subscribe order, once a channel of the union leaves,
//   and its next `snapshot` tells them `state`.
// - Every open passes `since` (IC-013): `<epoch>/<ch>=<n>,...` for the channels of the union that hold an applied position of
//   the most recent epoch seen, omitting channels with no position or needing a snapshot; null when no channel qualifies. The
//   vector stays within 2048 characters by leaving out its last entries (those channels then get a snapshot).
//
// Applying frames (IC-002, IC-012)
// - `snapshot` replaces the state and sets the applied position. A `patch` applies only after a snapshot of the same epoch and
//   only with a greater `n`; else it is dropped. A patch of another epoch, or one whose pointer is malformed (0 or more than 4
//   segments, a bad `~` escape) or walks through a non-object, is dropped and marks the channel as needing a snapshot: its
//   position is left out of `since` and a reopen is scheduled as for a union change, so the server sends a snapshot.
// - Patches apply copy-on-write: every object on a changed path is copied, so a listener holding an earlier state object never
//   sees it change. `unset` applies before `set`; a missing intermediate object on a `set` path is created. Listeners must treat
//   the state they get as read-only (it is shared by the listeners of one channel).
// - `reset` drops the state and the position and tells listeners `reset` (code: the reason); patches are ignored until a
//   snapshot. `error` tells listeners `error` with its code and keeps the subscription; the state and position are dropped too,
//   so a reopen asks for a snapshot; the next `snapshot` tells them `state`. `gone` tells listeners `gone` and drops the channel:
//   its listeners are removed and it leaves the union, so it is not asked for again unless someone subscribes to it anew.
// - A subscriber to a channel that already holds a state gets one `state` call at once (an errored or out-of-union channel
//   gives its `error` instead). Frames for channels nobody subscribes to, or outside the opened list, are ignored.
//
// Hidden tab, pause and reopening (DEC-016, DEC-041)
// - While the tab is hidden or the person paused, the adapter is closed and every pending reopen is cleared, so nothing arrives
//   and nothing is applied; a stray frame is ignored too. Visible and not paused again: the store reopens at once with `since`.
// - The adapter never reopens by itself. After `refused` or `unsupported` the store reopens after 30000 ms, again and again
//   while visible and not paused; after `closed` after 5000 ms. Three `retrying` states in a row with no frame between count as
//   a refusal: the adapter is closed, the transport reads `refused` with code `retry-limit`, and the store reopens after
//   30000 ms. While such a wait runs, union changes do not open early; the reopen uses the union of that moment.
//
// `status()` is `{ transport, lastFrameAt }`: `transport` is `idle` (nothing open: nothing subscribed, or the first 50 ms),
// `hidden`, `paused`, or the latest adapter state (`connecting`, `open`, `retrying`, `refused`, `unsupported`, `closed`);
// `lastFrameAt` is the clock time of the newest frame received, null before any.
// Extension of IC-017 for the live connector (IC-018): `onTransport(listener)` returns an unsubscribe and calls
// `listener({ state, code, at })` with every adapter state, plus the store's own `idle`, `hidden`, `paused` and the
// `refused` `retry-limit` above, so the connector can choose live or polling.
//
// Log lanes (150 IC-006, IC-007, IC-014, IC-019): `worker:<runId>:out` and `:err`. Their frames carry the byte-cursor id
// `<ino>:<offset>:<n>:<ms>` (and every other channel's frames `<epoch>-<n>`; a frame with the other form is ignored), never
// change the epoch, and are `snapshot`, `append`, `reset`, `error` and `gone` (a `patch` is ignored). The store keeps no log
// text: the client log store (log-store.js) merges it. A `snapshot` tells listeners `{ kind: 'state', state: <frame data>,
// code: null, id }` and an `append`, applied in arrival order, `{ kind: 'append', state: <frame data>, code: null, id }`; an
// `append` on any other channel is still ignored. A late subscriber gets the lane's error, if any, and nothing else. The
// lane's `since` entry is `<ch>=<ino>:<to>`: `subscribe(channel, listener, { position })` may pass `position()`, read at
// every open, which gives the subscriber's held `<ino>:<to>` or null (the lane is then left out, and gets a snapshot);
// without it the position is the `<ino>:<offset>` of the lane's last `snapshot` or `append`, dropped by `reset`, `error`
// and `gone`. Log positions count whatever the epoch, so a `since` of log lanes only, before any epoch was seen, carries
// the epoch `00000000`.

/** Wait after a change of the union before the connection is closed and reopened. */
const UNION_DEBOUNCE_MS = 50;
/** Wait before reopening after `refused`, `unsupported` or three `retrying` in a row. */
const REFUSED_RETRY_MS = 30000;
/** Wait before reopening after `closed`. */
const CLOSED_RETRY_MS = 5000;
/** `retrying` states in a row without a frame that count as a refusal. */
const RETRYING_LIMIT = 3;
/** Channels per connection (DEC-042). */
const MAX_CHANNELS = 8;
/** The longest `since` vector (IC-013). */
const MAX_SINCE_CHARS = 2048;
/** Pointer segments a patch may name (IC-012). */
const MAX_POINTER_SEGMENTS = 4;

const ID_PATTERN = /^([0-9a-f]{8})-([1-9][0-9]{0,15})$/;
/** 150 IC-007: a log frame's id, `<ino>:<offset>:<n>:<ms>`. */
const LOG_ID_PATTERN = /^([0-9]{1,20}):([0-9]{1,16}):[1-9][0-9]{0,15}:[0-9]{1,16}$/;
/** 150 IC-014 `logpos`, the position a log lane resumes from. */
const LOG_POSITION = /^[0-9]{1,20}:[0-9]{1,16}$/;
/** 150 IC-006: the two worker output channels. */
const LOG_CHANNEL = /^worker:w-[0-9a-f]{12}:(?:out|err)$/;
/** The epoch of a `since` vector that holds log positions only (they count whatever the epoch, 150 IC-014). */
const NO_EPOCH = '00000000';

/** @param {unknown} name */
const isLogChannel = (name) => typeof name === 'string' && LOG_CHANNEL.test(name);

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

/** @typedef {{ kind: 'state' | 'append' | 'reset' | 'error' | 'gone', state: any, code: string | null, id?: string }} LiveEvent */
/** @typedef {(event: LiveEvent) => void} LiveListener */
/** @typedef {{ position?: () => string | null }} SubscribeOptions */
/** @typedef {{ state: string, code: string | null, at: any }} TransportEvent */
/**
 * @typedef {object} LiveAdapter
 * @property {(channels: string[], since: string | null) => void} open
 * @property {() => void} close
 * @property {(listener: (envelope: any) => void) => void} onFrame
 * @property {(listener: (event: TransportEvent) => void) => void} onState
 */
/**
 * @typedef {object} Channel
 * @property {Set<{ listener: LiveListener, position: (() => string | null) | null }>} listeners
 * @property {any} state the applied state, null before a snapshot and after `reset` or `error`
 * @property {string | null} epoch
 * @property {bigint} n the applied position
 * @property {boolean} stale a patch could not apply: patches are ignored and the position is not sent until a snapshot
 * @property {string | null} errorCode
 * @property {boolean} overflow kept out of the union by the channel limit
 * @property {boolean} log a log lane (150 IC-006)
 * @property {string | null} logPos a log lane's `<ino>:<offset>` from its last snapshot or append
 */

/** @param {any} value @returns {value is Record<string, any>} */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {object} node @param {string} key */
const own = (node, key) => Object.hasOwn(node, key);

/** Sets an own data property, also for keys such as `__proto__`. @param {object} node @param {string} key @param {any} value */
function define(node, key, value) {
  Object.defineProperty(node, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * RFC 6901 from the state root, 1 to 4 segments; `~1` decodes to `/` before `~0` decodes to `~`. Null when malformed.
 * @param {unknown} text
 * @returns {string[] | null}
 */
function decodePointer(text) {
  if (typeof text !== 'string' || !text.startsWith('/')) return null;
  const raw = text.slice(1).split('/');
  if (raw.length > MAX_POINTER_SEGMENTS) return null;
  /** @type {string[]} */
  const segments = [];
  for (const segment of raw) {
    if (/~(?![01])/.test(segment)) return null;
    segments.push(segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  return segments;
}

/**
 * IC-012 `{set, unset}` applied copy-on-write: the result shares every untouched object with `state`, which is not changed.
 * Null when the patch is malformed or a path walks through a non-object.
 * @param {Record<string, any>} state
 * @param {any} data
 * @returns {Record<string, any> | null}
 */
function applyPatch(state, data) {
  if (!isPlainObject(data)) return null;
  const set = data.set === undefined ? {} : data.set;
  const unset = data.unset === undefined ? [] : data.unset;
  if (!isPlainObject(set) || !Array.isArray(unset)) return null;
  const root = { ...state };
  /** The objects this patch made, which it may change in place. */
  const copies = new Set([root]);

  /**
   * The object holding the last segment, copied along the way; undefined when an `unset` finds the path missing, null when the
   * path walks through a non-object.
   * @param {string[]} segments @param {boolean} create
   * @returns {Record<string, any> | null | undefined}
   */
  function holder(segments, create) {
    /** @type {Record<string, any>} */
    let node = root;
    for (const key of segments.slice(0, -1)) {
      let child = own(node, key) ? node[key] : undefined;
      if (child === undefined) {
        if (!create) return undefined;
        child = {};
      } else if (!isPlainObject(child)) return null;
      else if (!copies.has(child)) child = { ...child };
      copies.add(child);
      define(node, key, child);
      node = child;
    }
    return node;
  }

  for (const text of unset) {
    const segments = decodePointer(text);
    if (segments === null) return null;
    const node = holder(segments, false);
    if (node === null) return null;
    const last = segments[segments.length - 1];
    if (node !== undefined && own(node, last)) delete node[last];
  }
  for (const [text, value] of Object.entries(set)) {
    const segments = decodePointer(text);
    if (segments === null) return null;
    const node = holder(segments, true);
    if (node == null) return null;
    define(node, segments[segments.length - 1], value);
  }
  return root;
}

/**
 * @param {object} options
 * @param {LiveAdapter} options.adapter the transport (live.js); the store is its only user
 * @param {{ now(): number, setTimeout(fn: () => void, ms: number): any, clearTimeout(handle: any): void }} [options.clock]
 * @param {{ hidden(): boolean, subscribe(listener: () => void): () => void }} [options.visibility]
 */
function createLiveStore(options) {
  const { adapter } = options;
  const clock = options.clock ?? defaultClock;
  const visibility = options.visibility ?? defaultVisibility;

  /** @type {Map<string, Channel>} in first-subscribe order */
  const channels = new Map();
  /** @type {Set<(event: TransportEvent) => void>} */
  const transportListeners = new Set();
  /** @type {string[] | null} the channels of the open connection, null while the adapter is closed */
  let opened = null;
  let paused = false;
  let down = visibility.hidden(); // closed for a hidden tab or a pause
  let transport = down ? 'hidden' : 'idle';
  /** @type {number | null} */
  let lastFrameAt = null;
  /** @type {string | null} the epoch of the newest frame */
  let latestEpoch = null;
  let retrying = 0;
  /** @type {any} */
  let unionTimer = null;
  /** @type {any} */
  let backoffTimer = null;

  /** @param {Channel} entry @param {LiveEvent} event */
  function notify(entry, event) {
    for (const token of [...entry.listeners]) if (entry.listeners.has(token)) token.listener(event);
  }

  /** @param {string} state @param {string | null} code @param {any} [at] */
  function emitTransport(state, code, at = clock.now()) {
    transport = state;
    for (const listener of [...transportListeners]) listener({ state, code, at });
  }

  /** A state of the store itself, told once per change. @param {string} state @param {string | null} [code] */
  function setTransport(state, code = null) {
    if (transport !== state) emitTransport(state, code);
  }

  /** The first 8 channels; the others are told `too-many-channels` once. */
  function union() {
    /** @type {string[]} */
    const list = [];
    for (const [name, entry] of channels) {
      if (list.length < MAX_CHANNELS) {
        list.push(name);
        entry.overflow = false;
      } else if (!entry.overflow) {
        entry.overflow = true;
        notify(entry, { kind: 'error', state: null, code: 'too-many-channels' });
      }
    }
    return list;
  }

  /** A log lane's `<ino>:<to>`: the first subscriber position that gives one, else the lane's own. @param {Channel} entry */
  function logPosition(entry) {
    for (const token of entry.listeners) {
      if (token.position === null) continue;
      const value = token.position();
      return typeof value === 'string' && LOG_POSITION.test(value) ? value : null;
    }
    return entry.logPos;
  }

  /** IC-013's vector for `list` (150 IC-014: log lanes at `<ino>:<to>`), or null. @param {string[]} list */
  function since(list) {
    /** @type {string[]} */
    const entries = [];
    let length = (latestEpoch ?? NO_EPOCH).length + 1;
    for (const name of list) {
      const entry = channels.get(name);
      if (!entry) continue;
      let text;
      if (entry.log) {
        const pos = logPosition(entry);
        if (pos === null) continue;
        text = `${name}=${pos}`;
      } else {
        if (latestEpoch === null || entry.state === null || entry.stale || entry.epoch !== latestEpoch) continue;
        text = `${name}=${entry.n}`;
      }
      const added = text.length + (entries.length > 0 ? 1 : 0);
      if (length + added > MAX_SINCE_CHARS) break;
      entries.push(text);
      length += added;
    }
    return entries.length === 0 ? null : `${latestEpoch ?? NO_EPOCH}/${entries.join(',')}`;
  }

  function clearTimers() {
    if (unionTimer !== null) clock.clearTimeout(unionTimer);
    if (backoffTimer !== null) clock.clearTimeout(backoffTimer);
    unionTimer = null;
    backoffTimer = null;
  }

  function closeAdapter() {
    if (opened === null) return;
    opened = null;
    adapter.close();
  }

  /** Closes the connection and opens one for the union of now. */
  function connect() {
    clearTimers();
    if (down) return;
    const list = union();
    closeAdapter();
    retrying = 0;
    if (list.length === 0) {
      setTransport('idle');
      return;
    }
    opened = list;
    adapter.open(list.slice(), since(list));
  }

  /** The union changed or a channel needs a snapshot: one reopen 50 ms after the first such change. */
  function scheduleReopen() {
    if (down || unionTimer !== null || backoffTimer !== null) return;
    unionTimer = clock.setTimeout(() => {
      unionTimer = null;
      connect();
    }, UNION_DEBOUNCE_MS);
  }

  /** @param {number} ms */
  function backoff(ms) {
    clearTimers();
    backoffTimer = clock.setTimeout(() => {
      backoffTimer = null;
      connect();
    }, ms);
  }

  /** Hidden or paused: closed, nothing pending; back: reopened at once. */
  function sync() {
    const away = paused || visibility.hidden();
    if (away) {
      if (!down) {
        down = true;
        clearTimers();
        closeAdapter();
        retrying = 0;
      }
      setTransport(paused ? 'paused' : 'hidden');
    } else if (down) {
      down = false;
      connect();
    }
  }

  /** 150 IC-007: a log lane's frame; `pos` is the `<ino>:<offset>` of its id. @param {Channel} entry @param {any} envelope @param {string} pos */
  function onLogFrame(entry, envelope, pos) {
    const data = envelope.data;
    const id = envelope.id;
    switch (envelope.type) {
      case 'snapshot':
      case 'append': {
        if (!isPlainObject(data)) return;
        entry.logPos = pos;
        entry.errorCode = null;
        notify(entry, { kind: envelope.type === 'snapshot' ? 'state' : 'append', state: data, code: null, id });
        return;
      }
      case 'reset': {
        Object.assign(entry, { logPos: null, errorCode: null });
        notify(entry, { kind: 'reset', state: null, code: isPlainObject(data) && typeof data.reason === 'string' ? data.reason : null });
        return;
      }
      case 'error': {
        const code = isPlainObject(data) && typeof data.code === 'string' ? data.code : 'unknown';
        Object.assign(entry, { logPos: null, errorCode: code });
        notify(entry, { kind: 'error', state: null, code });
        return;
      }
      case 'gone': {
        channels.delete(envelope.ch);
        notify(entry, { kind: 'gone', state: null, code: null });
        entry.listeners.clear();
        union();
        scheduleReopen();
        return;
      }
      default:
        // `patch` never reaches a log lane (150 IC-007).
    }
  }

  /** @param {any} envelope */
  function onFrame(envelope) {
    if (down || opened === null || !isPlainObject(envelope) || typeof envelope.ch !== 'string' || typeof envelope.id !== 'string') return;
    if (isLogChannel(envelope.ch)) {
      const logId = LOG_ID_PATTERN.exec(envelope.id);
      if (logId === null) return;
      lastFrameAt = clock.now();
      retrying = 0;
      const entry = channels.get(envelope.ch);
      if (!entry || entry.overflow || !opened.includes(envelope.ch)) return;
      onLogFrame(entry, envelope, `${logId[1]}:${logId[2]}`);
      return;
    }
    const id = ID_PATTERN.exec(envelope.id);
    if (id === null) return;
    lastFrameAt = clock.now();
    retrying = 0;
    latestEpoch = id[1];
    const entry = channels.get(envelope.ch);
    if (!entry || entry.overflow || !opened.includes(envelope.ch)) return;
    const epoch = id[1];
    const n = BigInt(id[2]);
    const data = envelope.data;
    switch (envelope.type) {
      case 'snapshot': {
        if (!isPlainObject(data) || !isPlainObject(data.state)) return;
        Object.assign(entry, { state: data.state, epoch, n, stale: false, errorCode: null });
        notify(entry, { kind: 'state', state: entry.state, code: null });
        return;
      }
      case 'patch': {
        if (entry.state === null || entry.stale) return;
        if (epoch !== entry.epoch) {
          entry.stale = true;
          scheduleReopen();
          return;
        }
        if (n <= entry.n) return;
        const next = applyPatch(entry.state, data);
        if (next === null) {
          entry.stale = true;
          scheduleReopen();
          return;
        }
        entry.state = next;
        entry.n = n;
        notify(entry, { kind: 'state', state: next, code: null });
        return;
      }
      case 'reset': {
        Object.assign(entry, { state: null, epoch: null, n: 0n, stale: false, errorCode: null });
        notify(entry, { kind: 'reset', state: null, code: isPlainObject(data) && typeof data.reason === 'string' ? data.reason : null });
        return;
      }
      case 'error': {
        const code = isPlainObject(data) && typeof data.code === 'string' ? data.code : 'unknown';
        Object.assign(entry, { state: null, epoch: null, n: 0n, stale: false, errorCode: code });
        notify(entry, { kind: 'error', state: null, code });
        return;
      }
      case 'gone': {
        channels.delete(envelope.ch);
        notify(entry, { kind: 'gone', state: null, code: null });
        entry.listeners.clear();
        union();
        scheduleReopen();
        return;
      }
      default:
        // `append` belongs to log lanes (150 IC-007, above); on any other channel there is nothing to apply.
    }
  }

  /** @param {TransportEvent} event */
  function onState(event) {
    if (down || opened === null || !event || typeof event.state !== 'string') return;
    const { state } = event;
    emitTransport(state, typeof event.code === 'string' ? event.code : null, event.at ?? clock.now());
    if (state === 'open') {
      retrying = 0;
    } else if (state === 'retrying') {
      retrying += 1;
      if (retrying >= RETRYING_LIMIT) {
        closeAdapter();
        emitTransport('refused', 'retry-limit');
        backoff(REFUSED_RETRY_MS);
      }
    } else if (state === 'refused' || state === 'unsupported') {
      opened = null;
      backoff(REFUSED_RETRY_MS);
    } else if (state === 'closed') {
      opened = null;
      backoff(CLOSED_RETRY_MS);
    }
  }

  adapter.onFrame(onFrame);
  adapter.onState(onState);
  visibility.subscribe(sync);

  return {
    /**
     * Follows `channel`; returns the unsubscribe. On a log lane `options.position` may give the subscriber's held
     * `<ino>:<to>` for `since` (150 IC-019).
     * @param {string} channel
     * @param {LiveListener} listener
     * @param {SubscribeOptions} [options]
     * @returns {() => void}
     */
    subscribe(channel, listener, options) {
      if (typeof channel !== 'string' || typeof listener !== 'function') throw new TypeError('subscribe(channel, listener)');
      const position = options && typeof options.position === 'function' ? options.position : null;
      let entry = channels.get(channel);
      const fresh = entry === undefined;
      if (entry === undefined) {
        entry = { listeners: new Set(), state: null, epoch: null, n: 0n, stale: false, errorCode: null, overflow: false, log: isLogChannel(channel), logPos: null };
        channels.set(channel, entry);
      }
      const token = { listener, position };
      entry.listeners.add(token);
      if (fresh) {
        union();
        if (!entry.overflow) scheduleReopen();
      } else if (entry.overflow) listener({ kind: 'error', state: null, code: 'too-many-channels' });
      else if (entry.errorCode !== null) listener({ kind: 'error', state: null, code: entry.errorCode });
      else if (entry.state !== null) listener({ kind: 'state', state: entry.state, code: null });
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const current = channels.get(channel);
        if (!current || !current.listeners.delete(token) || current.listeners.size > 0) return;
        channels.delete(channel);
        if (current.overflow) return;
        union();
        scheduleReopen();
      };
    },
    /** The person pauses: the adapter closes and nothing is applied until `resume`. */
    pause() {
      if (paused) return;
      paused = true;
      sync();
    },
    /** The person resumes: the store reopens at once with `since` (unless the tab is hidden). */
    resume() {
      if (!paused) return;
      paused = false;
      sync();
    },
    /** @returns {{ transport: string, lastFrameAt: number | null }} */
    status() {
      return { transport, lastFrameAt };
    },
    /**
     * Extension of IC-017 for the live connector: every transport state as `{ state, code, at }`. Returns the unsubscribe.
     * @param {(event: TransportEvent) => void} listener
     * @returns {() => void}
     */
    onTransport(listener) {
      transportListeners.add(listener);
      return () => {
        transportListeners.delete(listener);
      };
    },
  };
}

export { UNION_DEBOUNCE_MS, REFUSED_RETRY_MS, CLOSED_RETRY_MS, RETRYING_LIMIT, MAX_CHANNELS, MAX_SINCE_CHARS, MAX_POINTER_SEGMENTS, applyPatch, createLiveStore };
