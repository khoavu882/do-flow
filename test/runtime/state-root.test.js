'use strict';
// 115 IC-004 and IC-006: one task state root for a linked worktree, and adoption of the records a
// worktree wrote in its own store before that rule.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { taskStateRoot, adoptWorktreeRecords, adoptedStores, ADOPTER } = require('../../src/runtime/state-root.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');

const REPO = path.resolve(__dirname, '../..');
const o = (extra = {}) => ({ global: false, positional: [], ...extra });
const linked = { ok: true, current: '/w/wt', main: '/w/main', isLinked: true, sandbox: false, others: ['/w/main'] };

test('taskStateRoot: a linked, non-sandbox worktree resolves to the main checkout', () => {
  assert.deepEqual(taskStateRoot(o(), linked), { root: '/w/main', redirected: true });
  assert.deepEqual(taskStateRoot(o({ positional: ['/w/wt/sub'] }), linked), { root: '/w/main', redirected: true });
});

test('taskStateRoot: --global, a sandbox, the main checkout, no listing or a failed one keep the caller\'s root', () => {
  const here = path.resolve('.');
  assert.deepEqual(taskStateRoot(o({ global: true }), linked), { root: os.homedir(), redirected: false });
  assert.deepEqual(taskStateRoot(o(), { ...linked, sandbox: true, main: null, mainReason: 'sandbox' }), { root: here, redirected: false });
  assert.deepEqual(taskStateRoot(o(), { ...linked, current: '/w/main', isLinked: false }), { root: here, redirected: false });
  assert.deepEqual(taskStateRoot(o(), null), { root: here, redirected: false });
  assert.deepEqual(taskStateRoot(o({ positional: ['/p'] }), { ok: false, reason: 'not-a-git-repository', isLinked: false }), { root: '/p', redirected: false });
});

test('adopted stores are the project-state stores that declare this module a writer in storage.json', () => {
  const registry = loadStorageRegistry({ repoRoot: REPO });
  const fromRegistry = registry.stores.filter((s) => s.root === 'project-state' && s.writers.includes(ADOPTER)).map((s) => s.path).sort();
  assert.deepEqual(adoptedStores(registry).map((s) => s.path).sort(), fromRegistry);
  assert.deepEqual(fromRegistry, ['delivery', 'evidence', 'orchestration', 'outcome', 'readiness', 'research', 'retrieval']);
  // The list follows the registry: a store that stops naming the module is no longer adopted.
  const trimmed = { stores: registry.stores.map((s) => (s.path === 'outcome' ? { ...s, writers: s.writers.filter((w) => w !== ADOPTER) } : s)) };
  assert.ok(!adoptedStores(trimmed).some((s) => s.path === 'outcome'));
});

