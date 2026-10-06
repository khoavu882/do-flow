'use strict';

// The one-time copy of an old agent-docs/lifecycle/events store into .doflow/state/lifecycle/events,
// run by each lifecycle verb before its own work, and the notice that the old folder is no longer
// read. Every spawn runs under the scratch HOME and XDG_CONFIG_HOME.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const store = require('../../src/runtime/lifecycle/event-store');
const { prepareStore, LEGACY_EVENTS_REL, LEGACY_LIFECYCLE_REL, MARKER_REL } = require('../../src/runtime/lifecycle/store-upkeep');

const CLI = path.resolve(__dirname, '..', '..', 'bin', 'doflow.js');
const POSIX = process.platform !== 'win32';
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;
const NOTICE = 'note: the lifecycle store is now .doflow/state/lifecycle/events; agent-docs/lifecycle/ is no longer read and can be deleted';

const scratch = createScratch('doflow-migrate-');
test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

let count = 0;
function project(name) {
  const dir = path.join(scratch.dir, `${name}-${(count += 1)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: scratch.env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let seq = 0;
/** Writes one followup.added event into `folder` and returns its file name. */
function eventIn(folder, fu) {
  seq += 1;
  const at = new Date(Date.UTC(2026, 9, 1, 0, 0, 0, seq)).toISOString();
  const id = `${at.replace(/[-:.]/g, '')}-aaaaaa`;
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${id}.json`), `${JSON.stringify({ v: 1, id, type: 'followup.added', at, by: 'agent', data: { id: fu, statement: `s ${fu}`, source: { kind: 'manual' } } }, null, 2)}\n`);
  return `${id}.json`;
}
/** A project with an old store holding one event per follow-up id; returns the project and the event names. */
function withLegacy(name, fus = ['FU-aaaaaa', 'FU-bbbbbb', 'FU-cccccc']) {
  const dir = project(name);
  const names = fus.map((fu) => eventIn(path.join(dir, LEGACY_EVENTS_REL), fu));
  return { dir, names };
}

function run(cwd, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: scratch.env(), encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* text output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const listIds = (dir) => run(dir, ['followup', '--action', 'list', '--state', 'all', '--json']).json.items.map((i) => i.id).sort();

/** Every file under `dir` with its bytes, mode and modification time. */
function snapshot(dir) {
  const out = {};
  for (const rel of fs.readdirSync(dir, { recursive: true }).sort()) {
    const file = path.join(dir, rel);
    const st = fs.lstatSync(file);
    out[rel] = { mode: st.mode, mtimeMs: st.mtimeMs, sha: st.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null };
  }
  return out;
}
const eventsDir = (dir) => path.join(dir, store.EVENTS_REL);
const lifecycleEntries = (dir) => fs.readdirSync(path.join(dir, store.LIFECYCLE_REL)).sort();
const noticeLines = (stderr) => stderr.split('\n').filter((l) => l.includes(NOTICE));

// ── the copy ───────────────────────────────────────────────────────────────────────────────────

test('copy: the first verb copies the old store once with equal names and bytes; the old tree, git status and ignore rules are unchanged', () => {
  const { dir, names } = withLegacy('copy-once');
  fs.writeFileSync(path.join(dir, LEGACY_LIFECYCLE_REL, 'README.md'), 'old store\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'old store');
  const oldTree = snapshot(path.join(dir, LEGACY_LIFECYCLE_REL));
  const exclude = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');

  const r = run(dir, ['followup', '--action', 'list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.items.map((i) => i.id).sort(), ['FU-aaaaaa', 'FU-bbbbbb', 'FU-cccccc']);
  assert.deepEqual(fs.readdirSync(eventsDir(dir)).sort(), names);
  for (const name of names) {
    assert.ok(fs.readFileSync(path.join(eventsDir(dir), name)).equals(fs.readFileSync(path.join(dir, LEGACY_EVENTS_REL, name))), name);
  }
  assert.deepEqual(lifecycleEntries(dir), ['events', 'migrated.json'], 'no temp, replaced or lock folder is left');
  assert.deepEqual(snapshot(path.join(dir, LEGACY_LIFECYCLE_REL)), oldTree);
  assert.equal(git(dir, 'status', '--porcelain', '--', 'agent-docs'), '');
  for (const file of ['.gitignore', path.join('.doflow', '.gitignore'), path.join('.doflow', 'state', '.gitignore')]) assert.equal(fs.existsSync(path.join(dir, file)), false, file);
  assert.equal(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), exclude);
});

test('rerun: a second verb copies nothing, even when the old folder has gained an event since', () => {
  const { dir, names } = withLegacy('rerun');
  assert.equal(run(dir, ['followup', '--action', 'list', '--json']).status, 0);
  const inodes = names.map((name) => fs.statSync(path.join(eventsDir(dir), name)).ino);
  eventIn(path.join(dir, LEGACY_EVENTS_REL), 'FU-dddddd');
  const again = run(dir, ['followup', '--action', 'list', '--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(fs.readdirSync(eventsDir(dir)).sort(), names);
  assert.deepEqual(names.map((name) => fs.statSync(path.join(eventsDir(dir), name)).ino), inodes, 'the copies were not rewritten');
  assert.deepEqual(again.json.items.map((i) => i.id).sort(), ['FU-aaaaaa', 'FU-bbbbbb', 'FU-cccccc']);
});

test('concurrency: two processes started together leave each event once and both exit 0', async () => {
  const { dir, names } = withLegacy('concurrent', Array.from({ length: 30 }, (_, i) => `FU-${String(i).padStart(6, '0')}`));
  const once = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'followup', '--action', 'list', '--state', 'all', '--json'], { cwd: dir, env: scratch.env() });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('exit', (code) => resolve({ code, stdout }));
  });
  const results = await Promise.all([once(), once()]);
  for (const r of results) {
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).items.length, names.length);
  }
  assert.deepEqual(fs.readdirSync(eventsDir(dir)).sort(), names);
  assert.deepEqual(lifecycleEntries(dir), ['events', 'migrated.json']);
});

