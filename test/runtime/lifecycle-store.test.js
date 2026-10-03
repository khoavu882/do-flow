'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { projectRoot } = require('../../src/runtime/lifecycle/root');
const store = require('../../src/runtime/lifecycle/event-store');

const scratch = createScratch('doflow-store-');
test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: scratch.env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function repo(name) {
  const dir = path.join(scratch.dir, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}
function plainDir(name) {
  const dir = path.join(scratch.dir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const added = (id, extra = {}) => ({ type: 'followup.added', by: 'agent', data: { id, statement: `s ${id}`, source: { kind: 'manual' }, ...extra } });

// ── root (IC-001, DEC-028) ─────────────────────────────────────────────────────────────────────

test('root: a plain repository is its own root, from any subfolder', () => {
  const dir = repo('plain');
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  assert.equal(projectRoot(dir), dir);
  assert.equal(projectRoot(path.join(dir, 'a', 'b')), dir);
});

test('root: every linked worktree resolves to the first worktree of the clone', () => {
  const dir = repo('main-clone');
  const linked = path.join(scratch.dir, 'linked');
  git(dir, 'worktree', 'add', '-q', '-b', 'feat/x', linked);
  assert.equal(projectRoot(linked), dir);
  assert.equal(projectRoot(dir), dir);
});

test('root: a bare repository skips its own bare entry for the first worktree', () => {
  const bare = path.join(scratch.dir, 'bare.git');
  git(scratch.dir, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = repo('seed');
  git(seed, 'push', '-q', bare, 'main');
  const wt = path.join(scratch.dir, 'bare-wt');
  git(bare, 'worktree', 'add', '-q', wt, 'main');
  assert.equal(projectRoot(wt), wt);
});

test('root: outside a git repository the working directory is the root', () => {
  const dir = plainDir('not-git');
  assert.equal(projectRoot(dir), dir);
});

test('root: a symlinked path resolves to the real path', () => {
  const dir = repo('real-repo');
  const link = path.join(scratch.dir, 'link-to-repo');
  fs.symlinkSync(dir, link);
  assert.equal(projectRoot(link), dir);
});

// ── reading ────────────────────────────────────────────────────────────────────────────────────

test('read: no folder gives an empty fold and creates nothing', () => {
  const dir = plainDir('read-empty');
  const result = store.readFold(dir);
  assert.deepEqual([result.followups, result.conflicts, result.unreadable], [[], [], []]);
  assert.equal(fs.existsSync(path.join(dir, 'agent-docs')), false);
});

test('read: names that are not event ids are ignored; a matching file that is not an envelope is unreadable', () => {
  const dir = plainDir('read-junk');
  const events = path.join(dir, store.EVENTS_REL);
  fs.mkdirSync(events, { recursive: true });
  fs.writeFileSync(path.join(events, 'notes.txt'), 'hi');
  fs.writeFileSync(path.join(events, 'README.json'), '{}');
  fs.writeFileSync(path.join(events, '20261004T091200123Z-k3m9ia.json'), '{"v":1}'); // i is not in the alphabet
  fs.writeFileSync(path.join(events, '20261004T091200123Z-k3m9qa.json'), '{"v":1,"id":"20261004T091200123Z-k3m9qa"'); // torn
  fs.writeFileSync(path.join(events, '20261004T091200124Z-k3m9qb.json'), JSON.stringify({ v: 1, id: '20261004T091200999Z-k3m9qb', type: 'x', at: '2026-10-04T09:12:00.124Z', by: 'agent', data: {} })); // id mismatch
  fs.writeFileSync(path.join(events, '20261004T091200125Z-k3m9qc.json'), JSON.stringify({ v: 1, id: '20261004T091200125Z-k3m9qc', type: 'feature.tracked', at: '2026-10-04T09:12:00.125Z', by: 'agent', data: { slug: 'f1' } }));
  const result = store.readFold(dir);
  assert.deepEqual(result.unreadable, ['20261004T091200123Z-k3m9qa.json', '20261004T091200124Z-k3m9qb.json']);
  assert.deepEqual(result.features.map((f) => f.slug), ['f1']);
});

// ── writing ────────────────────────────────────────────────────────────────────────────────────

test('write: an event file is named by its id, holds the IC-002 envelope and is created on first write', () => {
  const dir = plainDir('write-one');
  const now = new Date('2026-10-04T09:12:00.123Z');
  const out = store.appendEvents(dir, [added('FU-aaaaaa')], { now, random: () => 'k3m9qa' });
  assert.equal(out.ok, true);
  const [w] = out.written;
  assert.equal(w.id, '20261004T091200123Z-k3m9qa');
  assert.equal(w.file, 'agent-docs/lifecycle/events/20261004T091200123Z-k3m9qa.json');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, w.file), 'utf8'));
  assert.deepEqual(Object.keys(onDisk), ['v', 'id', 'type', 'at', 'by', 'data']);
  assert.equal(onDisk.at, '2026-10-04T09:12:00.123Z');
  assert.ok(store.EVENT_ID.test(w.id));
  assert.ok(!fs.existsSync(path.join(dir, 'agent-docs', 'lifecycle', 'events.lock')), 'the lock is released');
});

test('write: random characters come from the lowercase Crockford alphabet', () => {
  const chars = store.randomChars(2000);
  assert.equal(chars.length, 2000);
  assert.ok([...chars].every((c) => store.ALPHABET.includes(c)));
  assert.ok(!/[ilou]/.test(chars));
  assert.equal(store.ALPHABET.length, 32);
});

test('write: at is the later of the clock and one millisecond past the newest event seen', () => {
  const dir = plainDir('write-stamp');
  const late = new Date('2026-10-04T10:00:00.000Z');
  store.appendEvents(dir, [added('FU-aaaaaa')], { now: late });
  const behind = store.appendEvents(dir, [added('FU-bbbbbb')], { now: new Date('2026-10-04T09:00:00.000Z') });
  assert.equal(behind.written[0].event.at, '2026-10-04T10:00:00.001Z');
  const batch = store.appendEvents(dir, [added('FU-cccccc'), added('FU-dddddd')], { now: late });
  assert.deepEqual(batch.written.map((w) => w.event.at), ['2026-10-04T10:00:00.002Z', '2026-10-04T10:00:00.003Z']);
  const fold = store.readFold(dir);
  assert.deepEqual(fold.followups.map((f) => f.id), ['FU-aaaaaa', 'FU-bbbbbb', 'FU-cccccc', 'FU-dddddd']);
});

test('write: a name collision retries with new characters, at most five times, then refuses', () => {
  const dir = plainDir('write-collide');
  const now = new Date('2026-10-04T09:12:00.000Z');
  // Pre-create the files the next stamp would pick: 000001 is the first guess, then a free one.
  const events = path.join(dir, store.EVENTS_REL);
  fs.mkdirSync(events, { recursive: true });
  fs.writeFileSync(path.join(events, '20261004T091200000Z-000001.json'), 'taken');
  const draws = ['000001', '000001', '000002'];
  const retried = store.appendEvents(dir, [added('FU-aaaaaa')], { now, random: () => draws.shift() });
  assert.equal(retried.ok, true);
  assert.equal(retried.written[0].id, '20261004T091200000Z-000002');

  const dir2 = plainDir('write-collide-all');
  const events2 = path.join(dir2, store.EVENTS_REL);
  fs.mkdirSync(events2, { recursive: true });
  fs.writeFileSync(path.join(events2, '20261004T091200000Z-000001.json'), 'taken');
  let calls = 0;
  const refused = store.appendEvents(dir2, [added('FU-aaaaaa')], { now, random: () => { calls += 1; return '000001'; } });
  assert.equal(refused.ok, false);
  assert.equal(refused.finding, 'id-collision');
  assert.equal(calls, 2 + store.COLLISION_RETRIES, 'one draw for each of the two checks, then five retries');
});

test('write: an event never overwrites or edits an existing file', () => {
  const dir = plainDir('write-never-edit');
  const first = store.appendEvents(dir, [added('FU-aaaaaa')], { now: new Date('2026-10-04T09:00:00.000Z') });
  const file = path.join(dir, first.written[0].file);
  const before = fs.readFileSync(file, 'utf8');
  store.appendEvents(dir, [added('FU-bbbbbb')], { now: new Date('2026-10-04T09:00:00.000Z') });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readdirSync(path.join(dir, store.EVENTS_REL)).length, 2);
});

