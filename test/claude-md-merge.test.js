'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mergeMarkedSection, MARKER_START, MARKER_END } = require('../src/claude-md-merge');

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-claudemd-'));
}

function writeSrc(dir, content) {
  const p = path.join(dir, 'src.md');
  fs.writeFileSync(p, content);
  return p;
}

function dstPath(dir) {
  return path.join(dir, 'dst', 'CLAUDE.md');
}

test('marker constants match the exact literal contract strings', () => {
  assert.strictEqual(
    MARKER_START,
    '<!-- doflow:start — content below is managed by doflow install/update; edits here are overwritten on the next run -->'
  );
  assert.strictEqual(MARKER_END, '<!-- doflow:end -->');
});

test('create-when-missing: dst is created containing exactly the computed section', () => {
  const dir = scratchDir();
  const srcContent = 'Content of the file.\n\n\n'; // trailing whitespace to prove trimming
  const src = writeSrc(dir, srcContent);
  const dst = dstPath(dir);

  const result = mergeMarkedSection(src, dst);

  assert.strictEqual(result.changed, true);
  const expected = MARKER_START + '\n' + 'Content of the file.' + '\n' + MARKER_END + '\n';
  assert.strictEqual(fs.readFileSync(dst, 'utf8'), expected);
});

test('append: dst exists with no markers, no trailing newline -> separator is exactly "\\n\\n"', () => {
  const dir = scratchDir();
  const src = writeSrc(dir, 'Section body text.');
  const dst = dstPath(dir);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const existing = '# Existing File\n\nSome unrelated content, no trailing newline.';
  fs.writeFileSync(dst, existing);

  const result = mergeMarkedSection(src, dst);

  assert.strictEqual(result.changed, true);
  const section = MARKER_START + '\n' + 'Section body text.' + '\n' + MARKER_END + '\n';
  const expected = existing + '\n\n' + section;
  const actual = fs.readFileSync(dst, 'utf8');
  assert.strictEqual(actual, expected);
  assert.ok(actual.startsWith(existing), 'existing bytes must be preserved byte-for-byte at the start');
});

test('append: dst exists with no markers, ends with exactly ONE trailing newline -> one more "\\n" added', () => {
  const dir = scratchDir();
  const src = writeSrc(dir, 'Section body text.');
  const dst = dstPath(dir);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const existing = '# Existing File\n\nUnrelated content.\n'; // exactly one trailing \n
  fs.writeFileSync(dst, existing);

  const result = mergeMarkedSection(src, dst);

  assert.strictEqual(result.changed, true);
  const section = MARKER_START + '\n' + 'Section body text.' + '\n' + MARKER_END + '\n';
  const expected = existing + '\n' + section; // total: one blank line separates existing from section
  const actual = fs.readFileSync(dst, 'utf8');
  assert.strictEqual(actual, expected);
  assert.ok(actual.startsWith(existing), 'existing bytes must be preserved byte-for-byte at the start');
});

test('append: dst exists with no markers, ends with TWO+ trailing newlines -> no extra separator bytes added', () => {
  const dir = scratchDir();
  const src = writeSrc(dir, 'Section body text.');
  const dst = dstPath(dir);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const existing = '# Existing File\n\nUnrelated content.\n\n'; // already has a blank line
  fs.writeFileSync(dst, existing);

  const result = mergeMarkedSection(src, dst);

  assert.strictEqual(result.changed, true);
  const section = MARKER_START + '\n' + 'Section body text.' + '\n' + MARKER_END + '\n';
  const expected = existing + section; // no separator bytes inserted at all
  const actual = fs.readFileSync(dst, 'utf8');
  assert.strictEqual(actual, expected);
  assert.ok(!actual.includes('\n\n\n\n'), 'must not produce a triple-blank-line duplication');
});

