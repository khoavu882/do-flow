'use strict';

// post-compact.sh saves the summary for the session that follows a compaction; the first prompt of
// that session injects it once, bounded, and consumes the file. Runs the installed front doors of an
// install-shaped mirror under a scratch HOME.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');

const REPO = path.resolve(__dirname, '..', '..');
const scratch = createScratch('doflow-compact-summary-');
const mirror = path.join(scratch.dir, 'mirror');
const SUMMARY_DIR = path.join(scratch.xdg, 'doflow', 'session-env', 'projects');

test.before(() => {
  const built = spawnSync('bash', [path.join(REPO, 'test', 'hooks', 'build-install-mirror.sh'), mirror], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
});
test.after(() => scratch.remove());

let seq = 0;
/** A fresh project directory, so each test owns its own summary file. `branch` makes it a git repo. */
function project(branch) {
  const dir = path.join(scratch.dir, `proj${seq++}`);
  fs.mkdirSync(dir);
  if (branch) {
    const r = spawnSync('git', ['init', '-q', '-b', branch, dir], { env: scratch.env(), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  return fs.realpathSync(dir);
}

function hook(harness, script, payload, env = {}) {
  const r = spawnSync('bash', [path.join(mirror, `.${harness}`, 'hooks', script)], {
    input: JSON.stringify(payload), env: scratch.env(env), encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function compact(sessionId, cwd, summary) {
  hook('claude', 'post-compact.sh', { session_id: sessionId, cwd, trigger: 'auto', compact_summary: summary });
}

/** One prompt of a session: session-start on its first call, then the prompt hook. Returns the injected context. */
function prompt(harness, sessionId, cwd, { first = true, env } = {}) {
  if (first) hook(harness, 'session-start.sh', { session_id: sessionId, cwd, source: 'startup' });
  const out = JSON.parse(hook(harness, 'user-prompt-submit.sh', { session_id: sessionId, cwd }, env) || '{}');
  return out.additionalContext ?? out.hookSpecificOutput?.additionalContext ?? '';
}

/** The saved summary for a project directory, or undefined once it has been consumed. */
function summaryFileFor(cwd) {
  const lib = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies', 'lib.sh');
  const hash = spawnSync('bash', ['-c', 'source "$1"; cwd_hash "$2"', 'bash', lib, cwd], { env: scratch.env(), encoding: 'utf8' }).stdout.trim();
  const file = path.join(SUMMARY_DIR, hash, 'last-compact-summary.md');
  return fs.existsSync(file) ? file : undefined;
}

test('a fresh Claude session gets the summary once and the file is consumed; a later Codex session gets nothing', () => {
  const cwd = project();
  compact('A', cwd, 'SUMMARY-TWO');
  assert.ok(summaryFileFor(cwd));
  assert.match(prompt('claude', 'C', cwd), /SUMMARY-TWO/);
  assert.equal(summaryFileFor(cwd), undefined);
  assert.doesNotMatch(prompt('codex', 'D', cwd), /SUMMARY-TWO/);
});

test('the session that compacted skips the summary and leaves the file', () => {
  const cwd = project();
  compact('A', cwd, 'SUMMARY-THREE');
  assert.doesNotMatch(prompt('claude', 'A', cwd), /SUMMARY-THREE/);
  assert.ok(summaryFileFor(cwd));
  assert.match(prompt('claude', 'E', cwd), /SUMMARY-THREE/);
});

test('a 30,000-character summary is cut to 4000 characters with a truncation marker', () => {
  const cwd = project();
  compact('A', cwd, 'é'.repeat(30000));
  const ctx = prompt('claude', 'F', cwd);
  const body = ctx.slice(ctx.indexOf('\n', ctx.indexOf('[Prior session summary')) + 1);
  assert.match(body, /^é{4000}\n\[summary truncated: first 4000 of 30000 characters\]$/);
});

test('a summary under the cap is injected whole with no marker', () => {
  const cwd = project();
  compact('A', cwd, 'x'.repeat(4000));
  const ctx = prompt('claude', 'G', cwd);
  assert.ok(ctx.includes('x'.repeat(4000)));
  assert.doesNotMatch(ctx, /summary truncated/);
});

test('the header names the compaction time and branch from the file, and omits what is unknown', () => {
  const withBranch = project('topic');
  compact('A', withBranch, 'S');
  assert.match(prompt('claude', 'H', withBranch), /^\[Prior session summary, compacted \d{4}-\d\d-\d\dT[\d:]+Z on branch topic\]$/m);
  const noBranch = project();
  compact('A', noBranch, 'S');
  const ctx = prompt('claude', 'I', noBranch);
  assert.match(ctx, /^\[Prior session summary, compacted \d{4}-\d\d-\d\dT[\d:]+Z\]$/m);
  assert.doesNotMatch(ctx, /unknown/);
});

/** A `jq` ahead of the real one on PATH that runs `before` (bash) on every call, then execs the real jq. */
function fakeJq(before) {
  const bin = path.join(scratch.dir, `bin${seq++}`);
  fs.mkdirSync(bin);
  const real = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(bin, 'jq'), `#!/usr/bin/env bash\n${before}\nexec "${real}" "$@"\n`, { mode: 0o755 });
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}
const REJECT_RAWFILE = 'for a in "$@"; do [ "$a" = --rawfile ] && exit 2; done';

test('a jq without --rawfile support does not fail the hook and does not wedge the next prompt', () => {
  const cwd = project();
  compact('A', cwd, 'SUMMARY-NORAW');
  assert.doesNotMatch(prompt('claude', 'J', cwd, { env: fakeJq(REJECT_RAWFILE) }), /SUMMARY-NORAW/);
  assert.equal(prompt('claude', 'J', cwd, { first: false }), '');
  assert.ok(prompt('claude', 'K', cwd), 'a later session still gets its context');
});

test('an unreadable summary file does not fail the hook', { skip: process.getuid?.() === 0 }, () => {
  const cwd = project();
  compact('A', cwd, 'SUMMARY-LOCKED');
  fs.chmodSync(summaryFileFor(cwd), 0o000);
  assert.doesNotMatch(prompt('claude', 'L', cwd), /SUMMARY-LOCKED/);
  assert.equal(prompt('claude', 'L', cwd, { first: false }), '');
});

test('a symlinked summary file is not followed', () => {
  const cwd = project();
  compact('A', cwd, 'placeholder');
  const file = summaryFileFor(cwd);
  const target = path.join(scratch.dir, 'secret.md');
  fs.writeFileSync(target, '---\nsession_id: A\n---\n\nSYMLINK-SECRET\n');
  fs.rmSync(file);
  fs.symlinkSync(target, file);
  assert.doesNotMatch(prompt('claude', 'M', cwd), /SYMLINK-SECRET/);
});

test('the file is claimed before it is read: a summary written meanwhile survives', () => {
  const cwd = project();
  compact('A', cwd, 'SUMMARY-OLD');
  const file = summaryFileFor(cwd);
  const writeNewer = `for a in "$@"; do [ "$a" = --rawfile ] && printf -- '---\\nsession_id: Z\\n---\\n\\nSUMMARY-NEWER\\n' > "${file}"; done`;
  assert.match(prompt('claude', 'N', cwd, { env: fakeJq(writeNewer) }), /SUMMARY-OLD/);
  assert.match(fs.readFileSync(file, 'utf8'), /SUMMARY-NEWER/);
});

test('a CRLF summary written by the session itself is still recognised and skipped', () => {
  const cwd = project();
  compact('A', cwd, 'SUMMARY-CRLF');
  const file = summaryFileFor(cwd);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  assert.doesNotMatch(prompt('claude', 'A', cwd), /SUMMARY-CRLF/);
  assert.ok(summaryFileFor(cwd));
});

test('an oversized summary file is read in bounded form and cut to the cap', () => {
  const cwd = project();
  compact('A', cwd, 'y'.repeat(1000000));
  const ctx = prompt('claude', 'O', cwd);
  assert.ok(ctx.length < 5000, `context is ${ctx.length} characters`);
  assert.match(ctx, /\[summary truncated: first 4000 of at least \d+ characters\]$/);
});
