'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { spawnFakeServer } = require('../helper/fake-decision-server.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { CapabilityRouter } = require('../../src/runtime/capability-router.ts');
const { handleBriefToolsCommand, renderBriefTools } = require('../../src/runtime/brief-tools.ts');

const CLI = path.join(REPO_ROOT, 'bin/doflow.js');
const RUN = path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run');
const PLAN = `## 8. Tasks\n- [ ] A.1 [US1] implement feature — owner: core-implementer; tier: frontier; files: src/a.js\n`;

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
    enable(endpoint: any) { fs.mkdirSync(path.join(scratch.xdg, 'doflow'), { recursive: true }); fs.writeFileSync(path.join(scratch.xdg, 'doflow/decision-model.json'), JSON.stringify({ schema: 1, enabled: true, provider: 'ollama', endpoint, model: 'clef-flash' })); },
    startServer: () => spawnFakeServer({ dir: scratch.dir }),
  };
}

test('IC-011/012: feature-off and omitted tasks preserve the 062 markdown and record', (t) => {
  const f = fixture(t);
  const before = f.run([]);
  const withoutTasks = f.run(['--tasks', 'A.1']);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(withoutTasks.status, before.status);
  const baseline = JSON.parse(before.stdout);
  const omitted = JSON.parse(withoutTasks.stdout);
  assert.equal(omitted.markdown, baseline.markdown);
  assert.deepEqual(omitted.record, baseline.record);
  const noTasks = JSON.parse(f.run([]).stdout);
  assert.deepEqual(noTasks, baseline);
});

test('IC-011/012: answered tier advice follows Tier and retains the static tier and record fields', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  t.after(() => server.close());
  f.enable(server.origin);
  const baseline = JSON.parse(f.run(['--harness', 'claude']).stdout);
  const result = f.run(['--harness', 'claude', '--tasks', 'A.1']);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  const tierParagraph = 'Tier: `frontier` (task line), per\n`references/MODEL_SELECTION.md`.';
  const modelLine = `Model: harness default on \`${actual.record.model.harness}\`.`;
  assert.ok(actual.markdown.includes(`${tierParagraph}\n${modelLine}\nDecision model: `));
  assert.match(actual.markdown, /Decision model: `light` \(clear\), advisory\. The tier above stands unless you change it\./);
  assert.equal(actual.markdown.match(/^Decision model:/gm)?.length, 1);
  assert.equal(actual.markdown.match(/^Model:/gm)?.length, 1);
  assert.equal(actual.record.tier, baseline.record.tier);
  for (const [key, value] of Object.entries(baseline.record)) assert.deepEqual(actual.record[key], value, key);
  assert.deepEqual(actual.record.advice, {
    kind: 'tier', status: 'answered', pickId: actual.record.advice.pickId,
    pick: 'light', strength: 'clear', between: null, agrees: false,
  });
  assert.match(actual.record.advice.pickId, /^adv-[0-9]{13}-[0-9a-f]{6}$/);
});

test('IC-011/012: unavailable advice leaves markdown unchanged and records reason without pickId', (t) => {
  const f = fixture(t);
  f.enable('http://127.0.0.1:9');
  const baseline = JSON.parse(f.run([]).stdout);
  const result = f.run(['--tasks', 'A.1']);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.markdown, baseline.markdown);
  const { advice, ...record } = actual.record;
  assert.deepEqual(record, baseline.record);
  assert.equal(advice.kind, 'tier');
  assert.equal(advice.status, 'unavailable');
  assert.equal(advice.reason, 'unreachable');
  assert.equal(Object.hasOwn(advice, 'pickId'), false);
});