test('append: dst exists with no markers, ends with THREE trailing newlines -> still no extra separator bytes added', () => {
  const dir = scratchDir();
  const src = writeSrc(dir, 'Section body text.');
  const dst = dstPath(dir);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const existing = '# Existing File\n\nUnrelated content.\n\n\n'; // three trailing newlines
  fs.writeFileSync(dst, existing);

  const result = mergeMarkedSection(src, dst);

  assert.strictEqual(result.changed, true);
  const section = MARKER_START + '\n' + 'Section body text.' + '\n' + MARKER_END + '\n';
  const expected = existing + section;
  const actual = fs.readFileSync(dst, 'utf8');
  assert.strictEqual(actual, expected);
});

test('replace: existing marker span is replaced in place; content before and after the span is untouched', () => {
  const dir = scratchDir();
  const dst = dstPath(dir);
  fs.mkdirSync(path.dirname(dst), { recursive: true });

  const before = '# My File\n\nSome intro text.\n\n';
  // oldSpan includes its own trailing "\n" — matching how doflow itself always writes a span
  // (section always ends in exactly one "\n"). That single newline is considered part of the
  // span's own canonical form, not "content after it" — required for idempotency (see the
  // dedicated idempotency test): a span with nothing after it but that one "\n" must read back
  // as byte-identical when replaced with unchanged source, not grow by a newline each time.
  const oldSpan = MARKER_START + '\n' + 'OLD SECTION CONTENT HERE' + '\n' + MARKER_END + '\n';
  const after = '## After\n\nMore text after the managed span.\n';
  const dstOriginal = before + oldSpan + after;
  fs.writeFileSync(dst, dstOriginal);

  const src = writeSrc(dir, 'NEW SECTION CONTENT  \n\n'); // trailing whitespace to prove trimming still applies
  const result = mergeMarkedSection(src, dst);

  assert.strictEqual(result.changed, true);
  const newSection = MARKER_START + '\n' + 'NEW SECTION CONTENT' + '\n' + MARKER_END + '\n';
  const expected = before + newSection + after;
  const actual = fs.readFileSync(dst, 'utf8');

  assert.strictEqual(actual, expected);
  assert.ok(actual.startsWith(before), 'bytes before the span must be byte-identical to before');
  assert.ok(actual.endsWith(after), 'bytes after the span must be byte-identical to before');
  assert.ok(!actual.includes('OLD SECTION CONTENT HERE'), 'old section content must be gone');
});

test('idempotency: calling twice with unchanged src/dst performs no second write (bytes and mtime unchanged)', () => {
  const dir = scratchDir();
  const src = writeSrc(dir, 'Stable content.');
  const dst = dstPath(dir);

  const first = mergeMarkedSection(src, dst);
  assert.strictEqual(first.changed, true);

  const bytesAfterFirst = fs.readFileSync(dst, 'utf8');
  // Force mtime to a known, distinguishable-from-"now" value so we can prove no write touched it.
  const forcedMtime = new Date('2001-01-01T00:00:00Z');
  fs.utimesSync(dst, forcedMtime, forcedMtime);
  const mtimeMsBeforeSecondCall = fs.statSync(dst).mtimeMs;

  const second = mergeMarkedSection(src, dst);

  assert.strictEqual(second.changed, false);
  assert.strictEqual(fs.readFileSync(dst, 'utf8'), bytesAfterFirst, 'dst bytes must be unchanged after a no-op call');
  assert.strictEqual(
    fs.statSync(dst).mtimeMs,
    mtimeMsBeforeSecondCall,
    'dst mtime must be unchanged after a no-op call — proves no write happened at all'
  );
});

test('malformed markers: MARKER_START present with no MARKER_END anywhere after it throws', () => {
  const dir = scratchDir();
  const src = writeSrc(dir, 'New content.');
  const dst = dstPath(dir);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, 'prefix\n' + MARKER_START + '\nno end marker anywhere in this file\n');

  assert.throws(() => mergeMarkedSection(src, dst));
});

