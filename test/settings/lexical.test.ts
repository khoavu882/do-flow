'use strict';

// 086 B.1 (IC-004, DD-3, OI-1): the lexical failure.capture rule over the shared corpus as strings, and
// readLexicalCapture over the file shapes. Any value other than "on" is off; no match is no setting.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { lexicalCapture, readLexicalCapture } = require('../../src/runtime/settings/lexical.ts');

const BOM = '\u00ef\u00bb\u00bf'; // the three UTF-8 BOM bytes as latin1 characters
const NBSP = '\u00a0';

const CORPUS = [
  ['pretty LF', '{\n  "schema": 1,\n  "failure.capture": "on"\n}\n', 'on'],
  ['compact', '{"schema":1,"failure.capture":"on"}', 'on'],
  ['wide spaces', '{"failure.capture"   :   "on"}', 'on'],
  ['pair split over lines', '{"failure.capture"\n:\n"on"}', 'on'],
  ['CRLF', '{\r\n  "schema": 1,\r\n  "failure.capture": "on"\r\n}\r\n', 'on'],
  ['tab, VT and FF as space', '{"failure.capture"\t:\u000b\u000c"on"}', 'on'],
  ['BOM then on', `${BOM}{"failure.capture":"on"}`, 'on'],
  ['BOM then off', `${BOM}{"failure.capture":"off"}`, 'off'],
  ['off', '{"failure.capture":"off"}', 'off'],
  ['OFF', '{"failure.capture":"OFF"}', 'off'],
  ['ON is not on', '{"failure.capture":"ON"}', 'off'],
  ['"off " with a space', '{"failure.capture":"off "}', 'off'],
  ['"on " with a space', '{"failure.capture":"on "}', 'off'],
  ['bare true', '{"failure.capture":true}', 'off'],
  ['bare on', '{"failure.capture":on}', 'off'],
  ['empty value', '{"failure.capture":}', 'off'],
  ['no value at the end', '{"failure.capture":', 'off'],
  ['duplicate on then off', '{"failure.capture":"on","failure.capture":"off"}', 'off'],
  ['duplicate off then on', '{"failure.capture":"off","failure.capture":"on"}', 'off'],
  ['duplicate on then on', '{"failure.capture":"on","failure.capture":"on"}', 'on'],
  ['another key whose value is the key text, before', '{"other":"failure.capture","failure.capture":"on"}', 'on'],
  ['another key whose value is the key text, after', '{"failure.capture":"on","other":"failure.capture"}', 'on'],
  ['the key text alone is no setting', '{"other":"failure.capture"}', null],
  ['escaped key text inside a string', '{"x":"\\"failure.capture\\":\\"off\\""}', null],
  ['nested object is not the flat key', '{"failure":{"capture":"off"}}', null],
  ['key with a trailing space is another key', '{"failure.capture ":"on"}', null],
  ['unknown keys only', '{"schema":1}', null],
  ['empty text', '', null],
  ['broken JSON still reads the pair', '{"failure.capture":"on" garbage ]]', 'on'],
  ['junk after the closing quote (OI-1)', '{"failure.capture":"on"abc,}', 'on'],
  ['unterminated on', '{"failure.capture":"on', 'off'],
  ['NUL ends the text', '{"failure.capture":"on"}\0{"failure.capture":"off"}', 'on'],
  ['NUL before the key', '\0{"failure.capture":"off"}', null],
  [`non-breaking space is not space (negative control)`, `{"failure.capture"${NBSP}:"on"}`, null],
  ['non-breaking space after the colon', `{"failure.capture":${NBSP}"on"}`, 'off'],
  ['ELOOP read error has no lexical text', '', null],
  ['ENOTDIR read error has no lexical text', '{}', null],
  ['ancestor EACCES read error has no lexical text', '{"schema":1}', null],
];

for (const [name, text, expected] of CORPUS) {
  test(`lexicalCapture: ${name} -> ${expected}`, () => {
    assert.equal(lexicalCapture(text), expected);
  });
}

test('negative control: JS \\s in place of the C-locale class reads the non-breaking-space row differently', () => {
  const loose = /"failure\.capture"\s*:\s*("[^"]*"|[^,}"\s]*)/g;
  const text = `{"failure.capture"${NBSP}:"on"}`;
  assert.notEqual([...text.matchAll(loose)].length, 0, '\\s matches where the rule must not');
  assert.equal(lexicalCapture(text), null);
});

