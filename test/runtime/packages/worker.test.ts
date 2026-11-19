'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ACTIVE_HARNESS_IDS } = require('../../helper/harness-ids.ts');
const fs = require('node:fs');
const path = require('node:path');
const { createScratch } = require('../../helper/scratch-env.ts');
const { REPO_ROOT } = require('../../../src/helper/repo-root.ts');
const { planPackage, applyPlan } = require('../../../src/runtime/packages/store.ts');
const { packageView, resetPackageView } = require('../../../src/runtime/packages/view.ts');
const { readLock, writeLock, lockPackages } = require('../../../src/state/lockfile.ts');
const { workerCatalogue, descriptorDigest } = require('../../../src/runtime/worker/catalogue.ts');
const { select } = require('../../../src/runtime/worker/readiness.ts');
const { POINT_VALIDATORS } = require('../../../src/runtime/packages/points.ts');
const { PARSERS } = require('../../../src/runtime/worker/parsers.ts');

// No test reaches a real harness CLI: the product probes `<harness> --version` through PATH, so this file runs on a PATH without one.
require("../../helper/harness-free-path.ts").useHarnessFreePath();

const AT = '2026-10-24T09:12:03Z';
const NO_TMP = '/nonexistent-doflow-tmp';

function validWorkerJson() {
  return {
    profile: null,
    billing: 'unknown',
    family: 'custom-family',
    cli: {
      status: 'supported',
      evidence: ['test'],
      verification: 'Check mycli',
      verifiedOn: '2026-10-24',
      binary: 'mycli',
      versionArgv: ['--version'],
    },
    oneShot: {
      status: 'supported',
      evidence: ['test'],
      verification: 'Check mycli oneShot',
      verifiedOn: '2026-10-24',
      argv: ['{prompt}'],
      promptVia: 'argv',
    },
    structuredOutput: {
      status: 'supported',
      evidence: ['test'],
      verification: 'Check mycli structuredOutput',
      verifiedOn: '2026-10-24',
      argv: [],
      parser: 'doflow-jsonl-v1',
    },
    readOnly: {
      status: 'unknown',
      evidence: [],
      verification: 'Check readOnly',
      verifiedOn: '2026-10-24',
      reason: 'test',
    },
    spawnDenial: {
      status: 'unknown',
      evidence: [],
      verification: 'Check spawnDenial',
      verifiedOn: '2026-10-24',
      reason: 'test',
    },
    runnableProbe: {
      status: 'unknown',
      evidence: [],
      verification: 'Check runnableProbe',
      verifiedOn: '2026-10-24',
      reason: 'test',
    },
    hooksProbe: {
      status: 'unknown',
      evidence: [],
      verification: 'Check hooksProbe',
      verifiedOn: '2026-10-24',
      reason: 'test',
    },
    guidanceProbe: {
      status: 'unknown',
      evidence: [],
      verification: 'Check guidanceProbe',
      verifiedOn: '2026-10-24',
      reason: 'test',
    },
    loginProbe: {
      status: 'unknown',
      evidence: [],
      verification: 'Check loginProbe',
      verifiedOn: '2026-10-24',
      reason: 'test',
    },
    persistentSession: {
      status: 'unknown',
      evidence: [],
      verification: 'Check persistentSession',
      verifiedOn: '2026-10-24',
      reason: 'test',
    },
    resume: {
      status: 'unknown',
      evidence: [],
      verification: 'Check resume',
      verifiedOn: '2026-10-24',
      reason: 'test',
    },
    controlChannel: {
      status: 'unknown',
      evidence: [],
      verification: 'Check controlChannel',
      verifiedOn: '2026-10-24',
      reason: 'test',
    },
    modelChecks: [],
  };
}

