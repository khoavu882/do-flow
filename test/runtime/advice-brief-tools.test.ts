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
  t.after(() => scratch.remove());
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
function passBench(f: any, kind: any) {
  fs.mkdirSync(path.join(f.project, 'bench', 'advice'), { recursive: true });
  fs.writeFileSync(path.join(f.project, 'bench', 'advice', `${kind}.json`), JSON.stringify({
    kind, models: { 'clef-flash': { accuracy: 0.9, staticBaselineAccuracy: 0.5, heldoutCases: 10 } },
  }));
}
function pickRecords(f: any) {
  const file = path.join(f.project, '.doflow', 'state', 'advice', 'picks', `${new Date().toISOString().slice(0, 10)}.jsonl`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line: any) => JSON.parse(line)) : [];
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
  assert.equal(actual.record.advice.status, 'unavailable');
  assert.deepEqual(pickRecords(f).map(({ type, mode, caller, static: s, pick }: any) => ({ type, mode, caller, static: s, pick })),
    [{ type: 'pick', mode: 'shadow', caller: 'brief-tools', static: 'frontier', pick: 'light' }]);
});

test('084 H2: advice.kinds.tier act answers through the dispatcher with the pickId it recorded', async (t) => {
  const f = fixture(t);
  const server = await f.startServer();
  t.after(() => server.close());
  f.enable(server.origin);
  setKinds(f, { tier: 'act' });
  passBench(f, 'tier');
  const actual = JSON.parse(f.run(['--tasks', 'A.1']).stdout);
  assert.deepEqual(actual.record.advice, {
    kind: 'tier', status: 'answered', pickId: actual.record.advice.pickId,
    pick: 'light', strength: 'clear', between: null, agrees: false,
  });
  assert.match(actual.markdown, /Decision model: `light` \(clear\), advisory\./);
  const picks = pickRecords(f).filter((record: any) => record.type === 'pick');
  assert.equal(picks.length, 1);
  assert.equal(picks[0].pickId, actual.record.advice.pickId);
  assert.equal(picks[0].mode, 'act');
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
