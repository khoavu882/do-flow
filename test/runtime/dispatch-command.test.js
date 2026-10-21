'use strict';

// Feature 082 C.5 (IC-001, IC-002; DEC-002, DEC-024, DEC-034, DEC-044, DEC-051): the `dispatch`
// verb's handler, called in process through executeDispatchCommand.
//
// Flag rules run with no sandbox: a usage error is decided before any read. Every other case is a
// sandbox repository (test/helper/dispatch-sandbox.js) whose env PATH is the sandbox's scratch bin/
// alone (fake CLI links, node and git, never dirname(process.execPath), DEC-056), with the five
// DOFLOW_* identity variables set or deleted explicitly per caller. No case launches a worker.
// POSIX only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeDispatchSandbox, PLAN_DIR } = require('../helper/dispatch-sandbox.js');
const { tempDir } = require('../helper/tmp.js');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const { runKeyFor } = require(path.join(SRC, 'task-run.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { argvDigest } = require(path.join(SRC, 'dispatch', 'verify-run.ts'));
const { executeDispatchCommand, handleDispatchCommand } = require(path.join(SRC, 'dispatch', 'command.ts'));

const SLUG = '082-command-fixture';
const POSIX = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
const IDENTITY = ['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE'];
const DEFAULT_MAIN = { DOFLOW_RUN_ID: undefined, DOFLOW_LINEAGE_ID: undefined, DOFLOW_ATTEMPT: undefined, DOFLOW_SESSION_ROLE: 'main' };
/** An invalid DOFLOW_RUN_ID (`local` is the default run's name, never a launched one) resolves solo. */
const SOLO = { DOFLOW_RUN_ID: 'local', DOFLOW_LINEAGE_ID: undefined, DOFLOW_ATTEMPT: undefined, DOFLOW_SESSION_ROLE: 'main' };
const WORKER = { DOFLOW_SESSION_ROLE: 'worker' };
const D_ID = 'd-0123456789ab';

function git(cwd, env, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** `base` with each identity override applied; an undefined value deletes the variable. */
function withIdentity(base, over = {}) {
  const env = { ...base };
  for (const key of IDENTITY) {
    if (!Object.hasOwn(over, key)) continue;
    if (over[key] === undefined) delete env[key];
    else env[key] = over[key];
  }
  return env;
}

function project(t, { plan = 'dependent' } = {}) {
  const sb = makeDispatchSandbox(t, { plan, slug: SLUG });
  const file = store.storeFileFor(sb.root, SLUG);
  const worktrees = path.join(sb.root, '.doflow', 'state', 'dispatch-worktrees');
  const exec = (options, over = {}) => executeDispatchCommand({ slug: SLUG, cwd: sb.root, descriptors: sb.descriptors, ...options, env: withIdentity(sb.env, over) });
  const startWith = (extra = {}, over = {}) => exec({ action: 'start', by: 'main', mode: 'sequential', verifyArgv: JSON.stringify(sb.verifyArgv), ...extra }, over);
  const bytes = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  return { sb, file, worktrees, exec, startWith, bytes };
}

// ── flag rules (no reads) ────────────────────────────────────────────────────────────────────────

test('IC-001: each flag rule and a flag on the wrong action are exit 2 usage, decided before any read', async (t) => {
  const cwd = tempDir(t, 'doflow-dispatch-cmd-');
  const env = withIdentity({ PATH: path.join(cwd, 'no-bin') }, DEFAULT_MAIN);
  const longArg = 'x'.repeat(4097);
  const cases = [
    {},
    { action: 'bogus' },
    { action: 'start' },
    { action: 'start', by: '-bad' },
    { action: 'start', by: 'main', concurrency: '0' },
    { action: 'start', by: 'main', concurrency: '5' },
    { action: 'start', by: 'main', concurrency: 'two' },
    { action: 'start', by: 'main', mode: 'parallel' },
    { action: 'start', by: 'main', verifyArgv: 'not json' },
    { action: 'start', by: 'main', verifyArgv: '[]' },
    { action: 'start', by: 'main', verifyArgv: '{"a":1}' },
    { action: 'start', by: 'main', verifyArgv: JSON.stringify(['node', '']) },
    { action: 'start', by: 'main', verifyArgv: JSON.stringify(['a\u0000b']) },
    { action: 'start', by: 'main', verifyArgv: JSON.stringify(Array(65).fill('a')) },
    { action: 'start', by: 'main', verifyArgv: JSON.stringify([longArg]) },
    { action: 'start', by: 'main', verifySeconds: '0' },
    { action: 'start', by: 'main', verifySeconds: '14401' },
    { action: 'start', by: 'main', attemptSeconds: '0' },
    { action: 'start', by: 'main', attemptSeconds: '14281' },
    { action: 'start', by: 'main', reserveTokens: '-1' },
    { action: 'start', by: 'main', budgetAttempts: '0' },
    { action: 'start', by: 'main', spawnGrant: '{"depth":2,"children":1,"tokens":0}' },
    { action: 'start', by: 'main', spawnGrant: 'nope' },
    { action: 'start', by: 'main', harness: 'not-a-harness' },
    { action: 'start', by: 'main', need: 'not-a-need' },
    { action: 'run', maxSeconds: '0' },
    { action: 'run', maxSeconds: '14401' },
    { action: 'step', by: '!' },
    { action: 'submit', status: 'success', summary: 's' },
    { action: 'submit', dispatch: 'd-xyz', status: 'success', summary: 's' },
    { action: 'submit', dispatch: D_ID, status: 'done', summary: 's' },
    { action: 'spawn' },
    { action: 'spawn', promptFile: 'p.txt' },
    { action: 'spawn', requestId: 'd-0123456789ab.c9' },
    { action: 'spawn', requestId: `${D_ID}.c1`, promptFile: 'p.txt' },
    { action: 'pause', by: 'main' },
    { action: 'pause', by: 'main', reason: '   ' },
    { action: 'pause', reason: 'why' },
    { action: 'cancel', by: 'main' },
    { action: 'takeover', by: 'main', reason: 'why' },
    { action: 'takeover', by: 'main', reason: 'why', task: 'A1' },
    { action: 'resume', ack: 'sha256:abc' },
    { action: 'resume', ack: `sha256:${'a'.repeat(64)}` },
    // A flag on an action that does not take it.
    { action: 'step', concurrency: '2' },
    { action: 'step', maxSeconds: '5' },
    { action: 'pause', by: 'main', reason: 'why', task: 'A.1' },
    { action: 'cancel', by: 'main', reason: 'why', ack: `sha256:${'a'.repeat(64)}` },
    { action: 'start', by: 'main', dispatch: D_ID },
    { action: 'start', by: 'main', promptFile: 'p.txt' },
    { action: 'run', reserveTokens: '1' },
    { action: 'submit', dispatch: D_ID, status: 'success', summary: 's', mode: 'auto' },
    { action: 'inspect', by: 'main' },
    { action: 'inspect', reason: 'why' },
    { action: 'resume', task: 'A.1' },
    { action: 'spawn', requestId: `${D_ID}.c1`, by: 'w' },
    // 106 IC-005: --fallback and --ladder.
    { action: 'start', by: 'main', ladder: 'not-a-harness' },
    { action: 'start', by: 'main', ladder: 'claude,codex,claude' },
    { action: 'start', by: 'main', ladder: 'claude,codex,gemini,opencode,pi,copilot,kiro,antigravity,claude' },
    { action: 'start', by: 'main', ladder: 'codex', harness: 'codex' },
    { action: 'start', by: 'main', ladder: ' , ' },
    { action: 'start', by: 'main', fallback: 'banana' },
    { action: 'step', fallback: 'auto' },
    { action: 'inspect', fallback: 'ask' },
    { action: 'resume', ladder: 'claude' },
    { action: 'resume', fallback: 'banana' },
  ];
  for (const flags of cases) {
    const { exit, body } = await executeDispatchCommand({ slug: SLUG, ...flags, env, cwd });
    assert.equal(exit, 2, `${JSON.stringify(flags)} -> ${JSON.stringify(body)}`);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'usage', `${JSON.stringify(flags)} -> ${body.message}`);
  }
  // No slug and nothing to resolve it from.
  const noSlug = await executeDispatchCommand({ action: 'inspect', env, cwd });
  assert.equal(noSlug.exit, 2);
  assert.equal(noSlug.body.error, 'usage');
  assert.deepEqual(fs.readdirSync(cwd), [], 'nothing was written');
});

test('IC-001: --budget-tokens without --reserve-tokens of at least 1, and a grant over --reserve-tokens, are usage', async (t) => {
  const cwd = tempDir(t, 'doflow-dispatch-cmd-');
  const env = withIdentity({ PATH: path.join(cwd, 'no-bin') }, DEFAULT_MAIN);
  const cases = [
    { budgetTokens: '100' },
    { budgetTokens: '100', reserveTokens: '0' },
    { reserveTokens: '10', spawnGrant: '{"depth":1,"children":1,"tokens":11}' },
    { spawnGrant: '{"depth":1,"children":1,"tokens":1}' },
  ];
  for (const flags of cases) {
    const { exit, body } = await executeDispatchCommand({ action: 'start', slug: SLUG, by: 'main', ...flags, env, cwd });
    assert.equal(exit, 2, JSON.stringify(flags));
    assert.equal(body.error, 'usage', JSON.stringify(flags));
  }
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('IC-001 / IC-005 (SF-1): submit summary, blocker and token values are usage before any store read, with or without a run', POSIX, async (t) => {
  const bad = [
    { status: 'success' },
    { status: 'success', summary: '' },
    { status: 'success', summary: 'x'.repeat(8193) },
    { status: 'failure', summary: 's', blocker: Array.from({ length: 21 }, (_, i) => `b${i}`) },
    { status: 'failure', summary: 's', blocker: 'y'.repeat(201) },
    { status: 'success', summary: 's', tokens: '10' },
    { status: 'success', summary: 's', tokensBasis: 'measured' },
    { status: 'success', summary: 's', tokens: 'ten', tokensBasis: 'measured' },
    { status: 'success', summary: 's', tokens: '10', tokensBasis: 'guessed' },
  ];
  const expectUsage = async (exec, label) => {
    for (const flags of bad) {
      const { exit, body } = await exec({ action: 'submit', dispatch: D_ID, ...flags });
      assert.deepEqual([exit, body.error], [2, 'usage'], `${label} ${JSON.stringify(flags).slice(0, 120)} -> ${JSON.stringify(body).slice(0, 200)}`);
    }
  };
  // No dispatch run: before the fix the store read answered first, as no-dispatch-run.
  const p = project(t);
  await expectUsage((o) => p.exec(o), 'no run:');
  assert.equal(p.bytes(), null, 'no store was written');
  // An unreadable store would be store-unreadable if it were read first.
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  fs.writeFileSync(p.file, 'not json');
  await expectUsage((o) => p.exec(o), 'unreadable store:');
  fs.rmSync(p.file);
  // With a run, the same values are usage and the store bytes do not change.
  const started = await p.startWith();
  assert.equal(started.exit, 0, JSON.stringify(started.body));
  const before = p.bytes();
  await expectUsage((o) => p.exec(o), 'with run:');
  assert.equal(p.bytes(), before, 'the store bytes are unchanged');
});

// ── identity checks (DEC-044) ────────────────────────────────────────────────────────────────────

test('IC-001: identity-solo and worker-session are refused with no store written and no worktree made', POSIX, async (t) => {
  const p = project(t);
  for (const [over, reason] of [[SOLO, 'identity-solo'], [WORKER, 'worker-session']]) {
    const started = await p.startWith({}, over);
    assert.equal(started.exit, 1, JSON.stringify(started.body));
    assert.equal(started.body.disposition, 'refused');
    assert.equal(started.body.reason, reason);
    assert.equal(started.body.cleanup, undefined, 'refused at step 1, before step 6');
    for (const action of [{ action: 'inspect' }, { action: 'pause', by: 'u', reason: 'r' }, { action: 'step' }]) {
      const r = await p.exec(action, over);
      assert.equal(r.exit, 1);
      assert.equal(r.body.reason, reason, `${action.action}: ${JSON.stringify(r.body)}`);
    }
  }
  assert.equal(p.bytes(), null, 'no dispatch store');
  assert.equal(fs.existsSync(p.worktrees), false, 'no integration worktree was made');
  assert.equal(fs.existsSync(attempts.storeFile(p.sb.root, SLUG)), false, 'no 080 ledger');
});

test('IC-001: a foreign-run caller gets both run keys from every control, before any write', POSIX, async (t) => {
  const p = project(t);
  const started = await p.startWith();
  assert.equal(started.exit, 0, JSON.stringify(started.body));
  const before = p.bytes();
  const foreign = { DOFLOW_RUN_ID: 'f0f0f0f0f0f0' };
  const callerRunKey = runKeyFor(withIdentity(p.sb.env, foreign), p.sb.root).runKey;
  assert.notEqual(callerRunKey, started.body.runKey);
  const actions = [
    { action: 'pause', by: 'u', reason: 'r' },
    { action: 'inspect' },
    { action: 'step' },
    { action: 'run', maxSeconds: '1' },
    { action: 'submit', dispatch: D_ID, status: 'success', summary: 'done' },
    { action: 'cancel', by: 'u', reason: 'r' },
    { action: 'takeover', by: 'u', reason: 'r', task: 'A.1' },
    { action: 'resume' },
  ];
  for (const flags of actions) {
    const r = await p.exec(flags, foreign);
    assert.equal(r.exit, 1, `${flags.action}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body, { disposition: 'refused', reason: 'foreign-run', runKey: started.body.runKey, callerRunKey }, flags.action);
  }
  assert.equal(p.bytes(), before, 'the store bytes are unchanged');
  const ledger = JSON.parse(fs.readFileSync(attempts.storeFile(p.sb.root, SLUG), 'utf8'));
  assert.equal(ledger.runs[started.body.runKey].control, 'running', 'the foreign pause changed nothing');
});

test('IC-001: a default-main caller starts and another default-main invocation controls the run', POSIX, async (t) => {
  const p = project(t);
  const started = await p.startWith({}, DEFAULT_MAIN);
  assert.equal(started.exit, 0, JSON.stringify(started.body));
  assert.match(started.body.runKey, /\/local\/main$/);
  assert.equal(p.sb.env.DOFLOW_WORKTREE, p.sb.root);
  const run = store.readDispatch(p.file).run;
  assert.deepEqual([run.run, run.lineage, run.lineageKind], ['local', 'main', 'default-main']);
  const paused = await p.exec({ action: 'pause', by: 'user', reason: 'look' }, DEFAULT_MAIN);
  assert.equal(paused.exit, 0, JSON.stringify(paused.body));
  assert.equal(paused.body.disposition, 'paused');
  const seen = await p.exec({ action: 'inspect' }, DEFAULT_MAIN);
  assert.equal(seen.exit, 0);
  assert.equal(seen.body.control, 'paused');
});

test('IC-001: every action but start and spawn needs a dispatch run: no-dispatch-run', POSIX, async (t) => {
  const p = project(t);
  for (const flags of [{ action: 'inspect' }, { action: 'step' }, { action: 'pause', by: 'u', reason: 'r' }]) {
    const r = await p.exec(flags);
    assert.equal(r.exit, 1);
    assert.equal(r.body.reason, 'no-dispatch-run', flags.action);
  }
  assert.equal(p.bytes(), null);
});

// ── start (IC-002) ───────────────────────────────────────────────────────────────────────────────

test('IC-002: a plan without the graph header is not-graph-plan', POSIX, async (t) => {
  const text = fs.readFileSync(path.join(PLAN_DIR, 'dependent.md'), 'utf8').replace('**Task graph:** v1\n', '');
  assert.ok(!text.includes('Task graph'));
  const p = project(t, { plan: text });
  const r = await p.startWith();
  assert.equal(r.exit, 1);
  assert.equal(r.body.reason, 'not-graph-plan');
  assert.equal(p.bytes(), null);
  assert.equal(fs.existsSync(p.worktrees), false);
});

test('IC-002: a non-git directory is not-a-git-worktree; a repository with no commit is no-head', POSIX, async (t) => {
  const sb = makeDispatchSandbox(t, { slug: SLUG });
  const plain = tempDir(t, 'doflow-dispatch-nogit-');
  const planFile = path.join(plain, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.copyFileSync(path.join(PLAN_DIR, 'dependent.md'), planFile);
  const env = withIdentity(sb.env, { DOFLOW_WORKTREE: plain });
  const run = () => executeDispatchCommand({ action: 'start', slug: SLUG, by: 'main', env, cwd: plain });
  const r = await run();
  assert.equal(r.exit, 1, JSON.stringify(r.body));
  assert.equal(r.body.reason, 'not-a-git-worktree');
  git(plain, env, ['init', '-q', '-b', 'main']);
  const empty = await run();
  assert.equal(empty.exit, 1, JSON.stringify(empty.body));
  assert.equal(empty.body.reason, 'no-head');
  assert.equal(fs.existsSync(path.join(plain, '.doflow')), false, 'nothing was written');
});

test('IC-002: a second start is dispatch-run-exists and makes no second worktree', POSIX, async (t) => {
  const p = project(t);
  const first = await p.startWith();
  assert.equal(first.exit, 0, JSON.stringify(first.body));
  const before = p.bytes();
  const second = await p.startWith();
  assert.equal(second.exit, 1);
  assert.deepEqual(second.body, { disposition: 'refused', reason: 'dispatch-run-exists', dispatchRunId: first.body.dispatchRunId, state: 'running' });
  assert.equal(p.bytes(), before);
  assert.deepEqual(fs.readdirSync(p.worktrees), [first.body.dispatchRunId]);
});

test('IC-002: an 080 run-exists at step 8 removes the integration worktree and carries its cleanup', POSIX, async (t) => {
  const p = project(t);
  const env = withIdentity(p.sb.env, {});
  const earlier = attempts.start({ file: attempts.storeFile(p.sb.root, SLUG), fsImpl: fs, roots: [p.sb.root], slug: SLUG, by: 'main', env, cwd: p.sb.root });
  assert.equal(earlier.disposition, 'started');
  const r = await p.startWith();
  assert.equal(r.exit, 1, JSON.stringify(r.body));
  assert.equal(r.body.disposition, 'refused');
  assert.equal(r.body.reason, 'run-exists');
  assert.equal(r.body.cleanup.verified, true, JSON.stringify(r.body.cleanup));
  assert.equal(fs.existsSync(r.body.cleanup.path), false);
  assert.equal(git(p.sb.root, env, ['branch', '--list', `doflow/${SLUG}/*`]), '', 'the integration branch is gone');
  assert.equal(store.readDispatch(p.file).run, null, 'no dispatch run was stored');
});

test('IC-002: a started run returns StartResult with baseDirty true over an uncommitted change', POSIX, async (t) => {
  const p = project(t);
  const head = git(p.sb.root, p.sb.env, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(p.sb.root, 'README.md'), '# changed, not committed\n');
  const r = await p.startWith({
    concurrency: '3', verifySeconds: '30', attemptSeconds: '90', reserveTokens: '50', budgetAttempts: '5', budgetTokens: '1000',
    spawnGrant: '{"depth":1,"children":2,"tokens":40}',
  });
  assert.equal(r.exit, 0, JSON.stringify(r.body));
  const b = r.body;
  assert.equal(b.disposition, 'started');
  assert.match(b.dispatchRunId, /^p-[0-9a-f]{12}$/);
  assert.equal(b.slug, SLUG);
  assert.equal(b.runKey, runKeyFor(p.sb.env, p.sb.root).runKey);
  assert.equal(b.epoch, 1);
  assert.deepEqual(b.integration, {
    worktree: path.join(p.worktrees, b.dispatchRunId), branch: `doflow/${SLUG}/${b.dispatchRunId}`, base: head,
  });
  assert.equal(b.baseDirty, true);
  assert.equal(b.concurrency, 3);
  assert.equal(b.mode, 'sequential');
  assert.deepEqual(b.verification, { declared: true, argc: p.sb.verifyArgv.length, sha256: argvDigest(p.sb.verifyArgv), seconds: 30 });
  assert.equal(b.reserveTokens, 50);
  assert.equal(b.attemptSeconds, 90);
  assert.equal(b.workerTimeoutSeconds, 210);
  assert.deepEqual(b.spawnGrant, { depth: 1, children: 2, tokens: 40 });
  assert.equal(git(b.integration.worktree, p.sb.env, ['rev-parse', 'HEAD']), head);
  assert.equal(fs.readFileSync(path.join(b.integration.worktree, 'README.md'), 'utf8'), '# dispatch sandbox\n', 'the uncommitted change is not in base');

  const run = store.readDispatch(p.file).run;
  assert.equal(run.state, 'running');
  assert.equal(run.runKey, b.runKey);
  assert.deepEqual([run.run, run.lineage, run.lineageKind], [p.sb.identity.DOFLOW_RUN_ID, 'main', 'launched']);
  assert.deepEqual(run.verify, { argv: p.sb.verifyArgv, argvSha256: argvDigest(p.sb.verifyArgv), argvCount: p.sb.verifyArgv.length, timeoutSeconds: 30 });
  assert.deepEqual(run.integration, { ...b.integration, head });
  assert.equal(run.reserveTokens, 50);
  const ledger = JSON.parse(fs.readFileSync(attempts.storeFile(p.sb.root, SLUG), 'utf8'));
  assert.deepEqual(ledger.runs[b.runKey].budget, { attempts: 5, tokens: 1000 });
  assert.equal(ledger.runs[b.runKey].control, 'running');
});

test('IC-002: a clean caller checkout is baseDirty false; no --verify-argv is accepted and undeclared', POSIX, async (t) => {
  const p = project(t);
  const r = await p.startWith({ verifyArgv: undefined, mode: undefined });
  assert.equal(r.exit, 0, JSON.stringify(r.body));
  assert.equal(r.body.baseDirty, false);
  assert.equal(r.body.mode, 'auto');
  assert.equal(r.body.concurrency, 2);
  assert.equal(r.body.attemptSeconds, 1680);
  assert.deepEqual(r.body.verification, { declared: false, argc: 0, sha256: null, seconds: 600 });
  assert.equal(r.body.spawnGrant, null);
  assert.equal(r.body.reserveTokens, null);
});

test('IC-001: a step whose outcome is blocked exits 0; the text form prints one line and no argv', POSIX, async (t) => {
  const p = project(t);
  const started = await p.startWith({ verifyArgv: undefined });
  assert.equal(started.exit, 0, JSON.stringify(started.body));
  const stepped = await p.exec({ action: 'step' });
  assert.equal(stepped.exit, 0, JSON.stringify(stepped.body));
  assert.equal(stepped.body.disposition, 'stepped');
  assert.equal(stepped.body.outcome, 'blocked');
  assert.ok(stepped.body.blocked.gaps.some((g) => g.kind === 'verification-undeclared'), JSON.stringify(stepped.body.blocked));

  // The text form, on a second sandbox whose run declares an argv.
  const q = project(t);
  const lines = [];
  const original = { log: console.log, error: console.error, exitCode: process.exitCode };
  console.log = (line) => lines.push(['out', String(line)]);
  console.error = (line) => lines.push(['err', String(line)]);
  let exit;
  try {
    exit = await handleDispatchCommand({ action: 'start', slug: SLUG, by: 'main', mode: 'sequential', verifyArgv: JSON.stringify(q.sb.verifyArgv), env: withIdentity(q.sb.env, {}), cwd: q.sb.root });
  } finally {
    console.log = original.log;
    console.error = original.error;
    process.exitCode = original.exitCode;
  }
  assert.equal(exit, 0);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(lines[0][0], 'out');
  assert.match(lines[0][1], /^started p-[0-9a-f]{12} /);
  for (const arg of q.sb.verifyArgv) assert.ok(!lines[0][1].includes(arg), 'no argv element is printed');
});

test('106 IC-005: start stores run.fallback from --fallback and --ladder, else from the dispatch.fallback setting', POSIX, async (t) => {
  const p = project(t);
  const r = await p.startWith({ fallback: 'auto', ladder: 'gemini, claude' });
  assert.equal(r.exit, 0, JSON.stringify(r.body));
  assert.deepEqual(store.readDispatch(p.file).run.fallback, { mode: 'auto', ladder: ['gemini', 'claude'], exhausted: [], holds: {}, events: [], eventsDropped: 0 });

  const q = project(t);
  assert.equal((await q.startWith()).exit, 0);
  assert.deepEqual(store.readDispatch(q.file).run.fallback, { mode: 'ask', ladder: null, exhausted: [], holds: {}, events: [], eventsDropped: 0 }, 'the setting default');

  const o = project(t);
  fs.mkdirSync(path.join(o.sb.root, '.doflow'), { recursive: true });
  fs.writeFileSync(path.join(o.sb.root, '.doflow', 'settings.json'), `${JSON.stringify({ 'dispatch.fallback': 'off' })}\n`);
  assert.equal((await o.startWith()).exit, 0);
  assert.equal(store.readDispatch(o.file).run.fallback.mode, 'off', 'a project may narrow the setting to off');
});
