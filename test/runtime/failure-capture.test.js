'use strict';

// B.1 — the programming-error classifier (IC-010), the failure home and capture switch (IC-011,
// IC-014) and the Node writer with rotation and retention (IC-015). Every spawned process and every
// in-process call runs under a scratch HOME and XDG_CONFIG_HOME (DEC-041).

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { isProgrammingError, errorKind } = require('../../src/runtime/failure/classifier');
const { failureHome, captureSwitch, captureIsOff } = require('../../src/runtime/failure/home');
const { captureFailure, captureError, rotateIfDue, MAX_LINE_BYTES, ROTATE_AT_BYTES } = require('../../src/runtime/failure/capture');

const REPO = path.resolve(__dirname, '..', '..');
const scratch = createScratch('doflow-failure-capture-');
after(() => scratch.remove());

const homeOf = (env) => failureHome(env);
const readLines = (home) => fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function freshEnv(name, extra = {}) {
  const dir = fs.mkdtempSync(path.join(scratch.dir, `${name}-`));
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  fs.mkdirSync(home);
  fs.mkdirSync(xdg);
  return { dir, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, DOFLOW_FAILURE_CAPTURE: '', DOFLOW_AGENT: '', ...extra } };
}

function systemError(code, extra = {}) {
  return Object.assign(new Error(`${code}: boom`), { code, ...extra });
}

describe('classifier (IC-010)', () => {
  const cases = [
    ['TypeError', new TypeError('x'), true],
    ['RangeError', new RangeError('x'), true],
    ['ReferenceError', new ReferenceError('x'), true],
    ['assertion by name', Object.assign(new Error('x'), { name: 'AssertionError' }), true],
    ['assertion by code', Object.assign(new Error('x'), { code: 'ERR_ASSERTION' }), true],
    ['MODULE_NOT_FOUND', Object.assign(new Error('x'), { code: 'MODULE_NOT_FOUND' }), true],
    ['system error with syscall', systemError('ENOENT', { syscall: 'open' }), true],
    ['system error with errno', systemError('EACCES', { errno: -13 }), true],
    ['a TypeError that carries an ERR_ code', Object.assign(new TypeError('x'), { code: 'ERR_INVALID_ARG_TYPE' }), true],
    ['EPIPE on a write', systemError('EPIPE', { syscall: 'write', errno: -32 }), false],
    ['EPIPE without a syscall', systemError('EPIPE'), false],
    ['SyntaxError', new SyntaxError('Unexpected token'), false],
    ['a SyntaxError with a code', Object.assign(new SyntaxError('x'), { code: 'ERR_X', syscall: 'x' }), false],
    ['plain Error', new Error('x'), false],
    ['plain Error with a code but no syscall or errno', Object.assign(new Error('x'), { code: 'E_CUSTOM' }), false],
    ['a handler-defined class', new (class RefusalError extends Error {})('x'), false],
    ['a string', 'boom', false],
    ['null', null, false],
    ['undefined', undefined, false],
    ['a plain object', { message: 'x' }, false],
    ['a numeric code', Object.assign(new Error('x'), { code: 7, syscall: 'x' }), false],
  ];
  for (const [name, error, expected] of cases) {
    test(`${name} -> ${expected}`, () => assert.equal(isProgrammingError(error), expected));
  }

  test('a getter that throws is false, never a throw', () => {
    const hostile = { get code() { throw new Error('no'); }, get name() { throw new Error('no'); } };
    assert.equal(isProgrammingError(hostile), false);
  });

  test('errorKind names the class for the programming-error classes and the code for the rest', () => {
    assert.equal(errorKind(new TypeError('x')), 'TypeError');
    assert.equal(errorKind(Object.assign(new TypeError('x'), { code: 'ERR_INVALID_ARG_TYPE' })), 'TypeError');
    assert.equal(errorKind(systemError('ENOENT', { syscall: 'open' })), 'ENOENT');
    assert.equal(errorKind(Object.assign(new Error('x'), { code: 'MODULE_NOT_FOUND' })), 'MODULE_NOT_FOUND');
    assert.equal(errorKind(Object.assign(new Error('x'), { name: 'AssertionError', code: 'ERR_ASSERTION' })), 'AssertionError');
  });
});

