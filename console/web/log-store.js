// The client log store (feature 150, IC-019; FR-009, FR-010, FR-019). One `createLogStream` per worker run stream (`out` or
// `err`) holds that stream's masked text as pieces keyed by byte offset, from the log route
// (`GET /api/worker-runs/<slug>/<runId>/log?stream=<s>[&cursor=<c> | &before=<c>]`, IC-012) and the log channel
// `worker:<runId>:<s>` of the page's one live store (store.js, 150 IC-007 and IC-014). Everything is held in memory only.
//
// - First paint: one tail GET. After a 200 the stream subscribes to its channel, giving the store its held `<ino>:<to>` for
//   `since`. A 501 (`core-lacks-verb`) stops at `not-in-core`, a 404 at `not-found`; any other failure stops at `failed` and
//   `open()` tries again. A page that says `gone` stops at `gone` without a subscription.
// - Merge, the same for a page, a `snapshot` and an `append` (a chunk): with no held text or another inode the chunk replaces
//   the held text; with the same inode, pieces below the held `to` are dropped and the rest added when the chunk's `from` is
//   at or before the held `to`. A chunk whose `from` is past the held `to` is a gap: on that event, and never on a timer, the
//   stream reads forward from the held `to` until it reaches the chunk's `from`, then merges the chunk. A gap of
//   LOG_HOLD_BYTES or more is not read (the bound would drop what it read), and a gap read that fails or ends short leaves the
//   chunk to replace the held text. Chunks that arrive while a read runs wait for it, so they merge in order.
// - Hold bound: at most LOG_HOLD_BYTES (`to - from`) per stream. While following, the oldest pieces past it are dropped. Load
//   earlier reads one page `before` the held `from` and prepends it; past the bound the newest pieces are dropped and
//   following pauses (live text is then not merged, phase and end are, and no position is given, so a reopen sends a
//   snapshot). Jump to newest replaces the held text with a tail page and follows again.
// - Polling (FR-019): while the connection is down (the store's transport `refused`, `unsupported` or `closed`) or the channel
//   is in error, the stream reads forward from the held `to` (a tail read while nothing is held) every POLL_MS, while the
//   page is visible and not paused (the store's transport is not `hidden` or `paused`), following, and the run not ended.
//   The subscription stays: an open connection (with the channel not in error) or the next frame on the channel is live
//   again, and the store's reopen carries `since` at the held `<ino>:<to>`.
//
// `onChange(listener)` calls `listener(state)` at once and after every change, and returns the unsubscribe. `state` is a new
// object each time; treat it and its pieces as read-only:
//   { log, ino, from, to, pieces, phase, end, notices, following, mode, error }
//   log       null before the first paint, then 'waiting' | 'open' | 'none' | 'gone'
//   ino       the held file's inode (decimal string), null while nothing is held
//   from, to  the bytes the held pieces cover
//   pieces    [{ at, text, cut?: true, withheld?: true }] in byte order; a `cut` piece joins the next one when shown, a
//             `withheld` one stands for a line too long to show after masking
//   phase     the run's phase, null before the first paint; end: null, or { capped: boolean | null } once the run ended
//   notices   in this order, each when it holds: 'earlier' (text before `from` exists and is not shown), 'paused' (following
//             paused), 'reset' (the file was replaced; until Jump to newest), 'withheld', 'capped' (end.capped is true),
//             'waiting', 'none', 'gone'
//   following false while Load earlier holds the stream past the bound
//   mode      'idle' | 'loading' | 'live' | 'polling' | 'not-in-core' | 'not-found' | 'failed' | 'gone' | 'closed'
//   error     the last failed read as { status, code, network }, null after a successful one

/** 150 IC-019 (proposed): the most bytes (`to - from`) one stream holds. */
const LOG_HOLD_BYTES = 1048576;
/** 150 IC-019 (proposed): the forward read interval while polling. */
const POLL_MS = 3000;

