'use strict';

// Second-pass masking (feature 093, V.7, IC-024; NFR-003): console/src/mask-lite.ts is a hand-written
// copy of the key rules of the core's body profile (src/runtime/mask.ts). This file proves that
// masked input stays masked, that a planted secret the core left is masked, and (as a parity
// oracle, the core being importable from a test but not from the package) that on the shared rules
// the copy and the core agree.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { maskLite, MASKED, EMAIL, IP } = require('../src/mask-lite.ts');
const { maskBody } = require('../../src/runtime/mask.ts');

const GH = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const AWS = 'AKIAABCDEFGHIJKLMNOP';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const PEM_BLOCK = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';

/** Planted secrets in the shapes the body profile masks: input, and the text the core would print for it. */
const PLANTED: Array<[string, string]> = [
  ['a GitHub token', `pushed with ${GH} today`],
  ['an AWS key id', `key ${AWS} used`],
  ['a JWT', `bearer-less ${JWT} seen`],
  ['an sk- key', 'OPENAI sk-abcdefghijklmnop1234567890 set'],
  ['a PEM block', `file:\n${PEM_BLOCK}\ndone`],
  ['a Bearer token', 'curl -H "x: y" Bearer abcdefgh12345678 now'],
  ['an Authorization header', 'Authorization: Basic dXNlcjpwYXNz'],
  ['URL credentials', 'clone https://user:hunter2pw@example.test/repo.git'],
  ['key=value', 'export API_TOKEN=abc123XYZ789'],
  ['a quoted JSON key', '{"password": "hunter2"}'],
  ['a single-quoted key', "secret = 'swordfish'"],
  ['a secret flag', 'tool --password hunter2 --verbose'],
  ['a flag with equals', 'tool --api-key=abc123def'],
  ['an email', 'mail jane.doe@example.invalid please'],
  ['an IPv4', 'host 10.20.30.40 up'],
  ['a long mixed run', 'blob Zx9Kq2Lm7Np4Rt1Vw8Yb3Cd6Fg5Hj0AaBb done'],
  ['a password phrase', 'the password hunter2x is wrong'],
];

test('a planted secret the core left is masked', () => {
  for (const [name, input] of PLANTED) {
    const out = maskLite(input);
    assert.notEqual(out, input, name);
    assert.ok([MASKED, EMAIL, IP].some((marker) => out.includes(marker)), `${name}: ${out}`);
  }
  assert.ok(!maskLite(`pushed with ${GH} today`).includes(GH));
  assert.ok(!maskLite('clone https://user:hunter2pw@example.test/repo.git').includes('hunter2pw'));
  assert.ok(!maskLite('{"password": "hunter2"}').includes('hunter2'));
  assert.ok(!maskLite(`file:\n${PEM_BLOCK}\ndone`).includes('MIIEowIBAAKCAQEA'));
  assert.equal(maskLite('mail jane.doe@example.invalid please'), `mail ${EMAIL} please`);
  assert.equal(maskLite('host 10.20.30.40 up'), `host ${IP} up`);
  assert.equal(maskLite('see /Users/jane/work/x.ts'), `see /Users/${MASKED}/work/x.ts`);
  assert.equal(maskLite('see /home/jane/work/x.ts'), `see /home/${MASKED}/work/x.ts`);
});

test('masked input stays masked: a second pass changes nothing, and no marker is removed', () => {
  const corpus = [
    ...PLANTED.map(([, input]) => input),
    `token=${MASKED} sent to ${EMAIL} from ${IP}`,
    `{"password": "${MASKED}"}`,
    `Authorization: ${MASKED}`,
    `https://${MASKED}@example.test/x`,
    `Bearer ${MASKED}`,
    `--password ${MASKED}`,
    `/Users/${MASKED}/code`,
    `${MASKED}${MASKED}${EMAIL}`,
    'plain prose with nothing to hide',
  ];
  for (const input of corpus) {
    const once = maskLite(input);
    assert.equal(maskLite(once), once, `idempotent: ${input}`);
    const markers = (text: string) => [MASKED, EMAIL, IP].reduce((sum, m) => sum + text.split(m).length - 1, 0);
    assert.ok(markers(once) >= markers(input), `no marker removed: ${input}`);
    // What the core itself printed is already masked: the second pass over it adds nothing for the shared rules.
    const printed = maskBody(input, { home: null }).text;
    assert.ok(markers(maskLite(printed)) >= markers(printed), `core output stays masked: ${input}`);
  }
  for (const marked of [MASKED, EMAIL, IP, `x ${MASKED} y`]) assert.equal(maskLite(marked), marked);
});

test('parity: on the planted corpus the copy and the core mask the same text', () => {
  for (const [name, input] of PLANTED) assert.equal(maskLite(input), maskBody(input, { home: null }).text, name);
});

test('code that only looks like a secret is left alone, as in the core', () => {
  for (const input of ['token: string', 'const secret = new Vault()', 'password: Config', 'apiKey: string[]', 'const key = 5;', 'the password is required', 'risk-assessment-for-the-new-quarterly-plan']) {
    assert.equal(maskLite(input), maskBody(input, { home: null }).text, input);
  }
});

test('non-strings and empty input', () => {
  assert.equal(maskLite(null), '');
  assert.equal(maskLite(undefined), '');
  assert.equal(maskLite(''), '');
  assert.equal(maskLite(12), '12');
});

test('a long hostile line is masked in bounded time', () => {
  for (const input of ['eyJ'.repeat(40_000), 'a'.repeat(200_000), `${'token'.repeat(30_000)}=x`, '-----BEGIN X-----'.repeat(5_000), 'a@'.repeat(50_000)]) {
    const started = Date.now();
    maskLite(input);
    assert.ok(Date.now() - started < 3_000, `${input.slice(0, 12)}: ${Date.now() - started} ms`);
  }
});

test('control: an identity mask would leave every planted secret in place', () => {
  const identity = (text: string) => text;
  assert.deepEqual(PLANTED.filter(([, input]) => identity(input) !== input), []);
  assert.equal(PLANTED.filter(([, input]) => maskLite(input) === input).length, 0);
});
