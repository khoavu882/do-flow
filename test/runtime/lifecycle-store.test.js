'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { projectRoot } = require('../../src/runtime/lifecycle/root');
const store = require('../../src/runtime/lifecycle/event-store');
const { foldEvents } = require('../../src/runtime/lifecycle/fold');

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
let boundsCount = 0;
function plainRoot2(name) { boundsCount += 1; return plainDir(`${name}-${boundsCount}`); }
function plainDir(name) {
  const dir = path.join(scratch.dir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const added = (id, extra = {}) => ({ type: 'followup.added', by: 'agent', data: { id, statement: `s ${id}`, source: { kind: 'manual' }, ...extra } });

// ── root (IC-001, DEC-043) ─────────────────────────────────────────────────────────────────────

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

test('root: a bare clone has no main working tree, so each linked worktree is its own root, stable as siblings come and go', () => {
  const bare = path.join(scratch.dir, 'bare.git');
  git(scratch.dir, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = repo('seed');
  git(seed, 'push', '-q', bare, 'main');
  const one = path.join(scratch.dir, 'bare-wt1');
  git(bare, 'worktree', 'add', '-q', one, 'main');
  assert.equal(projectRoot(one), one);
  const two = path.join(scratch.dir, 'bare-wt2');
  git(bare, 'worktree', 'add', '-q', '-b', 'feat/two', two, 'main');
  assert.equal(projectRoot(one), one, 'adding a sibling does not move the first worktree\'s root');
  assert.equal(projectRoot(two), two);
  fs.rmSync(one, { recursive: true });
  assert.equal(projectRoot(two), two, 'a deleted, unpruned sibling is never chosen');
  assert.equal(fs.existsSync(one), false, 'nothing was created at the deleted worktree');
});

test('root: a submodule resolves to its working tree, never into .git/modules', () => {
  const sub = repo('sub-source');
  const parent = repo('sub-parent');
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub');
  const work = path.join(parent, 'vendor', 'sub');
  assert.equal(projectRoot(work), work);
  fs.mkdirSync(path.join(work, 'deep'));
  assert.equal(projectRoot(path.join(work, 'deep')), work);
  assert.ok(!projectRoot(work).includes(`${path.sep}.git${path.sep}`));
});

test('root: a repository with a separate git dir resolves to its working tree', () => {
  const work = path.join(scratch.dir, 'sep-work');
  const gitDir = path.join(scratch.dir, 'sep-gitdir');
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main', `--separate-git-dir=${gitDir}`);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'init');
  assert.equal(projectRoot(work), work);
  assert.notEqual(projectRoot(work), gitDir);
});

test('root: a main working tree that was moved away is not chosen; the current worktree is', () => {
  const main = repo('moved-main');
  const linked = path.join(scratch.dir, 'moved-linked');
  git(main, 'worktree', 'add', '-q', '-b', 'feat/moved', linked);
  const moved = path.join(scratch.dir, 'moved-main-away');
  fs.renameSync(main, moved);
  assert.equal(projectRoot(linked), linked);
  assert.equal(fs.existsSync(main), false, 'the vanished path was not recreated');
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
  assert.equal(fs.existsSync(path.join(dir, store.LIFECYCLE_REL)), false);
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
  assert.equal(w.file, '.doflow/state/lifecycle/events/20261004T091200123Z-k3m9qa.json');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, w.file), 'utf8'));
  assert.deepEqual(Object.keys(onDisk), ['v', 'id', 'type', 'at', 'by', 'data']);
  assert.equal(onDisk.at, '2026-10-04T09:12:00.123Z');
  assert.ok(store.EVENT_ID.test(w.id));
  assert.ok(!fs.existsSync(path.join(dir, '.doflow', 'state', 'lifecycle', 'events.lock')), 'the lock is released');
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
  assert.equal(fs.existsSync(path.join(dir, store.LIFECYCLE_REL)), false);
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
  assert.match(git(dir, 'status', '--porcelain'), /^\?\? \.doflow\/$/m);
  for (const name of ['.gitignore', '.gitattributes']) assert.equal(fs.existsSync(path.join(dir, name)), false);
  assert.equal(fs.existsSync(path.join(dir, '.git', 'info', 'exclude')) && /\.doflow/.test(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')), false);
});

function eventFile(dir, event) {
  const events = path.join(dir, store.EVENTS_REL);
  fs.mkdirSync(events, { recursive: true });
  fs.writeFileSync(path.join(events, `${event.id}.json`), JSON.stringify(event));
}
const stampOf = (at) => at.replace(/[-:.]/g, '');

test('time bounds: an at that is not a strict UTC timestamp, or differs from the id prefix, is unreadable and later writes still work (DEC-045)', () => {
  const dir = plainRoot2('bounds-strict');
  const tracked = (id, at) => ({ v: 1, id, type: 'feature.tracked', at, by: 'agent', data: { slug: 'f1' } });
  eventFile(dir, tracked('+275760-09-13T000000.000Z-aaaaaa', '+275760-09-13T00:00:00.000Z')); // name is not an id: ignored
  eventFile(dir, tracked('99991231T235959999Z-aaaaab', '+010000-01-01T00:00:00.000Z'));
  eventFile(dir, tracked('20261004T091200123Z-aaaaac', '2026-10-04T09:12:00.124Z'));       // prefix differs from at
  eventFile(dir, tracked('20261004T091200123Z-aaaaad', '2026-10-04T09:12:00Z'));           // no milliseconds
  eventFile(dir, tracked('20261304T091200123Z-aaaaae', '2026-13-04T09:12:00.123Z'));       // not a real month
  eventFile(dir, tracked('20260230T091200123Z-aaaaaf', '2026-02-30T09:12:00.123Z'));       // not a real day
  const { events, unreadable } = store.readEvents(dir);
  assert.deepEqual(events, []);
  assert.equal(unreadable.length, 5);
  const out = store.appendEvents(dir, [added('FU-aaaaaa')], { now: new Date('2026-10-04T10:00:00.000Z') });
  assert.equal(out.ok, true);
  assert.equal(store.readFold(dir, { now: new Date('2026-10-04T10:00:00.000Z') }).followups.length, 1);
});

test('time bounds: an event dated over 24 hours ahead is left out of the stamp floor and the tracking bound, and listed as a conflict', () => {
  const dir = plainRoot2('bounds-future');
  const now = new Date('2026-10-04T10:00:00.000Z');
  const at = '2030-01-01T00:00:00.000Z';
  eventFile(dir, { v: 1, id: `${stampOf(at)}-aaaaaa`, type: 'followup.added', at, by: 'agent', data: { id: 'FU-bbbbbb', statement: 'from a wrong clock', source: { kind: 'manual' } } });
  const out = store.appendEvents(dir, [{ type: 'feature.tracked', by: 'agent', data: { slug: 'f1' } }], { now });
  assert.equal(out.written[0].event.at, now.toISOString(), 'the stamp is not pushed to 2030');
  const fold = store.readFold(dir, { now });
  assert.equal(fold.features[0].trackedAt, now.toISOString());
  assert.deepEqual(fold.conflicts.map((c) => c.code), ['future-event']);
  assert.deepEqual(fold.followups, [], 'the future event is not applied');
  const near = new Date(now.getTime() + 23 * 3600 * 1000).toISOString();
  eventFile(dir, { v: 1, id: `${stampOf(near)}-aaaaab`, type: 'followup.added', at: near, by: 'agent', data: { id: 'FU-cccccc', statement: 'a fast clock, within a day', source: { kind: 'manual' } } });
  assert.deepEqual(store.readFold(dir, { now }).followups.map((f) => f.id), ['FU-cccccc']);
  assert.equal(foldEvents([], { now }).conflicts.length, 0);
});

test('time bounds: a write that cannot produce a valid id fails with a finding and creates nothing', () => {
  const dir = plainRoot2('bounds-invalid-id');
  const badRandom = store.appendEvents(dir, [added('FU-aaaaaa')], { random: () => 'ABC!!!' });
  assert.deepEqual([badRandom.ok, badRandom.finding], [false, 'invalid-id']);
  const farFuture = store.appendEvents(dir, [added('FU-aaaaaa')], { now: new Date(8.64e15) });
  assert.deepEqual([farFuture.ok, farFuture.finding], [false, 'invalid-id']);
  assert.equal(fs.existsSync(path.join(dir, store.LIFECYCLE_REL)), false, 'a refused write creates no folder');
  const last = store.appendEvents(dir, [added('FU-aaaaaa')], { now: new Date('9999-12-31T23:59:59.999Z') });
  assert.equal(last.ok, true, 'the last valid stamp is the end of year 9999');
  const beyond = store.appendEvents(dir, [added('FU-bbbbbb')], { now: new Date('9999-12-31T23:59:59.999Z') });
  assert.equal(beyond.finding, 'invalid-id', 'one more millisecond would leave the id shape');
  assert.equal(fs.readdirSync(path.join(dir, store.EVENTS_REL)).length, 1);
});

test('write: a batch whose second id cannot be made free writes nothing, not even the first event', () => {
  const dir = plainRoot2('batch-collide');
  const now = new Date('2026-10-04T09:12:00.000Z');
  const events = path.join(dir, store.EVENTS_REL);
  fs.mkdirSync(events, { recursive: true });
  fs.writeFileSync(path.join(events, '20261004T091200001Z-000001.json'), 'taken'); // the second draft's stamp (+1 ms)
  const refused = store.appendEvents(dir, [added('FU-aaaaaa'), added('FU-bbbbbb')], { now, random: () => '000001' });
  assert.deepEqual([refused.ok, refused.finding, refused.written], [false, 'id-collision', []]);
  assert.deepEqual(fs.readdirSync(events), ['20261004T091200001Z-000001.json']);
});

test('channel: question, gate and prompt are the user; default is the agent; anything else is unknown', () => {
  assert.deepEqual(['question', 'gate', 'prompt', 'default', undefined, 'bogus'].map((c) => store.byFromChannel(c)), ['user', 'user', 'user', 'agent', 'agent', null]);
});

// ── hostile store entries: only regular files of bounded size are read ───────────────────────────

const POSIX = process.platform !== 'win32';
const EVENT_FILE = '20261003T000000000Z-aaaaaa.json';
const validEvent = (extra = {}) => ({
  v: 1, id: '20261003T000000000Z-aaaaaa', type: 'followup.added', at: '2026-10-03T00:00:00.000Z', by: 'agent',
  data: { id: 'FU-aaaaaa', statement: 'a statement', source: { kind: 'manual' }, ...extra },
});
function storeWith(name) {
  const root = plainDir(name);
  const dir = path.join(root, store.EVENTS_REL);
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir, file: path.join(dir, EVENT_FILE) };
}
function expectSkipped(root, reason) {
  const read = store.readEvents(root);
  assert.deepEqual(read.events, []);
  assert.deepEqual(read.unreadable, [EVENT_FILE]);
  assert.match(read.reasons[EVENT_FILE], reason);
  const folded = store.readFold(root);
  assert.deepEqual(folded.unreadable, [EVENT_FILE]);
  assert.match(folded.unreadableReasons[EVENT_FILE], reason);
}

test('hostile store: a symlink to /dev/zero is skipped as unreadable, never read', { skip: !POSIX }, () => {
  const s = storeWith('hostile-zero');
  fs.symlinkSync('/dev/zero', s.file);
  expectSkipped(s.root, /not a regular file/);
});

test('hostile store: a symlink to a valid event outside the store is not followed', { skip: !POSIX }, () => {
  const s = storeWith('hostile-outside');
  const outside = path.join(scratch.dir, 'hostile-outside-event.json');
  fs.writeFileSync(outside, JSON.stringify(validEvent({ statement: 'OUTSIDE' })));
  fs.symlinkSync(outside, s.file);
  expectSkipped(s.root, /not a regular file/);
});

test('hostile store: a FIFO is skipped as unreadable and does not block the read', { skip: !POSIX }, () => {
  const s = storeWith('hostile-fifo');
  execFileSync('mkfifo', [s.file]);
  expectSkipped(s.root, /not a regular file/);
});

test('hostile store: a folder named like an event is unreadable', () => {
  const s = storeWith('hostile-folder');
  fs.mkdirSync(s.file);
  expectSkipped(s.root, /not a regular file/);
});

test('hostile store: a file over 256 KiB is unreadable; the largest legitimate event (100 items of 280 characters) is read', () => {
  const big = storeWith('hostile-big');
  fs.writeFileSync(big.file, `${JSON.stringify(validEvent())}${' '.repeat(store.MAX_EVENT_BYTES)}`);
  expectSkipped(big.root, /larger than 256 KiB/);

  const goal = storeWith('legit-goal');
  const items = Array.from({ length: 100 }, (_, i) => ({ id: `I-${i + 1}`, text: 'x'.repeat(280) }));
  const event = { v: 1, id: '20261003T000000000Z-aaaaaa', type: 'goal.added', at: '2026-10-03T00:00:00.000Z', by: 'agent', data: { goal: 'G-aaaaaa', outcome: 'o', items } };
  fs.writeFileSync(goal.file, `${JSON.stringify(event, null, 2)}\n`);
  assert.ok(fs.statSync(goal.file).size < store.MAX_EVENT_BYTES / 2);
  assert.deepEqual(store.readEvents(goal.root).events.map((e) => e.id), [event.id]);
});

test('hostile store: a symlinked events folder is refused for a read and for a write, naming the path; nothing lands outside', { skip: !POSIX }, () => {
  const root = plainDir('hostile-dirlink');
  const elsewhere = path.join(scratch.dir, 'hostile-dirlink-elsewhere');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, EVENT_FILE), JSON.stringify(validEvent({ statement: 'OUTSIDE' })));
  fs.mkdirSync(path.join(root, store.LIFECYCLE_REL), { recursive: true });
  const link = path.join(root, store.EVENTS_REL);
  fs.symlinkSync(elsewhere, link);
  const refused = (error) => error instanceof store.StoreUnsafeError && error.message.includes(link);
  assert.throws(() => store.readEvents(root), refused);
  assert.throws(() => store.readFold(root), refused);
  assert.throws(() => store.appendEvents(root, [added('FU-bbbbbb')]), refused);
  assert.deepEqual(fs.readdirSync(elsewhere), [EVENT_FILE], 'the write went nowhere');
});

