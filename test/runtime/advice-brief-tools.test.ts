'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { spawnFakeServer, startFakeServer, closedEndpoint } = require('../helper/fake-decision-server.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { CapabilityRouter } = require('../../src/runtime/capability-router.ts');
const { handleBriefToolsCommand, renderBriefTools } = require('../../src/runtime/brief-tools.ts');

const CLI = path.join(REPO_ROOT, 'bin/doflow.js');
const RUN = path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run');
const PLAN = `## 8. Tasks\n- [ ] A.1 [US1] implement feature — owner: core-implementer; tier: frontier; files: src/a.js\n`;

/** The verb's JSON answer without the record's creation time, which differs between two calls. */
function answer(stdout: any) {
  const parsed = JSON.parse(stdout);
  delete parsed.record.createdAt;
  return parsed;
}

function fixture(t: any) {
  const scratch = createScratch('doflow-advice-brief-tools-');
  const project = path.join(scratch.dir, 'project');
  const featureDir = path.join(project, 'agent-docs/doflow/001-feature');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'plan.md'), PLAN);
  // In-process calls see the scratch HOME and config home too, never the developer's ~/.config/doflow.
  scratch.apply();
  t.after(() => { scratch.restore(); scratch.remove(); });
  return {
    scratch, project,
    run(args: any) { return spawnSync(process.execPath, [CLI, 'brief-tools', '--owner', 'core-implementer', '--tier', 'frontier', '--slug', '001-feature', '--json', ...args], { cwd: project, env: scratch.env(), encoding: 'utf8', timeout: 10000 }); },
    enable(endpoint: any) { fs.mkdirSync(path.join(scratch.xdg, 'doflow'), { recursive: true }); fs.writeFileSync(path.join(scratch.xdg, 'doflow/settings.json'), JSON.stringify({ schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': endpoint, 'advice.model': 'clef-flash' })); },
    startServer: () => spawnFakeServer({ dir: scratch.dir }),
  };
}

test('IC-011/012: feature-off and omitted tasks preserve the 062 markdown and record', (t) => {
  const f = fixture(t);
  const before = f.run([]);
  const withoutTasks = f.run(['--tasks', 'A.1']);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(withoutTasks.status, before.status);
  const baseline = answer(before.stdout);
  const omitted = answer(withoutTasks.stdout);
  assert.equal(omitted.markdown, baseline.markdown);
  assert.deepEqual(omitted.record, baseline.record);
  const noTasks = answer(f.run([]).stdout);
  assert.deepEqual(noTasks, baseline);
});

test('IC-011/012: an act answer follows Tier and retains the static tier and record fields', async (t) => {
  const f = fixture(t);
  // act past the bench bar cannot be reached from a spawned verb (the shipped verdicts are empty): stand in for it.
  stubDispatcher(t, { mode: 'act', staticPick: 'standard', advisorPick: 'frontier', effectiveDecision: 'frontier', agreed: false });
  const { baseline, actual } = await invokeCounted(f, { tier: 'standard' });
  const tierParagraph = 'Tier: `standard` (task line), per `references/MODEL_SELECTION.md`.';
  assert.deepEqual(baseline.parts.header.map(([key]: any) => key), ['Tier']);
  assert.deepEqual(actual.parts.header.map(([key]: any) => key), ['Tier', 'Decision model']);
  assert.match(actual.parts.header[1][1], /^`frontier` \(clear\), advisory\. The tier above stands unless you change it\.$/);
  assert.ok(actual.markdown.includes(`${tierParagraph}\nDecision model: `), actual.markdown);
  assert.match(actual.markdown, /Decision model: `frontier` \(clear\), advisory\. The tier above stands unless you change it\./);
  assert.equal(actual.markdown.match(/^Decision model:/gm)?.length, 1);
  assert.equal(actual.record.tier, baseline.record.tier);
  const { advice, ...record } = actual.record;
  assert.deepEqual(record, baseline.record);
  assert.deepEqual(advice, {
    kind: 'tier', status: 'answered', pickId: 'adv-0000000000000-000000',
    pick: 'frontier', strength: 'clear', between: null, agrees: false,
  });
});

test('174 O-1: an unreachable model is a shadow call whose child records the miss; the block is unchanged', async (t) => {
  const f = fixture(t);
  f.enable(await closedEndpoint());
  const baseline = answer(f.run([]).stdout);
  const result = f.run(['--tasks', 'A.1']);
  assert.equal(result.status, 0, result.stderr);
  const actual = answer(result.stdout);
  assert.equal(actual.markdown, baseline.markdown);
  const { advice, ...record } = actual.record;
  assert.deepEqual(record, baseline.record);
  assert.deepEqual(advice, { kind: 'tier', status: 'shadow', reason: null });
  const until = Date.now() + 5000;
  while (Date.now() < until && pickRecords(f).length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(pickRecords(f).map(({ type, mode, reason, caller }: any) => ({ type, mode, reason, caller })),
    [{ type: 'miss', mode: 'shadow', reason: 'unreachable', caller: 'brief-tools' }]);
});

test('IC-011: the dispatcher gets the task lines as state, the tier question and the static tier', async (t) => {
  const f = fixture(t);
  const contexts = stubDispatcher(t, { mode: 'shadow', staticPick: 'frontier', advisorPick: null, effectiveDecision: 'frontier' });
  const { baseline, actual } = await invokeCounted(f, {});
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].state, `core-implementer\n${PLAN.trim().split('\n')[1]}`);
  assert.equal(contexts[0].questionSet.questions[0].name, 'tier');
  assert.equal(contexts[0].kind, 'tier');
  assert.equal(contexts[0].caller, 'brief-tools');
  assert.equal(contexts[0].staticPick, 'frontier');
  assert.equal(actual.markdown, baseline.markdown);
});

test('renderBriefTools remains synchronous (G29)', (t) => {
  const f = fixture(t);
  const router: any = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: f.project });
  const result = renderBriefTools({ registry: loadRegistry({ repoRoot: REPO_ROOT }), router, probes: {}, reach: null, owner: 'core-implementer' });
  assert.equal(typeof result.then, 'undefined');
  assert.equal(typeof result.markdown, 'string');
  assert.equal(typeof result.record, 'object');
});

