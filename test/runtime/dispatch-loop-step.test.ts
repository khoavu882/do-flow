'use strict';

// Feature 082 C.3 (IC-003, IC-004, IC-005, IC-022, IC-026; DEC-001, DEC-010, DEC-017, DEC-029,
// DEC-048, DEC-052): the loop's step order, perform yield and submit, mode selection with the
// static gate, a subagent attempt through the fake CLI, and a refused launch's retry.
//
// Each case is a sandbox repository (test/helper/dispatch-sandbox.ts) with a started 080 run, an
// integration worktree made by B.4's createIntegrationWorktree and a seeded dispatch run (C.5's
// `start` is not part of this task). The child PATH is the sandbox's scratch bin/ alone (fake CLI
// links, node and git, never dirname(process.execPath), DEC-056); the five DOFLOW_* identity
// variables are set by the sandbox, with DOFLOW_ATTEMPT deleted where a worker is launched so the
// caller is not the unit its worker becomes. A "test performer" plays the main session: it edits
// the perform yield's worktree by path and calls `submit`. POSIX only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.ts');

const SRC = path.join(__dirname, '..', '..', 'src', 'runtime');
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const readiness = require(path.join(SRC, 'worker', 'readiness.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { createIntegrationWorktree } = require(path.join(SRC, 'dispatch', 'integrate.ts'));
const loop = require(path.join(SRC, 'dispatch', 'loop.ts'));
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { CapabilityRouter } = require('../../src/runtime/capability-router.ts');
const { renderBriefTools } = require(path.join(SRC, 'brief-tools.ts'));
const { resolvePrimary } = require(path.join(SRC, 'context', 'primary.ts'));
const { readRuns, storeFileFor: runStoreFileFor } = require(path.join(SRC, 'worker', 'run-store.ts'));
const ENVELOPE_STORE = require('../../core/registry/storage.json').stores.find((x: any) => x.id === 'dispatch-envelopes');

const SLUG = '082-loop-step-fixture';
const POSIX: any = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
const SUCCESS: any = { type: 'result', status: 'success', summary: 'edited' };
const PHASE_ACTIONS: any = ['reconcile', 'admit', 'launch', 'integrate', 'verify', 'finish', 'decide'];

function git(cwd: any, env: any, args: any) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function callerState(root: any, env: any) {
  return {
    head: git(root, env, ['rev-parse', 'HEAD']),
    ref: git(root, env, ['symbolic-ref', '-q', 'HEAD']),
    status: git(root, env, ['status', '--porcelain=v1', '--untracked-files=all']),
  };
}

/**
 * A sandbox with a started 080 run and a seeded dispatch run. `identity` overrides the sandbox's
 * DOFLOW_* values; `probe` probes the fake descriptors so a subagent is eligible.
 */
async function project(t: any, {
  plan = 'dependent', mode = 'sequential', concurrency = 2, scenario = {}, identity = {}, probe = false, attemptSeconds = 60,
}: any = {}) {
  const sb = makeDispatchSandbox(t, { plan, slug: SLUG, scenario, identity });
  const { root } = sb;
  const env: any = { ...sb.env };
  for (const key of ['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE']) assert.ok(env[key], `${key} is set`);
  const ledgerFile = attempts.storeFile(root, SLUG);
  const common: any = { file: ledgerFile, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root };
  const started = attempts.start({ ...common, by: 'main' });
  assert.equal(started.disposition, 'started', JSON.stringify(started));
  const dispatchRunId = store.newDispatchRunId();
  const integration = createIntegrationWorktree({ root, slug: SLUG, dispatchRunId, env });
  const file = store.storeFileFor(root, SLUG);
  store.mutateDispatch(file, (s: any) => {
    s.run = {
      dispatchRunId, slug: SLUG, state: 'running', runKey: started.runKey, epoch: started.epoch, concurrency, mode,
      reserveTokens: null, attemptSeconds, harness: null, needs: [], spawnGrant: null, createdAt: new Date().toISOString(),
      integration: { worktree: integration.worktree, branch: integration.branch, base: integration.base, head: integration.head },
      verify: { argv: sb.verifyArgv, argvSha256: null, argvCount: sb.verifyArgv.length, timeoutSeconds: 60 },
    };
    return { write: true, result: null };
  });
  if (probe) assert.equal((await readiness.probe({ descriptors: sb.descriptors, env, cwd: root })).disposition, 'probed');
  const read = () => store.readDispatch(file);
  const ledger = () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const runStore = runStoreFileFor(root, SLUG);
  const options = (extra: any = {}) => ({ slug: SLUG, env, cwd: root, by: 'main', descriptors: sb.descriptors, ...extra });
  const step = (extra: any = {}) => loop.step(options(extra));
  /** The test performer: writes `files` into the yielded worktree, then submits. */
  const perform = (yieldOf: any, files: any = {}, extra: any = {}) => {
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(yieldOf.worktree, rel), text);
    return loop.submit(options({ dispatchId: yieldOf.dispatchId, status: 'success', summary: `done ${yieldOf.task}`, ...extra }));
  };
  return { sb, root, env, file, ledgerFile, runStore, common, started, integration, read, ledger, options, step, perform, before: callerState(root, env) };
}

const states = (p: any) => Object.fromEntries(attempts.inspect({ ...p.common }).tasks.map((r: any) => [r.id, r.state]));

test('IC-003: dependent.md in sequential mode admits A.3 only after A.1 and A.2 SUCCEEDED, records each phase and completes with final evidence', POSIX, async (t) => {
  const started = Date.now();
  const p = await project(t, { plan: 'dependent', mode: 'sequential' });
  const performed: any = [];
  const seen: any = new Set();
  let last = null;
  for (let i = 0; i < 20 && (!last || last.outcome !== 'completed'); i += 1) {
    last = await p.step();
    assert.equal(last.disposition, 'stepped', JSON.stringify(last));
    for (const a of last.actions) seen.add(a.action);
    assert.equal(last.actions[0].action, 'reconcile', 'reconcile runs first');
    assert.equal(last.actions.at(-1).action, 'decide', 'decide runs last');
    if (last.outcome === 'perform') {
      const y = last.perform;
      if (y.task === 'A.3') assert.deepEqual([states(p)['A.1'], states(p)['A.2']], ['SUCCEEDED', 'SUCCEEDED'], 'A.3 waits for both');
      performed.push(y.task);
      const file: any = ({ 'A.1': 'src/one.js', 'A.2': 'src/two.js', 'A.3': 'src/join.js' } as any)[y.task];
      const submitted = await p.perform(y, { [file]: `// ${y.task} done\n` });
      assert.equal(submitted.disposition, 'submitted', JSON.stringify(submitted));
    }
  }
  t.diagnostic(`dependent sequential run completed in ${Date.now() - started} ms`);
  assert.equal(last.outcome, 'completed', JSON.stringify(last.blocked || last));
  assert.deepEqual(performed, ['A.1', 'A.2', 'A.3']);
  for (const name of PHASE_ACTIONS) assert.ok(seen.has(name), `a step recorded '${name}'`);

  const s = p.read();
  assert.equal(s.run.state, 'completed');
  const c = last.completion;
  assert.equal(c.finalVerification.exitCode, 0);
  assert.match(c.finalVerification.evidenceId, /\S/);
  assert.deepEqual(c.tasks.map((x: any) => x.id), ['A.1', 'A.2', 'A.3']);
  assert.ok(c.tasks.every((x: any) => /^[0-9a-f]{40,64}$/.test(x.integratedCommit)));
  assert.equal(c.integration.head, git(p.integration.worktree, p.env, ['rev-parse', 'HEAD']));
  assert.equal(fs.readFileSync(path.join(p.integration.worktree, 'src', 'join.js'), 'utf8'), '// A.3 done\n');
  assert.ok(s.steps.length >= 4 && s.steps.every((r: any, i: any) => r.step === i + 1), 'one step record per pass');
  assert.deepEqual(s.run.verifications.at(-1).evidenceId, c.finalVerification.evidenceId);
  for (const d of Object.values(s.dispatches)) assert.equal(d.removal && d.removal.verified, true, `${d.dispatchId} worktree removed`);
  assert.deepEqual(callerState(p.root, p.env), p.before, 'the caller checkout is never written');

  const again = await p.step();
  assert.deepEqual([again.outcome, again.actions], ['completed', []], 'a completed run does nothing else');
});

test('IC-005: the perform yield carries task, token, worktree and handoff; a second main-session dispatch waits main-session-busy; submit argv and result', POSIX, async (t) => {
  const p = await project(t, { plan: 'disjoint', mode: 'sequential', concurrency: 2 });
  const r = await p.step();
  assert.equal(r.outcome, 'perform', JSON.stringify(r));
  const y = r.perform;
  assert.deepEqual([y.task, y.token, y.mode], ['A.1', 1, 'sequential']);
  assert.match(y.dispatchId, /^d-[0-9a-f]{12}$/);
  assert.equal(y.branch, `doflow-attempt/${SLUG}/${y.dispatchId}`);
  assert.equal(y.base, p.integration.head);
  assert.ok(fs.statSync(y.worktree).isDirectory());
  const bytes = fs.readFileSync(y.handoff.path);
  assert.equal(y.handoff.bytes, bytes.length);
  assert.match(y.handoff.sha256, /^[0-9a-f]{64}$/);
  const handoff = JSON.parse(bytes);
  assert.equal(handoff.schema, 'doflow-handoff-v1');
  assert.deepEqual([handoff.task.id, handoff.mode, handoff.budget.attemptSeconds, handoff.worktree.path], ['A.1', 'sequential', null, y.worktree]);
  assert.ok(!bytes.toString('utf8').includes(p.sb.verifyArgv[2]), 'the handoff carries no verification argv');
  assert.deepEqual(y.submit, ['dispatch', '--action', 'submit', '--slug', SLUG, '--dispatch', y.dispatchId, '--status', '<success|failure>', '--summary', '<text>']);
  const busy = r.actions.find((a: any) => a.task === 'A.2' && a.action === 'admit');
  assert.equal(busy.reason, 'skipped:main-session-busy', JSON.stringify(r.actions));
  assert.equal(Object.values(p.read().dispatches).length, 1);

  // Yielded again while it awaits its submit.
  const waiting = await p.step();
  assert.deepEqual([waiting.outcome, waiting.perform.dispatchId], ['perform', y.dispatchId]);

  const submitted = await p.perform(y, { 'src/a.js': '// a done\n' }, { summary: 'token=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 done', tokens: 12, tokensBasis: 'estimated' });
  assert.equal(submitted.disposition, 'submitted', JSON.stringify(submitted));
  assert.deepEqual(submitted.changes, [{ path: 'src/a.js', change: 'M', from: null }]);
  assert.deepEqual(submitted.undeclared, []);
  const result = JSON.parse(fs.readFileSync(submitted.result.path, 'utf8'));
  assert.equal(result.outcome, 'offered');
  assert.ok(!result.summary.includes('sk-ant-abcdefghijklmnopqrstuvwxyz0123456789'), 'the summary is masked');
  const d = p.read().dispatches[y.dispatchId];
  assert.deepEqual([d.phase, d.report, d.usage], ['collected', { status: 'success', performer: 'main' }, { tokens: 12, basis: 'estimated' }]);
  const twice = await p.perform(y);
  assert.deepEqual([twice.disposition, twice.reason, twice.phase], ['refused', 'dispatch-not-awaiting', 'collected']);

  const next = await p.step();
  assert.ok(next.actions.some((a: any) => a.action === 'integrate' && a.reason === 'completed'), JSON.stringify(next.actions));
  assert.equal(next.perform.task, 'A.2');
  assert.equal(next.measurement.tokens.main.estimated, 12);
});

test('IC-022 / DEC-052: under auto with the real registry the discover spy records exactly the codex call and every attempt is sequential with each gap', POSIX, async (t): Promise<any> => {
  const p = await project(t, { plan: 'dependent', mode: 'auto' });
  const calls: any = [];
  const r = await p.step({
    descriptors: undefined,
    evaluateImpl: (args: any) => {
      calls.push(args.harness);
      return {
        eligible: false,
        gaps: [
          { requirement: 'installed', result: 'unknown', reason: 'not-probed' },
          { requirement: 'runnable', result: 'unknown', reason: 'not-probed' },
        ],
      };
    },
  });
  assert.deepEqual(calls, ['codex']);
  assert.equal(r.outcome, 'perform', JSON.stringify(r));
  const d = p.read().dispatches[r.perform.dispatchId];
  assert.equal(d.mode, 'sequential');
  assert.equal(d.selection.policy, 'auto');
  assert.equal(d.selection.chosen, 'sequential');
  assert.ok(d.selection.candidates.length >= 7, JSON.stringify(d.selection));
  for (const c of d.selection.candidates) {
    assert.equal(c.eligible, false);
    if (c.harness === 'codex') {
      const requirements = c.gaps.map((g: any) => g.requirement);
      assert.ok(requirements.includes('installed') && requirements.includes('runnable'), `codex gaps: ${JSON.stringify(c.gaps)}`);
      assert.ok(!requirements.includes('isolated-edit'), `codex has no isolated-edit gap: ${JSON.stringify(c.gaps)}`);
      assert.deepEqual(requirements, ['installed', 'runnable'], JSON.stringify(c.gaps));
      continue;
    }
    const gap = c.gaps.find((g: any) => g.requirement === 'isolated-edit');
    assert.equal(gap.result, 'unknown', `${c.harness}: ${JSON.stringify(c.gaps)}`);
  }
  assert.equal(p.ledger().tasks['A.1'].attempts[0].mode, 'sequential');
  assert.equal(fs.existsSync(p.sb.log), false, 'no harness CLI was invoked');
});

test('IC-022 / DEC-048: with the claude fake supported the attempt runs subagent, the fake edits its worktree and run integrates the change', POSIX, async (t) => {
  const started = Date.now();
  const scenario: any = { run: [{ write: { path: 'src/retry.js', content: '// retried\n' } }, { emit: { type: 'usage', tokens: 30 } }, { emit: SUCCESS }] };
  const p = await project(t, { plan: 'budget', mode: 'auto', scenario, identity: { DOFLOW_ATTEMPT: undefined }, probe: true });
  assert.equal(Object.hasOwn(p.env, 'DOFLOW_ATTEMPT'), false, 'DOFLOW_ATTEMPT is deleted');
  const r = await loop.run(p.options({ maxSeconds: 60 }));
  t.diagnostic(`subagent run completed in ${Date.now() - started} ms over ${r.steps} steps`);
  assert.equal(r.disposition, 'ran', JSON.stringify(r));
  assert.equal(r.outcome, 'completed', JSON.stringify(r.last.blocked || r.last.actions));
  assert.equal(r.timeUp, false);
  const [d] = Object.values(p.read().dispatches);
  assert.deepEqual([d.mode, d.harness, d.disposition], ['subagent', 'claude', 'completed']);
  assert.equal(d.selection.chosen, 'claude');
  assert.match(d.workerRunId, /^w-[0-9a-f]{12}$/);
  assert.equal(d.workerIdentity.attempt, String(d.token));
  assert.deepEqual(d.usage, { tokens: 30, basis: 'measured' });
  assert.equal(Date.parse(d.deadline) - Date.parse(d.launchedAt), 60000);
  assert.equal(fs.readFileSync(path.join(p.integration.worktree, 'src', 'retry.js'), 'utf8'), '// retried\n');
  assert.equal(git(p.integration.worktree, p.env, ['log', '-1', '--format=%an', 'HEAD']), 'DoFlow dispatch');
  assert.equal(p.ledger().tasks['A.1'].attempts[0].mode, 'subagent');
  const handoff = JSON.parse(fs.readFileSync(path.join(p.root, '.doflow', 'state', d.envelopes.handoff), 'utf8'));
  assert.deepEqual([handoff.mode, handoff.budget.attemptSeconds, handoff.report.parser], ['subagent', 60, 'doflow-jsonl-v1']);
  const runArgv = fs.readFileSync(p.sb.log, 'utf8').trim().split('\n').map((l: any) => JSON.parse(l).argv).filter((a: any) => a[0] === '--edit-in-cwd');
  assert.equal(runArgv.length, 1, 'one edit run');
  // Row 173 T5: the worker's --prompt-file is the framed prompt beside the envelope, in the dispatch-envelopes store.
  const promptPath = readRuns(p.runStore)[d.workerRunId].prompt.path;
  assert.equal(promptPath, path.join(p.root, '.doflow', 'state', 'dispatch-envelopes', `${d.dispatchId}.handoff-prompt.txt`));
  assert.match(path.basename(promptPath), new RegExp(ENVELOPE_STORE.match), 'the prompt file is in the dispatch-envelopes store');
  const prompt = fs.readFileSync(promptPath, 'utf8');
  assert.ok(prompt.startsWith(`<role>\nYou are the \`core-implementer\` implementing task \`A.1\` of feature \`${SLUG}\` in an isolated worktree.\n</role>`), prompt.slice(0, 300));
  assert.ok(prompt.includes(`<document path=".doflow/state/dispatch-envelopes/${d.dispatchId}.handoff.json">\n`), 'the envelope is the path document');
  assert.ok(runArgv[0].at(-1).endsWith(`\n${prompt}`), 'the fake worker received the framed prompt after the context pack the worker layer puts first');
  assert.deepEqual(callerState(p.root, p.env), p.before);
});

// ---- 178 T5 (f), (g): the headless launch follows the driver's session effort ---------------------------------------------

const FAKE_CLI = require('../helper/fake-harness-cli.ts').FAKE_CLI;
const SESSION_NAMES = ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_EFFORT', 'CLAUDE_CODE_EFFORT_LEVEL'];
const PI_EFFORT = { status: 'supported', evidence: ['x'], verification: 'v', verifiedOn: '2026-11-16', via: 'flag', argv: ['--thinking', '{effort}'], levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], offLevel: 'off', mayLower: true };

