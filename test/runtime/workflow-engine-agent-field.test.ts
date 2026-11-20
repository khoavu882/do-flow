'use strict';

// 118 IC-001: every workflow stage names the agent that leads its dispatched work. The validator
// requires it as a lowercase-kebab string; it does not read the agent-spec directory (existence
// is guard G63's job), so these tests only exercise the registry shape.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { WorkflowEngine } = require('../../src/runtime/workflow-engine.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '../..');
const PATTERN = /^[a-z][a-z0-9-]*$/;
const KEBAB: any = { test: (v: any) => typeof v === 'string' && PATTERN.test(v) };
const shipped = () => JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'workflows.json'), 'utf8'));

test('the shipped registry validates with zero problems and every stage carries a kebab `agent`', () => {
  const doc = shipped();
  assert.deepEqual(WorkflowEngine.validateRegistry(doc), []);
  for (const [classId, def] of Object.entries(doc.classes)) {
    for (const stage of def.stages) {
      assert.ok(KEBAB.test(stage.agent), `${classId}/${stage.id} must carry a kebab-case agent`);
    }
  }
});

test('a stage without `agent` is refused', () => {
  const doc = shipped();
  delete doc.classes.feature.stages[0].agent;
  assert.deepEqual(WorkflowEngine.validateRegistry(doc), ["class 'feature' stage #1 must declare a non-empty `agent`"]);
});

test('a stage whose `agent` is not lowercase kebab-case is refused', () => {
  const doc = shipped();
  doc.classes.bug.stages[2].agent = 'Agent_X';
  assert.deepEqual(WorkflowEngine.validateRegistry(doc), ["class 'bug' stage #3 `agent` must be a lowercase kebab-case agent name"]);
});

test('`resolveWorkflow` output is otherwise unchanged by the field (negative control)', () => {
  const withField: any = new WorkflowEngine({ repoRoot: REPO });
  const doc = shipped();
  for (const def of Object.values(doc.classes)) for (const stage of def.stages) stage.agent = 'other-agent';
  const swapped: any = new WorkflowEngine({ workflows: doc });
  for (const taskClass of Object.keys(doc.classes)) {
    const a = withField.resolveWorkflow(taskClass);
    assert.ok(a.stages.every((s: any) => KEBAB.test(s.agent)), `${taskClass}: every resolved stage carries agent`);
    const b = swapped.resolveWorkflow(taskClass);
    // Resolved workflows are frozen and repeat stages (terminalStage, ...), so compare JSON copies
    // with every `agent` key dropped.
    const bare = (w: any) => JSON.parse(JSON.stringify(w, (key, value) => (key === 'agent' ? undefined : value)));
    assert.deepEqual(bare(a), bare(b), taskClass);
  }
});

test('`classify --task-class feature` stages carry `agent`', (t) => {
  const home = tempDir(t, 'doflow-agent-field-');
  const run = spawnSync(process.execPath, [path.join(REPO, 'bin', 'doflow.js'), 'classify', '--task-class', 'feature', '--calling-skill', 'do', '--json'], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), FORCE_COLOR: '' },
  });
  assert.equal(run.status, 0, run.stderr);
  const json = JSON.parse(run.stdout);
  assert.ok(json.workflow.stages.length > 0);
  for (const stage of json.workflow.stages) assert.ok(KEBAB.test(stage.agent), stage.id);
});