test('write: an illegal event is refused before anything is written, the whole call with it', () => {
  const dir = plainDir('write-illegal');
  store.appendEvents(dir, [added('FU-aaaaaa')]);
  const refused = store.appendEvents(dir, [
    added('FU-bbbbbb'),
    { type: 'followup.taken', by: 'agent', data: { ids: ['FU-aaaaaa'], feature: 'untracked' } },
  ]);
  assert.equal(refused.ok, false);
  assert.equal(refused.finding, 'illegal-transition');
  assert.equal(refused.conflict.code, 'untracked-feature');
  assert.match(refused.message, /Nothing was written/);
  assert.equal(fs.readdirSync(path.join(dir, store.EVENTS_REL)).length, 1);
  assert.deepEqual(store.readFold(dir).followups.map((f) => f.id), ['FU-aaaaaa']);
});

test('write: a refused write on a fresh project creates no folder and takes no lock', () => {
  const dir = plainDir('write-refused-fresh');
  const refused = store.appendEvents(dir, [{ type: 'followup.taken', by: 'agent', data: { ids: ['FU-aaaaaa'], feature: 'f1' } }]);
  assert.equal(refused.finding, 'illegal-transition');
  assert.equal(fs.existsSync(path.join(dir, 'agent-docs')), false);
});