/** A scratch `fake-pi` worker binary that logs its argv and the session variables it sees, then runs the stock fake CLI. */
function fakePi(p: any, effort: any = PI_EFFORT) {
  const wrapper = path.join(p.sb.dir, 'fake-pi.js');
  fs.writeFileSync(wrapper, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    `const names = ${JSON.stringify(SESSION_NAMES)};`,
    "fs.appendFileSync(process.env.FAKE_ENV_LOG, `${JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(names.map((n) => [n, process.env[n] ?? null])) })}\\n`);",
    `const r = spawnSync(process.execPath, [${JSON.stringify(FAKE_CLI)}, ...process.argv.slice(2)], { stdio: 'inherit' });`,
    'process.exit(r.status ?? 1);',
  ].join('\n'));
  fs.chmodSync(wrapper, 0o755);
  fs.symlinkSync(wrapper, path.join(p.sb.bin, 'fake-pi'));
  const log = path.join(p.sb.dir, 'env-log.jsonl');
  p.env.FAKE_ENV_LOG = log;
  const descriptor = structuredClone(p.sb.descriptors.claude);
  descriptor.cli.binary = 'fake-pi';
  descriptor.effort = structuredClone(effort);
  return { descriptors: { pi: descriptor }, runs: () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l: any) => JSON.parse(l)).filter((l: any) => l.argv.includes('--edit-in-cwd')) };
}

