'use strict';

// 086 C.2 (IC-007, DD-9, FR-012, NFR-003): where the project layer lives for a main checkout, a linked
// worktree and a sandbox, found from `.git`, `gitdir:` and `commondir` with no process spawned. The
// linked-worktree cases use a real `git worktree add` in a temp repo and are compared with
// listCheckouts(). Nothing here touches the real home.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { createSettingsEnv, write } = require('../helper/settings-fixtures');
const { projectLayerSource, MARKER } = require('../../src/runtime/settings/project-layers.ts');
const { listCheckouts } = require('../../src/runtime/checkouts.ts');

const real = (p) => fs.realpathSync(p);
const filesOf = (dir) => [path.join(dir, '.doflow', 'settings.local.json'), path.join(dir, '.doflow', 'settings.json')];

/** A `fs` whose reads and stats are counted, optionally with named methods replaced. */
function countingFs(overrides = {}) {
  const counts = { lstat: 0, stat: 0, read: 0, realpath: 0 };
  const wrap = (name, key) => (...args) => { counts[key] += 1; return (overrides[name] || fs[name])(...args); };
  return {
    counts,
    lstatSync: wrap('lstatSync', 'lstat'),
    statSync: wrap('statSync', 'stat'),
    readFileSync: wrap('readFileSync', 'read'),
    realpathSync: wrap('realpathSync', 'realpath'),
  };
}

/** A main checkout with a `.doflow/` and a linked worktree (own `.doflow/` empty). */
function worktreePair(t) {
  const fx = createSettingsEnv(t, { prefix: 'doflow-layers-', worktree: true });
  return { fx, main: real(fx.project), linked: fx.worktree };
}

test('a main checkout: its own .doflow, local file before shared file, two lstats and no reads', (t) => {
  const { main } = worktreePair(t);
  const spy = countingFs();
  assert.deepEqual(projectLayerSource(main, spy), { layersFrom: path.join(main, '.doflow'), checkout: 'own', files: filesOf(main) });
  assert.deepEqual(spy.counts, { lstat: 2, stat: 0, read: 0, realpath: 0 });
});

test('a linked worktree with no settings of its own takes the main checkout .doflow, in two reads', (t) => {
  const { fx, main, linked } = worktreePair(t);
  const spy = countingFs();
  const got = projectLayerSource(linked, spy);
  assert.deepEqual(got, { layersFrom: path.join(main, '.doflow'), checkout: 'main', files: filesOf(main) });
  assert.ok(spy.counts.read <= 3, `reads: ${spy.counts.read}`);
  assert.equal(spy.counts.read, 2);
  // the same answer as the one source that names every checkout
  const listed = listCheckouts({ cwd: linked, exec: (...a) => childProcess.spawnSync(...a) });
  assert.equal(real(listed.main), main);
  assert.equal(real(path.dirname(got.layersFrom)), real(listed.main));
  assert.equal(fx.worktree, linked);
});

test('negative control: the same worktree with its own settings stays own, for each file the 2.0 reader knew', (t) => {
  const { fx, linked } = worktreePair(t);
  for (const name of ['settings.json', 'settings.local.json', 'decision-model.json', 'prune']) {
    const file = write(fx.projectFile(name, linked), name.endsWith('.json') ? {} : 'x\n');
    assert.deepEqual(projectLayerSource(linked), { layersFrom: path.join(linked, '.doflow'), checkout: 'own', files: filesOf(linked) }, name);
    fs.rmSync(file);
    assert.equal(projectLayerSource(linked).checkout, 'main', `${name} removed`);
  }
});

test('a nested subdirectory resolves the same checkout as its root', (t) => {
  const { main, linked } = worktreePair(t);
  fs.mkdirSync(path.join(linked, 'a', 'b'), { recursive: true });
  fs.mkdirSync(path.join(main, 'c'), { recursive: true });
  assert.deepEqual(projectLayerSource(path.join(linked, 'a', 'b')), projectLayerSource(linked));
  assert.equal(projectLayerSource(path.join(linked, 'a', 'b')).checkout, 'main');
  assert.deepEqual(projectLayerSource(path.join(main, 'c')), projectLayerSource(main));
});

