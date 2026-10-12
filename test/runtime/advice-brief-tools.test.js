'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { spawnFakeServer } = require('../helper/fake-decision-server');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { CapabilityRouter } = require('../../src/runtime/capability-router');
const { handleBriefToolsCommand, renderBriefTools } = require('../../src/runtime/brief-tools');

const CLI = path.join(REPO_ROOT, 'bin/doflow.js');
const RUN = path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run');
const PLAN = `## 8. Tasks\n- [ ] A.1 [US1] implement feature — owner: core-implementer; tier: frontier; files: src/a.js\n`;

function fixture(t) {
  const scratch = createScratch('doflow-advice-brief-tools-');
  const project = path.join(scratch.dir, 'project');
  const featureDir = path.join(project, 'agent-docs/doflow/001-feature');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'plan.md'), PLAN);
  t.after(() => scratch.remove());
  return {
    scratch, project,
    run(args) { return spawnSync(process.execPath, [CLI, 'brief-tools', '--owner', 'core-implementer', '--tier', 'frontier', '--slug', '001-feature', '--json', ...args], { cwd: project, env: scratch.env(), encoding: 'utf8', timeout: 10000 }); },
    enable(endpoint) { fs.mkdirSync(path.join(scratch.xdg, 'doflow'), { recursive: true }); fs.writeFileSync(path.join(scratch.xdg, 'doflow/decision-model.json'), JSON.stringify({ schema: 1, enabled: true, provider: 'ollama', endpoint, model: 'clef-flash' })); },
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
  const baseline = JSON.parse(f.run([]).stdout);
  const result = f.run(['--tasks', 'A.1']);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  const tierParagraph = 'Tier: `frontier` (task line), per\n`references/MODEL_SELECTION.md`.';
  assert.ok(actual.markdown.includes(`${tierParagraph}\nDecision model: `));
  assert.match(actual.markdown, /Decision model: `light` \(clear\), advisory\. The tier above stands unless you change it\./);
  assert.equal(actual.markdown.match(/^Decision model:/gm)?.length, 1);
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
  const router = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: f.project });
  f.enable('http://127.0.0.1:9');
  const fixed = { registry, router, probes: {}, reach: null, owner: 'core-implementer', tier: 'frontier', stage: { feature: '001-feature' }, slug: '001-feature', probe: () => ({}) };
  let request;
  const adviceClient = { ask: (input) => { request = input; return new Promise((resolve) => setTimeout(() => resolve({ status: 'unavailable', reason: 'timeout', answers: [] }), 25)); } };
  async function invoke(tasks) {
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
  const router = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: f.project });
  const result = renderBriefTools({ registry: loadRegistry({ repoRoot: REPO_ROOT }), router, probes: {}, reach: null, owner: 'core-implementer' });
  assert.equal(typeof result.then, 'undefined');
  assert.equal(typeof result.markdown, 'string');
  assert.equal(typeof result.record, 'object');
});