async function piRun(t: any, sessionEnv: any, effort: any = PI_EFFORT) {
  const scenario: any = { run: [{ write: { path: 'src/retry.js', content: '// retried\n' } }, { emit: { type: 'usage', tokens: 30 } }, { emit: SUCCESS }] };
  const p = await project(t, { plan: 'budget', mode: 'auto', scenario, identity: { DOFLOW_ATTEMPT: undefined } });
  Object.assign(p.env, sessionEnv);
  const worker = fakePi(p, effort);
  assert.equal((await readiness.probe({ descriptors: worker.descriptors, env: p.env, cwd: p.root })).disposition, 'probed');
  const r = await loop.run(p.options({ maxSeconds: 60, descriptors: worker.descriptors }));
  assert.equal(r.outcome, 'completed', JSON.stringify(r.last.blocked || r.last.actions));
  const [d] = Object.values(p.read().dispatches) as any[];
  assert.deepEqual([d.mode, d.harness, d.disposition], ['subagent', 'pi', 'completed']);
  const runs = worker.runs();
  assert.equal(runs.length, 1, 'one edit run');
  return { d, run: runs[0], p };
}

test('178 (f): a driver session that marks Claude at `high` launches the Pi worker with --thinking high, records the plan, and the worker sees neither variable', POSIX, async (t) => {
  const { d, run, p } = await piRun(t, { CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_EFFORT: 'high' });
  const at = run.argv.indexOf('--thinking');
  assert.deepEqual(run.argv.slice(at, at + 2), ['--thinking', 'high']);
  assert.equal(run.argv.includes('--model'), false);
  assert.deepEqual(d.model.effortPlan, { pass: 'high', source: 'session', harness: 'claude', level: 'high', origin: 'CLAUDE_EFFORT', mapped: null, check: 'listed' });
  assert.deepEqual(run.env, { CLAUDE_CODE_CHILD_SESSION: null, CLAUDE_EFFORT: null, CLAUDE_CODE_EFFORT_LEVEL: null });
  // 178 §7.3 (T7): the worker run record's binding carries the same plan the dispatch record shows.
  const stored = readRuns(p.runStore)[d.workerRunId];
  assert.deepEqual(stored.binding, { model: null, provider: null, effort: 'high', flag: 'supported', effortPlan: d.model.effortPlan });
});

