'use strict';
// C2, the dual-scope reader (FR-002, NFR-002). Every case is hermetic: scopes are scratch
// directories and the real ~/.doflow is never read or written.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadRegistry } = require('../../src/registry');
const { stateRoot, ledgerPath, defaultLedger, writeLedger } = require('../../src/state');
const { defaultLock, writeLock, lockPath } = require('../../src/state/lockfile');
const { LIFECYCLE_HARNESSES } = require('../../src/lifecycle/view');
const { readScopes } = require('../../src/runtime/inventory/read-scopes');
const { buildInventoryReport } = require('../../src/runtime/inventory');

const REPO = path.resolve(__dirname, '../..');
const registry = loadRegistry({ repoRoot: REPO });

function scratch(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** Every path under `root`, each file with the sha256 of its bytes — a whole-tree snapshot, so an
 * added, removed, or rewritten file all show up as one inequality. Sorted, because directory order
 * is not a property under test. */
function treeHash(root) {
  const entries = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { entries.push(`dir ${rel}`); walk(full, rel); continue; }
      entries.push(`file ${rel} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  };
  walk(root, '');
  return entries;
}

/** The global scope root is derived from os.homedir() and is not an argument (design R7), so a
 * hermetic read of both scopes has to relocate the home directory for the duration of the call.
 * Synchronous, and restored in a finally, because readScopes is synchronous. Same helper A.1's
 * proof (test/lifecycle/dual-scope-read.test.js) uses. */
function withHomeDir(dir, fn) {
  const original = os.homedir;
  os.homedir = () => dir;
  try { return fn(); } finally { os.homedir = original; }
}

/** Seed one scope's neutral ledger with one resource per named harness, only that scope records. */
function seedScope({ scope, scopeRoot, assetId, harnesses = ['claude'] }) {
  const root = stateRoot({ scope, projectRoot: scopeRoot, homeDir: scopeRoot });
  const ledger = defaultLedger({ scope, scopeRoot });
  for (const harness of harnesses) {
    ledger.targets[harness] = { installed: true, lastUpdated: '2026-01-01T00:00:00.000Z' };
    ledger.resources.push({
      harness, scope, assetId, ownershipIdentity: `${harness}:${assetId}`,
      target: path.join(scopeRoot, `.${harness}`, 'skills', `${assetId}.md`),
      sourceVersion: 'test', fingerprint: null, projection: {}, recoveryRef: null, selection: null,
    });
  }
  writeLedger(root, ledger);
  return root;
}

function read({ homeDir, projectRoot, targets = ['claude'] }) {
  return withHomeDir(homeDir, () => readScopes({ registry, repoRoot: REPO, projectRoot, targets }));
}

const ids = (snapshot) => snapshot.resources.map((resource) => resource.assetId);

test('one invocation returns a snapshot per scope, with distinct roots and independent contents', () => {
  const homeDir = scratch('doflow-read-scopes-home-');
  const projectRoot = scratch('doflow-read-scopes-project-');
  seedScope({ scope: 'global', scopeRoot: homeDir, assetId: 'global.only.asset' });
  seedScope({ scope: 'project', scopeRoot: projectRoot, assetId: 'project.only.asset' });

  const { global, project, scopes } = read({ homeDir, projectRoot });

  assert.deepEqual(scopes, [global, project], 'scopes lists both snapshots');
  assert.equal(global.scope, 'global');
  assert.equal(project.scope, 'project');
  assert.equal(global.scopeRoot, path.resolve(homeDir));
  assert.equal(project.scopeRoot, path.resolve(projectRoot));
  assert.notEqual(global.scopeRoot, project.scopeRoot);
  assert.equal(global.stateRoot, path.join(homeDir, '.doflow', 'state'));
  assert.equal(project.stateRoot, path.join(projectRoot, '.doflow', 'state'));
  assert.deepEqual(ids(global), ['global.only.asset']);
  assert.deepEqual(ids(project), ['project.only.asset']);
  assert.ok(global.recorded && project.recorded, 'both scopes have something recorded');
});

test('neither scope leaks into the other', () => {
  const homeDir = scratch('doflow-read-scopes-home-');
  const projectRoot = scratch('doflow-read-scopes-project-');
  seedScope({ scope: 'global', scopeRoot: homeDir, assetId: 'global.only.asset' });
  seedScope({ scope: 'project', scopeRoot: projectRoot, assetId: 'project.only.asset' });

  const { global, project } = read({ homeDir, projectRoot });

  assert.ok(!ids(global).includes('project.only.asset'));
  assert.ok(!ids(project).includes('global.only.asset'));
  assert.equal(global.ledger.scope, 'global');
  assert.equal(project.ledger.scope, 'project');
  assert.ok(global.plan !== project.plan, 'each scope is planned independently');
});

test('a scope with nothing recorded is an empty snapshot, not an error, and creates no file (NFR-002)', () => {
  const homeDir = scratch('doflow-read-scopes-empty-home-');
  const projectRoot = scratch('doflow-read-scopes-empty-project-');

  const { global, project } = read({ homeDir, projectRoot });

  for (const snapshot of [global, project]) {
    assert.equal(snapshot.recorded, false, `${snapshot.scope} has nothing recorded`);
    assert.deepEqual(snapshot.resources, []);
    assert.deepEqual(snapshot.ledger, defaultLedger({ scope: snapshot.scope, scopeRoot: snapshot.scopeRoot }));
    assert.equal(fs.existsSync(snapshot.stateRoot), false, 'no state root is created');
    assert.equal(fs.existsSync(ledgerPath(snapshot.stateRoot)), false, 'reporting absence must not create a ledger');
  }
  assert.deepEqual(fs.readdirSync(homeDir), []);
  assert.deepEqual(fs.readdirSync(projectRoot), []);
});

test('one recorded scope beside one empty one — the ordinary state of a repository never installed into', () => {
  const homeDir = scratch('doflow-read-scopes-home-');
  const projectRoot = scratch('doflow-read-scopes-empty-project-');
  seedScope({ scope: 'global', scopeRoot: homeDir, assetId: 'global.only.asset' });

  const { global, project } = read({ homeDir, projectRoot });

  assert.equal(global.recorded, true);
  assert.deepEqual(ids(global), ['global.only.asset']);
  assert.equal(project.recorded, false);
  assert.deepEqual(project.resources, []);
});

test('reading is side-effect free: both ledgers on disk are byte-identical afterwards', () => {
  const homeDir = scratch('doflow-read-scopes-home-');
  const projectRoot = scratch('doflow-read-scopes-project-');
  const roots = [
    seedScope({ scope: 'global', scopeRoot: homeDir, assetId: 'global.only.asset' }),
    seedScope({ scope: 'project', scopeRoot: projectRoot, assetId: 'project.only.asset' }),
  ];
  const onDisk = () => roots.map((root) => fs.readFileSync(ledgerPath(root), 'utf8'));
  const tree = () => roots.map((root) => fs.readdirSync(root).sort());
  const before = { files: onDisk(), tree: tree() };

  const first = read({ homeDir, projectRoot });
  const second = read({ homeDir, projectRoot });

  assert.deepEqual(onDisk(), before.files, 'no ledger byte changed');
  assert.deepEqual(tree(), before.tree, 'no file was added to either state root');
  assert.deepEqual(second.global.ledger, first.global.ledger, 'a repeated read is unchanged');
  assert.deepEqual(second.project.ledger, first.project.ledger);
});

/**
 * NFR-001 at the verb level, not only at the reader's.
 *
 * The test above pins the reader: both ledgers are byte-identical afterwards and no file appears in
 * either state root. That is not the whole of NFR-001, because `buildInventoryReport` does two things
 * the reader does not — it reads each scope's lock, and it hands every recorded resource to
 * `inspectSiblings`, which `readdir`s the real destination directories those resources live in. So
 * the surface that could write reaches outside the state root, and nothing snapshotted that surface.
 *
 * Why a test rather than the by-hand check: the verification stage's manual attempt reported
 * SOMETHING CHANGED, and the changes turned out to be `~/.claude/history.jsonl` and
 * `~/.codex/models_cache.json` — the session's own noise. A live machine cannot separate the verb
 * from its environment. A temp fixture can, so this one uses scratch scope roots and never `$HOME`,
 * and never passes a scope selector.
 *
 * The fixture is `copilot`/`instructions.copilot` because `siblings.js` inspects a directory only
 * when the harness loads it wholesale, and that pair is one of the two it knows. A stray file sits
 * beside the managed ones at each scope, so the inspector reads two real directories and finds
 * something in both — a hermetic snapshot around a verb that inspected nothing would pass for the
 * wrong reason.
 */
test('NFR-001: assembling the whole report writes nothing — both scope trees hash identically afterwards', () => {
  const homeDir = scratch('doflow-inventory-readonly-home-');
  const projectRoot = scratch('doflow-inventory-readonly-project-');

  const seedCopilot = (scope, scopeRoot) => {
    const instructions = path.join(scopeRoot, '.github', 'instructions');
    fs.mkdirSync(instructions, { recursive: true });
    fs.writeFileSync(path.join(instructions, 'stray.instructions.md'), 'not ours');
    const resources = ['a', 'b'].map((letter) => {
      const name = `synthetic-041-${letter}.instructions.md`;
      const target = path.join(instructions, name);
      fs.writeFileSync(target, 'managed');
      return {
        harness: 'copilot', scope, assetId: 'instructions.copilot',
        ownershipIdentity: `doflow:copilot:copy-tree:instructions.copilot:${name}`,
        target, sourceVersion: 'test', fingerprint: 'sha256:0000000000000000',
        projection: {}, recoveryRef: null, selection: null,
      };
    });
    const ledger = defaultLedger({ scope, scopeRoot });
    ledger.targets.copilot = { installed: true, lastUpdated: '2026-01-01T00:00:00.000Z' };
    ledger.resources.push(...resources);
    writeLedger(stateRoot({ scope, projectRoot: scopeRoot, homeDir: scopeRoot }), ledger);
    // A lock, so the report's own lock read has a real file to find rather than only an absence.
    writeLock({ scope, homeDir: scopeRoot, projectRoot: scopeRoot },
      { ...defaultLock({ scope, scopeRoot }), targets: [{ harness: 'copilot' }] });
  };
  seedCopilot('global', homeDir);
  seedCopilot('project', projectRoot);

  const before = [treeHash(homeDir), treeHash(projectRoot)];

  const report = withHomeDir(homeDir, () => buildInventoryReport({
    repoRoot: REPO, projectRoot, targets: ['copilot'],
  }));

  assert.deepEqual([treeHash(homeDir), treeHash(projectRoot)], before,
    'no file under either scope root was added, removed, or changed by assembling the report. Every '
    + 'remedy the report states is text for the caller to run; the verb runs none of it (NFR-001)');

  // The fixture did reach the parts that could have written, so the snapshot above is not vacuous.
  assert.ok(report.assets.length > 0, 'the report joined the seeded copies into logical assets');
  assert.ok(report.assets.some((asset) => asset.unmanaged.length > 0),
    'and the sibling inspector read the real destination directories, which is the surface outside '
    + 'the state root that this snapshot exists to cover');
});

test('targets default to every lifecycle harness, so an inventory covers the whole install', () => {
  const homeDir = scratch('doflow-read-scopes-home-');
  const projectRoot = scratch('doflow-read-scopes-project-');

  const { global, project } = withHomeDir(homeDir, () => readScopes({ registry, repoRoot: REPO, projectRoot }));

  for (const snapshot of [global, project]) {
    assert.deepEqual(
      snapshot.plan.targets.map((target) => target.harness).sort(),
      [...LIFECYCLE_HARNESSES].sort(),
      `${snapshot.scope} plans every lifecycle harness`,
    );
  }
});

// ------------------------------------------------------- the restriction, and what the plan knows

test('the restriction bounds the resources, not only the plan: an unrequested harness is absent, not asserted current', () => {
  const homeDir = scratch('doflow-read-scopes-restrict-home-');
  const projectRoot = scratch('doflow-read-scopes-restrict-project-');
  seedScope({ scope: 'global', scopeRoot: homeDir, assetId: 'both.harnesses', harnesses: ['claude', 'gemini'] });

  const { global } = read({ homeDir, projectRoot, targets: ['claude'] });

  assert.deepEqual(global.targets, ['claude'], 'the snapshot states what it was read for');
  assert.deepEqual(global.resources.map((resource) => resource.harness), ['claude'],
    'a resource of a harness the plan never looked at must not be returned beside that plan: it is '
    + 'what let the report assert every unrequested harness\'s copy as current (IC-001 makes `targets` '
    + 'a restriction, so a harness outside it is not part of what was asked)');
  assert.deepEqual(global.plan.targets.map((target) => target.harness), ['claude'],
    'the plan is restricted to the same set — resources and plan must not disagree about the subject');
  assert.deepEqual(global.ledger.resources.map((resource) => resource.harness), ['claude', 'gemini'],
    'the ledger itself is passed through whole and unfiltered; only `resources` is restricted');
  assert.equal(global.recorded, true,
    '`recorded` describes the scope, not the restriction: this scope holds an install, and reporting '
    + 'it absent because the restriction matched only part of it would be false');
});

/**
 * The plan is what a currency judgement is read from, so it has to be the plan the repair command
 * would produce. `planLifecycle` derives a harness's MCP servers from the ids it is handed, and an
 * empty list is a positive statement that none was chosen — not a neutral default. This reader
 * therefore takes them from each scope's own `doflow.lock`, exactly as `reconcile` does.
 *
 * Both halves are asserted here because only the pair is the property: with the lock's selection the
 * plan leaves the recorded server alone; without it, the plan proposes to delete it. Defaulting to
 * the empty list made the second case the only case, and the report labelled those removals
 * `diverged` with a remedy promising to restore them.
 */
test('a scope\'s recorded MCP selections reach the plan its currency is derived from', () => {
  const selected = codexMcpScope({ mcpSelections: { codex: ['context7'] } });
  const deselected = codexMcpScope({ mcpSelections: {} });

  const withSelection = readCodex(selected);
  assert.deepEqual(withSelection.plan.mcp.map((server) => server.id), ['context7'],
    'the plan resolves the servers the lock pinned');
  assert.deepEqual(changesFor(withSelection, selected.ownershipIdentity), [],
    'the recorded server is installed and still selected, so the plan proposes nothing for it');

  const withoutSelection = readCodex(deselected);
  assert.deepEqual(withoutSelection.plan.mcp, [],
    'a lock recording no selection resolves no server — which is a read fact, not this reader\'s default');
  assert.deepEqual(changesFor(withoutSelection, deselected.ownershipIdentity), ['remove'],
    'with no selection the plan proposes to DELETE the registered server. That is the change the '
    + 'currency judgement used to read as a divergence, so this fixture is the one that must keep '
    + 'producing it for the verb-level assertion to mean anything');
});

test('a scope with no lock reads without error, resolves no selection, and creates no lock', () => {
  const homeDir = scratch('doflow-read-scopes-nolock-home-');
  const projectRoot = scratch('doflow-read-scopes-nolock-project-');
  seedScope({ scope: 'global', scopeRoot: homeDir, assetId: 'global.only.asset' });

  // No `locks` argument: each scope's lock is read from disk, and neither scope has one.
  const { global, project } = withHomeDir(homeDir, () => readScopes({
    registry, repoRoot: REPO, projectRoot, targets: ['claude'],
  }));

  for (const snapshot of [global, project]) {
    assert.deepEqual(snapshot.plan.mcp, [], `${snapshot.scope} resolves no MCP server`);
  }
  assert.equal(fs.existsSync(lockPath({ scope: 'global', homeDir })), false, 'reading created no global lock');
  assert.equal(fs.existsSync(lockPath({ scope: 'project', projectRoot })), false, 'reading created no project lock');
});

// ------------------------------------------------------------------- the codex MCP fixture

/** `src/adapters/codex/config.js` fingerprints a managed block as sha256 of its JSON encoding. The
 * removal branch of `planCodexMcp` compares the recorded fingerprint with the block on disk, so the
 * fixture has to record the same form an install would. */
function mcpFingerprint(block) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(block)).digest('hex')}`;
}

/** A global scope holding one registered, DoFlow-owned Codex MCP server: the block in config.toml,
 * the ledger row that owns it, and a lock whose `mcpSelections` the caller chooses. */
function codexMcpScope({ mcpSelections }) {
  const homeDir = scratch('doflow-read-scopes-mcp-home-');
  const projectRoot = scratch('doflow-read-scopes-mcp-project-');
  const block = '[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\n';
  const configFile = path.join(homeDir, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, block);

  const ownershipIdentity = 'doflow:codex:mcp-server:context7';
  const ledger = defaultLedger({ scope: 'global', scopeRoot: homeDir });
  ledger.targets.codex = { installed: true, lastUpdated: '2026-01-01T00:00:00.000Z' };
  ledger.resources.push({
    harness: 'codex', scope: 'global', assetId: 'guidance.codex-pointer', kind: 'mcp-server',
    identity: 'context7', target: configFile, ownershipIdentity, fingerprint: mcpFingerprint(block),
    sourceVersion: 'test', selection: true, recoveryRef: null, projection: { renderer: 'codex-mcp' },
  });
  writeLedger(stateRoot({ scope: 'global', projectRoot: homeDir, homeDir }), ledger);

  const lock = { ...defaultLock({ scope: 'global', scopeRoot: homeDir }), targets: [{ harness: 'codex' }], mcpSelections };
  writeLock({ scope: 'global', homeDir }, lock);
  return { homeDir, projectRoot, configFile, ownershipIdentity, lock };
}

function readCodex({ homeDir, projectRoot, lock }) {
  return withHomeDir(homeDir, () => readScopes({
    registry, repoRoot: REPO, projectRoot, targets: ['codex'], locks: { global: lock, project: null },
  })).global;
}

/** The operations this scope's plan proposes for one recorded resource, by its ownership identity. */
function changesFor(snapshot, ownershipIdentity) {
  return snapshot.plan.changes
    .filter((change) => change.ownershipIdentity === ownershipIdentity)
    .map((change) => change.operation);
}