test('duplicate MARKER_START: dst containing MARKER_START twice throws', () => {
  const dir = scratchDir();
  const src = writeSrc(dir, 'New content.');
  const dst = dstPath(dir);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const dstContent =
    MARKER_START + '\n' + 'first' + '\n' + MARKER_END + '\n' +
    MARKER_START + '\n' + 'second' + '\n' + MARKER_END + '\n';
  fs.writeFileSync(dst, dstContent);

  assert.throws(() => mergeMarkedSection(src, dst));
});

// Regression: the duplicate-marker check used to search for a second MARKER_START starting from
// *inside* the current span (right after its own opening), not after the span closes. That meant
// a span whose own content happened to mention the marker text (source content documenting this
// exact mechanism, or a copy-pasted example) was misdiagnosed as "duplicate marker" and blocked
// forever, even though there is genuinely only one real span.
test('self-reference: source content that itself contains the marker text does not false-positive as a duplicate', () => {
  const dir = scratchDir();
  const src = writeSrc(dir, `This project wraps managed content in ${MARKER_START} markers.`);
  const dst = dstPath(dir);

  const first = mergeMarkedSection(src, dst);
  assert.strictEqual(first.changed, true);

  // A second call with the same (self-referencing) source must be a clean no-op, not a throw.
  const second = mergeMarkedSection(src, dst);
  assert.strictEqual(second.changed, false);
});

test('dryRun: dst does not exist -> reports changed:true but creates nothing', () => {
  const dir = scratchDir();
  const src = writeSrc(dir, 'Some content.');
  const dst = dstPath(dir);

  const result = mergeMarkedSection(src, dst, { dryRun: true });

  assert.strictEqual(result.changed, true);
  assert.strictEqual(fs.existsSync(dst), false, 'dryRun must never create the file');
});

test('dryRun: dst exists and would be appended to -> reports changed:true but dst bytes are completely unchanged', () => {
  const dir = scratchDir();
  const src = writeSrc(dir, 'Some content.');
  const dst = dstPath(dir);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const existing = 'Unrelated pre-existing content, no markers here.\n';
  fs.writeFileSync(dst, existing);

  const result = mergeMarkedSection(src, dst, { dryRun: true });

  assert.strictEqual(result.changed, true);
  assert.strictEqual(fs.readFileSync(dst, 'utf8'), existing, 'dryRun must not modify dst bytes at all');
});

test('dryRun: dst exists and would be replaced -> reports changed:true but dst bytes are completely unchanged', () => {
  const dir = scratchDir();
  const dst = dstPath(dir);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const dstOriginal = 'before\n' + MARKER_START + '\nold\n' + MARKER_END + '\nafter';
  fs.writeFileSync(dst, dstOriginal);
  const src = writeSrc(dir, 'brand new content');

  const result = mergeMarkedSection(src, dst, { dryRun: true });

  assert.strictEqual(result.changed, true);
  assert.strictEqual(fs.readFileSync(dst, 'utf8'), dstOriginal, 'dryRun must not modify dst bytes at all');
});

test('dryRun: nothing would change -> reports changed:false and performs no write', () => {
  const dir = scratchDir();
  const src = writeSrc(dir, 'Stable content.');
  const dst = dstPath(dir);

  // Bring dst up to date for real first.
  const setup = mergeMarkedSection(src, dst);
  assert.strictEqual(setup.changed, true);
  const bytesAfterSetup = fs.readFileSync(dst, 'utf8');
  const forcedMtime = new Date('2001-01-01T00:00:00Z');
  fs.utimesSync(dst, forcedMtime, forcedMtime);
  const mtimeMsBefore = fs.statSync(dst).mtimeMs;

  const result = mergeMarkedSection(src, dst, { dryRun: true });

  assert.strictEqual(result.changed, false);
  assert.strictEqual(fs.readFileSync(dst, 'utf8'), bytesAfterSetup, 'dryRun no-op must not touch dst bytes');
  assert.strictEqual(fs.statSync(dst).mtimeMs, mtimeMsBefore, 'dryRun no-op must not touch dst mtime');
});