test('178 (g): a driver with no session marker passes no --thinking, records why, and the worker still sees no session variable', POSIX, async (t) => {
  const { d, run, p } = await piRun(t, { CLAUDE_EFFORT: 'high' });
  assert.equal(run.argv.some((item: string) => item.startsWith('--thinking')), false);
  assert.deepEqual(d.model.effortPlan, { pass: null, source: 'none', reason: 'session-unknown', session: { harness: null, reason: 'no-session-harness', level: null, origin: null } });
  assert.deepEqual(run.env, { CLAUDE_CODE_CHILD_SESSION: null, CLAUDE_EFFORT: null, CLAUDE_CODE_EFFORT_LEVEL: null });
  const stored = readRuns(p.runStore)[d.workerRunId];
  assert.equal(JSON.stringify(stored.recipe.argvShape).includes('--thinking'), false);
});

test('178 A-01: a non-orchestrator task still reads the declared main harness, so a declaration that contradicts the marker passes no --thinking and the brief shows the same plan', POSIX, async (t) => {
  const { d, run, p } = await piRun(t, { CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_EFFORT: 'high', DOFLOW_PRIMARY_HARNESS: 'codex' });
  assert.equal(run.argv.some((item: string) => item.startsWith('--thinking')), false);
  assert.deepEqual(d.model.effortPlan, { pass: null, source: 'none', reason: 'session-unknown', session: { harness: 'claude', reason: 'contradicted', level: null, origin: null } });
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const router = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: p.root });
  const probes: any = {};
  for (const capability of Object.values(router.capabilities) as any[]) for (const provider of capability.providers) probes[provider.id] = { id: provider.id, status: 'HEALTHY' };
  const primary = resolvePrimary({ env: p.env, projectRoot: p.root, registry });
  const brief: any = renderBriefTools({ registry, router, probes, reach: null, owner: 'core-implementer', stage: null, harness: 'pi', primary, env: p.env, loginModeOf: () => null });
  assert.deepEqual(brief.record.effortPlan, d.model.effortPlan, 'the brief and the launch give one plan');
});

