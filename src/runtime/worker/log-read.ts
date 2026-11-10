'use strict';

// Feature 150 A.1 (IC-001, C1; FR-008, FR-009, FR-011, FR-012, FR-018, DEC-006): the shared worker
// log reader. One function turns one output file and a position into one page of masked pieces,
// so the `worker-log` verb and the `worker:<runId>:out|err` channels carry the same pieces for the
// same byte range.
//
// `logFile` is the only function on the read side (this module, `reads.ts`, `events/logs.ts`) that
// forms a path to a file under `worker-output`, and it forms only the two names the sink writes
// (`createOutputSink`, supervisor.ts): `<runId>.out.log` and `<runId>.err.log`. `<runId>.last.log`
// cannot be formed here, and no path is taken from a run record. `events/logs.ts` also forms the
// `worker-output` directory path as a watched source; the detector lists it and stats only the names
// matching `^<runId>\.<stream>\.log$` (a stat, not an open). The supervisor, on the write side, forms
// all three names. `readLogPage` opens the file with flag 'r' and only reads: nothing is locked,
// created, written, renamed or deleted.
//
// Boundaries depend only on the file's bytes: 0, every offset after a '\n', the readable end, and
// every multiple of PIECE_GRID_BYTES inside a line backed off to a character start. So a long line
// is cut at the same offsets by every read and pieces from different reads align.

const fs = require('node:fs');
const path = require('node:path');
const { RUN_ID } = require('./run-store.ts');
const { maskBody } = require('../mask.ts');

/** The only two suffixes any path formed here carries. */
const LOG_STREAMS = Object.freeze({ out: 'out', err: 'err' });
/** The most file bytes one page or one frame covers (`to - from`). */
const PAGE_BYTES = 131072;
/** A line longer than this is cut at multiples of it. */
const PIECE_GRID_BYTES = 32768;
/** The most bytes `JSON.stringify(pieces)` may take. */
const FRAME_JSON_BUDGET = 204800;
/** The most UTF-8 continuation bytes one character holds; a grid cut backs off at most this far. */
const MAX_CONTINUATION = 3;
/** The chunk the backward scan for the last '\n' reads at a time. */
const SCAN_BYTES = 65536;
const MODES = Object.freeze(['tail', 'forward', 'backward']);
const NL = 0x0a;

type Stream = 'out' | 'err';
type Mode = 'tail' | 'forward' | 'backward';
type Piece = { at: number; text: string; cut?: true };
type LogPage = {
  file: 'present' | 'absent'; ino: string | null; size: number; from: number; to: number;
  pieces: Piece[]; eof: boolean; reset: boolean;
};

/** `<stateRoot>/worker-output/<runId>.<out|err>.log`, the path the output sink writes. */
function logFile(stateRoot: string, runId: string, stream: Stream): string {
  if (typeof stateRoot !== 'string' || !stateRoot) throw new TypeError('logFile: the state root must be a non-empty string');
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new TypeError(`logFile: run id '${runId}' is not 'w-' plus 12 hex characters`);
  if (typeof stream !== 'string' || !Object.hasOwn(LOG_STREAMS, stream)) throw new TypeError(`logFile: stream must be out or err: ${String(stream)}`);
  return path.join(stateRoot, 'worker-output', `${runId}.${LOG_STREAMS[stream]}.log`);
}

const absentPage = (): LogPage => ({ file: 'absent', ino: null, size: 0, from: 0, to: 0, pieces: [], eof: true, reset: false });

/** Reads `[start, end)` of `fd` into a new buffer; a short read (a file shrinking under us) returns fewer bytes. */
function readRange(fsImpl: any, fd: number, start: number, end: number): Buffer {
  const buf = Buffer.alloc(Math.max(0, end - start));
  let filled = 0;
  while (filled < buf.length) {
    const n = fsImpl.readSync(fd, buf, filled, buf.length - filled, start + filled);
    if (!n) break;
    filled += n;
  }
  return filled === buf.length ? buf : buf.subarray(0, filled);
}

