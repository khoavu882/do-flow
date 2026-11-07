'use strict';

// Feature 149 A.4 (IC-006): change detection for `doflow events --follow`.
//
// The detector decides WHEN a followed channel is recomputed and which record event it gets. It
// knows nothing about section producers or envelopes: a caller registers each channel with its
// declared sources (IC-004) and receives decisions through two callbacks, `onRecompute` and
// `onRecordEvent`. The clock, the file system and `fs.watch` are injected so tests are
// deterministic.
//
// - Watch hint: one non-recursive watch per followed directory, never on a file (a watch follows an
//   inode, and a record replaced by rename would stop reporting). Any event, a null file name
//   included, marks every channel that declared the directory. A watcher error closes it; the 30 s
//   pass attaches it again.
// - Debounce: a marked channel is recomputed 25 ms after its first mark, so a temp write and its
//   rename produce one recompute.
// - Passes, one 1 s ticker: every tick fingerprints every followed source and probes every primary
//   record; every 5th tick also recomputes the derived sections; every 30th recomputes everything
//   and re-attaches missing watchers. A tick that finds the previous pass still running is skipped;
//   a 5 s or 30 s pass it skipped runs at the next tick that does run.
// - Record rules (task-state stores: `version` 1, `revision` +1 per write, temp-file rename,
//   `src/runtime/task-state.ts:501-539`; worker runs: `seq` +1 per transition,
//   `src/runtime/worker/run-store.ts:160`) are applied before every recompute of a channel that
//   has a primary record, and its `seq` and `revision` are probed by every 1 s pass.
//
// Read-only: files are read with flag 'r'; this module creates, writes, renames and deletes nothing.

const fs = require('node:fs');
const path = require('node:path');

/** Delay from a channel's first mark to its recompute. */
const DEBOUNCE_MS = 25;
/** Period of the fingerprint pass; the derived and full passes run on multiples of it. */
const PASS_MS = 1000;
/** Every how many 1 s ticks the derived pass is due (5 s). */
const DERIVED_TICKS = 5;
/** Every how many 1 s ticks the full pass is due (30 s). */
const FULL_TICKS = 30;
/** Wait before the one re-read of a primary record that failed to parse. */
const RETRY_MS = 50;
/** How long a primary record seen before must be missing before the channel is `gone`. */
const GONE_MS = 2000;
/** The only record schema version the verbs read (`SCHEMA_VERSION`, `src/runtime/task-state.ts`). */
const RECORD_VERSION = 1;

type RecordEvent = 'store-unreadable' | 'unsupported-version' | 'replaced' | 'gone';

/** A followed directory; `match` selects the entry names its fingerprint covers (all when absent). */
interface DirectorySource { path: string; match?: RegExp }

/**
 * A channel's primary record (IC-004): the file whose `version` and `revision` are checked, and
 * `pick`, which returns the record inside the parsed file (the run entry of a worker-runs file);
 * `undefined` or `null` from `pick` means the record is missing. Without `pick` the file is the
 * record. The record's `seq`, when an integer, is tracked.
 */
interface PrimaryRecord { path: string; pick?: (doc: any) => any }

/** What a channel declares (IC-004): directories (watched and fingerprinted), files (fingerprinted),
 * the names of its derived sections, and its primary record, if it has one. */
interface ChannelSources {
  directories?: ReadonlyArray<string | DirectorySource>;
  files?: readonly string[];
  derived?: readonly string[];
  primary?: PrimaryRecord | null;
}

/**
 * A recompute decision. `scope: 'all'` asks for every section of the channel; `snapshot: true`
 * asks for the result as a `snapshot` (first read, recovery from an error frame, or after a
 * `reset replaced`) rather than a diff. `scope: 'derived'` asks for the named derived sections only.
 */
type RecomputeRequest =
  | { scope: 'all'; snapshot: boolean }
  | { scope: 'derived'; sections: readonly string[]; snapshot: false };

interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): any;
  clearTimeout(handle: any): void;
  setInterval(fn: () => void, ms: number): any;
  clearInterval(handle: any): void;
}

interface WatchHandle { close(): void; on(event: 'error', listener: (error: any) => void): any }
type WatchFn = (dir: string, options: { persistent: boolean; recursive: false }, listener: (eventType: string, filename: string | null) => void) => WatchHandle;

interface DetectorOptions {
  onRecompute: (channel: string, request: RecomputeRequest) => void | Promise<void>;
  onRecordEvent: (channel: string, event: RecordEvent) => void | Promise<void>;
  onFault?: (error: any) => void;
  clock?: Clock;
  fsImpl?: any;
  watch?: WatchFn;
}