// ---- 084 H2: advice.kinds.tier routes brief-tools through the dispatcher only when it is set ----

function setKinds(f: any, kinds: any) {
  fs.mkdirSync(path.join(f.project, '.doflow'), { recursive: true });
  fs.writeFileSync(path.join(f.project, '.doflow', 'settings.json'), JSON.stringify({ advice: { kinds } }));
}
/** A passing-looking bench file in the project: the gate never reads it (D3), so it never unlocks act. */
function projectBench(f: any, kind: any) {
  fs.mkdirSync(path.join(f.project, 'bench', 'advice'), { recursive: true });
  fs.writeFileSync(path.join(f.project, 'bench', 'advice', `${kind}.json`), JSON.stringify({
    kind, models: { 'clef-flash': { accuracy: 0.9, staticBaselineAccuracy: 0.5, heldoutCases: 10 } },
  }));
}
function pickRecords(f: any) {
  const file = path.join(f.project, '.doflow', 'state', 'advice', 'picks', `${new Date().toISOString().slice(0, 10)}.jsonl`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line: any) => JSON.parse(line)) : [];
}

/** The pick records once the detached shadow call (row 174 O-2) has written one, or after 5 s. */
async function settledPickRecords(f: any) {
  const until = Date.now() + 5000;
  while (Date.now() < until && pickRecords(f).length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  return pickRecords(f);
}

/** Runs the verb in-process with a counting client; `settings` goes into the project first. */
async function invokeCounted(f: any, { settings, env, tier = 'frontier', reply, injected = true }: any = {}) {
  fs.mkdirSync(path.join(f.project, '.doflow', 'state'), { recursive: true });
  if (settings) fs.writeFileSync(path.join(f.project, '.doflow', 'settings.json'), JSON.stringify(settings));
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const router: any = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: f.project });
  const calls: any = [];
  const answer = reply || { status: 'answered', model: 'clef-flash', answers: [{ name: 'tier', pick: 'light', pickId: 'adv-0000000000000-000000', strength: { word: 'clear', between: null }, agrees: false }] };
  const adviceClient: any = { ask: async (input: any) => { calls.push(input); return answer; } };
  const fixed: any = { registry, router, probes: {}, reach: null, owner: 'core-implementer', tier, stage: { feature: '001-feature' }, slug: '001-feature', probe: () => ({}), now: () => new Date('2026-11-01T00:00:00.000Z'), env: { ...f.scratch.env(), ...(env || {}) } };
  async function invoke(tasks: any) {
    let printed = '';
    const oldLog = console.log;
    const savedExit = process.exitCode;
    console.log = (text) => { printed += `${text}\n`; };
    try {
      await handleBriefToolsCommand({ ...fixed, tasks, json: true, projectRoot: f.project, repoRoot: REPO_ROOT, adviceClient: injected ? adviceClient : null });
    } finally { console.log = oldLog; process.exitCode = savedExit; }
    return JSON.parse(printed);
  }
  const baseline = await invoke(undefined);
  const actual = await invoke(['A.1']);
  // A shadow query is detached: give it a turn before counting.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { baseline, actual, calls };
}

