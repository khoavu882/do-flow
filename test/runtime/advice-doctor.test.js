'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { startFakeServer, spawnFakeServer } = require('../helper/fake-decision-server');
const { buildAdviceDoctor } = require('../../src/runtime/advice/doctor.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const BIN = path.join(REPO_ROOT, 'bin/doflow.js');
const kinds = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core/registry/advice.json'), 'utf8')).kinds.map((kind) => kind.id);

function fixture(t, setting) {
  const scratch = createScratch('doflow-advice-doctor-');
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(project);
  const settingFile = path.join(scratch.xdg, 'doflow/decision-model.json');
  if (setting !== undefined) write(settingFile, typeof setting === 'string' ? setting : JSON.stringify(setting));
  const servers = [];
  t.after(async () => { for (const server of servers) await server.close(); scratch.remove(); });
  return {
    scratch, project, settingFile,
    write: (file, text) => write(file, text),
    run: (json = false) => spawnSync(process.execPath, [BIN, 'doctor', project, ...(json ? ['--json'] : [])], {
      cwd: project, encoding: 'utf8', env: scratch.env({ DOFLOW_CLI: BIN }),
    }),
    start: async (routes = {}) => {
      const server = await spawnFakeServer({ routes, dir: scratch.dir }); servers.push(server); return server;
    },
  };
}
function write(file, contents) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); }
function enabled(endpoint, model = 'clef-flash') { return { schema: 1, enabled: true, provider: 'ollama', endpoint, model }; }
function section(text, header) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(header));
  assert.notEqual(start, -1, `missing ${header}`);
  const end = lines.findIndex((line, index) => index > start && line === '');
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

 test('feature-off reasons are advisory and never probe even a configured closed endpoint', async (t) => {
  const cases = [
    [undefined, /off \(not configured\)/],
    [{ schema: 1, enabled: false }, /off \(switched off in .*decision-model\.json\)/],
    ['{invalid', /off \(unreadable setting in .*decision-model\.json\)/],
  ];
  for (const [setting, expected] of cases) {
    const f = fixture(t, setting);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(section(result.stdout, '[Decision Model]'), expected);
    assert.doesNotMatch(result.stdout, /endpoint\s+http:/);
  }
  const f = fixture(t, enabled('http://127.0.0.1:9'));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(section(result.stdout, '[Decision Model]'), /UNREACHABLE/);
  // An off setting must not touch even a live loopback listener.
  const userDisabled = fixture(t);
  const userLive = await startFakeServer();
  t.after(() => userLive.close());
  write(userDisabled.settingFile, JSON.stringify({ ...enabled(userLive.origin), enabled: false }));
  assert.match(section(userDisabled.run().stdout, '[Decision Model]'), /switched off in/);
  const userReport = await buildAdviceDoctor({ repoRoot: REPO_ROOT, projectRoot: userDisabled.project, env: userDisabled.scratch.env() });
  assert.equal(userReport.decisionModel.setting.reason, 'user-disabled');
  assert.deepEqual(userLive.requests, []);

  const projectDisabled = fixture(t, enabled(userLive.origin));
  write(path.join(projectDisabled.project, '.doflow/decision-model.json'), JSON.stringify({ schema: 1, enabled: false }));
  assert.match(section(projectDisabled.run().stdout, '[Decision Model]'), /switched off in .*project.*decision-model\.json/);
  const projectReport = await buildAdviceDoctor({ repoRoot: REPO_ROOT, projectRoot: projectDisabled.project, env: projectDisabled.scratch.env() });
  assert.equal(projectReport.decisionModel.setting.reason, 'project-disabled');
  assert.deepEqual(userLive.requests, []);
});

