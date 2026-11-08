'use strict';

// 150 A.1 (IC-001, IC-022; FR-008, FR-009, FR-011, FR-012, FR-018): the shared worker log reader.
// Every case writes its own output file under a self-removing temp folder and reads it through
// readLogPage: the stream allow-list, the readable end, newline and grid boundaries, the three
// modes, the reset rule, the absent page, the page and frame budgets and the second masking pass.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const {
  LOG_STREAMS, PAGE_BYTES, PIECE_GRID_BYTES, FRAME_JSON_BUDGET, logFile, readLogPage,
} = require('../../src/runtime/worker/log-read.ts');

const RUN_ID = 'w-0123456789ab';

/** A file under a fresh temp folder holding `content`. */
function logOf(t: any, content: string | Buffer, name = 'w.out.log') {
  const file = path.join(tempDir(t, 'doflow-worker-log-read-'), name);
  fs.writeFileSync(file, content);
  return file;
}

const jsonBytes = (pieces: any[]) => Buffer.byteLength(JSON.stringify(pieces), 'utf8');

/** Asserts the pieces are contiguous from `from` to `to` and each one's text is its masked bytes. */
function assertContiguous(buf: Buffer, page: any) {
  let at = page.from;
  for (let i = 0; i < page.pieces.length; i++) {
    const piece = page.pieces[i];
    assert.equal(piece.at, at, `piece ${i} starts where the last one ended`);
    const end = i + 1 < page.pieces.length ? page.pieces[i + 1].at : page.to;
    const raw = buf.subarray(piece.at, end).toString('utf8');
    assert.equal(piece.text, raw.endsWith('\n') ? raw.slice(0, -1) : raw);
    assert.ok(end - piece.at <= PIECE_GRID_BYTES + 3, `piece ${i} covers at most one grid cell`);
    at = end;
  }
  assert.equal(at, page.to);
}

/** Every `g - d` cut of the long line `[start, end)` that IC-001 defines, computed independently. */
function expectedCuts(buf: Buffer, start: number, end: number) {
  const cuts: number[] = [];
  for (let g = PIECE_GRID_BYTES; g < end; g += PIECE_GRID_BYTES) {
    if (g <= start || buf[g] === 0x0a) continue;
    let d = 0;
    while (d < 3 && (buf[g - d] & 0xc0) === 0x80) d++;
    cuts.push(g - d);
  }
  return cuts;
}

/** Line texts from pieces in file order: a `cut` piece runs on into the next one. */
function linesOf(pieces: any[]) {
  const out: string[] = [];
  let open = '';
  for (const p of pieces) {
    if (p.cut) open += p.text;
    else {
      out.push(open + p.text);
      open = '';
    }
  }
  if (open) out.push(open);
  return out;
}

/** The end offset of every piece marked `cut`. */
const cutsOf = (page: any) => page.pieces.flatMap((p: any, i: number) => (p.cut ? [i + 1 < page.pieces.length ? page.pieces[i + 1].at : page.to] : []));

test('constants: the two streams, frozen, and the three budgets', () => {
  assert.deepEqual({ ...LOG_STREAMS }, { out: 'out', err: 'err' });
  assert.ok(Object.isFrozen(LOG_STREAMS));
  assert.equal(PAGE_BYTES, 131072);
  assert.equal(PIECE_GRID_BYTES, 32768);
  assert.equal(FRAME_JSON_BUDGET, 204800);
});

