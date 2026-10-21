'use strict';

// Feature 106 A.2 (IC-003, IC-004, IC-005; FR-002 to FR-008): the quota fallback ladder in 082
// dispatch. Ladder selection is checked on the pure `selectMode` with a prefilled candidate cache;
// holds, steps, events and gaps through the loop over a sandbox repository
// (test/helper/dispatch-sandbox.js) whose PATH is the scratch bin/ alone (fake CLI links, node and
// git, never a real harness binary, DEC-056); the setting through the settings fixture. No model or
// network call. POSIX only where a sandbox is used.
//
// Quota recognition is A.1's (IC-002: the supervisor sets `report.quota` from a descriptor's
// `quotaSignals` and `resultOfRun` withholds `report-quota`). This file does not depend on it: the
// stand-in below wraps `resultOfRun` before the loop is loaded, so a fake worker whose failure
// summary holds QUOTA_TEXT ends exactly as an IC-002 quota report would.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.js');
const { createSettingsEnv } = require('../helper/settings-fixtures.js');

const REPO = path.join(__dirname, '..', '..');
const SRC = path.join(REPO, 'src', 'runtime');
const QUOTA_TEXT = 'rate limit';
const supervisor = require(path.join(SRC, 'worker', 'supervisor.ts'));
const realResultOfRun = supervisor.resultOfRun;
supervisor.resultOfRun = (run) => {
  const out = realResultOfRun(run);
  const summary = String(run && run.report && run.report.summary ? run.report.summary : '').toLowerCase();
  if (!run || !run.report || run.report.status !== 'failure' || !summary.includes(QUOTA_TEXT)) return out;
  run.report.quota = run.report.quota || { signal: QUOTA_TEXT, basis: 'unverified' };
  return { resultOffered: false, withheld: out.withheld.map((r) => (r === 'report-failure' ? 'report-quota' : r)) };
};

