'use strict';

// The pairing payload (feature 160, IC-003): URL shape, the labelled text block and its non-terminal
// form. The QR inside is checked by qr.test.ts; here only that it is the QR of the URL and nothing else.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { payloadUrl, payloadBlock } = require('../src/pair-payload.ts');
const { encode, render } = require('../src/qr.ts');

const FP = 'ab'.repeat(32);
const CODE = 'abcdefghijklmnopqrstuvwxyz';
const base = { host: '192.168.1.23', port: 47380, code: CODE, fingerprint: FP };

test('the URL carries code, fingerprint and version in the fragment', () => {
  const url = payloadUrl(base);
  assert.equal(url, `https://192.168.1.23:47380/#pair=${CODE}&fp=${FP}&v=1`);
  assert.equal(Buffer.byteLength(url), 131, 'the design says 134; the arithmetic of its own example is 131');
  assert.equal(encode(Buffer.from(url)).version, 8);
  assert.equal(new URL(url).search, '', 'nothing but the fragment leaves the browser');
});

test('an IPv6 host is bracketed and normalised', () => {
  assert.equal(payloadUrl({ ...base, host: 'fd00:0:0:0:0:0:0:1' }), `https://[fd00::1]:47380/#pair=${CODE}&fp=${FP}&v=1`);
  assert.equal(new URL(payloadUrl({ ...base, host: 'fd00::1' })).hostname, '[fd00::1]');
});

test('a malformed part is refused, never written into a link', () => {
  for (const bad of [{ host: 'example.test' }, { host: 'fe80::1%en0' }, { port: 0 }, { port: 65536 }, { port: 1.5 }, { code: CODE.toUpperCase() }, { code: CODE.slice(1) }, { code: `${CODE.slice(1)}1` }, { fingerprint: FP.slice(1) }, { fingerprint: FP.toUpperCase() }]) {
    assert.throws(() => payloadUrl({ ...base, ...bad }), /payload/, JSON.stringify(bad));
  }
});

const EXPIRES = new Date(2026, 10, 15, 9, 7).getTime();
const input = { ...base, interfaceName: 'en0', rule: 'the only private IPv4 address on a non-virtual interface', scope: 'view', expiresAt: EXPIRES, tty: true, color: true };

test('the text block has the exact labels, the colon-paired fingerprint and the QR of the link', () => {
  const block = payloadBlock(input);
  const url = payloadUrl(base);
  const head = block.split('\n').slice(0, 5);
  assert.deepEqual(head, [
    'doflow ui: LAN mode on https://192.168.1.23:47380',
    '  address      192.168.1.23 (en0, the only private IPv4 address on a non-virtual interface)',
    `  fingerprint  SHA-256 ${'AB:'.repeat(31)}AB`,
    `  pairing code ${CODE} (one use, expires 09:07, scope view)`,
    `  link         ${url}`,
  ]);
  assert.equal(block.slice(head.join('\n').length + 1), `${render(encode(Buffer.from(url)), { color: true })}\n`);
});

test('the control scope and an IPv6 host show in the block', () => {
  const block = payloadBlock({ ...input, host: 'fd00::1', scope: 'control' });
  assert.match(block, /^doflow ui: LAN mode on https:\/\/\[fd00::1\]:47380\n/);
  assert.match(block, /\n  address      fd00::1 \(en0, /);
  assert.match(block, /scope control\)\n/);
});

test('off a terminal the QR is replaced by one line; NO_COLOR draws without escape codes', () => {
  const plain = payloadBlock({ ...input, tty: false });
  assert.equal(plain.endsWith('\n  (QR code shown on a terminal only)\n'), true);
  assert.equal(plain.includes('\x1b'), false);
  assert.equal(plain.split('\n').length, 7);
  const noColor = payloadBlock({ ...input, color: false });
  assert.equal(noColor.includes('\x1b'), false);
  assert.match(noColor, /\n {2}\(if it does not scan, use the link\)\n$/);
  assert.equal(payloadBlock(input).includes('\x1b[38;5;16m'), true);
});
