'use strict';

// A QR Code encoder and a terminal renderer for the pairing payload (feature 160, IC-003; design D10).
// ISO/IEC 18004 byte mode, error correction level M, versions 1-10 (at most 213 bytes), all eight masks
// scored with the four penalty rules and the lowest kept. Pure functions over bytes: no I/O, no
// dependency. The tests decode the matrix with a reader written separately (test/qr.test.ts).

type Matrix = { version: number, size: number, modules: boolean[][] };

// Level M per version: [error correction codewords per block, blocks of the first size, data codewords
// of those, blocks of the second size, data codewords of those]. Totals are the standard's: 26, 44, 70,
// 100, 134, 172, 196, 242, 292, 346.
const BLOCKS_M: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
];
const ALIGNMENT: ReadonlyArray<readonly number[]> = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];
const MAX_VERSION = BLOCKS_M.length;
const FORMAT_M = 0; // the two-bit indicator of level M

const sizeOf = (version: number) => 17 + 4 * version;
const dataCodewords = (version: number) => { const [, a, aData, b, bData] = BLOCKS_M[version - 1]; return a * aData + b * bData; };
const totalCodewords = (version: number) => { const [ec, a, aData, b, bData] = BLOCKS_M[version - 1]; return a * (aData + ec) + b * (bData + ec); };
const bit = (value: number, index: number) => ((value >>> index) & 1) === 1;

// ---- Reed-Solomon over GF(256), polynomial 0x11D ----

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i += 1) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
const multiply = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** The monic generator polynomial of `degree`, without its leading coefficient, highest power first. */
function divisorOf(degree: number): number[] {
  const result = Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = multiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = multiply(root, 2);
  }
  return result;
}

function remainderOf(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = Array(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coefficient, index) => { result[index] ^= multiply(coefficient, factor); });
  }
  return result;
}

// ---- the codeword stream ----

/** The data codewords of `bytes` at `version`: mode, count, bytes, terminator, padding. */
function dataStream(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, count: number) => { for (let i = count - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version >= 10 ? 16 : 8);
  for (const byte of bytes) push(byte, 8);
  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; words.length < dataCodewords(version); pad ^= 0xec ^ 0x11) words.push(pad);
  return words;
}

/** Data codewords split into blocks, each extended by its error correction, then interleaved. */
function interleave(data: readonly number[], version: number): number[] {
  const [ecLength, a, aData, b] = BLOCKS_M[version - 1];
  const divisor = divisorOf(ecLength);
  const blocks: { data: number[], ec: number[] }[] = [];
  let offset = 0;
  for (let index = 0; index < a + b; index += 1) {
    const length = index < a ? aData : aData + 1;
    const part = data.slice(offset, offset + length);
    offset += length;
    blocks.push({ data: part, ec: remainderOf(part, divisor) });
  }
  const out: number[] = [];
  for (let i = 0; i <= aData; i += 1) for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  for (let i = 0; i < ecLength; i += 1) for (const block of blocks) out.push(block.ec[i]);
  return out;
}

// ---- format and version information ----

/** BCH(15,5) format word for level M and `mask`, already XORed with 0x5412. */
function formatBits(mask: number): number {
  const data = (FORMAT_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** BCH(18,6) version word (versions 7 and up). */
function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

// ---- the matrix ----

const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

type Grid = { size: number, modules: boolean[][], isFunction: boolean[][] };

function drawFunctionModules(version: number): Grid {
  const size = sizeOf(version);
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => Array(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };
  for (let i = 0; i < size; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
    }
  }
  const centers = ALIGNMENT[version - 1];
  centers.forEach((cx, i) => centers.forEach((cy, j) => {
    const onFinder = (i === 0 && j === 0) || (i === 0 && j === centers.length - 1) || (i === centers.length - 1 && j === 0);
    if (onFinder) return;
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(bits, i));
      set(b, a, bit(bits, i));
    }
  }
  const drawn = { size, modules, isFunction };
  drawFormat(drawn, 0); // reserves the format area; redrawn per mask
  return drawn;
}

function drawFormat({ size, modules, isFunction }: Grid, mask: number): void {
  const bits = formatBits(mask);
  const set = (x: number, y: number, dark: boolean) => { modules[y][x] = dark; isFunction[y][x] = true; };
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(bits, i));
  set(8, 7, bit(bits, 6));
  set(8, 8, bit(bits, 7));
  set(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(bits, i));
  set(8, size - 8, true); // the one always-dark module
}

/** Places `codewords` in the zigzag over the modules that are not function modules. */
function placeData({ size, modules, isFunction }: Grid, codewords: readonly number[]): void {
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!isFunction[y][x] && index < codewords.length * 8) {
          modules[y][x] = bit(codewords[index >>> 3], 7 - (index & 7));
          index += 1;
        }
      }
    }
  }
}

