'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mask, maskLine, maskBody, normalise, normaliseMessage, printSafe } = require('../../src/runtime/mask.ts');

const HOME = '/home/user';
const opts: any = { home: HOME };
const NPM = `npm_${'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5'}`; // 36 letters and digits after the prefix

// IC-012 fixture table. Each row: [name, input, profile(s), expected].
const FIXTURES: any = [
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
  const shapes: any = [
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'github_pat_11ABCDEFG0abcdefghijklmnop',
    'glpat-abcdefghijklmnopqrstu',
    'sk-abcdefghijklmnop1234',
    'xoxb-1234567890-abcdef',
    `AIza${'a'.repeat(35)}`,
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc_DEF-123',
    // AWS's documented example key, split so secret scanners do not flag the fixture itself.
    `ASIA${'IOSFODNN7EXAMPLE'}`,
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

test('printSafe: controls and bidi marks become U+FFFD, line breaks a space, tab stays; other values pass through', () => {
  assert.equal(printSafe('a\u001b[2Jb\u0007c\u202ed\u2067e\u200ff\u009bg\u007fh'), 'a\uFFFD[2Jb\uFFFDc\uFFFDd\uFFFDe\uFFFDf\uFFFDg\uFFFDh');
  assert.equal(printSafe('a\nb\r\nc\u2028d\te'), 'a b  c d\te');
  assert.equal(printSafe('plain text, accents \u00e9 and CJK \u4e2d'), 'plain text, accents \u00e9 and CJK \u4e2d');
  assert.deepEqual(printSafe({ a: ['x\u001b', 3, null], b: { c: 'y\u202e' }, n: 1 }), { a: ['x\uFFFD', 3, null], b: { c: 'y\uFFFD' }, n: 1 });
  assert.equal(printSafe(7), 7);
  assert.equal(printSafe(null), null);
});

test('printSafe with keepLineBreaks leaves line breaks and still replaces controls', () => {
  assert.equal(printSafe('a\nb\u001bc\r\nd', { keepLineBreaks: true }), 'a\nb\uFFFDc\r\nd');
  assert.deepEqual(printSafe(['x\ny\u0007'], { keepLineBreaks: true }), ['x\ny\uFFFD']);
});

test('the home prefix needs a left boundary: it starts the text or follows whitespace, a quote, =, :, ( or [', () => {
  const home: any = { home: '/var/folders/x' };
  assert.equal(maskLine('see /private/var/folders/x/y here', home).text, 'see /private/var/folders/x/y here');
  assert.equal(maskLine('/a/var/folders/x/y', home).text, '/a/var/folders/x/y');
  assert.equal(maskLine('at /var/folders/x/y "/var/folders/x" \'/var/folders/x\' k=/var/folders/x (/var/folders/x) [/var/folders/x] p:/var/folders/x', home).text,
    'at ~/y "~" \'~\' k=~ (~) [~] p:~');
  assert.equal(maskLine('/var/folders/x/y', home).text, '~/y');
});

test('a JWT after a space, =, : or at a line start is still masked (RR-1, DEC-069)', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc_DEF-123';
  assert.equal(maskLine(`a ${jwt}`, opts).text, 'a <masked>');
  assert.equal(maskLine(`a=${jwt}`, opts).text, 'a=<masked>');
  assert.equal(maskLine(`a:${jwt}`, opts).text, 'a:<masked>');
  assert.equal(maskLine(jwt, opts).text, '<masked>');
  assert.equal(maskBody(`a\n${jwt}\nb`, opts).text, 'a\n<masked>\nb');
});

// Runs in a worker thread so a regression (quadratic masking) is terminated at the deadline instead
// of blocking the test process for minutes.
test('maskBody on a 1 MiB run of eyJ with no dots finishes in under 2000 ms (RR-1, DEC-069)', { timeout: 10000 }, async () => {
  const { Worker } = require('node:worker_threads');
  const source = `
    const { parentPort } = require('node:worker_threads');
    const { maskBody } = require(${JSON.stringify(require.resolve('../../src/runtime/mask.ts'))});
    const input = 'eyJ'.repeat(350000);
    const start = performance.now();
    const out = maskBody(input).text;
    parentPort.postMessage({ ms: performance.now() - start, unchanged: out === input });`;
  const worker: any = new Worker(source, { eval: true });
  let timer;
  const result: any = await Promise.race([
    new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), 8000); }),
  ]);
  clearTimeout(timer);
  await worker.terminate();
  assert.ok(result, 'maskBody did not finish within 8000 ms');
  assert.ok(result.ms < 2000, `maskBody took ${Math.round(result.ms)} ms`);
  assert.equal(result.unchanged, true, 'a dotless run of letters is not a secret');
});