/** Requests the model server got for a decision, after a shadow child (row 174 O-2) had a turn to ask. */
const asksOf = (server: any) => server.requests.filter((r: any) => r.method === 'POST' && r.pathname === '/v1/systemone').length;
async function untilAsks(server: any, n: number) {
  const until = Date.now() + 5000;
  while (Date.now() < until && asksOf(server) < n) await new Promise((resolve) => setTimeout(resolve, 10));
}
async function countingServer(t: any, f: any, { model = 'clef-flash' }: any = {}) {
  const server: any = await startFakeServer();
  t.after(() => server.close());
  fs.mkdirSync(path.join(f.scratch.xdg, 'doflow'), { recursive: true });
  fs.writeFileSync(path.join(f.scratch.xdg, 'doflow/settings.json'), JSON.stringify({ schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': server.origin, 'advice.model': model }));
  return server;
}

test('174 O-1: with advice.kinds.tier unset and a model configured the dispatcher takes a shadow call and shows nothing', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  t.after(() => server.close());
  f.enable(server.origin);
  const baseline = answer(f.run([]).stdout);
  const actual = answer(f.run(['--tasks', 'A.1']).stdout);
  assert.equal(actual.markdown, baseline.markdown);
  assert.doesNotMatch(actual.markdown, /Decision model:/);
  assert.deepEqual(actual.record.advice, { kind: 'tier', status: 'shadow', reason: null });
  assert.deepEqual((await settledPickRecords(f)).map(({ type, mode, caller, static: s, pick, model }: any) => ({ type, mode, caller, static: s, pick, model })),
    [{ type: 'pick', mode: 'shadow', caller: 'brief-tools', static: 'frontier', pick: 'light', model: 'clef-flash' }]);
});

test('174 O-1: with advice.kinds.tier unset and no model configured nothing is asked or recorded', async (t) => {
  const f = fixture(t);
  const server = await countingServer(t, f, { model: null });
  const counted = await invokeCounted(f, { injected: false });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(asksOf(server), 0);
  assert.deepEqual(pickRecords(f), []);
  assert.deepEqual(counted.actual.record, counted.baseline.record);
});

test('084 H2: advice.kinds.tier off adds no advice and records nothing', async (t) => {
  const f = fixture(t);
  const server = await countingServer(t, f);
  setKinds(f, { tier: 'off' });
  const baseline = answer(f.run([]).stdout);
  const actual = answer(f.run(['--tasks', 'A.1']).stdout);
  assert.equal(actual.markdown, baseline.markdown);
  assert.deepEqual(actual.record, baseline.record);
  const counted = await invokeCounted(f, { injected: false });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(asksOf(server), 0, 'off makes no model call');
  assert.deepEqual(pickRecords(f), []);
  assert.deepEqual(counted.actual.record, counted.baseline.record);
});

test('084 H2: advice.kinds.tier shadow leaves the block unchanged and records a shadow pick', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  t.after(() => server.close());
  f.enable(server.origin);
  setKinds(f, { tier: 'shadow' });
  const baseline = answer(f.run([]).stdout);
  const actual = answer(f.run(['--tasks', 'A.1']).stdout);
  assert.equal(actual.markdown, baseline.markdown);
  assert.deepEqual(actual.record.advice, { kind: 'tier', status: 'shadow', reason: null });
  assert.deepEqual((await settledPickRecords(f)).map(({ type, mode, caller, static: s, pick, model }: any) => ({ type, mode, caller, static: s, pick, model })),
    [{ type: 'pick', mode: 'shadow', caller: 'brief-tools', static: 'frontier', pick: 'light', model: 'clef-flash' }]);
});

test('084 H2: advice.kinds.tier act without a passed bench bar falls back to shadow and says why', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  t.after(() => server.close());
  f.enable(server.origin);
  setKinds(f, { tier: 'act' });
  const baseline = answer(f.run([]).stdout);
  const actual = answer(f.run(['--tasks', 'A.1']).stdout);
  assert.equal(actual.markdown, baseline.markdown);
  assert.equal(actual.record.advice.status, 'shadow');
  assert.match(actual.record.advice.reason, /^BENCH_BAR_UNMET: /);
  assert.deepEqual((await settledPickRecords(f)).map(({ type, mode, pick, model }: any) => ({ type, mode, pick, model })),
    [{ type: 'pick', mode: 'shadow', pick: 'light', model: 'clef-flash' }]);
});