// ── faults ─────────────────────────────────────────────────────────────────────────────────────

test('fault: a copy that fails part way refuses with store-migration-failed, leaves no events and no temp folder, and the next run copies', () => {
  const { dir, names } = withLegacy('fault-copy');
  const oldTree = snapshot(path.join(dir, LEGACY_LIFECYCLE_REL));
  let copies = 0;
  const failing = {
    ...fs,
    copyFileSync: (...args) => {
      copies += 1;
      if (copies === 2) throw Object.assign(new Error('disk said no'), { code: 'EIO' });
      return fs.copyFileSync(...args);
    },
  };
  const out = prepareStore(dir, { fsImpl: failing });
  assert.deepEqual([out.ok, out.finding], [false, 'store-migration-failed']);
  assert.match(out.message, /^could not copy agent-docs\/lifecycle\/events to \.doflow\/state\/lifecycle\/events \(EIO\); the old folder is unchanged and the next lifecycle command retries\. Nothing was written\.$/);
  assert.deepEqual(lifecycleEntries(dir), [], 'no events, no events.migrating-*, no lock, no marker');
  assert.deepEqual(snapshot(path.join(dir, LEGACY_LIFECYCLE_REL)), oldTree);

  const next = prepareStore(dir);
  assert.deepEqual(next, { ok: true, lines: [NOTICE] });
  assert.deepEqual(fs.readdirSync(eventsDir(dir)).sort(), names);
});

test('fault: a read-only .doflow/state/lifecycle refuses the verb with exit 1 and store-migration-failed; the next run succeeds', { skip: !POSIX || ROOT_USER }, () => {
  const { dir, names } = withLegacy('fault-readonly');
  const lifecycle = path.join(dir, store.LIFECYCLE_REL);
  fs.mkdirSync(lifecycle, { recursive: true });
  fs.chmodSync(lifecycle, 0o555);
  try {
    const r = run(dir, ['followup', '--action', 'list', '--json']);
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual([r.json.ok, r.json.action, r.json.finding], [false, 'list', 'store-migration-failed']);
    assert.match(r.json.message, /\(EACCES\)/);
    const text = run(dir, ['goal', '--action', 'list']);
    assert.equal(text.status, 1);
    assert.match(text.stdout, /^store-migration-failed: could not copy agent-docs\/lifecycle\/events/m);
    assert.deepEqual(fs.readdirSync(lifecycle), []);
  } finally {
    fs.chmodSync(lifecycle, 0o755);
  }
  const retry = run(dir, ['followup', '--action', 'list', '--json']);
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(fs.readdirSync(eventsDir(dir)).sort(), names);
});