test('hostile store: a symlinked lifecycle folder is refused for a read and for a write', { skip: !POSIX }, () => {
  const root = plainDir('hostile-lifelink');
  const elsewhere = path.join(scratch.dir, 'hostile-lifelink-elsewhere');
  fs.mkdirSync(path.join(elsewhere, 'events'), { recursive: true });
  fs.mkdirSync(path.join(root, '.doflow', 'state'), { recursive: true });
  const link = path.join(root, store.LIFECYCLE_REL);
  fs.symlinkSync(elsewhere, link);
  const refused = (error) => error instanceof store.StoreUnsafeError && error.message.includes(link);
  assert.throws(() => store.readEvents(root), refused);
  assert.throws(() => store.appendEvents(root, [added('FU-bbbbbb')]), refused);
  assert.deepEqual(fs.readdirSync(path.join(elsewhere, 'events')), []);
});

test('print-safe fold: strings read from an event are cleaned in memory, the excerpt keeps its line breaks, the file is untouched', () => {
  const s = storeWith('printsafe');
  const raw = `${JSON.stringify(validEvent({ statement: 'one\u001b[2J\ntwo\u202e', excerpt: 'line1\u0007\nline2' }))}\n`;
  fs.writeFileSync(s.file, raw);
  const [event] = store.readEvents(s.root).events;
  assert.deepEqual([event.data.statement, event.data.excerpt], ['one\uFFFD[2J two\uFFFD', 'line1\uFFFD\nline2']);
  assert.equal(fs.readFileSync(s.file, 'utf8'), raw);
});
