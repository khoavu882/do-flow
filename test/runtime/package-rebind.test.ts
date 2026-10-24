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
const { workerCatalogue } = require('../../src/runtime/worker/catalogue.ts');
const { knownWorkerIds } = require('../../src/registry/worker-ids.ts');
const { readWorkerBilling } = require('../../src/runtime/settings/worker-billing.ts');
const { handlePackageCommand } = require('../../src/runtime/packages/command.ts');

const NO_TMP = '/nonexistent-doflow-tmp';

function makeWorkerPackage(srcDir: string) {
  fs.mkdirSync(path.join(srcDir, 'workers'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'doflow-package.json'), JSON.stringify({
    manifest: 1,
    id: 'acme',
    version: '1.0.0',
    doflow: '>=2.0.0-beta.1 <3.0.0',
    programs: [{ id: 'mycli', binary: 'mycli', argv: 'worker-recipe' }],
    contributions: [{ point: 'worker', version: 1, id: 'mycli', file: 'workers/mycli.json', programs: ['mycli'] }],
  }, null, 2));

  fs.writeFileSync(path.join(srcDir, 'workers', 'mycli.json'), JSON.stringify({
    profile: null,
    billing: 'unknown',
    family: 'custom',
    cli: { status: 'supported', evidence: ['test'], verification: 'v', verifiedOn: '2026-10-24', binary: 'mycli', versionArgv: ['--version'] },
    oneShot: { status: 'supported', evidence: ['test'], verification: 'v', verifiedOn: '2026-10-24', argv: ['{prompt}'], promptVia: 'argv' },
    structuredOutput: { status: 'supported', evidence: ['test'], verification: 'v', verifiedOn: '2026-10-24', argv: [], parser: 'doflow-jsonl-v1' },
    readOnly: { status: 'unknown', evidence: [], verification: 'v', verifiedOn: '2026-10-24', reason: 'test' },
    spawnDenial: { status: 'unknown', evidence: [], verification: 'v', verifiedOn: '2026-10-24', reason: 'test' },
    runnableProbe: { status: 'unknown', evidence: [], verification: 'v', verifiedOn: '2026-10-24', reason: 'test' },
    hooksProbe: { status: 'unknown', evidence: [], verification: 'v', verifiedOn: '2026-10-24', reason: 'test' },
    guidanceProbe: { status: 'unknown', evidence: [], verification: 'v', verifiedOn: '2026-10-24', reason: 'test' },
    loginProbe: { status: 'unknown', evidence: [], verification: 'v', verifiedOn: '2026-10-24', reason: 'test' },
    persistentSession: { status: 'unknown', evidence: [], verification: 'v', verifiedOn: '2026-10-24', reason: 'test' },
    resume: { status: 'unknown', evidence: [], verification: 'v', verifiedOn: '2026-10-24', reason: 'test' },
    steering: { status: 'unknown', evidence: [], verification: 'v', verifiedOn: '2026-10-24', reason: 'test' },
    modelChecks: [],
  }, null, 2));

  fs.writeFileSync(path.join(srcDir, 'README.md'), '# Acme\n');
}