test('084 D3: advice.kinds.tier act with a passing bench file in the project still falls back to shadow', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  t.after(() => server.close());
  f.enable(server.origin);
  setKinds(f, { tier: 'act' });
  projectBench(f, 'tier');
  const baseline = answer(f.run([]).stdout);
  const actual = answer(f.run(['--tasks', 'A.1']).stdout);
  assert.equal(actual.markdown, baseline.markdown, 'no pick is shown');
  assert.doesNotMatch(actual.markdown, /Decision model:/);
  assert.equal(actual.record.advice.status, 'shadow');
  assert.match(actual.record.advice.reason, /^BENCH_BAR_UNMET: /);
  assert.deepEqual((await settledPickRecords(f)).map(({ type, mode, pick, model }: any) => ({ type, mode, pick, model })),
    [{ type: 'pick', mode: 'shadow', pick: 'light', model: 'clef-flash' }]);
});

// The settings layers come from the `env` the caller passes, never from this process's environment.
test('084: the passed env decides the user settings layer, not the process environment', async (t) => {
  const f = fixture(t);
  const server = await countingServer(t, f);
  const other = path.join(f.scratch.dir, 'other-xdg');
  fs.mkdirSync(path.join(other, 'doflow'), { recursive: true });
  fs.writeFileSync(path.join(other, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'advice.kinds.tier': 'off', 'advice.enabled': true, 'advice.endpoint': server.origin, 'advice.model': 'clef-flash' }));
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = other;
  t.after(() => { if (saved === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved; });
  const { actual } = await invokeCounted(f, { injected: false });
  assert.deepEqual(actual.record.advice, { kind: 'tier', status: 'shadow', reason: null }, 'advice.kinds.tier is unset in the passed env, so the kind is shadow');
  await untilAsks(server, 1);
  assert.equal(asksOf(server), 1);
  // control: the same file in the passed env's config home is read, and its advice.kinds.tier off asks nothing
  const set = await invokeCounted(f, { env: { XDG_CONFIG_HOME: other }, injected: false });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(asksOf(server), 1, 'the passed config home turns the kind off: no new call');
  assert.equal(set.actual.record.advice, undefined);
});