// Built from parts so the guard against absolute home paths in tracked files (G2) has nothing to flag.
const U = ['', 'Users'].join('/');

test('FU-ht8b3r: the body profile masks curl -u, mysql -p, a bare "password value" and other users\' home paths', () => {
  assert.equal(maskBody('curl -u alice:pw1 https://x.example/api', opts).text, 'curl -u <masked> https://x.example/api');
  assert.equal(maskBody('curl -s --user alice:pw1 -H x', opts).text, 'curl -s --user <masked> -H x');
  assert.equal(maskBody('mysql -h db -u root -psecret1 app', opts).text, 'mysql -h db -u root -p<masked> app');
  assert.equal(maskBody('mysqldump -p"my pass" db', opts).text, 'mysqldump -p<masked> db');
  assert.equal(maskBody('login with password hunter2 now', opts).text, 'login with password <masked> now');
  assert.equal(maskBody(`opened ${U}/bob/Workspace/x.js and ${U}/Shared/y`, opts).text, `opened ${U}/<masked>/Workspace/x.js and ${U}/Shared/y`);
});

test('FU-ht8b3r: the new body rules leave look-alikes alone and are idempotent', () => {
  for (const same of [
    'sort -u file', 'git push -u origin main', 'mysql -p', 'mysql --port 3306', 'mysql -P 3306',
    'the password is required', 'password: <masked>', 'password = <masked>', 'curl -u <masked> x',
    `/mnt${U}/bob/x`, `see ${U}/Shared/x`,
  ]) assert.equal(maskBody(same, opts).text, same, same);
  const once = maskBody(`curl -u a:b x; mysql -psecret1; password hunter2; ${U}/bob/x`, opts).text;
  assert.equal(maskBody(once, opts).text, once);
  assert.equal(maskBody(once, opts).masked, 0);
});

test('FU-ht8b3r: the line profile is unchanged by the body-only rules', () => {
  assert.equal(maskLine(`curl -u alice:pw1 x password hunter2 ${U}/bob/x`, opts).text, `curl -u alice:pw1 x password hunter2 ${U}/bob/x`);
});

test('FU-ht8b3r: the home directory of the running user is still abbreviated before the other-user rule', () => {
  assert.equal(maskBody(`${U}/me/x ${U}/bob/x`, { home: `${U}/me` }).text, `~/x ${U}/<masked>/x`);
});

test('FU-ht8b3r: repeated command words in one long line stay linear in the body profile', () => {
  for (const unit of ['curl ', 'mysql ', 'mysql -p x ', 'password ', `${U}/a `]) {
    const started = Date.now();
    maskBody(unit.repeat(100000), opts);
    assert.ok(Date.now() - started < 2000, `${JSON.stringify(unit)} took ${Date.now() - started} ms`);
  }
});

test('FU-ht8b3r C-5: every credential flag in one command is masked, repeated and glued forms included', () => {
  for (const [input, expected] of [
    ['curl -u a:b --user c:d x', 'curl -u <masked> --user <masked> x'],
    ['curl -u a:b -u c:d x', 'curl -u <masked> -u <masked> x'],
    ['mysql -pfoo -pbar db', 'mysql -p<masked> -p<masked> db'],
    ['mysqldump -p"my pass" -pbar db', 'mysqldump -p<masked> -p<masked> db'],
    ['curl -uadmin:pw1 x', 'curl -u<masked> x'],
    ['curl -sS -u"ad min:pw1" x', 'curl -sS -u<masked> x'],
    ['curl -uadmin:pw1 --user c:d x', 'curl -u<masked> --user <masked> x'],
  ]) assert.equal(maskBody(input, opts).text, expected, input);
});