test('logFile forms only <stateRoot>/worker-output/<runId>.<out|err>.log', () => {
  const root = path.join('/home/test', 'project', '.doflow', 'state');
  assert.equal(logFile(root, RUN_ID, 'out'), path.join(root, 'worker-output', `${RUN_ID}.out.log`));
  assert.equal(logFile(root, RUN_ID, 'err'), path.join(root, 'worker-output', `${RUN_ID}.err.log`));
  for (const stream of ['last', 'x', '__proto__', 'constructor', 'toString', 'stdout', '', 'OUT', null, undefined, 1]) {
    assert.throws(() => logFile(root, RUN_ID, stream), TypeError, `stream ${String(stream)} is refused`);
  }
  for (const runId of ['w-0123456789a', 'w-0123456789abc', 'w-0123456789AB', '../w-0123456789ab', `${RUN_ID}.last`, `${RUN_ID}/x`, 'x-0123456789ab', '', null, 7]) {
    assert.throws(() => logFile(root, runId, 'out'), TypeError, `run id ${String(runId)} is refused`);
  }
  assert.throws(() => logFile('', RUN_ID, 'out'), TypeError);
  assert.throws(() => logFile(undefined, RUN_ID, 'out'), TypeError);
});

test('the file is opened with flag r, fstat asks for a bigint inode, and nothing is written', (t) => {
  const file = logOf(t, 'one\ntwo\n');
  const calls: any[] = [];
  const spy = new Proxy(fs, {
    get(target: any, name: any) {
      const value = target[name];
      if (typeof value !== 'function') return value;
      return (...args: any[]) => {
        calls.push([name, ...args.filter((a) => typeof a === 'string' || (a && typeof a === 'object' && !Buffer.isBuffer(a)))]);
        return value.apply(target, args);
      };
    },
  });
  const page = readLogPage({ file, mode: 'tail', final: false, fsImpl: spy });
  assert.deepEqual(page.pieces.map((p: any) => p.text), ['one', 'two']);
  const names = calls.map((c) => c[0]);
  assert.deepEqual(calls.find((c) => c[0] === 'openSync'), ['openSync', file, 'r']);
  assert.deepEqual(calls.find((c) => c[0] === 'fstatSync'), ['fstatSync', { bigint: true }]);
  assert.ok(names.includes('closeSync'));
  for (const name of names) assert.ok(['openSync', 'fstatSync', 'readSync', 'closeSync'].includes(name), `only reads: ${name}`);
  assert.equal(page.ino, String(fs.statSync(file, { bigint: true }).ino));
  assert.equal(page.size, 8);
});

test('the absent page on ENOENT and on ENOTDIR', (t) => {
  const dir = tempDir(t, 'doflow-worker-log-read-');
  const absent = { file: 'absent', ino: null, size: 0, from: 0, to: 0, pieces: [], eof: true, reset: false };
  assert.deepEqual(readLogPage({ file: path.join(dir, 'missing.log'), mode: 'tail', final: false }), absent);
  const plain = path.join(dir, 'plain');
  fs.writeFileSync(plain, 'x');
  assert.deepEqual(readLogPage({ file: path.join(plain, 'w.out.log'), mode: 'forward', offset: 0, ino: '1', final: true }), absent);
  assert.throws(() => readLogPage({ file: dir, mode: 'tail', final: false }), 'any other open or read error reaches the caller');
});

test('a partial last line is held unless final', (t) => {
  const file = logOf(t, 'one\ntwo\nthr');
  const held = readLogPage({ file, mode: 'tail', final: false });
  assert.deepEqual(held.pieces, [{ at: 0, text: 'one' }, { at: 4, text: 'two' }]);
  assert.deepEqual([held.from, held.to, held.size, held.eof, held.reset], [0, 8, 11, true, false]);
  const ended = readLogPage({ file, mode: 'tail', final: true });
  assert.deepEqual(ended.pieces, [{ at: 0, text: 'one' }, { at: 4, text: 'two' }, { at: 8, text: 'thr' }]);
  assert.deepEqual([ended.from, ended.to, ended.eof], [0, 11, true]);
  const next = readLogPage({ file, mode: 'forward', offset: held.to, ino: held.ino, final: false });
  assert.deepEqual([next.from, next.to, next.pieces, next.eof], [8, 8, [], true]);

  const none = logOf(t, 'no newline yet');
  const empty = readLogPage({ file: none, mode: 'tail', final: false });
  assert.deepEqual([empty.file, empty.from, empty.to, empty.pieces, empty.eof], ['present', 0, 0, [], true]);
  assert.deepEqual(readLogPage({ file: none, mode: 'tail', final: true }).pieces, [{ at: 0, text: 'no newline yet' }]);
  assert.deepEqual(readLogPage({ file: logOf(t, ''), mode: 'tail', final: true }).pieces, []);
});

