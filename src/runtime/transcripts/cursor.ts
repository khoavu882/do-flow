'use strict';

/**
 * 093 V.4 (IC-022): the byte cursor, the bounded window read and the driver every transcript reader shares.
 *
 * A reader (`readers/<id>.ts`) is a `SPEC` of three small parts: its required keys, an optional `init`, and
 * `parse(record, ctx)`, which returns the normalised events of one record. The driver owns the rest:
 *  - the cursor `<inode>:<byteOffset>:<recordSeq>:<recordAtMs>`; a changed inode or a shorter file resets it
 *    to the last 64 records (`reset: true`); a read with no cursor starts the same way with `reset: false`;
 *  - at most 256 KiB per call, whole lines only: an unfinished last line is left for the next read;
 *  - `otherRecords` (records and blocks never read into an event: thinking, prompts, attachments, unknown types),
 *    `unparsable` (lines that are not a JSON object), and the `format-unrecognized` warning when more than 20 %
 *    of the processed records are unparsable or lack the reader's required keys;
 *  - text policy: every text-bearing string is masked with `maskBody` AFTER JSON decoding, then cut after
 *    masking (reply 4 KiB, tool arguments 512 B) with `cut: true`. Never on the raw line (R§4.8): escaped JSON
 *    such as `\"token\":\"...\"` inside a string slips past the key rules until it is decoded.
 * Read-only: files are opened `'r'` and nothing is created or written. Ceilings: `recordSeq` counts events
 * from the reset point, not from the start of the file; Claude usage dedup and the model of an event only see
 * the current window, so a message split across two reads can count its usage twice.
 */

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { maskBody } = require('../mask.ts');

const MAX_READ_BYTES = 256 * 1024;
const TAIL_RECORDS = 64;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const TEXT_CAP = 4096;
const ARGS_CAP = 512;
const MASK_MARGIN = 4096; // bytes kept past the cap before masking, so a secret cut by the cap is still whole when masked
const LEAF_MAX = 8192;
const UNRECOGNIZED_RATIO = 0.2;
const LABEL = /^[A-Za-z0-9 ._:/@-]{1,64}$/;
const CURSOR = /^(\d+):(\d+):(\d+):(\d+)$/;

/** IC-004's label rule: a value that is not a short plain label is withheld (null for an absent value). */
function label(value: any): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && LABEL.test(value) ? value : '(withheld)';
}

function parseCursor(text: any): { ino: string; offset: number; seq: number; atMs: number } | null {
  const m = typeof text === 'string' ? CURSOR.exec(text) : null;
  if (!m) return null;
  const [offset, seq, atMs] = [Number(m[2]), Number(m[3]), Number(m[4])];
  return [offset, seq, atMs].every(Number.isSafeInteger) ? { ino: m[1], offset, seq, atMs } : null;
}

/** Milliseconds from an ISO string or an epoch-ms number; NaN when neither. */
function toMs(at: any): number {
  if (typeof at === 'number') return Number.isFinite(at) ? at : NaN;
  return typeof at === 'string' ? Date.parse(at) : NaN;
}

function toIso(at: any): string | null {
  const ms = toMs(at);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function callKey(id: any): string | null {
  return typeof id === 'string' || typeof id === 'number' ? createHash('sha256').update(String(id)).digest('hex').slice(0, 16) : null;
}

/** Bytes of a tool result's content, never the content itself. */
function sizeOf(value: any): number | null {
  if (value === null || value === undefined) return null;
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value) ?? '', 'utf8');
}

/** A token record with a number or null per field; null when nothing is known (unknown is never zero). */
function tokens(fields: Record<string, any>): any {
  const out: Record<string, number | null> = {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) {
    out[key] = Number.isFinite(fields[key]) ? fields[key] : null;
  }
  return Object.values(out).some((v) => v !== null) ? out : null;
}

function cutBytes(text: string, cap: number): { text: string; cut: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= cap) return { text, cut: false };
  let end = cap;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1; // never split a character
  return { text: buf.toString('utf8', 0, end), cut: true };
}

/** Reply text: mask (after decoding), then cut. */
function capText(value: any, cap: number): { text: string; cut: boolean; masked: number } {
  const s = String(value);
  const long = s.length > cap + MASK_MARGIN;
  const m = maskBody(long ? s.slice(0, cap + MASK_MARGIN) : s);
  const r = cutBytes(m.text, cap);
  return { text: r.text, cut: r.cut || long, masked: m.masked };
}

/**
 * Tool arguments: a JSON string is decoded, every string leaf is masked on its own decoded text (so a
 * quoted key inside an embedded JSON string is plain again), the structure is rendered, the rendering is
 * masked once more (a `{"password":"x"}` pair only shows its key next to its value there), then cut.
 */