// ── what is already at the new location ────────────────────────────────────────────────────────

test('an empty events folder at the new location is replaced by the copy', () => {
  const { dir, names } = withLegacy('empty-new');
  fs.mkdirSync(eventsDir(dir), { recursive: true });
  assert.equal(run(dir, ['followup', '--action', 'list', '--json']).status, 0);
  assert.deepEqual(fs.readdirSync(eventsDir(dir)).sort(), names);
  assert.deepEqual(lifecycleEntries(dir), ['events', 'migrated.json'], 'the empty folder it replaced is gone');
});

test('an events folder holding only non-event entries is kept as events.replaced-*', () => {
  const { dir, names } = withLegacy('junk-new');
  fs.mkdirSync(eventsDir(dir), { recursive: true });
  fs.writeFileSync(path.join(eventsDir(dir), 'notes.txt'), 'mine');
  assert.equal(run(dir, ['followup', '--action', 'list', '--json']).status, 0);
  assert.deepEqual(fs.readdirSync(eventsDir(dir)).sort(), names);
  const replaced = lifecycleEntries(dir).filter((n) => n !== 'events' && n !== 'migrated.json');
  assert.equal(replaced.length, 1);
  assert.match(replaced[0], /^events\.replaced-[0-9a-hjkmnp-tv-z]{6}$/);
  assert.deepEqual(fs.readdirSync(path.join(dir, store.LIFECYCLE_REL, replaced[0])), ['notes.txt']);
});