/** The offset just after the last '\n' in the first `size` bytes, or 0 when there is none. */
function lastNewlineEnd(fsImpl: any, fd: number, size: number): number {
  for (let end = size; end > 0; end -= SCAN_BYTES) {
    const start = Math.max(0, end - SCAN_BYTES);
    const chunk = readRange(fsImpl, fd, start, end);
    const at = chunk.lastIndexOf(NL);
    if (at !== -1) return start + at + 1;
  }
  return 0;
}

/**
 * The window of bytes `[base, base + buf.length)` and the readable end `E`, enough to decide every
 * boundary in `[lo, hi]`: a grid boundary `g - d` needs bytes `g - 3` to `g`, and `g` can sit up to
 * three bytes past `hi`.
 */
function windowFor(fsImpl: any, fd: number, lo: number, hi: number, E: number) {
  const base = Math.max(0, lo - MAX_CONTINUATION - 1);
  const buf = readRange(fsImpl, fd, base, Math.min(E, hi + MAX_CONTINUATION + 1));
  const at = (i: number) => buf[i - base];
  return { base, buf, at };
}

/** Every boundary in `[lo, hi]` (`hi <= E`), ascending. `at(i)` is the file's byte at `i`. */
function boundaries(lo: number, hi: number, E: number, at: (i: number) => number | undefined): number[] {
  const out = new Set<number>();
  if (lo === 0) out.add(0);
  for (let i = Math.max(0, lo - 1); i < hi; i++) if (at(i) === NL) out.add(i + 1);
  // A grid point is inside a line when it starts no line and is not the line's own '\n'.
  const first = Math.max(PIECE_GRID_BYTES, Math.ceil(lo / PIECE_GRID_BYTES) * PIECE_GRID_BYTES);
  for (let g = first; g < E && g <= hi + MAX_CONTINUATION; g += PIECE_GRID_BYTES) {
    if (at(g - 1) === NL || at(g) === NL) continue;
    let d = 0;
    while (d < MAX_CONTINUATION && ((at(g - d) ?? 0) & 0xc0) === 0x80) d++;
    const b = g - d;
    if (b >= lo && b <= hi) out.add(b);
  }
  if (hi === E) out.add(E);
  return [...out].sort((a, b) => a - b);
}

/** The masked piece of bytes `[a, b)`, and the bytes its JSON takes. */
function pieceOf(buf: Buffer, base: number, a: number, b: number, E: number): { piece: Piece; json: number } {
  const raw = buf.subarray(a - base, b - base);
  const newline = raw.length > 0 && raw[raw.length - 1] === NL;
  const text = maskBody((newline ? raw.subarray(0, raw.length - 1) : raw).toString('utf8')).text;
  const piece: Piece = !newline && b !== E ? { at: a, text, cut: true } : { at: a, text };
  return { piece, json: Buffer.byteLength(JSON.stringify(piece), 'utf8') };
}

/** Pieces between consecutive boundaries `bs`, every one within the window. */
function piecesOf(bs: number[], buf: Buffer, base: number, E: number) {
  const out: { piece: Piece; json: number; end: number }[] = [];
  for (let i = 0; i + 1 < bs.length; i++) out.push({ ...pieceOf(buf, base, bs[i], bs[i + 1], E), end: bs[i + 1] });
  return out;
}

/** `JSON.stringify` of an array of pieces whose own JSON takes `sum` bytes in total. */
const arrayJson = (count: number, sum: number) => 2 + sum + Math.max(0, count - 1);

