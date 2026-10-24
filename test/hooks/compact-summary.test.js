'use strict';

// post-compact.sh saves the summary for the session that follows a compaction; the first prompt of
// that session injects it once, bounded, and consumes the file. Runs the installed front doors of an
// install-shaped mirror under a scratch HOME.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');

const REPO = path.resolve(__dirname, '..', '..');
const scratch = createScratch('doflow-compact-summary-');
const mirror = path.join(scratch.dir, 'mirror');
const SUMMARY_DIR = path.join(scratch.xdg, 'doflow', 'session-env', 'projects');
const SCOPE_DIR = path.join(scratch.xdg, 'doflow', 'session-env', 'summaries');

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

function preCompact(root, harness, cwd, env = {}) {
  const payload = { session_id: 'PRECOMPACT', ...(cwd === undefined ? {} : { cwd }) };
  const r = spawnSync('bash', [path.join(root, `.${harness}`, 'hooks', 'pre-compact.sh')], {
    input: JSON.stringify(payload), env: scratch.env(env), encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function compact(sessionId, cwd, summary, env) {
  hook('claude', 'post-compact.sh', { session_id: sessionId, cwd, trigger: 'auto', compact_summary: summary }, env);
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
  const file = path.join(SCOPE_DIR, hash, 'local', 'main', 'summary.md');
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

/** A PATH holding every tool the real PATH does except a `timeout` binary, as on a stock macOS: the
 * branch lookup must then run git directly rather than lose the branch. */
function pathWithoutTimeout() {
  const bin = path.join(scratch.dir, `bin${seq++}`);
  fs.mkdirSync(bin);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (name === 'timeout' || name === 'gtimeout' || fs.existsSync(path.join(bin, name))) continue;
      try { fs.symlinkSync(path.join(dir, name), path.join(bin, name)); } catch { /* unreadable entry */ }
    }
  }
  return { PATH: bin };
}

test('the header names the compaction time and branch from the file, with no timeout binary on PATH, and omits what is unknown', () => {
  const withBranch = project('topic');
  compact('A', withBranch, 'S', pathWithoutTimeout());
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
  // DEC-038: the render fault released the slot, so the next prompt bootstraps (the claimed summary
  // is not restored).
  const again = prompt('claude', 'J', cwd, { first: false });
  assert.doesNotMatch(again, /SUMMARY-NORAW/);
  assert.equal(again, 'Not a git repository.');
  assert.ok(prompt('claude', 'K', cwd), 'a later session still gets its context');
});

test('an unreadable summary file does not fail the hook', { skip: process.getuid?.() === 0 }, () => {
  const cwd = project();
  compact('A', cwd, 'SUMMARY-LOCKED');
  fs.chmodSync(summaryFileFor(cwd), 0o000);
  assert.doesNotMatch(prompt('claude', 'L', cwd), /SUMMARY-LOCKED/);
  // DEC-038: the render fault released the slot, so the next prompt bootstraps without the summary.
  assert.equal(prompt('claude', 'L', cwd, { first: false }), 'Not a git repository.');
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

// ── Session role (DOFLOW_SESSION_ROLE) ──────────────────────────────────────────

/** Like hook(), but returns stderr too, for the cases that assert on the diagnostic line. */
function hookRaw(harness, script, payload, env = {}) {
  const r = spawnSync('bash', [path.join(mirror, `.${harness}`, 'hooks', script)], {
    input: JSON.stringify(payload), env: scratch.env(env), encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return { stdout: r.stdout, stderr: r.stderr };
}

/** The project state directory for a working directory, whether or not anything is saved in it yet. */
function projectDirFor(cwd) {
  const lib = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies', 'lib.sh');
  const hash = spawnSync('bash', ['-c', 'source "$1"; cwd_hash "$2"', 'bash', lib, cwd], { env: scratch.env(), encoding: 'utf8' }).stdout.trim();
  const dir = path.join(SUMMARY_DIR, hash);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const WORKER = { DOFLOW_SESSION_ROLE: 'worker' };

test('a worker compaction leaves the pending main summary and meta.json byte-identical', () => {
  const cwd = project();
  compact('A', cwd, 'MAIN-SUMMARY');
  const dir = projectDirFor(cwd);
  fs.writeFileSync(path.join(dir, 'meta.json'), '{"compacted_at":"2020-01-01T00:00:00Z"}\n');
  const summary = path.join(SCOPE_DIR, path.basename(dir), 'local', 'main', 'summary.md');
  const summaryBefore = fs.readFileSync(summary);
  const metaBefore = fs.readFileSync(path.join(dir, 'meta.json'));
  compact('W', cwd, 'WORKER-SUMMARY', WORKER);
  assert.deepEqual(fs.readFileSync(summary), summaryBefore);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'meta.json')), metaBefore);
});

test('a worker compaction writes nothing when no summary is pending', () => {
  const cwd = project();
  compact('W', cwd, 'WORKER-SUMMARY', WORKER);
  assert.equal(summaryFileFor(cwd), undefined);
});

for (const harness of ['claude', 'codex']) {
  test(`a worker first prompt on ${harness} injects nothing and leaves the summary and warning`, () => {
    const cwd = project('topic');
    compact('A', cwd, 'MAIN-SUMMARY');
    const warning = path.join(projectDirFor(cwd), 'uncommitted-warning.txt');
    fs.writeFileSync(warning, 'MAIN-WARNING');
    const out = hook(harness, 'user-prompt-submit.sh', { session_id: 'W', cwd }, WORKER);
    hook(harness, 'session-start.sh', { session_id: 'W2', cwd, source: 'startup' });
    const withStart = hook(harness, 'user-prompt-submit.sh', { session_id: 'W2', cwd }, WORKER);
    for (const text of [out, withStart]) {
      assert.deepEqual(JSON.parse(text), {});
      assert.doesNotMatch(text, /MAIN-SUMMARY|MAIN-WARNING|Git context/);
    }
    assert.ok(summaryFileFor(cwd));
    assert.ok(fs.existsSync(warning));
    // The worker's first prompt marks the session injected: its later prompts stay silent too.
    assert.equal(prompt(harness, 'W2', cwd, { first: false, env: WORKER }), '');
    assert.match(prompt(harness, 'M', cwd), /MAIN-SUMMARY[\s\S]*MAIN-WARNING|MAIN-WARNING[\s\S]*MAIN-SUMMARY/);
  });
}

test('the role is matched case-insensitively: WORKER is a worker, Main is a main session', () => {
  const cwd = project();
  compact('A', cwd, 'SUMMARY-CASE');
  const upper = hookRaw('claude', 'user-prompt-submit.sh', { session_id: 'U', cwd }, { DOFLOW_SESSION_ROLE: 'WORKER' });
  assert.deepEqual(JSON.parse(upper.stdout), {});
  assert.equal(upper.stderr, '');
  assert.ok(summaryFileFor(cwd));
  assert.match(prompt('claude', 'V', cwd, { env: { DOFLOW_SESSION_ROLE: 'Main' } }), /SUMMARY-CASE/);
  assert.equal(summaryFileFor(cwd), undefined);
});

/** The non-empty lines a hook wrote to stderr. */
const diagnosticLines = (stderr) => stderr.split('\n').filter((line) => line.trim() !== '');

test('an unknown role behaves as a worker and writes one diagnostic line to stderr', () => {
  const cwd = project('topic');
  compact('A', cwd, 'SUMMARY-BOGUS');
  const warning = path.join(projectDirFor(cwd), 'uncommitted-warning.txt');
  fs.writeFileSync(warning, 'MAIN-WARNING');
  const bogus = { DOFLOW_SESSION_ROLE: 'bogus' };
  hook('claude', 'session-start.sh', { session_id: 'B', cwd, source: 'startup' });
  const first = hookRaw('claude', 'user-prompt-submit.sh', { session_id: 'B', cwd }, bogus);
  assert.deepEqual(JSON.parse(first.stdout), {});
  assert.doesNotMatch(first.stdout, /Git context|SUMMARY-BOGUS|MAIN-WARNING/);
  assert.equal(diagnosticLines(first.stderr).length, 1);
  assert.match(first.stderr, /^\[doflow\] unknown DOFLOW_SESSION_ROLE; treating session as worker$/m);
  assert.ok(summaryFileFor(cwd));
  assert.equal(fs.readFileSync(warning, 'utf8'), 'MAIN-WARNING');
  const compacted = hookRaw('claude', 'post-compact.sh', { session_id: 'B', cwd, trigger: 'auto', compact_summary: 'BOGUS-SUMMARY' }, bogus);
  const lines = diagnosticLines(compacted.stderr);
  assert.equal(lines.length, 1, compacted.stderr);
  assert.ok(lines[0].includes('unknown DOFLOW_SESSION_ROLE'), lines[0]);
  assert.match(fs.readFileSync(summaryFileFor(cwd), 'utf8'), /SUMMARY-BOGUS/);
});

test('a summary written before roles existed, with no role line, is claimed by a main session', () => {
  const cwd = project();
  const file = path.join(projectDirFor(cwd), 'last-compact-summary.md');
  fs.writeFileSync(file, '---\ncompacted_at: 2026-01-01T00:00:00Z\nsession_id: OLD\ntrigger: auto\nbranch: unknown\n---\n\nSUMMARY-LEGACY\n');
  assert.match(prompt('claude', 'P', cwd), /SUMMARY-LEGACY/);
  assert.equal(summaryFileFor(cwd), undefined);
});

test('a native subagent payload does not claim the summary or the warning but still gets git context', () => {
  const cwd = project('topic');
  compact('A', cwd, 'MAIN-SUMMARY');
  const warning = path.join(projectDirFor(cwd), 'uncommitted-warning.txt');
  fs.writeFileSync(warning, 'MAIN-WARNING');
  hook('claude', 'session-start.sh', { session_id: 'S', cwd, source: 'startup' });
  const out = hook('claude', 'user-prompt-submit.sh', { session_id: 'S', cwd, agent_id: 'sub1', agent_type: 'general' });
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Git context/);
  assert.doesNotMatch(ctx, /MAIN-SUMMARY|MAIN-WARNING/);
  assert.ok(summaryFileFor(cwd));
  assert.ok(fs.existsSync(warning));
});

test('with no git capture the first prompt still delivers the pending summary and warning (DEC-033)', () => {
  const cwd = project('topic');
  compact('A', cwd, 'SUMMARY-NOGIT');
  const warning = path.join(projectDirFor(cwd), 'uncommitted-warning.txt');
  fs.writeFileSync(warning, 'MAIN-WARNING');
  const ctx = prompt('claude', 'NG', cwd, { first: false });
  assert.ok(ctx.startsWith('Git context unavailable for this session.'), ctx);
  assert.match(ctx, /^\[Prior session summary, compacted [^\]]+ on branch topic\]$/m);
  assert.match(ctx, /SUMMARY-NOGIT/);
  assert.match(ctx, /^\[Prior session warning: MAIN-WARNING\]$/m);
  assert.equal(summaryFileFor(cwd), undefined);
  assert.equal(fs.existsSync(warning), false);
});

test('a main compaction records role: main in the frontmatter, with or without the variable', () => {
  for (const env of [{}, { DOFLOW_SESSION_ROLE: 'main' }]) {
    const cwd = project();
    compact('A', cwd, 'SUMMARY-ROLE', env);
    const text = fs.readFileSync(summaryFileFor(cwd), 'utf8');
    const frontmatter = text.split('\n---\n')[0];
    assert.match(frontmatter, /^role: main$/m);
  }
});

// ── Session end and the nudge, by role ──────────────────────────────────────────

/** A git repo with an untracked file, so the working tree is dirty at session end. */
function dirtyProject() {
  const cwd = project('topic');
  fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'x\n');
  return cwd;
}

for (const harness of ['claude', 'codex']) {
  test(`a worker session end on ${harness} writes no uncommitted warning; a main session end does`, () => {
    const cwd = dirtyProject();
    const warning = path.join(projectDirFor(cwd), 'uncommitted-warning.txt');
    hook(harness, 'session-end.sh', { session_id: 'W', cwd }, WORKER);
    assert.equal(fs.existsSync(warning), false);
    hook(harness, 'session-end.sh', { session_id: 'M', cwd });
    assert.match(fs.readFileSync(warning, 'utf8'), /Session M ended with uncommitted changes on branch topic/);
  });

  test(`a worker session end on ${harness} leaves a pre-existing main warning byte-identical`, () => {
    const cwd = dirtyProject();
    const warning = path.join(projectDirFor(cwd), 'uncommitted-warning.txt');
    fs.writeFileSync(warning, 'MAIN-WARNING\n');
    hook(harness, 'session-end.sh', { session_id: 'W', cwd }, WORKER);
    assert.deepEqual(fs.readFileSync(warning), Buffer.from('MAIN-WARNING\n'));
  });
}

test('a worker session end still logs the end marker', () => {
  const cwd = dirtyProject();
  hook('claude', 'session-end.sh', { session_id: 'WLOG', cwd }, WORKER);
  const log = fs.readFileSync(path.join(scratch.xdg, 'doflow', 'sessions.log'), 'utf8');
  assert.match(log, /END WLOG /);
});

// ── Compaction on the rules and the scoped store (feature 078, IC-011) ──────────────────────────

/** The hash directory name for a working directory, as every hook computes it. */
function hashOf(cwd) {
  const lib = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies', 'lib.sh');
  return spawnSync('bash', ['-c', 'source "$1"; cwd_hash "$2"', 'bash', lib, cwd], { env: scratch.env(), encoding: 'utf8' }).stdout.trim();
}
const LEGACY_FILE = (cwd) => path.join(SUMMARY_DIR, hashOf(cwd), 'last-compact-summary.md');
const SCOPE_FILE = (cwd, run, lineage) => path.join(SCOPE_DIR, hashOf(cwd), run, lineage, 'summary.md');
const LAUNCHED_WORKER = { DOFLOW_SESSION_ROLE: 'worker', DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'w1', DOFLOW_ATTEMPT: '1' };

test('a main compaction never writes the retired project-level summary path', () => {
  const cwd = project('topic');
  compact('A', cwd, 'SUMMARY-SCOPED');
  assert.match(fs.readFileSync(SCOPE_FILE(cwd, 'local', 'main'), 'utf8'), /SUMMARY-SCOPED/);
  assert.equal(fs.existsSync(LEGACY_FILE(cwd)), false);
  assert.deepEqual(fs.readdirSync(path.dirname(SCOPE_FILE(cwd, 'local', 'main'))), ['summary.md']);
});

test('a solo worker compaction writes nothing anywhere', () => {
  const cwd = project();
  compact('W', cwd, 'SOLO-SUMMARY', WORKER);
  assert.equal(fs.existsSync(path.join(SCOPE_DIR, hashOf(cwd))), false);
  assert.equal(fs.existsSync(path.join(SUMMARY_DIR, hashOf(cwd))), false);
});

test('a launched worker compaction writes its own scope and leaves meta.json untouched', () => {
  const cwd = project('topic');
  const dir = projectDirFor(cwd);
  fs.writeFileSync(path.join(dir, 'meta.json'), '{"compacted_at":"2020-01-01T00:00:00Z"}\n');
  const metaBefore = fs.readFileSync(path.join(dir, 'meta.json'));
  compact('LW', cwd, 'LAUNCHED-SUMMARY', LAUNCHED_WORKER);
  const text = fs.readFileSync(SCOPE_FILE(cwd, 'r1', 'w1'), 'utf8');
  assert.match(text, /LAUNCHED-SUMMARY/);
  assert.match(text, /^role: worker$/m);
  assert.match(text, /^lineage: w1$/m);
  assert.match(text, /^attempt: 1$/m);
  assert.equal(fs.existsSync(SCOPE_FILE(cwd, 'local', 'main')), false);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'meta.json')), metaBefore);
});

