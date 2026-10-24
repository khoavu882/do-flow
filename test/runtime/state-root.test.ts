'use strict';
// 115 IC-004 and IC-006: one task state root for a linked worktree, and the one locked sweep that
// moves the records a worktree wrote in its own store before that rule (C-3).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { taskStateRoot, sweepWorktreeRecords, adoptedStores, ADOPTER } = require('../../src/runtime/state-root.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');

const REPO = path.resolve(__dirname, '../..');
const o = (extra: any = {}) => ({ global: false, positional: [], ...extra });
const linked: any = { ok: true, current: '/w/wt', main: '/w/main', isLinked: true, sandbox: false, others: ['/w/main'] };

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
  const fromRegistry = registry.stores.filter((s: any) => s.root === 'project-state' && s.writers.includes(ADOPTER)).map((s: any) => s.path).sort();
  assert.deepEqual(adoptedStores(registry).map((s: any) => s.path).sort(), fromRegistry);
  assert.deepEqual(fromRegistry, ['delivery', 'evidence', 'orchestration', 'outcome', 'readiness', 'research', 'retrieval']);
  // The list follows the registry: a store that stops naming the module is no longer adopted.
  const trimmed: any = { stores: registry.stores.map((s: any) => (s.path === 'outcome' ? { ...s, writers: s.writers.filter((w: any) => w !== ADOPTER) } : s)) };
  assert.ok(!adoptedStores(trimmed).some((s: any) => s.path === 'outcome'));
});

function world(t: any) {
  const base = tempDir(t, 'doflow-state-root-');
  const main = path.join(base, 'main');
  const wt = path.join(base, 'wt');
  const put = (root: any, rel: any, body: any) => {
    const file = path.join(root, '.doflow', 'state', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  };
  const at = (root: any, rel: any) => path.join(root, '.doflow', 'state', rel);
  return { base, main, wt, put, at };
}

const sweep = (main: any, wt: any, extra: any = {}) => sweepWorktreeRecords({ mainRoot: main, worktreeRoot: wt, recordSlug: '900-x', ...extra });

/** Every file under a directory, relative to it. */
function filesUnder(dir: any) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).filter((rel: any) => fs.lstatSync(path.join(dir, rel)).isFile()).sort();
}

test('one sweep moves every record of every task, whatever the call names, to the same path in the main checkout', (t) => {
  const { main, wt, put, at } = world(t);
  put(wt, 'evidence/900-x/A.1.json', '{"e":1}');
  put(wt, 'evidence/900-x/A.1_claims.json', '{"c":1}');
  put(wt, 'orchestration/900-x/A.1.json', '{"r":1}');
  put(wt, 'readiness/900-x/T2.json', '{"n":2}');
  put(wt, 'outcome/900-x/B.1.json', '{"o":1}');
  const result = sweep(main, wt);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.adopted.length, 5);
  for (const [rel, body] of [['evidence/900-x/A.1.json', '{"e":1}'], ['evidence/900-x/A.1_claims.json', '{"c":1}'], ['orchestration/900-x/A.1.json', '{"r":1}'], ['readiness/900-x/T2.json', '{"n":2}'], ['outcome/900-x/B.1.json', '{"o":1}']]) {
    assert.equal(fs.readFileSync(at(main, rel), 'utf8'), body, rel);
    assert.ok(!fs.existsSync(at(wt, rel)), `${rel} left the worktree`);
  }
  assert.deepEqual(filesUnder(at(main, '')).filter((rel: any) => rel.includes('.lock') || rel.endsWith('.tmp')), [], 'no lock or temporary file is left');
  assert.deepEqual(sweep(main, wt), { ok: true, adopted: [], removed: [] }, 'a second sweep finds nothing');
});