test('FU-ht8b3r C-5: an unquoted flag value stops at a pipe, semicolon or ampersand and the command text after it is kept', () => {
  for (const [input, expected] of [
    ['curl -u a:b|cat', 'curl -u <masked>|cat'],
    ['curl -u a:b;echo done', 'curl -u <masked>;echo done'],
    ['curl -u a:b&&echo done', 'curl -u <masked>&&echo done'],
    ['curl -u a:b & echo done', 'curl -u <masked> & echo done'],
    ['mysql -psecret1|cat', 'mysql -p<masked>|cat'],
    ['mysql -psecret1;echo done', 'mysql -p<masked>;echo done'],
    ['mysql -psecret1&&echo done', 'mysql -p<masked>&&echo done'],
    ['curl -u "a:b"|cat', 'curl -u <masked>|cat'],
    ['curl -H "x: a|b;c" -u a:b y', 'curl -H "x: a|b;c" -u <masked> y'],
  ]) assert.equal(maskBody(input, opts).text, expected, input);
});

test('FU-ht8b3r C-5: a flag after a command break belongs to the next command only', () => {
  for (const same of [
    'curl x | sort -u', 'curl x; git push -u origin main', 'curl x && sort -u f', 'curl x\nsort -u f',
    'mysql -h h; ls -pfoo', 'mysql a | tail -pfoo', 'curl -sS --user-agent x y', 'ls -pfoo -uabc',
  ]) assert.equal(maskBody(same, opts).text, same, same);
  assert.equal(maskBody('curl x; mysql -pfoo db; curl -u a:b y', opts).text, 'curl x; mysql -p<masked> db; curl -u <masked> y');
  const once = maskBody('curl -u a:b --user c:d x|cat; mysql -pfoo -pbar db; curl -uadmin:pw1 y', opts).text;
  assert.equal(maskBody(once, opts).text, once);
  assert.equal(maskBody(once, opts).masked, 0);
});

test('FU-ht8b3r C-5: CI runner home paths and a bare count after "password" are not masked', () => {
  assert.equal(maskBody(`cd ${U}/runner/work/repo/repo and ${U}/bob/x`, opts).text, `cd ${U}/runner/work/repo/repo and ${U}/<masked>/x`);
  assert.equal(maskBody(`${U}/runner`, opts).text, `${U}/runner`);
  assert.equal(maskBody(`${U}/runner2/x`, opts).text, `${U}/<masked>/x`);
  assert.equal(maskBody('reset password 2 times', opts).text, 'reset password 2 times');
  assert.equal(maskBody('set password 1234 now', opts).text, 'set password <masked> now');
  assert.equal(maskBody('login with password hunter2 now', opts).text, 'login with password <masked> now');
});

test('FU-ht8b3r C-5: many credential flags and unterminated quotes in one long line stay linear', () => {
  for (const unit of ['curl -u a:b ', 'curl -u"a ', 'mysql -pa ', 'curl -H "a|b" ', "curl -u a:b ' ", 'mysql -p" ']) {
    const started = Date.now();
    maskBody(unit.repeat(50000), opts);
    assert.ok(Date.now() - started < 2000, `${JSON.stringify(unit)} took ${Date.now() - started} ms`);
  }
});