const RUN_ID = /^w-[0-9a-f]{12}$/;
const STREAMS = Object.freeze(['out', 'err']);
const LOG_STATES = Object.freeze(['waiting', 'open', 'none', 'gone']);
/** The store's transport states that end live delivery (live-view.js DOWN_STATES). */
const DOWN_STATES = Object.freeze(['refused', 'unsupported', 'closed']);
/** The store's transport states in which nothing is read: a hidden page or the person's pause. */
const AWAY_STATES = Object.freeze(['hidden', 'paused']);
/** Modes after which nothing is read again. */
const FINAL_MODES = Object.freeze(['not-in-core', 'not-found', 'gone', 'closed']);

const defaultClock = {
  now: () => Date.now(),
  setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (/** @type {any} */ handle) => globalThis.clearTimeout(handle),
};

/** @typedef {{ at: number, text: string, cut?: true, withheld?: true }} LogPiece */
/** @typedef {{ capped: boolean | null } | null} LogEnd */
/**
 * @typedef {object} Chunk
 * @property {string | null} [log] set on a page or a snapshot
 * @property {string | null} ino
 * @property {number} from
 * @property {number} to
 * @property {LogPiece[]} pieces
 * @property {string | null} phase
 * @property {LogEnd} end
 * @property {boolean} [reset] a page read as a tail because the file was replaced
 */

/** @typedef {{ status: number | null, code: string | null, network: boolean }} Failure */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @returns {value is number} */
const isCount = (value) => Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;

/** IC-001 pieces as held: `cut` and `withheld` only when true; null when malformed. @param {unknown} list */
function piecesOf(list) {
  if (!Array.isArray(list)) return null;
  /** @type {LogPiece[]} */
  const pieces = [];
  for (const item of list) {
    if (!isPlainObject(item) || !isCount(item.at) || typeof item.text !== 'string') return null;
    /** @type {LogPiece} */
    const piece = { at: item.at, text: item.text };
    if (item.cut === true) piece.cut = true;
    if (item.withheld === true) piece.withheld = true;
    pieces.push(piece);
  }
  return pieces;
}

/** @param {unknown} value @returns {LogEnd | undefined} */
function endOf(value) {
  if (value === null) return null;
  if (isPlainObject(value) && (value.capped === null || typeof value.capped === 'boolean')) return { capped: value.capped };
  return undefined;
}

/** An IC-002 page body (projected by the Console) as a chunk, or null. @param {any} body @returns {Chunk | null} */
function pageChunk(body) {
  if (!isPlainObject(body) || !LOG_STATES.includes(body.log) || !isCount(body.from) || !isCount(body.to) || body.from > body.to) return null;
  const pieces = piecesOf(body.pieces);
  if (pieces === null || !(body.ino === null || typeof body.ino === 'string') || typeof body.phase !== 'string') return null;
  const end = body.phase === 'ended' ? { capped: typeof body.capped === 'boolean' ? body.capped : null } : null;
  return { log: body.log, ino: body.log === 'open' ? body.ino : null, from: body.from, to: body.to, pieces, phase: body.phase, end, reset: body.reset === true };
}

/** A live frame's data as a chunk (`ino` from the frame id on an append), or null. @param {any} data @param {string | null} ino @param {boolean} snapshot */
function frameChunk(data, ino, snapshot) {
  if (!isPlainObject(data) || !isCount(data.from) || !isCount(data.to) || data.from > data.to) return null;
  const pieces = piecesOf(data.pieces);
  const end = endOf(data.end);
  if (pieces === null || end === undefined || !(data.phase === null || typeof data.phase === 'string')) return null;
  if (snapshot) {
    if (!['waiting', 'open', 'none'].includes(data.log) || (data.log === 'open') !== (typeof data.ino === 'string')) return null;
    return { log: data.log, ino: data.log === 'open' ? data.ino : null, from: data.from, to: data.to, pieces, phase: data.phase, end };
  }
  return { ino, from: data.from, to: data.to, pieces, phase: data.phase, end };
}