test('write: a lock that cannot be taken refuses with store-locked and writes nothing', () => {
  const dir = plainDir('write-locked');
  // A stale-looking lock directory that cannot be removed: acquireLock gives up without waiting.
  const heldFs = {
    ...fs,
    mkdirSync: (p, o) => { if (String(p).endsWith('.lock')) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); return fs.mkdirSync(p, o); },
    statSync: () => ({ mtimeMs: 0 }),
    rmdirSync: () => {},
  };
  const out = store.appendEvents(dir, [added('FU-aaaaaa')], { fsImpl: heldFs });
  assert.equal(out.ok, false);
  assert.equal(out.finding, 'store-locked');
  assert.match(out.message, /Nothing was written/);
  assert.equal(fs.readdirSync(path.join(dir, store.EVENTS_REL)).length, 0);
});

test('write: concurrent processes serialise; every event lands, ids and times are distinct, no conflict', async () => {
  const dir = plainDir('write-concurrent');
  const script = `
    const store = require(${JSON.stringify(path.resolve(__dirname, '../../src/runtime/lifecycle/event-store'))});
    const tag = process.argv[1];
    for (let i = 0; i < 5; i += 1) {
      const out = store.appendEvents(${JSON.stringify(dir)}, [{ type: 'followup.added', by: 'agent', data: { id: 'FU-' + tag + i, statement: 's', source: { kind: 'manual' } } }]);
      if (!out.ok) { console.error(out.finding); process.exit(1); }
    }`;
  const runs = ['aaaa', 'bbbb', 'cccc', 'dddd'].map((tag) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, tag], { env: scratch.env(), stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${code}`))));
  }));
  await Promise.all(runs);
  const { events, unreadable } = store.readEvents(dir);
  assert.equal(events.length, 20);
  assert.deepEqual(unreadable, []);
  assert.equal(new Set(events.map((e) => e.id)).size, 20);
  assert.equal(new Set(events.map((e) => e.at)).size, 20, 'each at is unique, so a later event never sorts before one it saw');
  assert.deepEqual(store.readFold(dir).conflicts, []);
});

test('write: DoFlow touches no git state and writes no ignore rule', () => {
  const dir = repo('write-git');
  const head = git(dir, 'rev-parse', 'HEAD');
  store.appendEvents(dir, [added('FU-aaaaaa')]);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), '', 'nothing staged');
  assert.match(git(dir, 'status', '--porcelain'), /^\?\? agent-docs\/$/m);
  for (const name of ['.gitignore', '.gitattributes']) assert.equal(fs.existsSync(path.join(dir, name)), false);
  assert.equal(fs.existsSync(path.join(dir, '.git', 'info', 'exclude')) && /agent-docs/.test(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')), false);
});

test('channel: question, gate and prompt are the user; default is the agent; anything else is unknown', () => {
  assert.deepEqual(['question', 'gate', 'prompt', 'default', undefined, 'bogus'].map((c) => store.byFromChannel(c)), ['user', 'user', 'user', 'agent', 'agent', null]);
});