// 085 H1 with advice.kinds unset: a chosen profile whose advisor is off makes no model call.
const CHOSEN_OFF: any = {
  'settings rollout.profile baseline': { settings: { rollout: { profile: 'baseline' } } },
  'env DOFLOW_ROLLOUT_PROFILE=baseline': { env: { DOFLOW_ROLLOUT_PROFILE: 'baseline' } },
  'an invalid profile value': { settings: { rollout: { profile: 'bogus' } } },
};
for (const [name, c] of Object.entries(CHOSEN_OFF) as any) {
  test(`085 H1: with advice.kinds unset, ${name} makes brief-tools ask nothing`, async (t) => {
    const f = fixture(t);
    const server = await countingServer(t, f);
    const { baseline, actual } = await invokeCounted(f, { ...c, injected: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(asksOf(server), 0, 'a capped-off advisor makes no model call');
    assert.equal(actual.markdown, baseline.markdown);
    assert.deepEqual(actual.record, baseline.record, 'status off adds no advice record');
    assert.deepEqual(pickRecords(f), []);
  });
}

// 084 C-6: with advice.kinds unset a shadow cap (canary, or staged per D2) is the same shadow call.
const CHOSEN_SHADOW: any = {
  'settings rollout.profile canary': { settings: { rollout: { profile: 'canary' } } },
  'env DOFLOW_ROLLOUT_PROFILE=canary': { env: { DOFLOW_ROLLOUT_PROFILE: 'canary' } },
  'settings rollout.profile staged': { settings: { rollout: { profile: 'staged' } } },
};
for (const [name, c] of Object.entries(CHOSEN_SHADOW) as any) {
  test(`084 C-6: with advice.kinds unset, ${name} asks once through the dispatcher and shows no tier pick`, async (t) => {
    const f = fixture(t);
    const server = await countingServer(t, f);
    const { baseline, actual } = await invokeCounted(f, { ...c, injected: false });
    await untilAsks(server, 1);
    assert.equal(asksOf(server), 1);
    assert.equal(actual.markdown, baseline.markdown);
    assert.doesNotMatch(actual.markdown, /Decision model:/);
    assert.deepEqual(actual.record.advice, { kind: 'tier', status: 'shadow', reason: null });
    assert.deepEqual((await settledPickRecords(f)).map(({ type, mode, caller }: any) => ({ type, mode, caller })),
      [{ type: 'pick', mode: 'shadow', caller: 'brief-tools' }]);
  });
}

// 084 C-10: a set kind consumes the dispatcher's mode and effectiveDecision, never advisorPick alone.
function stubDispatcher(t: any, resolution: any) {
  const dispatcher = require('../../src/runtime/advice/shadow-dispatcher.ts');
  const saved = dispatcher.interceptDecisionPoint;
  t.after(() => { dispatcher.interceptDecisionPoint = saved; });
  const contexts: any = [];
  dispatcher.interceptDecisionPoint = async (context: any) => {
    contexts.push(context);
    return {
      kind: 'tier', pickId: 'adv-0000000000000-000000', elevated: false, agreed: null,
      advisorAnswer: { name: 'tier', pick: resolution.advisorPick, strength: { word: 'clear', between: null }, model: 'clef-flash' },
      ...resolution,
    };
  };
  return contexts;
}

test('084 C-10: a shadow result shows no tier pick even when it carries one', async (t) => {
  const f = fixture(t);
  stubDispatcher(t, { mode: 'shadow', staticPick: 'standard', advisorPick: 'frontier', effectiveDecision: 'standard', warning: 'BENCH_BAR_UNMET: x' });
  const { baseline, actual } = await invokeCounted(f, { settings: { advice: { kinds: { tier: 'act' } } }, tier: 'standard' });
  assert.equal(actual.markdown, baseline.markdown);
  assert.deepEqual(actual.record.advice, { kind: 'tier', status: 'shadow', reason: 'BENCH_BAR_UNMET: x' });
});

test('084 C-10: an act result shows the effective decision, not the raw advisor pick', async (t) => {
  const f = fixture(t);
  stubDispatcher(t, { mode: 'act', staticPick: 'standard', advisorPick: 'light', effectiveDecision: 'standard' });
  const { actual } = await invokeCounted(f, { settings: { advice: { kinds: { tier: 'act' } } }, tier: 'standard' });
  assert.equal(actual.record.advice.status, 'answered');
  assert.equal(actual.record.advice.pick, 'standard');
  assert.equal(actual.record.advice.agrees, true);
});