test('both stores present: only the new store is read, nothing is copied, and the notice still prints', () => {
  const { dir } = withLegacy('both', ['FU-aaaaaa']);
  const own = eventIn(eventsDir(dir), 'FU-bbbbbb');
  const r = run(dir, ['followup', '--action', 'list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.items.map((i) => i.id), ['FU-bbbbbb']);
  assert.deepEqual(fs.readdirSync(eventsDir(dir)), [own]);
  assert.equal(noticeLines(r.stderr).length, 1);
});

test('only event-named regular files are copied: other files, event-named folders and event-named symlinks stay behind', () => {
  const { dir, names } = withLegacy('selective', ['FU-aaaaaa']);
  const legacy = path.join(dir, LEGACY_EVENTS_REL);
  fs.writeFileSync(path.join(legacy, 'README.md'), 'x');
  fs.writeFileSync(path.join(legacy, 'notes.json'), '{}');
  fs.mkdirSync(path.join(legacy, '20261001T000000000Z-bbbbbb.json'));
  if (POSIX) {
    const outside = path.join(scratch.dir, 'selective-outside');
    const target = eventIn(outside, 'FU-zzzzzz');
    fs.symlinkSync(path.join(outside, target), path.join(legacy, target));
  }
  assert.equal(run(dir, ['followup', '--action', 'list', '--json']).status, 0);
  assert.deepEqual(fs.readdirSync(eventsDir(dir)), names);
  assert.deepEqual(listIds(dir), ['FU-aaaaaa']);
});

test('a symlinked old lifecycle folder is refused with exit 2 and nothing is created', { skip: !POSIX }, () => {
  const dir = project('legacy-link');
  const elsewhere = path.join(scratch.dir, 'legacy-link-elsewhere');
  eventIn(path.join(elsewhere, 'events'), 'FU-aaaaaa');
  fs.mkdirSync(path.join(dir, 'agent-docs'));
  fs.symlinkSync(elsewhere, path.join(dir, LEGACY_LIFECYCLE_REL));
  const r = run(dir, ['followup', '--action', 'list', '--json']);
  assert.equal(r.status, 2);
  assert.deepEqual([r.json.ok, r.json.error], [false, 'usage']);
  assert.match(r.json.summary, /symbolic link/);
  assert.equal(fs.existsSync(path.join(dir, '.doflow')), false);
});

// ── the notice and the verbs ───────────────────────────────────────────────────────────────────

test('notice: one line per invocation on stderr for followup, lifecycle and goal; --json stdout still parses and text stdout carries no notice', () => {
  const { dir } = withLegacy('notice', ['FU-aaaaaa']);
  for (const [verb, args] of [['followup', ['--action', 'list']], ['lifecycle', []], ['goal', ['--action', 'list']], ['followup', ['--action', 'list']]]) {
    const r = run(dir, [verb, ...args, '--json']);
    assert.equal(r.status, 0, `${verb}: ${r.stderr}`);
    assert.ok(r.json && r.json.ok, verb);
    assert.deepEqual(noticeLines(r.stderr), [`doflow ${verb}: ${NOTICE}`], verb);
  }
  const text = run(dir, ['followup', '--action', 'list']);
  assert.equal(noticeLines(text.stderr).length, 1);
  assert.equal(noticeLines(text.stdout).length, 0);
});

test('notice: an old folder holding no event still prints the notice and copies nothing', () => {
  const dir = project('notice-empty');
  fs.mkdirSync(path.join(dir, LEGACY_EVENTS_REL), { recursive: true });
  const r = run(dir, ['followup', '--action', 'list', '--json']);
  assert.equal(r.status, 0);
  assert.equal(noticeLines(r.stderr).length, 1);
  assert.equal(fs.existsSync(path.join(dir, '.doflow')), false);
});

test('a read-only verb in an empty project creates neither folder and prints no notice', () => {
  const dir = project('empty');
  for (const args of [['followup', '--action', 'list', '--json'], ['goal', '--action', 'list', '--json'], ['lifecycle', '--json']]) {
    const r = run(dir, args);
    assert.equal(r.status, 0, args.join(' '));
    assert.equal(noticeLines(r.stderr).length, 0);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a fresh project with no .doflow gets .doflow/state/lifecycle/events on followup --action add', () => {
  const dir = project('fresh');
  const r = run(dir, ['followup', '--action', 'add', '--source', 'manual', '--statement', 'first one', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readdirSync(eventsDir(dir)).length, 1);
  assert.deepEqual(fs.readdirSync(dir), ['.doflow']);
});

test('a usage error found before the project root runs no copy', () => {
  const { dir } = withLegacy('usage', ['FU-aaaaaa']);
  for (const args of [['followup', '--action', 'bogus', '--json'], ['goal', '--action', 'add', '--json'], ['lifecycle', '--action', 'status', '--tag', 'v1', '--json']]) {
    const r = run(dir, args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(noticeLines(r.stderr).length, 0, args.join(' '));
  }
  assert.equal(fs.existsSync(path.join(dir, '.doflow')), false);
});

// ── copy once: the completion marker ──────────────────────────────────────────────────────────────

const HOUR = 3600000;
/** One event file dated `hoursAgo`, written straight into `folder`. */
function agedEvent(folder, type, data, hoursAgo) {
  seq += 1;
  const at = new Date(Date.now() - hoursAgo * HOUR + seq).toISOString();
  const id = `${at.replace(/[-:.]/g, '')}-aaaaaa`;
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${id}.json`), JSON.stringify({ v: 1, id, type, at, by: 'agent', data }));
  return `${id}.json`;
}
const marker = (dir) => JSON.parse(fs.readFileSync(path.join(dir, MARKER_REL), 'utf8'));

test('marker: after the copy, a store that retention empties is never filled from the old folder again', () => {
  const dir = project('marker-copy');
  agedEvent(path.join(dir, LEGACY_EVENTS_REL), 'followup.added', { id: 'FU-aaaaaa', statement: 's', source: { kind: 'manual' } }, 300);
  assert.equal(run(dir, ['followup', '--action', 'list', '--json']).status, 0);
  assert.deepEqual([marker(dir).v, marker(dir).copied], [1, 1]);
  agedEvent(eventsDir(dir), 'followup.settled', { id: 'FU-aaaaaa', as: 'dismissed', reason: 'gone' }, 299);
  const pruned = spawnSync(process.execPath, [CLI, 'followup', '--action', 'list', '--json'], { cwd: dir, env: scratch.env({ DOFLOW_RETENTION_HOURS: '1' }), encoding: 'utf8' });
  assert.match(pruned.stderr, /retention: removed 2 event files/);
  assert.deepEqual(fs.readdirSync(eventsDir(dir)), []);
  const after = run(dir, ['followup', '--action', 'list', '--state', 'all', '--json']);
  assert.deepEqual(after.json.items, [], 'the dismissed follow-up does not come back open');
  assert.deepEqual(fs.readdirSync(eventsDir(dir)), []);
  assert.ok(fs.existsSync(path.join(dir, MARKER_REL)), 'retention keeps the marker');
});

test('marker: a store that already holds events and no marker is marked without a copy, and stays unfilled once emptied', () => {
  const dir = project('marker-existing');
  agedEvent(path.join(dir, LEGACY_EVENTS_REL), 'followup.added', { id: 'FU-aaaaaa', statement: 'old', source: { kind: 'manual' } }, 300);
  agedEvent(eventsDir(dir), 'followup.added', { id: 'FU-bbbbbb', statement: 'new', source: { kind: 'manual' } }, 300);
  agedEvent(eventsDir(dir), 'followup.settled', { id: 'FU-bbbbbb', as: 'dismissed', reason: 'gone' }, 299);
  const pruned = spawnSync(process.execPath, [CLI, 'followup', '--action', 'list', '--json'], { cwd: dir, env: scratch.env({ DOFLOW_RETENTION_HOURS: '1' }), encoding: 'utf8' });
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.equal(marker(dir).copied, 0);
  assert.deepEqual(fs.readdirSync(eventsDir(dir)), []);
  assert.deepEqual(run(dir, ['followup', '--action', 'list', '--state', 'all', '--json']).json.items, []);
  assert.deepEqual(fs.readdirSync(eventsDir(dir)), [], 'FU-aaaaaa from the old folder is never copied in');
});

test('marker: a read-only old folder and read-only event files are copied, and their modes are left as they were', { skip: !POSIX }, () => {
  const { dir, names } = withLegacy('readonly-source');
  const legacy = path.join(dir, LEGACY_EVENTS_REL);
  for (const name of names) fs.chmodSync(path.join(legacy, name), 0o444);
  fs.chmodSync(legacy, 0o555);
  try {
    const oldTree = snapshot(path.join(dir, LEGACY_LIFECYCLE_REL));
    const r = run(dir, ['followup', '--action', 'list', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(fs.readdirSync(eventsDir(dir)).sort(), names);
    for (const name of names) assert.ok(fs.readFileSync(path.join(eventsDir(dir), name)).equals(fs.readFileSync(path.join(legacy, name))), name);
    assert.deepEqual(snapshot(path.join(dir, LEGACY_LIFECYCLE_REL)), oldTree);
  } finally {
    fs.chmodSync(legacy, 0o755);
  }
});

test('marker: an unlistable old folder refuses with store-migration-failed before the marker exists, and is never touched after', { skip: !POSIX || ROOT_USER }, () => {
  const { dir } = withLegacy('unlistable', ['FU-aaaaaa']);
  const legacy = path.join(dir, LEGACY_EVENTS_REL);
  fs.chmodSync(legacy, 0o000);
  try {
    const refused = run(dir, ['followup', '--action', 'list', '--json']);
    assert.equal(refused.status, 1, refused.stderr);
    assert.deepEqual([refused.json.ok, refused.json.finding], [false, 'store-migration-failed']);
    assert.match(refused.json.message, /^could not list agent-docs\/lifecycle\/events \(EACCES\)/);
    assert.equal(fs.existsSync(path.join(dir, '.doflow')), false);
    fs.chmodSync(legacy, 0o755);
    assert.equal(run(dir, ['followup', '--action', 'list', '--json']).status, 0);
    assert.ok(fs.existsSync(path.join(dir, MARKER_REL)));
    fs.chmodSync(legacy, 0o000);
    const after = run(dir, ['followup', '--action', 'list', '--json']);
    assert.equal(after.status, 0, after.stderr);
    assert.deepEqual(after.json.items.map((i) => i.id), ['FU-aaaaaa']);
  } finally {
    fs.chmodSync(legacy, 0o755);
  }
});

// ── a lock that never comes, and an unwritable store ─────────────────────────────────────────────

/** A preload that makes every store read time out on the lock, as a long pass by another verb would. */
function lockedPreload() {
  const file = path.join(scratch.dir, 'locked-preload.js');
  const storePath = path.resolve(__dirname, '..', '..', 'src', 'runtime', 'lifecycle', 'event-store');
  fs.writeFileSync(file, `const store = require(${JSON.stringify(storePath)});
const locked = () => { throw new store.StoreLockedError("Could not lock 'events' after 5s. Nothing was written."); };
store.readEvents = locked;
store.readFold = locked;
`);
  return file;
}

test('a lock timeout while reading is the store-locked refusal (exit 1, refusal shape) for followup, lifecycle, goal and the upkeep look-ahead', () => {
  const dir = project('lock-timeout');
  agedEvent(eventsDir(dir), 'followup.added', { id: 'FU-aaaaaa', statement: 's', source: { kind: 'manual' } }, 300);
  assert.equal(run(dir, ['followup', '--action', 'list', '--json']).status, 0, 'marks the store before reads are blocked');
  const preload = lockedPreload();
  for (const [args, action, extra] of [
    [['followup', '--action', 'list', '--json'], 'list', {}],
    [['lifecycle', '--json'], 'overview', {}],
    [['goal', '--action', 'list', '--json'], 'list', {}],
    [['followup', '--action', 'list', '--json'], 'list', { DOFLOW_RETENTION_HOURS: '1' }],
  ]) {
    const r = spawnSync(process.execPath, ['-r', preload, CLI, ...args], { cwd: dir, env: scratch.env(extra), encoding: 'utf8' });
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), { ok: false, action, finding: 'store-locked', message: "Could not lock 'events' after 5s. Nothing was written." });
  }
  const text = spawnSync(process.execPath, ['-r', preload, CLI, 'goal', '--action', 'list'], { cwd: dir, env: scratch.env(), encoding: 'utf8' });
  assert.equal(text.status, 1);
  assert.match(text.stdout, /^store-locked: Could not lock/);
});

test('an unwritable store with nothing to copy skips retention and says so; nothing is hidden or removed', { skip: !POSIX || ROOT_USER }, () => {
  const dir = project('unwritable');
  const files = [
    agedEvent(eventsDir(dir), 'followup.added', { id: 'FU-aaaaaa', statement: 's', source: { kind: 'manual' } }, 300),
    agedEvent(eventsDir(dir), 'followup.settled', { id: 'FU-aaaaaa', as: 'dismissed', reason: 'r' }, 299),
  ].sort();
  assert.equal(run(dir, ['followup', '--action', 'list', '--json']).status, 0);
  const lifecycle = path.join(dir, store.LIFECYCLE_REL);
  fs.chmodSync(lifecycle, 0o555);
  try {
    const r = spawnSync(process.execPath, [CLI, 'followup', '--action', 'list', '--state', 'all', '--json'], { cwd: dir, env: scratch.env({ DOFLOW_RETENTION_HOURS: '1' }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stderr.trim().split('\n'), ['doflow followup: warning: retention skipped: .doflow/state/lifecycle cannot be written (EACCES); nothing was hidden or removed']);
    assert.deepEqual(JSON.parse(r.stdout).items.map((i) => [i.id, i.state]), [['FU-aaaaaa', 'dismissed']]);
    assert.deepEqual(fs.readdirSync(eventsDir(dir)).sort(), files);
  } finally {
    fs.chmodSync(lifecycle, 0o755);
  }
});
