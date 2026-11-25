'use strict';

// 181 E.2 (IC-008, IC-009, FR-011, FR-012, FR-018, NFR-005): `verify --action feature-map` runs the
// command flows and records each as an extracted evidence item, lists the browser flows for the agent,
// records a flow it cannot drive as unreached with the reason, and files one follow-up per critical flow.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../../helper/tmp.ts');
const { createScratch } = require('../../helper/scratch-env.ts');
const { EvidenceLedger } = require('../../../src/runtime/evidence-ledger.ts');
const { compileRunEvidence } = require('../../../src/runtime/run-evidence.ts');

const REPO = path.resolve(__dirname, '../../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const scratch = createScratch('doflow-feature-map-run-');
after(() => scratch.remove());

const TASK = 'T-1';
const node = (code: string) => ({ kind: 'command', argv: [process.execPath, '-e', code] });
const flow = (over: any = {}) => ({ id: 'login', title: 'A user logs in', expect: 'the dashboard shows', drive: node('console.log("dashboard shown")'), ...over });

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8', env: scratch.env() });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function project(t: any, flows: any[] | string | null) {
  const root = tempDir(t, 'doflow-feature-map-run-project-');
  fs.writeFileSync(path.join(root, '.gitignore'), '.doflow/\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  if (flows !== null) {
    fs.mkdirSync(path.join(root, '.doflow'), { recursive: true });
    fs.writeFileSync(path.join(root, '.doflow', 'feature-map.json'), typeof flows === 'string' ? flows : JSON.stringify({ version: 1, flows }));
  }
  return { root, head: git(root, 'rev-parse', 'HEAD') };
}

const withoutBrowserTool = () => process.env.PATH!.split(path.delimiter).filter((dir) => !fs.existsSync(path.join(dir, 'agent-browser'))).join(path.delimiter);
function withBrowserTool(t: any) {
  const bin = tempDir(t, 'doflow-fake-agent-browser-');
  fs.writeFileSync(path.join(bin, 'agent-browser'), '#!/bin/sh\necho agent-browser 1.0.0\n', { mode: 0o755 });
  return `${bin}${path.delimiter}${withoutBrowserTool()}`;
}

function run(p: any, args: string[] = [], pathEnv = withoutBrowserTool()) {
  const result = spawnSync(process.execPath, [DOFLOW, 'verify', '--action', 'feature-map', '--task-id', TASK, '--json', ...args], {
    cwd: p.root, encoding: 'utf8', env: scratch.env({ PATH: pathEnv, DOFLOW_TELEMETRY: 'off', DOFLOW_RUN_ID: undefined, DOFLOW_LINEAGE_ID: undefined, DOFLOW_ATTEMPT: undefined, DOFLOW_CONFIG_DIR: undefined }),
  });
  let json: any = null;
  try { json = JSON.parse(result.stdout); } catch { /* usage errors print text */ }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

const ledgerItems = (p: any) => { const ledger = new EvidenceLedger({ repoRoot: p.root }); ledger.load(TASK); return ledger.getAllEvidence(); };
const followups = (p: any) => {
  const result = spawnSync(process.execPath, [DOFLOW, 'followup', '--action', 'list', '--json'], { cwd: p.root, encoding: 'utf8', env: scratch.env({ DOFLOW_TELEMETRY: 'off', DOFLOW_CONFIG_DIR: undefined }) });
  return JSON.parse(result.stdout).items.map((item: any) => item.statement);
};

test('two command flows give action, result and locator, and a failing flow exits 0 with status failed', (t) => {
  const p = project(t, [flow(), flow({ id: 'logout', title: 'A user logs out', drive: node('console.error("session kept"); process.exit(3)') })]);
  const out = run(p);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.json.ok, true);
  assert.equal(out.json.head, p.head);
  assert.deepEqual(out.json.ran.map((f: any) => [f.id, f.status, f.commit]), [['login', 'passed', p.head], ['logout', 'failed', p.head]]);
  const login = out.json.ran[0];
  assert.match(login.action, /-e/);
  assert.equal(login.observed, 'exit 0: dashboard shown');
  assert.match(login.locator, /^\.doflow\/state\/verification\/logs\/.*flow-login\.log$/);
  assert.match(fs.readFileSync(path.join(p.root, login.locator), 'utf8'), /dashboard shown/);
  assert.equal(out.json.ran[1].observed, 'exit 3: session kept');

  const items = ledgerItems(p);
  assert.equal(items.length, 2);
  const item = items.find((i: any) => i.establishes[0] === 'flow:login');
  assert.deepEqual([item.kind, item.provenance, item.source.provider, item.source.capability, item.observation.exitCode, item.freshness.gitCommit],
    ['runtime-observation', 'extracted', 'doflow', 'feature-map', 0, p.head]);
  assert.equal(item.observation.command, login.action);

  const what = compileRunEvidence({ root: p.root, taskId: TASK, head: p.head, featureDir: null });
  assert.deepEqual(what.flows.map((f: any) => [f.id, f.status]), [['login', 'passed'], ['logout', 'failed']]);
});

