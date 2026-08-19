'use strict';

// Regression fixture for the real Codex lifecycle sequence. Keep this test at
// the orchestration boundary: unit tests of individual reconcilers pass, while
// this sequence currently exposes a remove-time verification mismatch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRegistry } = require('../../src/registry');
const { createAdapterRegistry } = require('../../src/adapters');
const { planLifecycle, applyLifecycle, removeLifecycle } = require('../../src/lifecycle');
const { stateRoot, readLedger, recoveryRoot } = require('../../src/state');
const claude = require('../../src/adapters/claude');
const codex = require('../../src/adapters/codex');
const { createGeminiAdapter } = require('../../src/adapters/gemini');

const REPO = path.resolve(__dirname, "../..");

function fixture() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-codex-e2e-'));
  const registry = loadRegistry({ repoRoot: REPO });
  const adapters = createAdapterRegistry({ claude, codex, gemini: createGeminiAdapter() });
  const context = { repoRoot: REPO, projectRoot: project, homeDir: project, sourceVersion: '2.4.4' };
  const root = stateRoot({ scope: 'project', projectRoot: project });
  return { project, registry, adapters, context, root };
}

function plan({ registry, adapters, project, context, ledger, mcpIds }) {
  return planLifecycle({ registry, adapters, scope: 'project', scopeRoot: project,
    targets: ['codex'], mcpIds, ledger, context });
}

function diagnostics(root, project) {
  const recoveries = fs.existsSync(recoveryRoot(root))
    ? fs.readdirSync(recoveryRoot(root)).sort().map((file) => JSON.parse(fs.readFileSync(path.join(recoveryRoot(root), file), 'utf8')))
    : [];
  const config = path.join(project, '.codex', 'config.toml');
  return {
    ledger: readLedger(root),
    config: fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : null,
    recoveries: recoveries.map((record) => ({ id: record.id, status: record.status, verification: record.verification })),
  };
}

test('Codex lifecycle install -> MCP update -> guarded user edit -> remove verifies and updates the ledger', () => {
  const run = fixture();
  let current = plan({ ...run, mcpIds: ['context7'] });
  assert.equal(current.safe, true, JSON.stringify(current.conflicts));
  applyLifecycle({ plan: current, registry: run.registry, adapters: run.adapters, stateRoot: run.root });

  let ledger = readLedger(run.root);
  current = plan({ ...run, ledger, mcpIds: ['sequential-thinking'] });
  assert.equal(current.safe, true, JSON.stringify(current.conflicts));
  applyLifecycle({ plan: current, registry: run.registry, adapters: run.adapters, stateRoot: run.root, ledger });
  ledger = readLedger(run.root);

  const config = path.join(run.project, '.codex', 'config.toml');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('hooks = true', 'hooks = false'));
  const conflict = plan({ ...run, ledger, mcpIds: ['sequential-thinking'] });
  assert.equal(conflict.safe, false, 'a user-modified managed key must block lifecycle mutation');
  assert.match(JSON.stringify(conflict.conflicts), /modified outside DoFlow/);
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('hooks = false', 'hooks = true'));

  let removed;
  let failure;
  try {
    removed = removeLifecycle({ registry: run.registry, adapters: run.adapters, scope: 'project', scopeRoot: run.project,
      targets: ['codex'], mcpIds: ['sequential-thinking'], stateRoot: run.root, ledger, context: run.context });
  } catch (error) {
    failure = error;
  }
  assert.ifError(failure && new Error(`${failure.message}\n${JSON.stringify(diagnostics(run.root, run.project), null, 2)}`));
  assert.equal(removed.ledger.resources.length, 0);
  assert.ok(diagnostics(run.root, run.project).recoveries.every((record) => record.status === 'verified'));
});
