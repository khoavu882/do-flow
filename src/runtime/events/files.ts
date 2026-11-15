'use strict';

// Feature 161 T5 (IC-004; FR-009, NFR-001): the `file:<pk>:<fk>` lane of `doflow events --follow`: one
// indexed artifact (a brief, report, envelope, prompt or worker log) streamed as masked pieces.
//
// The lane is a LogSubscription like logs.ts's (the same `recompute`, `sources`, `end` contract and the
// frames of row 150 IC-008), with `phase` and `end` always null. Its file is resolved ONLY through the
// project's artifacts index (`findArtifact` over the project's checkouts from the child's project
// index): a project the index does not know, a fileKey it does not list, or a file that leaves the
// listing gives `gone`. The path stays inside the core; nothing the Console sends names one.
//
//   1. the file is gone from the index: `gone`
//   2. the file cannot be opened but is still listed: one `none` snapshot
//   3. first read, or one owed (after an error or a `reset`): an `open` snapshot of the newest page
//   4. another inode, or a size below the cursor: `reset` `replaced`, then a snapshot
//   5. bytes past the cursor: `forward` reads, at most CATCHUP_FRAMES appends, then a re-mark
//
// The listing is checked again when the last check is RESOLVE_MS old (the detector's 30 s pass always
// finds it so), before every snapshot, on another inode, and whenever the file cannot be opened.
// Ceiling: a file pushed out of the 64 newest artifacts stays followed for at most RESOLVE_MS. Every
// read opens the file through `confined.ts` under its checkout: a link anywhere on the way, or a file
// swapped between the check and the open, reads as absent, so the listing is checked again and a
// link (never listed) is `gone`. Reads go through `readLogPage` (masking, bounded pages). A worker log is read to its last newline while it is active;
// every other file, and a worker log idle for TAIL_ACTIVE_MS, to its last byte, so a brief with no final
// newline shows whole. Read-only: opened O_RDONLY (with O_NOFOLLOW); no file is created, written or locked.

const fs = require('node:fs');
const path = require('node:path');
const { readLogPage } = require('../worker/log-read.ts');
const { findArtifact } = require('./artifacts.ts');
const { confinedReader } = require('./confined.ts');
const { CATCHUP_FRAMES } = require('./logs.ts');

/** The 250 ms log pass reads a file while it changed in the last 10 minutes. */
const TAIL_ACTIVE_MS = 10 * 60 * 1000;
/** The least time between two checks of the artifacts listing; under the detector's 30 s pass. */
const RESOLVE_MS = 25000;

type Page = {
  file: 'present' | 'absent'; ino: string | null; size: number; from: number; to: number;
  pieces: Array<{ at: number; text: string; cut?: true }>; eof: boolean; reset: boolean;
};
type FileChannel = { kind: 'file'; name: string; projectKey: string; fileKey: string };
interface LaneStep { lines: string[]; gone?: true; again?: number | null }