function applyMask({ size, modules, isFunction }: Grid, mask: number): void {
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (!isFunction[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
}

const FINDER_LIKE = [[true, false, true, true, true, false, true, false, false, false, false], [false, false, false, false, true, false, true, true, true, false, true]];

/** The four penalty rules of the standard over a finished symbol. */
function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < size; i += 1) lines.push(modules[i], modules.map((row) => row[i]));
  for (const line of lines) {
    // Rule 1: five or more of one colour in a row, 3 + the excess.
    for (let start = 0, end = 0; start < size; start = end) {
      for (end = start + 1; end < size && line[end] === line[start]; end += 1);
      if (end - start >= 5) score += 3 + (end - start - 5);
    }
    // Rule 3: dark-light-dark-dark-dark-light-dark with four light modules on a side; the quiet zone is light.
    const padded = [false, false, false, false, ...line, false, false, false, false];
    for (let start = 0; start + 11 <= padded.length; start += 1) {
      if (FINDER_LIKE.some((pattern) => pattern.every((value, offset) => padded[start + offset] === value))) score += 40;
    }
  }
  // Rule 2: every 2x2 block of one colour.
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = modules[y][x];
      if (modules[y][x + 1] === color && modules[y + 1][x] === color && modules[y + 1][x + 1] === color) score += 3;
    }
  }
  // Rule 4: 10 per whole 5% the dark share is off 50%.
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/**
 * The symbol for `bytes`: the smallest version 1-10 that fits, level M. `options.mask` forces one mask
 * (tests); otherwise the lowest penalty wins, ties to the lower number. Throws when `bytes` needs more than version 10.
 */
function encode(bytes: Uint8Array, options: { mask?: number } = {}): Matrix {
  let version = 1;
  const need = (v: number) => 4 + (v >= 10 ? 16 : 8) + bytes.length * 8;
  while (version <= MAX_VERSION && need(version) > dataCodewords(version) * 8) version += 1;
  if (version > MAX_VERSION) throw new Error(`QR payload of ${bytes.length} bytes does not fit version ${MAX_VERSION} at level M (at most 213)`);
  const codewords = interleave(dataStream(bytes, version), version);
  const base = drawFunctionModules(version);
  placeData(base, codewords);
  const finish = (mask: number): Grid => {
    const copy: Grid = { size: base.size, modules: base.modules.map((row) => row.slice()), isFunction: base.isFunction.map((row) => row.slice()) };
    applyMask(copy, mask);
    drawFormat(copy, mask);
    return copy;
  };
  if (options.mask !== undefined) return { version, size: base.size, modules: finish(options.mask).modules };
  let best: Grid | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = finish(mask);
    const score = penalty(candidate.modules);
    if (score < bestScore) { best = candidate; bestScore = score; }
  }
  return { version, size: base.size, modules: (best as Grid).modules };
}

// ---- the terminal ----

const QUIET = 4;
const BLACK = 16;   // 256-colour cube black and white: explicit, so a theme cannot remap them
const WHITE = 231;

/**
 * The symbol as terminal text, `size + 8` columns wide with a four-module quiet zone, two module rows per
 * character row. `color`: `▀` cells with explicit black and white (top module as foreground, bottom as
 * background), so it reads the same in a light and a dark theme. Without colour: no escape codes, dark
 * modules as `█`, `▀`, `▄` on the terminal's own background, then a line saying to use the link.
 */
function render(matrix: Matrix, { color }: { color: boolean }): string {
  const total = matrix.size + 2 * QUIET;
  const dark = (x: number, y: number) => {
    const row = matrix.modules[y - QUIET];
    return row !== undefined && row[x - QUIET] === true;
  };
  const lines: string[] = [];
  for (let y = 0; y < total; y += 2) {
    let line = '';
    let last = '';
    for (let x = 0; x < total; x += 1) {
      const top = dark(x, y);
      const bottom = y + 1 < total && dark(x, y + 1);
      if (color) {
        const codes = `\x1b[38;5;${top ? BLACK : WHITE}m\x1b[48;5;${bottom ? BLACK : WHITE}m`;
        if (codes !== last) line += codes;
        last = codes;
        line += '▀';
      } else {
        line += top ? (bottom ? '█' : '▀') : (bottom ? '▄' : ' ');
      }
    }
    lines.push(color ? `${line}\x1b[0m` : line);
  }
  return `${lines.join('\n')}${color ? '' : '\n  (if it does not scan, use the link)'}`;
}

module.exports = { encode, render, formatBits, versionBits, penalty, divisorOf, remainderOf, totalCodewords, dataCodewords, MAX_VERSION };
