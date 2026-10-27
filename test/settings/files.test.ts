'use strict';

// 086 C.1 (IC-002, data-model §2, FR-008, NFR-010): reading one settings layer file. A parse failure
// reports a byte offset only; no byte of the file appears in any result (Node 24 and 26 both quote
// the first bytes of the input in "Unexpected token" messages). Files live under a temp folder; no
// test reads the real home.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir }: any = require('../helper/tmp.ts');
const { loadSettingsRegistry }: any = require('../../src/runtime/settings/registry.ts');
const { readLayerFile, jsonFailure, validateValue, MAX_BYTES }: any = require('../../src/runtime/settings/files.ts');

const POSIX = process.platform !== 'win32';
const loaded = loadSettingsRegistry();
assert.ok(loaded.ok, loaded.detail);
const registry = loaded.registry;

function put(t: any, text: any, name = 'settings.json') {
  const dir = tempDir(t, 'doflow-layer-');
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

const read = (file: any, fsImpl?: any) => readLayerFile(file, { registry, fsImpl });
/** Everything a caller could print or log from a result. */
const flat = (result: any) => JSON.stringify({ ...result, values: [...result.values] });

// ── a good file ────────────────────────────────────────────────────────────────────────────────

test('a pretty-printed file with registered keys is read: schema 1, values validated, no notes', (t) => {
  const file = put(t, '{\n  "schema": 1,\n  "advice.enabled": true,\n  "advice.model": "qwen3:8b",\n  "storage.prune": "off",\n  "failure.capture": "off"\n}\n');
  const result = read(file);
  assert.equal(result.status, 'ok');
  assert.equal(result.code, null);
  assert.equal(result.offset, null);
  assert.deepEqual(result.notes, []);
  assert.deepEqual([...result.values], [
    ['advice.enabled', { raw: true, value: true, error: null }],
    ['advice.model', { raw: 'qwen3:8b', value: 'qwen3:8b', error: null }],
    ['storage.prune', { raw: 'off', value: 'off', error: null }],
    ['failure.capture', { raw: 'off', value: 'off', error: null }],
  ]);
});

test('CRLF line endings and a leading BOM read the same as plain LF', (t) => {
  const body = '{\r\n  "schema": 1,\r\n  "storage.prune": "on"\r\n}\r\n';
  for (const text of [body, `﻿${body}`]) {
    const result = read(put(t, text));
    assert.equal(result.status, 'ok');
    assert.equal(result.values.get('storage.prune').value, 'on');
  }
  // a BOM written as its three UTF-8 bytes
  const file = put(t, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"schema":1,"storage.prune":"off"}')]));
  assert.equal(read(file).values.get('storage.prune').value, 'off');
});

test('negative control: without stripping the BOM the same file is unparseable', (t) => {
  const text = '﻿{"schema":1}';
  assert.throws(() => JSON.parse(text), 'JSON.parse does not accept a BOM, so the reader must strip it');
  assert.equal(read(put(t, text)).status, 'ok');
});

// ── missing and unusable files ───────────────────────────────────────────────────────────────────

test('a missing file is absent, and reading creates no file or folder', (t) => {
  const dir = tempDir(t, 'doflow-layer-');
  const result = read(path.join(dir, 'not', 'here', 'settings.json'));
  assert.deepEqual({ status: result.status, code: result.code, offset: result.offset, values: result.values.size, notes: result.notes }, { status: 'absent', code: null, offset: null, values: 0, notes: [] });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a folder where the file should be is a not-file layer fault, not a throw', (t) => {
  const dir = tempDir(t, 'doflow-layer-');
  fs.mkdirSync(path.join(dir, 'settings.json'));
  const result = read(path.join(dir, 'settings.json'));
  assert.equal(result.status, 'invalid');
  assert.equal(result.code, 'not-file');
  assert.equal(result.values.size, 0);
});

test('a FIFO is a not-file layer fault and is never opened', { skip: !POSIX }, (t) => {
  const dir = tempDir(t, 'doflow-layer-');
  const fifo = path.join(dir, 'settings.json');
  if (spawnSync('mkfifo', [fifo]).status !== 0) return t.skip('mkfifo unavailable');
  const result = read(fifo); // would block forever if it were opened for reading
  assert.equal(result.status, 'invalid');
  assert.equal(result.code, 'not-file');
});

test('a link to a file is followed, a dangling link is absent', { skip: !POSIX }, (t) => {
  const dir = tempDir(t, 'doflow-layer-');
  fs.writeFileSync(path.join(dir, 'real.json'), '{"schema":1,"storage.prune":"off"}');
  fs.symlinkSync(path.join(dir, 'real.json'), path.join(dir, 'link.json'));
  fs.symlinkSync(path.join(dir, 'nowhere.json'), path.join(dir, 'dangling.json'));
  assert.equal(read(path.join(dir, 'link.json')).values.get('storage.prune').value, 'off');
  assert.equal(read(path.join(dir, 'dangling.json')).status, 'absent');
});

test('an unreadable file is an unreadable layer fault', { skip: !POSIX || (process.getuid && process.getuid() === 0) }, (t) => {
  const file = put(t, '{"schema":1}');
  fs.chmodSync(file, 0o000);
  const result = read(file);
  assert.equal(result.status, 'invalid');
  assert.equal(result.code, 'unreadable');
  fs.chmodSync(file, 0o600);
  assert.equal(read(file).status, 'ok', 'control: readable again');
});

test('a stat error other than a missing file, and a read error, are unreadable and carry no error text', () => {
  const secret = 'SECRET-OS-MESSAGE';
  const failing = (code: any) => ({ statSync: () => { throw Object.assign(new Error(secret), { code }); }, readFileSync: () => secret });
  assert.equal(read('/x', failing('ENOENT')).status, 'absent');
  for (const code of ['EACCES', 'ELOOP', 'ENOTDIR']) {
    const result = read('/x', failing(code));
    assert.equal(result.code, 'unreadable');
    assert.equal(flat(result).includes(secret), false);
  }
  const rereadFails = { statSync: () => ({ isFile: () => true, size: 3 }), readFileSync: () => { throw new Error(secret); } };
  const result = read('/x', rereadFails);
  assert.equal(result.code, 'unreadable');
  assert.equal(flat(result).includes(secret), false);
});

test('size: exactly 64 KiB is read, one byte more is too-large; the stat size and the bytes read are both checked', (t) => {
  const pad = (n: any) => `{"schema":1,"note":"${'a'.repeat(n)}"}`;
  const base = pad(0).length;
  const atLimit = pad(MAX_BYTES - base);
  const over = pad(MAX_BYTES - base + 1);
  assert.equal(Buffer.byteLength(atLimit), MAX_BYTES);
  assert.equal(Buffer.byteLength(over), MAX_BYTES + 1);
  assert.equal(read(put(t, atLimit)).status, 'ok');
  const tooLarge = read(put(t, over));
  assert.equal(tooLarge.status, 'invalid');
  assert.equal(tooLarge.code, 'too-large');
  assert.equal(tooLarge.values.size, 0);
  // a file that grew between the stat and the read
  const grew = { statSync: () => ({ isFile: () => true, size: 10 }), readFileSync: () => Buffer.alloc(MAX_BYTES + 1, 0x20) };
  assert.equal(read('/x', grew).code, 'too-large');
});

// ── parse errors: an offset only, never file text ───────────────────────────────────────────────

const SECRET = 'TOPSECRET-hunter2-DO-NOT-LEAK';

test('a syntax error reports its byte offset and no byte of the file', (t) => {
  const cases = [
    ['trailing comma', `{"schema":1,"advice.model":"${SECRET}",}`],
    ['truncated', `{"schema":1,"advice.model":"${SECRET}"`],
    ['unquoted secret key', `{"schema":1, ${SECRET}: 1}`],
    ['plain text', SECRET],
    ['single quotes', `{'schema':1,'note':'${SECRET}'}`],
  ];
  for (const [label, text] of cases) {
    const result = read(put(t, text));
    assert.equal(result.status, 'invalid', label);
    assert.equal(result.code, 'unparseable', label);
    assert.equal(result.values.size, 0, label);
    assert.match(result.reason, /^not valid JSON( at offset \d+)?$/, label);
    // V8 quotes only the first ~10 characters of the input, so check the prefix too.
    assert.equal(flat(result).includes('TOPSECRET'), false, `${label}: the result must not contain file text`);
    assert.equal(flat(result).includes('hunter2'), false, label);
  }
});

test('offsets are file byte offsets: the failing character, the end of input, and a BOM adds three', (t) => {
  const trailing = '{"schema":1,}'; // the `}` at index 12 is where V8 stops
  const a = read(put(t, trailing));
  assert.equal(a.code, 'unparseable');
  assert.equal(a.offset, trailing.indexOf('}'));
  assert.equal(a.reason, `not valid JSON at offset ${trailing.indexOf('}')}`);

  const withBom = read(put(t, `﻿${trailing}`));
  assert.equal(withBom.offset, trailing.indexOf('}') + 3, 'the offset counts the BOM bytes');

  const cut = '{"schema":1,"advice.model":';
  const end = read(put(t, cut));
  assert.equal(end.offset, cut.length, 'unexpected end of input = the end of the text');

  const empty = read(put(t, ''));
  assert.equal(empty.code, 'unparseable');
  assert.equal(empty.offset, 0);

  const multibyte = '{"schema":1,"note":"é",}'; // é is two bytes, so the byte offset is one more than the character index
  assert.equal(read(put(t, multibyte)).offset, Buffer.byteLength(multibyte.slice(0, multibyte.indexOf('}')), 'utf8'));
});

test('a /etc/passwd-shaped file is unparseable and none of its lines appear', (t) => {
  const passwd = 'root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n';
  const result = read(put(t, passwd));
  assert.equal(result.code, 'unparseable');
  const out = flat(result);
  for (const piece of ['root', 'daemon', 'nobody', 'bash', 'nologin', '/usr']) assert.equal(out.includes(piece), false, `'${piece}' leaked`);
});

test('negative control: forwarding error.message would leak the secret on this Node, and the reader does not', (t) => {
  const text = `${SECRET} is not json`;
  let message = '';
  try { JSON.parse(text); } catch (error: any) { message = error.message; }
  if (!message.includes('TOPSECRET')) t.diagnostic(`this Node (${process.version}) does not quote input; the control cannot show a leak here`);
  else assert.ok(message.includes('TOPSECRET'), 'JSON.parse quotes the start of the input, which is why error.message is never forwarded');
  assert.equal(flat(read(put(t, text))).includes('TOPSECRET'), false);
  // the helper on its own, given a hostile error message whose quoted text mimics a position
  const hostile = new Error(`Unexpected token 'x', "x in JSON at position 3" is not valid JSON`);
  assert.deepEqual(jsonFailure(hostile, 'x in JSON at position 3'), { offset: null, reason: 'not valid JSON' });
  const hostileTail = new Error('Unexpected token \'x\', "TOPSECRET in JSON at position 3" is not valid JSON');
  assert.equal(JSON.stringify(jsonFailure(hostileTail, 'whatever')).includes('TOPSECRET'), false);
});

test('jsonFailure: V8 message shapes, with and without the line and column suffix', () => {
  assert.deepEqual(jsonFailure(new Error("Expected property name or '}' in JSON at position 1 (line 1 column 2)"), '{x}'), { offset: 1, reason: 'not valid JSON at offset 1' });
  assert.deepEqual(jsonFailure(new Error('Unexpected token } in JSON at position 5'), '{"a":}'), { offset: 5, reason: 'not valid JSON at offset 5' });
  assert.deepEqual(jsonFailure(new Error('Unexpected end of JSON input'), '{"a":'), { offset: 5, reason: 'not valid JSON at offset 5' });
  assert.deepEqual(jsonFailure(new Error('Unexpected end of JSON input'), '{"a":', 3), { offset: 8, reason: 'not valid JSON at offset 8' });
  assert.deepEqual(jsonFailure(new Error('something else'), 'x'), { offset: null, reason: 'not valid JSON' });
  assert.deepEqual(jsonFailure({}, 'x'), { offset: null, reason: 'not valid JSON' });
  assert.equal(jsonFailure(new Error('x in JSON at position 99999'), 'abc').offset, 3, 'an offset past the end is clamped');
});

test('a top-level value that is not an object is an unparseable layer', (t) => {
  for (const text of ['[]', 'null', '"text"', '3', 'true', '[{"schema":1}]']) {
    const result = read(put(t, text));
    assert.equal(result.code, 'unparseable', text);
    assert.equal(result.reason, 'must be a JSON object', text);
    assert.equal(result.offset, null);
  }
});

// ── schema ───────────────────────────────────────────────────────────────────────────────────────

test('schema: missing is read as 1 with a schema-missing note, 1 is clean, anything else is an invalid layer', (t) => {
  const missing = read(put(t, '{"storage.prune":"off"}'));
  assert.equal(missing.status, 'ok');
  assert.equal(missing.values.get('storage.prune').value, 'off');
  assert.deepEqual(missing.notes.map((n: any) => [n.code, n.key]), [['schema-missing', null]]);

  const one = read(put(t, '{"schema":1,"storage.prune":"off"}'));
  assert.deepEqual(one.notes, []);

  for (const text of ['{"schema":2}', '{"schema":"1"}', '{"schema":null}', '{"schema":true}', '{"schema":1.5}', '{"schema":[1]}']) {
    const result = read(put(t, `${text.slice(0, -1)},"storage.prune":"off"}`));
    assert.equal(result.status, 'invalid', text);
    assert.equal(result.code, 'schema', text);
    assert.equal(result.values.size, 0, 'no key of an invalid layer is applied');
  }
});

// ── keys: nested, unknown, invalid values ───────────────────────────────────────────────────────

test('a nested object or array under an unregistered key is reported as nested and not applied', (t) => {
  const result = read(put(t, '{"schema":1,"advice":{"enabled":true},"storage":["prune"],"advice.model":"m"}'));
  assert.equal(result.status, 'ok');
  assert.deepEqual([...result.values.keys()], ['advice.model']);
  assert.deepEqual(result.notes.map((n: any) => [n.code, n.key]), [['nested', 'advice'], ['nested', 'storage']]);
  assert.match(result.notes[0].text, /use dotted keys/);
  assert.equal(result.notes[0].source.endsWith('settings.json'), true);
});

test('an unregistered scalar key is an unknown-key note, not an error', (t) => {
  const result = read(put(t, '{"schema":1,"future.setting":3,"prompt-nudge":"off","advice.model":"m"}'));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.notes.map((n: any) => [n.code, n.key]), [['unknown-key', 'future.setting'], ['unknown-key', 'prompt-nudge']]);
  assert.deepEqual([...result.values.keys()], ['advice.model']);
  const long = read(put(t, `{"schema":1,"${'k'.repeat(500)}":1}`));
  assert.ok(long.notes[0].text.length < 200, 'a very long key name is cut in the note');
});