interface FileLaneOptions {
  channel: FileChannel;
  /** The channel context of the events command: `index` is the child's project index. */
  ctx: { cwd: string; index?: any };
  writer: any;
  fsImpl?: any;
  now?: () => number;
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Makes the lane of one `file:<pk>:<fk>` channel. The artifacts listing is read when `sources()` is
 * called and again as described above.
 * @param {FileLaneOptions} options
 */
function createFileLane(options: FileLaneOptions): any {
  const { channel, writer, ctx } = options;
  if (!channel || channel.kind !== 'file') throw new TypeError('a file lane needs a file channel');
  if (!ctx || !ctx.index) throw new TypeError('a file lane needs the project index');
  const index = ctx.index;
  const fsImpl = options.fsImpl ?? fs;
  const now = options.now ?? Date.now;
  const ch = channel.name;

  let found: { path: string; kind: string; root: string } | null = null;
  let resolvedAt = -Infinity;
  let done = false;
  /** What the last snapshot said; null while a snapshot is owed. */
  let lastLog: 'open' | 'none' | null = null;
  let ino: string | null = null;
  let cursor = 0;
  let failed = false;

  /** Looks the file up in the project's current artifacts index; false when it is not listed. */
  function resolve(): boolean {
    resolvedAt = now();
    const entry = index.lookup(channel.projectKey);
    found = entry === null ? null : findArtifact(entry.checkouts, channel.fileKey, fsImpl);
    return found !== null;
  }

  function active(): boolean {
    try { return found !== null && now() - fsImpl.statSync(found.path).mtimeMs < TAIL_ACTIVE_MS; } catch { return false; }
  }

  /** The detector's tail runs while the file is recent, and while it cannot be statted, so a deletion is seen at the next log pass. */
  function tailActive(): boolean {
    if (found === null) return false;
    try { return now() - fsImpl.statSync(found.path).mtimeMs < TAIL_ACTIVE_MS; } catch { return true; }
  }

  function gone(): LaneStep {
    done = true;
    return { lines: writer.gone(ch), gone: true };
  }

  function read(mode: 'tail' | 'forward'): Page {
    const file = (found as { path: string; kind: string; root: string });
    const final = !file.kind.startsWith('worker-') || !active();
    const via = confinedReader(file.root, fsImpl);
    return readLogPage(mode === 'tail' ? { file: file.path, mode, final, fsImpl: via } : { file: file.path, mode, offset: cursor, ino: ino as string, final, fsImpl: via });
  }

  function snapshot(log: 'open' | 'none', page: Page | null): string[] {
    const open = log === 'open' && page !== null;
    const lines = writer.logSnapshot(ch, {
      log, ino: open ? page.ino : null, from: open ? page.from : 0, to: open ? page.to : 0, pieces: open ? page.pieces : [], phase: null, end: null,
    });
    lastLog = log;
    ino = open ? page.ino : null;
    cursor = open ? page.to : 0;
    return lines;
  }

  /** Appends from the cursor, at most CATCHUP_FRAMES; `again` when the end was not reached. */
  function catchUp(first: Page): LaneStep {
    const lines: string[] = [];
    let page = first;
    let frames = 0;
    for (;;) {
      if (page.to > cursor) {
        lines.push(...writer.append(ch, { from: cursor, to: page.to, pieces: page.pieces, phase: null, end: null }));
        if (writer.needsSnapshot(ch)) { // `reset` `frame-cap`: the next recompute snapshots
          lastLog = null;
          return { lines, again: 0 };
        }
        cursor = page.to;
        frames += 1;
      }
      if (page.eof) return { lines };
      if (frames >= CATCHUP_FRAMES) return { lines, again: 0 };
      page = read('forward');
      if (page.file === 'absent' || page.reset) return { lines, again: 0 }; // the next recompute decides
    }
  }

  return {
    channel,

    /** The file's directory narrowed to its name, and the file as the detector's one tail. */
    sources() {
      resolve();
      if (found === null) return { directories: [], files: [], derived: [], primary: null, tails: [] };
      const file = found.path;
      return {
        directories: [{ path: path.dirname(file), match: new RegExp(`^${escapeRe(path.basename(file))}$`) }],
        files: [],
        derived: [],
        primary: null,
        tails: [{ path: file, active: () => !done && tailActive() }],
      };
    },

    recompute(snapshotAsked: boolean): LaneStep {
      if (done) return { lines: [] };
      const owe = snapshotAsked || lastLog === null || writer.needsSnapshot(ch);
      if (found === null || owe || now() - resolvedAt >= RESOLVE_MS) {
        if (!resolve()) return gone();
      }
      let page: Page;
      try {
        page = read(!owe && lastLog === 'open' && ino !== null ? 'forward' : 'tail');
      } catch {
        if (failed) return { lines: [] };
        failed = true;
        lastLog = null;
        return { lines: writer.error(ch, 'producer-failed') };
      }
      failed = false;
      if (page.file === 'absent') {
        if (!resolve()) return gone();
        return { lines: lastLog === 'none' && !owe ? [] : snapshot('none', null) };
      }
      if (owe || lastLog !== 'open') return { lines: snapshot('open', page) };
      if (page.reset) {
        if (!resolve()) return gone(); // another inode: listed again before it is served
        return { lines: [...writer.reset(ch, 'replaced'), ...snapshot('open', page)] };
      }
      return catchUp(page);
    },

    end(): void {
      done = true;
    },
  };
}

module.exports = { createFileLane, TAIL_ACTIVE_MS, RESOLVE_MS };