test('IC-014 probes in order, renders status rows and provides the decision-model JSON shape', async (t) => {
  const f = fixture(t, enabled('http://127.0.0.1:9'));
  const server = await f.start({
    'GET /api/version': { status: 200, body: { version: '0.30.0' } },
    'GET /api/tags': { status: 200, body: { models: [
      { name: 'clef-flash', capabilities: ['completion'] }, { name: 'nimble', capabilities: ['decision'] },
      ...Array.from({ length: 9 }, (_, i) => ({ name: `unknown-${i}` })),
    ] } },
    'POST /api/show': { status: 200, body: { capabilities: ['completion'] } },
  });
  write(f.settingFile, JSON.stringify(enabled(server.origin)));
  const result = f.run(true);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report.decisionModel), ['setting', 'endpoint', 'model', 'decisionModels', 'lastCall']);
  assert.equal(report.decisionModel.endpoint.version, '0.30.0');
  assert.equal(report.decisionModel.endpoint.versionOk, false);
  assert.equal(report.decisionModel.model.installed, true);
  assert.equal(report.decisionModel.model.decisionCapable, false);
  assert.deepEqual(report.decisionModel.decisionModels, ['nimble']);
  assert.equal(report.decisionModel.endpoint.state, 'reached');
  const text = f.run();
  const decision = section(text.stdout, '[Decision Model]');
  assert.match(decision, /older than 0\.35\.1/);
  assert.match(decision, /installed, not decision-capable/);
  assert.match(decision, /unknown-8.*capability unknown/);
  assert.doesNotMatch(decision, /unknown-0.*capability unknown/);
});

test('IC-014 reports refusal, missing model, empty capable list, and last answered, miss, or no record', async (t) => {
  const refuse = fixture(t, enabled('http://10.0.0.1:11434'));
  const refusal = JSON.parse(refuse.run(true).stdout).decisionModel;
  assert.equal(refusal.endpoint.state, 'refused');
  assert.match(section(refuse.run().stdout, '[Decision Model]'), /✗ REFUSED/);

  const capable = fixture(t);
  const capableServer = await capable.start();
  write(capable.settingFile, JSON.stringify(enabled(capableServer.origin)));
  const capableText = section(capable.run().stdout, '[Decision Model]');
  assert.match(capableText, /✓ REACHED/);
  assert.match(capableText, /✓ installed, decision-capable/);

  const f = fixture(t, enabled('http://127.0.0.1:9', 'absent'));
  const server = await f.start({ 'GET /api/tags': { status: 200, body: { models: [{ name: 'other', capabilities: ['completion'] }] } } });
  write(f.settingFile, JSON.stringify(enabled(server.origin, 'absent')));
  const first = JSON.parse(f.run(true).stdout).decisionModel;
  assert.equal(first.model.installed, false);
  assert.deepEqual(first.decisionModels, []);
  assert.match(section(f.run().stdout, '[Decision Model]'), /model\s+absent\s+✗ not installed/);
  assert.match(section(f.run().stdout, '[Decision Model]'), /decision-capable here: none/);
  assert.deepEqual(first.lastCall, null);
  assert.match(section(f.run().stdout, '[Decision Model]'), /last call\s+none recorded/);

  const root = path.join(f.project, '.doflow/state/advice/picks');
  const stamp = new Date().toISOString();
  write(path.join(root, `${stamp.slice(0, 10)}.jsonl`), `${JSON.stringify({ type: 'pick', pickId: 'x', at: stamp, kind: 'tier', pick: 'standard' })}\n${JSON.stringify({ type: 'outcome', pickId: 'x', at: stamp, actual: 'standard', source: 'brief-record' })}\n`);
  assert.equal(JSON.parse(f.run(true).stdout).decisionModel.lastCall.status, 'answered');
  write(path.join(root, `${stamp.slice(0, 10)}.jsonl`), `${JSON.stringify({ type: 'miss', at: stamp, kind: 'tier', reason: 'timeout' })}\n`);
  const miss = JSON.parse(f.run(true).stdout).decisionModel.lastCall;
  assert.equal(miss.status, 'unavailable'); assert.equal(miss.reason, 'timeout');
});

