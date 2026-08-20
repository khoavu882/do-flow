'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveLocator, describeResolution } = require('../../src/runtime/locator-resolve');

/** A throwaway repo root, so every case reads real files rather than a mocked shape. */
function tmpRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-locator-'));
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, 'utf8');
  }
  return root;
}

test('a line inside the file resolves', () => {
  const root = tmpRepo({ 'src/a.js': 'one\ntwo\nthree\n' });
  const result = resolveLocator({ locator: { file: 'src/a.js', line: 2 }, repoRoot: root });
  assert.equal(result.resolved, true);
  assert.equal(result.reason, null);
  assert.equal(result.actual.lines, 3);
});

test('a line beyond EOF does not resolve and reports the real length', () => {
  const root = tmpRepo({ 'src/a.js': 'one\ntwo\nthree\n' });
  const result = resolveLocator({ locator: { file: 'src/a.js', line: 799 }, repoRoot: root });
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'line-beyond-eof');
  assert.equal(result.actual.lines, 3);
  assert.match(describeResolution({ file: 'src/a.js', line: 799 }, result), /has 3 line\(s\).*line 799/);
});

test('the last line is addressable — a trailing newline does not invent a line', () => {
  const root = tmpRepo({ 'src/a.js': 'one\ntwo\nthree\n' });
  assert.equal(resolveLocator({ locator: { file: 'src/a.js', line: 3 }, repoRoot: root }).resolved, true);
  assert.equal(resolveLocator({ locator: { file: 'src/a.js', line: 4 }, repoRoot: root }).resolved, false);
});

test('a file that is not there does not resolve', () => {
  const root = tmpRepo({ 'src/a.js': 'one\n' });
  const result = resolveLocator({ locator: { file: 'src/gone.js', line: 1 }, repoRoot: root });
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'file-missing');
  assert.equal(result.actual, null);
});

test('a directory in place of a file reports file-missing rather than a third verdict', () => {
  const root = tmpRepo({ 'src/a.js': 'one\n' });
  const result = resolveLocator({ locator: { file: 'src' }, repoRoot: root });
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'file-missing');
});

test('a symbol present in the file resolves and reports where it actually is', () => {
  const root = tmpRepo({ 'src/a.js': 'const x = 1;\nfunction parseLocator() {}\n' });
  const result = resolveLocator({ locator: { file: 'src/a.js', symbol: 'parseLocator' }, repoRoot: root });
  assert.equal(result.resolved, true);
  assert.deepEqual(result.actual.symbolLines, [2]);
});

test('a symbol absent from the file does not resolve', () => {
  const root = tmpRepo({ 'src/a.js': 'const x = 1;\n' });
  const result = resolveLocator({ locator: { file: 'src/a.js', symbol: 'parseLocator' }, repoRoot: root });
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'symbol-absent');
  assert.match(describeResolution({ file: 'src/a.js', symbol: 'parseLocator' }, result), /no symbol 'parseLocator'/);
});

test('symbol matching respects word boundaries', () => {
  const root = tmpRepo({ 'src/a.js': 'const notParseLocatorReally = 1;\n' });
  const result = resolveLocator({ locator: { file: 'src/a.js', symbol: 'parseLocator' }, repoRoot: root });
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'symbol-absent');
});

test('a symbol on a different line than named still resolves — moved is not absent', () => {
  const root = tmpRepo({ 'src/a.js': 'a\nb\nfunction target() {}\n' });
  const result = resolveLocator({ locator: { file: 'src/a.js', line: 1, symbol: 'target' }, repoRoot: root });
  assert.equal(result.resolved, true);
  assert.deepEqual(result.actual.symbolLines, [3]);
});

test('a uri-only locator is not-checkable and does not read as a failure', () => {
  const result = resolveLocator({ locator: { uri: 'https://example.com/doc' }, repoRoot: '/nonexistent' });
  assert.equal(result.resolved, true);
  assert.equal(result.reason, 'not-checkable');
  assert.equal(describeResolution({ uri: 'https://example.com/doc' }, result), null);
});

test('an empty or absent locator is not-checkable', () => {
  assert.equal(resolveLocator({ locator: {} }).reason, 'not-checkable');
  assert.equal(resolveLocator({}).reason, 'not-checkable');
});

test('an absolute file path is honoured rather than joined to the root', () => {
  const root = tmpRepo({ 'src/a.js': 'one\ntwo\n' });
  const result = resolveLocator({
    locator: { file: path.join(root, 'src/a.js'), line: 2 },
    repoRoot: '/somewhere/else',
  });
  assert.equal(result.resolved, true);
});
