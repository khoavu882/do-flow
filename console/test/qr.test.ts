'use strict';

// The QR encoder and renderer (feature 160, IC-003; design D10, risk R6). Nothing here reuses the
// encoder to check itself: the format and version words are the standard's literal values (and a
// separate BCH division), the Reed-Solomon check is a syndrome over a field built again in this file, and
// the matrix is decoded by a reader written below from the standard's layout, not from qr.ts.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { encode, render, formatBits, versionBits, penalty, divisorOf, remainderOf, totalCodewords, MAX_VERSION } = require('../src/qr.ts');

// ---- literal values of the standard ----

const FORMAT_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
const VERSION_WORDS: Record<number, number> = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };
const TOTALS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const CAPACITY = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]; // bytes, level M
// Level M: error correction codewords per block, then the data length of every block in order.
const LAYOUT: Array<[number, number[]]> = [
  [10, [16]], [16, [28]], [26, [44]], [18, [32, 32]], [24, [43, 43]], [16, [27, 27, 27, 27]], [18, [31, 31, 31, 31]],
  [22, [38, 38, 39, 39]], [22, [36, 36, 36, 37, 37]], [26, [43, 43, 43, 43, 44]],
];

/** Remainder of `value` (shifted left by `degree` bits) divided by `poly`, plain binary long division. */
function bch(value: number, poly: number, degree: number): number {
  let rem = value << degree;
  const top = (n: number) => 31 - Math.clz32(n);
  while (rem !== 0 && top(rem) >= top(poly)) rem ^= poly << (top(rem) - top(poly));
  return rem;
}

test('format words for ECC M, masks 0-7, equal the standard and a separate BCH division', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(formatBits), FORMAT_M);
  FORMAT_M.forEach((word, mask) => {
    const data = (0 << 3) | mask;
    assert.equal(((data << 10) | bch(data, 0x537, 10)) ^ 0x5412, word);
  });
});

test('version words for versions 7-10 equal the standard and a separate BCH division', () => {
  for (const version of [7, 8, 9, 10]) {
    assert.equal(versionBits(version), VERSION_WORDS[version]);
    assert.equal((version << 12) | bch(version, 0x1f25, 12), VERSION_WORDS[version]);
  }
});

test('Reed-Solomon matches the published HELLO WORLD 1-M codewords', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(remainderOf(data, divisorOf(10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('codeword totals per version and the byte capacity at level M', () => {
  assert.equal(MAX_VERSION, 10);
  TOTALS.forEach((total, index) => assert.equal(totalCodewords(index + 1), total));
  CAPACITY.forEach((capacity, index) => {
    assert.equal(encode(new Uint8Array(capacity)).version, index + 1, `${capacity} bytes`);
    if (index + 1 < MAX_VERSION) assert.equal(encode(new Uint8Array(capacity + 1)).version, index + 2, `${capacity + 1} bytes`);
  });
  assert.throws(() => encode(new Uint8Array(214)), /does not fit version 10/);
});

// ---- the independent reader ----

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) { EXP[i] = x; LOG[x] = i; x = (x * 2) ^ (x >= 128 ? 0x11d : 0); }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}
const gmul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** True for the modules the standard reserves: finders, timing, alignment, format, version. */
function reservedMap(version: number, size: number): boolean[][] {
  const map = Array.from({ length: size }, () => Array(size).fill(false));
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) map[y][x] = true;
  };
  fill(0, 0, 8, 8); fill(size - 8, 0, size - 1, 8); fill(0, size - 8, 8, size - 1);
  fill(6, 0, 6, size - 1); fill(0, 6, size - 1, 6);
  if (version >= 2) {
    const n = Math.floor(version / 7) + 2;
    const interval = Math.floor((version * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
    const centers = [6];
    for (let c = size - 7, k = 0; k < n - 1; c -= interval, k += 1) centers.splice(1, 0, c);
    for (const cx of centers) {
      for (const cy of centers) {
        const nearFinder = (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6);
        if (!nearFinder) fill(cx - 2, cy - 2, cx + 2, cy + 2);
      }
    }
  }
  if (version >= 7) { fill(size - 11, 0, size - 9, 5); fill(0, size - 11, 5, size - 9); }
  return map;
}

/** The mask number written in the two format copies, which must agree and carry level M. */
function readFormat(modules: boolean[][], size: number): number {
  const at = (x: number, y: number) => (modules[y][x] ? 1 : 0);
  let first = 0;
  let second = 0;
  for (let i = 0; i < 15; i += 1) {
    const [x1, y1] = i <= 5 ? [8, i] : i === 6 ? [8, 7] : i === 7 ? [8, 8] : i === 8 ? [7, 8] : [14 - i, 8];
    const [x2, y2] = i < 8 ? [size - 1 - i, 8] : [8, size - 15 + i];
    first |= at(x1, y1) << i;
    second |= at(x2, y2) << i;
  }
  assert.equal(first, second, 'the two format copies differ');
  const mask = FORMAT_M.indexOf(first);
  assert.notEqual(mask, -1, `format word ${first.toString(16)} is not level M`);
  return mask;
}

const MASK_TESTS = [
  (r: number, c: number) => (r + c) % 2 === 0,
  (r: number) => r % 2 === 0,
  (_r: number, c: number) => c % 3 === 0,
  (r: number, c: number) => (r + c) % 3 === 0,
  (r: number, c: number) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r: number, c: number) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r: number, c: number) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r: number, c: number) => ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0,
];