test('a worktree whose commondir is missing, outside a .git, or not a regular file keeps its own', (t) => {
  const { fx, main, linked } = worktreePair(t);
  const gitdir = path.join(main, '.git', 'worktrees', path.basename(linked));
  assert.equal(projectLayerSource(linked).checkout, 'main');
  const own = { layersFrom: path.join(linked, '.doflow'), checkout: 'own', files: filesOf(linked) };

  const original = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8');
  fs.rmSync(path.join(gitdir, 'commondir'));
  assert.deepEqual(projectLayerSource(linked), own, 'missing');

  const elsewhere = tempDir(t, 'doflow-layers-elsewhere-');
  fs.mkdirSync(path.join(elsewhere, '.doflow'));
  write(path.join(gitdir, 'commondir'), `${path.join(elsewhere, 'common')}\n`);
  assert.deepEqual(projectLayerSource(linked), own, 'points at a folder that is not a .git, next to a .doflow');

  fs.mkdirSync(path.join(elsewhere, 'repo', '.git'), { recursive: true });
  write(path.join(gitdir, 'commondir'), `${path.join(elsewhere, 'repo', '.git')}\n`);
  assert.deepEqual(projectLayerSource(linked), own, 'a .git whose parent has no .doflow');

  fs.rmSync(path.join(gitdir, 'commondir'));
  fs.mkdirSync(path.join(gitdir, 'commondir'));
  assert.deepEqual(projectLayerSource(linked), own, 'a folder named commondir');
  fs.rmdirSync(path.join(gitdir, 'commondir'));

  write(path.join(gitdir, 'commondir'), original);
  assert.equal(projectLayerSource(linked).checkout, 'main', 'restored');
  assert.ok(fx);
});

test('a relative commondir resolves against the gitdir, as git writes it', (t) => {
  const { main, linked } = worktreePair(t);
  const gitdir = path.join(main, '.git', 'worktrees', path.basename(linked));
  write(path.join(gitdir, 'commondir'), '../..\n');
  assert.equal(projectLayerSource(linked).checkout, 'main');
  write(path.join(gitdir, 'commondir'), '..\n');
  assert.equal(projectLayerSource(linked).checkout, 'own', 'negative control: a wrong relative path');
});

test('a malformed gitdir line keeps the worktree own, and never throws', (t) => {
  const { linked } = worktreePair(t);
  const git = path.join(linked, '.git');
  const original = fs.readFileSync(git, 'utf8');
  assert.match(original, /^gitdir: /);
  const own = { layersFrom: path.join(linked, '.doflow'), checkout: 'own', files: filesOf(linked) };
  for (const bad of ['', 'garbage\n', 'gitdir:\n', 'gitdir:    \n', 'gitdir /x\n', `gitdir: ${path.join(linked, 'nope')}\n`,
    'gitdir: /a\0b\n', `gitdir: /${'x'.repeat(5000)}\n`, 'gitdir: /a\ngitdir: /b\n']) {
    fs.writeFileSync(git, bad);
    assert.deepEqual(projectLayerSource(linked), own, JSON.stringify(bad.slice(0, 20)));
  }
  fs.writeFileSync(git, original);
  assert.equal(projectLayerSource(linked).checkout, 'main', 'restored');
});

test('.git missing everywhere: the starting folder is its own checkout; no path or null input is no layer', (t) => {
  const dir = tempDir(t, 'doflow-layers-nogit-');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  const bare = (p) => ({ layersFrom: path.join(p, '.doflow'), checkout: 'own', files: filesOf(p) });
  assert.deepEqual(projectLayerSource(path.join(dir, 'sub'), { ...fs, lstatSync: (p, ...r) => { if (path.basename(p) === '.git') throw Object.assign(new Error('x'), { code: 'ENOENT' }); return fs.lstatSync(p, ...r); } }), bare(path.join(dir, 'sub')));
  for (const none of [null, undefined, '']) assert.deepEqual(projectLayerSource(none), { layersFrom: null, checkout: null, files: [] });
});

test('a filesystem that throws on every call yields no layer, never a throw', () => {
  const boom = () => { throw new Error('boom'); };
  const got = projectLayerSource('/some/where', { lstatSync: boom, statSync: boom, readFileSync: boom, realpathSync: boom });
  assert.deepEqual(got, { layersFrom: path.join('/some/where', '.doflow'), checkout: 'own', files: filesOf('/some/where') });
});