test('D.4 rebind lifecycle: tombstone excludes worker until fresh rebind confirmation', (t: any) => {
  const scratch = createScratch('doflow-rebind-');
  t.after(() => scratch.remove());

  const srcDir = path.join(scratch.dir, 'pkg-src');
  makeWorkerPackage(srcDir);

  const grantsFile = path.join(scratch.xdg, 'doflow', 'packages', 'grants.jsonl');
  const userSettings = path.join(scratch.xdg, 'doflow', 'settings.json');
  fs.mkdirSync(path.dirname(userSettings), { recursive: true });

  // 1. Initial add & plan
  const plan1 = planPackage({ action: 'add', source: srcDir, homeDir: scratch.home, repoRoot: REPO_ROOT, now: Date.parse('2026-10-24T10:00:00Z') });
  assert.equal(plan1.ok, true);
  applyPlan({ planId: plan1.plan.planId, action: 'add', homeDir: scratch.home, repoRoot: REPO_ROOT, env: scratch.env() });

  // Enable package
  const lockOpts = { scope: 'global', homeDir: scratch.home };
  writeLock(lockOpts, { ...readLock(lockOpts), packages: lockPackages(readLock(lockOpts)).map((r: any) => ({ ...r, enabled: true })) });

  // Append initial trust line
  fs.mkdirSync(path.dirname(grantsFile), { recursive: true });
  fs.writeFileSync(grantsFile, `${plan1.plan.grantLines.trust}\n`);

  // Negative control: first add with no tombstone needs no rebind
  resetPackageView();
  let view = packageView({ repoRoot: REPO_ROOT, homeDir: scratch.home, env: scratch.env(), tmpDir: NO_TMP });
  let cat = workerCatalogue({ view, repoRoot: REPO_ROOT });
  assert.ok(cat.some((e: any) => e.id === 'acme.mycli'), 'acme.mycli present on initial add');

  // Configure user settings: workers.billing free, workers.enabled place
  fs.writeFileSync(userSettings, JSON.stringify({
    'workers.billing': { 'acme.mycli': { billing: 'free', asserted: '2026-10-24' } },
    'workers.enabled': ['claude', 'acme.mycli'],
  }, null, 2));

  let billing = readWorkerBilling(scratch.env(), { workerIds: knownWorkerIds({ view }).ids });
  assert.equal(billing.state, 'set');
  assert.equal(billing.workers['acme.mycli']?.billing, 'free');

  // 2. Remove package
  handlePackageCommand({
    action: 'remove',
    id: 'acme',
    homeDir: scratch.home,
    repoRoot: REPO_ROOT,
    env: scratch.env(),
    tmpDir: NO_TMP,
    now: Date.parse('2026-10-24T11:00:00Z'),
    out: () => {},
  });

  // 3. Re-add package and append plain trust line (no rebind)
  const plan2 = planPackage({ action: 'add', source: srcDir, homeDir: scratch.home, repoRoot: REPO_ROOT, now: Date.parse('2026-10-24T12:00:00Z') });
  applyPlan({ planId: plan2.plan.planId, action: 'add', homeDir: scratch.home, repoRoot: REPO_ROOT, env: scratch.env() });
  writeLock(lockOpts, { ...readLock(lockOpts), packages: lockPackages(readLock(lockOpts)).map((r: any) => ({ ...r, enabled: true })) });

  // Write plain trust line dated after removal (at 12:00:00Z)
  fs.writeFileSync(grantsFile, `${plan2.plan.grantLines.trust}\n`);

  resetPackageView();
  view = packageView({ repoRoot: REPO_ROOT, homeDir: scratch.home, env: scratch.env(), tmpDir: NO_TMP });
  cat = workerCatalogue({ view, repoRoot: REPO_ROOT });

  // Catalogue omits acme.mycli and reports rebind-required finding
  assert.equal(cat.some((e: any) => e.id === 'acme.mycli'), false, 'tombstoned acme.mycli omitted from catalogue');
  assert.ok(view.findings.some((f: any) => f.code === 'rebind-required'), 'rebind-required finding present');

  // Billing resolves invalid: unknown-worker:acme.mycli
  billing = readWorkerBilling(scratch.env(), { workerIds: knownWorkerIds({ view }).ids });
  assert.equal(billing.state, 'invalid');
  assert.equal(billing.reason, 'unknown-worker:acme.mycli');

  // Verify trust command output includes rebind key and note of settings that would apply again
  const trustOut: string[] = [];
  handlePackageCommand({
    action: 'trust',
    id: 'acme',
    homeDir: scratch.home,
    repoRoot: REPO_ROOT,
    env: scratch.env(),
    tmpDir: NO_TMP,
    now: Date.parse('2026-10-24T12:30:00Z'),
    out: (line: string) => trustOut.push(line),
  });
  const trustPrinted = trustOut.join('\n');
  assert.ok(trustPrinted.includes('"rebind":["acme.mycli"]'), 'trust prints rebind key in grant');
  assert.ok(trustOut.some((line: string) => line.includes('rebind setting would apply again') && line.includes('workers.billing')), 'trust lists rebind settings that would apply again');

  let jsonTrustOut = '';
  handlePackageCommand({
    action: 'trust',
    id: 'acme',
    homeDir: scratch.home,
    repoRoot: REPO_ROOT,
    env: scratch.env(),
    tmpDir: NO_TMP,
    json: true,
    now: Date.parse('2026-10-24T12:30:00Z'),
    out: (s: string) => { jsonTrustOut += s; },
  });
  const jsonTrust = JSON.parse(jsonTrustOut);
  assert.deepEqual(jsonTrust.rebind, ['acme.mycli']);

  // 4. Re-trust with rebind key dated after tombstone
  const reboundGrant = JSON.stringify({
    grant: 'trust',
    package: 'acme',
    version: '1.0.0',
    contentDigest: plan2.plan.contentDigest,
    capabilityDigest: plan2.plan.capabilityDigest,
    policy: plan2.plan.trustPolicyVersion,
    at: '2026-10-24T13:00:00Z',
    rebind: ['acme.mycli'],
  });
  fs.writeFileSync(grantsFile, `${reboundGrant}\n`);

  resetPackageView();
  view = packageView({ repoRoot: REPO_ROOT, homeDir: scratch.home, env: scratch.env(), tmpDir: NO_TMP });
  cat = workerCatalogue({ view, repoRoot: REPO_ROOT });

  // acme.mycli back in catalogue, billing resolves free again
  assert.ok(cat.some((e: any) => e.id === 'acme.mycli'), 'acme.mycli present after rebind');
  billing = readWorkerBilling(scratch.env(), { workerIds: knownWorkerIds({ view }).ids });
  assert.equal(billing.state, 'set');
  assert.equal(billing.workers['acme.mycli']?.billing, 'free');
});
