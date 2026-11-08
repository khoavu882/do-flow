'use strict';

// Feature 150 A.6 (IC-007, IC-008; FR-010, FR-011, FR-012, NFR-001, NFR-008): the log channels
// `worker:<runId>:out` and `worker:<runId>:err` of `doflow events --follow`.
//
// One LogSubscription per log channel. It declares its sources to the detector (the
// `worker-output` directory narrowed to its one file, the `worker-runs` directory and the run's
// primary record as `worker:<runId>` declares them, and the file as a `tail` for the 250 ms log
// pass) and, on every recompute the detector asks for, decides the channel's next frames in the
// IC-008 order:
//
//   1. absent, never seen, run not ended: nothing (the snapshot said `waiting`)
//   2. absent, run ended: `gone` with a pointer or a file seen here, else a `none` snapshot once
//   3. seen here and absent while the run is not ended: `gone` once absent for GONE_MS
//   4. present after a `waiting` or `none` snapshot: an `open` snapshot of the newest page
//   5. another inode, or a size below the cursor: `reset` `replaced`, then a snapshot
//   6. bytes past the cursor: `forward` reads, at most CATCHUP_FRAMES appends, then a re-mark
//   7. a change of `phase` or `end` with no new bytes: one append with no pieces
//
// Every read goes through `readLogPage` (IC-001) on the path `logFile` forms, so only
// `<runId>.out.log` and `<runId>.err.log` can be opened and never `<runId>.last.log` (FR-012).
// `final` is IC-001's rule: the run has ended and its record holds the stream's output pointer.
// The record rules of 149 (version, torn store, replaced, record gone) stay the detector's.
// Read-only: no file is created, written, renamed or deleted, and no process is started after the
// lifecycle root is resolved once, when the subscription is made.

const fs = require('node:fs');
const path = require('node:path');
const { logFile, readLogPage } = require('../worker/log-read.ts');
const { readRuns, PHASES } = require('../worker/run-store.ts');
const { projectRoot: lifecycleProjectRoot } = require('../lifecycle/root.ts');
const { findWorkerRun, workerSources } = require('./sections.ts');
const { GONE_MS } = require('./detector.ts');

/** IC-008: the most `append` calls one recompute makes before it marks the channel again. */
const CATCHUP_FRAMES = 2;

type Stream = 'out' | 'err';
type LogChannel = { kind: 'log'; name: string; runId: string; stream: Stream };
type LogEnd = { capped: boolean | null } | null;
type RunState = { phase: string | null; end: LogEnd };
type Page = {
  file: 'present' | 'absent'; ino: string | null; size: number; from: number; to: number;
  pieces: Array<{ at: number; text: string; cut?: true }>; eof: boolean; reset: boolean;
};

/**
 * What one recompute decided: the lines to print, whether the channel is `gone` (the caller stops
 * following it), and `again`, the delay in milliseconds after which the caller must mark the
 * channel once more (0: after the debounce), or null.
 */
interface LogStep { lines: string[]; gone?: true; again?: number | null }

interface LogWriter {
  logSnapshot(ch: string, data: any): string[];
  append(ch: string, data: any): string[];
  reset(ch: string, reason: string): string[];
  error(ch: string, code: string): string[];
  gone(ch: string): string[];
  needsSnapshot(ch: string): boolean;
}

interface LogSubscriptionOptions {
  channel: LogChannel;
  ctx: { cwd: string; env?: Record<string, string | undefined> };
  writer: LogWriter;
  /** The fs every read goes through (default `node:fs`). */
  fsImpl?: any;
  /** Epoch milliseconds, for the GONE_MS wait (default `Date.now`). */
  now?: () => number;
}

interface LogSubscription {
  readonly channel: LogChannel;
  sources(): any;
  recompute(snapshot: boolean): LogStep;
  /** The channel stopped (a `gone` frame was printed for it); nothing more is decided. */
  end(): void;
}