test('IC-011: advice timeout fails open without changing the 062 block', async (t) => {
  const f = fixture(t);
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const router: any = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: f.project });
  f.enable('http://127.0.0.1:9');
  const fixed: any = { registry, router, probes: {}, reach: null, owner: 'core-implementer', tier: 'frontier', stage: { feature: '001-feature' }, slug: '001-feature', probe: () => ({}), env: f.scratch.env() };
  let request: any;
  const adviceClient: any = { ask: (input: any) => { request = input; return new Promise((resolve) => setTimeout(() => resolve({ status: 'unavailable', reason: 'timeout', answers: [] }), 25)); } };
  async function invoke(tasks: any) {
    let printed = '';
    const oldLog = console.log;
    console.log = (text) => { printed += `${text}\n`; };
    try {
      await handleBriefToolsCommand({ ...fixed, tasks, json: true, projectRoot: f.project, repoRoot: REPO_ROOT, adviceClient });
    } finally { console.log = oldLog; }
    return JSON.parse(printed);
  }
  const baseline = await invoke(undefined);
  const started = Date.now();
  const actual = await invoke(['A.1']);
  assert.ok(Date.now() - started >= 20, 'the handler waits for the injected bounded timeout result');
  assert.equal(request.questionSet.state, `core-implementer\n${PLAN.trim().split('\n')[1]}`);
  assert.equal(request.questionSet.questions[0].name, 'tier');
  assert.equal(request.kind, 'tier');
  assert.equal(request.staticAnswer, 'frontier');
  assert.equal(actual.markdown, baseline.markdown);
  assert.equal(actual.record.advice.reason, 'timeout');
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

/** Runs the verb in-process with a counting client; `settings` and `sentinel` go into the project first. */
async function invokeCounted(f: any, { settings, sentinel, env, tier = 'frontier', reply }: any = {}) {
  fs.mkdirSync(path.join(f.project, '.doflow', 'state'), { recursive: true });
  if (settings) fs.writeFileSync(path.join(f.project, '.doflow', 'settings.json'), JSON.stringify(settings));
  if (sentinel) fs.writeFileSync(path.join(f.project, '.doflow', 'state', 'rollback.json'), JSON.stringify(sentinel));
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const router: any = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: f.project });
  const calls: any = [];
  const answer = reply || { status: 'answered', model: 'clef-flash', answers: [{ name: 'tier', pick: 'light', pickId: 'adv-0000000000000-000000', strength: { word: 'clear', between: null }, agrees: false }] };
  const adviceClient: any = { ask: async (input: any) => { calls.push(input); return answer; } };
  const fixed: any = { registry, router, probes: {}, reach: null, owner: 'core-implementer', tier, stage: { feature: '001-feature' }, slug: '001-feature', probe: () => ({}), env: { ...f.scratch.env(), ...(env || {}) } };
  async function invoke(tasks: any) {
    let printed = '';
    const oldLog = console.log;
    const savedExit = process.exitCode;
    console.log = (text) => { printed += `${text}\n`; };
    try {
      await handleBriefToolsCommand({ ...fixed, tasks, json: true, projectRoot: f.project, repoRoot: REPO_ROOT, adviceClient });
    } finally { console.log = oldLog; process.exitCode = savedExit; }
    return JSON.parse(printed);
  }
  const baseline = await invoke(undefined);
  const actual = await invoke(['A.1']);
  // A shadow query is detached: give it a turn before counting.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { baseline, actual, calls };
}

test('084 H2: with advice.kinds.tier unset the client records the tier pick, as before the dispatcher', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  t.after(() => server.close());
  f.enable(server.origin);
  const actual = JSON.parse(f.run(['--tasks', 'A.1']).stdout);
  assert.equal(actual.record.advice.status, 'answered');
  const pick = pickRecords(f).find((record: any) => record.type === 'pick' && record.pickId === actual.record.advice.pickId);
  assert.equal(pick.question, 'tier', 'the client pick record, not the dispatcher one');
  assert.equal(Object.hasOwn(pick, 'mode'), false);
});

test('084 H2: advice.kinds.tier off adds no advice and records nothing', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  t.after(() => server.close());
  f.enable(server.origin);
  setKinds(f, { tier: 'off' });
  const baseline = JSON.parse(f.run([]).stdout);
  const actual = JSON.parse(f.run(['--tasks', 'A.1']).stdout);
  assert.equal(actual.markdown, baseline.markdown);
  assert.deepEqual(actual.record, baseline.record);
  assert.deepEqual(pickRecords(f), []);
  const counted = await invokeCounted(f);
  assert.equal(counted.calls.length, 0, 'off makes no model call');
  assert.deepEqual(counted.actual.record, counted.baseline.record);
});

