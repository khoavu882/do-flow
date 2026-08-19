'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRegistry } = require('../src/registry');
const {
  codexScope, registryLifecycleView, printRegistryLifecycle, LIFECYCLE_HARNESSES, assertSafeRegistryPlan,
} = require('../src/lifecycle/view');

const REPO = path.resolve(__dirname, '..');

function scratchProject() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lifecycle-view-')); }

test('codexScope maps {global} to Codex\'s "global"/"project" scope names', () => {
  assert.equal(codexScope({ global: true }), 'global');
  assert.equal(codexScope({ global: false }), 'project');
});

test('LIFECYCLE_HARNESSES names exactly the seven harnesses the registry/lifecycle path covers', () => {
  assert.deepEqual(LIFECYCLE_HARNESSES, ['claude', 'codex', 'gemini', 'opencode', 'pi', 'copilot', 'kiro']);
});

test('registryLifecycleView computes a fresh-install plan for every requested harness from a real registry', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const projectRoot = scratchProject();
  const view = registryLifecycleView({
    registry, repoRoot: REPO, scope: { global: false, projectRoot }, targets: ['claude', 'codex', 'gemini'], mcpIds: [],
  });
  assert.equal(view.registry, registry);
  assert.equal(typeof view.stateRoot, 'string');
  assert.deepEqual(view.ledger.resources, [], 'a never-installed scratch project has an empty ledger');
  assert.equal(view.plan.targets.length, 3);
  assert.ok(view.plan.targets.every((target) => target.changes.length > 0), 'every harness has pending changes for a fresh scratch project');
  assert.equal(view.plan.safe, true, 'a fresh install with no foreign conflicts must be a safe plan');
});

test('registryLifecycleView narrows to only the requested targets', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const projectRoot = scratchProject();
  const view = registryLifecycleView({
    registry, repoRoot: REPO, scope: { global: false, projectRoot }, targets: ['claude'], mcpIds: [],
  });
  assert.deepEqual(view.plan.targets.map((target) => target.harness), ['claude']);
});

function captureConsole(fn, key) {
  const original = console[key];
  const lines = [];
  console[key] = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console[key] = original; }
  return lines;
}

test('printRegistryLifecycle summarizes change/conflict/prerequisite counts per harness', () => {
  const view = {
    stateRoot: '/tmp/does-not-matter/state',
    plan: {
      changes: [{}, {}], conflicts: [], prerequisites: [],
      targets: [
        { harness: 'claude', changes: [{}, {}], conflicts: [] },
        { harness: 'codex', changes: [], conflicts: ['fingerprint mismatch'] },
      ],
    },
  };
  const lines = captureConsole(() => printRegistryLifecycle(view, '[DRY]'), 'log');
  assert.ok(lines.some((line) => line.includes('2 native change(s), 0 conflict(s), 0 prerequisite(s)')));
  assert.ok(lines.some((line) => line.includes('claude: 2 change(s)')));
  assert.ok(lines.some((line) => line.includes('codex: 0 change(s); conflicts: fingerprint mismatch')));
});

test('assertSafeRegistryPlan is a no-op for a safe plan', () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    assertSafeRegistryPlan({ plan: { safe: true, conflicts: [], prerequisites: [] } });
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('assertSafeRegistryPlan reports conflicts/prerequisites and sets a failing exit code for an unsafe plan', () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const lines = captureConsole(() => assertSafeRegistryPlan({
      plan: {
        safe: false,
        conflicts: [{ harness: 'codex', reason: 'foreign file modified' }],
        prerequisites: [{ harness: 'codex', prerequisite: 'hooks trust review' }],
      },
    }), 'error');
    assert.equal(process.exitCode, 1);
    assert.ok(lines.some((line) => line.includes('codex lifecycle refused: foreign file modified')));
    assert.ok(lines.some((line) => line.includes('codex lifecycle prerequisite: hooks trust review')));
  } finally {
    process.exitCode = originalExitCode;
  }
});