function capArgs(value: any, cap: number): { text: string; cut: boolean; masked: number } {
  let masked = 0;
  let leaves = 0;
  let v = value;
  if (typeof v === 'string') {
    try { const parsed = JSON.parse(v); if (parsed !== null && typeof parsed === 'object') v = parsed; } catch { /* plain text */ }
  }
  const walk = (x: any, depth: number): any => {
    if (typeof x === 'string') {
      if (++leaves > 64) return '...';
      const r = maskBody(x.length > LEAF_MAX ? x.slice(0, LEAF_MAX) : x);
      masked += r.masked;
      return r.text;
    }
    if (x === null || typeof x !== 'object') return x;
    if (depth > 6) return '...';
    if (Array.isArray(x)) return x.slice(0, 64).map((item) => walk(item, depth + 1));
    const out: Record<string, any> = {};
    for (const key of Object.keys(x).slice(0, 64)) out[key] = walk(x[key], depth + 1);
    return out;
  };
  const walked = walk(v, 0);
  const r = capText(typeof walked === 'string' ? walked : JSON.stringify(walked) ?? '', cap);
  return { text: r.text, cut: r.cut, masked: masked + r.masked };
}

function readRange(fd: number, from: number, to: number): Buffer {
  const buf = Buffer.alloc(Math.max(0, to - from));
  let got = 0;
  while (got < buf.length) {
    const n = fs.readSync(fd, buf, got, buf.length - got, from + got);
    if (n === 0) break;
    got += n;
  }
  return got < buf.length ? buf.subarray(0, got) : buf;
}

interface Line { text: string; start: number; end: number; oversize?: boolean }

/**
 * Whole lines of `buf` (absolute offset `base` for its first byte). `skipFirst` drops the leading partial
 * line (the buffer then starts one byte before the first wanted byte). Blank lines are skipped but consumed.
 */
function splitLines(buf: Buffer, base: number, skipFirst: boolean): { lines: Line[]; end: number; rest: number } {
  const lines: Line[] = [];
  let p = 0;
  if (skipFirst) {
    const i = buf.indexOf(10);
    p = i === -1 ? buf.length : i + 1;
  }
  for (let nl = buf.indexOf(10, p); nl !== -1 && p < buf.length; nl = buf.indexOf(10, p)) {
    const text = buf.toString('utf8', p, nl);
    if (text.trim() !== '') lines.push({ text, start: base + p, end: base + nl + 1 });
    p = nl + 1;
  }
  return { lines, end: base + p, rest: buf.length - p };
}

/**
 * The window one call reads. `lines` are the records to process; `prior()` returns the raw lines before the
 * window (Copilot differences its cumulative usage against them).
 */