test('084 H2: advice.kinds.tier shadow leaves the block unchanged and records a shadow pick', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  t.after(() => server.close());
  f.enable(server.origin);
  setKinds(f, { tier: 'shadow' });
  const baseline = JSON.parse(f.run([]).stdout);
  const actual = JSON.parse(f.run(['--tasks', 'A.1']).stdout);
  assert.equal(actual.markdown, baseline.markdown);
  assert.deepEqual(actual.record.advice, { kind: 'tier', status: 'shadow', reason: null });
  assert.deepEqual(pickRecords(f).map(({ type, mode, caller, static: s, pick, model }: any) => ({ type, mode, caller, static: s, pick, model })),
    [{ type: 'pick', mode: 'shadow', caller: 'brief-tools', static: 'frontier', pick: 'light', model: 'clef-flash' }]);
});

test('084 H2: advice.kinds.tier act without a passed bench bar falls back to shadow and says why', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  t.after(() => server.close());
  f.enable(server.origin);
  setKinds(f, { tier: 'act' });
  const baseline = JSON.parse(f.run([]).stdout);
  const actual = JSON.parse(f.run(['--tasks', 'A.1']).stdout);
  assert.equal(actual.markdown, baseline.markdown);
  assert.equal(actual.record.advice.status, 'shadow');
  assert.match(actual.record.advice.reason, /^BENCH_BAR_UNMET: /);
  assert.deepEqual(pickRecords(f).map(({ type, mode, pick, model }: any) => ({ type, mode, pick, model })),
    [{ type: 'pick', mode: 'shadow', pick: 'light', model: 'clef-flash' }]);
});

test('084 D3: advice.kinds.tier act with a passing bench file in the project still falls back to shadow', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  t.after(() => server.close());
  f.enable(server.origin);
  setKinds(f, { tier: 'act' });
  projectBench(f, 'tier');
  const baseline = JSON.parse(f.run([]).stdout);
  const actual = JSON.parse(f.run(['--tasks', 'A.1']).stdout);
  assert.equal(actual.markdown, baseline.markdown, 'no pick is shown');
  assert.doesNotMatch(actual.markdown, /Decision model:/);
  assert.equal(actual.record.advice.status, 'shadow');
  assert.match(actual.record.advice.reason, /^BENCH_BAR_UNMET: /);
  assert.deepEqual(pickRecords(f).map(({ type, mode, pick, model }: any) => ({ type, mode, pick, model })),
    [{ type: 'pick', mode: 'shadow', pick: 'light', model: 'clef-flash' }]);
});

// The settings layers come from the `env` the caller passes, never from this process's environment.
test('084: the passed env decides the user settings layer, not the process environment', async (t) => {
  const f = fixture(t);
  const other = path.join(f.scratch.dir, 'other-xdg');
  fs.mkdirSync(path.join(other, 'doflow'), { recursive: true });
  fs.writeFileSync(path.join(other, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'advice.kinds.tier': 'act', 'advice.enabled': false }));
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = other;
  t.after(() => { if (saved === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved; });
  const { actual, calls } = await invokeCounted(f, {});
  assert.equal(calls.length, 1, 'advice.kinds.tier is unset in the passed env, so the client is asked as on the legacy path');
  assert.equal(calls[0].record, undefined, 'the client records, as on the legacy path');
  assert.equal(actual.record.advice.status, 'answered');
  // control: the same file in the passed env's config home is read, and its advice.enabled false asks nothing
  const set = await invokeCounted(f, { env: { XDG_CONFIG_HOME: other } });
  assert.equal(set.calls.length, 0, 'the passed config home turns advice off');
  assert.notEqual(set.actual.record.advice?.status, 'answered');
});