interface Detector {
  follow(channel: string, sources: ChannelSources): Promise<void>;
  unfollow(channel: string): void;
  followed(): string[];
  close(): void;
}

type Probe =
  | { status: 'missing' | 'unparsable' | 'unsupported' }
  | { status: 'ok'; revision: number | null; seq: number | null };

interface Normalized {
  directories: DirectorySource[];
  files: string[];
  derived: string[];
  primary: PrimaryRecord | null;
}

interface ChannelState {
  id: string;
  sources: Normalized;
  keys: string[];
  consumed: Map<string, string>;
  debounce: any;
  busy: Promise<void> | null;
  queued: RecomputeRequest | null;
  status: 'ok' | 'unreadable' | 'unsupported';
  seen: boolean;
  lastRevision: number | null;
  probeKey: string | undefined;
  missingSince: number | null;
}

interface SourceEntry { kind: 'dir' | 'file'; path: string; match: RegExp | null; channels: Set<string> }
interface WatchEntry { channels: Set<string>; handle: WatchHandle | null }

const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
};

const SYSTEM_WATCH: WatchFn = (dir, options, listener) => fs.watch(dir, options, listener);

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** Validates a registration and returns it with defaults, de-duplicated, and stateless regexps. */
function normalize(sources: ChannelSources): Normalized {
  if (!sources || typeof sources !== 'object') throw new TypeError('channel sources must be an object');
  const directories: DirectorySource[] = [];
  const seenDirs = new Set<string>();
  for (const entry of sources.directories ?? []) {
    const dir: DirectorySource = typeof entry === 'string' ? { path: entry } : entry;
    if (!dir || !nonEmptyString(dir.path)) throw new TypeError('a declared directory needs a non-empty path');
    if (dir.match !== undefined && !(dir.match instanceof RegExp)) throw new TypeError(`the match of '${dir.path}' must be a RegExp`);
    // `g` and `y` make RegExp#test stateful; the fingerprint must not depend on the previous call.
    const match = dir.match ? new RegExp(dir.match.source, dir.match.flags.replace(/[gy]/g, '')) : undefined;
    const key = dirKey(dir.path, match ?? null);
    if (seenDirs.has(key)) continue;
    seenDirs.add(key);
    directories.push(match ? { path: dir.path, match } : { path: dir.path });
  }
  const files = [...new Set(sources.files ?? [])];
  if (files.some((file) => !nonEmptyString(file))) throw new TypeError('a declared file needs a non-empty path');
  const derived = [...new Set(sources.derived ?? [])];
  if (derived.some((name) => !nonEmptyString(name))) throw new TypeError('a derived section needs a non-empty name');
  const primary = sources.primary ?? null;
  if (primary !== null) {
    if (typeof primary !== 'object' || !nonEmptyString(primary.path)) throw new TypeError('a primary record needs a non-empty path');
    if (primary.pick !== undefined && typeof primary.pick !== 'function') throw new TypeError('a primary record pick must be a function');
  }
  return { directories, files, derived, primary };
}

function dirKey(dirPath: string, match: RegExp | null): string {
  return `d\0${dirPath}\0${match ? `${match.source}/${match.flags}` : ''}`;
}

function fileKey(filePath: string): string {
  return `f\0${filePath}`;
}

function probeKeyOf(probe: Probe): string {
  return probe.status === 'ok' ? `ok:${probe.revision}:${probe.seq}` : probe.status;
}

/**
 * Creates a change detector (IC-006) and starts its 1 s ticker.
 *
 * @param options.onRecompute called when a channel must be recomputed; a returned promise is
 *   awaited, so a recompute is part of the pass that asked for it, and one channel never has two
 *   recomputes in flight (a request made meanwhile runs after it).
 * @param options.onRecordEvent called with `store-unreadable`, `unsupported-version`, `replaced`
 *   (followed by a `snapshot: true` recompute) or `gone` (after which the channel is no longer
 *   followed). Each error event is sent once per spell; a new `follow` of the channel re-arms it.
 * @param options.onFault receives an error thrown or rejected by a callback; without it the error
 *   is rethrown outside the detector as an uncaught exception.
 * @param options.clock timers and `now` (default: the system clock).
 * @param options.fsImpl `statSync`, `readdirSync` and `readFileSync` (default: `node:fs`).
 * @param options.watch `fs.watch`-compatible function (default: `fs.watch`).
 * @returns {Detector} `follow`, `unfollow`, `followed` and `close`.
 */