test('IC-015 aggregates retained picks and outcomes by registry kind, includes adhoc and unreadable lines', (t) => {
  const f = fixture(t);
  const root = path.join(f.project, '.doflow/state/advice/picks');
  const at = new Date().toISOString();
  const records = [
    { type: 'pick', pickId: 'p1', at, kind: 'tier', pick: 'standard' },
    { type: 'outcome', pickId: 'p1', at, actual: 'frontier', source: 'brief-record' },
    { type: 'miss', at, kind: 'tier', reason: 'timeout' },
    { type: 'pick', pickId: 'p3', at, kind: 'tier', pick: 'frontier' },
    { type: 'outcome', pickId: 'p3', at, actual: 'frontier', source: 'classify-verdict' },
    { type: 'pick', pickId: 'p4', at, kind: 'tier', pick: 'standard' },
    { type: 'outcome', pickId: 'p4', at, actual: 'frontier', source: 'brief-record' },
    { type: 'outcome', pickId: 'p4', at, actual: 'standard', source: 'brief-record' },
    { type: 'pick', pickId: 'p2', at, kind: 'adhoc', pick: 'a' },
    { type: 'outcome', pickId: 'p2', at, actual: 'a', source: 'caller' },
  ];
  write(path.join(root, `${at.slice(0, 10)}.jsonl`), `${records.map(JSON.stringify).join('\n')}\n{bad json\n`);
  const result = f.run(true);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout).advice;
  assert.deepEqual(Object.keys(json), ['windowDays', 'store', 'kinds', 'unreadableLines']);
  assert.equal(json.unreadableLines, 1);
  assert.deepEqual(json.kinds.map((row) => row.kind), [...kinds, 'adhoc']);
  assert.equal(json.kinds[0].picks, 3); assert.equal(json.kinds[0].matched, 2);
  const text = section(f.run().stdout, '[Advice Agreement]');
  assert.match(text, /done = tier the brief named or accepted class/);
  assert.match(text, /done = value the caller recorded/);
  assert.match(text, /calls unavailable/);
  assert.match(text, /no picks recorded/);
  assert.match(text, /1 line\(s\) could not be read/);
  assert.doesNotMatch(text, /%|\d\s*\/\s*\d/);
  const empty = fixture(t);
  assert.match(section(empty.run().stdout, '[Advice Agreement]'), /No picks recorded here\./);
});

test('advice leaves a real runtime-no-reach health finding and exit status unchanged when off or the endpoint fails', async (t) => {
  const f = fixture(t);
  const root = path.join(f.project, '.doflow');
  write(path.join(root, 'state/ledger.json'), JSON.stringify({
    version: 2, scope: 'project', scopeRoot: f.project, targets: {}, mcpSelections: {},
    resources: [{ harness: 'pi', assetId: 'skills.doflow', kind: 'copy-tree-file' }], legacyImports: [],
  }));
  write(path.join(root, 'scripts/doflow/bin/doflow-run'), '#!/bin/sh\\n', 0o755);
  const offResult = f.run(true);
  assert.equal(offResult.status, 1, offResult.stderr);
  const offReport = JSON.parse(offResult.stdout);
  assert.ok(offReport.findings.some((finding) => finding.kind === 'runtime-no-reach'));

  const server = await f.start({ 'GET /api/tags': { status: 500, body: { error: 'probe failed' } } });
  write(f.settingFile, JSON.stringify(enabled(server.origin)));
  const failedResult = f.run(true);
  assert.equal(failedResult.status, 1, failedResult.stderr);
  const failedReport = JSON.parse(failedResult.stdout);
  assert.equal(failedReport.decisionModel.model.installed, false);
  assert.deepEqual(failedReport.findings, offReport.findings);
  assert.deepEqual(failedReport.warnings, offReport.warnings);
});

