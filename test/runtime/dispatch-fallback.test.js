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
const { executeDispatchCommand, fallbackSetting } = require(path.join(SRC, 'dispatch', 'command.ts'));
const { loadSettings } = require(path.join(SRC, 'settings', 'resolve.ts'));
const { loadRegistry } = require(path.join(REPO, 'src', 'registry', 'index.ts'));

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
const FRONTIER_PLAN = [
  '# Implementation Plan: frontier fixture', '', '**Task graph:** v1', '', '## 8. Tasks', '', '### Phase A', '',
  '- [ ] A.1 Design the module — owner: system-architect; files: src/retry.js; budget: attempts=2', '',
].join('\n');

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
  const gone = select([cand('claude'), cand('gemini')], { fallback: fb({ ladder: ['gemini'], exhausted: ['gemini'], mode: 'auto' }) });
  assert.deepEqual(gone.hold, { reason: 'ladder-exhausted', from: 'gemini', proposed: null });
  assert.equal(gone.mode, undefined, 'never a mode, never claude');
});

test('106 IC-004: an exhausted harness is never chosen again, for any task and any ladder', () => {
  const all = [cand('claude'), cand('codex'), cand('gemini')];
  for (const owner of ['core-implementer', 'quality-guardian', null, 'not-an-owner']) {
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
  const single = select([cand('codex')], { fallback: fb({ mode: 'auto', exhausted: ['codex'] }) });
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
  assert.deepEqual(select(eligible, { lastFailureClass: 'launch', fallback: fb({ mode: 'auto', exhausted: ['codex'] }) }).mode, 'sequential');
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

test('106 IC-004: a frontier-tier owner holds frontier-no-step in every mode; a registry without dispatchTiers reads standard', () => {
  const all = [cand('claude'), cand('codex')];
  assert.equal(REG.dispatchTiers.byOwner['system-architect'], 'frontier');
  for (const mode of ['off', 'ask', 'auto']) {
    const r = select(all, { owner: 'system-architect', fallback: fb({ mode, exhausted: ['claude'] }) });
    assert.deepEqual(r.hold, { reason: 'frontier-no-step', from: 'claude', proposed: null }, mode);
  }
  const plain = select(all, { owner: 'system-architect', registry: { harnesses: [] }, fallback: fb({ mode: 'auto', exhausted: ['claude'] }) });
  assert.equal(plain.harness, 'codex');
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
async function project(t, { plan = 'budget', mode = 'auto', fallback, scenario = SCENARIO, probe = true } = {}) {
  const sb = makeDispatchSandbox(t, { plan, slug: SLUG, scenario, identity: { DOFLOW_ATTEMPT: undefined } });
  const { root } = sb;
  const env = { ...sb.env };
  const descriptors = structuredClone(sb.descriptors);
  descriptors.gemini.isolatedEdit = structuredClone(descriptors.claude.isolatedEdit);
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
  if (probe) assert.equal((await readiness.probe({ descriptors, env, cwd: root })).disposition, 'probed');
  const read = () => store.readDispatch(file);
  const options = (extra = {}) => ({ slug: SLUG, env, cwd: root, by: 'main', descriptors, ...extra });
  const exec = (extra) => executeDispatchCommand({ slug: SLUG, cwd: root, env, descriptors, ...extra });
  const fallbackActions = () => read().steps.flatMap((s) => s.actions).filter((a) => a.action === 'fallback');
  const ledger = () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const runs = () => (fs.existsSync(sb.log) ? fs.readFileSync(sb.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.argv[0] === '--edit-in-cwd') : []);
  return { sb, root, env, file, read, options, exec, fallbackActions, ledger, runs, run: (extra) => loop.run(options({ maxSeconds: 60, ...extra })) };
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
  assert.deepEqual(resumed.body.fallback, { mode: 'auto', cleared: ['A.1'] });
  const done = await p.run();
  assert.equal(done.outcome, 'completed', JSON.stringify(done.last.blocked || done.last.actions));
  s = p.read();
  assert.deepEqual(byToken(s).map((d) => [d.harness, d.disposition]), [['claude', 'failed'], ['gemini', 'completed']]);
  assert.deepEqual(s.run.fallback.events.map((e) => e.kind), ['quota', 'hold', 'step']);
  assert.deepEqual(s.run.fallback.events[2].mode, 'auto');
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
  assert.deepEqual(auto.body.fallback, { mode: 'auto', cleared: ['A.1'] });
  const f = p.read().run.fallback;
  assert.deepEqual([f.mode, Object.keys(f.holds).sort(), f.exhausted], ['auto', ['A.2', 'A.3'], ['claude']]);
  const inspected = await p.exec({ action: 'inspect' });
  assert.deepEqual(inspected.body.fallback, f, 'inspect shows run.fallback unchanged');

  const old = await project(t, { probe: false });
  const asked = await old.exec({ action: 'resume' });
  const resumed = await old.exec({ action: 'resume', ack: asked.body.digest, by: 'main', fallback: 'ask' });
  assert.deepEqual(resumed.body.fallback, { mode: 'ask', cleared: [] });
  assert.deepEqual(old.read().run.fallback, fb({ mode: 'ask' }));
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