/** A failed `apiGet` as `{ status, code, network }`. @param {any} error @returns {Failure} */
function failureOf(error) {
  return {
    status: error && typeof error.status === 'number' ? error.status : null,
    code: error && typeof error.code === 'string' ? error.code : null,
    network: Boolean(error && error.network === true),
  };
}

/**
 * @param {object} options
 * @param {(path: string) => Promise<any>} options.apiGet the shell's same-origin GET (app.js): the body, or a thrown
 *   `{ status, code, network }`
 * @param {any} options.store the page's one live store (store.js)
 * @param {{ now(): number, setTimeout(fn: () => void, ms: number): any, clearTimeout(handle: any): void }} [options.clock]
 * @param {string} options.slug
 * @param {string} options.runId
 * @param {'out' | 'err'} options.stream
 */
function createLogStream(options) {
  const { apiGet, store, slug, runId, stream } = options;
  if (typeof apiGet !== 'function' || !store || typeof slug !== 'string' || slug === '' || !RUN_ID.test(runId) || !STREAMS.includes(stream)) {
    throw new TypeError('createLogStream({ apiGet, store, clock, slug, runId, stream })');
  }
  const clock = options.clock ?? defaultClock;
  const base = `/api/worker-runs/${encodeURIComponent(slug)}/${encodeURIComponent(runId)}/log?stream=${stream}`;
  const channel = `worker:${runId}:${stream}`;

  /** @type {string | null} */
  let log = null;
  /** @type {string | null} */
  let ino = null;
  let from = 0;
  let to = 0;
  /** @type {LogPiece[]} */
  let pieces = [];
  /** @type {string | null} */
  let phase = null;
  /** @type {LogEnd} */
  let end = null;
  let following = true;
  let replaced = false;
  let mode = 'idle';
  /** @type {{ status: number | null, code: string | null, network: boolean } | null} */
  let error = null;

  /** @type {Set<(state: any) => void>} */
  const listeners = new Set();
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  /** @type {(() => void) | null} */
  let unTransport = null;
  let transport = 'idle';
  let laneError = false;
  /** @type {any} */
  let pollTimer = null;
  /** Bumped by `close()`: an answer of an earlier life is dropped. */
  let life = 0;
  /** @type {Promise<void> | null} */
  let opening = null;

  /** @type {Array<() => void | Promise<void>>} the work in order: frames, gap reads, polls, earlier pages, jumps */
  const queue = [];
  let busy = false;

  function snapshotState() {
    /** @type {string[]} */
    const notices = [];
    if (ino !== null && from > 0) notices.push('earlier');
    if (!following) notices.push('paused');
    if (replaced) notices.push('reset');
    if (pieces.some((piece) => piece.withheld === true)) notices.push('withheld');
    if (end !== null && end.capped === true) notices.push('capped');
    if (log === 'waiting' || log === 'none' || log === 'gone') notices.push(log);
    return { log, ino, from, to, pieces: pieces.slice(), phase, end, notices, following, mode, error };
  }

  function emit() {
    if (mode === 'closed') return;
    const state = snapshotState();
    for (const listener of [...listeners]) if (listeners.has(listener)) listener(state);
  }

  const alive = (/** @type {number} */ mine) => mine === life && !FINAL_MODES.includes(mode);

  /** Runs queued work one item at a time; synchronous items run at once. Every item checks that its stream is still alive. */
  function pump() {
    while (!busy && queue.length > 0) {
      const task = /** @type {() => void | Promise<void>} */ (queue.shift());
      const result = task();
      if (result && typeof result.then === 'function') {
        busy = true;
        result.then(() => {}, () => {}).then(() => {
          busy = false;
          pump();
          arm();
        });
      }
    }
  }

  /** @param {() => void | Promise<void>} task */
  function enqueue(task) {
    return new Promise((resolve) => {
      queue.push(() => {
        const result = task();
        if (result && typeof result.then === 'function') return result.then(() => resolve(undefined), () => resolve(undefined));
        resolve(undefined);
        return undefined;
      });
      pump();
    });
  }

  /**
   * One page by `query` ('' for a tail read), or a failure.
   * @param {string} query
   * @returns {Promise<{ ok: true, chunk: Chunk } | { ok: false, failure: Failure }>}
   */
  async function read(query) {
    try {
      const chunk = pageChunk(await apiGet(base + query));
      return chunk === null ? { ok: false, failure: { status: null, code: 'core-contract-mismatch', network: false } } : { ok: true, chunk };
    } catch (thrown) {
      return { ok: false, failure: failureOf(thrown) };
    }
  }

  const cursor = (/** @type {string} */ kind, /** @type {number} */ offset) => `&${kind}=${encodeURIComponent(`${ino}:${offset}:0:0`)}`;

  /** The oldest pieces past the bound dropped (while following). */
  function trimFront() {
    if (to - from <= LOG_HOLD_BYTES) return;
    let k = 0;
    while (k < pieces.length && to - pieces[k].at > LOG_HOLD_BYTES) k += 1;
    pieces = pieces.slice(k);
    from = pieces.length > 0 ? pieces[0].at : to;
  }

  /** The newest pieces past the bound dropped (after Load earlier); true when any was. */
  function trimBack() {
    if (to - from <= LOG_HOLD_BYTES) return false;
    let k = pieces.length;
    while (k > 0 && (k < pieces.length ? pieces[k].at : to) - from > LOG_HOLD_BYTES) k -= 1;
    to = k < pieces.length ? pieces[k].at : to;
    pieces = pieces.slice(0, k);
    return true;
  }

  /** @param {Chunk} chunk */
  function runState(chunk) {
    phase = chunk.phase;
    end = chunk.end;
  }

  /** @param {Chunk} chunk */
  function replaceWith(chunk) {
    if (chunk.log !== undefined && chunk.log !== null) log = chunk.log;
    else log = 'open';
    ino = chunk.ino;
    from = chunk.from;
    to = chunk.to;
    pieces = chunk.pieces.slice();
    runState(chunk);
    trimFront();
  }

  /** The pieces of `chunk` at or past the held `to` added; the chunk's `from` is at or before it. @param {Chunk} chunk */
  function extend(chunk) {
    for (const piece of chunk.pieces) if (piece.at >= to) pieces.push(piece);
    to = Math.max(to, chunk.to);
    log = 'open';
    runState(chunk);
    trimFront();
  }

  /** A page of the forward kind (gap fill, polling) or a tail page merged; false when it was a reset tail. @param {Chunk} chunk */
  function mergePage(chunk) {
    if (chunk.reset === true) {
      replaced = true;
      replaceWith(chunk);
      return false;
    }
    if (chunk.log === 'gone') {
      log = 'gone';
      runState(chunk);
      stopFor('gone');
      return false;
    }
    if (chunk.log !== 'open' || ino === null || chunk.ino !== ino) replaceWith(chunk);
    else if (chunk.from <= to) extend(chunk);
    else replaceWith(chunk);
    return true;
  }

  /**
   * IC-019's merge of a live chunk, with the gap read on this event.
   * @param {Chunk} chunk
   * @param {number} mine
   * @returns {void | Promise<void>}
   */
  function mergeLive(chunk, mine) {
    if (!following) {
      runState(chunk);
      emit();
      return undefined;
    }
    if (chunk.log !== undefined && chunk.log !== 'open') {
      replaceWith(chunk);
      emit();
      return undefined;
    }
    if (ino === null || chunk.ino !== ino || chunk.from <= to) {
      if (ino === null || chunk.ino !== ino) replaceWith(chunk);
      else extend(chunk);
      emit();
      return undefined;
    }
    if (chunk.from - to >= LOG_HOLD_BYTES) {
      replaceWith(chunk);
      emit();
      return undefined;
    }
    return fillGap(chunk, mine);
  }

  /** Forward reads from the held `to` up to the chunk's `from` (at most LOG_HOLD_BYTES read), then the chunk. @param {Chunk} chunk @param {number} mine */
  async function fillGap(chunk, mine) {
    const startIno = ino;
    let readBytes = 0;
    while (to < chunk.from && readBytes < LOG_HOLD_BYTES && ino === chunk.ino && following) {
      const held = to;
      const answer = await read(cursor('cursor', held));
      if (!alive(mine)) return;
      if (!answer.ok) {
        if (stopOnFailure(answer.failure)) return;
        error = answer.failure;
        break;
      }
      error = null;
      const page = answer.chunk;
      if (!mergePage(page) || to <= held) break;
      readBytes += page.to - page.from;
    }
    // Gone, or closed (emit then says nothing).
    if (!alive(mine)) {
      emit();
      return;
    }
    // A read that found the file replaced holds a newer tail than the chunk: the chunk is dropped.
    if (ino !== startIno) runState(chunk);
    else if (!following) runState(chunk);
    else if (ino === null || chunk.ino !== ino || chunk.from > to) replaceWith(chunk);
    else extend(chunk);
    emit();
  }

  /** 501 and 404 end the stream; true when `failure` did. @param {{ status: number | null, code: string | null, network: boolean }} failure */
  function stopOnFailure(failure) {
    if (failure.status !== 501 && failure.status !== 404) return false;
    error = failure;
    stopFor(failure.status === 501 ? 'not-in-core' : 'not-found');
    emit();
    return true;
  }

  /** Nothing is read again: the subscription and the poll timer end. @param {string} final */
  function stopFor(final) {
    mode = final;
    disarm();
    if (unsubscribe) unsubscribe();
    if (unTransport) unTransport();
    unsubscribe = null;
    unTransport = null;
  }

  // ---- polling ----

  function disarm() {
    if (pollTimer !== null) clock.clearTimeout(pollTimer);
    pollTimer = null;
  }

  const shouldPoll = () => mode === 'polling' && following && end === null && !AWAY_STATES.includes(transport);

  /** The poll timer runs exactly while the stream should poll and no read is running. */
  function arm() {
    if (!shouldPoll()) {
      disarm();
      return;
    }
    if (pollTimer !== null || busy) return;
    const mine = life;
    pollTimer = clock.setTimeout(() => {
      pollTimer = null;
      if (mine !== life || !shouldPoll()) return;
      void enqueue(() => poll(mine));
    }, POLL_MS);
  }

  /** One forward read from the held `to`, or a tail read while nothing is held. @param {number} mine */
  async function poll(mine) {
    if (!shouldPoll()) return;
    const answer = await read(ino === null ? '' : cursor('cursor', to));
    if (!alive(mine)) return;
    if (!answer.ok) {
      if (stopOnFailure(answer.failure)) return;
      error = answer.failure;
      emit();
      return;
    }
    error = null;
    if (following) mergePage(answer.chunk);
    else runState(answer.chunk);
    emit();
  }

  function enterPolling() {
    if (FINAL_MODES.includes(mode) || mode === 'polling') return;
    mode = 'polling';
    emit();
  }

  function goLive() {
    if (mode !== 'polling') return;
    mode = 'live';
    disarm();
    emit();
  }

  // ---- the channel ----

  /** @param {{ kind: string, state: any, code: string | null, id?: string }} event */
  function onLive(event) {
    const mine = life;
    if (!alive(mine) || !event) return;
    if (event.kind === 'state' || event.kind === 'append') {
      const idIno = typeof event.id === 'string' ? event.id.slice(0, event.id.indexOf(':')) : null;
      const chunk = frameChunk(event.state, idIno, event.kind === 'state');
      if (chunk === null) return;
      laneError = false;
      goLive();
      void enqueue(() => (alive(mine) ? mergeLive(chunk, mine) : undefined));
    } else if (event.kind === 'reset') {
      void enqueue(() => {
        if (!alive(mine)) return;
        ino = null;
        from = 0;
        to = 0;
        pieces = [];
        following = true;
        replaced = true;
        emit();
      });
    } else if (event.kind === 'error') {
      laneError = true;
      enterPolling();
      arm();
    } else if (event.kind === 'gone') {
      void enqueue(() => {
        if (!alive(mine)) return;
        log = 'gone';
        stopFor('gone');
        emit();
      });
    }
  }

  /** @param {{ state: string, code: string | null }} event */
  function onTransport(event) {
    if (!event || typeof event.state !== 'string' || FINAL_MODES.includes(mode)) return;
    transport = event.state;
    if (DOWN_STATES.includes(event.state)) enterPolling();
    else if (event.state === 'open' && !laneError) goLive();
    arm();
  }

  /** The position the store's `since` gives this lane: the held `<ino>:<to>` while following. */
  const position = () => (following && ino !== null && log === 'open' ? `${ino}:${to}` : null);

  function subscribe() {
    transport = store.status().transport;
    unTransport = store.onTransport(onTransport);
    unsubscribe = store.subscribe(channel, onLive, { position });
    mode = DOWN_STATES.includes(transport) ? 'polling' : 'live';
  }

  /** The first paint. @param {number} mine */
  async function firstPaint(mine) {
    mode = 'loading';
    error = null;
    emit();
    const answer = await read('');
    if (mine !== life) return;
    if (!answer.ok) {
      if (stopOnFailure(answer.failure)) return;
      error = answer.failure;
      mode = 'failed';
      emit();
      return;
    }
    replaceWith(answer.chunk);
    if (answer.chunk.log === 'gone') {
      stopFor('gone');
      emit();
      return;
    }
    subscribe();
    emit();
    arm();
  }

  return {
    /** Paints the newest page and follows the channel; again after `failed`. Resolves when the first paint is done. */
    open() {
      if (opening !== null) return opening;
      if (mode !== 'idle' && mode !== 'failed') return Promise.resolve();
      const mine = life;
      opening = firstPaint(mine).finally(() => {
        if (mine === life) opening = null;
      });
      return opening;
    },
    /** Ends the subscription and every timer; nothing is reported after it. */
    close() {
      if (mode === 'closed') return;
      life += 1;
      stopFor('closed');
      opening = null;
      listeners.clear();
    },
    /** One page before the held text, prepended; past the bound following pauses. Resolves when done. */
    loadEarlier() {
      const mine = life;
      return enqueue(async () => {
        if (!alive(mine) || ino === null || from === 0 || log !== 'open') return;
        const held = from;
        const answer = await read(cursor('before', held));
        if (!alive(mine)) return;
        if (!answer.ok) {
          if (stopOnFailure(answer.failure)) return;
          error = answer.failure;
          emit();
          return;
        }
        error = null;
        const page = answer.chunk;
        if (page.reset === true || page.log !== 'open' || page.ino !== ino) {
          following = true;
          mergePage({ ...page, reset: page.reset === true || page.ino !== ino });
          emit();
          return;
        }
        pieces = [...page.pieces.filter((piece) => piece.at < held), ...pieces];
        from = Math.min(from, page.from);
        runState(page);
        if (trimBack()) following = false;
        emit();
      });
    },
    /** Replaces the held text with a tail page and follows again. Resolves when done. */
    jumpToNewest() {
      const mine = life;
      return enqueue(async () => {
        if (!alive(mine) || (mode !== 'live' && mode !== 'polling')) return;
        const answer = await read('');
        if (!alive(mine)) return;
        if (!answer.ok) {
          if (stopOnFailure(answer.failure)) return;
          error = answer.failure;
          emit();
          return;
        }
        error = null;
        following = true;
        replaced = false;
        if (answer.chunk.log === 'gone') mergePage(answer.chunk);
        else replaceWith(answer.chunk);
        emit();
      });
    },
    /** Calls `listener(state)` now and after every change; returns the unsubscribe. @param {(state: any) => void} listener */
    onChange(listener) {
      if (typeof listener !== 'function') throw new TypeError('onChange(listener)');
      listeners.add(listener);
      if (mode !== 'closed') listener(snapshotState());
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export { LOG_HOLD_BYTES, POLL_MS, createLogStream };
