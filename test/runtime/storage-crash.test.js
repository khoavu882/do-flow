'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { inheritedEnv } = require('../helper/scratch-env');
const registry = require('../../core/registry/storage.json');
const { runPass } = require('../../src/runtime/storage/engine');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
const { ClaimsManager } = require('../../src/runtime/claims.ts');
const NOW = Date.parse('2026-10-10T12:00:00Z'), DAY = 86400000;
const CLI = path.resolve(__dirname, '../../bin/doflow.js');
const TOMBSTONE = /^\.[A-Za-z0-9][A-Za-z0-9._-]*\.pruning-[0-9]+-[0-9a-f]{8}$/;
function fixture(t) {
  const dir = tempDir(t, 'doflow-storage-crash-'), project = path.join(dir, 'project');
  const home = path.join(dir, 'home'), xdg = path.join(dir, 'xdg');
  for (const folder of [project, home, xdg]) fs.mkdirSync(folder);
  fs.mkdirSync(path.join(xdg, 'doflow')); fs.writeFileSync(path.join(xdg, 'doflow/prune'), 'off\n');
  const roots = Object.fromEntries(Object.entries(registry.roots).map(([id, root]) => [id, path.join(root.base === 'home' ? home : root.base === 'xdg-config' ? xdg : project, ...root.segments)]));
  const env = { ...inheritedEnv(), HOME: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_GLOBAL: path.join(dir, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  assert.equal(spawnSync('git', ['init', '-q', project], { env, encoding: 'utf8' }).status, 0);
  const pass = (stores, extra = {}) => runPass({ registry, roots, stores, mode: 'prune', now: NOW, budgetMs: Infinity, ...extra });
  return { dir, project, home, xdg, roots, env, pass };
}
function put(dir, name, text = '{}', age = 40) {
  fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, name);
  fs.writeFileSync(file, text); fs.utimesSync(file, new Date(NOW - age * DAY), new Date(NOW - age * DAY)); return file;
}
function oldFolder(f, name) {
  const dir = path.join(f.roots['config-home'], 'session-env/sessions', name);
  put(dir, 'activity', 'old'); fs.utimesSync(dir, new Date(NOW - 40 * DAY), new Date(NOW - 40 * DAY)); return dir;
}
function injected(overrides) {
  return new Proxy(fs, { get(target, key) { return overrides[key] || (typeof target[key] === 'function' ? target[key].bind(target) : target[key]); } });
}
function fault(code = 'EIO') { return Object.assign(new Error(`injected ${code}`), { code }); }
function tree(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().flatMap(name => {
    const file = path.join(dir, name), relative = `${prefix}${name}`, info = fs.lstatSync(file);
    return info.isDirectory() ? [[`${relative}/`, ''], ...tree(file, `${relative}/`)] : [[relative, fs.readFileSync(file).toString('hex')]];
  });
}
function cli(f, args, cwd = f.project) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd, env: f.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
function seedReadable(f) {
  cli(f, ['orchestrate', '--action', 'start', '--task-id', 'live', '--task-class', 'trivial-edit']);
  const ledger = new EvidenceLedger({ repoRoot: f.project });
  const claims = new ClaimsManager({ repoRoot: f.project });
  for (const taskId of ['live', 'expired']) {
    ledger.addEvidence({ taskId, kind: 'structural', content: taskId, locator: { file: 'fixture.js' } });
    const file = ledger.save(taskId); fs.utimesSync(file, new Date(NOW - 40 * DAY), new Date(NOW - 40 * DAY));
    claims.addClaim({ taskId, statement: taskId });
    const claimFile = claims.save(taskId); fs.utimesSync(claimFile, new Date(NOW - 41 * DAY), new Date(NOW - 41 * DAY));
  }
  put(path.join(f.roots['project-state'], 'research'), 'expired.json');
  oldFolder(f, 'expired-session');
}
function readersSucceed(f) {
  // Readers (notably readiness and lifecycle) write state. Exercise an exact copy so their writes
  // cannot change the retry-equivalence comparison of the interrupted engine's own tree.
  const copy = path.join(f.dir, 'reader-project'); fs.cpSync(f.project, copy, { recursive: true });
  const readerHome = path.join(f.dir, 'reader-home'), readerXdg = path.join(f.dir, 'reader-xdg');
  fs.cpSync(f.home, readerHome, { recursive: true }); fs.cpSync(f.xdg, readerXdg, { recursive: true });
  const reader = { ...f, project: copy, env: { ...f.env, HOME: readerHome, XDG_CONFIG_HOME: readerXdg } };
  for (const args of [
    ['evidence', '--action', 'list', '--task-id', 'live'],
    ['evidence', '--action', 'list', '--task-id', 'expired'],
    ['readiness', '--task-id', 'live', '--task-class', 'trivial-edit'],
    ['orchestrate', '--action', 'status', '--task-id', 'live'],
    ['trace'], ['followup', '--action', 'list'],
  ]) cli(reader, args);
}
const CRASH_STORES = ['task-evidence', 'task-research', 'session-dirs'];
for (const crash of ['after-two-file-removals', 'after-tombstone-rename']) {
  test(`interruption ${crash}: all readers succeed and retry equals uninterrupted paths and bytes`, t => {
    const f = fixture(t), baseline = fixture(t); seedReadable(f); seedReadable(baseline);
    // The live run/evidence have generated ids/timestamps. Keep identical bytes in both trees.
    fs.rmSync(baseline.roots['project-state'], { recursive: true });
    fs.cpSync(f.roots['project-state'], baseline.roots['project-state'], { recursive: true, preserveTimestamps: true });
    let removals = 0, renamed = false;
    const fsImpl = injected({
      unlinkSync(file) { if (crash === 'after-two-file-removals' && removals >= 2) throw fault(); fs.unlinkSync(file); removals++; },
      renameSync(from, to) { fs.renameSync(from, to); renamed = true; },
      rmSync(file, options) { if (crash === 'after-tombstone-rename') { assert.match(path.basename(file), TOMBSTONE); throw fault(); } if (removals >= 2) throw fault(); fs.rmSync(file, options); },
    });
    const interrupted = f.pass(CRASH_STORES, { fsImpl });
    assert.ok(interrupted.stores.some(row => row.failed.length), 'fault was reached');
    if (crash === 'after-two-file-removals') assert.equal(removals, 2);
    else { assert.equal(renamed, true); assert.ok(fs.readdirSync(path.dirname(path.join(f.roots['config-home'], 'session-env/sessions/expired-session'))).some(name => TOMBSTONE.test(name))); }
    readersSucceed(f);
    f.pass(CRASH_STORES); baseline.pass(CRASH_STORES);
    for (const id of ['project-state', 'config-home']) assert.deepEqual(tree(f.roots[id]), tree(baseline.roots[id]), id);
    assert.equal(f.pass(CRASH_STORES).stores.reduce((sum, row) => sum + row.removed, 0), 0);
  });
}
test('P1 sweeps tombstones in every requested store before zero budget/cap; report and off do not sweep', t => {
  const f = fixture(t), dir = path.join(f.roots['config-home'], 'session-env/sessions');
  const tombstone = path.join(dir, '.expired.pruning-123-abcdef12'); put(tombstone, 'activity', 'old');
  const projectTombstone = path.join(f.roots['config-home'], 'session-env/projects/.0123456789abcdef.pruning-123-abcdef12'); put(projectTombstone, 'activity');
  const recordTombstone = path.join(f.roots['project-state'], 'research/.old.pruning-123-abcdef12'); put(recordTombstone, 'task.json');
  assert.equal(f.pass(['task-research'], { mode: 'report' }).stores[0].selected.length, 0, 'tombstones are not record namespaces');
  assert.equal(f.pass(['session-dirs'], { mode: 'report' }).stores[0].entries, 0);
  assert.equal(fs.existsSync(tombstone), true);
  f.pass(['session-dirs'], { setting: { 'config-home': 'off' } }); assert.equal(fs.existsSync(tombstone), true);
  const result = f.pass(['task-research', 'session-dirs', 'project-dirs'], { budgetMs: 0, maxRemovals: 0 });
  assert.equal(result.partial, true);
  for (const folder of [tombstone, projectTombstone, recordTombstone]) assert.equal(fs.existsSync(folder), false);
});
test('folder rename stays in the same parent; failed rename skips without failure or removal', t => {
  const f = fixture(t), folder = oldFolder(f, 'old'); let renames = 0;
  const fsImpl = injected({ renameSync(from, to) { renames++; assert.equal(from, folder); assert.equal(path.dirname(to), path.dirname(from)); assert.match(path.basename(to), TOMBSTONE); throw fault('EACCES'); }, rmSync() { assert.fail('cannot remove after failed rename'); } });
  const row = f.pass(['session-dirs'], { fsImpl }).stores[0];
  assert.equal(renames, 1); assert.equal(row.removed, 0); assert.deepEqual(row.failed, []); assert.equal(fs.existsSync(folder), true);
});
test('P1 never follows or removes a linked tombstone; recursive removal never follows nested links', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), folder = oldFolder(f, 'old'), outside = path.join(f.dir, 'outside'); put(outside, 'keep', 'safe');
  const dir = path.dirname(folder), linked = path.join(dir, '.linked.pruning-123-abcdef12'); fs.symlinkSync(outside, linked);
  // Insert a link only after selection, modelling a child changed during the rename.
  const fsImpl = injected({ renameSync(from, to) { fs.renameSync(from, to); fs.symlinkSync(outside, path.join(to, 'link')); } });
  assert.equal(f.pass(['session-dirs'], { fsImpl }).stores[0].removed, 1);
  assert.equal(fs.lstatSync(linked).isSymbolicLink(), true); assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'safe');
});
test('record try-lock makes one attempt, never waits or breaks an old held lock', t => {
  const f = fixture(t), file = put(path.join(f.roots['project-state'], 'research'), 'held.json');
  fs.mkdirSync(`${file}.lock`); fs.utimesSync(`${file}.lock`, new Date(0), new Date(0)); let attempts = 0;
  const fsImpl = injected({ mkdirSync(dir, ...args) { if (dir === `${file}.lock`) attempts++; return fs.mkdirSync(dir, ...args); } });
  assert.equal(f.pass(['task-research'], { fsImpl }).stores[0].removed, 0);
  assert.equal(attempts, 1); assert.equal(fs.existsSync(file), true); assert.equal(fs.existsSync(`${file}.lock`), true);
});
for (const id of ['task-evidence', 'task-readiness', 'task-research', 'task-outcome', 'task-retrieval', 'task-orchestration']) {
  test(`RK8 unlocked writers: ${id} target changed before locked recheck is kept`, t => {
    const f = fixture(t), store = registry.stores.find(row => row.id === id), dir = path.join(f.roots['project-state'], store.path);
    const file = put(dir, 'changed.json', id === 'task-orchestration' ? '{"state":"COMPLETED"}' : '{}'); let acquired = false;
    const fsImpl = injected({ mkdirSync(folder, ...args) { const result = fs.mkdirSync(folder, ...args); if (folder === `${file}.lock`) { acquired = true; fs.utimesSync(file, new Date(NOW), new Date(NOW)); } return result; } });
    assert.equal(f.pass([id], { fsImpl }).stores[0].removed, 0); assert.equal(acquired, true);
    assert.equal(fs.existsSync(file), true); assert.equal(fs.existsSync(`${file}.lock`), false);
  });
}
test('workStatus is rerun under lock with current record metadata', t => {
  const f = fixture(t), file = put(path.join(f.roots['project-state'], 'research'), 'changed.json');
  put(path.join(f.project, 'agent-docs/doflow/open-feature'), 'plan.md', '- [ ] unfinished\n');
  let locked = false, lockedReads = 0;
  const fsImpl = injected({
    mkdirSync(folder, ...args) { const result = fs.mkdirSync(folder, ...args); if (folder === `${file}.lock`) locked = true; return result; },
    readFileSync(target, ...args) { if (locked && target === file) { lockedReads++; return '{"featureSlug":"open-feature"}'; } return fs.readFileSync(target, ...args); },
  });
  assert.equal(f.pass(['task-research'], { fsImpl }).stores[0].removed, 0);
  assert.ok(lockedReads > 0); assert.equal(fs.existsSync(file), true); assert.equal(fs.existsSync(`${file}.lock`), false);
});
test('a run reopened after selection keeps its dependent record: the locked recheck reads the current run (G.1)', t => {
  const f = fixture(t);
  const run = put(path.join(f.roots['project-state'], 'orchestration'), 'reopened.json',
    JSON.stringify({ state: 'COMPLETED', updatedAt: new Date(NOW - 40 * DAY).toISOString() }));
  const file = put(path.join(f.roots['project-state'], 'research'), 'reopened.json');
  let reopened = false;
  const fsImpl = injected({ mkdirSync(folder, ...args) {
    const result = fs.mkdirSync(folder, ...args);
    if (folder === `${file}.lock`) { reopened = true; fs.writeFileSync(run, JSON.stringify({ state: 'RUNNING', updatedAt: new Date(NOW).toISOString() })); }
    return result;
  } });
  assert.equal(f.pass(['task-research'], { fsImpl }).stores[0].removed, 0);
  assert.equal(reopened, true); assert.equal(fs.existsSync(file), true);
});
test('a plan task unchecked after selection keeps its record: the locked recheck reads the current plan (G.1)', t => {
  const f = fixture(t);
  const plan = put(path.join(f.project, 'agent-docs/doflow/feat-a'), 'plan.md', '- [x] T1 done\n');
  const file = put(path.join(f.roots['project-state'], 'research'), 'feat-a-T1.json');
  let unchecked = false;
  const fsImpl = injected({ mkdirSync(folder, ...args) {
    const result = fs.mkdirSync(folder, ...args);
    if (folder === `${file}.lock`) { unchecked = true; fs.writeFileSync(plan, '- [x] T1 done\n- [ ] T2 reopened\n'); }
    return result;
  } });
  assert.equal(f.pass(['task-research'], { fsImpl }).stores[0].removed, 0);
  assert.equal(unchecked, true); assert.equal(fs.existsSync(file), true);
});
test('without a concurrent change the same finished record is still removed under the fresh recheck', t => {
  const f = fixture(t);
  put(path.join(f.project, 'agent-docs/doflow/feat-a'), 'plan.md', '- [x] T1 done\n');
  const file = put(path.join(f.roots['project-state'], 'research'), 'feat-a-T1.json');
  assert.equal(f.pass(['task-research']).stores[0].removed, 1);
  assert.equal(fs.existsSync(file), false);
});
test('RK8 unlocked writer refreshes the subject during the locked workStatus read: keep it', t => {
  const f = fixture(t), file = put(path.join(f.roots['project-state'], 'research'), 'changed.json');
  let locked = false;
  const fsImpl = injected({
    mkdirSync(folder, ...args) { const result = fs.mkdirSync(folder, ...args); if (folder === `${file}.lock`) locked = true; return result; },
    readFileSync(target, ...args) { if (locked && target === file) fs.utimesSync(file, new Date(NOW), new Date(NOW)); return fs.readFileSync(target, ...args); },
  });
  assert.equal(f.pass(['task-research'], { fsImpl }).stores[0].removed, 0);
  assert.equal(fs.existsSync(file), true); assert.equal(fs.existsSync(`${file}.lock`), false);
});
test('orchestration subject is reread under lock even though workStatus shares its cached run', t => {
  const f = fixture(t), file = put(path.join(f.roots['project-state'], 'orchestration'), 'changed.json', '{"state":"COMPLETED"}');
  let locked = false, lockedReads = 0;
  const fsImpl = injected({
    mkdirSync(folder, ...args) { const result = fs.mkdirSync(folder, ...args); if (folder === `${file}.lock`) locked = true; return result; },
    readFileSync(target, ...args) { if (locked && target === file) { lockedReads++; return '{"state":"RUNNING"}'; } return fs.readFileSync(target, ...args); },
  });
  assert.equal(f.pass(['task-orchestration'], { fsImpl }).stores[0].removed, 0);
  assert.equal(lockedReads, 1); assert.equal(fs.existsSync(file), true); assert.equal(fs.existsSync(`${file}.lock`), false);
});
test('session child refreshed after selection keeps its folder and never enters rename', t => {
  const f = fixture(t), folder = oldFolder(f, 'old'); let folderStats = 0;
  const fsImpl = injected({
    lstatSync(file, ...args) { if (file === folder && ++folderStats === 2) fs.utimesSync(path.join(folder, 'activity'), new Date(NOW), new Date(NOW)); return fs.lstatSync(file, ...args); },
    renameSync() { assert.fail('refreshed session must not be hidden'); },
  });
  assert.equal(f.pass(['session-dirs'], { fsImpl }).stores[0].removed, 0); assert.equal(fs.existsSync(folder), true);
});
test('claims precede their evidence regardless of mtime; orchestration outlives every dependent store', t => {
  const f = fixture(t), evidence = path.join(f.roots['project-state'], 'evidence');
  put(evidence, 'task.json', '{}', 80); put(evidence, 'task_claims.json', '{}', 40);
  put(path.join(f.roots['project-state'], 'research'), 'task.json');
  put(path.join(f.roots['project-state'], 'orchestration'), 'task.json', '{"state":"COMPLETED"}', 90);
  const removed = [], fsImpl = injected({ unlinkSync(file) { removed.push(path.relative(f.roots['project-state'], file)); fs.unlinkSync(file); } });
  f.pass(['task-orchestration', 'task-research', 'task-evidence'], { fsImpl });
  assert.deepEqual(removed, ['evidence/task_claims.json', 'evidence/task.json', 'research/task.json', 'orchestration/task.json']);
});
for (const code of ['ENOENT', 'EACCES', 'EIO']) {
  test(`file removal ${code}: correct accounting and record lock release`, t => {
    const f = fixture(t), file = put(path.join(f.roots['project-state'], 'research'), 'failure.json');
    const fsImpl = injected({ unlinkSync(target) { if (target === file) { if (code === 'ENOENT') fs.unlinkSync(target); throw fault(code); } fs.unlinkSync(target); } });
    const row = f.pass(['task-research'], { fsImpl }).stores[0];
    assert.equal(row.removed, code === 'ENOENT' ? 1 : 0);
    assert.deepEqual(row.failed, code === 'ENOENT' ? [] : [{ name: 'failure.json', code }]);
    assert.equal(fs.existsSync(file), code !== 'ENOENT'); assert.equal(fs.existsSync(`${file}.lock`), false);
  });
}
test('a namespace concurrently removed before P5 counts its record as already removed', t => {
  const f = fixture(t), namespace = path.join(f.roots['project-state'], 'research/group'); put(namespace, 'gone.json');
  // AM22: a namespaced record finishes only through its feature's checked plan.
  put(path.join(path.dirname(path.dirname(f.roots['project-state'])), 'agent-docs/doflow/group'), 'plan.md', '- [x] done\n');
  let reads = 0;
  const fsImpl = injected({ lstatSync(file, ...args) { if (file === namespace && ++reads === 3) fs.rmSync(namespace, { recursive: true }); return fs.lstatSync(file, ...args); } });
  const row = f.pass(['task-research'], { fsImpl }).stores[0];
  assert.equal(row.removed, 1); assert.deepEqual(row.failed, []); assert.equal(fs.existsSync(namespace), false);
});
test('a plain file is removed by exactly one unlink without rename or recursive rm', t => {
  const f = fixture(t), name = `${NOW - 40 * DAY}-old.log`, file = put(path.join(f.roots['project-state'], 'verification/logs'), name, 'expired'); let unlinks = 0;
  const fsImpl = injected({
    unlinkSync(target) { assert.equal(target, file); unlinks++; fs.unlinkSync(target); },
    renameSync() { assert.fail('files must not be renamed'); }, rmSync() { assert.fail('files must not be recursively removed'); },
  });
  assert.equal(f.pass(['verification-logs'], { fsImpl }).stores[0].removed, 1); assert.equal(unlinks, 1);
});
test('P1 removal error is accounted, leaves tombstone invisible, and retries successfully', t => {
  const f = fixture(t), tombstone = path.join(f.roots['config-home'], 'session-env/sessions/.old.pruning-123-abcdef12'); put(tombstone, 'activity');
  const row = f.pass(['session-dirs'], { fsImpl: injected({ rmSync() { throw fault('EACCES'); } }) }).stores[0];
  assert.deepEqual(row.failed, [{ name: path.basename(tombstone), code: 'EACCES' }]); assert.equal(row.entries, 0);
  f.pass(['session-dirs']); assert.equal(fs.existsSync(tombstone), false);
});
