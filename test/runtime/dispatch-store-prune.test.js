'use strict';

// Feature 082 (IC-037 amendment, SF-11): the `dispatch` store's `work` rule treats a dispatch run
// whose state is not `completed` or `cancelled` as open, mirroring IC-028's `task-attempts` check.
// Without it, a run left paused, blocked or resume-required on a plan whose boxes are all ticked is
// finished work and its record is pruned after 30 days, leaving its kept worktrees unnamed.
//
// Each case is a scratch project with agent-docs/doflow/<slug>/plan.md fully ticked and one
// dispatch record at .doflow/state/dispatch/<slug>.json aged 31 days, pruned through the storage
// engine's runPass against the real core/registry/storage.json.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const registry = require('../../core/registry/storage.json');
const { runPass } = require('../../src/runtime/storage/engine.ts');
const { workStatus } = require('../../src/runtime/storage/work-status.ts');

const NOW = Date.parse('2026-10-16T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const SLUG = '082-prune-fixture';

function fixture(t, runState) {
  const project = tempDir(t, 'doflow-dispatch-prune-');
  const home = path.join(project, 'home');
  const roots = Object.fromEntries(Object.entries(registry.roots).map(([id, r]) => [id, path.join(r.base === 'xdg-config' ? path.join(home, '.config') : r.base === 'home' ? home : project, ...r.segments)]));
  const plan = path.join(project, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(plan), { recursive: true });
  fs.writeFileSync(plan, '**Task graph:** v1\n\n### Phase A\n\n- [x] A.1 done\n- [x] A.2 done\n');
  const file = path.join(roots['project-state'], 'dispatch', `${SLUG}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const run = runState === null ? null : { dispatchRunId: 'p-0123456789ab', state: runState, runKey: 'k' };
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, revision: 3, slug: SLUG, run, dispatches: {}, drivers: [], lease: null, spawnRequests: {}, steps: [] })}\n`);
  const old = new Date(NOW - 31 * DAY);
  fs.utimesSync(file, old, old);
  const prune = () => runPass({ registry, roots, stores: ['dispatch'], mode: 'prune', setting: Object.fromEntries(Object.keys(roots).map((id) => [id, 'on'])), now: NOW });
  const status = () => workStatus({ projectRoot: project, store: 'dispatch', taskId: SLUG, mtimeMs: old.getTime() });
  return { file, prune, status };
}

for (const state of ['paused', 'blocked', 'resume-required', 'running', 'cancelling']) {
  test(`IC-037 (SF-11): a ${state} dispatch run on a fully ticked plan, 31 days old, is open and not pruned`, (t) => {
    const f = fixture(t, state);
    const before = fs.readFileSync(f.file);
    assert.deepEqual(f.status(), { state: 'open', since: null, reason: 'dispatch-run-open', run: null, feature: null });
    const result = f.prune();
    const row = result.stores.find((s) => s.id === 'dispatch');
    assert.deepEqual(row.selected, [], JSON.stringify(row));
    assert.equal(row.removed, 0);
    assert.deepEqual(fs.readFileSync(f.file), before, 'the record is kept byte for byte');
  });
}

for (const state of ['completed', 'cancelled']) {
  test(`IC-037 (SF-11): a ${state} dispatch run on a fully ticked plan, 31 days old, is pruned`, (t) => {
    const f = fixture(t, state);
    assert.equal(f.status().state, 'finished');
    const row = f.prune().stores.find((s) => s.id === 'dispatch');
    assert.equal(row.removed, 1, JSON.stringify(row));
    assert.equal(fs.existsSync(f.file), false);
  });
}

test('IC-037 (SF-11): a dispatch store with no run keeps the plan-based answer', (t) => {
  const f = fixture(t, null);
  assert.equal(f.status().state, 'finished');
});