const attempts = require(path.join(SRC, 'task-attempts.ts'));
const readiness = require(path.join(SRC, 'worker', 'readiness.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { createIntegrationWorktree } = require(path.join(SRC, 'dispatch', 'integrate.ts'));
const loop = require(path.join(SRC, 'dispatch', 'loop.ts'));
const { executeDispatchCommand, fallbackSetting, summaryLines } = require(path.join(SRC, 'dispatch', 'command.ts'));
const { readRuns, storeFileFor: runStoreFileFor } = require(path.join(SRC, 'worker', 'run-store.ts'));
const { runVerification } = require(path.join(SRC, 'dispatch', 'verify-run.ts'));
const { loadSettings } = require(path.join(SRC, 'settings', 'resolve.ts'));
const { loadRegistry } = require(path.join(REPO, 'src', 'registry', 'index.ts'));
const { parsePlan } = require(path.join(SRC, 'scaffold', 'artifacts.ts'));
const { taskLineHash } = require(path.join(SRC, 'task-attempts.ts'));
const { buildGraph, graphDigest, graphTuples } = require(path.join(SRC, 'task-graph.ts'));

const SLUG = '106-fallback-fixture';
const POSIX = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
const REG = loadRegistry({ repoRoot: REPO });
const SUCCESS = { type: 'result', status: 'success', summary: 'edited' };
const QUOTA = { type: 'result', status: 'failure', summary: 'Rate limit reached for this account' };
/** claude ends on quota, gemini edits and succeeds. */
const SCENARIO = {
  byBinary: {
    'fake-claude': { run: [{ emit: QUOTA }] },
    'fake-gemini': { run: [{ write: { path: 'src/retry.js', content: '// stepped\n' } }, { emit: SUCCESS }] },
  },
};
const planFor = (owner = 'core-implementer', budget = 3, tier = null) => [
  '# Implementation Plan: fallback fixture', '', '**Task graph:** v1', '', '## 8. Tasks', '', '### Phase A', '',
  `- [ ] A.1 Write the module — owner: ${owner}${tier ? `; tier: ${tier}` : ''}; files: src/retry.js; budget: attempts=${budget}`, '',
].join('\n');
const FRONTIER_PLAN = planFor('system-architect', 2);
/** Every named fake binary ends on quota, unless `ok` names the one that edits and succeeds. */
const quotaOn = (names, ok = null) => ({ byBinary: Object.fromEntries([
  ...names.map((n) => [`fake-${n}`, { run: [{ emit: QUOTA }] }]),
  ...(ok ? [[`fake-${ok}`, { run: [{ write: { path: 'src/retry.js', content: `// ${ok}\n` } }, { emit: SUCCESS }] }]] : []),
]) });

/** Each fake rung's edit argv, so the harness log names the rung that ran. */
const EDIT_ARGV = Object.freeze({ claude: '--edit-in-cwd', gemini: '--gemini-edit-in-cwd', opencode: '--opencode-edit-in-cwd' });
const cand = (harness, eligible = true) => ({ harness, eligible, gaps: eligible ? [] : [{ requirement: 'installed', result: 'unknown', reason: 'not-probed' }] });
const fb = (extra = {}) => ({ mode: 'ask', ladder: null, exhausted: [], holds: {}, events: [], eventsDropped: 0, ...extra });
const select = (candidates, extra = {}) => loop.selectMode({ policy: 'auto', registry: REG, cache: { candidates: structuredClone(candidates) }, ...extra });
const line = (kind, task, from, to, reason, mode, basis = 'unverified') => `${kind}:${task} ${from} -> ${to ?? 'none'} (${reason}; mode ${mode}; signals ${basis})`;

// ── selection (IC-004, pure) ─────────────────────────────────────────────────────────────────────

test('106 IC-004: the ladder order is honoured; without a ladder registry order; a harness outside the ladder is never chosen', () => {
  const all = [cand('claude'), cand('codex'), cand('gemini')];
  const laddered = select(all, { fallback: fb({ ladder: ['gemini', 'claude'] }) });
  assert.deepEqual([laddered.mode, laddered.harness], ['subagent', 'gemini']);
  assert.deepEqual(laddered.selection.candidates.map((c) => c.harness), ['gemini', 'claude']);
  assert.equal(select(all, { fallback: fb() }).harness, 'claude');

  const outside = select([cand('claude'), cand('codex'), cand('gemini', false)], { fallback: fb({ ladder: ['gemini'] }) });
  assert.deepEqual([outside.mode, outside.harness], ['sequential', null], 'claude and codex are not rungs');
  const gone = select([cand('claude'), cand('gemini')], { owner: 'core-implementer', fallback: fb({ ladder: ['gemini'], exhausted: ['gemini'], mode: 'auto' }) });
  assert.deepEqual(gone.hold, { reason: 'ladder-exhausted', from: 'gemini', proposed: null });
  assert.equal(gone.mode, undefined, 'never a mode, never claude');
});

test('106 IC-004: an exhausted harness is never chosen again, for any task and any ladder', () => {
  const all = [cand('claude'), cand('codex'), cand('gemini')];
  for (const owner of ['core-implementer', 'spec-analyst', 'research-writer', 'Core-Implementer']) {
    for (const ladder of [null, ['claude', 'codex'], ['claude', 'gemini', 'codex']]) {
      const r = select(all, { owner, fallback: fb({ mode: 'auto', ladder, exhausted: ['claude'] }) });
      assert.equal(r.mode, 'subagent', JSON.stringify(r));
      assert.notEqual(r.harness, 'claude');
      assert.deepEqual(r.selection.fallback, { kind: 'step', from: 'claude', to: ladder ? ladder[1] : 'codex' });
    }
  }
});

test('106 IC-004: with every rung exhausted the task holds ladder-exhausted in every mode, never sequential', () => {
  const all = [cand('claude'), cand('codex'), cand('gemini', false)];
  for (const mode of ['off', 'ask', 'auto']) {
    const r = select(all, { owner: 'core-implementer', fallback: fb({ mode, exhausted: ['claude', 'codex'] }) });
    assert.deepEqual(r.hold, { reason: 'ladder-exhausted', from: 'claude', proposed: null }, mode);
    assert.notEqual(r.mode, 'sequential', mode);
  }
  const single = select([cand('codex')], { owner: 'core-implementer', fallback: fb({ mode: 'auto', exhausted: ['codex'] }) });
  assert.deepEqual(single.hold, { reason: 'ladder-exhausted', from: 'codex', proposed: null }, 'a --harness run is a one-rung ladder');
});

test('106 IC-004: with nothing exhausted passed the selection equals the pre-106 one', () => {
  const eligible = [cand('claude', false), cand('codex'), cand('gemini')];
  const none = [cand('claude', false), cand('codex', false)];
  const pre = (candidates) => {
    const chosen = candidates.find((c) => c.eligible);
    const selection = { policy: 'auto', chosen: chosen ? chosen.harness : 'sequential', candidates };
    return chosen ? { mode: 'subagent', harness: chosen.harness, selection } : { mode: 'sequential', harness: null, selection };
  };
  for (const candidates of [eligible, none]) {
    assert.deepEqual(select(candidates), pre(candidates));
    for (const mode of ['off', 'ask', 'auto']) {
      assert.deepEqual(select(candidates, { fallback: fb({ mode }) }), pre(candidates), mode);
      assert.deepEqual(select(candidates, { fallback: fb({ mode, exhausted: ['gemini'] }) }), pre(candidates), `${mode}: the exhausted rung is after the choice`);
    }
  }
  assert.deepEqual(select(eligible, { lastFailureClass: 'launch', fallback: fb({ mode: 'auto' }) }).mode, 'sequential');
  assert.deepEqual(select(eligible, { lastFailureClass: 'launch', fallback: fb({ mode: 'auto', exhausted: ['gemini'] }) }).mode, 'sequential', 'C-3: no rung change, the launch rule');
  assert.deepEqual(select(eligible, { policy: 'manual', fallback: fb({ mode: 'auto', exhausted: ['codex'] }) }).mode, 'manual');
  assert.deepEqual(select(eligible, { held: true, fallback: fb({ mode: 'auto', exhausted: ['codex'] }) }).mode, 'sequential');
});

test('106 IC-004: ask holds with the next rung proposed, off holds with none, auto steps once', () => {
  const all = [cand('claude'), cand('codex')];
  const at = { owner: 'core-implementer' };
  assert.deepEqual(select(all, { ...at, fallback: fb({ mode: 'ask', exhausted: ['claude'] }) }).hold, { reason: 'quota', from: 'claude', proposed: 'codex' });
  assert.deepEqual(select(all, { ...at, fallback: fb({ mode: 'off', exhausted: ['claude'] }) }).hold, { reason: 'quota', from: 'claude', proposed: null });
  const auto = select(all, { ...at, fallback: fb({ mode: 'auto', exhausted: ['claude'] }) });
  assert.deepEqual([auto.hold, auto.mode, auto.harness, auto.selection.chosen], [undefined, 'subagent', 'codex', 'codex']);
  assert.deepEqual(auto.selection.fallback, { kind: 'step', from: 'claude', to: 'codex' });
});

test('106 IC-004 / C-2: frontier, review (quality-guardian), mis-cased and unknown owners hold frontier-no-step in every mode; no dispatchTiers holds', () => {
  const all = [cand('claude'), cand('codex')];
  assert.equal(REG.dispatchTiers.byOwner['system-architect'], 'frontier');
  assert.equal(REG.dispatchTiers.byOwner['quality-guardian'], 'standard', 'held as review work, not by tier');
  for (const owner of ['system-architect', 'System-Architect', 'quality-guardian', 'QUALITY-GUARDIAN', 'not-an-owner', null, '']) {
    for (const mode of ['off', 'ask', 'auto']) {
      const r = select(all, { owner, fallback: fb({ mode, exhausted: ['claude'] }) });
      assert.deepEqual(r.hold, { reason: 'frontier-no-step', from: 'claude', proposed: null }, `${owner} ${mode}`);
    }
  }
  for (const owner of ['core-implementer', 'Core-Implementer']) {
    assert.equal(select(all, { owner, fallback: fb({ mode: 'auto', exhausted: ['claude'] }) }).harness, 'codex', owner);
  }
  const plain = select(all, { owner: 'core-implementer', registry: { harnesses: [] }, fallback: fb({ mode: 'auto', exhausted: ['claude'] }) });
  assert.deepEqual(plain.hold, { reason: 'frontier-no-step', from: 'claude', proposed: null }, 'a registry without dispatchTiers: every owner unknown, held');
});

test('106 R-1: the task line tier wins over the owner tier; a valid task-line frontier holds in every mode, an invalid one falls back to the owner', () => {
  const all = [cand('claude'), cand('codex')];
  const at = (owner, tier, mode) => select(all, { owner, tier, fallback: fb({ mode, exhausted: ['claude'] }) });
  for (const mode of ['off', 'ask', 'auto']) {
    for (const owner of ['core-implementer', 'spec-analyst', 'Core-Implementer']) {
      assert.deepEqual(at(owner, 'frontier', mode).hold, { reason: 'frontier-no-step', from: 'claude', proposed: null }, `${owner} ${mode}`);
    }
    assert.deepEqual(at('system-architect', 'ultra', mode).hold, { reason: 'frontier-no-step', from: 'claude', proposed: null }, `invalid tier, frontier owner, ${mode}`);
    assert.deepEqual(at('not-an-owner', 'standard', mode).hold, { reason: 'frontier-no-step', from: 'claude', proposed: null }, `unknown owner stays held, ${mode}`);
    assert.deepEqual(at('quality-guardian', 'light', mode).hold, { reason: 'frontier-no-step', from: 'claude', proposed: null }, `review owner stays held, ${mode}`);
  }
  assert.equal(at('core-implementer', 'ultra', 'auto').harness, 'codex', 'an invalid task-line tier is ignored');
  assert.equal(at('system-architect', 'standard', 'auto').harness, 'codex', 'a valid task-line tier wins over the owner tier, as brief-tools resolves it');
});

test('106 R-1: the parser keeps tier only on a line that carries one; the line hash, graph tuples and digest ignore it', () => {
  const withTier = '- [ ] A.1 Review the branch — owner: core-implementer; tier: frontier; files: src/a.js; budget: attempts=2';
  const without = '- [ ] A.1 Review the branch — owner: core-implementer; files: src/a.js; budget: attempts=2';
  const parse = (line) => parsePlan(['# Plan', '', '**Task graph:** v1', '', '## 8. Tasks', '', '### Phase A', '', line, ''].join('\n'));
  const [a] = parse(withTier).tasks;
  const [b] = parse(without).tasks;
  assert.equal(a.tier, 'frontier');
  assert.equal(Object.hasOwn(b, 'tier'), false, 'a line with no tier: is parsed exactly as before');
  const { tier, ...rest } = a;
  assert.deepEqual(rest, b, 'tier is the only difference');
  assert.equal(taskLineHash(a), taskLineHash(b));
  const ga = buildGraph(parse(withTier)).graph;
  const gb = buildGraph(parse(without)).graph;
  assert.equal(ga.tasks[0].tier, 'frontier', 'the graph task carries it to dispatch');
  assert.deepEqual(graphTuples(ga), graphTuples(gb));
  assert.equal(graphDigest(ga), graphDigest(gb));
});

test('106 R-2: an acceptance steps only to the accepted rung; another chosen rung holds with the new proposal', () => {
  const all = [cand('claude'), cand('gemini', false), cand('opencode')];
  const last = { harness: 'claude', failureClass: 'quota', token: 1 };
  const at = (mode, accepted) => select(all, { task: 'A.1', last, owner: 'core-implementer', fallback: fb({ mode, ladder: ['claude', 'gemini', 'opencode'], exhausted: ['claude'], accepted }) });
  assert.deepEqual(at('ask', { 'A.1': 'gemini' }).hold, { reason: 'quota', from: 'claude', proposed: 'opencode' });
  assert.deepEqual(at('off', { 'A.1': 'gemini' }).hold, { reason: 'quota', from: 'claude', proposed: null });
  assert.deepEqual(at('off', { 'A.1': null }).hold, { reason: 'quota', from: 'claude', proposed: null }, 'an off hold proposed nothing, so nothing can be accepted');
  assert.deepEqual(at('off', { 'A.1': 'opencode' }).hold, { reason: 'quota', from: 'claude', proposed: null }, 'off never steps on an acceptance');
  const ok = at('ask', { 'A.1': 'opencode' });
  assert.deepEqual([ok.harness, ok.selection.fallback], ['opencode', { kind: 'step', from: 'claude', to: 'opencode', accepted: true }]);
});

test('106 C-1: after a quota end any next harness is a change: frontier holds in every mode, others hold, propose or step from the quota-ed rung', () => {
  const back = [cand('claude'), cand('gemini', false)];
  const last = { harness: 'gemini', failureClass: 'quota', token: 1 };
  const at = (owner, mode) => select(back, { task: 'A.1', last, owner, fallback: fb({ mode, ladder: ['claude', 'gemini'], exhausted: ['gemini'] }) });
  for (const mode of ['off', 'ask', 'auto']) {
    assert.deepEqual(at('system-architect', mode).hold, { reason: 'frontier-no-step', from: 'gemini', proposed: null }, mode);
  }
  assert.deepEqual(at('core-implementer', 'off').hold, { reason: 'quota', from: 'gemini', proposed: null });
  assert.deepEqual(at('core-implementer', 'ask').hold, { reason: 'quota', from: 'gemini', proposed: 'claude' });
  const auto = at('core-implementer', 'auto');
  assert.deepEqual([auto.mode, auto.harness, auto.selection.fallback], ['subagent', 'claude', { kind: 'step', from: 'gemini', to: 'claude' }]);
  // A task that already runs on the chosen rung (an accepted step, then an ordinary failure) stays there.
  const stays = select([cand('claude'), cand('gemini')], { task: 'A.1', last: { harness: 'gemini', failureClass: 'worker-failure', token: 2 }, owner: 'core-implementer', fallback: fb({ mode: 'ask', ladder: ['claude', 'gemini'], exhausted: ['claude'] }) });
  assert.deepEqual([stays.hold, stays.mode, stays.harness, stays.selection.fallback], [undefined, 'subagent', 'gemini', undefined]);
});

test('106 C-3: lastFailure skips quota ends; launch then an exhausted ladder holds; a no-quota launch failure stays sequential without evaluating', () => {
  const ended = (token, failureClass, harness = 'claude') => ({ dispatchId: `d-00000000000${token}`, task: 'A.1', token, phase: 'ended', disposition: 'failed', failureClass, harness });
  const s = { dispatches: { a: ended(1, 'launch'), b: ended(2, 'quota', 'gemini') } };
  assert.equal(loop.lastFailure(s, 'A.1'), 'launch');
  assert.equal(loop.lastWorkerDispatch(s, 'A.1').token, 2);
  const held = select([cand('claude')], { task: 'A.1', lastFailureClass: 'launch', last: ended(1, 'launch'), owner: 'core-implementer', fallback: fb({ mode: 'ask', ladder: ['claude'], exhausted: ['claude'] }) });
  assert.deepEqual(held.hold, { reason: 'ladder-exhausted', from: 'claude', proposed: null });
  let read = 0;
  const cache = { get candidates() { read += 1; return [cand('claude')]; }, set candidates(v) { read += 1; } };
  const plain = loop.selectMode({ policy: 'auto', task: 'A.1', lastFailureClass: 'launch', last: ended(1, 'launch'), owner: 'core-implementer', registry: REG, cache, fallback: fb({ mode: 'auto' }) });
  assert.deepEqual([plain.mode, read], ['sequential', 0]);
});

test('106 IC-004: run.fallback.events keeps the newest 200 and counts the dropped ones', () => {
  const run = {};
  for (let i = 0; i < 205; i += 1) store.appendFallbackEvent(run, { kind: 'quota', i }, 'ask');
  assert.equal(run.fallback.events.length, 200);
  assert.equal(run.fallback.eventsDropped, 5);
  assert.deepEqual([run.fallback.events[0].i, run.fallback.events.at(-1).i], [5, 204]);
  assert.deepEqual([run.fallback.mode, run.fallback.ladder, run.fallback.exhausted, run.fallback.holds], ['ask', null, [], {}]);
});

// ── the loop (IC-003, IC-004) ────────────────────────────────────────────────────────────────────

/** A sandbox with a started 080 run and a seeded dispatch run; `fallback` is stored as given. */
async function project(t, { plan = 'budget', mode = 'auto', fallback, scenario = SCENARIO, probe = true, probeOnly = null } = {}) {
  const sb = makeDispatchSandbox(t, { plan, slug: SLUG, scenario, identity: { DOFLOW_ATTEMPT: undefined } });
  const { root } = sb;
  const env = { ...sb.env };
  const descriptors = structuredClone(sb.descriptors);
  for (const h of ['gemini', 'opencode']) descriptors[h].isolatedEdit = { ...structuredClone(descriptors.claude.isolatedEdit), argv: [EDIT_ARGV[h]] };
  const ledgerFile = attempts.storeFile(root, SLUG);
  const common = { file: ledgerFile, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root };
  const started = attempts.start({ ...common, by: 'main' });
  assert.equal(started.disposition, 'started', JSON.stringify(started));
  const dispatchRunId = store.newDispatchRunId();
  const integration = createIntegrationWorktree({ root, slug: SLUG, dispatchRunId, env });
  const file = store.storeFileFor(root, SLUG);
  store.mutateDispatch(file, (s) => {
    s.run = {
      dispatchRunId, slug: SLUG, state: 'running', runKey: started.runKey, epoch: started.epoch, concurrency: 1, mode,
      reserveTokens: null, attemptSeconds: 60, harness: null, needs: [], spawnGrant: null, createdAt: new Date().toISOString(),
      integration: { worktree: integration.worktree, branch: integration.branch, base: integration.base, head: integration.head },
      verify: { argv: sb.verifyArgv, argvSha256: null, argvCount: sb.verifyArgv.length, timeoutSeconds: 60 },
      ...(fallback === undefined ? {} : { fallback }),
    };
    return { write: true, result: null };
  });
  if (probe) assert.equal((await readiness.probe({ descriptors, env, cwd: root, ...(probeOnly ? { harness: probeOnly } : {}) })).disposition, 'probed');
  const read = () => store.readDispatch(file);
  const options = (extra = {}) => ({ slug: SLUG, env, cwd: root, by: 'main', descriptors, ...extra });
  const exec = (extra) => executeDispatchCommand({ slug: SLUG, cwd: root, env, descriptors, ...extra });
  const fallbackActions = () => read().steps.flatMap((s) => s.actions).filter((a) => a.action === 'fallback');
  const ledger = () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const byArgv = Object.fromEntries(Object.entries(EDIT_ARGV).map(([h, a]) => [a, h]));
  const runs = () => (fs.existsSync(sb.log) ? fs.readFileSync(sb.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => Object.hasOwn(byArgv, l.argv[0])) : []);
  /** The harness of every edit run the fakes logged, in order. */
  const ran = () => runs().map((l) => byArgv[l.argv[0]]);
  const probeNow = async (harness) => assert.equal((await readiness.probe({ descriptors, env, cwd: root, harness })).disposition, 'probed');
  return {
    sb, root, env, file, read, options, exec, fallbackActions, ledger, runs, ran, probeNow, descriptors, common, epoch: started.epoch,
    run: (extra) => loop.run(options({ maxSeconds: 60, ...extra })),
  };
}

const byToken = (s) => Object.values(s.dispatches).sort((a, b) => a.token - b.token);

test('106 IC-003 / IC-004: auto mode releases the quota attempt, marks claude exhausted and steps once to gemini, one event and action each', POSIX, async (t) => {
  const p = await project(t, { fallback: fb({ mode: 'auto', ladder: ['claude', 'gemini'] }) });
  const r = await p.run();
  assert.equal(r.outcome, 'completed', JSON.stringify(r.last.blocked || r.last.actions));
  const s = p.read();
  const [first, second] = byToken(s);
  assert.deepEqual([first.harness, first.disposition, first.failureClass], ['claude', 'failed', 'quota']);
  assert.deepEqual([second.harness, second.disposition], ['gemini', 'completed']);
  assert.deepEqual(p.ledger().tasks['A.1'].attempts.map((a) => [a.state, a.result ?? null]), [['released', null], ['finished', 'COMPLETED']]);
  assert.deepEqual(s.run.fallback.exhausted, ['claude']);
  assert.deepEqual(s.run.fallback.holds, {});
  const events = s.run.fallback.events;
  assert.deepEqual(events.map((e) => [e.kind, e.task, e.dispatchId, e.from, e.to, e.reason, e.mode, e.basis]), [
    ['quota', 'A.1', first.dispatchId, 'claude', null, QUOTA_TEXT, 'auto', 'unverified'],
    ['step', 'A.1', second.dispatchId, 'claude', 'gemini', 'quota', 'auto', 'unverified'],
  ]);
  assert.deepEqual(first.fallback, [events[0]], 'the quota event is copied to its dispatch');
  assert.deepEqual(second.fallback, [events[1]], 'the step event is copied to its dispatch');
  assert.deepEqual(p.fallbackActions().map((a) => [a.dispatchId, a.reason]), [
    [first.dispatchId, line('quota', 'A.1', 'claude', null, QUOTA_TEXT, 'auto')],
    [second.dispatchId, line('step', 'A.1', 'claude', 'gemini', 'quota', 'auto')],
  ]);
  assert.deepEqual(p.runs().length, 2, 'one claude run, one gemini run');
});

test('106 IC-004 / IC-005: ask holds with gemini proposed, the run blocks on cause quota, and resume --fallback auto steps it', POSIX, async (t) => {
  const p = await project(t, { fallback: fb({ mode: 'ask', ladder: ['claude', 'gemini'] }) });
  const r = await p.run();
  assert.equal(r.outcome, 'blocked', JSON.stringify(r.last.actions));
  assert.equal(r.last.blocked.cause, 'quota');
  const gap = r.last.blocked.gaps.find((g) => g.task === 'A.1');
  assert.deepEqual([gap.kind, gap.cause, gap.reason], ['quota', 'quota', 'claude quota; proposed gemini']);
  let s = p.read();
  assert.deepEqual(Object.keys(s.run.fallback.holds), ['A.1']);
  assert.deepEqual([s.run.fallback.holds['A.1'].reason, s.run.fallback.holds['A.1'].from, s.run.fallback.holds['A.1'].proposed], ['quota', 'claude', 'gemini']);
  assert.deepEqual(s.run.fallback.events.map((e) => [e.kind, e.dispatchId === null, e.to]), [['quota', false, null], ['hold', true, 'gemini']]);
  assert.deepEqual(p.fallbackActions().map((a) => a.reason), [
    line('quota', 'A.1', 'claude', null, QUOTA_TEXT, 'ask'), line('hold', 'A.1', 'claude', 'gemini', 'quota', 'ask'),
  ]);
  assert.equal(Object.keys(s.dispatches).length, 1, 'the held task is never admitted');
  const again = await loop.step(p.options());
  assert.ok(again.actions.some((a) => a.action === 'admit' && a.reason === 'skipped:held:quota'), JSON.stringify(again.actions));
  assert.equal(p.fallbackActions().length, 2, 'an existing hold adds no event');

  const asked = await p.exec({ action: 'resume', fallback: 'auto' });
  assert.equal(asked.body.disposition, 'ack-required', JSON.stringify(asked.body));
  assert.equal(p.read().run.fallback.mode, 'ask', 'nothing changes before the ack');
  const resumed = await p.exec({ action: 'resume', ack: asked.body.digest, by: 'main', fallback: 'auto' });
  assert.equal(resumed.exit, 0, JSON.stringify(resumed.body));
  assert.deepEqual(resumed.body.fallback, { mode: 'ask', cleared: ['A.1'] }, 'C-14: one-shot; the run mode stays ask');
  assert.deepEqual(p.read().run.fallback.accepted, { 'A.1': 'gemini' });
  const done = await p.run();
  assert.equal(done.outcome, 'completed', JSON.stringify(done.last.blocked || done.last.actions));
  s = p.read();
  assert.deepEqual(byToken(s).map((d) => [d.harness, d.disposition]), [['claude', 'failed'], ['gemini', 'completed']]);
  assert.deepEqual(s.run.fallback.events.map((e) => [e.kind, e.reason, e.mode]), [['quota', QUOTA_TEXT, 'ask'], ['hold', 'quota', 'ask'], ['step', 'accepted', 'ask']]);
  assert.deepEqual([s.run.fallback.mode, s.run.fallback.accepted], ['ask', {}]);
});

test('106 IC-004: a frontier-tier task holds frontier-no-step in auto and never moves to gemini', POSIX, async (t) => {
  const p = await project(t, { plan: FRONTIER_PLAN, fallback: fb({ mode: 'auto', ladder: ['claude', 'gemini'] }) });
  const r = await p.run();
  assert.equal(r.outcome, 'blocked', JSON.stringify(r.last.actions));
  assert.equal(r.last.blocked.cause, 'quota');
  const hold = p.read().run.fallback.holds['A.1'];
  assert.deepEqual([hold.reason, hold.from, hold.proposed], ['frontier-no-step', 'claude', null]);
  assert.deepEqual(p.runs().length, 1, 'gemini never ran');
  assert.deepEqual(r.last.blocked.gaps.find((g) => g.task === 'A.1').reason, 'claude quota; proposed none');
});

test('106 IC-027: a run blocked only by holds reports cause quota; a run started before 106 has no run.fallback and steps as before', POSIX, async (t) => {
  const holds = { 'A.1': { reason: 'ladder-exhausted', from: 'claude', proposed: null, at: '2026-10-21T00:00:00.000Z' } };
  const p = await project(t, { fallback: fb({ exhausted: ['claude', 'gemini'], holds }), probe: false });
  const r = await loop.step(p.options());
  assert.equal(r.outcome, 'blocked', JSON.stringify(r.actions));
  assert.equal(r.blocked.cause, 'quota');
  assert.deepEqual(r.blocked.gaps.map((g) => [g.task, g.kind, g.cause, g.reason]), [['A.1', 'ladder-exhausted', 'quota', 'claude quota; proposed none']]);
  assert.ok(r.actions.some((a) => a.action === 'admit' && a.reason === 'skipped:held:ladder-exhausted'));
  assert.deepEqual(p.read().dispatches, {});

  const old = await project(t, { mode: 'sequential', probe: false });
  const first = await loop.step(old.options());
  assert.equal(first.outcome, 'perform', JSON.stringify(first));
  assert.equal(old.read().run.fallback, undefined, 'nothing is written for a run with no quota event');
});

test('106 IC-005: resume --fallback auto clears quota holds only; a run with no run.fallback gets one', POSIX, async (t) => {
  const at = '2026-10-21T00:00:00.000Z';
  const holds = {
    'A.1': { reason: 'quota', from: 'claude', proposed: 'gemini', at },
    'A.2': { reason: 'frontier-no-step', from: 'claude', proposed: null, at },
    'A.3': { reason: 'ladder-exhausted', from: 'claude', proposed: null, at },
  };
  const p = await project(t, { plan: 'disjoint', fallback: fb({ mode: 'off', exhausted: ['claude'], holds }), probe: false });
  const resume = async (fallback) => {
    const asked = await p.exec({ action: 'resume' });
    assert.equal(asked.body.disposition, 'ack-required', JSON.stringify(asked.body));
    return p.exec({ action: 'resume', ack: asked.body.digest, by: 'main', fallback });
  };
  const ask = await resume('ask');
  assert.deepEqual(ask.body.fallback, { mode: 'ask', cleared: [] });
  const auto = await resume('auto');
  assert.deepEqual(auto.body.fallback, { mode: 'ask', cleared: ['A.1'] });
  const f = p.read().run.fallback;
  assert.deepEqual([f.mode, Object.keys(f.holds).sort(), f.exhausted, f.accepted], ['ask', ['A.2', 'A.3'], ['claude'], { 'A.1': 'gemini' }]);
  const inspected = await p.exec({ action: 'inspect' });
  assert.deepEqual(inspected.body.fallback, f, 'inspect shows run.fallback unchanged');
  // C-10: the text form prints one line per hold after IC-029's lines.
  const lines = summaryLines(inspected.body);
  assert.deepEqual(lines.slice(-2), ['hold A.2 frontier-no-step from claude proposed none', 'hold A.3 ladder-exhausted from claude proposed none']);

  const old = await project(t, { probe: false });
  const asked = await old.exec({ action: 'resume' });
  const resumed = await old.exec({ action: 'resume', ack: asked.body.digest, by: 'main', fallback: 'ask' });
  assert.deepEqual(resumed.body.fallback, { mode: 'ask', cleared: [] });
  assert.deepEqual(old.read().run.fallback, fb({ mode: 'ask' }));
});

/** Waits until every launched dispatch's worker run has ended. */
async function settled(p) {
  for (let i = 0; i < 150; i += 1) {
    const runs = readRuns(runStoreFileFor(p.root, SLUG));
    const live = Object.values(p.read().dispatches).filter((d) => d.workerRunId && d.phase === 'launched' && (!runs[d.workerRunId] || runs[d.workerRunId].phase !== 'ended'));
    if (!live.length) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('a worker run did not end');
}

const kinds = (p) => p.read().run.fallback.events.map((e) => e.kind);
/** gemini quotas, claude edits and succeeds. */
const BACK = quotaOn(['gemini'], 'claude');

/**
 * Review BE-1 / C-1: ladder claude,gemini with claude not yet probed, so the task starts on gemini;
 * gemini ends on quota; the pass is interrupted right after collect; claude is probed; then `run`.
 */
async function rungOneBack(t, owner, mode) {
  const p = await project(t, { plan: planFor(owner), fallback: fb({ mode, ladder: ['claude', 'gemini'] }), scenario: BACK, probeOnly: 'gemini' });
  const first = await loop.step(p.options());
  assert.ok(first.actions.some((a) => a.action === 'launch' && a.reason.startsWith('subagent:gemini')), JSON.stringify(first.actions));
  await settled(p);
  let phases = 0;
  await loop.step(p.options({ shouldStop: () => (phases += 1) >= 2 }));
  const [d] = Object.values(p.read().dispatches);
  assert.deepEqual([d.harness, d.disposition, d.failureClass], ['gemini', 'failed', 'quota'], 'collected, nothing admitted yet');
  await p.probeNow('claude');
  return { p, r: await p.run() };
}

test('106 C-1: a frontier task whose quota-ed rung is gemini never moves back to an eligible claude, in off, ask and auto', POSIX, async (t) => {
  for (const mode of ['off', 'ask', 'auto']) {
    const { p, r } = await rungOneBack(t, 'system-architect', mode);
    assert.equal(r.outcome, 'blocked', `${mode}: ${JSON.stringify(r.last.actions)}`);
    const hold = p.read().run.fallback.holds['A.1'];
    assert.deepEqual([hold.reason, hold.from, hold.proposed], ['frontier-no-step', 'gemini', null], mode);
    assert.deepEqual(p.ran(), ['gemini'], `${mode}: claude never launched`);
    assert.deepEqual(kinds(p), ['quota', 'hold'], `${mode}: one hold event`);
  }
});

test('106 C-1: a standard task whose quota-ed rung is gemini holds proposing claude in ask and steps gemini -> claude in auto', POSIX, async (t) => {
  const ask = await rungOneBack(t, 'core-implementer', 'ask');
  assert.equal(ask.r.outcome, 'blocked');
  const hold = ask.p.read().run.fallback.holds['A.1'];
  assert.deepEqual([hold.reason, hold.from, hold.proposed], ['quota', 'gemini', 'claude']);
  assert.deepEqual(ask.p.ran(), ['gemini']);
  const auto = await rungOneBack(t, 'core-implementer', 'auto');
  assert.equal(auto.r.outcome, 'completed', JSON.stringify(auto.r.last.blocked || auto.r.last.actions));
  assert.deepEqual(auto.p.ran(), ['gemini', 'claude']);
  const steps = auto.p.read().run.fallback.events.filter((e) => e.kind === 'step');
  assert.deepEqual(steps.map((e) => [e.from, e.to]), [['gemini', 'claude']], 'one step event');
});

test('106 C-2: a quality-guardian (review) task in auto holds frontier-no-step and never launches rung 2', POSIX, async (t) => {
  const p = await project(t, { plan: planFor('quality-guardian'), fallback: fb({ mode: 'auto', ladder: ['claude', 'gemini'] }) });
  const r = await p.run();
  assert.equal(r.outcome, 'blocked', JSON.stringify(r.last.actions));
  const hold = p.read().run.fallback.holds['A.1'];
  assert.deepEqual([hold.reason, hold.from, hold.proposed], ['frontier-no-step', 'claude', null]);
  assert.deepEqual(p.ran(), ['claude']);
});

test('106 C-4: a held task finished outside dispatch is no gap and the run completes', POSIX, async (t) => {
  const holds = { 'A.1': { reason: 'frontier-no-step', from: 'claude', proposed: null, at: '2026-10-21T00:00:00.000Z' } };
  const p = await project(t, { fallback: fb({ exhausted: ['claude'], holds }), probe: false });
  const c = attempts.claim({ ...p.common, task: 'A.1', owner: 'core-implementer', mode: 'sequential', epoch: p.epoch });
  assert.equal(c.disposition, 'claimed', JSON.stringify(c));
  const v = await runVerification({ root: p.root, slug: SLUG, taskId: 'A.1', worktree: p.root, argv: p.sb.verifyArgv, seconds: 30, env: p.env });
  const fin = attempts.finish({ ...p.common, task: 'A.1', token: c.token, result: 'COMPLETED', evidenceId: v.evidenceId, tokens: 0, basis: 'estimated' });
  assert.equal(fin.disposition, 'applied', JSON.stringify(fin));
  const r = await loop.step(p.options());
  assert.equal(r.outcome, 'completed', JSON.stringify(r.blocked || r.actions));
});

test('106 C-5: a stepped dispatch that also ends on quota keeps [step, quota]', POSIX, async (t) => {
  const p = await project(t, { plan: planFor('core-implementer', 3), fallback: fb({ mode: 'auto', ladder: ['claude', 'gemini'] }), scenario: quotaOn(['claude', 'gemini']) });
  const r = await p.run();
  assert.equal(r.outcome, 'blocked', JSON.stringify(r.last.actions));
  const [first, second] = byToken(p.read());
  assert.deepEqual([first.harness, (first.fallback || []).map((e) => e.kind)], ['claude', ['quota']]);
  assert.deepEqual([second.harness, (second.fallback || []).map((e) => e.kind)], ['gemini', ['step', 'quota']]);
  assert.deepEqual(kinds(p), ['quota', 'step', 'quota', 'hold']);
});

test('106 C-7: a quota release spends one 080 attempt: attempts=2 and two quotas is BLOCKED budget; attempts=1 never steps', POSIX, async (t) => {
  const two = await project(t, { plan: 'budget', fallback: fb({ mode: 'auto', ladder: ['claude', 'gemini'] }), scenario: quotaOn(['claude', 'gemini']) });
  const r2 = await two.run();
  assert.equal(r2.outcome, 'blocked');
  assert.deepEqual(two.ledger().tasks['A.1'].attempts.map((a) => a.state), ['released', 'released']);
  const task = attempts.inspect({ ...two.common }).tasks.find((x) => x.id === 'A.1');
  assert.deepEqual([task.state, task.reason], ['BLOCKED', 'budget']);
  assert.equal(r2.last.blocked.cause, 'budget');

  const one = await project(t, { plan: planFor('core-implementer', 1), fallback: fb({ mode: 'auto', ladder: ['claude', 'gemini'] }) });
  const r1 = await one.run();
  assert.equal(r1.outcome, 'blocked');
  assert.equal(r1.last.blocked.cause, 'budget');
  assert.deepEqual(one.ran(), ['claude'], 'no step happens');
  assert.deepEqual(kinds(one), ['quota']);
});

test('106 C-14: resume --fallback auto accepts one proposal: one step, then the stepped rung quotas and holds again, mode stays ask', POSIX, async (t) => {
  const p = await project(t, { plan: planFor('core-implementer', 3), fallback: fb({ mode: 'ask', ladder: ['claude', 'gemini', 'opencode'] }), scenario: quotaOn(['claude', 'gemini'], 'opencode') });
  const r = await p.run();
  assert.equal(r.outcome, 'blocked');
  assert.equal(p.read().run.fallback.holds['A.1'].proposed, 'gemini');
  const asked = await p.exec({ action: 'resume' });
  const resumed = await p.exec({ action: 'resume', ack: asked.body.digest, by: 'main', fallback: 'auto' });
  assert.deepEqual(resumed.body.fallback, { mode: 'ask', cleared: ['A.1'] });
  const again = await p.run();
  assert.equal(again.outcome, 'blocked', JSON.stringify(again.last.actions));
  const f = p.read().run.fallback;
  assert.deepEqual(p.ran(), ['claude', 'gemini'], 'one step, never a second');
  assert.deepEqual([f.mode, f.accepted, f.holds['A.1'].reason, f.holds['A.1'].from, f.holds['A.1'].proposed], ['ask', {}, 'quota', 'gemini', 'opencode']);
  assert.deepEqual(f.events.map((e) => `${e.kind}:${e.reason}`), ['quota:rate limit', 'hold:quota', 'step:accepted', 'quota:rate limit', 'hold:quota']);
});

test('106 R-1: a task line marked tier: frontier (owner core-implementer) holds frontier-no-step in auto and never launches rung 2', POSIX, async (t) => {
  const p = await project(t, { plan: planFor('core-implementer', 3, 'frontier'), fallback: fb({ mode: 'auto', ladder: ['claude', 'gemini'] }) });
  const r = await p.run();
  assert.equal(r.outcome, 'blocked', JSON.stringify(r.last.actions));
  const hold = p.read().run.fallback.holds['A.1'];
  assert.deepEqual([hold.reason, hold.from, hold.proposed], ['frontier-no-step', 'claude', null]);
  assert.deepEqual(p.ran(), ['claude']);
  assert.deepEqual(kinds(p), ['quota', 'hold']);
});

/** Holds A.1 proposing gemini (ask, ladder claude,gemini[,opencode]), then resume --fallback auto. */
async function accepted(t, ladder, scenario) {
  const p = await project(t, { plan: planFor('core-implementer', 3), fallback: fb({ mode: 'ask', ladder }), scenario });
  assert.equal((await p.run()).outcome, 'blocked');
  assert.equal(p.read().run.fallback.holds['A.1'].proposed, 'gemini');
  return p;
}
async function resumeWith(p, fallback) {
  const asked = await p.exec({ action: 'resume' });
  return p.exec({ action: 'resume', ack: asked.body.digest, by: 'main', fallback });
}

test('106 R-2: an accepted gemini that is no longer ready is never replaced by opencode: held again proposing opencode', POSIX, async (t) => {
  const p = await accepted(t, ['claude', 'gemini', 'opencode'], quotaOn(['claude'], 'opencode'));
  fs.rmSync(path.join(p.root, '.doflow', 'state', 'worker-probes', 'gemini.json'));
  assert.deepEqual((await resumeWith(p, 'auto')).body.fallback, { mode: 'ask', cleared: ['A.1'] });
  const r = await p.run();
  assert.equal(r.outcome, 'blocked', JSON.stringify(r.last.actions));
  const f = p.read().run.fallback;
  assert.deepEqual(p.ran(), ['claude'], 'opencode never launched');
  assert.deepEqual([f.holds['A.1'].reason, f.holds['A.1'].proposed, f.accepted], ['quota', 'opencode', {}]);
  assert.deepEqual(kinds(p), ['quota', 'hold', 'hold']);
});

test('106 R-2: resume --fallback off after an acceptance revokes it: no step, held', POSIX, async (t) => {
  const p = await accepted(t, ['claude', 'gemini'], SCENARIO);
  await resumeWith(p, 'auto');
  assert.deepEqual(p.read().run.fallback.accepted, { 'A.1': 'gemini' });
  const off = await resumeWith(p, 'off');
  assert.deepEqual(off.body.fallback, { mode: 'off', cleared: [] });
  assert.deepEqual(p.read().run.fallback.accepted, {});
  const r = await p.run();
  assert.equal(r.outcome, 'blocked', JSON.stringify(r.last.actions));
  const f = p.read().run.fallback;
  assert.deepEqual(p.ran(), ['claude']);
  assert.deepEqual([f.mode, f.holds['A.1'].reason, f.holds['A.1'].proposed], ['off', 'quota', null]);
  assert.equal(f.events.some((e) => e.kind === 'step'), false);
});

// ── the setting (IC-005) ─────────────────────────────────────────────────────────────────────────

test('106 IC-005: dispatch.fallback defaults to ask, a project may set off, and auto is a settings validation error', (t) => {
  const fx = createSettingsEnv(t, { prefix: 'doflow-fallback-setting-' });
  const get = () => loadSettings({ projectRoot: fx.project, env: fx.env() });
  const first = get().get('dispatch.fallback', 'project');
  assert.deepEqual([first.state, first.value], ['ok', 'ask']);
  assert.equal(fallbackSetting(fx.project, fx.env()), 'ask');

  fx.writeProjectSettings({ 'dispatch.fallback': 'off' });
  assert.equal(get().get('dispatch.fallback', 'project').value, 'off');
  assert.equal(fallbackSetting(fx.project, fx.env()), 'off');

  fx.writeProjectSettings({ 'dispatch.fallback': 'auto' });
  let view = get();
  assert.notEqual(view.get('dispatch.fallback', 'project').value, 'auto');
  assert.ok(view.errors.some((e) => e.key === 'dispatch.fallback'), JSON.stringify(view.errors));
  fx.remove(fx.projectFile('settings.json'));
  fx.writeUserSettings({ 'dispatch.fallback': 'auto' });
  view = get();
  assert.notEqual(view.get('dispatch.fallback', 'project').value, 'auto');
  assert.ok(view.errors.some((e) => e.key === 'dispatch.fallback'), JSON.stringify(view.errors));
  assert.notEqual(fallbackSetting(fx.project, fx.env()), 'auto');
});

test('106 FR-005: step and run print one fallback line per fallback event, in the IC-004 act-line form', () => {
  const { summaryLines } = require(path.join(SRC, 'dispatch', 'command.ts'));
  const actions = [
    { action: 'admit', reason: 'admitted' },
    { action: 'fallback', reason: 'quota:A.1 claude -> none (rate limit; mode ask; signals unverified)' },
    { action: 'fallback', reason: 'hold:A.1 claude -> gemini (quota; mode ask; signals unverified)' },
  ];
  const stepped = summaryLines({ disposition: 'stepped', dispatchRunId: 'p-000000000000', step: 1, outcome: 'blocked', actions });
  assert.deepEqual(stepped.slice(1), [
    'fallback quota A.1 claude -> none (rate limit; mode ask; signals unverified)',
    'fallback hold A.1 claude -> gemini (quota; mode ask; signals unverified)',
  ]);
  const ran = summaryLines({ disposition: 'ran', dispatchRunId: 'p-000000000000', steps: 2, outcome: 'blocked', fallback: actions.slice(1) });
  assert.equal(ran.length, 3);
  assert.equal(ran[2], 'fallback hold A.1 claude -> gemini (quota; mode ask; signals unverified)');
});
