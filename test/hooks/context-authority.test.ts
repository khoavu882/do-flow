'use strict';

// Feature 078, IC-006 and IC-022 (DEC-001, DEC-034): one emission authority behind the prompt hook
// and the launcher. The hook runs from an install mirror (test/helper/hook-fixtures
// buildInstallMirror); the launcher is the IC-006 stand-in (test/helper/launcher-stand-in.js),
// which 081 replaces with its real launcher. Every hook and every in-process call gets a scratch
// HOME and XDG_CONFIG_HOME, so nothing reads or writes the developer's own store.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildInstallMirror } = require('../helper/hook-fixtures.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { launch, launchEnv, firstPrompt } = require('../helper/launcher-stand-in.ts');
const { emitContext } = require('../../src/runtime/context-pack.ts');
const { grantSummary } = require('../../src/runtime/context/summary-store.ts');
const { writeSummary } = require('../helper/summary-fixture.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');

const REPO = path.resolve(__dirname, '..', '..');
const DISPATCHER = path.join(REPO, 'core/shared/scripts/doflow/bin/doflow-run');
const REGISTRY = path.join(REPO, 'core', 'registry', 'workflows.json');
const NUDGE = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).promptNudge.message;
const CODE_CHANGE = 'add a retry to the upload client in src/upload.js';
const PACK_END = '[end of pack]';
/** The first-prompt bootstrap segments (IC-002): git context, the prior summary, the warning. */
const BOOTSTRAP = [/Git context/, /Not a git repository/, /\[Prior session summary/, /UNCOMMITTED-WARNING/];

const scratch = createScratch('doflow-context-authority-');
const mirror = path.join(scratch.dir, 'mirror');

/** The registry beside the mirrored policies (IC-006 candidate 1), so the nudge can be earned. */
function withRegistry(dir: any) {
  const target = path.join(dir, '.doflow', 'runtime', 'core', 'registry', 'workflows.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(REGISTRY, target);
  return dir;
}

test.before(() => withRegistry(buildInstallMirror(mirror)));
test.after(() => scratch.remove());

let seq = 0;
/** A fresh world: a git repository on `main` with one commit and its own store. */
function world(name = 'w') {
  const root = path.join(scratch.dir, `${name}${seq++}`);
  const w: any = { root, repo: path.join(root, 'repo'), home: path.join(root, 'home'), xdg: path.join(root, 'xdg') };
  for (const dir of [w.repo, w.home, w.xdg]) fs.mkdirSync(dir, { recursive: true });
  w.repo = fs.realpathSync(w.repo);
  const git = (...args: any[]) => {
    const r = spawnSync('git', ['-C', w.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { env: scratch.env(), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(w.repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'first');
  w.env = envFor(w.home, w.xdg);
  w.store = path.join(w.xdg, 'doflow', 'session-env');
  return w;
}

/** The spawn and in-process environment over one store; harness config folders are cleared. */
function envFor(home: any, xdg: any, extra = {}) {
  return scratch.env({
    HOME: home, XDG_CONFIG_HOME: xdg, DOFLOW_FAILURE_CAPTURE: 'off',
    CLAUDE_CONFIG_DIR: '', CLAUDE_PROJECT_DIR: '', CODEX_HOME: '', DOFLOW_PROJECT_DIR: '', DOFLOW_AGENT: '',
    DOFLOW_RUN_ID: '', DOFLOW_LINEAGE_ID: '', DOFLOW_ATTEMPT: '', DOFLOW_SESSION_ROLE: '', DOFLOW_WORKTREE: '', DOFLOW_CONTEXT_MAX_BYTES: '',
    ...extra,
  });
}

/** A pending summary in (worktree, run, lineage), written by the store itself. */
function pending(w: any, body: any, { run = 'local', lineage = 'main' } = {}) {
  const made = writeSummary({ worktree: w.repo, run, lineage, compactedAt: '2026-10-14T10:00:00Z', sessionId: 'owner', branch: 'main', body, env: w.env });
  assert.ok(made, 'the summary is written');
  return made;
}

function warning(w: any, text = 'UNCOMMITTED-WARNING: 3 files') {
  const file = path.join(w.store, 'projects', cwdHash(w.repo), 'uncommitted-warning.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${text}\n`);
}

/** A second store holding a byte copy of `w`'s, read through the same repository. */
function copyOf(w: any) {
  const xdg = path.join(w.root, 'xdg-copy');
  fs.cpSync(w.xdg, xdg, { recursive: true });
  return { ...w, xdg, env: { ...w.env, XDG_CONFIG_HOME: xdg }, store: path.join(xdg, 'doflow', 'session-env') };
}

const ledgerOf = (store: any, unit: any) => {
  try { return fs.readFileSync(path.join(store, 'sessions', unit, 'emitted'), 'utf8'); } catch { return ''; }
};

// ── FR-001: the same answer from the hook and the launcher-side authority ─────────────────────

/**
 * The states compared. Each prepares one store; `env` is the identity the prompt runs under and
 * `unit` the bootstrap unit whose ledger the refusal lands in.
 */
const STATES = [
  {
    name: 'main session, first prompt: git, own summary and warning',
    prepare(w: any) { pending(w, 'AUTHORITY-SUMMARY'); warning(w); },
    env: {}, unit: (sid: any) => sid, expect: /AUTHORITY-SUMMARY/,
  },
  {
    name: 'main session, already bootstrapped',
    prepare(w: any) { pending(w, 'AUTHORITY-NOT-AGAIN'); },
    // After SessionStart (which clears a stale slot): an earlier prompt took the slot.
    pre(w: any, sid: any) { fs.writeFileSync(path.join(w.store, 'sessions', sid, 'injected'), ''); },
    env: {}, unit: (sid: any) => sid, expect: null,
  },
  {
    name: 'launched worker, a grant that fits',
    prepare(w: any) {
      pending(w, 'AUTHORITY-GRANTED');
      grantSummary({ summary: 'pending', toRun: 'r1', toLineage: 'w1', fromWorktree: w.repo, fromRun: 'local', fromLineage: 'main', env: w.env });
    },
    env: { DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'w1', DOFLOW_ATTEMPT: '1', DOFLOW_SESSION_ROLE: 'worker' },
    unit: () => 'L.r1.w1.1', expect: /AUTHORITY-GRANTED/,
  },
  {
    name: 'launched worker, a grant above DOFLOW_CONTEXT_MAX_BYTES',
    prepare(w: any) {
      pending(w, 'B'.repeat(3000));
      grantSummary({ summary: 'pending', toRun: 'r2', toLineage: 'w2', fromWorktree: w.repo, fromRun: 'local', fromLineage: 'main', env: w.env });
    },
    env: { DOFLOW_RUN_ID: 'r2', DOFLOW_LINEAGE_ID: 'w2', DOFLOW_ATTEMPT: '1', DOFLOW_SESSION_ROLE: 'worker', DOFLOW_CONTEXT_MAX_BYTES: '1000' },
    unit: () => 'L.r2.w2.1', expect: /withheld: 3000 bytes exceed the 1000-byte context budget/, refused: true,
  },
];

for (const harness of ['claude', 'codex']) {
  for (const state of STATES) {
    test(`FR-001 (${harness}): ${state.name}: the hook's output equals emitContext({event: 'prompt', peek: true}) over a copy of the state`, () => {
      const w: any = world('auth');
      const sid = `auth-${harness}-${seq}`;
      state.prepare(w);
      const env = { ...w.env, ...state.env };
      // SessionStart writes the git capture; the state is copied after it, so both copies hold it.
      spawnSync('bash', [path.join(mirror, `.${harness}`, 'hooks', 'session-start.sh')], {
        cwd: w.repo, input: `${JSON.stringify({ session_id: sid, cwd: w.repo, hook_event_name: 'SessionStart', source: 'startup' })}\n`, env, encoding: 'utf8',
      });
      if (state.pre) state.pre(w, sid);
      const copy = copyOf(w);

      const peeked = emitContext({ event: 'prompt', cwd: w.repo, sessionId: sid, harness, peek: true, env: { ...copy.env, ...state.env } });
      const hook = firstPrompt({ mirror, harness, sessionId: sid, cwd: w.repo, env, start: false });

      assert.equal(hook.additionalContext, peeked.text ?? '', 'the hook renders what the authority renders');
      assert.equal(hook.additionalContext !== '', peeked.decision.emit, 'and decides the same emit');
      if (!peeked.decision.emit) assert.deepEqual(JSON.parse(hook.stdout), {}, 'a silent decision is {}');
      const refusedLine = /\tgrant\ts-[^\t]+\trefused:mandatory-over-budget\thook\n/.test(ledgerOf(w.store, state.unit(sid)));
      assert.equal(refusedLine, peeked.decision.reason === 'refused:mandatory-over-budget', 'the same refusal');
      assert.equal(peeked.committed, false, 'the peek took nothing');
      if (state.expect) assert.match(hook.additionalContext, state.expect);
      else assert.equal(peeked.decision.reason, 'silent:already-bootstrapped');
      if (state.refused) assert.doesNotMatch(hook.additionalContext, /BBBB/, 'the over-budget grant is never cut into the context');
    });
  }
}

// ── FR-002: an unchanged second prompt is silent ──────────────────────────────────────────────

for (const harness of ['claude', 'codex']) {
  test(`FR-002 (${harness}): an unchanged second prompt prints {}`, () => {
    const w: any = world('unchanged');
    pending(w, 'UNCHANGED-SUMMARY');
    const sid = `unchanged-${harness}`;
    const first = firstPrompt({ mirror, harness, sessionId: sid, cwd: w.repo, env: w.env });
    assert.match(first.additionalContext, /UNCHANGED-SUMMARY/, 'the first prompt bootstraps');
    const second = firstPrompt({ mirror, harness, sessionId: sid, cwd: w.repo, env: w.env, start: false });
    assert.deepEqual(JSON.parse(second.stdout), {});
    assert.equal(second.additionalContext, '');
  });
}

// ── FR-013: launch, then the first prompt: the bootstrap is delivered once ───────────────────

/** IC-006: the launch text is non-empty and the first prompt holds no bootstrap segment. */
function noDuplicateBootstrap(root: any, harness: any) {
  const w: any = world('boot');
  pending(w, 'LAUNCH-SUMMARY', { run: 'r9', lineage: 'm9' });
  const { launched, env } = launch({ mirror: root, env: w.env, cwd: w.repo, run: 'r9', lineage: 'm9', role: 'main', worktree: w.repo });
  assert.equal(launched.decision.reason, 'emit');
  assert.ok(launched.text && launched.text.includes(PACK_END), 'the launch delivers the pack');
  assert.match(launched.text, /LAUNCH-SUMMARY/, 'and the scoped summary');
  const prompt = firstPrompt({ mirror: root, harness, sessionId: `boot-${harness}`, cwd: w.repo, env });
  for (const segment of BOOTSTRAP) assert.doesNotMatch(prompt.additionalContext, segment, 'the first prompt repeats no bootstrap segment');
  assert.deepEqual(JSON.parse(prompt.stdout), {}, 'the first prompt after a launch is silent');
}

for (const harness of ['claude', 'codex']) {
  test(`FR-013 (${harness}): launch then first prompt delivers the bootstrap exactly once`, () => {
    noDuplicateBootstrap(mirror, harness);
  });
}

test('negative control: a hook that ignores the slot fails the no-duplicate-bootstrap test', () => {
  const patched = withRegistry(buildInstallMirror(path.join(scratch.dir, 'mirror-ignores-slot')));
  const file = path.join(patched, '.doflow', 'shared', 'hooks', 'policies', 'emission.sh');
  const source = fs.readFileSync(file, 'utf8');
  // The hook's own private slot: it never sees the one the launch took.
  const sabotaged = source.split('"$dir/injected"').join('"$dir/injected.hook-only"');
  assert.notEqual(sabotaged, source, 'the patch applies');
  fs.writeFileSync(file, sabotaged);
  for (const harness of ['claude', 'codex']) {
    assert.throws(() => noDuplicateBootstrap(patched, harness), { name: 'AssertionError', message: 'the first prompt repeats no bootstrap segment' });
  }
  assert.equal(fs.readFileSync(path.join(REPO, 'core/harnesses/shared/hooks/policies/emission.sh'), 'utf8'), source, 'the repository copy is untouched');
});

// ── A worker gets no nudge and no git summary ─────────────────────────────────────────────────

test('a launched worker gets no nudge and no git context; a main session in the same repository gets both', () => {
  const w: any = world('worker');
  const { launched, env } = launch({ mirror, env: w.env, cwd: w.repo, run: 'r3', lineage: 'w3', role: 'worker', worktree: w.repo });
  assert.equal(launched.decision.reason, 'emit');
  assert.equal(launched.decision.actions.git, undefined, 'the launch has no git segment');
  assert.equal(launched.decision.actions.nudge, undefined, 'or nudge');
  for (const harness of ['claude', 'codex']) {
    const worker = firstPrompt({ mirror, harness, sessionId: `worker-${harness}`, cwd: w.repo, env: launchEnv({ env, run: 'r3', lineage: 'w3', role: 'worker', worktree: w.repo }), prompt: CODE_CHANGE });
    assert.doesNotMatch(worker.additionalContext, /Git context/, `${harness}: no git context`);
    assert.equal(worker.additionalContext.includes(NUDGE), false, `${harness}: no nudge`);
    assert.deepEqual(JSON.parse(worker.stdout), {});
    // The control: the same prompt in a main session earns both.
    const main = firstPrompt({ mirror, harness, sessionId: `main-${harness}`, cwd: w.repo, env: w.env, prompt: CODE_CHANGE });
    assert.match(main.additionalContext, /^Git context — branch: main/, `${harness}: main gets git context`);
    assert.ok(main.additionalContext.endsWith(NUDGE), `${harness}: main gets the nudge`);
  }
});

// ── FR-004: a grant above the budget gives the pointer, never a cut ───────────────────────────

test('FR-004: a grant above DOFLOW_CONTEXT_MAX_BYTES gives the pointer at launch, never a cut, and is not repeated', () => {
  const w: any = world('budget');
  // One budget for the whole launch emission (DEC-034). The smallest budget the pack alone fits
  // (it must fit in both of its renderings), found with peeks, plus room for the pointer only.
  const fits = (bytes: any) => emitContext({ event: 'launch', cwd: w.repo, peek: true, env: launchEnv({ env: { ...w.env, DOFLOW_CONTEXT_MAX_BYTES: String(bytes) }, run: 'probe', lineage: 'p1' }) }).decision.reason === 'emit';
  let floor = 1024;
  while (!fits(floor)) { floor += 256; assert.ok(floor < 65536, 'the pack fits some budget'); }
  const max = String(floor + 600);
  const body = `GRANT-HEAD-${'g'.repeat(Number(max) + 1000)}`;
  const made = pending(w, body);
  const env = { ...w.env, DOFLOW_CONTEXT_MAX_BYTES: max };
  const { launched, grant, env: child } = launch({
    mirror, env, cwd: w.repo, run: 'r4', lineage: 'w4', role: 'worker', worktree: w.repo,
    grant: { summary: 'pending', fromWorktree: w.repo, fromRun: 'local', fromLineage: 'main', maxBytes: 65536 },
  });
  assert.equal(grant.summaryId, made.summaryId);
  assert.equal(launched.decision.reason, 'refused:mandatory-over-budget');
  assert.ok(launched.text.includes(PACK_END), 'the pack is delivered');
  assert.ok(launched.text.includes(`[Granted summary ${made.summaryId} withheld: ${Buffer.byteLength(body)} bytes exceed the`), 'the pointer is delivered');
  assert.doesNotMatch(launched.text, /GRANT-HEAD|ggggg/, 'no part of the body is cut into the context');
  assert.ok(Buffer.byteLength(launched.text) <= Number(max), 'within the one budget');
  assert.equal(fs.existsSync(grant.path), true, 'the grant is not consumed');
  assert.match(ledgerOf(w.store, 'L.r4.w4.1'), new RegExp(`\\tgrant\\t${made.summaryId}\\trefused:mandatory-over-budget\\tlauncher\\n`));

  const prompt = firstPrompt({ mirror, harness: 'claude', sessionId: 'budget', cwd: w.repo, env: child });
  assert.doesNotMatch(prompt.additionalContext, /GRANT-HEAD|ggggg/, 'the first prompt cuts nothing in either');
  assert.doesNotMatch(prompt.additionalContext, /withheld/, 'and does not repeat the pointer the launch delivered');
  assert.equal(fs.existsSync(grant.path), true);
});

test('FR-004: an over-budget context-grant exits 3 through doflow-run and leaves no failure record', () => {
  const w: any = world('grant-cli');
  pending(w, 'x'.repeat(4000));
  const env = { ...w.env };
  delete env.DOFLOW_FAILURE_CAPTURE;
  const r = spawnSync('/bin/bash', [DISPATCHER, 'context-grant', '--summary', 'pending', '--to-run', 'r5', '--to-lineage', 'w5',
    '--from-worktree', w.repo, '--from-run', 'local', '--from-lineage', 'main', '--max-bytes', '1000', '--json'], { cwd: w.repo, env, encoding: 'utf8' });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(JSON.parse(r.stdout).error, 'over-budget');
  assert.equal(fs.existsSync(path.join(w.xdg, 'doflow', 'failures', 'events.jsonl')), false, 'status 3 of context-grant is not a crash');
});