test('a registered key with the wrong encoding is a value error on that key, the others still apply', (t) => {
  const result = read(put(t, JSON.stringify({
    schema: 1,
    'advice.enabled': 'yes',
    'advice.provider': 'not-a-provider',
    'advice.endpoint': 'not a url',
    'advice.model': '   ',
    'storage.prune': 'maybe',
    'storage.retentionHours': 0,
    'failure.capture': 'ON',
  })));
  assert.equal(result.status, 'ok');
  const codes = Object.fromEntries([...result.values].map(([key, entry]) => [key, entry.error && entry.error.code]));
  assert.deepEqual(codes, {
    'advice.enabled': 'type', 'advice.provider': 'enum', 'advice.endpoint': 'url', 'advice.model': 'type',
    'storage.prune': 'enum', 'storage.retentionHours': 'range', 'failure.capture': 'enum',
  });
  for (const entry of result.values.values()) assert.equal(entry.value, null);
  assert.equal(result.values.get('advice.enabled').raw, 'yes', 'the raw value is kept for display');
  const good = read(put(t, '{"schema":1,"advice.model":"m","storage.retentionHours":48}'));
  assert.equal(good.values.get('storage.retentionHours').value, 48);
  assert.equal(good.values.get('advice.model').error, null);
});

test('a value error never echoes the value (a URL with credentials stays out of the reason)', (t) => {
  const result = read(put(t, JSON.stringify({ schema: 1, 'advice.endpoint': `${SECRET} not a url`, 'storage.prune': SECRET })));
  for (const entry of result.values.values()) assert.equal(JSON.stringify(entry.error).includes('TOPSECRET'), false);
  assert.equal(result.values.get('advice.endpoint').error.code, 'url');
});