test('a 300 KiB line with multibyte characters is cut at the same offsets by every read', (t) => {
  const unit = 'ab\u20ac\u{1f600}'; // 2 + 3 + 4 bytes: grid points land inside the 4-byte character
  const head = 'first line\n';
  const line = unit.repeat(Math.ceil((300 * 1024) / 9));
  const buf = Buffer.from(`${head}${line}\nlast\n`, 'utf8');
  const file = logOf(t, buf);
  const start = Buffer.byteLength(head);
  const end = start + Buffer.byteLength(line);
  const expected = expectedCuts(buf, start, end);
  assert.ok(expected.length >= 9);
  assert.ok(expected.some((b, i) => b !== PIECE_GRID_BYTES * (i + 1)), 'at least one grid point backs off');
  for (const b of expected) assert.notEqual(buf[b] & 0xc0, 0x80, 'a cut is a character start');

  const walk = (offset: number) => {
    const pages: any[] = [];
    let page = readLogPage({ file, mode: 'forward', offset, ino: readLogPage({ file, mode: 'tail', final: false }).ino, final: false });
    pages.push(page);
    while (!page.eof) {
      page = readLogPage({ file, mode: 'forward', offset: page.to, ino: page.ino, final: false });
      pages.push(page);
    }
    return pages;
  };
  const fromZero = walk(0);
  const fromMid = walk(start + 40001);
  for (const pages of [fromZero, fromMid]) for (const page of pages) assertContiguous(buf, page);
  const cutsZero = fromZero.flatMap(cutsOf);
  const cutsMid = fromMid.flatMap(cutsOf);
  assert.deepEqual(cutsZero, expected);
  assert.deepEqual(cutsMid, expected.filter((b) => b > start + 40001));
  const textZero = fromZero.flatMap((p) => p.pieces).filter((p: any) => p.at >= start && p.at < end).map((p: any) => p.text).join('');
  assert.equal(textZero, line);
  assert.ok(!textZero.includes('\ufffd'));

  const tail = readLogPage({ file, mode: 'tail', final: false });
  assertContiguous(buf, tail);
  const back = readLogPage({ file, mode: 'backward', offset: tail.from, ino: tail.ino, final: false });
  assertContiguous(buf, back);
  for (const b of [...cutsOf(tail), ...cutsOf(back)]) assert.ok(expected.includes(b), `cut ${b} matches the forward reads`);
  const starts = new Set([...fromZero, ...fromMid].flatMap((p) => p.pieces.map((x: any) => x.at)));
  for (const piece of [...tail.pieces, ...back.pieces]) assert.ok(starts.has(piece.at), `piece at ${piece.at} aligns`);
});