function createDetector(options: DetectorOptions): Detector {
  if (!options || typeof options.onRecompute !== 'function' || typeof options.onRecordEvent !== 'function') {
    throw new TypeError('createDetector needs onRecompute and onRecordEvent functions');
  }
  const clock: Clock = options.clock ?? SYSTEM_CLOCK;
  const fsImpl = options.fsImpl ?? fs;
  const watchImpl: WatchFn = options.watch ?? SYSTEM_WATCH;
  const fault = (error: any): void => {
    if (options.onFault) options.onFault(error);
    else process.nextTick(() => { throw error; });
  };

  const channels = new Map<string, ChannelState>();
  const sources = new Map<string, SourceEntry>();
  const watchers = new Map<string, WatchEntry>();
  const sleeps = new Set<any>();
  let closed = false;
  let running = false;
  let tick = 0;
  let derivedDue = false;
  let fullDue = false;

  const live = (state: ChannelState): boolean => !closed && channels.get(state.id) === state;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const handle = clock.setTimeout(() => { sleeps.delete(handle); resolve(); }, ms);
      sleeps.add(handle);
    });
  }

  function statKey(filePath: string): string {
    try {
      const stat = fsImpl.statSync(filePath);
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return 'absent';
    }
  }

  /** Directory: the sorted matching names with `ino`, `size`, `mtimeMs`; file: those three or absent. */
  function fingerprint(entry: SourceEntry): string {
    if (entry.kind === 'file') return statKey(entry.path);
    let names: string[];
    try {
      names = fsImpl.readdirSync(entry.path).map(String);
    } catch {
      return 'absent';
    }
    const matched = names.filter((name) => !entry.match || entry.match.test(name)).sort();
    return JSON.stringify(matched.map((name) => [name, statKey(path.join(entry.path, name))]));
  }

  function probe(primary: PrimaryRecord): Probe {
    let text: string;
    try {
      text = fsImpl.readFileSync(primary.path, { encoding: 'utf8', flag: 'r' });
    } catch (error: any) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { status: 'missing' };
      return { status: 'unparsable' };
    }
    let doc: any;
    try {
      doc = JSON.parse(text);
    } catch {
      return { status: 'unparsable' };
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { status: 'unparsable' };
    // The same test as readTaskState (src/runtime/task-state.ts:453): present and not 1 is refused.
    if (doc.version !== undefined && doc.version !== RECORD_VERSION) return { status: 'unsupported' };
    let record: any;
    try {
      record = primary.pick ? primary.pick(doc) : doc;
    } catch {
      return { status: 'unparsable' };
    }
    if (record === undefined || record === null) return { status: 'missing' };
    return {
      status: 'ok',
      revision: Number.isInteger(doc.revision) ? doc.revision : null,
      seq: typeof record === 'object' && Number.isInteger(record.seq) ? record.seq : null,
    };
  }

  /** Takes in what the channel's sources look like now, so the 1 s pass marks only later changes. */
  function consume(state: ChannelState): void {
    for (const key of state.keys) {
      const entry = sources.get(key);
      if (entry) state.consumed.set(key, fingerprint(entry));
    }
  }

  function attach(dir: string, entry: WatchEntry): void {
    let handle: WatchHandle;
    try {
      handle = watchImpl(dir, { persistent: true, recursive: false }, () => {
        if (closed || watchers.get(dir) !== entry || entry.handle !== handle) return;
        for (const id of entry.channels) {
          const state = channels.get(id);
          if (state) mark(state);
        }
      });
    } catch {
      entry.handle = null; // ENOENT, EMFILE, an unsupported file system: the 30 s pass tries again
      return;
    }
    entry.handle = handle;
    handle.on('error', () => {
      try { handle.close(); } catch { /* already closed */ }
      if (entry.handle === handle) entry.handle = null;
    });
  }

  function register(state: ChannelState): void {
    const add = (key: string, make: () => SourceEntry): void => {
      let entry = sources.get(key);
      if (!entry) { entry = make(); sources.set(key, entry); }
      entry.channels.add(state.id);
      state.keys.push(key);
    };
    for (const dir of state.sources.directories) {
      add(dirKey(dir.path, dir.match ?? null), () => ({ kind: 'dir', path: dir.path, match: dir.match ?? null, channels: new Set() }));
      let watch = watchers.get(dir.path);
      if (!watch) {
        watch = { channels: new Set(), handle: null };
        watchers.set(dir.path, watch);
        attach(dir.path, watch);
      }
      watch.channels.add(state.id);
    }
    for (const file of state.sources.files) {
      add(fileKey(file), () => ({ kind: 'file', path: file, match: null, channels: new Set() }));
    }
    consume(state);
  }

  function unregister(state: ChannelState): void {
    if (state.debounce !== null) { clock.clearTimeout(state.debounce); state.debounce = null; }
    for (const key of state.keys) {
      const entry = sources.get(key);
      if (!entry) continue;
      entry.channels.delete(state.id);
      if (entry.channels.size === 0) sources.delete(key);
    }
    for (const dir of state.sources.directories) {
      const watch = watchers.get(dir.path);
      if (!watch) continue;
      watch.channels.delete(state.id);
      if (watch.channels.size === 0) {
        watchers.delete(dir.path);
        if (watch.handle) { try { watch.handle.close(); } catch { /* already closed */ } }
      }
    }
  }

  function mark(state: ChannelState): void {
    if (!live(state) || state.debounce !== null) return;
    state.debounce = clock.setTimeout(() => {
      state.debounce = null;
      void evaluate(state, { scope: 'all', snapshot: false });
    }, DEBOUNCE_MS);
  }

  async function emitRecord(state: ChannelState, event: RecordEvent): Promise<void> {
    if (live(state)) await options.onRecordEvent(state.id, event);
  }

  /**
   * Applies the record rules before a recompute. Returns null when nothing may be recomputed (an
   * error frame was sent, or a record seen before is missing), else whether to answer a snapshot.
   */
  async function checkRecord(state: ChannelState, primary: PrimaryRecord): Promise<{ snapshot: boolean } | null> {
    let result = probe(primary);
    if (result.status === 'unparsable') {
      await sleep(RETRY_MS);
      if (!live(state)) return null;
      result = probe(primary);
    }
    state.probeKey = probeKeyOf(result);
    if (result.status === 'unparsable' || result.status === 'unsupported') {
      const status = result.status === 'unparsable' ? 'unreadable' : 'unsupported';
      if (state.status !== status) {
        state.status = status;
        await emitRecord(state, status === 'unreadable' ? 'store-unreadable' : 'unsupported-version');
      }
      return null;
    }
    if (result.status === 'missing') {
      if (state.seen) {
        if (state.missingSince === null) state.missingSince = clock.now();
        return null;
      }
      // Never seen: the sections are what the verbs answer; the channel waits for the record.
      const recovering = state.status !== 'ok';
      state.status = 'ok';
      return { snapshot: recovering };
    }
    if (result.status !== 'ok') return null;
    const replaced = state.seen && state.lastRevision !== null && result.revision !== null && result.revision < state.lastRevision;
    const recovering = state.status !== 'ok';
    state.status = 'ok';
    state.seen = true;
    state.missingSince = null;
    state.lastRevision = result.revision;
    if (replaced) await emitRecord(state, 'replaced');
    return { snapshot: replaced || recovering };
  }

  async function recomputeOnce(state: ChannelState, request: RecomputeRequest): Promise<void> {
    if (!live(state)) return;
    if (request.scope === 'all') consume(state);
    let snapshot = request.snapshot;
    const { primary } = state.sources;
    if (primary) {
      const verdict = await checkRecord(state, primary);
      if (verdict === null || !live(state)) return;
      snapshot = snapshot || verdict.snapshot;
    }
    const decided: RecomputeRequest = snapshot || request.scope === 'all'
      ? { scope: 'all', snapshot }
      : request;
    if (decided.scope === 'all' && request.scope !== 'all') consume(state);
    await options.onRecompute(state.id, decided);
  }

  function merge(queued: RecomputeRequest | null, next: RecomputeRequest): RecomputeRequest {
    if (!queued) return next;
    if (queued.scope === 'derived' && next.scope === 'derived') return next;
    return { scope: 'all', snapshot: queued.snapshot || next.snapshot };
  }

  /** Runs one recompute of a channel, or queues it behind the one in flight. Never rejects. */
  function evaluate(state: ChannelState, request: RecomputeRequest): Promise<void> {
    if (state.busy) {
      state.queued = merge(state.queued, request);
      return state.busy;
    }
    state.busy = (async () => {
      await null; // the assignment above happens before the body's `finally` can clear it
      try {
        let next: RecomputeRequest | null = request;
        while (next && live(state)) {
          try {
            await recomputeOnce(state, next);
          } catch (error) {
            fault(error);
          }
          next = state.queued;
          state.queued = null;
        }
      } finally {
        state.busy = null;
        state.queued = null;
      }
    })();
    return state.busy;
  }

  async function goneOf(state: ChannelState): Promise<void> {
    if (!live(state)) return;
    unregister(state);
    channels.delete(state.id);
    await options.onRecordEvent(state.id, 'gone');
  }

  async function pass(full: boolean, derived: boolean): Promise<void> {
    if (full) {
      for (const [dir, entry] of watchers) if (entry.handle === null) attach(dir, entry);
    }
    const current = new Map<string, string>();
    for (const [key, entry] of sources) current.set(key, fingerprint(entry));
    const dirty: ChannelState[] = [];
    const gone: ChannelState[] = [];
    for (const state of channels.values()) {
      let changed = state.keys.some((key) => current.has(key) && current.get(key) !== state.consumed.get(key));
      const { primary } = state.sources;
      if (primary) {
        const result = probe(primary);
        if (result.status === 'missing' && state.seen) {
          if (state.missingSince === null) state.missingSince = clock.now();
          if (clock.now() - state.missingSince >= GONE_MS) { gone.push(state); continue; }
        } else if (result.status !== 'missing') {
          state.missingSince = null;
        }
        const key = probeKeyOf(result);
        if (state.probeKey !== undefined && key !== state.probeKey) changed = true; // a `seq` or `revision` change
        state.probeKey = key;
      }
      if (changed) dirty.push(state);
    }
    for (const state of gone) await goneOf(state);
    if (full) {
      for (const state of [...channels.values()]) {
        if (state.debounce !== null) { clock.clearTimeout(state.debounce); state.debounce = null; }
        await evaluate(state, { scope: 'all', snapshot: false });
      }
      return;
    }
    for (const state of dirty) mark(state);
    if (derived) {
      for (const state of [...channels.values()]) {
        if (state.sources.derived.length > 0) await evaluate(state, { scope: 'derived', sections: state.sources.derived, snapshot: false });
      }
    }
  }

  function onTick(): void {
    if (closed) return;
    tick += 1;
    if (tick % DERIVED_TICKS === 0) derivedDue = true;
    if (tick % FULL_TICKS === 0) fullDue = true;
    if (running) return; // passes never overlap: this tick is skipped
    running = true;
    const full = fullDue;
    const derived = derivedDue && !full;
    fullDue = false;
    derivedDue = false;
    (async () => {
      await null;
      try {
        await pass(full, derived);
      } catch (error) {
        fault(error);
      } finally {
        running = false;
      }
    })();
  }

  const ticker = clock.setInterval(onTick, PASS_MS);

  return {
    /**
     * Follows a channel, or follows it again with new sources (a repeated `sub`), and recomputes it
     * at once as a snapshot, under the record rules. Resolves when that first decision is made.
     */
    follow(channel: string, declared: ChannelSources): Promise<void> {
      if (closed) throw new Error('the detector is closed');
      if (!nonEmptyString(channel)) throw new TypeError('a channel id must be a non-empty string');
      const normalized = normalize(declared);
      const prior = channels.get(channel);
      if (prior) unregister(prior);
      const samePrimary = !!prior && prior.sources.primary?.path === normalized.primary?.path;
      const state: ChannelState = {
        id: channel,
        sources: normalized,
        keys: [],
        consumed: new Map(),
        debounce: null,
        busy: null,
        queued: null,
        status: 'ok',
        seen: samePrimary ? prior!.seen : false,
        lastRevision: samePrimary ? prior!.lastRevision : null,
        probeKey: undefined,
        missingSince: null,
      };
      channels.set(channel, state);
      register(state);
      return evaluate(state, { scope: 'all', snapshot: true });
    },
    /** Stops following a channel; its sources are dropped when no other channel declares them. */
    unfollow(channel: string): void {
      const state = channels.get(channel);
      if (!state) return;
      unregister(state);
      channels.delete(channel);
    },
    /** The ids of the channels followed now, in follow order. */
    followed(): string[] {
      return [...channels.keys()];
    },
    /** Closes every watcher and timer; no callback runs after it returns. */
    close(): void {
      if (closed) return;
      closed = true;
      clock.clearInterval(ticker);
      for (const handle of sleeps) clock.clearTimeout(handle);
      sleeps.clear();
      for (const state of channels.values()) {
        if (state.debounce !== null) { clock.clearTimeout(state.debounce); state.debounce = null; }
      }
      for (const entry of watchers.values()) {
        if (entry.handle) { try { entry.handle.close(); } catch { /* already closed */ } }
        entry.handle = null;
      }
      channels.clear();
      sources.clear();
      watchers.clear();
    },
  };
}

module.exports = {
  createDetector,
  DEBOUNCE_MS,
  PASS_MS,
  DERIVED_TICKS,
  FULL_TICKS,
  RETRY_MS,
  GONE_MS,
};
