'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REPO_ROOT } = require('../../src/helper/repo-root');
const { loadRegistry } = require('../../src/registry');
const { evaluateReach, REACH_DISPATCHER_REL, REACH_RUNTIME_REL } = require('../../src/runtime/reach');

const registry = loadRegistry({ repoRoot: REPO_ROOT });
const made = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

/** A real temporary tree: `home/` and `proj/sub/`, no DoFlow install anywhere. */
function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-reach-')));
  made.push(dir);
  const home = path.join(dir, 'home');
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
  return { home, proj, sub: path.join(proj, 'sub') };
}

function write(file, text = '', mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}

/** Writes `<root>/.doflow/state/ledger.json` with one `skills.doflow` row per harness named, and bare rows for `bare`. */
function ledger(root, scope, { skills = [], bare = [] }) {
  const resources = [
    ...skills.map((harness) => ({ harness, assetId: 'skills.doflow', kind: 'copy-tree-file' })),
    ...bare.map((harness) => ({ harness, assetId: 'locator.doflow', kind: 'copy-tree-file' })),
  ];
  write(path.join(root, '.doflow', 'state', 'ledger.json'), JSON.stringify({
    version: 2, scope, scopeRoot: root, targets: {}, mcpSelections: {}, resources, legacyImports: [],
  }));
}

function install(root, { runtime = true } = {}) {
  write(path.join(root, '.doflow', REACH_DISPATCHER_REL), '#!/bin/sh\n', 0o755);
  if (runtime) write(path.join(root, '.doflow', REACH_RUNTIME_REL), '');
}

const reach = ({ proj, home }, projectRoot = proj) => evaluateReach({ registry, projectRoot, homeDir: home });

test('a project install with a dispatcher and a runtime is REACHED at the install root', () => {
  const t = fixture();
  ledger(t.proj, 'project', { skills: ['pi'] });
  install(t.proj);
  assert.deepEqual(reach(t), {
    rows: [{ harness: 'pi', scope: 'project', state: 'REACHED', root: path.join(t.proj, '.doflow') }],
    unreadable: [],
  });
});

test('NO-REACH with no dispatcher names the paths searched and the project fix', () => {
  const t = fixture();
  ledger(t.proj, 'project', { skills: ['pi'] });
  const [row] = reach(t).rows;
  assert.equal(row.state, 'NO-REACH');
  assert.ok(row.reason.startsWith('no executable dispatcher at '), row.reason);
  assert.ok(row.reason.includes(path.join(t.proj, '.doflow', REACH_DISPATCHER_REL)), row.reason);
  assert.ok(row.reason.includes(path.join(t.home, '.doflow', REACH_DISPATCHER_REL)), row.reason);
  assert.equal(row.fix, `npx @khoavu882/doflow install ${t.proj} -t pi`);
  assert.equal(row.root, undefined);
});

test('NO-REACH with a dispatcher but no runtime names the dispatcher', () => {
  const t = fixture();
  ledger(t.proj, 'project', { skills: ['pi'] });
  install(t.proj, { runtime: false });
  const [row] = reach(t).rows;
  assert.equal(row.state, 'NO-REACH');
  assert.equal(row.reason, `dispatcher at ${path.join(t.proj, '.doflow', REACH_DISPATCHER_REL)} but no runtime/bin/doflow.js`);
});

test('a dispatcher without the execute bit does not count', { skip: process.platform === 'win32' }, () => {
  const t = fixture();
  ledger(t.proj, 'project', { skills: ['pi'] });
  install(t.proj);
  fs.chmodSync(path.join(t.proj, '.doflow', REACH_DISPATCHER_REL), 0o644);
  assert.equal(reach(t).rows[0].state, 'NO-REACH');
});

test('a project install falls back to the global dispatcher and runtime, and reports that root', () => {
  const t = fixture();
  ledger(t.proj, 'project', { skills: ['opencode'] });
  install(t.home);
  const [row] = reach(t).rows;
  assert.equal(row.state, 'REACHED');
  assert.equal(row.root, path.join(t.home, '.doflow'));
});

