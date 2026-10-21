'use strict';

// Feature 106 A.3: end-to-end quota fallback through the real dispatch loop and fake workers.
// The child PATH is the dispatch sandbox's bin/ (fake harnesses, node and git only).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.js');
const { readLog } = require('../helper/fake-harness-cli.js');
const attempts = require('../../src/runtime/task-attempts.ts');
const dispatchStore = require('../../src/runtime/dispatch/store.ts');
const loop = require('../../src/runtime/dispatch/loop.ts');
const { executeDispatchCommand } = require('../../src/runtime/dispatch/command.ts');
const readiness = require('../../src/runtime/worker/readiness.ts');

const SLUG = '106-fallback-e2e';
const POSIX = { skip: process.platform === 'win32' && 'dispatch sandbox cleanup is unverified on win32' };
/** The codex entry's registry signals, read, not copied (106 review C-6). */
const SIGNALS = require('../../src/registry/index.ts').loadRegistry({ repoRoot: path.join(__dirname, '..', '..') }).harnesses.find((h) => h.id === 'codex').worker.structuredOutput.quotaSignals.signals;
const QUOTA = { type: 'result', status: 'failure', summary: 'You have hit your usage limit' };
const SUCCESS = { type: 'result', status: 'success', summary: 'edited' };
const PLAN = (owner = 'core-implementer') => [
  '# Implementation Plan: fallback end-to-end fixture', '', '**Task graph:** v1', '', '## 8. Tasks', '', '### Phase A', '',
  `- [ ] A.1 Write the retry module — owner: ${owner}; files: src/retry.js; budget: attempts=3`, '',
].join('\n');

function descriptorsFor({ secondSignals = false, firstSignals = true } = {}) {
  const box = require('../fixtures/worker/descriptors.json');
  const descriptors = structuredClone(box);
  // The first rung declares the same conservative signal list and unverified basis as Codex's
  // registry entry. Both workers are isolated-edit capable fake descriptors for this test only.
  if (firstSignals) descriptors.claude.structuredOutput.quotaSignals = { signals: [...SIGNALS], basis: 'unverified', evidence: [] };
  else delete descriptors.claude.structuredOutput.quotaSignals;
  descriptors.claude.isolatedEdit = {
    status: 'supported', evidence: ['dispatch-fallback-e2e.test.js fake worker'],
    verification: 'Run this test with the fake harness CLI.', verifiedOn: '2026-10-21', argv: ['--edit-in-cwd'],
  };
  descriptors.gemini.structuredOutput = structuredClone(descriptors.claude.structuredOutput);
  if (secondSignals) descriptors.gemini.structuredOutput.quotaSignals = { signals: [...SIGNALS], basis: 'unverified', evidence: [] };
  else delete descriptors.gemini.structuredOutput.quotaSignals;
  descriptors.gemini.isolatedEdit = {
    status: 'supported', evidence: ['dispatch-fallback-e2e.test.js fake worker'],
    verification: 'Run this test with the fake harness CLI.', verifiedOn: '2026-10-21', argv: ['--gemini-edit-in-cwd'],
  };
  return descriptors;
}

function scenario(first = QUOTA, second = SUCCESS) {
  return { byBinary: {
    'fake-claude': { run: [{ sleep: 100 }, { emit: first }] },
    'fake-gemini': { run: [{ write: { path: 'src/retry.js', content: '// stepped\n' } }, { sleep: 100 }, { emit: second }] },
  } };
}

async function project(t, { owner, fallback, secondSignals = false, firstSignals = true, workerScenario = scenario() } = {}) {
  const sb = makeDispatchSandbox(t, { plan: PLAN(owner), slug: SLUG, scenario: workerScenario, systemTools: ['bash'], identity: { DOFLOW_ATTEMPT: undefined } });
  const env = { ...sb.env };
  const descriptors = descriptorsFor({ secondSignals, firstSignals });
  assert.equal((await readiness.probe({ descriptors, env, cwd: sb.root })).disposition, 'probed');
  const started = await executeDispatchCommand({
    action: 'start', slug: SLUG, by: 'main', mode: 'auto', verifyArgv: JSON.stringify(sb.verifyArgv),
    ladder: 'claude,gemini', ...(fallback ? { fallback } : {}), cwd: sb.root, env, descriptors,
  });
  assert.equal(started.exit, 0, JSON.stringify(started.body));
  const file = dispatchStore.storeFileFor(sb.root, SLUG);
  const ledgerFile = attempts.storeFile(sb.root, SLUG);
  const read = () => dispatchStore.readDispatch(file);
  const ledger = () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const run = () => loop.run({ slug: SLUG, env, cwd: sb.root, by: 'main', descriptors, maxSeconds: 60 });
  const inspect = () => executeDispatchCommand({ action: 'inspect', slug: SLUG, cwd: sb.root, env, descriptors });
  const harnessRuns = () => readLog(sb.log).filter((entry) => entry.argv.some((arg) => ['--edit-in-cwd', '--gemini-edit-in-cwd'].includes(arg)));
  return { sb, env, descriptors, read, ledger, run, inspect, harnessRuns };
}

