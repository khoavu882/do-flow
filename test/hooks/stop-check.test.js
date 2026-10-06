'use strict';

// The Stop policy reads the payload's last_assistant_message, falls back to the transcript in the
// shapes Claude Code, Codex and the flat {role,content} fixture write, and blocks (exit 2) on an
// unfinished-work marker. Everything runs against an install-shaped mirror under a scratch HOME.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');

const REPO = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(REPO, 'test', 'fixtures', 'transcripts');
const scratch = createScratch('doflow-stop-check-');
const mirror = path.join(scratch.dir, 'mirror');

test.before(() => {
  const built = spawnSync('bash', [path.join(REPO, 'test', 'hooks', 'build-install-mirror.sh'), mirror], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
});
test.after(() => scratch.remove());

/** Runs a harness's installed stop-check front door; payload is an object or a raw string. */
function stop(harness, payload) {
  const r = spawnSync('bash', [path.join(mirror, `.${harness}`, 'hooks', 'stop-check.sh')], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: scratch.env(),
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Each call gets its own session: a blocked message is not blocked a second time in the same session.
let sidSeq = 0;
const sid = () => `s${sidSeq++}`;

let seq = 0;
function transcript(lines) {
  const file = path.join(scratch.dir, `t${seq++}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''));
  return file;
}
function fixtureLines(name) {
  return fs.readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean);
}

// Each recorded fixture ends on the TODO turn; its clean turn is the prefix of this many lines.
const SHAPES = [['claude', 3], ['codex', 2], ['legacy', 2]];

for (const [shape, cleanLines] of SHAPES) {
  const lines = fixtureLines(shape);
  test(`${shape} transcript shape: a TODO in the last assistant turn exits 2`, () => {
    const r = stop('claude', { session_id: sid(), transcript_path: transcript(lines) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /TODO|stub/);
  });
  test(`${shape} transcript shape: a clean last assistant turn exits 0`, () => {
    const r = stop('claude', { session_id: sid(), transcript_path: transcript(lines.slice(0, cleanLines)) });
    assert.equal(r.code, 0);
  });
}

test('payload last_assistant_message with a TODO exits 2 without a transcript', () => {
  assert.equal(stop('claude', { session_id: sid(), last_assistant_message: '// TODO: finish' }).code, 2);
});

test('a present last_assistant_message key, even null, wins over a transcript that has a TODO', () => {
  const t = transcript(fixtureLines('legacy'));
  assert.equal(stop('claude', { session_id: sid(), transcript_path: t, last_assistant_message: null }).code, 0);
  assert.equal(stop('claude', { session_id: sid(), transcript_path: t, last_assistant_message: '' }).code, 0);
});

test('stop_hook_active exits 0 even with a TODO, and still drains the lint queue', () => {
  const queueDir = path.join(scratch.xdg, 'doflow', 'session-env', 'sessions', 's-active');
  fs.mkdirSync(queueDir, { recursive: true });
  const queue = path.join(queueDir, 'edited-files.txt');
  fs.writeFileSync(queue, 'a.txt\n');
  const r = stop('claude', { session_id: 's-active', stop_hook_active: true, transcript_path: transcript(fixtureLines('legacy')) });
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(queue), false, 'the edited-files queue is drained');
  assert.equal(fs.existsSync(`${queue}.proc`), false);
});

test('a partial last line is skipped and the last complete clean turn decides', () => {
  const lines = fixtureLines('claude').slice(0, 3);
  const r = stop('claude', { session_id: sid(), transcript_path: transcript([...lines, '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"# TO']) });
  assert.equal(r.code, 0);
});

test('a tool_use-only final entry leaves the last text turn in charge', () => {
  const toolOnly = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"# TODO"}}]}}';
  assert.equal(stop('claude', { session_id: sid(), transcript_path: transcript([...fixtureLines('claude').slice(0, 3), toolOnly]) }).code, 0);
});

test('a foreign transcript schema exits 0 (fail open)', () => {
  for (const line of ['{"message":"no role field here, # TODO"}', '{"foo":["# TODO"]}', '[1,2]', 'not json']) {
    assert.equal(stop('claude', { session_id: sid(), transcript_path: transcript([line]) }).code, 0, line);
  }
});

test('a missing transcript file or path exits 0', () => {
  assert.equal(stop('claude', { session_id: sid(), transcript_path: path.join(scratch.dir, 'absent.jsonl') }).code, 0);
  assert.equal(stop('claude', { session_id: sid() }).code, 0);
});

test('codex front door: a stub exits 2 with the reason on stderr, clean prints {} and exits 0', () => {
  const stub = stop('codex', { session_id: sid(), transcript_path: transcript(fixtureLines('codex')) });
  assert.equal(stub.code, 2);
  assert.match(stub.stderr, /TODO|stub/);
  const clean = stop('codex', { session_id: sid(), transcript_path: transcript(fixtureLines('codex').slice(0, 2)) });
  assert.equal(clean.code, 0);
  assert.equal(clean.stdout.trim(), '{}');
});

test('codex front door: a crashing policy prints {} and exits 0', () => {
  const policy = path.join(mirror, '.doflow', 'shared', 'hooks', 'policies', 'stop-check.sh');
  const original = fs.readFileSync(policy);
  fs.writeFileSync(policy, '#!/usr/bin/env bash\nexit 1\n');
  try {
    const r = stop('codex', { session_id: sid(), last_assistant_message: '# TODO: x' });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '{}');
  } finally {
    fs.writeFileSync(policy, original);
  }
});

test('a large message with an early marker still exits 2', () => {
  const r = stop('claude', { session_id: sid(), last_assistant_message: `# TODO: x\n${'a'.repeat(100000)}` });
  assert.equal(r.code, 2);
});

test('the same blocked message blocks once; a different message blocks again', () => {
  const session = sid();
  const say = (text) => stop('claude', { session_id: session, last_assistant_message: text });
  assert.equal(say('# TODO: one').code, 2);
  assert.equal(say('# TODO: one').code, 0, 'the unchanged continuation is let through');
  assert.equal(say('# TODO: two').code, 2, 'new text is judged afresh');
});

test('without a session_id the once-only guard is keyed by the transcript', () => {
  const t = transcript(fixtureLines('legacy'));
  const run = (file) => stop('claude', { transcript_path: file });
  assert.equal(run(t).code, 2);
  assert.equal(run(t).code, 0);
  assert.equal(run(transcript(fixtureLines('legacy'))).code, 2, 'another conversation is not excused');
});

test('linter output reaches the caller on stderr, so a Codex Stop prints only {}', () => {
  const bin = path.join(scratch.dir, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ruff'), '#!/bin/sh\n[ "$1" = check ] && echo "a.py:1:1: E501 line too long"\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gofmt'), '#!/bin/sh\necho "b.go:2:1: expected declaration" >&2\nexit 0\n', { mode: 0o755 });
  const session = sid();
  const queueDir = path.join(scratch.xdg, 'doflow', 'session-env', 'sessions', session);
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, 'edited-files.txt'), 'a.py\nb.go\n');
  const r = spawnSync('bash', [path.join(mirror, '.codex', 'hooks', 'stop-check.sh')], {
    input: JSON.stringify({ session_id: session }),
    env: scratch.env({ PATH: `${bin}${path.delimiter}${process.env.PATH}` }),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '{}');
  assert.match(r.stderr, /E501 line too long/);
  assert.match(r.stderr, /expected declaration/);
});

// Text that only resembles a marker is not an unfinished-work comment.
for (const text of [
  'See http://todo-app.example.com for the demo.',
  'The board is at https://todo.example.com/x/y.',
  'See (https://todo.example.com/x) and "http://todo.example.com".',
  '## TODO list\n\n- done',
  '### FIXME notes',
  '# Todo',
  '# Fixme list',
  'I removed the // TODO comment',
  'I removed the # TODO comments.',
]) {
  test(`prose that resembles a marker does not block: ${JSON.stringify(text)}`, () => {
    assert.equal(stop('claude', { session_id: sid(), last_assistant_message: text }).code, 0);
  });
}

// Every real stub shape keeps blocking, including next to the prose above.
for (const text of [
  '// TODO: finish',
  '# TODO implement this',
  '# todo: later',
  '    # FIXME broken',
  'x = 1  // TODO fix',
  '```js\n// TODO: handle errors\n```',
  'def f():\n    raise NotImplementedError',
  "throw new Error('Not implemented')",
  '// stub',
  'See http://a.example.com\n// TODO: finish',
  '## Plan\n# TODO: finish',
  '# Todo\n# TODO: finish',
  '## Step 2 // TODO: wire up',
  '## raise NotImplementedError',
  '```python\n## TODO: implement parse\n```',
  '// TODO comment out debug logging',
  'x=1 # TODO markers: implement',
  '# FIXME markers in parser',
  'fetch("http://a.b/c")//TODO implement',
  'I removed the // TODO comment but // TODO: wire up',
]) {
  test(`a real stub still blocks: ${JSON.stringify(text)}`, () => {
    assert.equal(stop('claude', { session_id: sid(), last_assistant_message: text }).code, 2);
  });
}

// The prose filter must stay linear in the line length. Each case is timed at 20000 and 100000
// characters: an absolute bound, and a bound relative to the small run so a slow machine does not
// fail it (a quadratic filter took 33 times longer at 100000 than at 20000).
function timedStop(text) {
  const start = process.hrtime.bigint();
  const r = stop('claude', { session_id: sid(), last_assistant_message: text });
  return { code: r.code, seconds: Number(process.hrtime.bigint() - start) / 1e9 };
}
for (const [name, build, expected] of [
  ['one long line with no URL', (n) => 'a'.repeat(n), 0],
  ['one long line with a marker', (n) => `# TODO: x\n${'a'.repeat(n)}`, 2],
  ['one long line of repeated URLs', (n) => 'http://x'.repeat(n / 8), 0],
  ['repeated URLs, then a marker', (n) => `${'http://x'.repeat(n / 8)}\n// TODO: y`, 2],
  ['a long scheme-like run before ://', (n) => `${'a'.repeat(n)}://b`, 0],
]) {
  test(`the prose filter is linear: ${name}`, () => {
    const small = timedStop(build(20000));
    const large = timedStop(build(100000));
    assert.equal(small.code, expected);
    assert.equal(large.code, expected);
    assert.ok(large.seconds < 2, `100000 characters took ${large.seconds}s`);
    assert.ok(large.seconds < small.seconds * 6 + 0.3, `${large.seconds}s at 100000 against ${small.seconds}s at 20000`);
  });
}

test('2000 repeated URLs finish quickly and a marker after them still blocks', () => {
  const r = timedStop(`${'http://x'.repeat(2000)}\n// TODO: y`);
  assert.equal(r.code, 2);
  assert.ok(r.seconds < 2, `took ${r.seconds}s`);
});