test('global scope has its own fix and reads only the home install', () => {
  const t = fixture();
  ledger(t.home, 'global', { skills: ['claude'] });
  assert.deepEqual(reach(t, t.sub).rows, [{
    harness: 'claude',
    scope: 'global',
    state: 'NO-REACH',
    reason: `no executable dispatcher at ${path.join(t.home, '.doflow', REACH_DISPATCHER_REL)}`,
    fix: 'npx @khoavu882/doflow install -g -t claude',
  }]);
});

test('a harness with no skills.doflow row at a scope is N/A without a fix', () => {
  const t = fixture();
  ledger(t.home, 'global', { bare: ['antigravity'] });
  assert.deepEqual(reach(t, t.home).rows, [
    { harness: 'antigravity', scope: 'global', state: 'N/A', reason: 'no skills at global scope' },
  ]);
});

test('an unreadable ledger is reported for its scope and produces no rows for it', () => {
  const t = fixture();
  ledger(t.proj, 'project', { skills: ['pi'] });
  install(t.proj);
  write(path.join(t.home, '.doflow', 'state', 'ledger.json'), '{ not json');
  const result = reach(t);
  assert.deepEqual(result.rows.map((row) => `${row.harness}:${row.scope}:${row.state}`), ['pi:project:REACHED']);
  assert.equal(result.unreadable.length, 1);
  assert.equal(result.unreadable[0].scope, 'global');
  assert.match(result.unreadable[0].detail, /Cannot read neutral ledger/);
});

test('a projectRoot below the install root reads the install root ledger', () => {
  const t = fixture();
  ledger(t.proj, 'project', { skills: ['pi'] });
  install(t.proj);
  assert.deepEqual(reach(t, t.sub).rows, [
    { harness: 'pi', scope: 'project', state: 'REACHED', root: path.join(t.proj, '.doflow') },
  ]);
});

test('a nested ledger does not hide the enclosing install: each ancestor ledger is evaluated', () => {
  const t = fixture();
  ledger(t.sub, 'project', { bare: ['gemini'] });
  ledger(t.proj, 'project', { skills: ['pi'] });
  install(t.proj, { runtime: false });
  const { rows } = reach(t, t.sub);
  assert.deepEqual(rows.map((row) => `${row.harness}:${row.scope}:${row.state}`), ['gemini:project:N/A', 'pi:project:NO-REACH']);
  assert.equal(rows[1].fix, `npx @khoavu882/doflow install ${t.proj} -t pi`);
});

test('a projectRoot equal to the home directory reports global rows only', () => {
  const t = fixture();
  ledger(t.home, 'global', { skills: ['pi'] });
  install(t.home);
  const rows = reach(t, t.home).rows;
  assert.deepEqual(rows.map((row) => `${row.harness}:${row.scope}:${row.state}`), ['pi:global:REACHED']);
});

test('project and global rows come in that order, each in registry order', () => {
  const t = fixture();
  ledger(t.proj, 'project', { skills: ['pi', 'claude'] });
  ledger(t.home, 'global', { skills: ['kiro', 'codex'] });
  install(t.proj);
  install(t.home);
  const order = reach(t).rows.map((row) => `${row.scope}:${row.harness}`);
  const rank = (harness) => registry.harnesses.findIndex((entry) => entry.id === harness);
  assert.deepEqual(order, [
    ...['claude', 'pi'].sort((a, b) => rank(a) - rank(b)).map((h) => `project:${h}`),
    ...['codex', 'kiro'].sort((a, b) => rank(a) - rank(b)).map((h) => `global:${h}`),
  ]);
});

test('no ledger and no project install give no rows', () => {
  const t = fixture();
  assert.deepEqual(reach(t), { rows: [], unreadable: [] });
});
