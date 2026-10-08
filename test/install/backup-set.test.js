'use strict';
// The backup set builder (src/install/backup-set.js): which files a run backs up. Plans are built by
// hand for the rules, and by the real lifecycle planner for the Codex and Gemini hook scripts.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { backupSetFromPlan, backupSetFromPaths } = require('../../src/install/backup-set');
const { BackupError } = require('../../src/install/backup');
const { loadRegistry } = require('../../src/registry');
const { registryLifecycleView } = require('../../src/lifecycle/view');
const { IS_WIN } = require('../helper-platform');

const REPO = path.resolve(__dirname, '../..');

const scratches = [];
after(() => { for (const dir of scratches) fs.rmSync(dir, { recursive: true, force: true }); });

function scratchDir() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-backup-set-')));
  scratches.push(dir);
  return dir;
}

function write(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function change(target, extra = {}) {
  return { harness: 'claude', assetId: 'asset.a', operation: 'update', kind: 'copy-tree', target, ...extra };
}

function plan(changes, ledger = {}) {
  return { changes, ledger: { resources: [], tombstones: [], ...ledger } };
}

function build(root, p, extra = {}) {
  return backupSetFromPlan({ plan: p, scope: 'global', scopeRoot: root, ...extra });
}

function listDir(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      out.push(path.join(d, e.name));
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(dir);
  return out.sort();
}

test('each changed file is an entry, sorted, with its stat and scope-relative path', () => {
  const root = scratchDir();
  const b = write(path.join(root, '.claude', 'b.md'), 'four');
  const a = path.join(root, '.claude', 'a.md');
  const outside = write(path.join(scratchDir(), 'AGENTS.md'), 'ab');
  const set = build(root, plan([change(b), change(a, { operation: 'create' }), change(outside, { harness: 'pi' })]));

  assert.deepStrictEqual(set.entries.map((e) => [e.path, e.rel, e.kind, e.size]), [
    [a, '.claude/a.md', 'absent', null],
    [b, '.claude/b.md', 'file', 4],
    [outside, null, 'file', 2],
  ].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
  assert.strictEqual(set.scope, 'global');
  assert.strictEqual(set.scopeRoot, root);
  assert.deepStrictEqual([set.count, set.existing, set.absent, set.bytes], [3, 2, 1, 6]);
  const bEntry = set.entries.find((e) => e.path === b);
  assert.deepStrictEqual(bEntry.reasons, ['change']);
  assert.deepStrictEqual(bEntry.harnesses, ['claude']);
  assert.strictEqual(bEntry.mode, fs.statSync(b).mode & 0o7777);
});

test('retained and released changes touch no file and are skipped', () => {
  const root = scratchDir();
  const set = build(root, plan([
    change(path.join(root, 'kept.md'), { operation: 'remove', retained: true }),
    change(path.join(root, 'released.md'), { operation: 'remove', release: true, kind: 'mcp-server' }),
  ]));
  assert.deepStrictEqual(set.entries, []);
  assert.deepStrictEqual(set.excluded, []);
});

test('a file whose every change is an MCP entry is excluded; one MCP change beside a file change is not', () => {
  const root = scratchDir();
  const claudeJson = write(path.join(root, '.claude.json'), '{}');
  const settings = write(path.join(root, '.gemini', 'settings.json'), '{}');
  const set = build(root, plan([
    change(claudeJson, { kind: 'mcp-server' }),
    change(claudeJson, { kind: 'mcp-server', assetId: 'mcp.b' }),
    change(settings, { kind: 'mcp-server', harness: 'gemini' }),
    change(settings, { kind: 'settings-entry', harness: 'gemini' }),
  ]));
  assert.deepStrictEqual(set.entries.map((e) => e.path), [settings]);
  assert.deepStrictEqual(set.excluded, [{ path: claudeJson, reason: 'mcp-entries-only' }]);
});

test('companion targets, relocated-from rows and unswept tombstones become entries; the union is per path', () => {
  const root = scratchDir();
  const hooksJson = path.join(root, '.codex', 'hooks.json');
  const script = write(path.join(root, '.codex', 'hooks', 'lib.sh'));
  const oldCopy = write(path.join(root, '.claude', 'old', 'skill.md'));
  const gone = path.join(root, '.claude', 'gone.md');
  const tomb = write(path.join(root, '.claude', 'tomb.md'));
  const ownedTomb = write(path.join(root, '.claude', 'owned.md'));
  const swept = write(path.join(root, '.claude', 'swept.md'));
  const newCopy = path.join(root, '.claude', 'new', 'skill.md');
  const ledger = {
    resources: [
      { harness: 'claude', assetId: 'asset.a', identity: 'skill', target: oldCopy, kind: 'copy-tree' },
      { harness: 'claude', assetId: 'asset.a', identity: 'skill', target: gone, kind: 'copy-tree' },
      { harness: 'claude', assetId: 'asset.a', identity: 'skill', target: oldCopy, kind: 'mcp-server' },
      { harness: 'codex', assetId: 'asset.a', identity: 'skill', target: oldCopy, kind: 'copy-tree' },
      { harness: 'claude', assetId: 'asset.z', identity: 'other', target: ownedTomb, kind: 'copy-tree' },
    ],
    tombstones: [
      { harness: 'claude', fromTarget: tomb, toTarget: newCopy },
      { harness: 'claude', fromTarget: ownedTomb, toTarget: newCopy },
      { harness: 'claude', fromTarget: swept, toTarget: newCopy, sweptAt: '2026-01-01T00:00:00.000Z' },
      { harness: 'claude', fromTarget: path.join(root, 'missing.md'), toTarget: newCopy },
    ],
  };
  const set = build(root, plan([
    change(hooksJson, { harness: 'codex', assetId: 'hooks', operation: 'create', companionTargets: [script, hooksJson] }),
    change(newCopy, { operation: 'create', identity: 'skill' }),
    change(script, { harness: 'codex', assetId: 'other' }),
  ], ledger));

  const byPath = new Map(set.entries.map((e) => [e.path, e]));
  assert.deepStrictEqual([...byPath.keys()].sort(), [hooksJson, script, oldCopy, newCopy, tomb].sort());
  assert.deepStrictEqual(byPath.get(hooksJson).reasons, ['change', 'companion']);
  assert.deepStrictEqual(byPath.get(script).reasons, ['change', 'companion']);
  assert.deepStrictEqual(byPath.get(oldCopy).reasons, ['relocated-from']);
  assert.deepStrictEqual(byPath.get(tomb).reasons, ['tombstone']);
  assert.deepStrictEqual(byPath.get(tomb).harnesses, ['claude']);
});

test('DoFlow state at or under an excluded path is reported, never backed up', () => {
  const root = scratchDir();
  const lock = write(path.join(root, '.doflow', 'doflow.lock'));
  const ledgerFile = write(path.join(root, '.doflow', 'state', 'ledger.json'));
  const kept = write(path.join(root, '.claude', 'CLAUDE.md'));
  const set = build(root, plan([change(lock), change(ledgerFile), change(kept)]), {
    exclude: [path.join(root, '.doflow', 'state'), lock, path.join(root, '.doflow', 'backups')],
  });
  assert.deepStrictEqual(set.entries.map((e) => e.path), [kept]);
  assert.deepStrictEqual(set.excluded, [
    { path: lock, reason: 'doflow-state' },
    { path: ledgerFile, reason: 'doflow-state' },
  ]);
});

test('stat kinds: a directory is other, a dangling link is absent, an unreadable path throws BackupError', { skip: IS_WIN && 'symlinks need privileges on Windows' }, () => {
  const root = scratchDir();
  const dir = path.join(root, 'dir');
  fs.mkdirSync(dir);
  const dangling = path.join(root, 'dangling');
  fs.symlinkSync(path.join(root, 'nowhere'), dangling);
  const underFile = path.join(write(path.join(root, 'file')), 'child');
  const set = build(root, plan([change(dir), change(dangling), change(underFile)]));
  assert.deepStrictEqual(set.entries.map((e) => [path.basename(e.path), e.kind]), [['dangling', 'absent'], ['dir', 'other'], ['child', 'absent']]);
  assert.deepStrictEqual([set.existing, set.absent, set.bytes], [0, 2, 0]);

  const fsImpl = { ...fs, statSync() { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
  assert.throws(() => build(root, plan([change(dir)]), { fsImpl }), (err) => err instanceof BackupError && err.message === `could not read ${dir}: EACCES`);
});

test('backupSetFromPaths builds a snapshot set with the same exclusions', () => {
  const root = scratchDir();
  const a = write(path.join(root, '.claude', 'a.md'), 'abc');
  const state = write(path.join(root, '.doflow', 'state', 'ledger.json'));
  const set = backupSetFromPaths({
    items: [{ path: a, harnesses: ['claude'] }, { path: a, harnesses: ['codex'] }, { path: state, harnesses: ['claude'] }],
    scope: 'project', scopeRoot: root, exclude: [path.join(root, '.doflow', 'state')],
  });
  assert.deepStrictEqual(set.entries.map((e) => [e.path, e.harnesses, e.reasons]), [[a, ['claude', 'codex'], ['snapshot']]]);
  assert.deepStrictEqual(set.excluded, [{ path: state, reason: 'doflow-state' }]);
  assert.deepStrictEqual([set.scope, set.count, set.bytes], ['project', 1, 3]);
});

for (const harness of ['codex', 'gemini']) {
  test(`a real ${harness} plan's set holds every hook script the apply deploys, and building it writes nothing`, () => {
    const projectRoot = scratchDir();
    const before = listDir(projectRoot);
    const view = registryLifecycleView({
      registry: loadRegistry({ repoRoot: REPO }), repoRoot: REPO, scope: { global: false, projectRoot }, targets: [harness],
    });
    const hooksChange = view.plan.changes.find((c) => c.nativeComponent === 'hooks');
    assert.ok(hooksChange, `${harness} plans a hooks change for a fresh project`);
    const sourceDir = path.join(REPO, 'core', 'harnesses', harness, 'hooks');
    const shipped = fs.readdirSync(sourceDir).filter((n) => !n.endsWith('.json') && fs.statSync(path.join(sourceDir, n)).isFile());
    assert.ok(shipped.length > 0);
    assert.deepStrictEqual(hooksChange.companionTargets.map((p) => path.basename(p)).sort(), shipped.sort());

    const set = backupSetFromPlan({ plan: view.plan, scope: 'project', scopeRoot: projectRoot, exclude: [view.stateRoot] });
    const byPath = new Map(set.entries.map((e) => [e.path, e]));
    for (const script of hooksChange.companionTargets) {
      assert.ok(byPath.get(script)?.reasons.includes('companion'), `${script} is in the set`);
      assert.ok(byPath.get(script).harnesses.includes(harness));
    }
    assert.deepStrictEqual(listDir(projectRoot), before, 'planning and building the set create no file');
  });
}