/** Tail and backward: the page ending at `to`, starting at the first boundary at or after `to - PAGE_BYTES`, dropped from the front to the frame budget. */
function pageBack(fsImpl: any, fd: number, to: number, E: number) {
  const lo = Math.max(0, to - PAGE_BYTES);
  const { base, buf, at } = windowFor(fsImpl, fd, lo, to, E);
  const bs = boundaries(lo, to, E, at);
  if (bs[bs.length - 1] !== to) bs.push(to);
  const all = piecesOf(bs, buf, base, E);
  let sum = all.reduce((n, p) => n + p.json, 0);
  let first = 0;
  while (first < all.length && arrayJson(all.length - first, sum) > FRAME_JSON_BUDGET) sum -= all[first++].json;
  const kept = all.slice(first);
  return { from: kept.length ? kept[0].piece.at : to, to, pieces: kept.map((p) => p.piece) };
}

/** Forward: pieces from `from` toward `E`, stopping before the first that breaks either bound. */
function pageForward(fsImpl: any, fd: number, from: number, E: number) {
  if (from >= E) return { from, to: from, pieces: [] as Piece[] };
  const hi = Math.min(E, from + PAGE_BYTES);
  const { base, buf, at } = windowFor(fsImpl, fd, from, hi, E);
  const bs = boundaries(from, hi, E, at);
  if (bs[0] !== from) bs.unshift(from);
  const pieces: Piece[] = [];
  let sum = 0;
  let to = from;
  for (const p of piecesOf(bs, buf, base, E)) {
    if (p.end - from > PAGE_BYTES || arrayJson(pieces.length + 1, sum + p.json) > FRAME_JSON_BUDGET) break;
    pieces.push(p.piece);
    sum += p.json;
    to = p.end;
  }
  return { from, to, pieces };
}

const isOffset = (value: any) => Number.isSafeInteger(value) && value >= 0;

/**
 * One page of masked pieces from `file` (IC-001). `tail` ends at the readable end; `forward` starts
 * at `offset`; `backward` ends at `min(offset, E)`. A read whose `ino` differs from the file's, or
 * whose `offset` is past its size, is a `tail` read with `reset: true`. `ENOENT` or `ENOTDIR` gives
 * the absent page; any other open, stat or read error is thrown.
 */
function readLogPage({ file, mode, offset, ino, final, fsImpl = fs }: {
  file: string; mode: Mode; offset?: number; ino?: string; final: boolean; fsImpl?: any;
}): LogPage {
  if (typeof file !== 'string' || !file) throw new TypeError('readLogPage: file must be a non-empty string');
  if (!MODES.includes(mode)) throw new TypeError(`readLogPage: mode must be one of ${MODES.join(', ')}: ${String(mode)}`);
  if (typeof final !== 'boolean') throw new TypeError('readLogPage: final must be a boolean');
  const positioned = mode !== 'tail';
  if ((positioned || offset !== undefined) && !isOffset(offset)) throw new TypeError(`readLogPage: offset must be a non-negative integer: ${String(offset)}`);
  if ((positioned || ino !== undefined) && !(typeof ino === 'string' && /^[0-9]+$/.test(ino))) throw new TypeError(`readLogPage: ino must be a decimal string: ${String(ino)}`);

  let fd: number;
  try {
    fd = fsImpl.openSync(file, 'r');
  } catch (error: any) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return absentPage();
    throw error;
  }
  try {
    const stat = fsImpl.fstatSync(fd, { bigint: true });
    const fileIno = String(stat.ino);
    const size = Number(stat.size);
    const E = final ? size : lastNewlineEnd(fsImpl, fd, size);
    const reset = (ino !== undefined && ino !== fileIno) || (offset !== undefined && offset > size);
    const effective: Mode = reset ? 'tail' : mode;
    const page = effective === 'forward' ? pageForward(fsImpl, fd, offset as number, E)
      : pageBack(fsImpl, fd, effective === 'backward' ? Math.min(offset as number, E) : E, E);
    return { file: 'present', ino: fileIno, size, from: page.from, to: page.to, pieces: page.pieces, eof: page.to >= E, reset };
  } finally {
    fsImpl.closeSync(fd);
  }
}

module.exports = { LOG_STREAMS, PAGE_BYTES, PIECE_GRID_BYTES, FRAME_JSON_BUDGET, logFile, readLogPage };
