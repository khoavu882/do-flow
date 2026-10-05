'use strict';

// G23 — hidden Unicode. Shipped prose and code are read by models and by reviewers; a code point that
// renders as nothing (tag characters, zero-width characters, bidirectional controls, invisible
// operators) can carry instructions or reorder text that no reviewer sees. Every file under core/,
// src/, bin/ and docs/, and README.md, must hold none, and must decode as strict UTF-8 so an
// undecodable file cannot slip past unscanned. test/ and bench/ are not scanned: test/ holds
// deliberate bidirectional fixtures. This file builds every fixture character with
// String.fromCodePoint and names code points only in escapes, so it does not flag itself.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');

const SCAN_ROOTS = ['core', 'src', 'bin', 'docs'];
const SCAN_FILES = ['README.md'];
const OS_METADATA = new Set(['.DS_Store']);

const HIDDEN_CODE_POINTS = [
  { from: 0xE0000, to: 0xE007F, cls: 'tag character' },
  { from: 0x200B, to: 0x200D, cls: 'zero-width' },
  { from: 0x2060, to: 0x2060, cls: 'zero-width' },
  { from: 0xFEFF, to: 0xFEFF, cls: 'zero-width' },
  { from: 0x202A, to: 0x202E, cls: 'bidirectional control' },
  { from: 0x2066, to: 0x2069, cls: 'bidirectional control' },
  { from: 0x200E, to: 0x200F, cls: 'bidirectional mark' },
  { from: 0x061C, to: 0x061C, cls: 'bidirectional mark' },
  { from: 0x2061, to: 0x2064, cls: 'invisible operator' },
];

const ZWJ = 0x200D;
const VARIATION_SELECTOR_16 = 0xFE0F;
const HIDDEN_RE = new RegExp(
  `[${HIDDEN_CODE_POINTS.map(({ from, to }) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join('')}]`, 'u');
const PICTOGRAPHIC_RE = /^\p{Extended_Pictographic}$/u;

const hex = (codePoint) => codePoint.toString(16).toUpperCase().padStart(4, '0');
const classOf = (codePoint) => HIDDEN_CODE_POINTS.find(({ from, to }) => codePoint >= from && codePoint <= to)?.cls;

/** Whether the ZWJ at `at` joins two pictographs (an emoji ZWJ sequence), skipping U+FE0F on both sides. */
function joinsPictographs(codePoints, at) {
  let before = at - 1;
  while (before >= 0 && codePoints[before].codePointAt(0) === VARIATION_SELECTOR_16) before -= 1;
  let after = at + 1;
  while (after < codePoints.length && codePoints[after].codePointAt(0) === VARIATION_SELECTOR_16) after += 1;
  return before >= 0 && after < codePoints.length
    && PICTOGRAPHIC_RE.test(codePoints[before]) && PICTOGRAPHIC_RE.test(codePoints[after]);
}

/** Hidden code points in `text`, positioned by line and code-point column, both counted from 1. */
function scanText(rel, text) {
  if (!HIDDEN_RE.test(text)) return [];
  const codePoints = Array.from(text);
  const findings = [];
  let line = 1;
  let column = 0;
  codePoints.forEach((char, at) => {
    column += 1;
    if (char === '\n') { line += 1; column = 0; return; }
    const codePoint = char.codePointAt(0);
    const cls = classOf(codePoint);
    if (!cls) return;
    if (codePoint === ZWJ && joinsPictographs(codePoints, at)) return;
    findings.push({ rel, line, column, codePoint, cls });
  });
  return findings;
}

const describe = ({ rel, line, column, codePoint, cls }) => `${rel}:${line}:${column} U+${hex(codePoint)} ${cls}`;

/** Findings for one file's bytes: the hidden code points, or a single not-valid-UTF-8 finding. */
function scanBuffer(rel, buffer) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return [`${rel}: not valid UTF-8, not scanned`];
  }
  return scanText(rel, text).map(describe);
}

/** Every file under `dir`, OS metadata aside. */
function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return OS_METADATA.has(entry.name) ? [] : [full];
  });
}

test('G23: no file under core/, src/, bin/, docs/ or README.md holds a hidden code point', (t) => {
  const started = process.hrtime.bigint();
  const perRoot = new Map();
  const findings = [];
  for (const full of [...SCAN_ROOTS.flatMap((root) => filesUnder(path.join(REPO, root))),
    ...SCAN_FILES.map((file) => path.join(REPO, file))]) {
    const rel = path.relative(REPO, full).split(path.sep).join('/');
    const top = SCAN_FILES.includes(rel) ? rel : rel.split('/')[0];
    perRoot.set(top, (perRoot.get(top) || 0) + 1);
    findings.push(...scanBuffer(rel, fs.readFileSync(full)));
  }

  const empty = [...SCAN_ROOTS, ...SCAN_FILES].filter((entry) => !perRoot.get(entry));
  assert.deepEqual(empty, [], `scan roots that held no file; the scan below would measure nothing: ${empty.join(', ')}`);
  const files = [...perRoot.values()].reduce((a, b) => a + b, 0);
  t.diagnostic(`hidden unicode: ${files} files scanned (${[...perRoot].map(([root, n]) => `${root} ${n}`).join(', ')}) `
    + `in ${Math.round(Number(process.hrtime.bigint() - started) / 1e6)} ms`);
  assert.deepEqual(findings.sort(), [],
    `hidden code points or undecodable files (position is line:column in code points):\n  ${findings.join('\n  ')}`);
});

test('G23: every asset source lies under a scanned root', () => {
  const { assets } = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'assets.json'), 'utf8'));
  assert.ok(assets.length > 0, 'no assets parsed; the coverage check would measure nothing');
  const outside = assets.filter(({ source }) => !/^(core|src|bin)(\/|$)/.test(source))
    .map(({ id, source }) => `asset ${id} source ${source} is outside the scanned roots`);
  assert.deepEqual(outside, [], outside.join('\n'));
});

test('G23: controls — the scan sees hidden code points, exempts emoji joins and refuses invalid UTF-8', () => {
  const chars = [0xE0041, 0x202E, 0x200B, 0x2066].map((codePoint) => String.fromCodePoint(codePoint));
  const hidden = scanText('fixture.md', chars.map((char, i) => `a${char}b${i}`).join('\n'));
  assert.deepEqual(hidden.map(({ line, column, codePoint }) => [line, column, codePoint]),
    [[1, 2, 0xE0041], [2, 2, 0x202E], [3, 2, 0x200B], [4, 2, 0x2066]]);
  assert.deepEqual(hidden.map(({ cls }) => cls),
    ['tag character', 'bidirectional control', 'zero-width', 'bidirectional control']);
  assert.equal(describe(hidden[0]), 'fixture.md:1:2 U+E0041 tag character');

  const joined = String.fromCodePoint(0x1F469, ZWJ, 0x1F4BB);
  assert.deepEqual(scanText('fixture.md', joined), []);
  assert.deepEqual(scanText('fixture.md', String.fromCodePoint(0x2764, VARIATION_SELECTOR_16, ZWJ, 0x1F525)), []);

  const between = scanText('fixture.md', `a${String.fromCodePoint(ZWJ)}b`);
  assert.equal(between.length, 1);
  assert.equal(between[0].codePoint, ZWJ);

  assert.deepEqual(scanBuffer('bad.md', Buffer.from([0xC3, 0x28])), ['bad.md: not valid UTF-8, not scanned']);
  assert.deepEqual(scanBuffer('ok.md', Buffer.from('plain text', 'utf8')), []);
});
