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
  const summaryBefore = fs.readFileSync(path.join(dir, 'last-compact-summary.md'));
  const metaBefore = fs.readFileSync(path.join(dir, 'meta.json'));
  compact('W', cwd, 'WORKER-SUMMARY', WORKER);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'last-compact-summary.md')), summaryBefore);
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

// Pre-compact output bytes are pinned to develop 468e77b (DEC-023), taken from `git archive`.
const GOLDEN_REF = '468e77b';
const hasGoldenRef = spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${GOLDEN_REF}^{commit}`]).status === 0;
test('pre-compact output on Claude, Codex and Gemini is byte-identical to 468e77b', { skip: !hasGoldenRef && `${GOLDEN_REF} not in this clone` }, () => {
  const golden = path.join(scratch.dir, 'golden');
  const extract = path.join(scratch.dir, 'golden-src');
  fs.mkdirSync(extract);
  const archive = spawnSync('git', ['-C', REPO, 'archive', '--format=tar', GOLDEN_REF, 'core/harnesses'], { maxBuffer: 1 << 28 });
  assert.equal(archive.status, 0, String(archive.stderr));
  const untar = spawnSync('tar', ['-x', '-C', extract], { input: archive.stdout });
  assert.equal(untar.status, 0, String(untar.stderr));
  for (const harness of ['claude', 'codex', 'gemini']) {
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
  for (const harness of ['claude', 'codex', 'gemini']) {
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
