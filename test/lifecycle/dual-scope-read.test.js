'use strict';
// Proof for design risk R1 (feature 041-cross-scope-inventory): the scope-resolved lifecycle view
// has exactly one call site, which resolves scope once as a boolean, so it has never been invoked
// twice in one process. The cross-scope inventory's dual-scope reader (C2) depends on exactly that,
// so it is proven here before anything is built on it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRegistry } = require('../../src/registry');
const { stateRoot, ledgerPath, defaultLedger, writeLedger } = require('../../src/state');
const { registryLifecycleView } = require('../../src/lifecycle/view');

const REPO = path.resolve(__dirname, '../..');
const registry = loadRegistry({ repoRoot: REPO });

function scratch(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** The view derives a global scopeRoot from os.homedir() rather than from its scope descriptor, so
 * a hermetic global-scope read has to relocate the home directory for the duration of the call.
 * Synchronous, and restored in a finally, because the view is synchronous. */
function withHomeDir(dir, fn) {
  const original = os.homedir;
  os.homedir = () => dir;
  try { return fn(); } finally { os.homedir = original; }
}

function ownedResource({ scope, scopeRoot, assetId }) {
  return {
    harness: 'claude', scope, assetId, ownershipIdentity: assetId,
    target: path.join(scopeRoot, '.claude', 'skills', `${assetId}.md`),
    sourceVersion: 'test', fingerprint: null, projection: {}, recoveryRef: null, selection: null,
  };
}

/** Seed one scope's neutral ledger with a single resource only that scope records. */
function seedScope({ scope, scopeRoot, assetId }) {
  const root = stateRoot({ scope, projectRoot: scopeRoot, homeDir: scopeRoot });
  const ledger = defaultLedger({ scope, scopeRoot });
  ledger.targets.claude = { installed: true, lastUpdated: '2026-01-01T00:00:00.000Z' };
  ledger.resources.push(ownedResource({ scope, scopeRoot, assetId }));
  writeLedger(root, ledger);
  return root;
}

function readGlobal(homeDir) {
  return withHomeDir(homeDir, () => registryLifecycleView({
    registry, repoRoot: REPO, scope: { global: true }, targets: ['claude'], mcpIds: [],
  }));
}

function readProject(projectRoot) {
  return registryLifecycleView({
    registry, repoRoot: REPO, scope: { global: false, projectRoot }, targets: ['claude'], mcpIds: [],
  });
}

test('the lifecycle view called twice in one process with two scope descriptors returns two independent results', () => {
  const homeDir = scratch('doflow-dual-scope-home-');
  const projectRoot = scratch('doflow-dual-scope-project-');
  seedScope({ scope: 'global', scopeRoot: homeDir, assetId: 'global.only.asset' });
  seedScope({ scope: 'project', scopeRoot: projectRoot, assetId: 'project.only.asset' });

  const global = readGlobal(homeDir);
  const project = readProject(projectRoot);

  assert.notEqual(global.stateRoot, project.stateRoot, 'each scope resolves its own neutral state root');
  assert.equal(global.stateRoot, path.join(homeDir, '.doflow', 'state'));
  assert.equal(project.stateRoot, path.join(projectRoot, '.doflow', 'state'));
  assert.equal(global.ledger.scope, 'global');
  assert.equal(project.ledger.scope, 'project');
  assert.notEqual(global.ledger.scopeRoot, project.ledger.scopeRoot);
  assert.deepEqual(global.ledger.resources.map((resource) => resource.assetId), ['global.only.asset']);
  assert.deepEqual(project.ledger.resources.map((resource) => resource.assetId), ['project.only.asset']);
  assert.ok(global.plan.targets.length === 1 && project.plan.targets.length === 1, 'each call plans independently');
});

test('neither scope read leaks into the other, in either order, and neither call writes to either scope', () => {
  const homeDir = scratch('doflow-dual-scope-home-');
  const projectRoot = scratch('doflow-dual-scope-project-');
  const globalStateRoot = seedScope({ scope: 'global', scopeRoot: homeDir, assetId: 'global.only.asset' });
  const projectStateRoot = seedScope({ scope: 'project', scopeRoot: projectRoot, assetId: 'project.only.asset' });
  const onDisk = () => [globalStateRoot, projectStateRoot].map((root) => fs.readFileSync(ledgerPath(root), 'utf8'));
  const before = onDisk();

  // Interleaved: project, global, then project again. A cached or mutated read shows up as the
  // third result disagreeing with the first.
  const firstProject = readProject(projectRoot);
  const global = readGlobal(homeDir);
  const secondProject = readProject(projectRoot);

  const ids = (view) => view.ledger.resources.map((resource) => resource.assetId);
  assert.ok(!ids(global).includes('project.only.asset'), 'the project resource must not appear in the global result');
  assert.ok(!ids(firstProject).includes('global.only.asset'), 'the global resource must not appear in the project result');
  assert.deepEqual(ids(secondProject), ids(firstProject), 're-reading a scope after reading the other is unchanged');
  assert.deepEqual(secondProject.ledger, firstProject.ledger);
  assert.equal(secondProject.stateRoot, firstProject.stateRoot);
  assert.deepEqual(onDisk(), before, 'the view is read-only: neither ledger on disk changed');
});

test('a scope with nothing recorded yields the default empty ledger rather than throwing (NFR-002)', () => {
  const emptyHome = scratch('doflow-dual-scope-empty-home-');
  const emptyProject = scratch('doflow-dual-scope-empty-project-');

  const global = readGlobal(emptyHome);
  const project = readProject(emptyProject);

  assert.deepEqual(global.ledger, defaultLedger({ scope: 'global', scopeRoot: emptyHome }));
  assert.deepEqual(project.ledger, defaultLedger({ scope: 'project', scopeRoot: emptyProject }));
  assert.deepEqual(project.ledger.resources, []);
  assert.equal(fs.existsSync(ledgerPath(project.stateRoot)), false, 'reporting an absent ledger must not create one');
});

test('a global scope descriptor takes its root from os.homedir(), not from the descriptor', () => {
  // The constraint the dual-scope reader has to work within: the global root is not an argument.
  // A caller wanting both scopes in one process supplies the project root and inherits the home
  // directory for the global one.
  const homeDir = scratch('doflow-dual-scope-home-');
  const projectRoot = scratch('doflow-dual-scope-project-');
  seedScope({ scope: 'global', scopeRoot: homeDir, assetId: 'global.only.asset' });
  seedScope({ scope: 'project', scopeRoot: projectRoot, assetId: 'project.only.asset' });

  const view = withHomeDir(homeDir, () => registryLifecycleView({
    registry, repoRoot: REPO, scope: { global: true, projectRoot }, targets: ['claude'], mcpIds: [],
  }));

  assert.equal(view.stateRoot, path.join(homeDir, '.doflow', 'state'), 'projectRoot is ignored for a global descriptor');
  assert.deepEqual(view.ledger.resources.map((resource) => resource.assetId), ['global.only.asset']);
});