test('178 A-02: the effort is resolved against the descriptor the loop launches, not the registry copy: a level only the registry lists is mapped down', POSIX, async (t) => {
  const { d, run } = await piRun(t, { CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_EFFORT: 'max' }, { ...PI_EFFORT, levels: ['low', 'high'] });
  const at = run.argv.indexOf('--thinking');
  assert.deepEqual(run.argv.slice(at, at + 2), ['--thinking', 'high']);
  assert.deepEqual(d.model.effortPlan, { pass: 'high', source: 'session', harness: 'claude', level: 'max', origin: 'CLAUDE_EFFORT', mapped: { from: 'max', to: 'high' }, check: 'listed' });
});

test('row 173 T5 (g): sequential and manual modes yield the envelope and write no handoff prompt', POSIX, async (t) => {
  for (const mode of ['sequential', 'manual']) {
    const p = await project(t, { plan: 'disjoint', mode, concurrency: 1 });
    const r = await p.step();
    assert.equal(r.outcome, 'perform', JSON.stringify(r));
    assert.equal(r.perform.mode, mode);
    const listed = fs.readdirSync(path.join(p.root, '.doflow', 'state', 'dispatch-envelopes'));
    assert.deepEqual(listed, [`${r.perform.dispatchId}.handoff.json`], `${mode}: the envelope only`);
    assert.equal(JSON.parse(fs.readFileSync(r.perform.handoff.path, 'utf8')).schema, 'doflow-handoff-v1');
  }
});