function world(t) {
  const base = tempDir(t, 'doflow-state-root-');
  const main = path.join(base, 'main');
  const wt = path.join(base, 'wt');
  const put = (root, rel, body) => {
    const file = path.join(root, '.doflow', 'state', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  };
  const at = (root, rel) => path.join(root, '.doflow', 'state', rel);
  return { main, wt, put, at };
}

test('a record only in the worktree is moved to the same path in the main checkout; the task\'s files move together', (t) => {
  const { main, wt, put, at } = world(t);
  put(wt, 'evidence/A.1.json', '{"e":1}');
  put(wt, 'evidence/A.1_claims.json', '{"c":1}');
  put(wt, 'orchestration/A.1.json', '{"r":1}');
  put(wt, 'readiness/900-x/A.1.json', '{"n":1}');
  put(wt, 'evidence/A.10.json', '{"other":1}');
  put(wt, 'evidence/B.1.json', '{"other":2}');
  const result = adoptWorktreeRecords({ mainRoot: main, worktreeRoot: wt, taskId: 'A.1', slug: '900-x' });
  assert.equal(result.ok, true);
  assert.equal(result.adopted.length, 4);
  for (const [rel, body] of [['evidence/A.1.json', '{"e":1}'], ['evidence/A.1_claims.json', '{"c":1}'], ['orchestration/A.1.json', '{"r":1}'], ['readiness/900-x/A.1.json', '{"n":1}']]) {
    assert.equal(fs.readFileSync(at(main, rel), 'utf8'), body, rel);
    assert.ok(!fs.existsSync(at(wt, rel)), `${rel} left the worktree`);
  }
  assert.ok(fs.existsSync(at(wt, 'evidence/A.10.json')) && fs.existsSync(at(wt, 'evidence/B.1.json')), 'another task\'s records stay');
  assert.ok(!fs.existsSync(`${at(main, 'evidence/A.1.json')}.lock`), 'the lock is released');
  // A second call finds nothing left to adopt.
  assert.deepEqual(adoptWorktreeRecords({ mainRoot: main, worktreeRoot: wt, taskId: 'A.1', slug: '900-x' }), { ok: true, adopted: [], removed: [] });
});

test('equal bytes in both checkouts delete the worktree copy (a move that stopped between rename and delete)', (t) => {
  const { main, wt, put, at } = world(t);
  put(main, 'research/A.1.json', '{"same":true}');
  put(wt, 'research/A.1.json', '{"same":true}');
  const result = adoptWorktreeRecords({ mainRoot: main, worktreeRoot: wt, taskId: 'A.1' });
  assert.deepEqual(result, { ok: true, adopted: [], removed: [at(wt, 'research/A.1.json')] });
  assert.equal(fs.readFileSync(at(main, 'research/A.1.json'), 'utf8'), '{"same":true}');
  assert.ok(!fs.existsSync(at(wt, 'research/A.1.json')));
});

test('different bytes in both checkouts refuse with store-conflict naming both paths and write nothing', (t) => {
  const { main, wt, put, at } = world(t);
  put(wt, 'delivery/A.1.json', '{"only":"worktree"}');
  put(main, 'outcome/A.1.json', '{"v":"main"}');
  put(wt, 'outcome/A.1.json', '{"v":"worktree"}');
  const result = adoptWorktreeRecords({ mainRoot: main, worktreeRoot: wt, taskId: 'A.1' });
  assert.deepEqual(result, { ok: false, error: 'store-conflict', paths: [at(main, 'outcome/A.1.json'), at(wt, 'outcome/A.1.json')] });
  assert.equal(fs.readFileSync(at(main, 'outcome/A.1.json'), 'utf8'), '{"v":"main"}');
  assert.equal(fs.readFileSync(at(wt, 'outcome/A.1.json'), 'utf8'), '{"v":"worktree"}');
  assert.ok(fs.existsSync(at(wt, 'delivery/A.1.json')) && !fs.existsSync(at(main, 'delivery/A.1.json')), 'no file of the task moved');
});

test('only stores named by the registry are adopted, and an unsafe task id or the same root adopts nothing', (t) => {
  const { main, wt, put, at } = world(t);
  put(wt, 'task-attempts/A.1.json', '{}');
  put(wt, 'evidence/A.1.json', '{}');
  const registry = { stores: [{ id: 'x', root: 'project-state', path: 'evidence', match: '^[A-Za-z0-9][A-Za-z0-9._-]*\\.json$', writers: [ADOPTER] }] };
  assert.equal(adoptWorktreeRecords({ mainRoot: main, worktreeRoot: wt, taskId: 'A.1', registry }).adopted.length, 1);
  assert.ok(fs.existsSync(at(wt, 'task-attempts/A.1.json')), 'a store the registry does not name stays');
  assert.deepEqual(adoptWorktreeRecords({ mainRoot: main, worktreeRoot: wt, taskId: '../x' }), { ok: true, adopted: [], removed: [] });
  assert.deepEqual(adoptWorktreeRecords({ mainRoot: wt, worktreeRoot: wt, taskId: 'A.1' }), { ok: true, adopted: [], removed: [] });
});