const fallbackActions = (s) => s.steps.flatMap((step) => step.actions).filter((action) => action.action === 'fallback');

test('106 A.3: default ask releases quota attempt, holds proposed rung, exposes inspect state, and never launches rung 2', POSIX, async (t) => {
  const p = await project(t);
  const r = await p.run();
  assert.equal(r.outcome, 'blocked', JSON.stringify(r.last));
  assert.equal(r.last.blocked.cause, 'quota');
  const s = p.read();
  const d = Object.values(s.dispatches)[0];
  assert.deepEqual([d.harness, d.disposition, d.failureClass], ['claude', 'failed', 'quota']);
  assert.deepEqual(p.ledger().tasks['A.1'].attempts.map((a) => [a.state, a.result ?? null]), [['released', null]]);
  assert.deepEqual(s.run.fallback.holds['A.1'] && [s.run.fallback.holds['A.1'].reason, s.run.fallback.holds['A.1'].proposed], ['quota', 'gemini']);
  assert.deepEqual(s.run.fallback.events.map((e) => e.kind), ['quota', 'hold']);
  assert.deepEqual(fallbackActions(s).map((a) => a.reason), [
    'quota:A.1 claude -> none (usage limit; mode ask; signals unverified)',
    'hold:A.1 claude -> gemini (quota; mode ask; signals unverified)',
  ]);
  assert.deepEqual(r.last.blocked.gaps.find((g) => g.task === 'A.1')?.cause, 'quota');
  assert.deepEqual(p.harnessRuns().map((entry) => entry.argv.includes('--gemini-edit-in-cwd')), [false]);
  const inspected = await p.inspect();
  assert.deepEqual(inspected.body.fallback, s.run.fallback);
});

test('106 A.3: auto releases rung 1 quota attempt and completes on rung 2 with one step action', POSIX, async (t) => {
  const p = await project(t, { fallback: 'auto' });
  const r = await p.run();
  assert.equal(r.outcome, 'completed', JSON.stringify(r.last));
  const s = p.read();
  assert.deepEqual(Object.values(s.dispatches).map((d) => [d.harness, d.disposition]), [['claude', 'failed'], ['gemini', 'completed']]);
  assert.deepEqual(p.ledger().tasks['A.1'].attempts.map((a) => a.state), ['released', 'finished']);
  assert.deepEqual(s.run.fallback.events.map((e) => e.kind), ['quota', 'step']);
  assert.equal(fallbackActions(s).length, 2);
  assert.deepEqual(p.harnessRuns().map((entry) => entry.argv.includes('--gemini-edit-in-cwd')), [false, true]);
});

test('106 A.3: auto keeps a frontier owner at frontier-no-step and never launches rung 2', POSIX, async (t) => {
  const p = await project(t, { owner: 'system-architect', fallback: 'auto' });
  const r = await p.run();
  assert.equal(r.outcome, 'blocked', JSON.stringify(r.last));
  const hold = p.read().run.fallback.holds['A.1'];
  assert.deepEqual([hold.reason, hold.proposed], ['frontier-no-step', null]);
  assert.equal(p.harnessRuns().some((entry) => entry.argv.includes('--gemini-edit-in-cwd')), false);
  assert.deepEqual(Object.values(p.read().dispatches).map((d) => d.harness), ['claude']);
});

test('106 A.3: quota on every rung holds ladder-exhausted and never falls through to sequential', POSIX, async (t) => {
  const p = await project(t, { fallback: 'auto', secondSignals: true, workerScenario: scenario(QUOTA, QUOTA) });
  const r = await p.run();
  assert.equal(r.outcome, 'blocked', JSON.stringify(r.last));
  assert.notEqual(r.mode, 'sequential');
  assert.ok(Object.values(p.read().dispatches).every((d) => d.mode === 'subagent'), 'no sequential dispatch is created');
  assert.deepEqual(p.read().run.fallback.holds['A.1'] && [p.read().run.fallback.holds['A.1'].reason, p.read().run.fallback.holds['A.1'].proposed], ['ladder-exhausted', null]);
  assert.equal(p.harnessRuns().length, 2);
  assert.equal(p.read().run.fallback.events.some((e) => e.kind === 'step'), true);
});

test('106 A.3: 401 authentication failure remains worker-failure and does not trigger fallback', POSIX, async (t) => {
  const p = await project(t, { fallback: 'auto', workerScenario: scenario({ type: 'result', status: 'failure', summary: '401 Unauthorized: invalid api key' }) });
  const r = await p.run();
  assert.equal(r.outcome, 'blocked', JSON.stringify(r.last));
  const dispatches = Object.values(p.read().dispatches);
  assert.ok(dispatches.length > 0);
  assert.ok(dispatches.every((d) => d.failureClass === 'worker-failure' && d.disposition === 'failed'));
  assert.deepEqual(p.read().run.fallback.events, []);
  assert.equal(fallbackActions(p.read()).length, 0);
  assert.equal(p.harnessRuns().some((entry) => entry.argv.includes('--gemini-edit-in-cwd')), false);
});