test('a flow with no drive is unreached with its reason and is not reported as done', (t) => {
  const p = project(t, [flow({ drive: undefined })]);
  const out = run(p);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.json.unreached, [{ id: 'login', reason: 'no drive in the feature map' }]);
  assert.equal(out.json.ran[0].status, 'unreached');
  const [item] = ledgerItems(p);
  assert.deepEqual([item.provenance, item.content, item.establishes, item.observation], ['asserted', 'unreached: no drive in the feature map', ['flow:login'], null]);
  assert.equal(compileRunEvidence({ root: p.root, taskId: TASK, head: p.head, featureDir: null }).flows[0].status, 'unreached');
});

test('a browser flow is listed for the agent; without agent-browser it is also recorded as unreached', (t) => {
  const browser = { kind: 'browser', start: 'http://localhost:3000/login', steps: 'Sign in as the demo user and read the heading.' };
  const p = project(t, [flow({ drive: browser })]);
  const absent = run(p);
  assert.equal(absent.status, 0, absent.stderr);
  assert.deepEqual(absent.json.agent, [{ id: 'login', start: browser.start, steps: browser.steps, browserTool: 'absent' }]);
  assert.deepEqual(absent.json.unreached, [{ id: 'login', reason: 'agent-browser not found' }]);
  assert.equal(ledgerItems(p)[0].content, 'unreached: agent-browser not found');

  if (process.platform === 'win32') return;
  const q = project(t, [flow({ drive: browser })]);
  const present = run(q, [], withBrowserTool(t));
  assert.equal(present.status, 0, present.stderr);
  assert.equal(present.json.agent[0].browserTool, 'present');
  assert.deepEqual([present.json.unreached, present.json.ran, ledgerItems(q)], [[], [], []]);
});

test('a critical flow gets a property or formal proposal as a follow-up, once, and no proof is written', (t) => {
  const p = project(t, [
    flow({ critical: true, property: 'a session ends exactly once' }),
    flow({ id: 'pay', title: 'A user pays', critical: true, concurrency: true, property: 'no double charge under concurrent retries' }),
    flow({ id: 'audit', title: 'An admin reads the audit trail', critical: true }),
    flow({ id: 'plain', title: 'A user opens the help page' }),
  ]);
  const first = run(p);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(first.json.proposals.map((x: any) => [x.flow, x.kind, x.statement]), [
    ['login', 'property-based', 'Property check proposed for flow login: a session ends exactly once'],
    ['pay', 'formal', 'Formal specification proposed for flow pay: no double charge under concurrent retries'],
    ['audit', 'property-needed', 'Critical flow audit needs its property named before a check can be proposed'],
  ]);
  assert.ok(first.json.proposals.every((x: any) => /^FU-/.test(x.followup)));
  assert.equal(followups(p).length, 3);

  const again = run(p);
  assert.deepEqual(again.json.proposals.map((x: any) => x.followup), first.json.proposals.map((x: any) => x.followup));
  assert.equal(followups(p).length, 3);
  assert.equal(git(p.root, 'status', '--porcelain'), '', 'nothing outside project state is written');
});

test('--flow runs only the named flows; an unknown flow is usage', (t) => {
  const p = project(t, [flow(), flow({ id: 'logout', title: 'Out' })]);
  const some = run(p, ['--flow', 'logout']);
  assert.deepEqual(some.json.ran.map((f: any) => f.id), ['logout']);
  assert.equal(ledgerItems(p).length, 1);
  const unknown = run(p, ['--flow', 'nope']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.json.summary, /--flow nope names no flow in the feature map \(flows: login, logout\)/);
});

test('an absent or invalid map exits 1 and runs nothing', (t) => {
  const absent = project(t, null);
  const none = run(absent);
  assert.deepEqual([none.status, none.json.ok, none.json.error], [1, false, 'map-absent']);
  const bad = project(t, [flow({ drive: { kind: 'command', argv: [process.execPath, '-e', 'require("fs").writeFileSync("ran.txt", "x")'] } }), flow({ id: 'Bad Id' })]);
  const invalid = run(bad);
  assert.deepEqual([invalid.status, invalid.json.error], [1, 'map-invalid']);
  assert.match(invalid.json.findings.join('\n'), /id must match/);
  assert.equal(fs.existsSync(path.join(bad.root, 'ran.txt')), false);
  assert.deepEqual(ledgerItems(bad), []);
});

test('--flow with another action is usage', (t) => {
  const p = project(t, [flow()]);
  const result = spawnSync(process.execPath, [DOFLOW, 'verify', '--action', 'inner-loop', '--task-id', TASK, '--flow', 'login'], { cwd: p.root, encoding: 'utf8', env: scratch.env() });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--flow applies to --action feature-map only/);
});
