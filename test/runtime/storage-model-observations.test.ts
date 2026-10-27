'use strict';

// Row 120 IC-005 Lifetime (gate-a prune-by-done): the two model-observation stores.
// `worker-model-observations` keeps a file while its run or dispatch record is not terminal or cannot
// be resolved, and ages it out only after the run ended; `model-observations` prunes a main-session
// `primary/<cwdHash>` directory by age.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const registry = require('../../core/registry/storage.json');
const { runPass } = require('../../src/runtime/storage/engine.ts');

const DAY = 86400000;
const NOW = Date.parse('2026-10-24T12:00:00Z');
const FAR = NOW + 3650 * DAY;
const WORKER = 'worker-model-observations';
const PRIMARY = 'model-observations';

function fixture(t: any) {
  const project = tempDir(t, 'doflow-model-observations-');
  const home = path.join(project, 'home');
  const roots = Object.fromEntries(Object.entries(registry.roots).map(([id, r]) => [id, path.join(r.base === 'xdg-config' ? path.join(home, '.config') : r.base === 'home' ? home : project, ...r.segments)]));
  const setting = Object.fromEntries(Object.keys(roots).map((id) => [id, 'on']));
  return {
    roots,
    workerDir: path.join(roots['config-home'], 'session-env', 'worker-model'),
    primaryDir: path.join(roots['config-home'], 'session-env', 'primary'),
    pass: (stores: any, now: any, mode: any = 'prune') => runPass({ registry, roots, stores, mode, setting, now }),
  };
}

function aged(target: any, days: any, now: any = NOW) {
  const when = new Date(now - days * DAY);
  fs.utimesSync(target, when, when);
  return target;
}

function observation(dir: any, name: any, days: any) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, '{"schema":1,"harness":"codex","model":"gpt-5.1","event":"PreToolUse","observedAt":"2026-10-01T00:00:00Z","session":"0123456789abcdef"}\n');
  return aged(file, days);
}

function workerRuns(f: any, runs: any) {
  const dir = path.join(f.roots['project-state'], 'worker-runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'feat.json'), JSON.stringify({ slug: 'feat', runs, version: 1, revision: 1 }));
}

function run(runId: any, phase: any, identity: any) {
  return { [runId]: { runId, task: 'A.1', token: Number(identity.attempt), phase, seq: 0, identity: { ...identity, runSource: 'claim' } } };
}

test('a worker-model file whose run is not terminal survives a pass far past any age bound', (t) => {
  const f = fixture(t);
  const file = observation(f.workerDir, 'L.r1.lin.1.json', 400);
  workerRuns(f, run('w-000000000001', 'running', { run: 'r1', lineage: 'lin', attempt: '1' }));
  const row = f.pass([WORKER], FAR).stores.find((s: any) => s.id === WORKER);
  assert.ok(row, 'the worker-model-observations store is declared');
  assert.equal(row.removed, 0);
  assert.equal(row.protected, 1);
  assert.equal(fs.existsSync(file), true);
});

test('a worker-model file whose run cannot be resolved survives the same pass', (t) => {
  const f = fixture(t);
  const unknown = observation(f.workerDir, 'L.r9.lin.1.json', 400);
  const noStore = f.pass([WORKER], FAR).stores.find((s: any) => s.id === WORKER);
  assert.ok(noStore, 'the worker-model-observations store is declared');
  assert.equal(noStore.removed, 0);
  workerRuns(f, run('w-000000000001', 'ended', { run: 'r1', lineage: 'lin', attempt: '1' }));
  assert.equal(f.pass([WORKER], FAR).stores.find((s: any) => s.id === WORKER).removed, 0, 'another run ended; this one is unknown');
  fs.writeFileSync(path.join(f.roots['project-state'], 'worker-runs', 'torn.json'), '{"runs":');
  const ended = observation(f.workerDir, 'L.r1.lin.1.json', 400);
  assert.equal(f.pass([WORKER], FAR).stores.find((s: any) => s.id === WORKER).removed, 0, 'an unreadable run store keeps every file');
  assert.equal(fs.existsSync(unknown), true);
  assert.equal(fs.existsSync(ended), true);
});

test('a worker-model file for a terminal run, older than the bound, is pruned; a newer one and an open dispatch are kept', (t) => {
  const f = fixture(t);
  const old = observation(f.workerDir, 'L.r1.lin.1.json', 8);
  const fresh = observation(f.workerDir, 'L.r1.lin.2.json', 6);
  const dispatched = observation(f.workerDir, 'L.r1.lin.3.json', 8);
  workerRuns(f, {
    ...run('w-000000000001', 'ended', { run: 'r1', lineage: 'lin', attempt: '1' }),
    ...run('w-000000000002', 'ended', { run: 'r1', lineage: 'lin', attempt: '2' }),
    ...run('w-000000000003', 'ended', { run: 'r1', lineage: 'lin', attempt: '3' }),
  });
  const dispatchDir = path.join(f.roots['project-state'], 'dispatch');
  fs.mkdirSync(dispatchDir, { recursive: true });
  fs.writeFileSync(path.join(dispatchDir, 'feat.json'), JSON.stringify({ slug: 'feat', dispatches: { 'd-000000000003': { phase: 'collected', seq: 0, workerRunId: 'w-000000000003' } } }));
  const row = f.pass([WORKER], NOW).stores.find((s: any) => s.id === WORKER);
  assert.equal(row.removed, 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(dispatched), true, 'a dispatch that has not ended keeps its worker file');
});

test('a main-session primary/<cwdHash> directory older than 7 days is pruned; a 6-day-old one stays', (t) => {
  const f = fixture(t);
  const stale = path.join(f.primaryDir, '0123456789abcdef');
  const live = path.join(f.primaryDir, 'fedcba9876543210');
  for (const dir of [stale, live]) observation(path.join(dir, 'codex'), '0011223344556677.json', 0);
  aged(path.join(stale, 'codex'), 8); aged(stale, 8);
  aged(path.join(live, 'codex'), 6); aged(live, 6);
  const row = f.pass([PRIMARY], NOW).stores.find((s: any) => s.id === PRIMARY);
  assert.ok(row, 'the model-observations store is declared');
  assert.equal(row.removed, 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(live), true);
});
