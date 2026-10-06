'use strict';

// G23 — hidden Unicode. Shipped prose and code are read by models and by reviewers; a code point that
// renders as nothing (tag characters, zero-width characters, bidirectional controls, invisible
// operators) can carry instructions or reorder text that no reviewer sees. Every file under core/,
// src/, bin/ and docs/, and README.md, must hold none, and must decode as strict UTF-8 so an
// undecodable file cannot slip past unscanned. The scan reads the files git tracks (the working-tree
// walk is the fallback when git cannot list them), so an ignored or untracked artifact never fails
// it; a tracked file holding a NUL byte is binary and a symlink is not a file of its own, and
// both are skipped. test/ and bench/ are not scanned: test/ holds deliberate bidirectional
// fixtures. This file builds every fixture character with String.fromCodePoint and names code
// points only in escapes, so it does not flag itself.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { REPO } = require('./_shared');

const SCAN_ROOTS = ['core', 'src', 'bin', 'docs'];
const SCAN_FILES = ['README.md'];

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

/** Findings for one file's bytes: the hidden code points, or a single not-valid-UTF-8 finding. A
 * buffer holding a NUL byte is binary (an image, a compiled file) and has no text to scan. */
function scanBuffer(rel, buffer) {
  if (buffer.includes(0)) return [];
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return [`${rel}: not valid UTF-8, not scanned`];
  }
  return scanText(rel, text).map(describe);
}

/** Every regular file under `dir` (repo-relative, forward slashes); a symlink, dangling or not, is not one. */
function filesUnder(root, dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return filesUnder(root, rel);
    return entry.isFile() ? [rel] : [];
  });
}

function gitTracked(root) {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...SCAN_ROOTS, ...SCAN_FILES], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' },
  });
  return out.split('\0').filter(Boolean);
}

/** The files to scan under `root`: what git tracks there, or the working-tree walk when git cannot say. */
function scanTargets(root, listTracked = gitTracked) {
  try {
    const rels = listTracked(root);
    if (rels.length) return { rels, source: 'git' };
  } catch { /* no git, or not a repository: walk instead */ }
  const walked = SCAN_ROOTS.filter((dir) => fs.existsSync(path.join(root, dir))).flatMap((dir) => filesUnder(root, dir));
  return { rels: [...walked, ...SCAN_FILES.filter((file) => fs.existsSync(path.join(root, file)))], source: 'walk' };
}

/** A file's bytes, or null when it is not a regular file (a symlink, a directory, a path that vanished). */
function readRegularFile(full) {
  try {
    return fs.lstatSync(full).isFile() ? fs.readFileSync(full) : null;
  } catch {
    return null;
  }
}

/** Asset sources outside the scanned roots, as failure messages. */
function outsideRoots(assets) {
  return assets.filter(({ source }) => !/^(core|src|bin)(\/|$)/.test(source))
    .map(({ id, source }) => `asset ${id} source ${source} is outside the scanned roots`);
}

test('G23: no file under core/, src/, bin/, docs/ or README.md holds a hidden code point', (t) => {
  const started = process.hrtime.bigint();
  const perRoot = new Map();
  const findings = [];
  const skipped = { binary: 0, notRegular: 0 };
  const { rels, source } = scanTargets(REPO);
  for (const rel of rels) {
    const buffer = readRegularFile(path.join(REPO, rel));
    if (!buffer) { skipped.notRegular += 1; continue; }
    if (buffer.includes(0)) { skipped.binary += 1; continue; }
    const top = SCAN_FILES.includes(rel) ? rel : rel.split('/')[0];
    perRoot.set(top, (perRoot.get(top) || 0) + 1);
    findings.push(...scanBuffer(rel, buffer));
  }

  const empty = [...SCAN_ROOTS, ...SCAN_FILES].filter((entry) => !perRoot.get(entry));
  assert.deepEqual(empty, [], `scan roots that held no file; the scan below would measure nothing: ${empty.join(', ')}`);
  const files = [...perRoot.values()].reduce((a, b) => a + b, 0);
  t.diagnostic(`hidden unicode: ${files} ${source} files scanned (${[...perRoot].map(([root, n]) => `${root} ${n}`).join(', ')}); `
    + `skipped ${skipped.binary} binary, ${skipped.notRegular} not regular; in ${Math.round(Number(process.hrtime.bigint() - started) / 1e6)} ms`);
  assert.deepEqual(findings.sort(), [],
    `hidden code points or undecodable files (position is line:column in code points):\n  ${findings.join('\n  ')}`);
});

test('G23: every asset source lies under a scanned root', () => {
  const { assets } = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'assets.json'), 'utf8'));
  assert.ok(assets.length > 0, 'no assets parsed; the coverage check would measure nothing');
  const outside = outsideRoots(assets);
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

test('G23: controls — binary files, symlinks and untracked files do not fail the scan; sources outside the roots do', (t) => {
  assert.deepEqual(scanBuffer('image.png', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xC3, 0x28])), [],
    'a binary file is skipped, not reported as undecodable');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-g23-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'a.md'), 'plain');
  fs.writeFileSync(path.join(root, 'docs', 'sub', 'b.md'), 'plain');
  fs.writeFileSync(path.join(root, 'README.md'), 'plain');
  let linked = true;
  try {
    fs.symlinkSync(path.join(root, 'no-such-target'), path.join(root, 'docs', 'dangling.md'));
    fs.symlinkSync(path.join(root, 'docs', 'sub'), path.join(root, 'docs', 'dir-link'));
    fs.symlinkSync(path.join(root, 'docs', 'a.md'), path.join(root, 'docs', 'file-link.md'));
  } catch { linked = false; }

  assert.deepEqual(scanTargets(root, () => { throw new Error('no git'); }),
    { rels: ['docs/a.md', 'docs/sub/b.md', 'README.md'], source: 'walk' }, 'the walk fallback lists regular files only');
  assert.equal(scanTargets(root, () => []).source, 'walk', 'an empty git listing falls back to the walk');
  assert.deepEqual(scanTargets(root, () => ['docs/a.md']), { rels: ['docs/a.md'], source: 'git' }, 'only tracked files are scanned');
  if (linked) {
    for (const name of ['dangling.md', 'dir-link', 'file-link.md']) {
      assert.equal(readRegularFile(path.join(root, 'docs', name)), null, `${name} is not a regular file`);
    }
  }
  assert.equal(readRegularFile(path.join(root, 'docs', 'gone.md')), null, 'a tracked path missing from the tree is skipped');
  assert.deepEqual(readRegularFile(path.join(root, 'docs', 'a.md')), Buffer.from('plain'));
  assert.ok(scanTargets(REPO).rels.includes('README.md'), 'the repository scan lists README.md');

  assert.deepEqual(outsideRoots([{ id: 'x.tests', source: 'test/fixtures' }, { id: 'y', source: 'core/shared' }]),
    ['asset x.tests source test/fixtures is outside the scanned roots']);
});
