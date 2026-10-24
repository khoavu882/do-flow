'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScratch } = require('../helper/scratch-env.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { planPackage, applyPlan } = require('../../src/runtime/packages/store.ts');
const { packageView, resetPackageView } = require('../../src/runtime/packages/view.ts');
const { readLock, writeLock, lockPackages } = require('../../src/state/lockfile.ts');
const { workerCatalogue, descriptorDigest } = require('../../src/runtime/worker/catalogue.ts');
const { select } = require('../../src/runtime/worker/readiness.ts');
const { POINT_VALIDATORS } = require('../../src/runtime/packages/points.ts');
const { PARSERS } = require('../../src/runtime/worker/parsers.ts');

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
    steering: {
      status: 'unknown',
      evidence: [],
      verification: 'Check steering',
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
  for (const id of ['claude', 'codex', 'gemini', 'antigravity', 'pi', 'opencode', 'copilot', 'kiro']) {
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

test('a parser id not in PARSERS is refused by worker-v1 validator', () => {
  const badWorker = validWorkerJson();
  badWorker.structuredOutput.parser = 'nonexistent-parser';
  assert.equal(Object.hasOwn(PARSERS, 'nonexistent-parser'), false);

  const errors = POINT_VALIDATORS['worker-v1']('mycli', badWorker, { packageId: 'acme' });
  assert.ok(errors.some((err: string) => /parser 'nonexistent-parser' is not a registered core parser/.test(err)));
});
