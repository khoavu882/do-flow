'use strict';

// The pure parts of the pairing screen (feature 160, IC-009): the fragment grammar, the fingerprint form and the
// failure sorting. The page behaviour (the fragment removed at once, the single post, the states on screen) is
// tested end to end with the fake DOM in client-core.test.ts ("pair:" tests). The web root is copied beside a
// {"type":"module"} marker and imported from there, as the other client tests do.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let copy: string;
let pair: any;
let states: any;

before(async () => {
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-pair-view-'));
  fs.cpSync(path.join(__dirname, '..', 'web'), copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  states = await import(pathToFileURL(path.join(copy, 'states.js')).href);
  pair = await import(pathToFileURL(path.join(copy, 'views', 'pair.js')).href);
});
after(() => fs.rmSync(copy, { recursive: true, force: true }));

const CODE = 'abcdefghijklmnopqrstuvwx27';
const FP = 'ab'.repeat(32);

test('parsePairFragment accepts exactly #pair=<26 base32>&fp=<64 lowercase hex>&v=1', () => {
  assert.deepEqual(pair.parsePairFragment(`#pair=${CODE}&fp=${FP}&v=1`), { code: CODE, fingerprint: FP });
  for (const hash of ['', '#', '#/', '#c=' + FP, `#pair=${CODE}`, `#pair=${CODE}&fp=${FP}`, `#pair=${CODE}&fp=${FP}&v=2`, `#pair=${CODE}&fp=${FP}&v=1&x=1`,
    `#pair=${CODE.toUpperCase()}&fp=${FP}&v=1`, `#pair=${CODE.slice(1)}&fp=${FP}&v=1`, `#pair=${CODE}1&fp=${FP}&v=1`, `#pair=${CODE}&fp=${FP.toUpperCase()}&v=1`,
    `#pair=${CODE}&fp=${FP.slice(2)}&v=1`, `#pair=${CODE}&v=1&fp=${FP}`, ` #pair=${CODE}&fp=${FP}&v=1`, `#pair=${CODE}&fp=${FP}&v=1\n`]) {
    assert.equal(pair.parsePairFragment(hash), null, JSON.stringify(hash));
  }
});

test('colonPairs shows 64 hex digits as 32 uppercase pairs', () => {
  assert.equal(pair.colonPairs(FP), Array(32).fill('AB').join(':'));
  assert.equal(pair.colonPairs('0123456789abcdef'.repeat(4)).split(':').length, 32);
});

test('pairFailure sorts each refusal of POST /api/pair into its row; only a refused code is final', () => {
  const sort = (status: number | null, code: string | null, extra: object = {}) => states.pairFailure({ status, code, network: status === null, ...extra });
  assert.deepEqual([sort(401, 'pair-refused').key, sort(401, 'pair-refused').final], ['pair-refused', true]);
  assert.equal(sort(429, 'pair-rate-limited', { retryAfter: 540 }).key, 'pair-rate-limited');
  assert.match(sort(429, 'pair-rate-limited', { retryAfter: 540 }).sentence, /Try again in 9 min\./);
  assert.match(sort(429, 'pair-rate-limited', { retryAfter: 45 }).sentence, /Try again in 45 s\./);
  assert.match(sort(429, 'pair-rate-limited').sentence, /Try again in a few minutes\./);
  assert.equal(sort(409, 'device-limit').key, 'device-limit');
  assert.equal(sort(503, 'store-busy').key, 'store-busy');
  assert.equal(sort(503, 'store-unreadable').key, 'store-unreadable');
  assert.equal(sort(null, null).key, 'pair-offline');
  assert.equal(sort(400, 'usage').key, 'pair-failed');
  assert.equal(sort(403, 'forbidden-origin').key, 'pair-failed');
  for (const row of Object.values(states.PAIR_COPY) as any[]) assert.equal(typeof row.title, 'string');
  assert.deepEqual(Object.entries(states.PAIR_COPY).filter(([, row]: any) => row.final).map(([key]) => key), ['pair-refused']);
});