test('meta.json compacted_at moves only for the default main lineage', () => {
  const cwd = project();
  const meta = path.join(projectDirFor(cwd), 'meta.json');
  fs.writeFileSync(meta, '{"compacted_at":"2020-01-01T00:00:00Z","keep":1}\n');
  compact('LM', cwd, 'LAUNCHED-MAIN', { DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_ATTEMPT: '1' });
  assert.ok(fs.existsSync(SCOPE_FILE(cwd, 'r1', 'main')));
  assert.equal(JSON.parse(fs.readFileSync(meta, 'utf8')).compacted_at, '2020-01-01T00:00:00Z');
  compact('A', cwd, 'DEFAULT-MAIN');
  const after = JSON.parse(fs.readFileSync(meta, 'utf8'));
  assert.notEqual(after.compacted_at, '2020-01-01T00:00:00Z');
  assert.equal(after.keep, 1);
});

const PRESERVE_LINE = 'Preserve: decisions made, files modified, open questions, planned next steps, acceptance criteria and pending verification of the active task.';

function gitOutput(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env: scratch.env(), encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function commitFile(cwd, filename, subject) {
  fs.writeFileSync(path.join(cwd, filename), `${subject}\n`);
  gitOutput(cwd, 'add', '.');
  gitOutput(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', subject);
}

function knownGitProject() {
  const cwd = project('topic');
  commitFile(cwd, 'first.txt', 'first');
  fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'dirty\n');
  return cwd;
}

function twoCommitProject() {
  const cwd = project('topic');
  commitFile(cwd, 'first.txt', 'first');
  commitFile(cwd, 'second.txt', 'second');
  return cwd;
}

function longGitProject() {
  const cwd = project('b'.repeat(200));
  commitFile(cwd, 'first.txt', 'a'.repeat(300));
  commitFile(cwd, 'second.txt', 'c'.repeat(300));
  const deep = path.join(cwd, 'd'.repeat(72), 'e'.repeat(72), 'f'.repeat(72));
  fs.mkdirSync(deep, { recursive: true });
  const realDeep = fs.realpathSync(deep);
  assert.ok(realDeep.length > 200, 'the deep cwd is longer than 200 characters');
  return realDeep;
}

// C-2: a repository with no commit, and a detached HEAD, take the IC-001 fallbacks.
function noCommitProject() {
  return project('topic');
}

function detachedProject() {
  const cwd = twoCommitProject();
  gitOutput(cwd, 'checkout', '-q', '--detach', 'HEAD');
  return cwd;
}

function expectedGitText(cwd) {
  const branch = gitOutput(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim() || 'unknown';
  const sha = gitOutput(cwd, 'rev-parse', '--short', 'HEAD').trim() || 'unknown';
  const status = gitOutput(cwd, 'status', '--porcelain');
  const dirtyCount = status.split('\n').filter(Boolean).length;
  const recent = gitOutput(cwd, 'log', '--format=%h %s', '-2').trimEnd().split('\n').filter(Boolean).join(' | ') || 'none';
  return `${PRESERVE_LINE}\nInclude in compact summary:\n- git branch: ${branch} sha: ${sha}\n- uncommitted files: ${dirtyCount}\n- cwd: ${cwd || 'unknown'}\n- recent commits: ${recent}`;
}

function assertCompactParity(cwd, env = {}) {
  const claude = preCompact(mirror, 'claude', cwd, env);
  const codex = JSON.parse(preCompact(mirror, 'codex', cwd, env));
  assert.deepEqual(Object.keys(codex), ['systemMessage']);
  assert.equal(claude, codex.systemMessage);
  return claude;
}

// C-1: the exact text and Claude/Codex parity hold for every role, so a role-only edit is caught here.
const ROLES = [['main', {}], ['worker', WORKER], ['launched worker', LAUNCHED_WORKER]];

test('PreCompact builds exact IC-002 git text from repository state for every role', () => {
  const cwd = knownGitProject();
  for (const [role, env] of ROLES) assert.equal(assertCompactParity(cwd, env), expectedGitText(cwd), role);
});

test('PreCompact emits exact non-git text for project and unknown cwd for every role', () => {
  const cwd = project();
  for (const [role, env] of ROLES) {
    assert.equal(assertCompactParity(cwd, env), `${PRESERVE_LINE}\nInclude in compact summary:\n- cwd: ${cwd} (not a git repository)`, role);
    assert.equal(assertCompactParity(undefined, env), `${PRESERVE_LINE}\nInclude in compact summary:\n- cwd: unknown (not a git repository)`, role);
    assert.equal(assertCompactParity('', env), `${PRESERVE_LINE}\nInclude in compact summary:\n- cwd: unknown (not a git repository)`, role);
  }
});

test('PreCompact takes the no-commit and detached-HEAD fallbacks with exact text for every role', () => {
  const empty = noCommitProject();
  const detached = detachedProject();
  const sha = gitOutput(detached, 'rev-parse', '--short', 'HEAD').trim();
  const recent = gitOutput(detached, 'log', '--format=%h %s', '-2').trimEnd().split('\n').join(' | ');
  for (const [role, env] of ROLES) {
    assert.equal(assertCompactParity(empty, env),
      `${PRESERVE_LINE}\nInclude in compact summary:\n- git branch: topic sha: unknown\n- uncommitted files: 0\n- cwd: ${empty}\n- recent commits: none`, role);
    assert.equal(assertCompactParity(detached, env),
      `${PRESERVE_LINE}\nInclude in compact summary:\n- git branch: unknown sha: ${sha}\n- uncommitted files: 0\n- cwd: ${detached}\n- recent commits: ${recent}`, role);
  }
});

test('PreCompact separates two recent commits with " | "', () => {
  const cwd = twoCommitProject();
  const expectedRecent = gitOutput(cwd, 'log', '--format=%h %s', '-2').trimEnd().split('\n').join(' | ');
  const text = preCompact(mirror, 'claude', cwd);
  assert.ok(text.includes(`- recent commits: ${expectedRecent}`), text);
});

test('PreCompact cap keeps preserve line first and later git context', () => {
  const cwd = longGitProject();
  const text = preCompact(mirror, 'claude', cwd);
  assert.ok(text.length <= 490, `got ${text.length} characters`);
  assert.equal(text.split('\n')[0], PRESERVE_LINE);
  assert.ok(text.includes('\nInclude in compact summary:\n'), text);
  assert.ok(text.includes('\n- git branch: '), text);
  assert.ok(text.includes('\n- uncommitted files: 0\n'), text);
});

// FU-tsq77m / FU-zg76ce: the 490 cap counts bytes in every locale and never ends inside a multi-byte
// character. Under LC_ALL=C the old character cut split a character before Codex's jq --arg rewrote the
// tail to U+FFFD, and under a UTF-8 locale it counted characters, not bytes.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function preCompactBytes(harness, cwd, env) {
  const r = spawnSync('bash', [path.join(mirror, `.${harness}`, 'hooks', 'pre-compact.sh')], {
    input: JSON.stringify({ session_id: 'PRECOMPACT', cwd }), env: scratch.env(env), cwd: scratch.dir,
  });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
}

const CUT_CHARACTERS = [['U+00E9 (2 bytes)', 'é'], ['U+20AC (3 bytes)', '€'], ['U+1F600 (4 bytes)', '\u{1F600}']];

/** The first installed UTF-8 locale (en_US.UTF-8, C.UTF-8, ...) under which bash counts characters, not
 * bytes; a locale that is not installed makes bash fall back to C, so it is proved active here, not assumed. */
function installedUtf8Locale() {
  for (const locale of ['en_US.UTF-8', 'C.UTF-8', 'en_US.utf8', 'C.utf8']) {
    const r = spawnSync('bash', ['-c', 's=$(printf "\\303\\251"); echo ${#s}'], { env: scratch.env({ LC_ALL: locale }), encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '1') return locale;
  }
  return null;
}
const UTF8_LOCALE = installedUtf8Locale();

function assertCutHolds(locale) {
  const cwd = project('topic');
  commitFile(cwd, 'first.txt', 'first');
  for (const [label, character] of CUT_CHARACTERS) {
    // Prefixes of 0 to 3 ASCII bytes move the cut across every offset inside the character.
    for (let prefix = 0; prefix < 4; prefix += 1) {
      gitOutput(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--amend', '--allow-empty', '-qm',
        `${'x'.repeat(prefix)}${character.repeat(300)}`);
      const env = { LC_ALL: locale };
      const claude = preCompactBytes('claude', cwd, env);
      const where = `${locale} ${label} prefix ${prefix}`;
      assert.ok(claude.length <= 490, `${where}: ${claude.length} bytes`);
      const text = strictUtf8.decode(claude);
      assert.equal(text.split('\n')[0], PRESERVE_LINE, where);
      assert.ok(text.includes('\n- recent commits: '), `${where}: the git context line survives`);
      assert.equal(JSON.parse(preCompactBytes('codex', cwd, env).toString('utf8')).systemMessage, text, `${where}: Codex parity`);
    }
  }
}

test('PreCompact cut never splits a multi-byte character and holds 490 bytes under LC_ALL=C', () => assertCutHolds('C'));

test('PreCompact cut never splits a multi-byte character and holds 490 bytes under an installed UTF-8 locale',
  { skip: UTF8_LOCALE ? false : 'no UTF-8 locale (en_US.UTF-8, C.UTF-8) is installed on this host, so the byte-not-character cap cannot be exercised' },
  () => assertCutHolds(UTF8_LOCALE));

// Review C-1: the byte value of a character above 127 depends on the shell and libc. bash 3.2 prints it
// negative, glibc prints 128-255, and a libc that maps a C-locale byte to a code unit prints 0xDF00 | byte.
// The cut masks the value to one byte, so every one of them gives the same valid UTF-8; this stubs the
// `printf -v` the builder reads bytes with, because no installed shell here prints the code-unit form.
const BYTE_FORMS = {
  signed: 'b=$(( b > 127 ? b - 256 : b ))',
  plain: 'b=$(( b & 255 ))',
  codeunit: 'b=$(( b > 127 || b < 0 ? 0xDF00 | (b & 255) : b ))',
};

test('PreCompact cut gives valid UTF-8 whatever form the shell prints a byte above 127 in', () => {
  const builder = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies', 'compact-text.sh');
  for (const [form, convert] of Object.entries(BYTE_FORMS)) {
    for (const [label, character] of CUT_CHARACTERS) {
      for (let prefix = 0; prefix < 4; prefix += 1) {
        const script = [
          'is_git_worktree() { return 1; }',
          // Wraps only the byte read: `printf -v b %d "'<char>"`.
          'printf() { if [[ $1 == -v && $2 == b && $3 == %d ]]; then builtin printf "$@"; ' + convert + '; else builtin printf "$@"; fi; }',
          `source "${builder}"`,
          'doflow_compact_text "$1"',
          'builtin printf "%s" "$DF_COMPACT_TEXT"',
        ].join('\n');
        const cwd = `${'x'.repeat(prefix)}${character.repeat(300)}`;
        const r = spawnSync('bash', ['-c', script, 'bash', cwd], { env: scratch.env({ LC_ALL: 'C' }) });
        const where = `${form} ${label} prefix ${prefix}`;
        assert.equal(r.status, 0, `${where}: ${r.stderr}`);
        assert.ok(r.stdout.length <= 490, `${where}: ${r.stdout.length} bytes`);
        assert.doesNotThrow(() => strictUtf8.decode(r.stdout), `${where}: valid UTF-8`);
      }
    }
  }
});

test('PreCompact Claude and Codex stay byte-identical with one JSON key across contract cases and roles', () => {
  const cases = [knownGitProject(), project(), undefined, '', twoCommitProject(), longGitProject(), noCommitProject(), detachedProject()];
  for (const [, env] of ROLES) for (const cwd of cases) assertCompactParity(cwd, env);
});

test('PreCompact skip rule exits silently on Claude and Codex', () => {
  const skipped = path.join(scratch.dir, 'skip-mirror');
  fs.cpSync(mirror, skipped, { recursive: true });
  const rulesPath = path.join(skipped, '.doflow/shared/hooks/policies/emission-rules.sh');
  const rules = fs.readFileSync(rulesPath, 'utf8');
  const skippedRules = rules.replace(/('compact-instructions\.instructions\|(main|worker)'\)) DF_ACTION=include/g, '$1 DF_ACTION=skip');
  assert.equal((skippedRules.match(/'compact-instructions\.instructions\|(main|worker)'\) DF_ACTION=skip/g) || []).length, 2, 'both role rules were changed');
  fs.writeFileSync(rulesPath, skippedRules);
  const cwd = project();
  for (const harness of ['claude', 'codex']) assert.equal(preCompact(skipped, harness, cwd), '');
});

