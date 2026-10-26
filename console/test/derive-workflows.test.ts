'use strict';

// The Workflows view's derivations (feature 093, plan task F.2; design.md section 7 V6). Pure functions over the
// `GET /api/workflows` body: no DOM and no fetch. Control: dropping the gates from stepsOf turns the order case red
// (the control rewrites a copy of derive/workflows.js and re-runs the same case).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const SOURCE_FILE = path.join(WEB_ROOT, 'derive', 'workflows.js');

let scratch: string[] = [];
let flows: any;

/** A copy of derive/workflows.js (optionally rewritten) as an ES module a CommonJS package can import. */
async function load(source: string = fs.readFileSync(SOURCE_FILE, 'utf8')): Promise<any> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-workflows-'));
  scratch.push(dir);
  fs.cpSync(path.join(WEB_ROOT, 'derive'), path.join(dir, 'derive'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(dir, 'derive', 'workflows.js'), source);
  return import(pathToFileURL(path.join(dir, 'derive', 'workflows.js')).href);
}

before(async () => { flows = await load(); });
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

const gate = (id: string, kind: string) => ({ id, name: `Name of ${id}`, kind, trigger: 't', prompt: 'p' });
const stage = (id: string, gatesAfter: any[] = [], optional = false) => ({ id, kind: id, optional, skill: `do-${id}`, agent: 'a', purpose: `Purpose of ${id}.`, gatesAfter });
const WF = { taskClass: 'feature', name: 'Feature Delivery', stages: [stage('discovery', [gate('gate-0', 'clarification')]), stage('design', [], true), stage('planning', [gate('gate-a', 'approval')])] };

const orderCase = (mod: any) => {
  const steps = mod.stepsOf(WF);
  assert.deepEqual(steps.map((s: any) => [s.type, s.id]), [['stage', 'discovery'], ['gate', 'gate-0'], ['stage', 'design'], ['stage', 'planning'], ['gate', 'gate-a']]);
  assert.deepEqual(steps.map((s: any) => s.n), [1, 2, 3, 4, 5]);
};

test('stepsOf: each stage then its gates after it, numbered from 1; optional stages and the gate kind are carried', () => {
  orderCase(flows);
  const steps = flows.stepsOf(WF);
  assert.equal(steps[2].optional, true);
  assert.equal(steps[0].optional, false);
  assert.equal(steps[1].kind, 'clarification');
  assert.equal(steps[4].kind, 'approval');
  assert.equal(steps[0].detail, 'do-discovery: Purpose of discovery.');
  assert.equal(steps[1].label, 'Name of gate-0');
});

test('control: a stepsOf that drops the gates turns the order case red', async () => {
  const source = fs.readFileSync(SOURCE_FILE, 'utf8');
  const broken = source.replace('Array.isArray(stage.gatesAfter) ? stage.gatesAfter : []', '[]');
  assert.notEqual(broken, source, 'the control found the gate source to remove');
  const mod = await load(broken);
  assert.throws(() => orderCase(mod));
});

test('stepsOf: a body without stages gives no steps, and a stage without a gates array is just the stage', () => {
  assert.deepEqual(flows.stepsOf(null), []);
  assert.deepEqual(flows.stepsOf({ taskClass: 'x' }), []);
  assert.deepEqual(flows.stepsOf({ stages: [{ id: 'a' }] }).map((s: any) => s.id), ['a']);
});

test('altText: a non-empty sentence that names the workflow and every step in order, with the kind of each gate', () => {
  const alt = flows.altText(WF);
  assert.match(alt, /^Feature Delivery workflow diagram\./);
  assert.ok(alt.indexOf('discovery') < alt.indexOf('clarification gate Name of gate-0'));
  assert.ok(alt.indexOf('clarification gate') < alt.indexOf('design (optional)'));
  assert.ok(alt.indexOf('design') < alt.indexOf('planning'));
  assert.ok(alt.indexOf('planning') < alt.indexOf('approval gate Name of gate-a'));
  assert.ok(flows.altText({ taskClass: 'bare' }).length > 0, 'a body with nothing still has an alternative');
});

test('diagramPath: only a lower-case class id becomes a same-origin path', () => {
  assert.equal(flows.diagramPath('feature'), '/diagrams/feature.svg');
  assert.equal(flows.diagramPath('dependency-change'), '/diagrams/dependency-change.svg');
  for (const bad of ['../x', 'a/b', 'A', '-a', 'a b', 'a.svg', '', null, 7, undefined]) assert.equal(flows.diagramPath(bad), null, String(bad));
});

test('workflowsOf: keeps the entries with a string class and a stages array, in the route order', () => {
  const body = { v: 1, workflows: [WF, null, { taskClass: 7, stages: [] }, { taskClass: 'x' }, { taskClass: 'documentation', name: 'Docs', stages: [] }] };
  assert.deepEqual(flows.workflowsOf(body).map((w: any) => w.taskClass), ['feature', 'documentation']);
  assert.deepEqual(flows.workflowsOf(null), []);
  assert.deepEqual(flows.workflowsOf({ workflows: 'no' }), []);
});
