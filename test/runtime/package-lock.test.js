'use strict';
// Design R6 (122 IC-007): a global lock created only to hold packages has `targets: []`. DoFlow reads
// `targets`, the ledger and the install manifest to decide what is installed, never the presence of a
// lock, so such a lock must read as "not installed globally" in status, inventory and reconcile.
// Hermetic: HOME is a scratch directory, so the real ~/.doflow is never read or written.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { defaultLock, writeLock, readLock, lockPath, lockPackages } = require('../../src/state/lockfile.ts');
const { readScopeLocks, repairCoverage, REPAIR_REASONS } = require('../../src/runtime/inventory/coverage.ts');

const REPO = path.resolve(__dirname, '../..');
const BIN = path.join(REPO, 'bin', 'doflow.js');

const ACME = {
  id: 'acme', version: '1.2.0', source: { type: 'local', path: '/abs/acme' },
  contentDigest: 'a'.repeat(64), capabilityDigest: 'b'.repeat(64), enabled: false, addedAt: '2026-10-24T09:00:00.000Z',
};

/** A scratch home holding a packages-only global lock, as `package add` leaves it before any install. */
function packagesOnlyHome(t) {
  const home = tempDir(t, 'doflow-pkglock-home-');
  writeLock({ scope: 'global', homeDir: home }, { ...defaultLock({ scope: 'global', scopeRoot: home }), packages: [ACME] });
  return home;
}

function doflow(home, args) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  delete env.PI_CODING_AGENT_DIR;
  const result = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', cwd: home });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test('the fixture is a v2 global lock with no targets and one package', (t) => {
  const home = packagesOnlyHome(t);
  const lock = readLock({ scope: 'global', homeDir: home });
  assert.equal(lock.version, 2);
  assert.deepEqual(lock.targets, []);
  assert.deepEqual(lockPackages(lock), [ACME]);
  assert.equal(fs.existsSync(lockPath({ scope: 'global', homeDir: home })), true);
});

test('R6 status: doflow status --global reads the packages-only lock as not installed', (t) => {
  const home = packagesOnlyHome(t);
  const json = doflow(home, ['status', '--global', '--json']);
  assert.equal(json.code, 0, json.err);
  const report = JSON.parse(json.out);
  assert.equal(report.manifest, null, 'no install manifest, so nothing is installed');
  assert.equal(report.context.claude.status, 'not-installed');
  assert.deepEqual(report.context.claude.resources, []);
  assert.deepEqual(report.mcpSelections, { claude: null }, 'no MCP row is pinned by a lock with no targets');

  const text = doflow(home, ['status', '--global']);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /No install manifest found/);
});

test('R6 inventory: the global scope is absent with no pinned target, and nothing in it is repairable', (t) => {
  const home = packagesOnlyHome(t);
  const project = tempDir(t, 'doflow-pkglock-project-');
  const run = doflow(home, ['inventory', '--json', project]);
  assert.equal(run.code, 0, run.err);
  const report = JSON.parse(run.out);
  assert.equal(report.status, 'CLEAN');
  const global = report.scopes.find((scope) => scope.scope === 'global');
  assert.equal(global.present, false);
  assert.equal(global.resources, 0);
  assert.deepEqual(report.assets, []);
  assert.deepEqual(report.repairCoverage.scopes.global, { scope: 'global', lock: 'empty', pinned: false, targets: [], findings: 0, repairable: 0 });
});

test('R6 inventory coverage: a finding in the packages-only scope is not repairable by reconcile', (t) => {
  const home = packagesOnlyHome(t);
  const project = tempDir(t, 'doflow-pkglock-project-');
  const locks = readScopeLocks({ projectRoot: project, homeDir: home });
  assert.equal(lockPackages(locks.global).length, 1);
  const coverage = repairCoverage({ findings: [{ id: 'skills.doflow', harness: 'claude', scope: 'global', repairPath: 'reconcile' }], locks });
  assert.equal(coverage.scopes.global.lock, 'empty');
  assert.equal(coverage.scopes.global.pinned, false);
  assert.equal(coverage.repairable, 0);
  assert.deepEqual(coverage.reasons, { [REPAIR_REASONS.SCOPE_NOT_PINNED]: 1 });
});

test('R6 reconcile: the packages-only lock pins nothing to reconcile against', (t) => {
  const home = packagesOnlyHome(t);
  const run = doflow(home, ['reconcile', '--global']);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /nothing pinned to reconcile against/);
  // reconcile left the packages where they were
  assert.deepEqual(lockPackages(readLock({ scope: 'global', homeDir: home })), [ACME]);
});