test('negative control: the bare alternative must exclude the quote (OI-1)', () => {
  const original = /"failure\.capture"[ \t\n\v\f\r]*:[ \t\n\v\f\r]*("[^"]*"|[^,} \t\n\v\f\r]*)/g;
  // Without the exclusion a leftmost-longest engine (bash) captures `"on"abc`; JS would still pick `"on"`.
  assert.equal([...'{"failure.capture":"on"abc,}'.matchAll(original)][0][1], '"on"');
  assert.equal(lexicalCapture('{"failure.capture":"on"abc,}'), 'on');
  assert.equal(lexicalCapture('{"failure.capture":on"abc}'), 'off', 'a bare value stops at the quote and is not "on"');
});

// ── files ──────────────────────────────────────────────────────────────────────────────────────

const POSIX = process.platform !== 'win32';

test('readLexicalCapture: a missing file is no setting, a regular file is read', (t) => {
  const dir = tempDir(t, 'doflow-lexical-');
  const file = path.join(dir, 'settings.json');
  assert.equal(readLexicalCapture(file), null);
  fs.writeFileSync(file, '{"failure.capture":"on"}\n');
  assert.equal(readLexicalCapture(file), 'on');
  fs.writeFileSync(file, '{"failure.capture":"off"}\n');
  assert.equal(readLexicalCapture(file), 'off');
  fs.writeFileSync(file, '{}\n');
  assert.equal(readLexicalCapture(file), null);
});

test('readLexicalCapture: bytes are read one character each (a UTF-8 file with a BOM and non-ASCII text)', (t) => {
  const dir = tempDir(t, 'doflow-lexical-');
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"note":"héllo","failure.capture":"on"}', 'utf8')]));
  assert.equal(readLexicalCapture(file), 'on');
  fs.writeFileSync(file, Buffer.from(`{"failure.capture"${NBSP}:"on"}`, 'utf8'));
  assert.equal(readLexicalCapture(file), null, 'U+00A0 is two bytes and neither is a space');
  fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00, 0x7b]));
  assert.equal(readLexicalCapture(file), null, 'binary junk is no setting');
});

test('readLexicalCapture: a folder is off, a link to a file is followed, a dangling link is no setting', { skip: !POSIX }, (t) => {
  const dir = tempDir(t, 'doflow-lexical-');
  const folder = path.join(dir, 'settings.json');
  fs.mkdirSync(folder);
  assert.equal(readLexicalCapture(folder), 'off');
  const real = path.join(dir, 'real.json');
  fs.writeFileSync(real, '{"failure.capture":"on"}');
  const link = path.join(dir, 'link.json');
  fs.symlinkSync(real, link);
  assert.equal(readLexicalCapture(link), 'on');
  const dangling = path.join(dir, 'dangling.json');
  fs.symlinkSync(path.join(dir, 'nowhere.json'), dangling);
  assert.equal(readLexicalCapture(dangling), null);
});

test('readLexicalCapture: a FIFO is off and is never opened', { skip: !POSIX }, (t) => {
  const dir = tempDir(t, 'doflow-lexical-');
  const fifo = path.join(dir, 'settings.json');
  const made = spawnSync('mkfifo', [fifo]);
  if (made.status !== 0) return t.skip('mkfifo unavailable');
  assert.equal(readLexicalCapture(fifo), 'off'); // would block forever if it were opened for reading
});

test('readLexicalCapture: an unreadable file is off', { skip: !POSIX || (process.getuid && process.getuid() === 0) }, (t) => {
  const dir = tempDir(t, 'doflow-lexical-');
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"failure.capture":"on"}');
  fs.chmodSync(file, 0o000);
  assert.equal(readLexicalCapture(file), 'off');
  fs.chmodSync(file, 0o600);
  assert.equal(readLexicalCapture(file), 'on', 'control: readable again');
});

test('readLexicalCapture: a stat or read error other than a missing file is off, and nothing quotes file text', () => {
  const secret = 'SECRET-FILE-TEXT';
  const failing = (code: any) => ({ statSync: () => { throw Object.assign(new Error(secret), { code }); }, readFileSync: () => secret });
  assert.equal(readLexicalCapture('/x', failing('ENOENT')), null);
  assert.equal(readLexicalCapture('/x', failing('EACCES')), null, 'an EACCES while resolving the parent chain is unset');
  const blockedParent = {
    constants: fs.constants,
    statSync: (file: any) => file === '/x' ? { isDirectory: () => true } : (() => { throw Object.assign(new Error(secret), { code: 'EACCES' }); })(),
    accessSync: () => { throw Object.assign(new Error(secret), { code: 'EACCES' }); },
  };
  assert.equal(readLexicalCapture('/x/settings.json', blockedParent), 'off', 'an existing but unsearchable immediate parent is off');
  const rereadFails = { statSync: () => ({ isFile: () => true }), readFileSync: () => { throw new Error(secret); } };
  assert.equal(readLexicalCapture('/x', rereadFails), 'off');
  assert.equal(lexicalCapture(`{"failure.capture":"${secret}"}`), 'off', 'the answer is a word, never the text');
});