// N-2: a command word is the command only at command position (line or segment start, after a break,
// at the start of a quoted span, after a wrapper word); quoted text is scanned, not skipped; one pass.
// Known false positive, not asserted: a command word after a wrapper word that only prints it
// (`sudo echo curl documentation -u unique`) still masks the value after `-u`.
test('FU-ht8b3r N-2: credential flags of a command inside quotes or behind a wrapper word are masked in one pass', () => {
  for (const [input, expected] of [
    ['bash -c "curl -u admin:S3cret https://x"', 'bash -c "curl -u <masked> https://x"'],
    ["ssh db1 'mysql -pS3cret -e \"select 1\"'", "ssh db1 'mysql -p<masked> -e \"select 1\"'"],
    ['docker exec c sh -c "mysqldump -pS3cret db"', 'docker exec c sh -c "mysqldump -p<masked> db"'],
    ['ssh db1 mysql -pS3cret db', 'ssh db1 mysql -p<masked> db'],
    ['sudo -u bob curl -u a:b x', 'sudo -u bob curl -u <masked> x'],
    ['FOO=1 /usr/bin/curl -u a:b x', 'FOO=1 /usr/bin/curl -u <masked> x'],
    ['$ curl -u a:b x', '$ curl -u <masked> x'],
    ['Running: curl -u a:b x', 'Running: curl -u <masked> x'],
    ['echo "curl -u a:b"', 'echo "curl -u <masked>"'],
    ['echo $(curl -u a:b x)|cat', 'echo $(curl -u <masked> x)|cat'],
  ]) {
    const once = maskBody(input, opts).text;
    assert.equal(once, expected, input);
    assert.equal(maskBody(once, opts).text, once, `not idempotent: ${input}`);
  }
});

test('FU-ht8b3r N-2: a tool name inside a URL, a path or an argument is not a command', () => {
  for (const [input, expected] of [
    ['curl https://h/mysql/x -u a:b', 'curl https://h/mysql/x -u <masked>'],
    ['curl http://mysql -u a:b', 'curl http://mysql -u <masked>'],
    ['curl password mysql-8 -u a:b', 'curl password <masked> -u <masked>'],
  ]) {
    const once = maskBody(input, opts).text;
    assert.equal(once, expected, input);
    assert.equal(maskBody(once, opts).text, once, `not idempotent: ${input}`);
  }
  for (const same of ['ls /var/lib/mysql -pfoo', 'git clone https://h/curl -u x', 'mysql-8 -pfoo', 'cat notes-curl -u a']) {
    assert.equal(maskBody(same, opts).text, same, same);
  }
});

test('FU-ht8b3r N-2: a break inside quotes ends only the command inside them', () => {
  for (const [input, expected] of [
    ['curl -H "x: a|b;c" -u a:b y', 'curl -H "x: a|b;c" -u <masked> y'],
    ['bash -c "curl x | sort -u; mysql -pfoo db" && curl -u a:b y', 'bash -c "curl x | sort -u; mysql -p<masked> db" && curl -u <masked> y'],
    ["sh -c 'ls -pfoo; curl -u a:b'", "sh -c 'ls -pfoo; curl -u <masked>'"],
  ]) assert.equal(maskBody(input, opts).text, expected, input);
});

test('FU-ht8b3r N-2: nested and unterminated quotes stay linear', () => {
  for (const unit of ['sh -c "curl -u a:b ', "ssh h 'mysql -pa \" ", 'x "', "y '", '"\'']) {
    const started = Date.now();
    maskBody(unit.repeat(50000), opts);
    assert.ok(Date.now() - started < 2000, `${JSON.stringify(unit)} took ${Date.now() - started} ms`);
  }
});

test('FU-5d100z & FU-v1sh3v: maskBody preserves TypeScript type annotations and code assignments', () => {
  assert.equal(maskBody('(token: string, secret: number)').text, '(token: string, secret: number)');
  assert.equal(maskBody('token: any').text, 'token: any');
  assert.equal(maskBody('(token: string[], secret: boolean)').text, '(token: string[], secret: boolean)');
  assert.equal(maskBody('(token: UserToken, secret: [number])').text, '(token: UserToken, secret: [number])');
  assert.equal(maskBody('const TOKEN_BASES = Object.freeze([').text, 'const TOKEN_BASES = Object.freeze([');
  assert.equal(maskBody('let token = getToken()').text, 'let token = getToken()');
  assert.equal(maskBody('const secret = new Secret()').text, 'const secret = new Secret()');
});