test('row 173 T5 (f): a handoff prompt over 65536 B fails the launch prompt-too-large before any worker starts, and the retry runs sequential', POSIX, async (t) => {
  // Each upstream hand-back is 1998 B of `<role>`, which the frame escapes to 2997 B: 24 of them pass the bound.
  const deps = Array.from({ length: 24 }, (_, i) => `A.${i + 1}`);
  const join = `A.${deps.length + 1}`;
  const plan = [
    '# Implementation Plan: dispatch fixture, an oversize handoff prompt', '', '**Task graph:** v1', '', '## 8. Tasks', '', '### Phase A', '',
    ...deps.map((id, i) => `- [ ] ${id} Write module ${i + 1} — owner: core-implementer; files: src/m${i + 1}.js\n`),
    `- [ ] ${join} Join every module — owner: core-implementer; files: src/join.js; depends-on: ${deps.join(', ')}`, '',
  ].join('\n');
  const p = await project(t, { plan, mode: 'sequential', concurrency: 1, probe: true });
  const summary = '<role>'.repeat(333);
  let submitted = 0;
  let r: any = null;
  for (let i = 0; i < 120 && !(r && r.outcome === 'perform' && r.perform.task === join); i += 1) {
    r = await p.step();
    assert.notEqual(r.outcome, 'blocked', JSON.stringify(r.blocked));
    if (r.outcome !== 'perform' || r.perform.task === join) continue;
    const done = await p.perform(r.perform, { [`src/m${r.perform.task.slice(2)}.js`]: `// ${r.perform.task}\n` }, { summary });
    assert.equal(done.disposition, 'submitted', JSON.stringify(done));
    submitted += 1;
    // Every upstream is in: the join task is selected under auto, where the claude fake is eligible.
    if (submitted === deps.length) store.mutateDispatch(p.file, (s: any) => { s.run.mode = 'auto'; return { write: true, result: null }; });
  }
  assert.equal(r.perform.task, join, JSON.stringify(r));
  const tries = (Object.values(p.read().dispatches) as any[]).filter((d) => d.task === join).sort((a, b) => a.token - b.token);
  assert.deepEqual(tries.map((d) => [d.token, d.mode, d.disposition, d.failureClass]), [[1, 'subagent', 'failed', 'launch'], [2, 'sequential', null, null]]);
  assert.equal(tries[0].workerRunId ?? null, null, 'no worker run was started');
  assert.equal(tries[0].envelopes.handoff, `dispatch-envelopes/${tries[0].dispatchId}.handoff.json`, 'the envelope was written and kept');
  const envelopes = path.join(p.root, '.doflow', 'state', 'dispatch-envelopes');
  assert.equal(fs.existsSync(path.join(envelopes, `${tries[0].dispatchId}.handoff-prompt.txt`)), false, 'no prompt file over the bound');
  const steps = p.read().steps.flatMap((x: any) => x.actions);
  assert.ok(steps.some((a: any) => a.action === 'launch' && a.task === join && a.reason === 'refused:prompt-too-large'), JSON.stringify(steps.filter((a: any) => a.task === join)));
  const [a1] = p.ledger().tasks[join].attempts;
  assert.match(a1.reason, /^launch: prompt-too-large/);
  const edits = fs.existsSync(p.sb.log) ? fs.readFileSync(p.sb.log, 'utf8').trim().split('\n').filter((l: any) => JSON.parse(l).argv[0] === '--edit-in-cwd') : [];
  assert.deepEqual(edits, [], 'no harness run was spawned');
});

