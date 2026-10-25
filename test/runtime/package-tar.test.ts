'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { readTar } = require('../../src/runtime/packages/tar.ts');
const { loadPoints } = require('../../src/runtime/packages/points.ts');
const limits = loadPoints().registry.limits;

function entry(name: any, body = Buffer.alloc(0), type = '0', mode = 0o644, bad = false) {
  const h = Buffer.alloc(512);
  const put = (at: any, n: any, v: any) => h.write(v + '\0', at, n, 'utf8');
  const oct = (at: any, n: any, v: any) => h.write(v.toString(8).padStart(n - 1, '0') + '\0', at, n, 'ascii');
  put(0, 100, name); oct(100, 8, mode); oct(108, 8, 0); oct(116, 8, 0); oct(124, 12, body.length);
  oct(136, 12, 0); h.fill(32, 148, 156); h[156] = type.charCodeAt(0); put(257, 6, 'ustar'); put(263, 2, '00');
  let sum = 0; for (const b of h) sum += b; oct(148, 8, sum + (bad ? 1 : 0));
  return Buffer.concat([h, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}
function archive(...items: any[]) { return Buffer.concat([...items, Buffer.alloc(1024)]); }
function pax(record: any) {
  let row = ` ${record}\n`; let n = row.length + 1;
  while (`${n}${row}`.length !== n) n = `${n}${row}`.length;
  return Buffer.from(`${n}${row}`);
}
function paxPath(name: any) {
  return archive(entry('PaxHeaders/path', pax(`path=${name}`), 'x'), entry('short', Buffer.from('x')));
}
function read(bytes: any, extra = {}) { return readTar(bytes, { limits, ...extra }); }

test('reads ustar, pax and gzip archives with bytewise paths and execute modes', () => {
  const plain = read(archive(entry('z', Buffer.from('z'), '0', 0o755), entry('a', Buffer.from('a'))));
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.files.map((f: any) => [f.path, f.mode]), [['a', 0o644], ['z', 0o755]]);
  assert.equal(read(zlib.gzipSync(archive(entry('a', Buffer.from('x'))))).ok, true);
  assert.equal(read(paxPath('folder/long-file.txt')).files[0].path, 'folder/long-file.txt');
});
test('refuses links, oversized inputs, excessive counts and unsafe paths', () => {
  assert.equal(read(archive(entry('link', Buffer.alloc(0), '2'))).findings[0].code, 'symlink');
  assert.equal(read(archive(entry('big', Buffer.alloc(5 * 1024 * 1024)))).findings[0].code, 'too-large');
  assert.equal(read(archive(...Array.from({ length: 513 }, (_, i) => entry(`f${i}`)))).findings[0].code, 'too-many-files');
  for (const p of ['../x', '/x']) assert.equal(read(archive(entry(p))).findings[0].code, 'path-escapes-root');
  assert.equal(read(archive(entry('.git/config'))).findings[0].code, 'bad-type');
  assert.equal(read(archive(entry('x', Buffer.alloc(0), '0', 0o644, true))).findings[0].code, 'bad-type');
  const duplicate = read(archive(entry('same'), entry('same')));
  assert.equal(duplicate.findings[0].code, 'bad-type');
  assert.match(duplicate.findings[0].message, /appears twice in the archive/);
  const sizeRecord = pax('size=2');
  const mismatch = read(archive(entry('PaxHeaders/size', sizeRecord, 'x'), entry('sized', Buffer.from('x'))));
  assert.equal(mismatch.findings[0].code, 'bad-type');
  assert.match(mismatch.findings[0].message, /pax size does not match/);
});
test('stripPrefix retains only its subtree and refuses outside entries', () => {
  assert.equal(read(archive(entry('pkg/a')), { stripPrefix: 'pkg/' }).files[0].path, 'a');
  assert.equal(read(archive(entry('other/a')), { stripPrefix: 'pkg/' }).findings[0].code, 'path-escapes-root');
});