test('a dispatch worktree under <root>/.doflow/state/dispatch-worktrees/<id> is a sandbox with its own folder', (t) => {
  const { fx, main } = worktreePair(t);
  const env = fx.env();
  const id = 'd-0123456789ab';
  const sandbox = path.join(main, '.doflow', 'state', 'dispatch-worktrees', id);
  childProcess.spawnSync('git', ['worktree', 'add', '-q', '-b', `dispatch-${id}`, sandbox], { cwd: main, env, encoding: 'utf8' });
  assert.ok(fs.statSync(path.join(sandbox, '.git')).isFile());

  // negative control: without the marker it is only a linked worktree and inherits the main folder
  assert.equal(projectLayerSource(sandbox).checkout, 'main');

  fs.writeFileSync(path.join(sandbox, MARKER), 'abc123\n');
  const spy = countingFs();
  assert.deepEqual(projectLayerSource(sandbox, spy), { layersFrom: path.join(sandbox, '.doflow'), checkout: 'sandbox', files: filesOf(sandbox) });
  assert.equal(spy.counts.read, 0);
  fs.mkdirSync(path.join(sandbox, 'deep'), { recursive: true });
  assert.equal(projectLayerSource(path.join(sandbox, 'deep')).checkout, 'sandbox');
  // the main checkout, whose .doflow holds the sandbox, is still its own
  assert.equal(projectLayerSource(main).checkout, 'own');
});

test('no child process is spawned for any case', (t) => {
  const { fx, main, linked } = worktreePair(t);
  const sandbox = path.join(main, '.doflow', 'state', 'dispatch-worktrees', 'd-aaaaaaaaaaaa');
  childProcess.spawnSync('git', ['worktree', 'add', '-q', '-b', 'dispatch-aaa', sandbox], { cwd: main, env: fx.env(), encoding: 'utf8' });
  fs.writeFileSync(path.join(sandbox, MARKER), 'abc\n');

  const calls = [];
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  const saved = {};
  for (const name of names) {
    saved[name] = childProcess[name];
    childProcess[name] = (...args) => { calls.push(name); return saved[name](...args); };
  }
  try {
    for (const cwd of [main, linked, sandbox, path.join(linked, 'nope'), tempDir(t, 'doflow-layers-spy-')]) projectLayerSource(cwd);
    assert.deepEqual(calls, []);
    // negative control: the spy does see a spawn
    childProcess.spawnSync(process.execPath, ['-e', '0']);
    assert.deepEqual(calls, ['spawnSync']);
  } finally {
    for (const name of names) childProcess[name] = saved[name];
  }
});

test('a .doflow symlinked out of its checkout is not followed; one symlinked inside is', (t) => {
  const { fx, main, linked } = worktreePair(t);
  const outside = tempDir(t, 'doflow-layers-outside-');
  const unused = path.join(main, 'inner');
  fs.mkdirSync(unused);

  // own checkout
  fs.rmSync(path.join(main, '.doflow'), { recursive: true });
  fs.symlinkSync(outside, path.join(main, '.doflow'));
  assert.deepEqual(projectLayerSource(main), { layersFrom: null, checkout: 'own', files: [] });
  fs.rmSync(path.join(main, '.doflow'));
  fs.symlinkSync(unused, path.join(main, '.doflow'));
  assert.deepEqual(projectLayerSource(main), { layersFrom: path.join(main, '.doflow'), checkout: 'own', files: filesOf(main) }, 'inside the repo');

  // a linked worktree whose main .doflow escapes falls back to its own folder
  fs.rmSync(path.join(main, '.doflow'));
  fs.symlinkSync(outside, path.join(main, '.doflow'));
  assert.deepEqual(projectLayerSource(linked), { layersFrom: path.join(linked, '.doflow'), checkout: 'own', files: filesOf(linked) });
  fs.rmSync(path.join(main, '.doflow'));
  fs.symlinkSync(unused, path.join(main, '.doflow'));
  assert.equal(projectLayerSource(linked).checkout, 'main', 'negative control: contained link is followed');

  // a dangling link is contained by nothing: no layer, no throw
  fs.rmSync(path.join(main, '.doflow'));
  fs.symlinkSync(path.join(outside, 'gone'), path.join(main, '.doflow'));
  assert.equal(projectLayerSource(main).layersFrom, null);
  assert.ok(fx);
});

test('the answer is pure data: same tree, same result, deep-equal and JSON-safe', (t) => {
  const { linked } = worktreePair(t);
  const a = projectLayerSource(linked);
  assert.deepEqual(projectLayerSource(linked), a);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
});