/** Decodes a matrix to its byte-mode payload, asserting the symbol's structure on the way. */
function decode(matrix: { version: number, size: number, modules: boolean[][] }): { mask: number, bytes: Buffer } {
  const { version, size, modules } = matrix;
  assert.equal(size, 17 + 4 * version);
  const reserved = reservedMap(version, size);
  const mask = readFormat(modules, size);
  // Zigzag from the bottom right in two-column strips, skipping the timing column, reading unmasked bits.
  const bits: number[] = [];
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        bits.push(modules[row][c] !== MASK_TESTS[mask](row, c) ? 1 : 0);
      }
    }
    upward = !upward;
  }
  const remainder = bits.length - TOTALS[version - 1] * 8;
  assert.equal(remainder, [0, 7, 7, 7, 7, 7, 0, 0, 0, 0][version - 1], 'remainder bits');
  const words: number[] = [];
  for (let i = 0; i < TOTALS[version - 1] * 8; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  // De-interleave into blocks, then check every block's syndromes are zero.
  const [ecLength, lengths] = LAYOUT[version - 1];
  const blocks: number[][] = lengths.map(() => []);
  let cursor = 0;
  for (let i = 0; i < Math.max(...lengths); i += 1) lengths.forEach((length, b) => { if (i < length) blocks[b].push(words[cursor++]); });
  const ecBlocks: number[][] = lengths.map(() => []);
  for (let i = 0; i < ecLength; i += 1) lengths.forEach((_, b) => ecBlocks[b].push(words[cursor++]));
  assert.equal(cursor, words.length);
  blocks.forEach((data, b) => {
    const codeword = [...data, ...ecBlocks[b]];
    for (let root = 0; root < ecLength; root += 1) {
      let syndrome = 0;
      for (const value of codeword) syndrome = gmul(syndrome, EXP[root]) ^ value;
      assert.equal(syndrome, 0, `block ${b} syndrome ${root}`);
    }
  });
  const stream = blocks.flat();
  let position = 0;
  const take = (count: number) => { let out = 0; for (let i = 0; i < count; i += 1) { const byte = stream[position >>> 3]; out = (out << 1) | ((byte >>> (7 - (position & 7))) & 1); position += 1; } return out; };
  assert.equal(take(4), 0b0100, 'byte mode');
  const length = take(version >= 10 ? 16 : 8);
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) out[i] = take(8);
  // The terminator, bit padding and 0xEC/0x11 pad bytes follow.
  const dataBits = lengths.reduce((a, b) => a + b, 0) * 8;
  const tail = Math.min(4, dataBits - position);
  assert.equal(take(tail), 0, 'terminator');
  position += (8 - (position & 7)) & 7;
  for (let pad = 0xec; position < dataBits; pad = pad === 0xec ? 0x11 : 0xec) assert.equal(take(8), pad, 'pad byte');
  return { mask, bytes: out };
}

function sampleBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = 12345 + length;
  for (let i = 0; i < length; i += 1) { state = (state * 1103515245 + 12345) & 0x7fffffff; out[i] = (state >>> 16) & 0xff; }
  if (length > 2) { out[0] = 0; out[1] = 255; }
  return out;
}

test('the reader recovers the exact payload bytes for lengths 1, 50, 134 and 213', () => {
  for (const length of [1, 50, 134, 213]) {
    const bytes = sampleBytes(length);
    const matrix = encode(bytes);
    const { bytes: decoded } = decode(matrix);
    assert.deepEqual(new Uint8Array(decoded), bytes, `${length} bytes at version ${matrix.version}`);
  }
});