describe('failure home (IC-011)', () => {
  test('XDG_CONFIG_HOME wins when absolute', () => {
    assert.equal(failureHome({ XDG_CONFIG_HOME: '/x/cfg', HOME: '/h' }), '/x/cfg/doflow/failures');
  });
  test('HOME/.config when XDG_CONFIG_HOME is unset or empty', () => {
    assert.equal(failureHome({ HOME: '/h' }), '/h/.config/doflow/failures');
    assert.equal(failureHome({ XDG_CONFIG_HOME: '', HOME: '/h' }), '/h/.config/doflow/failures');
  });
  test('a relative XDG_CONFIG_HOME skips capture even when HOME is usable', () => {
    assert.equal(failureHome({ XDG_CONFIG_HOME: 'cfg', HOME: '/h' }), null);
  });
  test('an unset, empty or relative HOME skips capture', () => {
    assert.equal(failureHome({}), null);
    assert.equal(failureHome({ HOME: '' }), null);
    assert.equal(failureHome({ HOME: 'rel/h' }), null);
  });
  test('Node reads the HOME variable, not os.homedir()', () => {
    assert.equal(failureHome({ HOME: '/only-this' }), '/only-this/.config/doflow/failures');
  });
});

describe('capture switch (IC-014)', () => {
  let ctx;
  beforeEach(() => { ctx = freshEnv('switch'); });

  test('on by default, and stat-ing the sentinel creates no folder', () => {
    const home = homeOf(ctx.env);
    assert.deepEqual(captureSwitch(home, ctx.env), { effective: 'on', sentinel: false, env: null });
    assert.equal(fs.existsSync(home), false);
  });
  for (const value of ['off', 'OFF', '0', 'false', 'No', ' off ']) {
    test(`env ${JSON.stringify(value)} turns capture off`, () => {
      const env = { ...ctx.env, DOFLOW_FAILURE_CAPTURE: value };
      assert.equal(captureIsOff(homeOf(env), env), true);
      assert.equal(captureSwitch(homeOf(env), env).effective, 'off');
    });
  }
  for (const value of ['on', '1', 'true', 'yes', 'whatever']) {
    test(`env ${JSON.stringify(value)} does not turn it off`, () => {
      const env = { ...ctx.env, DOFLOW_FAILURE_CAPTURE: value };
      assert.equal(captureIsOff(homeOf(env), env), false);
    });
  }
  test('the sentinel wins, and an env value of on cannot turn capture on over it', () => {
    const home = homeOf(ctx.env);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'off'), '2026-10-03T00:00:00.000Z\n');
    const env = { ...ctx.env, DOFLOW_FAILURE_CAPTURE: 'on' };
    assert.equal(captureIsOff(home, env), true);
    assert.deepEqual(captureSwitch(home, env), { effective: 'off', sentinel: true, env: 'on' });
  });
  test('while off nothing is written and no folder is created, for either source', () => {
    const viaEnv = { ...ctx.env, DOFLOW_FAILURE_CAPTURE: 'off' };
    assert.equal(captureError(new TypeError('x'), { command: 'decision' }, viaEnv), false);
    assert.equal(fs.existsSync(homeOf(viaEnv)), false);
    const sentinelHome = homeOf(ctx.env);
    fs.mkdirSync(sentinelHome, { recursive: true });
    fs.writeFileSync(path.join(sentinelHome, 'off'), 'x');
    assert.equal(captureError(new TypeError('y'), { command: 'decision' }, ctx.env), false);
    assert.deepEqual(fs.readdirSync(sentinelHome), ['off']);
  });
});