test('PreCompact exits silently when the shared builder is missing', () => {
  const missing = path.join(scratch.dir, 'missing-builder-mirror');
  fs.cpSync(mirror, missing, { recursive: true });
  fs.rmSync(path.join(missing, '.doflow/shared/hooks/policies/compact-text.sh'), { force: true });
  const cwd = project();
  for (const harness of ['claude', 'codex']) assert.equal(preCompact(missing, harness, cwd), '');
});

// Pre-compact output bytes are pinned to develop 468e77b (DEC-023), taken from `git archive`.
const GOLDEN_REF = '468e77b';
const hasGoldenRef = spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${GOLDEN_REF}^{commit}`]).status === 0;
test('pre-compact output on Gemini is byte-identical to 468e77b', { skip: !hasGoldenRef && `${GOLDEN_REF} not in this clone` }, () => {
  const golden = path.join(scratch.dir, 'golden');
  const extract = path.join(scratch.dir, 'golden-src');
  fs.mkdirSync(extract);
  const archive = spawnSync('git', ['-C', REPO, 'archive', '--format=tar', GOLDEN_REF, 'core/harnesses'], { maxBuffer: 1 << 28 });
  assert.equal(archive.status, 0, String(archive.stderr));
  const untar = spawnSync('tar', ['-x', '-C', extract], { input: archive.stdout });
  assert.equal(untar.status, 0, String(untar.stderr));
  for (const harness of ['gemini']) {
    fs.cpSync(path.join(extract, 'core', 'harnesses', harness, 'hooks'), path.join(golden, `.${harness}`, 'hooks'), { recursive: true });
  }
  fs.cpSync(path.join(extract, 'core', 'harnesses', 'shared', 'hooks'), path.join(golden, '.doflow', 'shared', 'hooks'), { recursive: true });

  const repo = project('topic');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  for (const args of [['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first']]) {
    assert.equal(spawnSync('git', ['-C', repo, ...args], { env: scratch.env() }).status, 0);
  }
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x\n');
  const run = (root, harness, cwd, env) => spawnSync('bash', [path.join(root, `.${harness}`, 'hooks', 'pre-compact.sh')], {
    input: JSON.stringify({ session_id: 'P', cwd }), env: scratch.env(env),
  });
  for (const harness of ['gemini']) {
    for (const cwd of [repo, project()]) {
      for (const env of [{}, WORKER, LAUNCHED_WORKER]) {
        const before = run(golden, harness, cwd, env);
        const after = run(mirror, harness, cwd, env);
        assert.equal(after.status, 0);
        assert.ok(before.stdout.length > 0, `${harness} golden produced output`);
        assert.deepEqual(after.stdout, before.stdout, `${harness} ${cwd} ${JSON.stringify(env)}`);
      }
    }
  }
});
