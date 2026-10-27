'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { tempDirOutsideProfile } = require('../helper/outside-profile.ts');
const { systemPath } = require('../helper/system-path.ts');
const { startFakeServer, spawnFakeServer } = require('../helper/fake-decision-server.ts');
const { buildAdviceDoctor } = require('../../src/runtime/advice/doctor.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const BIN = path.join(REPO_ROOT, 'bin/doflow.js');
// `doctor` runs `<harness> --version` for every harness it finds on PATH (seconds each for some); these
// tests read the advice sections only, so the spawned doctor sees node and the system tools and no harness.
const DOCTOR_PATH = systemPath(path.dirname(process.execPath));
const kinds = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core/registry/advice.json'), 'utf8')).kinds.map((kind: any) => kind.id);

function fixture(t: any, setting?: any) {
  const scratch = createScratch('doflow-advice-doctor-');
  // outside the account profile on win32: the doctor walks up from the project to any `.doflow/` store
  const project = path.join(tempDirOutsideProfile(t, 'doflow-advice-doctor-proj-'), 'project');
  fs.mkdirSync(project);
  const settingFile = path.join(scratch.xdg, 'doflow/decision-model.json');
  if (setting !== undefined) write(settingFile, typeof setting === 'string' ? setting : JSON.stringify(setting));
  const servers: any = [];
  t.after(async (): Promise<any> => { for (const server of servers) await server.close(); scratch.remove(); });
  return {
    scratch, project, settingFile,
    write: (file: any, text: any, mode?: any) => write(file, text, mode),
    run: (json: any = false) => spawnSync(process.execPath, [BIN, 'doctor', project, ...(json ? ['--json'] : [])], {
      cwd: project, encoding: 'utf8', env: scratch.env({ DOFLOW_CLI: BIN, PATH: DOCTOR_PATH }),
    }),
    start: async (routes: any = {}) => {
      const server = await spawnFakeServer({ routes, dir: scratch.dir }); servers.push(server); return server;
    },
  };
}
function write(file: any, contents: any, _mode?: any) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); }
function enabled(endpoint: any, model: any = 'clef-flash') { return { schema: 1, enabled: true, provider: 'ollama', endpoint, model }; }
function section(text: any, header: any) {
  const lines = text.split('\n');
  const start = lines.findIndex((line: any) => line.startsWith(header));
  assert.notEqual(start, -1, `missing ${header}`);
  const end = lines.findIndex((line: any, index: any) => index > start && line === '');
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

 test('feature-off reasons are advisory and never probe even a configured closed endpoint', async (t) => {
  const cases: any = [
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
  const records: any = [
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
  assert.deepEqual(json.kinds.map((row: any) => row.kind), [...kinds, 'adhoc']);
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
  assert.ok(offReport.findings.some((finding: any) => finding.kind === 'runtime-no-reach'));

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
  assert.deepEqual(server.requests.map(({ method, pathname }: any) => `${method} ${pathname}`), [
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
  ].map((x: any) => JSON.stringify(x)).join('\n')}\n`);
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
  let timeoutReport: any;
  await assert.doesNotReject(async () => {
    timeoutReport = await buildAdviceDoctor({ repoRoot: REPO_ROOT, projectRoot: timeoutFixture.project,
      env: timeoutFixture.scratch.env(), probeTimeoutMs: 400, doctorBudgetMs: 3000 });
  });
  assert.equal(timeoutReport.decisionModel.endpoint.state, 'unreachable');
  assert.match(timeoutReport.decisionModel.endpoint.message, /timed out after 400ms/);
  assert.deepEqual(timeoutServer.requests.map(({ method, pathname }: any) => `${method} ${pathname}`), ['GET /api/version']);

  const budgetFixture = fixture(t);
  const budgetServer = await startFakeServer();
  t.after(() => budgetServer.close());
  write(budgetFixture.settingFile, JSON.stringify(enabled(budgetServer.origin)));
  let budgetReport: any;
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

test('084 C-4/C-7: doctor counts a dispatcher pick, its outcome and an unavailable call from the fields record.ts writes', async (t) => {
  const { interceptDecisionPoint } = require('../../src/runtime/advice/shadow-dispatcher.ts');
  const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
  const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
  const { appendOutcome, readWindow } = require('../../src/runtime/advice/record.ts');
  const f = fixture(t);
  const env = f.scratch.env();
  const roots = resolveRoots({ registry: loadStorageRegistry({ repoRoot: REPO_ROOT }), projectRoot: f.project, env });
  const questionSet = { state: 's', questions: [{ name: 'tier', type: 'choice', instructions: 'Choose.', options: { light: 'L', standard: 'S', frontier: 'F' } }] };
  const context = { kind: 'tier', caller: 'brief-tools', state: 's', staticPick: 'light', questionSet, adviceRegistry: { timeoutMs: 1000 }, projectRoot: f.project, env };
  const shadow = { kind: 'tier', mode: 'shadow', model: 'm' };
  const answer = { status: 'answered', model: 'm', answers: [{ name: 'tier', type: 'choice', pick: 'standard', strength: { word: 'clear', between: null }, probabilities: {}, confidence: 0.9 }] };
  const picked = await interceptDecisionPoint(context, { adviceClient: { ask: async () => answer }, roots, shadowConfig: shadow });
  await interceptDecisionPoint(context, { adviceClient: { ask: async () => ({ status: 'unavailable', reason: 'timeout', answers: [] }) }, roots, shadowConfig: shadow });
  const until = Date.now() + 1000;
  while (readWindow({ roots }).records.length < 2 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(appendOutcome({ roots, pickId: picked.pickId, actual: 'standard', source: 'caller', store: 'project-state' }));
  const report = await buildAdviceDoctor({ repoRoot: REPO_ROOT, projectRoot: f.project, env });
  const tier = report.advice.kinds.find((row: any) => row.kind === 'tier');
  assert.deepEqual(tier, { kind: 'tier', picks: 1, withOutcome: 1, matched: 1, unavailable: 1, outcomeSources: ['caller'] });
});
