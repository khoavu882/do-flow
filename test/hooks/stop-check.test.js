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
    const r = stop('claude', { session_id: 's1', transcript_path: transcript(lines) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /TODO|stub/);
  });
  test(`${shape} transcript shape: a clean last assistant turn exits 0`, () => {
    const r = stop('claude', { session_id: 's1', transcript_path: transcript(lines.slice(0, cleanLines)) });
    assert.equal(r.code, 0);
  });
}

test('payload last_assistant_message with a TODO exits 2 without a transcript', () => {
  assert.equal(stop('claude', { session_id: 's1', last_assistant_message: '// TODO: finish' }).code, 2);
});

test('a present last_assistant_message key, even null, wins over a transcript that has a TODO', () => {
  const t = transcript(fixtureLines('legacy'));
  assert.equal(stop('claude', { session_id: 's1', transcript_path: t, last_assistant_message: null }).code, 0);
  assert.equal(stop('claude', { session_id: 's1', transcript_path: t, last_assistant_message: '' }).code, 0);
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
  const r = stop('claude', { session_id: 's1', transcript_path: transcript([...lines, '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"# TO']) });
  assert.equal(r.code, 0);
});

test('a tool_use-only final entry leaves the last text turn in charge', () => {
  const toolOnly = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"# TODO"}}]}}';
  assert.equal(stop('claude', { session_id: 's1', transcript_path: transcript([...fixtureLines('claude').slice(0, 3), toolOnly]) }).code, 0);
});

test('a foreign transcript schema exits 0 (fail open)', () => {
  for (const line of ['{"message":"no role field here, # TODO"}', '{"foo":["# TODO"]}', '[1,2]', 'not json']) {
    assert.equal(stop('claude', { session_id: 's1', transcript_path: transcript([line]) }).code, 0, line);
  }
});

test('a missing transcript file or path exits 0', () => {
  assert.equal(stop('claude', { session_id: 's1', transcript_path: path.join(scratch.dir, 'absent.jsonl') }).code, 0);
  assert.equal(stop('claude', { session_id: 's1' }).code, 0);
});

test('codex front door: a stub exits 2 with the reason on stderr, clean prints {} and exits 0', () => {
  const stub = stop('codex', { session_id: 's1', transcript_path: transcript(fixtureLines('codex')) });
  assert.equal(stub.code, 2);
  assert.match(stub.stderr, /TODO|stub/);
  const clean = stop('codex', { session_id: 's1', transcript_path: transcript(fixtureLines('codex').slice(0, 2)) });
  assert.equal(clean.code, 0);
  assert.equal(clean.stdout.trim(), '{}');
});

test('codex front door: a crashing policy prints {} and exits 0', () => {
  const policy = path.join(mirror, '.doflow', 'shared', 'hooks', 'policies', 'stop-check.sh');
  const original = fs.readFileSync(policy);
  fs.writeFileSync(policy, '#!/usr/bin/env bash\nexit 1\n');
  try {
    const r = stop('codex', { session_id: 's1', last_assistant_message: '# TODO: x' });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '{}');
  } finally {
    fs.writeFileSync(policy, original);
  }
});
