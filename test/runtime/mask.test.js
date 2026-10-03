'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mask, maskLine, maskBody, normalise, normaliseMessage } = require('../../src/runtime/mask');

const HOME = '/home/user';
const opts = { home: HOME };
const NPM = `npm_${'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5'}`; // 36 letters and digits after the prefix

// IC-012 fixture table. Each row: [name, input, profile(s), expected].
const FIXTURES = [
  ['json password', '{"password": "x"}', ['body'], '{"password": "<masked>"}'],
  ['basic authorization header', 'Authorization: Basic dXNlcjpwYXNz', ['body'], 'Authorization: <masked>'],
  ['proxy authorization header', 'Proxy-Authorization: Bearer abc.def.ghi', ['body'], 'Proxy-Authorization: <masked>'],
  ['--password flag', '--password hunter2', ['body'], '--password <masked>'],
  ['--token= flag', '--token=abc123', ['body'], '--token=<masked>'],
  ['pem without END', 'before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAAB3NzaC1yc2E', ['body'], 'before\n<masked>'],
  ['password with spaces around =', 'password = hunter2', ['body'], 'password = <masked>'],
  ['client_secret with bare colon', 'client_secret:abc', ['body'], 'client_secret:<masked>'],
  ['bearer token', 'bearer abc123def456', ['line', 'body'], 'bearer <masked>'],
  ['npm token', NPM, ['line', 'body'], '<masked>'],
  ['aws access key id', 'AKIAIOSFODNN7EXAMPLE', ['line', 'body'], '<masked>'],
  ['aws secret access key', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', ['line', 'body'], '<masked>'],
  ['key=value with a digit', 'token=ab12cd34', ['line'], 'token=<masked>'],
  ['prose with a key word', 'Fix auth: token refresh fails', ['line'], 'Fix auth: token refresh fails'],
  ['prose with a colon', 'Author: Jane', ['line', 'body'], 'Author: Jane'],
  ['git sha', 'e17bb1e0c3a94f2b8d6e5a7c9b1d3f5e7a9c1b3d', ['line', 'body'], 'e17bb1e0c3a94f2b8d6e5a7c9b1d3f5e7a9c1b3d'],
  ['home path with a long segment', '/home/user/Workspace/046-lifecycle-loop-with-a-long-name/src/x.js', ['line', 'body'], '~/Workspace/046-lifecycle-loop-with-a-long-name/src/x.js'],
  ['camelCase frame', 'handleDecisionCommandWithRegisterCompaction', ['line', 'body'], 'handleDecisionCommandWithRegisterCompaction'],
];

for (const [name, input, profiles, expected] of FIXTURES) {
  for (const profile of profiles) {
    test(`IC-012 fixture (${profile}): ${name}`, () => {
      assert.equal(mask(input, profile, opts).text, expected);
    });
  }
}

test('a PEM block with an END line stops at the END line', () => {
  const input = 'a\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\nb';
  assert.equal(maskLine(input, opts).text, 'a\n<masked>\nb');
});

test('every token shape of rule 2 is masked', () => {
  const shapes = [
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'github_pat_11ABCDEFG0abcdefghijklmnop',
    'glpat-abcdefghijklmnopqrstu',
    'sk-abcdefghijklmnop1234',
    'xoxb-1234567890-abcdef',
    `AIza${'a'.repeat(35)}`,
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc_DEF-123',
    'ASIAIOSFODNN7EXAMPLE',
  ];
  for (const shape of shapes) assert.equal(maskLine(`x ${shape} y`, opts).text, 'x <masked> y', shape);
});

test('sk- inside a hyphenated word is not a token', () => {
  assert.equal(maskLine('risk-assessment-for-checkout-flows', opts).text, 'risk-assessment-for-checkout-flows');
});

test('URL credentials, emails and IPv4 addresses', () => {
  assert.equal(maskLine('git clone https://user:s3cret@host.example/x.git', opts).text, 'git clone https://<masked>@host.example/x.git');
  assert.equal(maskLine('mail jane.doe@example.com from 10.0.0.12', opts).text, 'mail <email> from <ip>');
  assert.equal(maskLine('version 1.2.3 and 1.2.3.4.5', opts).text, 'version 1.2.3 and 1.2.3.4.5');
});

test('the home prefix becomes ~ only at a path boundary', () => {
  assert.equal(maskLine('/home/user', opts).text, '~');
  assert.equal(maskLine('see /home/user/x and /home/users/x', opts).text, 'see ~/x and /home/users/x');
  assert.equal(maskLine('/home/user/x', { home: null }).text, '/home/user/x');
  assert.equal(maskLine('/x', { home: '/' }).text, '/x');
});

test('rule 4 leaves a plain-letter value alone in the line profile, rule 7 masks it in the body profile', () => {
  assert.equal(maskLine('secret: values', opts).text, 'secret: values');
  assert.equal(maskBody('secret: values', opts).text, 'secret: <masked>');
  assert.equal(maskBody('"api_key": \'abc\', "session_id" = "9"', opts).text, '"api_key": \'<masked>\', "session_id" = "<masked>"');
});

test('the body profile masks a header value to the end of the line only', () => {
  assert.equal(maskBody('Authorization: Bearer abc.def.ghi extra\nHost: x', opts).text, 'Authorization: <masked>\nHost: x');
});

test('--flag values, quoted too', () => {
  assert.equal(maskBody('run --client-secret "two words" --api-key=k1 ok', opts).text, 'run --client-secret <masked> --api-key=<masked> ok');
});

test('a long mixed run that is a path survives, one that is not is masked', () => {
  const part = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5';
  assert.equal(maskLine(`/${part}/x`, opts).text, `/${part}/x`, 'every part under 32 and starts with /');
  assert.equal(maskLine(`/${part}XY/x`, opts).text, '<masked>', 'a part of 32 is not a path');
  assert.equal(maskLine(`value ${part}XY`, opts).text, 'value <masked>');
});

test('masking is idempotent and counts each value once', () => {
  const input = `Proxy-Authorization: Bearer abc12345678\nrun --token=abc123 ${NPM} a@b.io`;
  const once = maskBody(input, opts);
  assert.equal(maskBody(once.text, opts).text, once.text);
  assert.equal(maskBody(once.text, opts).masked, 0);
  assert.equal(once.masked, 4); // header, flag value, npm token, email
  assert.equal(maskLine('token=ab12 password=x1', opts).masked, 2);
  assert.equal(maskLine('nothing here', opts).masked, 0);
});

test('non-string input is coerced and an unknown profile throws', () => {
  assert.equal(maskLine(null, opts).text, '');
  assert.equal(maskLine(42, opts).text, '42');
  assert.throws(() => mask('x', 'both', opts), TypeError);
});

test('rule 5 measures a 40-character value on its own, after = : or _', () => {
  const key = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  assert.equal(maskLine(`x=${key}`, opts).text, 'x=<masked>');
  assert.equal(maskLine(`AWS_KEY=${key}`, opts).text, 'AWS_KEY=<masked>');
  assert.equal(maskBody(`key:${key} tail`, opts).text, 'key:<masked> tail');
  assert.equal(maskLine(`AWS_${key}`, opts).text, 'AWS_<masked>');
  const longer = `${key}Q`;
  const shorter = key.slice(1);
  assert.equal(longer.length, 41);
  assert.equal(shorter.length, 39);
  assert.equal(maskLine(longer, opts).text, longer, '41 characters with one digit is not the key shape');
  assert.equal(maskLine(shorter, opts).text, shorter, '39 characters with one digit is not the key shape');
  assert.equal(maskLine(`x=${longer}`, opts).text, `x=${longer}`);
  assert.equal(maskLine('e17bb1e0c3a94f2b8d6e5a7c9b1d3f5e7a9c1b3d', opts).text, 'e17bb1e0c3a94f2b8d6e5a7c9b1d3f5e7a9c1b3d');
});

test('key-name matching is bounded: repeated key words and a 1 MB body finish quickly in both profiles', () => {
  for (const input of ['token.'.repeat(16 * 1024 / 6), `${'token.'.repeat(200)} x`.repeat(80), 'secret-'.repeat(50000), `${'a'.repeat(100)}token${'b'.repeat(100)}=1 `.repeat(2000)]) {
    for (const profile of ['line', 'body']) {
      const started = Date.now();
      mask(input, profile, opts);
      assert.ok(Date.now() - started < 500, `${profile} took ${Date.now() - started} ms on ${input.length} characters`);
    }
  }
  const started = Date.now();
  maskBody('token.'.repeat(Math.ceil(1_000_000 / 6)), opts);
  assert.ok(Date.now() - started < 500);
});

test('a key name over 64 characters on a side is not treated as a key', () => {
  assert.equal(maskLine(`${'a'.repeat(70)}token=ab12cd34`, opts).text, `${'a'.repeat(70)}token=ab12cd34`);
  assert.equal(maskLine(`my_${'a'.repeat(20)}_token=ab12cd34`, opts).text, `my_${'a'.repeat(20)}_token=<masked>`);
});

test('a large body with a long unbroken run finishes quickly', () => {
  const started = Date.now();
  maskBody(`${'a'.repeat(1_000_000)}\n${'password=x '.repeat(10_000)}`, opts);
  assert.ok(Date.now() - started < 5000);
});

test('normalise: paths, quoted text, digits, whitespace and length (rules 10 to 13)', () => {
  assert.equal(normalise('open /home/user/app/src/x.js:12:3 failed'), 'open <path>:N:N failed');
  assert.equal(normalise('see ~/Workspace/app and ~'), 'see <path> and <path>');
  assert.equal(normalise('Cannot read properties of undefined (reading \'price\')'), 'Cannot read properties of undefined (reading "...")');
  assert.equal(normalise('a "b c" `d` \'e\' done'), 'a "..." "..." "..." done');
  assert.equal(normalise("don't stop, can't stop"), "don't stop, can't stop");
  assert.equal(normalise('retry 3 of 10 after 250ms'), 'retry N of N after Nms');
  assert.equal(normalise('a   b\n\tc  '), 'a b c');
  assert.equal(normalise('x'.repeat(300)).length, 200);
  assert.equal(normalise('a/b and and/or https://x.test/y'), 'a/b and and/or https://x.test/y');
  assert.equal(normalise('C:\\Users\\dev\\x.js broke'), '<path> broke');
  assert.equal(normalise(undefined), '');
});

test('normaliseMessage masks first, then normalises', () => {
  assert.equal(normaliseMessage('failed for token=ab12cd34 in /home/user/app at line 12', opts), 'failed for token=<masked> in <path> at line N');
});