test('171 review: a package worker carrying only a fieldMap reports the map id as the handoff report.parser', POSIX, async (t) => {
  const p = await project(t, { plan: 'budget', mode: 'auto', scenario: { run: [{ write: { path: 'src/retry.js', content: '// retried\n' } }, { emit: SUCCESS }] }, identity: { DOFLOW_ATTEMPT: undefined } });
  const { parser: _core, ...rest } = p.sb.descriptors.claude.structuredOutput;
  p.sb.descriptors.claude.structuredOutput = {
    ...rest,
    fieldMap: {
      id: 'claude-like-v1', format: 'jsonl-field-map-v1', eventType: ['type'], missingTerminal: 'no-result',
      rules: [{ when: [{ path: ['type'], equals: 'result' }, { path: ['summary'], is: 'string' }], then: { final: ['summary'], terminal: { outcome: 'completed' } } }],
    },
  };
  assert.equal((await readiness.probe({ descriptors: p.sb.descriptors, env: p.env, cwd: p.root })).disposition, 'probed');
  const r = await loop.run(p.options({ maxSeconds: 60 }));
  assert.equal(r.outcome, 'completed', JSON.stringify(r.last.blocked || r.last.actions));
  const [d] = Object.values(p.read().dispatches) as any[];
  assert.equal(d.harness, 'claude');
  const handoff = JSON.parse(fs.readFileSync(path.join(p.root, '.doflow', 'state', d.envelopes.handoff), 'utf8'));
  assert.equal(handoff.report.parser, 'claude-like-v1');
});