test('a flat record of a task id other than its feature\'s slug lands under <store>/<slug>/: its own slug, else the call\'s', (t) => {
  const { main, wt, put, at } = world(t);
  put(wt, 'readiness/A.1.json', '{"slug":"900-y","state":"READY"}');
  put(wt, 'evidence/A.2.json', '{"taskId":"A.2"}');
  put(wt, 'orchestration/900-x.json', '{"taskId":"900-x","featureSlug":"900-x"}');
  assert.equal(sweep(main, wt).ok, true);
  assert.equal(fs.readFileSync(at(main, 'readiness/900-y/A.1.json'), 'utf8'), '{"slug":"900-y","state":"READY"}');
  assert.equal(fs.readFileSync(at(main, 'evidence/900-x/A.2.json'), 'utf8'), '{"taskId":"A.2"}');
  assert.ok(fs.existsSync(at(main, 'orchestration/900-x.json')), 'a task id that is its feature\'s slug stays flat');
  assert.ok(!fs.existsSync(at(main, 'evidence/A.2.json')) && !fs.existsSync(at(main, 'readiness/A.1.json')));
  // No slug for the call and none in the record: the flat path is kept.
  put(wt, 'evidence/A.3.json', '{"taskId":"A.3"}');
  assert.equal(sweep(main, wt, { recordSlug: null }).ok, true);
  assert.ok(fs.existsSync(at(main, 'evidence/A.3.json')));
});

test('A.1_other is its own file: moved to its own path byte for byte, and its conflict does not stop A.1', (t) => {
  const { main, wt, put, at } = world(t);
  put(wt, 'evidence/900-x/A.1.json', '{"task":"A.1"}');
  put(wt, 'evidence/900-x/A.1_other.json', '{"task":"A.1_other","v":"worktree"}');
  put(main, 'evidence/900-x/A.1_other.json', '{"task":"A.1_other","v":"main"}');
  const result = sweep(main, wt);
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicts, [{ worktree: at(wt, 'evidence/900-x/A.1_other.json'), main: at(main, 'evidence/900-x/A.1_other.json'), reason: 'differs' }]);
  assert.equal(fs.readFileSync(at(main, 'evidence/900-x/A.1.json'), 'utf8'), '{"task":"A.1"}', 'A.1 moved on its own');
  assert.equal(fs.readFileSync(at(main, 'evidence/900-x/A.1_other.json'), 'utf8'), '{"task":"A.1_other","v":"main"}');
  assert.equal(fs.readFileSync(at(wt, 'evidence/900-x/A.1_other.json'), 'utf8'), '{"task":"A.1_other","v":"worktree"}');
});

test('equal bytes delete the worktree copy; different bytes are reported pair by pair and files already moved stay moved', (t) => {
  const { main, wt, put, at } = world(t);
  put(main, 'research/A.1.json', '{"same":true}');
  put(wt, 'research/A.1.json', '{"same":true}');
  put(wt, 'delivery/A.1.json', '{"only":"worktree"}');
  put(main, 'outcome/A.1.json', '{"v":"main"}');
  put(wt, 'outcome/A.1.json', '{"v":"worktree"}');
  put(main, 'readiness/T9.json', '{"v":"main"}');
  put(wt, 'readiness/T9.json', '{"v":"worktree"}');
  const result = sweep(main, wt, { recordSlug: null });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'store-conflict');
  assert.deepEqual(result.conflicts.map((c: any) => [c.worktree, c.main, c.reason]).sort(), [
    [at(wt, 'outcome/A.1.json'), at(main, 'outcome/A.1.json'), 'differs'],
    [at(wt, 'readiness/T9.json'), at(main, 'readiness/T9.json'), 'differs'],
  ]);
  assert.deepEqual(result.removed, [at(wt, 'research/A.1.json')]);
  assert.deepEqual(result.adopted, [at(main, 'delivery/A.1.json')]);
  assert.equal(fs.readFileSync(at(main, 'outcome/A.1.json'), 'utf8'), '{"v":"main"}');
  assert.equal(fs.readFileSync(at(wt, 'outcome/A.1.json'), 'utf8'), '{"v":"worktree"}');
});

test('a worktree whose .doflow/state links to the main checkout\'s is not swept: the record stays', (t) => {
  const { main, wt, put, at } = world(t);
  const file = put(main, 'evidence/900-x/A.1.json', '{"keep":true}');
  fs.mkdirSync(path.join(wt, '.doflow'), { recursive: true });
  fs.symlinkSync(path.join(main, '.doflow', 'state'), path.join(wt, '.doflow', 'state'));
  assert.deepEqual(sweep(main, wt), { ok: true, adopted: [], removed: [] });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"keep":true}');
});

