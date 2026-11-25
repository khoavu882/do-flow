'use strict';

// 181 D.2 (IC-006): compileRunEvidence answers what ran on a head commit from the latest verify run
// record and the evidence ledger's flow:<id> items, and writes nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
const { compileRunEvidence } = require('../../src/runtime/run-evidence.ts');

const TASK = 'T-1';
const HEAD = 'c'.repeat(40);
const OLD = 'd'.repeat(40);
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

function project(t: any, flows: any[] | null = [
  { id: 'login', title: 'A user logs in', expect: 'the dashboard shows', critical: true },
  { id: 'logout', title: 'A user logs out', expect: 'the login page shows' },
  { id: 'reset', title: 'A user resets a password', expect: 'a mail is sent' },
  { id: 'export', title: 'A user exports', expect: 'a file is written' },
]) {
  const root = tempDir(t, 'doflow-run-evidence-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  if (flows) write(path.join(root, '.doflow', 'feature-map.json'), JSON.stringify({ version: 1, flows }));
  return root;
}

function record(root: string, over: any = {}) {
  const line = { schema: 2, taskId: TASK, head: HEAD, clean: true, verdict: 'PASS', risk: 'LOW',
    checks: [{ tier: 'build', role: 'build', command: 'npm run build', status: 'PASS', exitCode: 0, log: null }],
    at: '2026-11-25T10:00:00.000Z', reportSha256: 'sha256:x', ...over };
  const file = path.join(root, '.doflow', 'state', 'verification', 'runs', `${TASK}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
}

function flowItem(root: string, id: string, over: any = {}) {
  const ledger = new EvidenceLedger({ repoRoot: root, slug: TASK });
  ledger.load(TASK);
  ledger.addEvidence({
    taskId: TASK, kind: 'runtime-observation', provenance: 'extracted',
    source: { provider: 'doflow', capability: 'feature-map' }, locator: { path: `.doflow/state/verification/logs/${id}.log` },
    content: `${id} ran`, establishes: [`flow:${id}`], observation: { command: `node ${id}.js`, exitCode: 0 },
    freshness: { gitCommit: HEAD, observedAt: '2026-11-25T10:01:00.000Z' }, ...over,
  });
  ledger.save(TASK);
}

const compile = (root: string, head = HEAD) => compileRunEvidence({ root, taskId: TASK, head, featureDir: null });
const byId = (what: any, id: string) => what.flows.find((f: any) => f.id === id);

test('each flow takes the status of its newest evidence item on the head', (t) => {
  const root = project(t);
  flowItem(root, 'login');
  flowItem(root, 'logout', { observation: { command: 'node logout.js', exitCode: 2 } });
  flowItem(root, 'reset', { provenance: 'asserted', content: 'unreached: agent-browser not found', observation: undefined, locator: undefined });
  const what = compile(root);

  assert.equal(what.featureMap, 'present');
  assert.deepEqual(what.flows.map((f: any) => [f.id, f.status]), [['login', 'passed'], ['logout', 'failed'], ['reset', 'unreached'], ['export', 'not-run']]);
  const login = byId(what, 'login');
  assert.deepEqual([login.title, login.critical, login.action, login.observed, login.locator, login.commit, login.reason],
    ['A user logs in', true, 'node login.js', 'login ran', '.doflow/state/verification/logs/login.log', HEAD, null]);
  assert.equal(byId(what, 'reset').reason, 'agent-browser not found');
  assert.equal(byId(what, 'export').commit, null);
  assert.equal(byId(what, 'logout').critical, false);
});

test('an item on another head or an unclassifiable item leaves the flow not run', (t) => {
  const root = project(t);
  flowItem(root, 'login', { freshness: { gitCommit: OLD, observedAt: '2026-11-25T09:00:00.000Z' } });
  flowItem(root, 'logout', { observation: { command: 'node logout.js', exitCode: null } });
  flowItem(root, 'reset', { provenance: 'asserted', content: 'it works' });
  const what = compile(root);
  assert.deepEqual(what.flows.map((f: any) => f.status), ['not-run', 'not-run', 'not-run', 'not-run']);
  assert.equal(compile(root, OLD).flows[0].status, 'passed', 'the same item is evidence for the head it ran on');
});

test('the newest item on the head wins, whatever order the ledger holds them', (t) => {
  const root = project(t);
  flowItem(root, 'login', { observation: { command: 'node login.js', exitCode: 1 }, freshness: { gitCommit: HEAD, observedAt: '2026-11-25T10:05:00.000Z' } });
  flowItem(root, 'login', { freshness: { gitCommit: HEAD, observedAt: '2026-11-25T10:01:00.000Z' } });
  assert.equal(byId(compile(root), 'login').status, 'failed');
});

test('the latest verify record shows its checks only when it ran on the head from a clean tree', (t) => {
  const root = project(t);
  record(root, { head: OLD });
  let what = compile(root);
  assert.equal(what.verify.onHead, false);
  assert.deepEqual(what.verify.checks, [], 'a run on an older head is not evidence for this head');

  record(root, { clean: false });
  what = compile(root);
  assert.deepEqual([what.verify.onHead, what.verify.clean, what.verify.checks], [true, false, []]);

  record(root);
  what = compile(root);
  assert.deepEqual([what.verify.at, what.verify.verdict, what.verify.onHead, what.verify.clean], ['2026-11-25T10:00:00.000Z', 'PASS', true, true]);
  assert.deepEqual(what.verify.checks.map((c: any) => c.command), ['npm run build']);
});

test('a schema 1 record reads as empty checks; an unknown schema is a problem, not a record', (t) => {
  const root = project(t);
  record(root, { schema: 1, checks: undefined });
  const what = compile(root);
  assert.deepEqual([what.verify.onHead, what.verify.checks], [true, []]);
  record(root, { schema: 7 });
  const after = compile(root);
  assert.equal(after.verify.verdict, 'PASS', 'the unknown line is skipped');
  assert.match(after.problems.join('\n'), /1 verify record line\(s\) could not be read/);
});

test('no verify record and no feature map give a null verify part and an absent map', (t) => {
  const root = project(t, null);
  assert.deepEqual(compile(root), { head: HEAD, verify: null, flows: [], featureMap: 'absent', problems: [] });
});

test('a malformed feature map is invalid and says why; a flow id in both maps is used in neither', (t) => {
  const bad = project(t, null);
  write(path.join(bad, '.doflow', 'feature-map.json'), '{ nope');
  const what = compile(bad);
  assert.equal(what.featureMap, 'invalid');
  assert.deepEqual(what.flows, []);
  assert.match(what.problems[0], /feature-map\.json is not valid JSON/);

  const root = project(t, [{ id: 'login', title: 'A', expect: 'x' }, { id: 'solo', title: 'B', expect: 'y' }]);
  const featureDir = path.join(root, 'agent-docs', 'doflow', TASK);
  write(path.join(featureDir, 'test', 'feature-map.json'), JSON.stringify({ version: 1, flows: [{ id: 'login', title: 'C', expect: 'z' }, { id: 'extra', title: 'D', expect: 'w' }] }));
  const both: any = compileRunEvidence({ root, taskId: TASK, head: HEAD, featureDir });
  assert.equal(both.featureMap, 'invalid');
  assert.deepEqual(both.flows.map((f: any) => f.id), ['solo', 'extra']);
  assert.match(both.problems.join('\n'), /flow id 'login' is in both feature maps; neither copy is used/);
});

test('the feature map of the feature folder is read beside the project map', (t) => {
  const root = project(t, [{ id: 'a', title: 'A', expect: 'x' }]);
  const featureDir = path.join(root, 'agent-docs', 'doflow', TASK);
  write(path.join(featureDir, 'test', 'feature-map.json'), JSON.stringify({ version: 1, flows: [{ id: 'b', title: 'B', expect: 'y', critical: true }] }));
  const what: any = compileRunEvidence({ root, taskId: TASK, head: HEAD, featureDir });
  assert.equal(what.featureMap, 'present');
  assert.deepEqual(what.flows.map((f: any) => [f.id, f.critical]), [['a', false], ['b', true]]);
});

test('the same records give the same value, and compiling writes nothing', (t) => {
  const root = project(t);
  record(root);
  flowItem(root, 'login');
  const files = () => execFileSync('find', [root, '-type', 'f', '-exec', 'stat', process.platform === 'darwin' ? '-f' : '-c', process.platform === 'darwin' ? '%N %m' : '%n %Y', '{}', '+'], { encoding: 'utf8' });
  const before = files();
  const first = compile(root);
  const second = compile(root);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.equal(files(), before, 'no file was created or changed');
});