/** The record's output pointer for the stream: `output.stdout` for `out`, `output.stderr` for `err`. */
function pointerOf(run: any, stream: Stream): any {
  const pointer = run?.output?.[stream === 'out' ? 'stdout' : 'stderr'];
  return pointer && typeof pointer === 'object' ? pointer : null;
}

const stateKey = (state: RunState): string => JSON.stringify([state.phase, state.end]);

/**
 * Makes the LogSubscription of one log channel (IC-008). The lifecycle root is resolved here,
 * once; the output files live under its `.doflow/state`, where the sink writes them.
 * @param {LogSubscriptionOptions} options
 * @returns {LogSubscription}
 */
function createLogSubscription(options: LogSubscriptionOptions): LogSubscription {
  const { channel, writer } = options;
  if (!channel || channel.kind !== 'log') throw new TypeError('a log subscription needs a log channel');
  if (!options.ctx || typeof options.ctx.cwd !== 'string' || options.ctx.cwd === '') throw new TypeError('a log subscription needs a cwd');
  const fsImpl = options.fsImpl ?? fs;
  const now = options.now ?? Date.now;
  const ch = channel.name;
  const { runId, stream } = channel;
  const lifecycleRoot: string = lifecycleProjectRoot(path.resolve(options.ctx.cwd));
  const stateRoot = path.join(lifecycleRoot, '.doflow', 'state');
  const file: string = logFile(stateRoot, runId, stream);

  let primaryPath: string | null = null;
  let done = false;
  /** What the last snapshot said; null while a snapshot is owed. */
  let lastLog: 'waiting' | 'open' | 'none' | null = null;
  let ino: string | null = null;
  let cursor = 0;
  let sent: RunState = { phase: null, end: null };
  let seenFile = false;
  let missingSince: number | null = null;
  let failedCode: string | null = null;
  /** The phase the last recompute read; the log pass runs while it is not `ended`. */
  let phaseSeen: string | null = null;

  /** The run's record: from the declared primary store, else the store that holds it now. */
  function readRecord(): { ok: true; run: any } | { ok: false } {
    let storeFile = primaryPath;
    if (storeFile === null) {
      const found = findWorkerRun({ lifecycleRoot }, runId);
      if (!found) return { ok: true, run: null };
      storeFile = found.file;
    }
    let runs: Record<string, any>;
    try {
      runs = readRuns(storeFile, fsImpl);
    } catch (error: any) {
      if (error?.code === 'store-unreadable') return { ok: false };
      throw error;
    }
    return { ok: true, run: Object.prototype.hasOwnProperty.call(runs, runId) ? runs[runId] : null };
  }

  function read(mode: 'tail' | 'forward', final: boolean): Page {
    return readLogPage(mode === 'tail' ? { file, mode, final, fsImpl } : { file, mode, offset: cursor, ino: ino as string, final, fsImpl });
  }

  /** An `error` frame once per spell; a later good read ends the spell with a snapshot. */
  function fail(code: string): LogStep {
    if (failedCode === code) return { lines: [] };
    failedCode = code;
    lastLog = null;
    return { lines: writer.error(ch, code) };
  }

  function gone(): LogStep {
    done = true;
    return { lines: writer.gone(ch), gone: true };
  }

  function snapshot(log: 'waiting' | 'open' | 'none', page: Page | null, state: RunState): string[] {
    const open = log === 'open' && page !== null;
    const lines = writer.logSnapshot(ch, {
      log,
      ino: open ? page.ino : null,
      from: open ? page.from : 0,
      to: open ? page.to : 0,
      pieces: open ? page.pieces : [],
      phase: state.phase,
      end: state.end,
    });
    lastLog = log;
    ino = open ? page.ino : null;
    cursor = open ? page.to : 0;
    sent = state;
    return lines;
  }

  /** Step 7: one append with no pieces when `phase` or `end` changed. */
  function change(state: RunState): string[] {
    if (stateKey(state) === stateKey(sent)) return [];
    const lines = writer.append(ch, { from: cursor, to: cursor, pieces: [], phase: state.phase, end: state.end });
    sent = state;
    return lines;
  }

  /** Step 6: appends from the cursor, at most CATCHUP_FRAMES; `again` when the end was not reached. */
  function catchUp(first: Page, state: RunState, final: boolean): LogStep {
    const lines: string[] = [];
    let page = first;
    let frames = 0;
    for (;;) {
      if (page.to > cursor) {
        // Only the frame that reaches the readable end carries a new phase or end, so the last
        // bytes of an ended run are sent before its end is (FR-011 b).
        const carried = page.eof ? state : sent;
        lines.push(...writer.append(ch, { from: cursor, to: page.to, pieces: page.pieces, phase: carried.phase, end: carried.end }));
        if (writer.needsSnapshot(ch)) { // `reset` `frame-cap`: the next recompute snapshots
          lastLog = null;
          return { lines, again: 0 };
        }
        cursor = page.to;
        sent = carried;
        frames += 1;
      }
      if (page.eof) break;
      if (frames >= CATCHUP_FRAMES) return { lines, again: 0 };
      page = read('forward', final);
      if (page.file === 'absent' || page.reset) return { lines, again: 0 }; // the next recompute decides
    }
    lines.push(...change(state));
    return { lines };
  }

  return {
    channel,

    /**
     * IC-008's declared sources, read now: the `worker-output` directory with `match`
     * `^<runId>\.<stream>\.log$`, the directories and primary record `worker:<runId>` declares
     * (`workerSources`), and the file as the detector's `tail`.
     */
    sources() {
      const worker = workerSources({ lifecycleRoot }, runId);
      primaryPath = worker.primary ? worker.primary.path : null;
      return {
        directories: [{ path: path.join(stateRoot, 'worker-output'), match: new RegExp(`^${runId}\\.${stream}\\.log$`) }, ...worker.directories],
        files: [],
        derived: [],
        primary: worker.primary,
        tail: { path: file, active: () => !done && phaseSeen !== 'ended' },
      };
    },

    /**
     * One IC-008 recompute. `snapshot` asks for a snapshot (first read, after an error or a
     * `reset`); one is also owed whenever the writer says so.
     */
    recompute(snapshotAsked: boolean): LogStep {
      if (done) return { lines: [] };
      let record: { ok: true; run: any } | { ok: false };
      try {
        record = readRecord();
      } catch {
        return fail('producer-failed');
      }
      if (!record.ok) return fail('store-unreadable');
      const run = record.run;
      const phase: string | null = run && PHASES.includes(run.phase) ? run.phase : null;
      phaseSeen = phase;
      const pointer = pointerOf(run, stream);
      const ended = phase === 'ended';
      const state: RunState = { phase, end: ended ? { capped: pointer ? pointer.truncated === true : null } : null };
      const final = ended && pointer !== null;
      const owe = snapshotAsked || lastLog === null || writer.needsSnapshot(ch);
      const positioned = !owe && lastLog === 'open' && ino !== null;
      let page: Page;
      try {
        page = read(positioned ? 'forward' : 'tail', final);
      } catch {
        return fail('producer-failed');
      }
      failedCode = null;

      if (page.file === 'absent') {
        if (ended) { // step 2
          if (pointer !== null || seenFile) return gone();
          return { lines: owe || lastLog !== 'none' ? snapshot('none', null, state) : change(state) };
        }
        if (seenFile) { // step 3
          if (missingSince === null) missingSince = now();
          const waited = now() - missingSince;
          if (waited >= GONE_MS) return gone();
          return { lines: owe ? snapshot('waiting', null, state) : change(state), again: GONE_MS - waited };
        }
        return { lines: owe ? snapshot('waiting', null, state) : change(state) }; // step 1
      }

      missingSince = null;
      seenFile = true;
      if (owe || lastLog !== 'open') return { lines: snapshot('open', page, state) }; // step 4 (a tail read)
      if (page.reset) return { lines: [...writer.reset(ch, 'replaced'), ...snapshot('open', page, state)] }; // step 5
      return catchUp(page, state, final); // steps 6 and 7
    },

    end(): void {
      done = true;
    },
  };
}

module.exports = { createLogSubscription, CATCHUP_FRAMES };