function openWindow(file: string, cursorText: any, maxBytes: number): any {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    const ino = String(st.ino);
    const size = Number(st.size);
    const cursor = parseCursor(cursorText);
    const reset = cursor !== null && (cursor.ino !== ino || size < cursor.offset);
    const tail = cursor === null || reset;
    const from = tail ? Math.max(0, size - maxBytes) : (cursor as any).offset;
    const skipFirst = tail && from > 0;
    const base = skipFirst ? from - 1 : from;
    const buf = readRange(fd, base, Math.min(size, from + maxBytes));
    const split = splitLines(buf, base, skipFirst);
    let { lines } = split;
    if (tail && lines.length > TAIL_RECORDS) lines = lines.slice(-TAIL_RECORDS);
    const windowEnd = base + buf.length;
    // One line longer than the whole window: consume it as a single unparsable record.
    if (!skipFirst && lines.length === 0 && split.rest > 0 && windowEnd < size) {
      lines = [{ text: '', start: from, end: windowEnd, oversize: true }];
    }
    const startOffset = lines.length ? lines[0].start : split.end;
    return {
      ino, size, cursor, reset, tail, lines, startOffset, completeEnd: lines.length ? lines[lines.length - 1].end : split.end,
      reachedEnd: windowEnd >= size,
      prior(): string[] {
        if (startOffset === 0) return [];
        const pFrom = Math.max(0, startOffset - maxBytes);
        const pBase = pFrom > 0 ? pFrom - 1 : 0;
        const pfd = fs.openSync(file, 'r');
        try { return splitLines(readRange(pfd, pBase, startOffset), pBase, pFrom > 0).lines.map((l) => l.text); } finally { fs.closeSync(pfd); }
      },
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** The first `maxLines` JSON-object records of a file (at most 64 KiB), for a reader's `header`. */
function headRecords(file: string, maxLines: number = 8, maxBytes: number = 64 * 1024): any[] {
  const fd = fs.openSync(file, 'r');
  try {
    const out: any[] = [];
    const { lines } = splitLines(readRange(fd, 0, maxBytes), 0, false);
    for (const line of lines) {
      if (out.length >= maxLines) break;
      try { const rec = JSON.parse(line.text); if (rec && typeof rec === 'object') out.push(rec); } catch { /* torn */ }
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** A small JSON companion file (at most 256 KiB), or null when absent or unreadable. */
function readJsonFile(file: string): any {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size > MAX_READ_BYTES) return null;
      const parsed = JSON.parse(readRange(fd, 0, size).toString('utf8'));
      return parsed !== null && typeof parsed === 'object' ? parsed : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function makeContext(mode: string, agentKey: any): any {
  const ctx: any = { mode, agentKey, pending: 0, state: {}, calls: new Map<string, { ms: number; name: string | null }>() };
  ctx.tool = (name: any, id: any, extra: any = {}) => ({
    name: label(name), callKey: callKey(id), status: extra.status ?? null, bytes: extra.bytes ?? null, durationMs: extra.durationMs ?? null,
  });
  ctx.noteCall = (id: any, at: any, name: any) => { if (id !== undefined && id !== null) ctx.calls.set(String(id), { ms: toMs(at), name: typeof name === 'string' ? name : null }); };
  ctx.callOf = (id: any) => (id === undefined || id === null ? undefined : ctx.calls.get(String(id)));
  /** Milliseconds from the call's record to `at`, when both are in the window. */
  ctx.durationOf = (id: any, at: any) => {
    const call = ctx.callOf(id);
    const d = call ? toMs(at) - call.ms : NaN;
    return Number.isFinite(d) && d >= 0 ? d : null;
  };
  ctx.event = (kind: string, at: any, f: any = {}) => {
    let text: string | null = null;
    let args: string | null = null;
    let cut = false;
    if (mode === 'text') {
      if (f.text !== undefined && f.text !== null) { const r = capText(f.text, TEXT_CAP); text = r.text; cut = r.cut; ctx.pending += r.masked; }
      if (f.args !== undefined && f.args !== null) { const r = capArgs(f.args, ARGS_CAP); args = r.text; cut = cut || r.cut; ctx.pending += r.masked; }
    }
    return {
      seq: 0, at: toIso(at), kind, agentKey: ctx.agentKey, model: label(f.model ?? ctx.state.model ?? null),
      tool: f.tool ?? null, text, args, cut, tokens: f.tokens ?? null, record: null,
    };
  };
  return ctx;
}

/**
 * Runs one reader over one transcript file. `opts`: `file`, `mode` ('text' | 'metadata'), `cursor`, `limit`
 * (default 200, at most 500), `agentKey`, `companion` (Kiro's `.json`), `maxBytes` (default 256 KiB).
 * Throws the fs error when the file cannot be opened; the caller maps it to `not-found`.
 */
function readTranscript(spec: any, opts: any): any {
  const mode = opts.mode === 'metadata' ? 'metadata' : 'text';
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isInteger(opts.limit) ? opts.limit : DEFAULT_LIMIT));
  const win = openWindow(opts.file, opts.cursor, opts.maxBytes ?? MAX_READ_BYTES);
  const ctx = makeContext(mode, opts.agentKey ?? null);
  if (spec.init) ctx.state = spec.init(win, opts, ctx) ?? {};

  const events: any[] = [];
  let seq = win.tail ? 0 : win.cursor.seq;
  let atMs = win.tail ? 0 : win.cursor.atMs;
  let committedEnd: number | null = null;
  let [other, unparsable, bad, processed, masked] = [0, 0, 0, 0, 0];
  let stopped = false;

  for (const line of win.lines) {
    let rec: any = null;
    if (!line.oversize) { try { rec = JSON.parse(line.text); } catch { /* counted below */ } }
    ctx.pending = 0;
    let out: any;
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) out = { events: [], other: 0, unparsable: 1 };
    else if (!spec.requiredKeys.every((key: string) => rec[key] !== undefined)) out = { events: [], other: 1, bad: 1 };
    else {
      out = spec.parse(rec, ctx);
      if (out.other === undefined) out.other = out.events.length ? 0 : 1;
    }
    if (events.length > 0 && events.length + out.events.length > limit) { stopped = true; break; }
    for (const event of out.events) { event.seq = seq; seq += 1; events.push(event); }
    other += out.other;
    unparsable += out.unparsable ?? 0;
    bad += out.bad ?? 0;
    masked += ctx.pending;
    processed += 1;
    committedEnd = line.end;
    const ms = rec ? toMs(spec.at ? spec.at(rec) : rec.timestamp) : NaN;
    if (Number.isFinite(ms)) atMs = ms;
  }

  const offset = committedEnd ?? (win.tail ? win.startOffset : win.cursor.offset);
  let eof = !stopped && win.reachedEnd;
  if (spec.extra) {
    ctx.pending = 0;
    const more = spec.extra(ctx, win, opts, limit - events.length);
    for (const event of more.events) { event.seq = seq; seq += 1; events.push(event); }
    masked += ctx.pending;
    if (Number.isFinite(more.atMs)) atMs = more.atMs;
    if (more.more) eof = false;
  }

  const warnings: string[] = [];
  if (processed > 0 && (unparsable + bad) / processed > UNRECOGNIZED_RATIO) warnings.push('format-unrecognized');
  return {
    events, cursor: `${win.ino}:${offset}:${seq}:${Math.trunc(atMs)}`, reset: win.reset, eof,
    otherRecords: other, unparsable, masked, warnings,
  };
}

module.exports = {
  MAX_READ_BYTES, TAIL_RECORDS, DEFAULT_LIMIT, MAX_LIMIT, TEXT_CAP, ARGS_CAP, UNRECOGNIZED_RATIO,
  parseCursor, readTranscript, headRecords, readJsonFile, label, toMs, toIso, sizeOf, tokens,
};