function makeWorkerPackage(dir: string, workerObj = validWorkerJson()) {
  fs.mkdirSync(path.join(dir, 'workers'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), JSON.stringify({
    manifest: 1,
    id: 'acme',
    version: '1.2.0',
    summary: 'A worker package',
    doflow: '>=2.0.0-beta.1 <3.0.0',
    programs: [
      {
        id: 'mycli',
        binary: 'mycli',
        argv: 'worker-recipe',
      },
    ],
    contributions: [
      {
        point: 'worker',
        version: 1,
        id: 'mycli',
        file: 'workers/mycli.json',
        programs: ['mycli'],
      },
    ],
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'workers', 'mycli.json'), JSON.stringify(workerObj, null, 2));
  fs.writeFileSync(path.join(dir, 'README.md'), 'notes\n');
}

test('negative control: with no package, catalogue equals built-in harnesses', () => {
  const catalogue = workerCatalogue({ repoRoot: REPO_ROOT });
  assert.ok(catalogue.length > 0);
  assert.ok(catalogue.every((e: any) => e.origin === 'builtin'));
  for (const id of ACTIVE_HARNESS_IDS) {
    assert.ok(catalogue.some((e: any) => e.id === id));
  }
});

test('package worker catalogue lifecycle: needs-trust, active, unverified family', (t: any) => {
  const scratch = createScratch('doflow-pworker-');
  t.after(() => scratch.remove());

  const srcDir = path.join(scratch.dir, 'pkg-src');
  makeWorkerPackage(srcDir);

  const grantsFile = path.join(scratch.xdg, 'doflow', 'packages', 'grants.jsonl');
  const planned = planPackage({ action: 'add', source: srcDir, homeDir: scratch.home, repoRoot: REPO_ROOT, now: Date.parse(AT) });
  assert.equal(planned.ok, true, JSON.stringify(planned.findings));

  const applied = applyPlan({ planId: planned.plan.planId, action: 'add', homeDir: scratch.home, repoRoot: REPO_ROOT, env: scratch.env() });
  assert.equal(applied.ok, true, JSON.stringify(applied.findings));

  // Enable package in lockfile
  const lockOpts = { scope: 'global', homeDir: scratch.home };
  const lock = readLock(lockOpts);
  writeLock(lockOpts, { ...lock, packages: lockPackages(lock).map((r: any) => (r.id === 'acme' ? { ...r, enabled: true } : r)) });

  // While needs-trust, acme.mycli is absent from catalogue
  resetPackageView();
  const untrustedView = packageView({ repoRoot: REPO_ROOT, homeDir: scratch.home, env: scratch.env(), tmpDir: NO_TMP });
  const pkgBefore = untrustedView.packages.find((p: any) => p.id === 'acme');
  assert.equal(pkgBefore.state, 'needs-trust');

  const untrustedCatalogue = workerCatalogue({ view: untrustedView, repoRoot: REPO_ROOT });
  assert.equal(untrustedCatalogue.some((e: any) => e.id === 'acme.mycli'), false);

  // Person trusts the package
  fs.mkdirSync(path.dirname(grantsFile), { recursive: true });
  fs.appendFileSync(grantsFile, `${planned.plan.grantLines.trust}\n`);

  resetPackageView();
  const trustedView = packageView({ repoRoot: REPO_ROOT, homeDir: scratch.home, env: scratch.env(), tmpDir: NO_TMP });
  const pkgAfter = trustedView.packages.find((p: any) => p.id === 'acme');
  assert.equal(pkgAfter.state, 'active');

  const trustedCatalogue = workerCatalogue({ view: trustedView, repoRoot: REPO_ROOT });
  const entry = trustedCatalogue.find((e: any) => e.id === 'acme.mycli');
  assert.ok(entry, 'acme.mycli should be in catalogue');
  assert.equal(entry.origin, 'package');
  assert.equal(entry.packageId, 'acme');
  assert.equal(entry.worker.family, 'unverified', 'family must be forced to unverified');
  assert.equal(entry.descriptorDigest, descriptorDigest(validWorkerJson()));

  // Never selected unless workers.enabled names it (when that key exists)
  const projectDir = path.join(scratch.dir, 'project');
  fs.mkdirSync(path.join(projectDir, '.doflow'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.doflow', 'settings.json'), JSON.stringify({
    'workers.enabled': ['claude', 'codex'],
  }, null, 2));

  const selectRes = select({
    root: projectDir,
    cwd: projectDir,
    env: scratch.env(),
    view: trustedView,
    descriptors: {
      'acme.mycli': entry.worker,
      claude: trustedCatalogue.find((e: any) => e.id === 'claude').worker,
    },
  });
  assert.notEqual(selectRes.harness, 'acme.mycli');
});

const MAP = (id: string) => ({
  id, format: 'jsonl-field-map-v1', eventType: ['type'], missingTerminal: 'no-done',
  rules: [
    { when: [{ path: ['type'], equals: 'message' }, { path: ['text'], is: 'string' }], then: { final: ['text'] } },
    { when: [{ path: ['type'], equals: 'done' }], then: { terminal: { outcome: 'completed' } } },
  ],
});

test('171 review: a package worker may carry a fieldMap alone, or a core parser alone', () => {
  const mapOnly: any = validWorkerJson();
  delete mapOnly.structuredOutput.parser;
  mapOnly.structuredOutput.fieldMap = MAP('acme-stream-v1');
  assert.deepEqual(POINT_VALIDATORS['worker-v1']('mycli', mapOnly, { packageId: 'acme' }), []);
  assert.deepEqual(POINT_VALIDATORS['worker-v1']('mycli', validWorkerJson(), { packageId: 'acme' }), []);
});

test('171 review: a package worker carrying both parser and fieldMap is refused, naming the fields, even when parser equals the map id', () => {
  for (const [parser, mapId] of [['doflow-jsonl-v1', 'acme-stream-v1'], ['acme-stream-v1', 'acme-stream-v1']]) {
    const both: any = validWorkerJson();
    both.structuredOutput.parser = parser;
    both.structuredOutput.fieldMap = MAP(mapId);
    const errors = POINT_VALIDATORS['worker-v1']('mycli', both, { packageId: 'acme' });
    assert.ok(errors.some((err: string) => /structuredOutput/.test(err) && /'parser'/.test(err) && /'fieldMap'/.test(err) && /not both/.test(err)), JSON.stringify([parser, errors]));
  }
});