test('every mask decodes, and the chosen mask has the lowest penalty', () => {
  const bytes = sampleBytes(134);
  assert.equal(encode(bytes).version, 8);
  const scores: number[] = [];
  for (let mask = 0; mask < 8; mask += 1) {
    const forced = encode(bytes, { mask });
    const { mask: read, bytes: decoded } = decode(forced);
    assert.equal(read, mask);
    assert.deepEqual(new Uint8Array(decoded), bytes);
    scores.push(penalty(forced.modules));
  }
  const chosen = decode(encode(bytes)).mask;
  assert.equal(chosen, scores.indexOf(Math.min(...scores)), 'the lowest score wins, ties to the lower mask');
});

test('every version 1-10 decodes at its smallest and largest payload', () => {
  CAPACITY.forEach((capacity, index) => {
    for (const length of [index === 0 ? 1 : CAPACITY[index - 1] + 1, capacity]) {
      const bytes = sampleBytes(length);
      const matrix = encode(bytes);
      assert.equal(matrix.version, index + 1);
      assert.deepEqual(new Uint8Array(decode(matrix).bytes), bytes, `${length} bytes`);
    }
  });
});

test('the fixed patterns are where the standard puts them', () => {
  const { size, modules } = encode(sampleBytes(134));
  const ring = (cx: number, cy: number) => { // a 7x7 finder: dark ring, light ring, dark 3x3
    for (let dy = -3; dy <= 3; dy += 1) for (let dx = -3; dx <= 3; dx += 1) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      assert.equal(modules[cy + dy][cx + dx], d !== 2, `finder at ${cx},${cy} offset ${dx},${dy}`);
    }
  };
  ring(3, 3); ring(size - 4, 3); ring(3, size - 4);
  for (let i = 8; i < size - 8; i += 1) { assert.equal(modules[6][i], i % 2 === 0); assert.equal(modules[i][6], i % 2 === 0); }
  assert.equal(modules[size - 8][8], true, 'the dark module');
});

// ---- the terminal ----

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

/** The module grid (quiet zone included) a colour render shows: each cell's foreground is its top row. */
function readColor(text: string): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of text.split('\n')) {
    let fg = 231;
    let bg = 231;
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      const code = /^\x1b\[(38|48);5;(\d+)m$/.exec(part);
      if (code) { if (code[1] === '38') fg = Number(code[2]); else bg = Number(code[2]); } else if (part !== '' && !/^\x1b\[0m$/.test(part)) {
        for (const ch of part) { assert.equal(ch, '▀'); top.push(fg === 16); bottom.push(bg === 16); }
      }
    }
    rows.push(top, bottom);
  }
  return rows;
}

test('the colour render is size + 8 columns, two module rows per line, and reads back to the matrix', () => {
  const matrix = encode(sampleBytes(134));
  const text = render(matrix, { color: true });
  const lines = text.split('\n');
  assert.equal(matrix.size, 49);
  assert.equal(lines.length, 29);
  for (const line of lines) assert.equal([...strip(line)].length, 57);
  assert.match(text, /\x1b\[38;5;16m/);
  assert.match(text, /\x1b\[48;5;231m/);
  const grid = readColor(text);
  for (let y = 0; y < 57; y += 1) for (let x = 0; x < 57; x += 1) {
    const inside = y >= 4 && y < 53 && x >= 4 && x < 53;
    assert.equal(grid[y][x], inside ? matrix.modules[y - 4][x - 4] : false, `module ${x},${y}`);
  }
  assert.equal(text.endsWith('\x1b[0m'), true);
  assert.equal(text.includes('use the link'), false);
});

test('without colour there is no escape code, block characters on the terminal background, and a hint line', () => {
  const matrix = encode(sampleBytes(134));
  const text = render(matrix, { color: false });
  assert.equal(text.includes('\x1b'), false);
  const lines = text.split('\n');
  assert.equal(lines.pop(), '  (if it does not scan, use the link)');
  assert.equal(lines.length, 29);
  for (const line of lines) { assert.equal([...line].length, 57); assert.match(line, /^[ █▀▄]+$/); }
  lines.forEach((line, row) => [...line].forEach((ch, x) => {
    const at = (y: number) => y >= 4 && y < 53 && x >= 4 && x < 53 && matrix.modules[y - 4][x - 4];
    assert.equal(ch, at(row * 2) ? (at(row * 2 + 1) ? '█' : '▀') : (at(row * 2 + 1) ? '▄' : ' '));
  }));
});

test('qr.ts requires nothing but node:crypto and node:buffer (NFR-005)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'qr.ts'), 'utf8');
  const modules = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
  for (const name of modules) assert.equal(['node:crypto', 'node:buffer'].includes(name), true, name);
});