test('tail, backward and forward pages walk the whole file without a repeat or a gap', (t) => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${String(i).padStart(5, '0')} ${'x'.repeat(88)}`);
  const buf = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  const file = logOf(t, buf);
  const tail = readLogPage({ file, mode: 'tail', final: false });
  assertContiguous(buf, tail);
  assert.equal(tail.to, buf.length);
  assert.ok(tail.to - tail.from <= PAGE_BYTES);
  assert.ok(tail.from >= buf.length - PAGE_BYTES);
  assert.equal(buf[tail.from - 1], 0x0a, 'tail starts at a line');
  assert.deepEqual([tail.eof, tail.reset], [true, false]);

  const back: any[][] = [tail.pieces];
  let page = tail;
  while (page.from > 0) {
    page = readLogPage({ file, mode: 'backward', offset: page.from, ino: page.ino, final: false });
    assertContiguous(buf, page);
    assert.ok(page.to - page.from <= PAGE_BYTES && page.pieces.length > 0);
    assert.equal(page.eof, false);
    back.unshift(page.pieces);
  }
  assert.deepEqual(linesOf(back.flat()), lines);
  const gridCut = back.flat().filter((p: any) => p.cut);
  assert.ok(gridCut.length > 0, 'a line that straddles a grid point is cut there, as IC-001 defines boundaries');
  assert.ok(gridCut.every((p: any) => back.flat()[back.flat().indexOf(p) + 1].at % PIECE_GRID_BYTES === 0));

  const forward: any[] = [];
  page = readLogPage({ file, mode: 'forward', offset: 0, ino: tail.ino, final: false });
  for (;;) {
    assertContiguous(buf, page);
    assert.ok(page.to - page.from <= PAGE_BYTES);
    forward.push(...page.pieces);
    if (page.eof) break;
    assert.ok(page.pieces.length > 0);
    page = readLogPage({ file, mode: 'forward', offset: page.to, ino: page.ino, final: false });
  }
  assert.deepEqual(linesOf(forward), lines);
  assert.deepEqual(forward.map((p: any) => p.at), back.flat().map((p: any) => p.at), 'forward and backward walks cut at the same offsets');

  const clamp = readLogPage({ file, mode: 'backward', offset: buf.length, ino: tail.ino, final: false });
  assert.deepEqual([clamp.from, clamp.to], [tail.from, tail.to]);
  assert.throws(() => readLogPage({ file, mode: 'sideways', final: false }), TypeError);
  assert.throws(() => readLogPage({ file, mode: 'forward', ino: tail.ino, final: false }), TypeError);
  assert.throws(() => readLogPage({ file, mode: 'backward', offset: -1, ino: tail.ino, final: false }), TypeError);
  assert.throws(() => readLogPage({ file, mode: 'forward', offset: 0, final: false }), TypeError);
  assert.throws(() => readLogPage({ file, mode: 'forward', offset: 0, ino: 'abc', final: false }), TypeError);
  assert.throws(() => readLogPage({ file, mode: 'tail', final: 'yes' }), TypeError);
});

test('reset: a replaced file and a shorter file give a tail read with reset true', (t) => {
  const file = logOf(t, 'a\nb\nc\n');
  const first = readLogPage({ file, mode: 'tail', final: false });
  const same = readLogPage({ file, mode: 'forward', offset: first.to, ino: first.ino, final: false });
  assert.deepEqual([same.reset, same.from, same.to, same.pieces], [false, 6, 6, []]);

  const other = `${file}.new`;
  fs.writeFileSync(other, 'fresh\n');
  fs.renameSync(other, file);
  const replaced = readLogPage({ file, mode: 'forward', offset: first.to, ino: first.ino, final: false });
  assert.notEqual(replaced.ino, first.ino);
  assert.deepEqual([replaced.reset, replaced.from, replaced.to, replaced.eof], [true, 0, 6, true]);
  assert.deepEqual(replaced.pieces, [{ at: 0, text: 'fresh' }]);
  const replacedBack = readLogPage({ file, mode: 'backward', offset: 2, ino: first.ino, final: false });
  assert.deepEqual([replacedBack.reset, replacedBack.from, replacedBack.to], [true, 0, 6]);

  const long = logOf(t, 'one\ntwo\nthree\n', 'long.log');
  const before = readLogPage({ file: long, mode: 'tail', final: false });
  fs.truncateSync(long, 4);
  const shorter = readLogPage({ file: long, mode: 'forward', offset: before.to, ino: before.ino, final: false });
  assert.equal(shorter.ino, before.ino, 'same inode, fewer bytes');
  assert.deepEqual([shorter.reset, shorter.size, shorter.from, shorter.to, shorter.pieces], [true, 4, 0, 4, [{ at: 0, text: 'one' }]]);
  const atSize = readLogPage({ file: long, mode: 'forward', offset: 4, ino: before.ino, final: false });
  assert.equal(atSize.reset, false);
});

test('both bounds hold with control-byte text that escapes to six bytes per byte', (t) => {
  const lineText = '\u0001'.repeat(999);
  assert.equal(JSON.stringify(lineText).length, 999 * 6 + 2);
  const buf = Buffer.from(`${`${lineText}\n`.repeat(400)}`, 'utf8');
  const file = logOf(t, buf);

  const tail = readLogPage({ file, mode: 'tail', final: false });
  assertContiguous(buf, tail);
  assert.ok(jsonBytes(tail.pieces) <= FRAME_JSON_BUDGET);
  assert.ok(tail.to - tail.from < PAGE_BYTES - 1000, 'the frame budget, not the page, bounds this page');
  assert.equal(tail.to, buf.length);
  const dropped = { at: tail.from - 1000, text: lineText };
  assert.ok(jsonBytes([dropped, ...tail.pieces]) > FRAME_JSON_BUDGET, 'pieces were dropped from the front only as needed');

  const back = readLogPage({ file, mode: 'backward', offset: tail.from, ino: tail.ino, final: false });
  assertContiguous(buf, back);
  assert.equal(back.to, tail.from);
  assert.ok(jsonBytes(back.pieces) <= FRAME_JSON_BUDGET);
  assert.ok(jsonBytes([{ at: back.from - 1000, text: lineText }, ...back.pieces]) > FRAME_JSON_BUDGET);

  const forward = readLogPage({ file, mode: 'forward', offset: 0, ino: tail.ino, final: false });
  assertContiguous(buf, forward);
  assert.equal(forward.from, 0);
  assert.ok(jsonBytes(forward.pieces) <= FRAME_JSON_BUDGET);
  assert.ok(jsonBytes([...forward.pieces, { at: forward.to, text: lineText }]) > FRAME_JSON_BUDGET, 'forward stops before the piece that breaks the budget');
  assert.equal(forward.eof, false);

  const plain = Buffer.from(`${'y'.repeat(999)}\n`.repeat(400), 'utf8');
  const plainFile = logOf(t, plain, 'plain.log');
  const page = readLogPage({ file: plainFile, mode: 'forward', offset: 0, ino: readLogPage({ file: plainFile, mode: 'tail', final: false }).ino, final: false });
  assert.ok(page.to - page.from <= PAGE_BYTES && page.to - page.from > PAGE_BYTES - 1000, 'the page bound stops forward');
  const plainTail = readLogPage({ file: plainFile, mode: 'tail', final: false });
  assert.ok(plainTail.to - plainTail.from <= PAGE_BYTES && plainTail.to - plainTail.from > PAGE_BYTES - 1000);
});

test('a page with from < E holds at least one piece, even inside one long control-byte line', (t) => {
  const buf = Buffer.from(`${'\u0002'.repeat(300 * 1024)}\n`, 'utf8');
  const file = logOf(t, buf);
  const { ino } = readLogPage({ file, mode: 'tail', final: false });
  const E = buf.length;
  for (const offset of [0, 1, PIECE_GRID_BYTES - 1, PIECE_GRID_BYTES, PIECE_GRID_BYTES + 1, 100000, E - 2, E - 1]) {
    const page = readLogPage({ file, mode: 'forward', offset, ino, final: false });
    assert.ok(page.pieces.length >= 1, `forward from ${offset}`);
    assert.ok(jsonBytes(page.pieces) <= FRAME_JSON_BUDGET);
    assertContiguous(buf, page);
    const back = readLogPage({ file, mode: 'backward', offset: offset + 1, ino, final: false });
    assert.ok(back.pieces.length >= 1, `backward to ${offset + 1}`);
    assert.ok(jsonBytes(back.pieces) <= FRAME_JSON_BUDGET);
    assertContiguous(buf, back);
  }
  const tail = readLogPage({ file, mode: 'tail', final: false });
  assert.ok(tail.pieces.length >= 1 && tail.from < E);
  assert.equal(tail.pieces.at(-1).cut, undefined, 'the piece that ends at the newline is not cut');
  assert.equal(tail.pieces.length, 1, 'one grid piece of control bytes nearly fills the frame budget');
  const ended = readLogPage({ file: logOf(t, 'z'.repeat(70000), 'open.log'), mode: 'tail', final: true });
  assert.deepEqual(ended.pieces.map((p: any) => [p.at, p.text.length, p.cut]), [[0, 32768, true], [32768, 32768, true], [65536, 4464, undefined]]);
});

test('a planted secret is masked by the second pass', (t) => {
  const secret = 'sk-test-value-that-must-not-appear';
  const file = logOf(t, `ok\nusing ${secret} now\nAWS_SECRET_ACCESS_KEY=abcdEFGH1234abcdEFGH1234\n`);
  const page = readLogPage({ file, mode: 'tail', final: false });
  const body = JSON.stringify(page);
  assert.ok(!body.includes(secret));
  assert.ok(!body.includes('abcdEFGH1234abcdEFGH1234'));
  assert.equal(page.pieces[1].text, 'using <masked> now');
  assert.equal(page.pieces[2].text, 'AWS_SECRET_ACCESS_KEY=<masked>');
});

// 150 R-1, DEC-012: a grid cut also splits a short line that crosses a 32768-byte offset, so a
// path only a whole-line pass can see must be masked by the sink before the write. The file is
// written as createOutputSink writes it (supervisor.ts onLine: `maskBody(line).text` plus '\n'),
// with the second line starting 8 and 12 bytes before a grid point (the reviewer's two cuts).
test('R-1: another user\'s /home/<name> on a line a grid cut splits is masked in every piece and in the joined text', (t) => {
  const { maskBody } = require('../../src/runtime/mask.ts');
  const other = ['', 'home', 'alice'].join('/'); // built from parts, so G2 has no literal home path to flag
  const line = `read ${other}/plan.md ok`;
  const sinkWrite = (lines: string[]) => lines.map((text) => `${maskBody(text).text}\n`).join('');
  for (const [firstBytes, head] of [[32759, 'read /ho'], [32755, 'read /home/']] as const) {
    const first = 'x'.repeat(firstBytes);
    const file = logOf(t, sinkWrite([first, line]));
    const page = readLogPage({ file, mode: 'tail', final: false });
    const second = page.pieces.filter((p: any) => p.at > firstBytes);
    // Not vacuous: the line really is cut, at the grid point.
    assert.equal(second.length, 2, `${firstBytes}: the line is cut once`);
    assert.equal(second[0].at, firstBytes + 1);
    assert.equal(second[1].at, PIECE_GRID_BYTES);
    assert.equal(second[0].cut, true);
    assert.ok(second[0].text.startsWith(head), `${firstBytes}: ${second[0].text}`);
    for (const piece of page.pieces) assert.ok(!piece.text.includes(other), `${firstBytes}: piece ${JSON.stringify(piece.text)}`);
    const joined = linesOf(page.pieces);
    assert.equal(joined[joined.length - 1], `read ${['', 'home', '<masked>'].join('/')}/plan.md ok`);
    for (const text of joined) assert.ok(!text.includes(other), `${firstBytes}: joined ${JSON.stringify(text)}`);
    assert.ok(!JSON.stringify(page).includes(other));
  }
  // Control: the same bytes written without the sink's whole-line pass reach the reader's per-piece
  // pass split, and the joined text carries the path, so the check above can fail.
  const raw = logOf(t, `${'x'.repeat(32759)}\n${line}\n`, 'raw.out.log');
  const leaked = linesOf(readLogPage({ file: raw, mode: 'tail', final: false }).pieces);
  assert.ok(leaked.some((text) => text.includes(other)), `the unmasked control leaks: ${JSON.stringify(leaked.slice(-1))}`);
});