test('IC-014 probe requests are exactly version, listing, then show', async (t) => {
  const f = fixture(t);
  const server = await startFakeServer({ routes: {
    'GET /api/tags': { status: 200, body: { models: [{ name: 'clef-flash' }] } },
  } });
  t.after(() => server.close());
  write(f.settingFile, JSON.stringify(enabled(server.origin)));
  const report = await buildAdviceDoctor({ repoRoot: REPO_ROOT, projectRoot: f.project, env: f.scratch.env() });
  assert.equal(report.decisionModel.setting.state, 'on');
  assert.deepEqual(server.requests.map(({ method, pathname }) => `${method} ${pathname}`), [
    'GET /api/version', 'GET /api/tags', 'POST /api/show',
  ]);
});

test('latestCall chooses the later appended call when timestamps tie', async (t) => {
  const f = fixture(t);
  const root = path.join(f.project, '.doflow/state/advice/picks');
  const at = new Date().toISOString();
  write(path.join(root, `${at.slice(0, 10)}.jsonl`), `${[
    { type: 'pick', pickId: 'earlier', at, kind: 'tier', pick: 'standard' },
    { type: 'miss', at, kind: 'tier', reason: 'later miss' },
  ].map(JSON.stringify).join('\n')}\n`);
  const report = await buildAdviceDoctor({ repoRoot: REPO_ROOT, projectRoot: f.project, env: f.scratch.env(), now: () => new Date(at) });
  assert.deepEqual(report.decisionModel.lastCall, { at, status: 'unavailable', reason: 'later miss' });
});

test('doctor inspection probe timeout and exhausted budget fail open', async (t) => {
  const timeoutFixture = fixture(t);
  const timeoutServer = await startFakeServer({ routes: {
    'GET /api/version': { status: 200, body: { version: '0.40.2' }, delayMs: 1200 },
  } });
  t.after(() => timeoutServer.close());
  write(timeoutFixture.settingFile, JSON.stringify(enabled(timeoutServer.origin)));
  let timeoutReport;
  await assert.doesNotReject(async () => {
    timeoutReport = await buildAdviceDoctor({ repoRoot: REPO_ROOT, projectRoot: timeoutFixture.project,
      env: timeoutFixture.scratch.env(), probeTimeoutMs: 400, doctorBudgetMs: 3000 });
  });
  assert.equal(timeoutReport.decisionModel.endpoint.state, 'unreachable');
  assert.match(timeoutReport.decisionModel.endpoint.message, /timed out after 400ms/);
  assert.deepEqual(timeoutServer.requests.map(({ method, pathname }) => `${method} ${pathname}`), ['GET /api/version']);

  const budgetFixture = fixture(t);
  const budgetServer = await startFakeServer();
  t.after(() => budgetServer.close());
  write(budgetFixture.settingFile, JSON.stringify(enabled(budgetServer.origin)));
  let budgetReport;
  await assert.doesNotReject(async () => {
    budgetReport = await buildAdviceDoctor({ repoRoot: REPO_ROOT, projectRoot: budgetFixture.project,
      env: budgetFixture.scratch.env(), probeTimeoutMs: 400, doctorBudgetMs: 0 });
  });
  assert.equal(budgetReport.decisionModel.endpoint.state, 'unreachable');
  assert.match(budgetReport.decisionModel.endpoint.message, /probe budget exhausted/);
  assert.deepEqual(budgetServer.requests, []);
});

test('doctor settings section joins the advice sections without affecting health result', (t) => {
  const f = fixture(t);
  const base = f.run(true); const text = f.run();
  assert.equal(base.status, text.status);
  const report = JSON.parse(base.stdout);
  assert.equal(report.settings.configHome.dir, path.join(f.scratch.xdg, 'doflow'));
  assert.deepEqual(report.findings, JSON.parse(f.run(true).stdout).findings);
  assert.deepEqual(report.warnings, JSON.parse(f.run(true).stdout).warnings);
  const order = ['[MCP Consultations]', '[Decision Model]', '[Advice Agreement]', '[Settings]', '[Warnings]', '[Findings]']
    .map((header) => text.stdout.indexOf(header)).filter((index) => index >= 0);
  assert.ok(text.stdout.includes('[Settings]'));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});
