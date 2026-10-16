'use strict';

// Feature 082 D.3 (IC-040, requirement §6; DEC-010, DEC-011, DEC-014, DEC-046, DEC-058): the
// three-mode acceptance suite and the cleanup check.
//
// Each requirement §6 scenario runs once per mode IC-040's table names, through the `dispatch` verb
// in process (`executeDispatchCommand`: start, step, run, submit, spawn and the controls), on a
// sandbox from test/helper/dispatch-sandbox.js. The modes:
//   - manual and sequential: `--mode manual` / `--mode sequential`. A test performer plays the user
//     (or the main session): it edits the yielded attempt worktree by path and calls `submit`.
//   - subagent: `--mode auto` with the claude fake's `isolatedEdit` supported (editDescriptors())
//     and probed. The fake CLI's `doflow` step runs PERFORMER below inside the worker, which reads
//     the same per-task spec the in-process performer reads, so both sides make the same edits.
// Every scenario that runs in more than one mode records its 080 task states and parent outcome;
// the FR-020 test at the end asserts they are equal across the modes.
//
// No real harness, model call or login (NFR-002): the child PATH is the sandbox's scratch bin/
// alone (fake CLI links, node and git, plus dirname, date and mkdir for the one dispatcher case),
// never dirname(process.execPath) (DEC-056). The five DOFLOW_* identity variables are set by the
// sandbox, with DOFLOW_ATTEMPT deleted (or set explicitly) so the caller is not the unit a token-1
// worker becomes. Every project registers its process cleanup before its sandbox (after hooks run
// in registration order), so no supervisor outlives its sandbox; the last test asserts that no
// recorded worker process outlived its test. POSIX only: tree cleanup is unverified on win32
// (NFR-005), so on win32 the sandbox cannot be built and every case skips with that reason.
//
// The race and the leak scan live beside this file in test/runtime/dispatch-race.test.js and
// test/runtime/dispatch-secrets.test.js (D.4, DEC-058).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.js');
const DESCRIPTORS = require('../fixtures/worker/descriptors.json');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const readiness = require(path.join(SRC, 'worker', 'readiness.ts'));
const tree = require(path.join(SRC, 'worker', 'process-tree.ts'));
const { readRuns, storeFileFor: runStoreFileFor } = require(path.join(SRC, 'worker', 'run-store.ts'));
const { cancelRun } = require(path.join(SRC, 'worker', 'cancel.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { WORKTREES_DIR } = require(path.join(SRC, 'dispatch', 'integrate.ts'));
const { executeDispatchCommand } = require(path.join(SRC, 'dispatch', 'command.ts'));

const SLUG = '082-dispatch-e2e';
const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const RUN = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const POSIX = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
const MODES = Object.freeze(['manual', 'sequential', 'subagent']);
const POLICY = Object.freeze({ manual: 'manual', sequential: 'sequential', subagent: 'auto' });
const MAIN_SESSION = Object.freeze(['manual', 'sequential']);
const ALL = MODES;
const SUBAGENT = Object.freeze(['subagent']);
const TOKENS = 5;
const SUCCESS = { type: 'result', status: 'success', summary: 'edited' };
const TERMINAL = Object.freeze(['completed', 'blocked', 'cancelled', 'resume-required', 'paused']);

/** Verification that fails when any file under src/ holds BAD (run in the integration worktree). */
const VERIFY_NO_BAD = "const fs=require('fs'),p=require('path');let bad=false;(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())w(f);else if(fs.readFileSync(f,'utf8').includes('BAD'))bad=true;}})('src');process.exitCode=bad?1:0;";
/** Verification that passes until its `n`-th call, counting in VERIFY_COUNT. */
const countingVerify = (n) => `const fs=require('fs');const f=process.env.VERIFY_COUNT;const c=(fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0)+1;fs.writeFileSync(f,String(c));process.exitCode=c>=${n}?1:0;`;

const plan = (title, lines) => ['# Implementation Plan: ' + title, '', '**Task graph:** v1', '', '## 8. Tasks', '', '### Phase A', '', ...lines.flatMap((l) => [l, '']), ''].join('\n');
const TWO_TASKS = plan('e2e, two tasks', [
  '- [ ] A.1 Write module a — owner: core-implementer; files: src/a.js',
  '- [ ] A.2 Write module b — owner: core-implementer; files: src/b.js',
]);
const THREE_TASKS = plan('e2e, three tasks', [
  '- [ ] A.1 Write module a — owner: core-implementer; files: src/a.js',
  '- [ ] A.2 Write module b — owner: core-implementer; files: src/b.js',
  '- [ ] A.3 Write module c — owner: core-implementer; files: src/c.js',
]);
const THREE_DEPENDENT = plan('e2e, budget gap', [
  '- [ ] A.1 Write module a — owner: core-implementer; files: src/a.js',
  '- [ ] A.2 Write module b — owner: core-implementer; files: src/b.js',
  '- [ ] A.3 Join a and b — owner: core-implementer; files: src/c.js; depends-on: A.2',
]);
const THREE_ATTEMPTS = plan('e2e, attempt budget 3', ['- [ ] A.1 Retry the module — owner: core-implementer; files: src/retry.js; budget: attempts=3']);
const MANY_FILES = Array.from({ length: 350 }, (_, i) => `src/m/f${String(i).padStart(3, '0')}.js`);
const WIDE_TASK = plan('e2e, wide write set', [`- [ ] A.1 Touch one of many modules — owner: core-implementer; files: ${MANY_FILES.join(', ')}`]);

/**
 * The edits one attempt of `task` makes: `spec['*']`, then `spec[task].any`, then
 * `spec[task][token]`, merged in that order. With no `write`, every declared file gets one line.
 * Shared by the in-process performer and, through its source, by PERFORMER inside the worker.
 */
function actFor(spec, task, token, files) {
  const byTask = spec[task] || {};
  const act = Object.assign({}, spec['*'] || {}, byTask.any || {}, byTask[String(token)] || {});
  if (!act.write) {
    act.write = {};
    for (const f of files) act.write[f] = `// ${task} token ${token}\n`;
  }
  return act;
}

/** The fake CLI's `doflow` step script: the subagent side of the performer (IC-041 `doflow`). */
const PERFORMER = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
  actFor.toString(),
  "const spec = JSON.parse(fs.readFileSync(process.env.PERFORM_SPEC, 'utf8'));",
  // The store is read unlocked: a read racing a rename retries. The handoff is read by its fixed
  // name, written before the worker starts (the dispatch records its pointer only after).
  'const read = () => { for (let i = 0; ; i += 1) { try { return JSON.parse(fs.readFileSync(process.env.PERFORM_STORE, \'utf8\')); } catch (e) { if (i > 50) throw e; pause(20); } } };',
  'const here = path.basename(process.cwd());',
  'let act;',
  'if (/\\.c[0-9]+$/.test(here)) act = spec.child || {};',
  'else {',
  '  const d = read().dispatches[here];',
  "  const handoff = JSON.parse(fs.readFileSync(path.join(process.env.PERFORM_ROOT, '.doflow', 'state', 'dispatch-envelopes', `${here}.handoff.json`), 'utf8'));",
  '  act = actFor(spec, d.task, d.token, handoff.task.files || []);',
  '  for (const [rel, text] of Object.entries(act.write)) { fs.mkdirSync(path.dirname(rel), { recursive: true }); fs.writeFileSync(rel, text); }',
  '  for (const s of act.stray || []) fs.writeFileSync(s.path, s.content);',
  '  if (act.sibling) {',
  "    const other = Object.values(read().dispatches).find((x) => x.task !== d.task && x.phase !== 'ended' && x.attempt && x.attempt.worktree);",
  '    if (other) fs.writeFileSync(path.join(other.attempt.worktree, act.sibling.path), act.sibling.content);',
  '  }',
  '}',
  "if (act.mark) fs.writeFileSync(act.mark, 'done');",
  'if (act.waitFor) { const end = Date.now() + 25000; while (!fs.existsSync(act.waitFor) && Date.now() < end) pause(50); }',
  'if (act.sleepMs) pause(act.sleepMs);',
  '',
].join('\n');

/** Scenario id -> mode -> the task states and parent outcome that mode produced (FR-020). */
const RECORDED = {};
/** Scenario id -> the modes it is declared for. */
const DECLARED = {};
/** Worker processes still alive after their test's own cleanup (should stay empty). */
const LEFTOVERS = [];
let CHECKED_PROCESSES = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function git(cwd, env, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function kill(target, signal = 'SIGKILL') {
  try { process.kill(target, signal); } catch { /* ended */ }
}

async function until(check, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** The most dispatches active at once, from their claim and end times. */
function maxActive(dispatches) {
  const events = [];
  for (const d of dispatches) {
    if (!d.claimedAt) continue;
    events.push([Date.parse(d.claimedAt), 1]);
    events.push([d.endedAt ? Date.parse(d.endedAt) : Infinity, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let max = 0;
  for (const [, delta] of events) { now += delta; max = Math.max(max, now); }
  return max;
}

/** `doflow-attempt/` worktrees and branches left in the caller repository. */
function attemptLeftovers(root, env) {
  const list = git(root, env, ['worktree', 'list', '--porcelain']).split('\n');
  return {
    worktrees: list.filter((l) => l.startsWith('branch refs/heads/doflow-attempt/')),
    branches: git(root, env, ['branch', '--list', 'doflow-attempt/*']).split('\n').map((l) => l.trim()).filter(Boolean),
    integration: list.filter((l) => l.startsWith('branch refs/heads/doflow/')),
  };
}

function callerState(root, env) {
  return {
    head: git(root, env, ['rev-parse', 'HEAD']),
    ref: git(root, env, ['symbolic-ref', '-q', 'HEAD']),
    branches: git(root, env, ['branch', '--list', '--format=%(refname)']),
    status: git(root, env, ['status', '--porcelain=v1', '--untracked-files=all']),
  };
}

/**
 * A sandbox with a dispatch run started through the verb in `mode`. Options: `plan`, `concurrency`,
 * `verify` (the verification script), `spec` (actFor's input), `start` (extra start flags),
 * `scenario` (the fake CLI's), `descriptors` (`'edit'` default, `'raw'` descriptors.json,
 * `'registry'` the real registry), `probe`, `identity`, `systemTools`, `extraEnv`, `startNow`.
 */
async function project(t, mode, {
  plan: planText = 'budget', concurrency = 2, verify, spec = {}, start = {}, scenario, descriptors = 'edit', probe = mode === 'subagent',
  identity = {}, systemTools = [], extraEnv = {}, startNow = true,
} = {}) {
  // Registered before the sandbox, so it runs before the sandbox is removed: every 081 run still
  // live is ended through 081, then any process still alive is recorded as a leftover and killed.
  const live = {};
  t.after(async () => {
    if (!live.runStore || !fs.existsSync(live.runStore)) return;
    for (const run of Object.values(readRuns(live.runStore))) {
      if (run.phase === 'ended') continue;
      try { await cancelRun({ file: live.runStore, runId: run.runId, by: 'test', reason: 'test cleanup', env: live.env, cwd: live.root }); } catch { /* recorded below */ }
    }
    for (const run of Object.values(readRuns(live.runStore))) {
      for (const proc of [run.supervisor, run.worker]) {
        if (!proc || !Number.isInteger(proc.pid)) continue;
        CHECKED_PROCESSES += 1;
        // A supervisor writes its end record before it exits: allow it a moment.
        for (let i = 0; i < 50 && tree.alive(proc) === true; i += 1) await sleep(100);
        if (tree.alive(proc) === true) {
          LEFTOVERS.push({ test: t.name, runId: run.runId, pid: proc.pid });
          if (Number.isInteger(proc.pgid)) kill(-proc.pgid);
          kill(proc.pid);
        }
      }
    }
  });
  const fakeScenario = scenario || { run: [{ doflow: { args: [] } }, { emit: { type: 'usage', tokens: TOKENS } }, { emit: SUCCESS }] };
  const sb = makeDispatchSandbox(t, {
    plan: planText, slug: SLUG, scenario: fakeScenario, identity: { DOFLOW_ATTEMPT: undefined, ...identity }, systemTools,
    ...(verify ? { verify } : {}),
  });
  const { root } = sb;
  const file = store.storeFileFor(root, SLUG);
  const env = {
    ...sb.env,
    PERFORM_ROOT: root,
    PERFORM_SPEC: path.join(sb.dir, 'perform-spec.json'),
    PERFORM_STORE: file,
    FAKE_DOFLOW_CLI: path.join(sb.dir, 'performer.js'),
    VERIFY_COUNT: path.join(sb.dir, 'verify-count'),
    ...extraEnv,
  };
  fs.writeFileSync(env.FAKE_DOFLOW_CLI, PERFORMER);
  const p = { sb, root, env, file, mode, spec: null, steps: [] };
  p.setSpec = (next) => { p.spec = next; fs.writeFileSync(env.PERFORM_SPEC, JSON.stringify(next)); };
  p.setSpec(spec);
  p.descriptors = descriptors === 'edit' ? sb.descriptors : descriptors === 'raw' ? structuredClone(DESCRIPTORS) : undefined;
  p.runStore = runStoreFileFor(root, SLUG);
  Object.assign(live, { runStore: p.runStore, env, root });
  p.ledgerFile = attempts.storeFile(root, SLUG);
  p.common = { file: p.ledgerFile, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root };
  p.read = () => store.readDispatch(file);
  p.ledger = () => JSON.parse(fs.readFileSync(p.ledgerFile, 'utf8'));
  p.states = () => Object.fromEntries(attempts.inspect(p.common).tasks.map((r) => [r.id, r.state]));
  p.dispatches = () => Object.values(p.read().dispatches).sort((a, b) => a.task.localeCompare(b.task) || a.token - b.token);
  p.exec = (options, over = null) => executeDispatchCommand({
    slug: SLUG, cwd: root, ...(p.descriptors ? { descriptors: p.descriptors } : {}), ...options, env: over || env,
  });
  p.start = async (extra = {}) => {
    const { exit, body } = await p.exec({
      action: 'start', by: 'main', mode: POLICY[mode], verifyArgv: JSON.stringify(sb.verifyArgv), concurrency: String(concurrency), ...start, ...extra,
    });
    assert.equal(exit, 0, JSON.stringify(body));
    assert.equal(body.disposition, 'started');
    p.started = body;
    return body;
  };

  /** The test performer: edits the yielded worktree by path, then submits through the verb. */
  p.perform = async (y) => {
    const handoff = JSON.parse(fs.readFileSync(y.handoff.path, 'utf8'));
    const act = actFor(p.spec, y.task, y.token, handoff.task.files || []);
    for (const [rel, text] of Object.entries(act.write)) {
      fs.mkdirSync(path.dirname(path.join(y.worktree, rel)), { recursive: true });
      fs.writeFileSync(path.join(y.worktree, rel), text);
    }
    for (const s of act.stray || []) fs.writeFileSync(s.path, s.content);
    const { body } = await p.exec({
      action: 'submit', dispatch: y.dispatchId, status: act.status || 'success', summary: act.summary || `done ${y.task}`,
      tokens: String(act.tokens ?? TOKENS), tokensBasis: 'measured',
    });
    assert.ok(['submitted', 'stale'].includes(body.disposition), JSON.stringify(body));
    return body;
  };

  /**
   * Steps through the verb until `stop(result)` or a terminal outcome. Each perform yield is
   * answered by the performer; `onLaunched(dispatch)` runs once per dispatch first seen launched,
   * before its yield is answered; `onStep(result)` after every pass.
   */
  p.drive = async ({ stop = (r) => TERMINAL.includes(r.outcome), onLaunched = null, onStep = null, max = 200 } = {}) => {
    const seen = new Set();
    for (let i = 0; i < max; i += 1) {
      const { exit, body } = await p.exec({ action: 'step' });
      assert.equal(exit, 0, JSON.stringify(body));
      assert.equal(body.disposition, 'stepped', JSON.stringify(body));
      p.steps.push(body);
      if (onStep) await onStep(body);
      if (onLaunched) {
        for (const d of Object.values(p.read().dispatches)) {
          if (d.phase === 'launched' && !seen.has(d.dispatchId)) { seen.add(d.dispatchId); await onLaunched(d, body); }
        }
      }
      if (stop(body)) return body;
      if (body.outcome === 'perform') await p.perform(body.perform);
      else if (TERMINAL.includes(body.outcome)) return body;
      else await sleep(100);
    }
    assert.fail(`drive did not finish in ${max} passes`);
  };

  /** Repeats the `run` verb, answering each perform yield, until a terminal outcome. */
  p.runToEnd = async () => {
    for (let i = 0; i < 40; i += 1) {
      const { exit, body } = await p.exec({ action: 'run', maxSeconds: 120 });
      assert.equal(exit, 0, JSON.stringify(body));
      assert.equal(body.disposition, 'ran', JSON.stringify(body));
      assert.equal(body.timeUp, false);
      if (body.outcome === 'perform') { await p.perform(body.last.perform); continue; }
      return body.last;
    }
    assert.fail('run did not finish');
  };

  if (probe) assert.equal((await readiness.probe({ descriptors: p.descriptors, env, cwd: root })).disposition, 'probed');
  if (startNow) await p.start();
  p.before = callerState(root, env);
  return p;
}

/** Declares one test per applicable mode; `fn(t, mode)` returns what FR-020 compares, or null. */
function scenario(id, title, modes, fn, options = {}) {
  DECLARED[id] = modes;
  for (const mode of modes) {
    test(`${id} [${mode}]: ${title}`, { ...POSIX, ...options }, async (t) => {
      const started = Date.now();
      const recorded = await fn(t, mode);
      t.diagnostic(`${mode} took ${Date.now() - started} ms`);
      if (recorded) (RECORDED[id] = RECORDED[id] || {})[mode] = recorded;
    });
  }
}

const outcomeOf = (p, outcome) => ({ states: p.states(), outcome });

// ── US1 / FR-001, FR-014: completion ─────────────────────────────────────────────────────────────

scenario('graph-completion', 'a graph runs to verified completion: the third task waits for both others, each step records its reason', ALL, async (t, mode) => {
  const p = await project(t, mode, { plan: 'dependent', concurrency: 2 });
  const last = await p.runToEnd();
  assert.equal(last.outcome, 'completed', JSON.stringify(last.blocked || last.actions));
  const s = p.read();
  const done = (task) => Object.values(s.dispatches).find((d) => d.task === task && d.disposition === 'completed');
  for (const task of ['A.1', 'A.2', 'A.3']) assert.ok(done(task), `${task} completed`);
  assert.ok(Date.parse(done('A.3').claimedAt) >= Math.max(Date.parse(done('A.1').endedAt), Date.parse(done('A.2').endedAt)), 'A.3 is claimed only after A.1 and A.2 end');
  for (const d of Object.values(s.dispatches)) assert.equal(d.mode, mode, 'every attempt records the mode');
  assert.ok(s.steps.length > 0);
  for (const st of s.steps) {
    assert.equal(st.actions.at(-1).action, 'decide', `step ${st.step} ends with its decision`);
    for (const a of st.actions) assert.ok(typeof a.reason === 'string' && a.reason.length > 0, `step ${st.step} ${a.action} records a reason`);
  }
  const c = last.completion;
  assert.equal(c.finalVerification.exitCode, 0);
  assert.match(c.finalVerification.evidenceId, /\S/);
  assert.equal(s.run.verifications.at(-1).evidenceId, c.finalVerification.evidenceId, 'the final evidence is recorded on the run');
  assert.deepEqual(c.tasks.map((x) => x.id), ['A.1', 'A.2', 'A.3']);
  assert.equal(fs.readFileSync(path.join(c.integration.worktree, 'src', 'join.js'), 'utf8'), '// A.3 token 1\n');
  assert.deepEqual(callerState(p.root, p.env), p.before, 'the caller checkout is never written');
  return outcomeOf(p, last.outcome);
});

// ── US2 / FR-002: the concurrency bound ──────────────────────────────────────────────────────────

scenario('concurrency-bound', 'four disjoint READY tasks under a limit of 2: never more than two active, the others wait', ALL, async (t, mode) => {
  const p = await project(t, mode, { plan: 'disjoint', concurrency: 2, spec: { '*': { sleepMs: 700 } } });
  let peakNonEnded = 0;
  const last = await p.drive({
    onStep: () => { peakNonEnded = Math.max(peakNonEnded, Object.values(p.read().dispatches).filter((d) => d.phase !== 'ended').length); },
  });
  assert.equal(last.outcome, 'completed', JSON.stringify(last.blocked || last.actions));
  const first = p.steps[0];
  const admitted = first.actions.filter((a) => a.action === 'admit' && !String(a.reason).startsWith('skipped:')).map((a) => a.task);
  assert.equal(new Set(admitted).size, mode === 'subagent' ? 2 : 1, JSON.stringify(first.actions));
  const waiting = ['A.1', 'A.2', 'A.3', 'A.4'].filter((task) => !admitted.includes(task));
  for (const task of waiting) {
    assert.ok(first.actions.some((a) => a.action === 'admit' && a.task === task && String(a.reason).startsWith('skipped:')), `${task} waits: ${JSON.stringify(first.actions)}`);
  }
  const ds = p.dispatches();
  assert.ok(peakNonEnded <= 2, `at most two non-ended dispatches, saw ${peakNonEnded}`);
  assert.ok(maxActive(ds) <= 2);
  assert.equal(maxActive(ds), mode === 'subagent' ? 2 : 1, 'subagents use the room; one main session runs one attempt at a time');
  assert.equal(p.read().run.peak.workers, mode === 'subagent' ? 2 : 0);
  return outcomeOf(p, last.outcome);
});

// ── US2 / FR-004: the budget is not replicated ───────────────────────────────────────────────────

scenario('budget-not-replicated', 'a remaining budget that fits one reservation starts one dispatch, and reservations never exceed it', ALL, async (t, mode) => {
  const p = await project(t, mode, {
    plan: TWO_TASKS, concurrency: 2, start: { reserveTokens: '10', budgetTokens: '10' },
    spec: { '*': { tokens: 10 } }, scenario: { run: [{ doflow: { args: [] } }, { emit: { type: 'usage', tokens: 10 } }, { emit: SUCCESS }] },
  });
  let peakNonEnded = 0;
  const totals = () => p.ledger().runs[p.started.runKey].totals.tokens;
  const last = await p.drive({
    onStep: () => {
      peakNonEnded = Math.max(peakNonEnded, Object.values(p.read().dispatches).filter((d) => d.phase !== 'ended').length);
      const tok = totals();
      assert.ok(tok.reserved + tok.measured + tok.estimated <= 10, `reserved and spent stay within the budget: ${JSON.stringify(tok)}`);
    },
  });
  assert.equal(peakNonEnded, 1, 'only one dispatch is ever active');
  assert.deepEqual(p.dispatches().map((d) => d.task), ['A.1'], 'only one dispatch starts');
  const refusedClaims = p.steps.flatMap((s) => s.actions).filter((a) => a.task === 'A.2' && /aggregate-exhausted/.test(a.reason));
  assert.ok(refusedClaims.length >= 1, 'A.2 is refused for the aggregate budget');
  assert.equal(last.outcome, 'blocked', JSON.stringify(last));
  assert.equal(last.blocked.cause, 'budget');
  return outcomeOf(p, last.outcome);
});

// ── US3 / FR-006, FR-007: compact envelopes ──────────────────────────────────────────────────────

scenario('envelopes-compact', 'source pointers past the bound overflow to a sidecar; the result holds no transcript and only the changes git shows', ALL, async (t, mode) => {
  const line = 'TRANSCRIPT-LINE the worker thought about this for a long while';
  const claim = 'changed src/m/f000.js and src/never.js';
  const p = await project(t, mode, {
    plan: WIDE_TASK, concurrency: 1,
    spec: { 'A.1': { any: { write: { 'src/m/f000.js': '// edited\n' }, summary: `${claim}\n${`${line}\n`.repeat(100)}` } } },
    scenario: { run: [{ doflow: { args: [] } }, { printRepeat: { text: line, times: 2000 } }, { emit: { type: 'usage', tokens: TOKENS } }, { emit: { type: 'result', status: 'success', summary: claim } }] },
  });
  const last = await p.drive();
  assert.equal(last.outcome, 'completed', JSON.stringify(last.blocked || last.actions));
  const [d] = p.dispatches();
  const stateRoot = path.join(p.root, '.doflow', 'state');
  const handoffBytes = fs.readFileSync(path.join(stateRoot, d.envelopes.handoff));
  assert.ok(handoffBytes.length <= 16384, `handoff ${handoffBytes.length} bytes`);
  const handoff = JSON.parse(handoffBytes);
  const over = handoff.overflow.find((o) => o.list === 'sources');
  assert.ok(over, JSON.stringify(handoff.overflow));
  assert.equal(over.total, MANY_FILES.length + 3, 'every declared file and the three chain artifacts');
  assert.ok(over.kept < over.total && over.kept === handoff.sources.length);
  const sidecar = JSON.parse(fs.readFileSync(path.join(stateRoot, over.pointer), 'utf8'));
  assert.equal(sidecar.length, over.total - over.kept, 'the sidecar holds the pointers past the bound');

  const resultText = fs.readFileSync(path.join(stateRoot, d.envelopes.result), 'utf8');
  assert.ok(Buffer.byteLength(resultText) <= 32768);
  const result = JSON.parse(resultText);
  assert.deepEqual(result.changes, [{ path: 'src/m/f000.js', change: 'M', from: null }], 'change refs come from the worktree, not the claim');
  assert.ok(Buffer.byteLength(result.summary) <= 2000, 'a main-session summary is cut, never a transcript');
  const transcriptBytes = (resultText.split(line).length - 1) * line.length;
  assert.ok(transcriptBytes <= 2000, `the result carries no transcript (${transcriptBytes} bytes of it)`);
  if (mode === 'subagent') assert.equal(resultText.includes(line), false, 'the worker transcript stays in its output file');
  return outcomeOf(p, last.outcome);
});

// ── US2 / FR-011: overlapping edits ──────────────────────────────────────────────────────────────

scenario('overlap-serialized', 'two tasks declaring one file and one declaring none never run alongside each other', ALL, async (t, mode) => {
  const p = await project(t, mode, { plan: 'overlap', concurrency: 2, spec: { '*': { sleepMs: 300 } } });
  const last = await p.drive();
  assert.equal(last.outcome, 'completed', JSON.stringify(last.blocked || last.actions));
  assert.equal(maxActive(p.dispatches()), 1, 'none of the three is ever active alongside another');
  const reasons = p.steps.flatMap((s) => s.actions).filter((a) => a.action === 'admit' && String(a.reason).startsWith('skipped:overlap'));
  if (mode === 'subagent') assert.ok(reasons.length >= 1, 'subagent admission names the overlap');
  return outcomeOf(p, last.outcome);
});

// ── US2 / FR-011, FR-013: integration conflict ───────────────────────────────────────────────────

scenario('conflict-fails-attempt', 'a change conflicting with an earlier integration integrates nothing, fails conflict, and the retry starts from the current base', SUBAGENT, async (t, mode) => {
  const p = await project(t, mode, {
    plan: TWO_TASKS, concurrency: 2,
    spec: { 'A.1': { any: { write: { 'src/a.js': '// from A.1\n' } } }, 'A.2': { 1: { write: { 'src/b.js': '// b\n', 'src/a.js': '// from A.2\n' }, sleepMs: 1500 } } },
  });
  const last = await p.drive();
  assert.equal(last.outcome, 'completed', JSON.stringify(last.blocked || last.actions));
  const [a1, b1, b2] = p.dispatches();
  assert.deepEqual([a1.task, a1.disposition], ['A.1', 'completed']);
  assert.deepEqual([b1.task, b1.token, b1.disposition, b1.failureClass], ['A.2', 1, 'failed', 'conflict']);
  assert.deepEqual([b2.task, b2.token, b2.disposition], ['A.2', 2, 'completed']);
  assert.equal(b1.integratedCommit ?? null, null, 'nothing of the conflicting attempt is integrated');
  assert.equal(b2.attempt.base, a1.integratedCommit, 'the retry starts from the integration head after A.1');
  const [l1, l2] = p.ledger().tasks['A.2'].attempts;
  assert.equal(l1.result, 'FAILED');
  assert.match(l1.reason, /^conflict/);
  assert.equal(l2.result, 'COMPLETED');
  const wt = p.started.integration.worktree;
  assert.equal(git(wt, p.env, ['show', 'HEAD:src/a.js']), '// from A.1', 'the conflicting edit never landed');
  assert.equal(git(wt, p.env, ['show', 'HEAD:src/b.js']), '// A.2 token 2', 'the retry, made on the current base, integrates cleanly');
  assert.equal(git(wt, p.env, ['rev-parse', `${b2.integratedCommit}^`]), a1.integratedCommit, 'nothing was integrated between A.1 and the retry');
  return null;
});

// ── US4 / FR-012: failed verification undoes ─────────────────────────────────────────────────────

scenario('failed-verification-undoes', 'a change that fails the run verification is undone and the attempt fails with the evidence', ALL, async (t, mode) => {
  const p = await project(t, mode, { plan: 'budget', verify: VERIFY_NO_BAD, spec: { 'A.1': { 1: { write: { 'src/retry.js': '// BAD\n' } } } } });
  const base = p.started.integration.base;
  const firstEnded = () => p.dispatches().find((d) => d.token === 1 && d.phase === 'ended');
  await p.drive({ stop: (r) => Boolean(firstEnded()) || TERMINAL.includes(r.outcome) });
  const d = firstEnded();
  assert.deepEqual([d.disposition, d.failureClass], ['failed', 'verification'], JSON.stringify(d));
  assert.match(String(d.evidenceId), /\S/, 'the failing evidence is stored');
  const wt = p.started.integration.worktree;
  assert.equal(git(wt, p.env, ['rev-parse', 'HEAD']), base, 'the integration is undone');
  assert.equal(p.read().run.integration.head, base);
  assert.equal(fs.readFileSync(path.join(wt, 'src', 'retry.js'), 'utf8'), '// src/retry.js\n');
  const [a1] = p.ledger().tasks['A.1'].attempts;
  assert.equal(a1.result, 'FAILED');
  assert.match(a1.reason, /^verification/);
  const states = p.states();
  assert.notEqual(states['A.1'], 'SUCCEEDED');
  const last = await p.drive();
  assert.equal(last.outcome, 'completed', 'the retry within budget completes');
  return { states, outcome: last.outcome };
});

// ── US1 / FR-013, FR-015: repeated failure ───────────────────────────────────────────────────────

scenario('repeated-failure-blocks', 'two equal failures block the task with that class, plan.md unchanged, reported as a gap', ALL, async (t, mode) => {
  // A budget of 3, so the block comes from the repeat rule and not from an exhausted budget.
  const p = await project(t, mode, { plan: THREE_ATTEMPTS, verify: VERIFY_NO_BAD, spec: { 'A.1': { any: { write: { 'src/retry.js': '// BAD\n' } } } } });
  const planBefore = fs.readFileSync(p.sb.planFile);
  const last = await p.drive();
  assert.equal(last.outcome, 'blocked', JSON.stringify(last));
  const list = p.ledger().tasks['A.1'].attempts;
  assert.deepEqual(list.map((a) => a.result), ['FAILED', 'BLOCKED']);
  assert.equal(list[1].reason, 'verification: repeated');
  assert.deepEqual(fs.readFileSync(p.sb.planFile), planBefore, 'plan.md is byte-identical');
  const gap = last.blocked.gaps.find((g) => g.task === 'A.1');
  assert.deepEqual([gap.kind, gap.cause], ['verification', 'no-progress'], JSON.stringify(last.blocked));
  return outcomeOf(p, last.outcome);
});

// ── US4 / FR-014: no false completion ────────────────────────────────────────────────────────────

scenario('no-false-completion', 'every worker done and the final verification failing leaves the parent incomplete, naming the verification', ALL, async (t, mode) => {
  const p = await project(t, mode, { plan: 'budget', verify: countingVerify(2) });
  const last = await p.drive();
  assert.equal(last.outcome, 'blocked', JSON.stringify(last.completion || last));
  const s = p.read();
  assert.equal(s.run.state, 'blocked');
  assert.equal(s.run.completion, undefined, 'no completion record');
  const gap = last.blocked.gaps.find((g) => g.kind === 'final-verification-failed');
  assert.ok(gap, JSON.stringify(last.blocked));
  assert.equal(gap.evidenceId, s.run.verifications.at(-1).evidenceId, 'the result names the failing verification');
  assert.equal(s.run.verifications.at(-1).exitCode, 1);
  return outcomeOf(p, last.outcome);
});

// ── US4 / FR-015: blocked run reports gaps ───────────────────────────────────────────────────────

scenario('blocked-run-gaps', 'an exhausted aggregate with a task still PLANNED returns BLOCKED budget with completed, integrated and gaps', ALL, async (t, mode) => {
  const p = await project(t, mode, {
    plan: THREE_DEPENDENT, concurrency: 1, start: { reserveTokens: '10', budgetTokens: '10' },
    spec: { '*': { tokens: 10 } }, scenario: { run: [{ doflow: { args: [] } }, { emit: { type: 'usage', tokens: 10 } }, { emit: SUCCESS }] },
  });
  const last = await p.drive();
  assert.equal(last.outcome, 'blocked', JSON.stringify(last));
  const b = last.blocked;
  assert.equal(b.cause, 'budget');
  assert.deepEqual(b.completed.map((c) => c.task), ['A.1']);
  const [a1] = p.dispatches();
  assert.deepEqual(b.integrated.map((x) => [x.task, x.commit]), [['A.1', a1.integratedCommit]]);
  const gap = (task) => b.gaps.find((g) => g.task === task) || assert.fail(JSON.stringify(b));
  assert.deepEqual([gap('A.2').kind, gap('A.2').cause], ['aggregate-exhausted', 'budget'], JSON.stringify(b.gaps));
  assert.deepEqual(gap('A.2').blocks, ['A.3'], 'the PLANNED task is reported behind the gap that holds it');
  assert.equal(p.states()['A.3'], 'PLANNED');
  return outcomeOf(p, last.outcome);
});

// ── US5 / FR-017: controls ───────────────────────────────────────────────────────────────────────

scenario('controls', 'pause starts nothing new, inspect lists the active dispatches, take over and cancel end every worker and attempt', ALL, async (t, mode) => {
  const p = await project(t, mode, { plan: 'disjoint', concurrency: 2, spec: { '*': { sleepMs: 30000 } } });
  const first = await p.exec({ action: 'step' });
  assert.equal(first.exit, 0, JSON.stringify(first.body));
  const active = p.dispatches().filter((d) => d.phase === 'launched');
  assert.equal(active.length, mode === 'subagent' ? 2 : 1, 'a main session holds one attempt at a time');
  if (mode === 'subagent') await until(() => active.every((d) => readRuns(p.runStore)[d.workerRunId]?.worker), 'both workers recorded');

  const paused = await p.exec({ action: 'pause', by: 'main', reason: 'stop admitting' });
  assert.deepEqual([paused.exit, paused.body.disposition], [0, 'paused'], JSON.stringify(paused.body));
  const after = await p.exec({ action: 'step' });
  assert.ok(!after.body.actions.some((a) => a.action === 'admit' && !String(a.reason).startsWith('skipped:')), 'pause starts nothing new');
  assert.equal(Object.keys(p.read().dispatches).length, active.length);

  const bytes = fs.readFileSync(p.file);
  const view = await p.exec({ action: 'inspect' });
  assert.deepEqual([view.exit, view.body.disposition], [0, 'inspected']);
  assert.deepEqual(fs.readFileSync(p.file), bytes, 'inspect writes nothing');
  assert.deepEqual(view.body.dispatches.map((d) => d.task).sort(), active.map((d) => d.task).sort(), 'inspect lists every active dispatch');
  for (const d of view.body.dispatches) assert.ok(Number.isInteger(d.token) && d.phase === 'launched');

  const taken = await p.exec({ action: 'takeover', by: 'main', reason: 'I will do it', task: 'A.1' });
  if (mode === 'subagent') {
    assert.deepEqual([taken.exit, taken.body.disposition], [0, 'taken-over'], JSON.stringify(taken.body));
    assert.equal(taken.body.workerRun.endState, 'cancelled');
    assert.ok(MAIN_SESSION.includes(taken.body.held.mode), 'the task is held for the main session');
    const record = attempts.inspect(p.common).tasks.find((r) => r.id === 'A.1');
    assert.ok(record.state !== 'CANCELLED' && (record.state === 'READY' || record.claimable === true), `A.1 stays claimable: ${JSON.stringify(record)}`);
  } else {
    assert.deepEqual([taken.exit, taken.body.reason], [1, 'already-main-session'], 'a main-session attempt is already the user\'s');
  }

  const cancelled = await p.exec({ action: 'cancel', by: 'main', reason: 'stop everything' });
  assert.deepEqual([cancelled.exit, cancelled.body.disposition], [0, 'cancelled'], JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.cleanupVerified, true);
  for (const w of cancelled.body.workers) assert.deepEqual([w.endState, w.cleanup.status], ['cancelled', 'verified'], JSON.stringify(w));
  for (const run of Object.values(fs.existsSync(p.runStore) ? readRuns(p.runStore) : {})) {
    assert.equal(run.phase, 'ended', `worker run ${run.runId} ended`);
    for (const proc of [run.supervisor, run.worker]) if (proc && proc.pid) assert.notEqual(tree.alive(proc), true, `pid ${proc.pid} ended`);
  }
  const ledger = p.ledger();
  for (const d of active) {
    const a = ledger.tasks[d.task].attempts.find((x) => x.token === d.token);
    assert.equal(a.state, mode === 'subagent' && d.task === 'A.1' ? 'released' : 'cancelled', `${d.task} attempt`);
  }
  assert.equal(ledger.runs[p.started.runKey].control, 'cancelled');
  assert.equal(p.read().run.state, 'cancelled');
  for (const d of p.dispatches()) assert.equal(fs.existsSync(d.attempt.worktree), false, `${d.dispatchId} worktree removed`);
  return { outcome: 'cancelled' };
});

// ── US2 / FR-024, NFR-005: worktrees cleaned up ──────────────────────────────────────────────────

scenario('worktrees-cleaned', 'a run with one integrated, one cancelled and one failed attempt completes with no attempt worktree or branch left', ALL, async (t, mode) => {
  const p = await project(t, mode, {
    plan: THREE_TASKS, concurrency: 1, verify: VERIFY_NO_BAD,
    spec: { 'A.2': { 1: { sleepMs: 20000 } }, 'A.3': { 1: { write: { 'src/c.js': '// BAD\n' } } } },
  });
  const onLaunched = (d) => {
    if (d.task !== 'A.2' || d.token !== 1) return;
    const r = attempts.cancel({ ...p.common, task: 'A.2', token: 1, by: 'main', reason: 'user stopped it' });
    assert.equal(r.disposition, 'cancelled', JSON.stringify(r));
  };
  const blocked = await p.drive({ onLaunched });
  assert.equal(blocked.outcome, 'blocked', JSON.stringify(blocked));
  assert.ok(blocked.blocked.gaps.some((g) => g.task === 'A.2' && g.kind === 'cancelled'), JSON.stringify(blocked.blocked.gaps));
  const ack = await p.exec({ action: 'resume' });
  assert.equal(ack.body.disposition, 'ack-required', JSON.stringify(ack.body));
  const resumed = await p.exec({ action: 'resume', by: 'main', ack: ack.body.digest });
  assert.equal(resumed.body.disposition, 'resumed', JSON.stringify(resumed.body));
  const last = await p.drive();
  assert.equal(last.outcome, 'completed', JSON.stringify(last.blocked || last.actions));

  const ends = p.dispatches().map((d) => [d.task, d.token, d.disposition]);
  assert.deepEqual(ends, [['A.1', 1, 'completed'], ['A.2', 1, 'stale'], ['A.2', 2, 'completed'], ['A.3', 1, 'failed'], ['A.3', 2, 'completed']]);
  const left = attemptLeftovers(p.root, p.env);
  assert.deepEqual(left.worktrees, [], 'no doflow-attempt/ worktree remains');
  assert.deepEqual(left.branches, [], 'no doflow-attempt/ branch remains');
  assert.equal(left.integration.length, 1, 'the integration worktree remains');
  assert.ok(fs.existsSync(p.started.integration.worktree));
  assert.deepEqual(last.completion.removals.kept, []);
  for (const d of p.dispatches()) assert.equal(d.removal && d.removal.verified, true, `${d.dispatchId} removal verified`);
  return outcomeOf(p, last.outcome);
});

const ROOT_OR_WIN = (process.getuid?.() === 0 && 'a read-only parent cannot fail a removal as root (RK11)')
  || (process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)');

scenario('removal-failure-named', 'a removal made to fail by a read-only parent directory is named by path and its worktree kept', ALL, async (t, mode) => {
  const locked = {};
  t.after(() => { if (locked.dir) fs.chmodSync(locked.dir, 0o755); });
  const p = await project(t, mode, { plan: 'budget', verify: VERIFY_NO_BAD, startNow: false });
  // Attempt 1 fails verification (kept until the run ends); attempt 2 waits until the parent is read-only.
  const go = path.join(p.sb.dir, 'go');
  p.setSpec({ 'A.1': { 1: { write: { 'src/retry.js': '// BAD\n' } }, 2: { waitFor: go } } });
  await p.start();
  const dir = path.join(p.root, WORKTREES_DIR);
  const onLaunched = (d) => {
    if (d.token !== 2) return;
    fs.chmodSync(dir, 0o555);
    locked.dir = dir;
    fs.writeFileSync(go, 'go');
  };
  const last = await p.drive({ onLaunched });
  fs.chmodSync(dir, 0o755);
  assert.equal(last.outcome, 'completed', JSON.stringify(last.blocked || last.actions));
  const ds = p.dispatches();
  const kept = [...last.completion.removals.kept].sort();
  assert.deepEqual(kept, ds.map((d) => d.attempt.worktree).sort(), 'each removal that failed is named by its path');
  for (const d of ds) {
    assert.ok(fs.existsSync(d.attempt.worktree), `${d.attempt.worktree} is kept`);
    assert.notEqual(d.removal && d.removal.verified, true);
  }
  return { states: p.states(), outcome: last.outcome, kept: kept.length };
}, { skip: ROOT_OR_WIN });

// ── US6 / FR-021: measurement ────────────────────────────────────────────────────────────────────

scenario('run-measured', 'a completed run reports tokens by source and basis, durations and peaks', ALL, async (t, mode) => {
  const p = await project(t, mode, { plan: 'budget' });
  const last = await p.drive();
  assert.equal(last.outcome, 'completed', JSON.stringify(last.blocked || last.actions));
  const m = last.measurement;
  const spent = { measured: TOKENS, estimated: 0 };
  const none = { measured: 0, estimated: 0 };
  assert.deepEqual(m.tokens.main, mode === 'subagent' ? none : spent);
  assert.deepEqual(m.tokens.worker, mode === 'subagent' ? spent : none);
  assert.deepEqual(m.tokens.child, none);
  assert.deepEqual(m.tokens.total, spent);
  assert.equal(m.durationsMs.attempt.count, 1);
  assert.equal(m.durationsMs.integration.count, 1);
  assert.equal(m.durationsMs.verification.count, 2, 'one integration check and the final one');
  for (const k of ['attempt', 'integration', 'verification']) assert.ok(m.durationsMs[k].totalMs >= m.durationsMs[k].maxMs && m.durationsMs[k].maxMs >= 0);
  assert.equal(typeof m.durationsMs.run, 'number');
  assert.ok(m.durationsMs.run >= 0);
  assert.equal(m.peak.workers, mode === 'subagent' ? 1 : 0);
  assert.equal(m.peak.worktrees, 1);
  assert.deepEqual(p.read().run.measurement, m, 'the report is the stored measurement');
  return { states: p.states(), outcome: last.outcome, peakWorktrees: m.peak.worktrees, durations: Object.keys(m.durationsMs) };
});

// ── US6 / FR-022, FR-023, NFR-007: identity ──────────────────────────────────────────────────────

scenario('identity-joins', 'records under a launcher identity carry run key, task, token, run, lineage and attempt; an invalid attempt is omitted', ALL, async (t, mode) => {
  const launcher = { DOFLOW_RUN_ID: 'r7launcher01', DOFLOW_LINEAGE_ID: 'main', DOFLOW_ATTEMPT: '7', DOFLOW_SESSION_ROLE: 'main' };
  const p = await project(t, mode, { plan: 'budget', identity: launcher, systemTools: ['dirname', 'date', 'mkdir'] });
  const last = await p.drive();
  assert.equal(last.outcome, 'completed', JSON.stringify(last.blocked || last.actions));
  const s = p.read();
  const runKey = p.started.runKey;
  assert.match(runKey, /\/r7launcher01\/main$/);
  assert.deepEqual([s.run.runKey, s.run.run, s.run.lineage], [runKey, 'r7launcher01', 'main']);
  assert.ok(p.ledger().runs[runKey], 'the 080 run is keyed by the same run key');
  const [d] = p.dispatches();
  assert.deepEqual([d.parentRunKey, d.task, d.token], [runKey, 'A.1', 1]);
  assert.equal(p.ledger().tasks['A.1'].attempts[0].token, d.token);
  if (mode === 'subagent') {
    assert.equal(d.workerIdentity.attempt, '1', 'the worker is the attempt token');
    const run = readRuns(p.runStore)[d.workerRunId];
    assert.deepEqual([run.identity.run, run.identity.lineage, run.identity.attempt], [d.workerIdentity.run, d.workerIdentity.lineage, d.workerIdentity.attempt]);
  } else assert.equal(d.workerIdentity ?? null, null, 'a main-session attempt launches no worker');

  // The traced verb, under the launcher identity and under one with an invalid attempt.
  const config = path.join(p.sb.dir, 'config');
  const runsDir = path.join(config, 'state', 'runs');
  const traced = (over) => {
    fs.rmSync(runsDir, { recursive: true, force: true });
    const env = { ...p.env, ...over, DOFLOW_CLI: CLI, DOFLOW_CONFIG_DIR: config, DOFLOW_FAILURE_CAPTURE: 'off' };
    const r = spawnSync('/bin/bash', [RUN, 'dispatch', '--action', 'inspect', '--slug', SLUG, '--json'], { cwd: p.root, env, encoding: 'utf8' });
    const lines = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).flatMap((f) => fs.readFileSync(path.join(runsDir, f), 'utf8').split('\n').filter(Boolean)) : [];
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    return { stdout: r.stdout, record: JSON.parse(lines[0]) };
  };
  const good = traced({});
  const bad = traced({ DOFLOW_ATTEMPT: '0' });
  assert.deepEqual([good.record.verb, good.record.run, good.record.lineage, good.record.attempt], ['dispatch', 'r7launcher01', 'main', '7']);
  assert.deepEqual([bad.record.run, bad.record.lineage, bad.record.attempt], ['r7launcher01', 'main', null], 'the invalid attempt is omitted');
  assert.equal(good.stdout, bad.stdout, 'the verb output is identical');
  assert.equal(JSON.parse(good.stdout).dispatchRunId, s.run.dispatchRunId);
  return { states: p.states(), outcome: last.outcome, trace: [good.record.attempt, bad.record.attempt] };
});

// ── US2 / FR-008, FR-010: edits stay in the attempt worktree (subagent) ──────────────────────────

scenario('stray-write-caller', 'a worker writing into the caller checkout is a violation and is not integrated; the other edit is integrated only', SUBAGENT, async (t, mode) => {
  const p = await project(t, mode, { plan: TWO_TASKS, concurrency: 2, startNow: false });
  const strayPath = path.join(p.root, 'STRAY.txt');
  p.setSpec({ 'A.2': { 1: { stray: [{ path: strayPath, content: 'stray\n' }] } } });
  await p.start();
  const before = callerState(p.root, p.env);
  const last = await p.drive();
  assert.equal(last.outcome, 'completed', JSON.stringify(last.blocked || last.actions));
  const [a1, b1, b2] = p.dispatches();
  assert.deepEqual([a1.task, a1.disposition], ['A.1', 'completed']);
  assert.deepEqual([b1.task, b1.token, b1.disposition, b1.failureClass], ['A.2', 1, 'failed', 'isolation']);
  const run = readRuns(p.runStore)[b1.workerRunId];
  assert.equal(run.isolation.status, 'violated', JSON.stringify(run.isolation));
  assert.ok(JSON.stringify(run.isolation).includes('outside-write'), JSON.stringify(run.isolation));
  assert.match(p.ledger().tasks['A.2'].attempts[0].reason, /^isolation/);
  assert.deepEqual([b2.token, b2.disposition], [2, 'completed']);
  const wt = p.started.integration.worktree;
  assert.equal(fs.existsSync(path.join(wt, 'STRAY.txt')), false, 'the stray write is never integrated');
  assert.equal(fs.readFileSync(path.join(wt, 'src', 'a.js'), 'utf8'), '// A.1 token 1\n', 'the first change is integrated into the integration worktree');
  const after = callerState(p.root, p.env);
  assert.deepEqual([after.head, after.ref, after.branches], [before.head, before.ref, before.branches], 'the caller HEAD, branch and branch list are unchanged');
  assert.equal(after.status, '?? STRAY.txt', 'the caller checkout holds only what the worker wrote itself, never an integration');
  assert.equal(fs.readFileSync(path.join(p.root, 'src', 'a.js'), 'utf8'), '// src/a.js\n');
  return null;
});

scenario('stray-write-sibling', 'a write into a sibling attempt worktree lands in the sibling\'s change refs (DEC-046)', SUBAGENT, async (t, mode) => {
  const p = await project(t, mode, { plan: TWO_TASKS, concurrency: 2, startNow: false });
  const mark = path.join(p.sb.dir, 'sibling-wrote');
  p.setSpec({
    'A.1': { any: { waitFor: mark } },
    'A.2': { any: { sibling: { path: 'src/from-sibling.js', content: '// written by A.2\n' }, mark } },
  });
  await p.start();
  const last = await p.drive();
  assert.equal(last.outcome, 'completed', JSON.stringify(last.blocked || last.actions));
  const [a1, b1] = p.dispatches();
  assert.deepEqual([a1.disposition, b1.disposition], ['completed', 'completed'], 'the edit check covers the caller checkout, not a sibling');
  assert.deepEqual(a1.changes.map((c) => c.path).sort(), ['src/a.js', 'src/from-sibling.js']);
  assert.deepEqual(a1.undeclared, ['src/from-sibling.js']);
  assert.deepEqual(b1.changes.map((c) => c.path), ['src/b.js']);
  assert.equal(readRuns(p.runStore)[b1.workerRunId].isolation.status, 'clean');
  return null;
});

// ── US2 / FR-005: stale result (subagent) ────────────────────────────────────────────────────────

scenario('stale-result', 'an attempt cancelled while its worker still runs is collected stale; nothing is integrated and the task state is unchanged by it', SUBAGENT, async (t, mode) => {
  const p = await project(t, mode, { plan: 'budget', spec: { '*': { sleepMs: 30000 } } });
  await p.exec({ action: 'step' });
  const [d] = p.dispatches();
  assert.equal(d.phase, 'launched');
  await until(() => readRuns(p.runStore)[d.workerRunId]?.worker, 'the worker recorded');
  const cancelled = attempts.cancel({ ...p.common, task: 'A.1', token: d.token, by: 'main', reason: 'user stopped it' });
  assert.equal(cancelled.disposition, 'cancelled', JSON.stringify(cancelled));
  const taskBefore = p.ledger().tasks['A.1'];
  const stateBefore = p.states()['A.1'];
  const { body } = await p.exec({ action: 'step' });
  const stale = body.actions.find((a) => a.action === 'stale');
  assert.equal(stale && stale.reason, 'attempt-cancelled', JSON.stringify(body.actions));
  assert.ok(!body.actions.some((a) => a.action === 'integrate' && a.reason === 'completed'), 'nothing is integrated');
  const x = p.read().dispatches[d.dispatchId];
  assert.deepEqual([x.phase, x.disposition, x.staleReason], ['ended', 'stale', 'attempt-cancelled']);
  assert.deepEqual(p.ledger().tasks['A.1'], taskBefore, 'the stale result changes nothing in the task');
  assert.equal(p.states()['A.1'], stateBefore);
  assert.equal(p.read().run.integration.head, p.started.integration.base);
  assert.equal(readRuns(p.runStore)[d.workerRunId].phase, 'ended', 'its worker is ended');
  return null;
});

// ── US1 / FR-013, FR-018: timeout (subagent) ─────────────────────────────────────────────────────

scenario('timeout-retried', 'a worker sleeping past its bound with a budget of two is cancelled, retried once and never a third time', SUBAGENT, async (t, mode) => {
  const p = await project(t, mode, { plan: 'budget', start: { attemptSeconds: '1' }, spec: { '*': { sleepMs: 30000 } } });
  const last = await p.runToEnd();
  assert.equal(last.outcome, 'blocked', JSON.stringify(last));
  const ds = p.dispatches();
  assert.deepEqual(ds.map((d) => [d.token, d.disposition, d.failureClass]), [[1, 'failed', 'timeout'], [2, 'failed', 'timeout']]);
  const list = p.ledger().tasks['A.1'].attempts;
  assert.equal(list.length, 2, 'no third attempt');
  assert.deepEqual(list.map((a) => a.result), ['FAILED', 'BLOCKED']);
  for (const d of ds) assert.equal(readRuns(p.runStore)[d.workerRunId].end.state, 'timed-out');
  return null;
});

// ── US5 / FR-018: restart and resume (subagent) ──────────────────────────────────────────────────

scenario('restart-resume', 'a killed loop with one live and one lost worker dispatches nothing before resume, leaves the live run, cancels the lost one before its retry', SUBAGENT, async (t, mode) => {
  const p = await project(t, mode, { plan: 'disjoint', concurrency: 2, spec: { '*': { sleepMs: 30000 } } });
  await p.exec({ action: 'step' });
  const byTask = Object.fromEntries(p.dispatches().map((d) => [d.task, d]));
  const live = byTask['A.1'];
  const lost = byTask['A.2'];
  await until(() => [live, lost].every((d) => readRuns(p.runStore)[d.workerRunId]?.worker), 'both workers recorded');
  const lostRun = readRuns(p.runStore)[lost.workerRunId];
  kill(lostRun.supervisor.pid);
  kill(-lostRun.worker.pgid);
  await until(() => tree.alive(lostRun.supervisor) === false && tree.alive(lostRun.worker) === false, 'the lost run to die');
  // The killed loop: its registered driver's process is gone.
  const dead = spawnSync(process.execPath, ['-e', ''], { env: {} }).pid;
  store.mutateDispatch(p.file, (s) => { s.drivers.push({ pid: dead, start: 'Thu Jan  1 00:00:00 2026', registeredAt: new Date().toISOString(), endedAt: null }); return { write: true, result: null }; });

  const restarted = await p.exec({ action: 'step' });
  assert.equal(restarted.body.outcome, 'resume-required', JSON.stringify(restarted.body));
  assert.equal(Object.keys(p.read().dispatches).length, 2, 'nothing is dispatched before resume');
  const ack = await p.exec({ action: 'resume' });
  assert.equal(ack.body.disposition, 'ack-required', JSON.stringify(ack.body));
  const lostAttempt = () => p.ledger().tasks['A.2'].attempts.find((a) => a.token === lost.token);
  assert.equal(lostAttempt().state, 'cancelled', 'the lost attempt is cancelled before the resume');
  const again = await p.exec({ action: 'step' });
  assert.equal(again.body.outcome, 'resume-required');
  assert.equal(Object.keys(p.read().dispatches).length, 2);
  const resumed = await p.exec({ action: 'resume', by: 'main', ack: ack.body.digest });
  assert.equal(resumed.body.disposition, 'resumed', JSON.stringify(resumed.body));
  const liveRun = readRuns(p.runStore)[live.workerRunId];
  assert.equal(liveRun.phase, 'running', 'the live worker run is left');
  await p.exec({ action: 'step' });
  const ds = p.dispatches();
  assert.ok(ds.some((d) => d.task === 'A.2' && d.token === lost.token + 1), 'the lost task is retried after its attempt was cancelled');
  assert.equal(ds.filter((d) => d.task === 'A.1').length, 1, 'the live run\'s task is not dispatched again');
  assert.equal(readRuns(p.runStore)[live.workerRunId].phase, 'running', 'and its worker runs on');
  const cancelled = await p.exec({ action: 'cancel', by: 'main', reason: 'test done' });
  assert.equal(cancelled.body.disposition, 'cancelled', JSON.stringify(cancelled.body));
  return null;
});

// ── US5 / FR-016: spawn grant bounds (subagent) ──────────────────────────────────────────────────

scenario('spawn-grant-bounds', 'requests past the granted children, depth or tokens are refused naming the bound; an ungranted worker is spawning-denied', SUBAGENT, async (t, mode) => {
  const p = await project(t, mode, { plan: 'budget', start: { reserveTokens: '100', spawnGrant: JSON.stringify({ depth: 1, children: 1, tokens: 50 }) }, startNow: false });
  const go = path.join(p.sb.dir, 'go');
  p.setSpec({ '*': { waitFor: go }, child: { waitFor: go } });
  await p.start();
  await p.exec({ action: 'step' });
  const [granter] = p.dispatches();
  assert.equal(granter.phase, 'launched');
  await until(() => readRuns(p.runStore)[granter.workerRunId]?.worker, 'the granter worker recorded');
  const prompt = path.join(p.sb.dir, 'child-prompt.md');
  fs.writeFileSync(prompt, 'look something up');
  const workerEnv = (id, worktree) => ({
    ...p.env, DOFLOW_RUN_ID: id.run, DOFLOW_LINEAGE_ID: id.lineage, DOFLOW_ATTEMPT: id.attempt, DOFLOW_SESSION_ROLE: 'worker', DOFLOW_WORKTREE: worktree,
  });
  const ask = (reserve, id = granter.workerIdentity, worktree = granter.attempt.worktree) => p.exec({ action: 'spawn', promptFile: prompt, reserveTokens: String(reserve), cwd: worktree }, workerEnv(id, worktree));

  const over = await ask(60);
  assert.deepEqual([over.exit, over.body.reason, over.body.remaining], [1, 'budget-exceeded', 50], JSON.stringify(over.body));
  const ok = await ask(20);
  assert.deepEqual([ok.exit, ok.body.disposition], [0, 'spawn-requested'], JSON.stringify(ok.body));
  const second = await ask(10);
  assert.deepEqual([second.exit, second.body.reason, second.body.limit], [1, 'concurrency-exceeded', 1], JSON.stringify(second.body));

  await until(async () => {
    await p.exec({ action: 'step' });
    const r = p.read().spawnRequests[ok.body.requestId];
    return r.state === 'launched' && r.identity && fs.existsSync(r.worktree || '');
  }, 'the child run launched');
  const request = p.read().spawnRequests[ok.body.requestId];
  const grand = await ask(5, request.identity, request.worktree);
  assert.deepEqual([grand.exit, grand.body.reason], [1, 'depth-exceeded'], JSON.stringify(grand.body));
  const status = await p.exec({ action: 'spawn', requestId: ok.body.requestId, cwd: granter.attempt.worktree }, workerEnv(granter.workerIdentity, granter.attempt.worktree));
  assert.deepEqual([status.body.disposition, status.body.state], ['spawn-status', 'launched']);
  fs.writeFileSync(go, 'go');
  const last = await p.drive();
  assert.equal(last.outcome, 'completed', JSON.stringify(last.blocked || last.actions));
  assert.equal(p.read().spawnRequests[ok.body.requestId].endState, 'exited');
  assert.equal(Object.keys(p.read().spawnRequests).length, 1, 'refused requests are never recorded');

  // An ungranted worker: a run started without --spawn-grant.
  const q = await project(t, mode, { plan: 'budget', spec: { '*': { sleepMs: 30000 } } });
  await q.exec({ action: 'step' });
  const [plain] = q.dispatches();
  assert.equal(plain.grant, null);
  await until(() => readRuns(q.runStore)[plain.workerRunId]?.worker, 'the ungranted worker recorded');
  fs.writeFileSync(path.join(q.sb.dir, 'p.md'), 'x');
  const denied = await q.exec({ action: 'spawn', promptFile: path.join(q.sb.dir, 'p.md'), reserveTokens: '1', cwd: plain.attempt.worktree }, {
    ...q.env, DOFLOW_RUN_ID: plain.workerIdentity.run, DOFLOW_LINEAGE_ID: plain.workerIdentity.lineage, DOFLOW_ATTEMPT: plain.workerIdentity.attempt,
    DOFLOW_SESSION_ROLE: 'worker', DOFLOW_WORKTREE: plain.attempt.worktree,
  });
  assert.deepEqual([denied.exit, denied.body.reason], [1, 'spawning-denied'], JSON.stringify(denied.body));
  await q.exec({ action: 'cancel', by: 'main', reason: 'test done' });
  return null;
});

// ── US2 / FR-009: editing needs a verified harness; US6 / FR-019: honest fallback ────────────────

/** Sequential runs on the outcome side; subagent mode shows the gap side with the claude fake. */
scenario('verified-harness', 'a harness whose isolated editing is unknown is ineligible naming the gap, and the task runs sequential', ['sequential', 'subagent'], async (t, mode) => {
  // sequential: --mode auto over descriptors.json, where no fake declares isolatedEdit.
  // subagent: --mode auto with claude's isolatedEdit supported; gemini's stays unknown.
  const p = await project(t, mode === 'sequential' ? 'subagent' : mode, { plan: 'budget', descriptors: mode === 'sequential' ? 'raw' : 'edit' });
  const last = await p.drive();
  assert.equal(last.outcome, 'completed', JSON.stringify(last.blocked || last.actions));
  const [d] = p.dispatches();
  const gemini = d.selection.candidates.find((c) => c.harness === 'gemini');
  assert.equal(gemini.eligible, false);
  assert.deepEqual(gemini.gaps.find((g) => g.requirement === 'isolated-edit'), { requirement: 'isolated-edit', result: 'unknown', reason: 'not-declared' });
  if (mode === 'sequential') {
    for (const c of d.selection.candidates) assert.ok(c.gaps.some((g) => g.requirement === 'isolated-edit'), `${c.harness} names isolated-edit`);
    assert.deepEqual([d.mode, d.selection.chosen], ['sequential', 'sequential'], 'the task runs in the main session');
  } else {
    assert.deepEqual([d.mode, d.harness], ['subagent', 'claude'], 'only the verified harness edits');
  }
  return null;
});

scenario('honest-fallback', 'with no eligible harness each gap is named and every attempt records mode sequential', ['sequential', 'subagent'], async (t, mode) => {
  // sequential: the real registry (every isolatedEdit unknown). subagent: the claude fake unprobed,
  // so its effective facts are unknown, and every other fake fails the static gate.
  const p = await project(t, 'subagent', { plan: 'dependent', descriptors: mode === 'sequential' ? 'registry' : 'edit', probe: false });
  const last = await p.drive();
  assert.equal(last.outcome, 'completed', JSON.stringify(last.blocked || last.actions));
  const ds = p.dispatches();
  assert.equal(ds.length, 3);
  for (const d of ds) {
    assert.deepEqual([d.mode, d.selection.policy, d.selection.chosen], ['sequential', 'auto', 'sequential']);
    assert.ok(d.selection.candidates.length >= 1);
    for (const c of d.selection.candidates) assert.ok(c.eligible === false && c.gaps.length >= 1, `${c.harness}: ${JSON.stringify(c.gaps)}`);
  }
  for (const task of ['A.1', 'A.2', 'A.3']) assert.equal(p.ledger().tasks[task].attempts[0].mode, 'sequential');
  assert.equal(fs.existsSync(p.sb.log) ? fs.readFileSync(p.sb.log, 'utf8').split('\n').filter((l) => l && JSON.parse(l).argv[0] === '--edit-in-cwd').length : 0, 0, 'no worker was launched');
  return outcomeOf(p, last.outcome);
});

// ── US6 / FR-020: the same acceptance in three modes ─────────────────────────────────────────────

test('FR-020: every scenario run in more than one mode gives the same task states and parent outcome in each', POSIX, () => {
  let compared = 0;
  for (const [id, modes] of Object.entries(DECLARED)) {
    const got = RECORDED[id] || {};
    const ran = modes.filter((m) => got[m]);
    if (ran.length < 2) continue;
    for (const m of ran.slice(1)) assert.deepEqual(got[m], got[ran[0]], `${id}: ${m} differs from ${ran[0]}`);
    compared += 1;
  }
  const allModes = Object.entries(DECLARED).filter(([, modes]) => modes.length === 3).map(([id]) => id);
  for (const id of allModes) {
    if (id === 'removal-failure-named' && ROOT_OR_WIN) continue;
    assert.deepEqual(Object.keys(RECORDED[id] || {}).sort(), [...MODES].sort(), `${id} ran and recorded in all three modes`);
  }
  assert.ok(compared >= allModes.length - (ROOT_OR_WIN ? 1 : 0));
});

test('NFR-005: no worker process outlived its test', POSIX, () => {
  assert.ok(CHECKED_PROCESSES > 0, 'the cleanup hooks saw the worker processes');
  assert.deepEqual(LEFTOVERS, []);
});