test('a link on either side\'s own path refuses that file and nothing is written through it', (t) => {
  const { base, main, wt, put, at } = world(t);
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  // The main checkout's store directory is a link.
  put(wt, 'evidence/900-x/A.1.json', '{"e":1}');
  fs.mkdirSync(at(main, ''), { recursive: true });
  fs.symlinkSync(outside, at(main, 'evidence'));
  let result = sweep(main, wt);
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicts, [{ worktree: at(wt, 'evidence/900-x/A.1.json'), main: at(main, 'evidence/900-x/A.1.json'), reason: 'link' }]);
  assert.deepEqual(filesUnder(outside), [], 'nothing was written outside');
  assert.ok(fs.existsSync(at(wt, 'evidence/900-x/A.1.json')));
  // The worktree's store directory is a link.
  fs.writeFileSync(path.join(outside, 'B.1.json'), '{"b":1}');
  fs.mkdirSync(at(wt, ''), { recursive: true });
  fs.symlinkSync(outside, at(wt, 'research'));
  result = sweep(main, wt);
  assert.ok(result.conflicts.some((c: any) => c.worktree === at(wt, 'research') && c.reason === 'link'), JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(outside, 'B.1.json'), 'utf8'), '{"b":1}');
  assert.ok(!fs.existsSync(at(main, 'research')));
  // A record file that is itself a link is refused, not skipped.
  fs.mkdirSync(at(wt, 'outcome'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'B.1.json'), at(wt, 'outcome/C.1.json'));
  result = sweep(main, wt);
  assert.ok(result.conflicts.some((c: any) => c.worktree === at(wt, 'outcome/C.1.json') && c.reason === 'link'), JSON.stringify(result));
  assert.ok(!fs.existsSync(at(main, 'outcome')));
});

/** fs with every path under `from` served from `to`, as a bind mount would, except realpath. */
function bindMount(from: any, to: any) {
  const map = (p: any) => (typeof p === 'string' && (p === from || p.startsWith(from + path.sep)) ? to + p.slice(from.length) : p);
  return new Proxy(fs, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function' || prop === 'realpathSync') return value;
      return (...args: any[]) => value.apply(target, args.map(map));
    },
  });
}

test('a source and target that are one file (dev:ino) are refused, never deleted', (t) => {
  const { main, wt, put, at } = world(t);
  const file = put(main, 'evidence/900-x/A.1.json', '{"only":"copy"}');
  fs.mkdirSync(at(wt, ''), { recursive: true });
  const result = sweep(main, wt, { fsImpl: bindMount(at(wt, ''), at(main, '')) });
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicts, [{ worktree: at(wt, 'evidence/900-x/A.1.json'), main: file, reason: 'same-file' }]);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"only":"copy"}', 'the only copy is kept');
});

test('a write to the worktree record that holds its lock when the sweep arrives is the revision moved', (t) => {
  const { main, wt, put, at } = world(t);
  const from = put(wt, 'evidence/900-x/A.1.json', '{"revision":1}');
  let wrote = false;
  const racing: any = new Proxy(fs, {
    get(target, prop) {
      const value = target[prop];
      if (prop !== 'mkdirSync') return typeof value === 'function' ? value.bind(target) : value;
      return (dir: any, ...rest: any[]) => {
        // The writer held the lock and finishes revision 2 just as the sweep takes the lock.
        if (dir === `${from}.lock` && !wrote) { wrote = true; target.writeFileSync(from, '{"revision":2}'); }
        return value.call(target, dir, ...rest);
      };
    },
  });
  assert.equal(sweep(main, wt, { fsImpl: racing }).ok, true);
  assert.ok(wrote, 'the source lock was taken');
  assert.equal(fs.readFileSync(at(main, 'evidence/900-x/A.1.json'), 'utf8'), '{"revision":2}');
  assert.ok(!fs.existsSync(from));
});

test('only stores named by the registry are swept, and the same root sweeps nothing', (t) => {
  const { main, wt, put, at } = world(t);
  put(wt, 'task-attempts/A.1.json', '{}');
  put(wt, 'evidence/A.1.json', '{}');
  const registry: any = { stores: [{ id: 'x', root: 'project-state', path: 'evidence', match: '^[A-Za-z0-9][A-Za-z0-9._-]*\\.json$', writers: [ADOPTER] }] };
  assert.equal(sweep(main, wt, { registry, recordSlug: null }).adopted.length, 1);
  assert.ok(fs.existsSync(at(wt, 'task-attempts/A.1.json')), 'a store the registry does not name stays');
  assert.deepEqual(sweep(wt, wt), { ok: true, adopted: [], removed: [] });
});