// 085 H1 on the unset-kinds path: a chosen profile whose advisor is off skips the client call.
const CHOSEN_OFF: any = {
  'settings rollout.profile baseline': { settings: { rollout: { profile: 'baseline' } } },
  'env DOFLOW_ROLLOUT_PROFILE=baseline': { env: { DOFLOW_ROLLOUT_PROFILE: 'baseline' } },
  'an active rollback sentinel': { sentinel: { active: true, reason: 'manual' } },
  'an invalid profile value': { settings: { rollout: { profile: 'bogus' } } },
};
for (const [name, c] of Object.entries(CHOSEN_OFF) as any) {
  test(`085 H1: with advice.kinds unset, ${name} makes brief-tools ask nothing`, async (t) => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.project, '.doflow', 'state'), { recursive: true });
    if (c.settings) fs.writeFileSync(path.join(f.project, '.doflow', 'settings.json'), JSON.stringify(c.settings));
    if (c.sentinel) fs.writeFileSync(path.join(f.project, '.doflow', 'state', 'rollback.json'), JSON.stringify(c.sentinel));
    const registry = loadRegistry({ repoRoot: REPO_ROOT });
    const router: any = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: f.project });
    let calls = 0;
    const adviceClient: any = { ask: async () => { calls += 1; return { status: 'answered', answers: [{ pick: 'light', pickId: null }] }; } };
    const fixed: any = { registry, router, probes: {}, reach: null, owner: 'core-implementer', tier: 'frontier', stage: { feature: '001-feature' }, slug: '001-feature', probe: () => ({}), env: { ...f.scratch.env(), ...(c.env || {}) } };
    async function invoke(tasks: any) {
      let printed = '';
      const oldLog = console.log;
      console.log = (text) => { printed += `${text}\n`; };
      try {
        await handleBriefToolsCommand({ ...fixed, tasks, json: true, projectRoot: f.project, repoRoot: REPO_ROOT, adviceClient });
      } finally { console.log = oldLog; }
      return JSON.parse(printed);
    }
    const baseline = await invoke(undefined);
    const actual = await invoke(['A.1']);
    assert.equal(calls, 0);
    assert.equal(actual.markdown, baseline.markdown);
    assert.deepEqual(actual.record, baseline.record, 'status off adds no advice record');
  });
}

// 084 C-6: on the unset-kinds path a shadow cap (canary, or staged per D2) records the opinion and shows none.
const CHOSEN_SHADOW: any = {
  'settings rollout.profile canary': { settings: { rollout: { profile: 'canary' } } },
  'env DOFLOW_ROLLOUT_PROFILE=canary': { env: { DOFLOW_ROLLOUT_PROFILE: 'canary' } },
  'settings rollout.profile staged': { settings: { rollout: { profile: 'staged' } } },
};
for (const [name, c] of Object.entries(CHOSEN_SHADOW) as any) {
  test(`084 C-6: with advice.kinds unset, ${name} asks once, as the legacy path, and shows no tier pick`, async (t) => {
    const f = fixture(t);
    const { baseline, actual, calls } = await invokeCounted(f, c);
    assert.equal(calls.length, 1, 'the same single call the legacy path makes');
    assert.equal(calls[0].kind, 'tier');
    assert.equal(calls[0].caller, 'brief-tools');
    assert.equal(calls[0].staticAnswer, 'frontier');
    assert.equal(calls[0].record, undefined, 'the client records, as on the legacy path');
    assert.equal(actual.markdown, baseline.markdown);
    assert.doesNotMatch(actual.markdown, /Decision model:/);
    assert.deepEqual(actual.record.advice, { kind: 'tier', status: 'shadow', reason: null });
  });
}

test('084 C-6: under a canary profile the CLI records the client pick and shows none', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  t.after(() => server.close());
  f.enable(server.origin);
  fs.mkdirSync(path.join(f.project, '.doflow'), { recursive: true });
  fs.writeFileSync(path.join(f.project, '.doflow', 'settings.json'), JSON.stringify({ rollout: { profile: 'canary' } }));
  const baseline = JSON.parse(f.run([]).stdout);
  const actual = JSON.parse(f.run(['--tasks', 'A.1']).stdout);
  assert.equal(actual.markdown, baseline.markdown);
  assert.deepEqual(actual.record.advice, { kind: 'tier', status: 'shadow', reason: null });
  assert.deepEqual(pickRecords(f).map(({ type, question, pick, static: s, model }: any) => ({ type, question, pick, static: s, model })),
    [{ type: 'pick', question: 'tier', pick: 'light', static: 'frontier', model: 'clef-flash' }]);
});

// 084 C-10: a set kind consumes the dispatcher's mode and effectiveDecision, never advisorPick alone.
function stubDispatcher(t: any, resolution: any) {
  const dispatcher = require('../../src/runtime/advice/shadow-dispatcher.ts');
  const saved = dispatcher.interceptDecisionPoint;
  t.after(() => { dispatcher.interceptDecisionPoint = saved; });
  dispatcher.interceptDecisionPoint = async () => ({
    kind: 'tier', pickId: 'adv-0000000000000-000000', elevated: false, agreed: null,
    advisorAnswer: { name: 'tier', pick: resolution.advisorPick, strength: { word: 'clear', between: null }, model: 'clef-flash' },
    ...resolution,
  });
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