test('validateValue: boolean, enum, integer (safe, minimum), string, url', () => {
  const spec = (type: any, extra = {}) => ({ type, ...extra });
  assert.equal(validateValue(spec('boolean'), false), null);
  assert.equal(validateValue(spec('boolean'), 0).code, 'type');
  assert.equal(validateValue(spec('enum'), 'on', ['off', 'on']), null);
  assert.equal(validateValue(spec('enum'), 'On', ['off', 'on']).code, 'enum');
  assert.equal(validateValue(spec('enum'), 1, ['off', 'on']).code, 'type');
  assert.equal(validateValue(spec('enum'), 'on', null).code, 'enum');
  assert.equal(validateValue(spec('integer', { min: 1 }), 1), null);
  assert.equal(validateValue(spec('integer', { min: 1 }), 0).code, 'range');
  assert.equal(validateValue(spec('integer', { min: 1 }), 1.5).code, 'type');
  assert.equal(validateValue(spec('integer', { min: 1 }), '5').code, 'type');
  assert.equal(validateValue(spec('integer', { min: 1 }), Number.MAX_SAFE_INTEGER + 1).code, 'type');
  assert.equal(validateValue(spec('integer'), -5), null, 'no minimum declared');
  assert.equal(validateValue(spec('string'), 'x'), null);
  assert.equal(validateValue(spec('string'), '').code, 'type');
  assert.equal(validateValue(spec('string'), '  ').code, 'type');
  assert.equal(validateValue(spec('url'), 'http://127.0.0.1:11434'), null);
  assert.equal(validateValue(spec('url'), 'nope').code, 'url');
  assert.equal(validateValue(spec('url'), 5).code, 'type');
  assert.equal(validateValue(spec('float'), 5).code, 'type');
});

test('duplicate keys in a file: the last value wins, as JSON.parse reads it', (t) => {
  const result = read(put(t, '{"schema":1,"storage.prune":"off","storage.prune":"on"}'));
  assert.equal(result.values.get('storage.prune').value, 'on');
});