describe('Node writer (IC-011, IC-015)', () => {
  test('writes one IC-011 line with the stored fields only', () => {
    const { env } = freshEnv('line', { DOFLOW_AGENT: 'codex' });
    function brokenHandler() { return null.price; }
    let error;
    try { brokenHandler(); } catch (e) { error = e; }
    assert.equal(captureError(error, { command: 'decision', exit: 1 }, env), true);
    const [line] = readLines(homeOf(env));
    assert.deepEqual(Object.keys(line), ['v', 'at', 'source', 'command', 'harness', 'version', 'project', 'kind', 'message', 'frame', 'exit']);
    assert.equal(line.v, 1);
    assert.match(line.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(line.source, 'cli');
    assert.equal(line.command, 'decision');
    assert.equal(line.harness, 'codex');
    assert.equal(line.version, require('../../package.json').version);
    assert.equal(line.kind, 'TypeError');
    assert.equal(line.exit, 1);
    assert.match(line.message, /^Cannot read properties of null \(reading "\.\.\."\)$/);
    assert.equal(line.frame, 'test/runtime/failure-capture.test.js:brokenHandler');
  });

  test('a stack with no DoFlow frame records frame null', () => {
    const { env } = freshEnv('noframe');
    const error = Object.assign(new TypeError('x'), { stack: 'TypeError: x\n    at Object.run (/elsewhere/other.js:1:1)' });
    captureError(error, { command: 'verify', exit: 1 }, env);
    assert.equal(readLines(homeOf(env))[0].frame, null);
  });

  test('message is the normalised, masked form: secrets, home, paths, quoted text and digits never survive', () => {
    const { env } = freshEnv('mask');
    const secret = `npm_${'a1B2'.repeat(9)}`;
    const home = env.HOME;
    const error = new TypeError(`bad "${secret}" at ${home}/work/app.js line 4242 token=ab12cd34`);
    captureError(error, { command: 'decision', exit: 1 }, env);
    const raw = fs.readFileSync(path.join(homeOf(env), 'events.jsonl'), 'utf8');
    assert.ok(!raw.includes(secret), 'secret stored');
    assert.ok(!raw.includes(home), 'home path stored');
    assert.ok(!raw.includes('4242') && !raw.includes('ab12cd34'));
    assert.equal(readLines(homeOf(env))[0].message, 'bad "..." at <path> line N token=<masked>');
  });

  test('project is the working directory with the home prefix as ~', () => {
    const { env } = freshEnv('project');
    fs.mkdirSync(path.join(env.HOME, 'work', 'app'), { recursive: true });
    const result = spawnSync(process.execPath, ['-e', `
      const { captureError } = require(${JSON.stringify(path.join(REPO, 'src/runtime/failure/capture'))});
      captureError(new TypeError('x'), { command: 'verify', exit: 1 });
    `], { cwd: path.join(env.HOME, 'work', 'app'), env, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(readLines(homeOf(env))[0].project, '~/work/app');
  });

  test('command is a name or unknown, never an argument value', () => {
    const { env } = freshEnv('command');
    captureFailure({ source: 'cli', command: '/example/arg value', kind: 'TypeError' }, env);
    captureFailure({ source: 'cli', command: undefined, kind: 'TypeError' }, env);
    captureFailure({ source: 'cli', command: 'followup', kind: 'TypeError' }, env);
    assert.deepEqual(readLines(homeOf(env)).map((l) => l.command), ['unknown', 'unknown', 'followup']);
  });

  test('harness is none unless DOFLOW_AGENT is a plain name', () => {
    const { env } = freshEnv('harness', { DOFLOW_AGENT: 'a b; rm -rf' });
    captureFailure({ source: 'cli', command: 'x1', kind: 'TypeError' }, env);
    assert.equal(readLines(homeOf(env))[0].harness, 'none');
  });

  test('a programming error is recorded; a plain Error, SyntaxError and EPIPE are not', () => {
    const { env } = freshEnv('filter');
    assert.equal(captureError(new Error('refusal'), { command: 'decision' }, env), false);
    assert.equal(captureError(new SyntaxError('x'), { command: 'decision' }, env), false);
    assert.equal(captureError(systemError('EPIPE', { syscall: 'write' }), { command: 'decision' }, env), false);
    assert.equal(fs.existsSync(homeOf(env)), false);
  });

  test('one error object caught at two points is recorded once', () => {
    const { env } = freshEnv('twice');
    const error = new TypeError('once');
    assert.equal(captureError(error, { command: 'decision', exit: 2 }, env), true);
    assert.equal(captureError(error, { command: 'decision', exit: 1 }, env), false);
    assert.equal(readLines(homeOf(env)).length, 1);
  });

  test('an uncaught throw is recorded under uncaught:<kind>', () => {
    const { env } = freshEnv('uncaught');
    captureError(Object.assign(new Error('x'), { code: 'MODULE_NOT_FOUND' }), { command: 'unknown', uncaught: true, exit: 1 }, env);
    assert.equal(readLines(homeOf(env))[0].kind, 'uncaught:MODULE_NOT_FOUND');
  });

  test('a line is at most 2048 bytes including the newline; message is cut first, then project', () => {
    const { env } = freshEnv('size');
    const longProject = path.join(env.HOME, 'p'.repeat(150));
    fs.mkdirSync(longProject, { recursive: true });
    const result = spawnSync(process.execPath, ['-e', `
      const { captureFailure } = require(${JSON.stringify(path.join(REPO, 'src/runtime/failure/capture'))});
      captureFailure({ source: 'cli', command: 'verify', kind: 'TypeError', message: 'm'.repeat(5000), frame: 'f'.repeat(300) });
    `], { cwd: longProject, env, encoding: 'utf8' });
    assert.equal(result.status, 0);
    const raw = fs.readFileSync(path.join(homeOf(env), 'events.jsonl'), 'utf8');
    assert.ok(Buffer.byteLength(raw) <= MAX_LINE_BYTES, `line is ${Buffer.byteLength(raw)} bytes`);
    const [line] = readLines(homeOf(env));
    assert.ok(line.message.length < 5000);
    assert.equal(line.frame.length, 300, 'frame is not the field that gets cut');
  });

  test('a multibyte message still ends under the cap', () => {
    const { env } = freshEnv('multibyte');
    captureFailure({ source: 'cli', command: 'verify', kind: 'TypeError', message: '\u00e9'.repeat(3000) }, env);
    assert.ok(Buffer.byteLength(fs.readFileSync(path.join(homeOf(env), 'events.jsonl'), 'utf8')) <= MAX_LINE_BYTES);
  });

  test('the folder is 0700 and a new file is 0600', { skip: process.platform === 'win32' }, () => {
    const { env } = freshEnv('modes');
    captureFailure({ source: 'cli', command: 'verify', kind: 'TypeError' }, env);
    const home = homeOf(env);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(home, 'events.jsonl')).mode & 0o777, 0o600);
  });

  test('appends: a second capture adds a second line', () => {
    const { env } = freshEnv('append');
    captureFailure({ source: 'cli', command: 'verify', kind: 'TypeError' }, env);
    captureFailure({ source: 'cli', command: 'verify', kind: 'TypeError' }, env);
    assert.equal(readLines(homeOf(env)).length, 2);
  });

  test('an unwritable store is silent: no throw, nothing on stdout or stderr', () => {
    const { dir, env } = freshEnv('unwritable');
    // XDG_CONFIG_HOME names a regular file, so the folder cannot be created.
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const broken = { ...env, XDG_CONFIG_HOME: blocker };
    assert.equal(captureError(new TypeError('x'), { command: 'verify', exit: 1 }, broken), false);
    const result = spawnSync(process.execPath, ['-e', `
      const { captureError } = require(${JSON.stringify(path.join(REPO, 'src/runtime/failure/capture'))});
      captureError(new TypeError('x'), { command: 'verify', exit: 1 });
    `], { env: broken, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  test('a successful capture also writes no byte to stdout or stderr', () => {
    const { env } = freshEnv('silent');
    const result = spawnSync(process.execPath, ['-e', `
      const { captureError } = require(${JSON.stringify(path.join(REPO, 'src/runtime/failure/capture'))});
      captureError(new TypeError('x'), { command: 'verify', exit: 1 });
    `], { env, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(readLines(homeOf(env)).length, 1);
  });

  test('an unset HOME with no XDG_CONFIG_HOME writes nothing and does not throw', () => {
    const env = { ...process.env };
    delete env.HOME;
    delete env.XDG_CONFIG_HOME;
    assert.equal(captureError(new TypeError('x'), { command: 'verify', exit: 1 }, env), false);
  });
});

describe('rotation and retention (IC-015)', () => {
  const big = (file) => { fs.writeFileSync(file, ''); fs.truncateSync(file, ROTATE_AT_BYTES); };

  test('below 1 MiB nothing rotates', () => {
    const { env } = freshEnv('rot-below');
    const home = homeOf(env);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'events.jsonl'), 'x'.repeat(ROTATE_AT_BYTES - 1));
    assert.equal(rotateIfDue(home), false);
    assert.deepEqual(fs.readdirSync(home), ['events.jsonl']);
  });

  test('at 1 MiB the file is renamed and the next line goes to a new events.jsonl', () => {
    const { env } = freshEnv('rot-at');
    const home = homeOf(env);
    fs.mkdirSync(home, { recursive: true });
    big(path.join(home, 'events.jsonl'));
    assert.equal(captureFailure({ source: 'cli', command: 'verify', kind: 'TypeError' }, env), true);
    const names = fs.readdirSync(home).sort();
    assert.equal(names.length, 2);
    const rotated = names.find((n) => n !== 'events.jsonl');
    assert.match(rotated, new RegExp(`^events-\\d{8}T\\d{6}Z-${process.pid}\\.jsonl$`));
    assert.equal(fs.statSync(path.join(home, rotated)).size, ROTATE_AT_BYTES);
    assert.equal(readLines(home).length, 1);
  });

  test('only the newest four rotated files are kept', () => {
    const { env } = freshEnv('rot-keep');
    const home = homeOf(env);
    fs.mkdirSync(home, { recursive: true });
    const old = ['20250101T000000Z-1', '20250102T000000Z-1', '20250103T000000Z-1', '20250104T000000Z-1', '20250105T000000Z-1'];
    for (const stampName of old) fs.writeFileSync(path.join(home, `events-${stampName}.jsonl`), '');
    fs.writeFileSync(path.join(home, 'settlements.jsonl'), '');
    big(path.join(home, 'events.jsonl'));
    assert.equal(rotateIfDue(home), true);
    const rotated = fs.readdirSync(home).filter((n) => n.startsWith('events-')).sort();
    assert.equal(rotated.length, 4);
    assert.ok(!rotated.includes('events-20250101T000000Z-1.jsonl') && !rotated.includes('events-20250102T000000Z-1.jsonl'));
    assert.ok(fs.existsSync(path.join(home, 'settlements.jsonl')), 'settlements are never rotated or pruned');
  });

  test('a rename lost to another process is ignored and capture goes on', () => {
    const { env } = freshEnv('rot-race');
    const home = homeOf(env);
    fs.mkdirSync(home, { recursive: true });
    assert.equal(rotateIfDue(home), false, 'no live file to rename');
    assert.equal(captureFailure({ source: 'cli', command: 'verify', kind: 'TypeError' }, env), true);
  });
});