test('IC-022: a refused launch fails as launch, is never relabelled, and the retry runs sequential', POSIX, async (t) => {
  // DOFLOW_ATTEMPT stays '1', so the caller is the unit a token-1 worker would be: 081 refuses
  // `identity-collision` after the claim (081 IC-011 step 9).
  const p = await project(t, { plan: 'budget', mode: 'auto', scenario: { run: [{ emit: SUCCESS }] }, probe: true });
  const first = await p.step();
  const launch = first.actions.find((a: any) => a.action === 'launch');
  assert.equal(launch.reason, 'refused:identity-collision', JSON.stringify(first.actions));
  assert.equal(first.outcome, 'continue', JSON.stringify(first));
  const second = await p.step();
  assert.equal(second.outcome, 'perform', JSON.stringify(second));
  const ds = Object.values(p.read().dispatches).sort((a, b) => a.token - b.token);
  assert.deepEqual(ds.map((d) => [d.token, d.mode, d.disposition, d.failureClass]), [[1, 'subagent', 'failed', 'launch'], [2, 'sequential', null, null]]);
  const [a1, a2] = p.ledger().tasks['A.1'].attempts;
  assert.deepEqual([a1.mode, a1.result], ['subagent', 'FAILED']);
  assert.match(a1.reason, /^launch: identity-collision/);
  assert.equal(a2.mode, 'sequential');
});