test('171 review S5: a package fieldMap whose id is a core PARSERS key is refused at install', () => {
  const taken: any = validWorkerJson();
  delete taken.structuredOutput.parser;
  taken.structuredOutput.fieldMap = MAP('codex-exec-json-v1');
  assert.equal(Object.hasOwn(PARSERS, 'codex-exec-json-v1'), true);
  const errors = POINT_VALIDATORS['worker-v1']('mycli', taken, { packageId: 'acme' });
  assert.ok(errors.some((err: string) => /fieldMap\.id 'codex-exec-json-v1' is a core parser id/.test(err)), JSON.stringify(errors));
});

test('a parser id not in PARSERS is refused by worker-v1 validator', () => {
  const badWorker = validWorkerJson();
  badWorker.structuredOutput.parser = 'nonexistent-parser';
  assert.equal(Object.hasOwn(PARSERS, 'nonexistent-parser'), false);

  const errors = POINT_VALIDATORS['worker-v1']('mycli', badWorker, { packageId: 'acme' });
  assert.ok(errors.some((err: string) => /parser 'nonexistent-parser' is not a registered core parser/.test(err)));
});

test('170 D2: a package worker declares a control channel through the worker point, with the same checks a built-in takes', () => {
  const withChannel = (channel: any) => {
    const worker: any = validWorkerJson();
    worker.mainSession = {
      status: 'supported', evidence: ['test'], verification: 'Check mycli mainSession', verifiedOn: '2026-11-17',
      argv: ['--json', '{prompt}'], promptVia: 'argv', parser: 'doflow-jsonl-v1',
    };
    worker.controlChannel = channel;
    return worker;
  };
  const channel = () => ({
    status: 'supported', evidence: ['test'], verification: 'Check mycli controlChannel', verifiedOn: '2026-11-17',
    argv: ['--stdin-json'], framing: 'jsonl-lf', parser: 'doflow-jsonl-v1',
    messages: { followUp: { type: 'message', text: '{text}' }, stop: { type: 'stop' } },
    turn: { working: [{ path: ['type'], equals: 'busy' }], settled: [{ path: ['type'], equals: 'idle' }] },
    close: { stdinEof: 'exits', graceSeconds: 5 },
    unverified: ['everything: declared from docs only'],
  });
  assert.deepEqual(POINT_VALIDATORS['worker-v1']('mycli', withChannel(channel()), { packageId: 'acme' }), []);
  const bad: any = channel();
  bad.messages.followUp.text = 'say {text}';
  const errors = POINT_VALIDATORS['worker-v1']('mycli', withChannel(bad), { packageId: 'acme' });
  assert.ok(errors.some((err: string) => /^package 'acme' worker 'mycli' worker 'controlChannel'\.messages\.followUp\.text: a placeholder/.test(err)), JSON.stringify(errors));
  const old: any = withChannel(channel());
  old.steering = { status: 'unknown', evidence: [], verification: 'v', verifiedOn: '2026-11-17', reason: 'r' };
  assert.ok(POINT_VALIDATORS['worker-v1']('mycli', old, { packageId: 'acme' }).some((err: string) => /steering was replaced by controlChannel \(row 170\)/.test(err)));
});

test('170 C5: a package channel parser is a core parser or the worker\'s own fieldMap id, nothing else', () => {
  const channelWorker = (parser: string | null, mapId?: string) => {
    const worker: any = validWorkerJson();
    worker.mainSession = {
      status: 'supported', evidence: ['test'], verification: 'Check mycli mainSession', verifiedOn: '2026-11-17',
      argv: ['--json', '{prompt}'], promptVia: 'argv', parser: 'doflow-jsonl-v1',
    };
    if (mapId) { delete worker.structuredOutput.parser; worker.structuredOutput.fieldMap = MAP(mapId); }
    worker.controlChannel = {
      status: 'supported', evidence: ['test'], verification: 'Check mycli controlChannel', verifiedOn: '2026-11-17',
      argv: ['--stdin-json'], framing: 'jsonl-lf', parser,
      messages: { followUp: { type: 'message', text: '{text}' }, stop: { type: 'stop' } },
      turn: { working: [{ path: ['type'], equals: 'busy' }], settled: [{ path: ['type'], equals: 'idle' }] },
      close: { stdinEof: 'exits', graceSeconds: 5 },
      unverified: ['everything: declared from docs only'],
    };
    return worker;
  };
  const check = (worker: any) => POINT_VALIDATORS['worker-v1']('mycli', worker, { packageId: 'acme' });
  assert.deepEqual(check(channelWorker('acme-stream-v1', 'acme-stream-v1')), []);
  assert.deepEqual(check(channelWorker(null)), []);
  const errors = check(channelWorker('nonexistent-parser'));
  assert.ok(errors.some((err: string) => /worker 'controlChannel': parser 'nonexistent-parser' is not a registered core parser or this worker's structuredOutput\.fieldMap\.id/.test(err)), JSON.stringify(errors));
  assert.ok(check(channelWorker('other-map-v1', 'acme-stream-v1')).length > 0, 'another worker\'s map id is refused');
});
