'use strict';
// Retention and backup sizes in src/install/backup.js. Backups are planted by hand under scratch
// directories; nothing here reaches a real HOME.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const { applyRetention, backupSize, listBackups, sweepStaleTemps, hostTag } = require('../../src/install/backup.ts');
const { plantFullBackup } = require('../helper/backup-v1-fixture.ts');
const { IS_WIN } = require('../helper-platform.ts');

const DAY = 24 * 60 * 60 * 1000;

function scratchDir() {
  const dir = suiteTempDir('doflow-backup-retention-');
  return dir;
}

function backupRootOf(scopeRoot: any) { return path.join(scopeRoot, '.doflow', 'backups'); }

/** A format-2 backup directory whose manifest carries `timestamp`. */
function plant(root: any, id: any, timestamp: any) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'files', 'a.md'), id);
  fs.writeFileSync(path.join(dir, '.manifest.json'), JSON.stringify({ id, operation: 'install', timestamp, type: 'files', format: 2, files: [] }));
  return dir;
}

/** Five backups, oldest first: install_2026-01-01 ... install_2026-01-05. */
function plantFive(root: any) {
  const ids = [1, 2, 3, 4, 5].map((d) => `install_2026-01-0${d}_00-00-00`);
  ids.forEach((id, i) => plant(root, id, `2026-01-0${i + 1}T00:00:00.000Z`));
  return ids;
}

function remaining(root: any) { return fs.readdirSync(root).filter((n: any) => !n.startsWith('.')).sort(); }

test('keep 3 keeps the protected backup plus the two newest', () => {
  const root = backupRootOf(scratchDir());
  const ids = plantFive(root);
  // The run's own backup is the newest one (FU-j55357: retention never removes a backup newer than it).
  const result = applyRetention({ backupRoot: root, keep: 3, protect: [ids[4]] });

  assert.deepStrictEqual(remaining(root), [ids[2], ids[3], ids[4]]);
  assert.deepStrictEqual(result.removed, [ids[1], ids[0]]);
  assert.strictEqual(result.kept, 3);
  assert.strictEqual(result.keep, 3);
  assert.deepStrictEqual(result.failed, []);
  assert.deepStrictEqual(result.wouldRemove, []);
});

test('a backup newer than the run\'s own survives --prune 1, as a concurrent run\'s would (FU-j55357)', () => {
  const root = backupRootOf(scratchDir());
  const ids = plantFive(root);
  // The run made ids[2]; another run finished ids[3] and ids[4] after it, before this pass listed the root.
  const result = applyRetention({ backupRoot: root, keep: 1, protect: [ids[2]] });
  assert.deepStrictEqual(remaining(root), [ids[2], ids[3], ids[4]]);
  assert.deepStrictEqual(result.removed, [ids[1], ids[0]]);
  assert.strictEqual(result.kept, 3);
  const dry = applyRetention({ backupRoot: root, keep: 1, protect: [ids[2]], dryRun: true });
  assert.deepStrictEqual(dry.wouldRemove, [], 'nothing older than the run\'s own backup is left to remove');
});

test('a protected backup that is the oldest leaves every newer backup alone', () => {
  const root = backupRootOf(scratchDir());
  const ids = plantFive(root);
  const result = applyRetention({ backupRoot: root, keep: 2, protect: [ids[0]] });
  assert.deepStrictEqual(remaining(root), ids);
  assert.deepStrictEqual(result.removed, []);
  assert.strictEqual(result.kept, 5);
});

test('a backup is renamed aside to .tmp-del-* before it is removed, so it is never half-deleted in place', () => {
  const root = backupRootOf(scratchDir());
  const ids = plantFive(root);
  const seen: any = [];
  const watching = {
    ...fs,
    rmSync(target: any, options: any) {
      seen.push({ target, originalStillThere: fs.existsSync(path.join(root, path.basename(target).replace(/^\.tmp-del-/, '').replace(/-\d+-[0-9a-f]+$/, ''))) });
      return fs.rmSync(target, options);
    },
  };
  const result = applyRetention({ backupRoot: root, keep: 3, protect: [ids[4]], fsImpl: watching });
  assert.deepStrictEqual(result.removed, [ids[1], ids[0]]);
  const removals = seen.filter((c: any) => path.basename(c.target).startsWith('.tmp-del-'));
  assert.strictEqual(removals.length, 2, JSON.stringify(seen));
  assert.ok(removals.every((c: any) => c.originalStillThere === false), 'the id was already out of the listing when the removal began');
  assert.deepStrictEqual(fs.readdirSync(root).filter((n: any) => n.startsWith('.')), [], 'no aside folder remains');
});

test('a backup whose rename aside fails is reported and left whole', () => {
  const root = backupRootOf(scratchDir());
  const ids = plantFive(root);
  const failing = {
    ...fs,
    renameSync(from: any, to: any) {
      if (path.basename(from) === ids[1]) throw Object.assign(new Error('EPERM: busy'), { code: 'EPERM' });
      return fs.renameSync(from, to);
    },
  };
  const result = applyRetention({ backupRoot: root, keep: 3, protect: [ids[4]], fsImpl: failing });
  assert.deepStrictEqual(result.removed, [ids[0]]);
  assert.strictEqual(result.failed.length, 1);
  assert.strictEqual(result.failed[0].id, ids[1]);
  assert.ok(fs.existsSync(path.join(root, ids[1], '.manifest.json')), 'untouched');
});

/** The pid of a process that has already exited, so no live pass can own it. */
function deadPid() { return spawnSync(process.execPath, ['-e', '0']).pid; }
const HOURS = 60 * 60 * 1000;

test('a .tmp-del-* left by a crashed removal is cleaned on the next pass and is never listed as a backup', () => {
  const root = backupRootOf(scratchDir());
  const ids = plantFive(root);
  const left = path.join(root, `.tmp-del-${ids[0]}-${hostTag()}-${deadPid()}-abcd1234`);
  fs.renameSync(path.join(root, ids[0]), left);
  assert.deepStrictEqual(listBackups(root).map((r: any) => r.id).sort(), ids.slice(1), 'not a backup');
  assert.ok(!applyRetention({ backupRoot: root, keep: 9, dryRun: true }).wouldRemove.length);
  assert.ok(fs.existsSync(left), 'a dry run removes nothing');
  applyRetention({ backupRoot: root, keep: 9 });
  assert.ok(!fs.existsSync(left), 'removed by the next pass, long before the 24 hour temp age');
  assert.deepStrictEqual(remaining(root), ids.slice(1));
});

test('a concurrent pass leaves a live pass\'s rename-aside alone, so its failed delete rolls back whole (C-1)', () => {
  const root = backupRootOf(scratchDir());
  const ids = plantFive(root);
  let inner: any = null;
  const racing = {
    ...fs,
    rmSync(target: any, options: any) {
      if (path.basename(target).startsWith('.tmp-del-') && inner === null) {
        // The aside is this process's (a live pid) and is hours old by mtime; another run prunes now.
        const old = new Date(Date.now() - 30 * HOURS);
        fs.utimesSync(target, old, old);
        inner = applyRetention({ backupRoot: root, keep: 9 });
        throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      }
      return fs.rmSync(target, options);
    },
  };
  const result = applyRetention({ backupRoot: root, keep: 4, protect: [ids[4]], fsImpl: racing });
  assert.strictEqual(result.failed.length, 1);
  assert.ok(fs.existsSync(path.join(root, result.failed[0].id, '.manifest.json')), 'the backup is back under its id, whole');
  assert.strictEqual(remaining(root).length, 5, 'the one removal failed, so all five remain');
  assert.deepStrictEqual(fs.readdirSync(root).filter((n: any) => n.startsWith('.tmp-del-')), []);
});

test('sweepStaleTemps never removes a .tmp-del-* by age: only when the pid in its name is dead (C-1)', () => {
  const root = backupRootOf(scratchDir());
  const ids = plantFive(root);
  const live = path.join(root, `.tmp-del-${ids[0]}-${hostTag()}-${process.pid}-abcd1234`);
  const dead = path.join(root, `.tmp-del-${ids[1]}-${hostTag()}-${deadPid()}-abcd1234`);
  const odd = path.join(root, '.tmp-del-no-pid-here');
  for (const [name, dir] of [[ids[0], live], [ids[1], dead]]) fs.renameSync(path.join(root, name), dir);
  fs.mkdirSync(odd);
  const old = new Date(Date.now() - 48 * HOURS);
  for (const dir of [live, dead, odd]) fs.utimesSync(dir, old, old);
  assert.strictEqual(sweepStaleTemps(root), 1);
  assert.deepStrictEqual([live, dead, odd].map((d) => fs.existsSync(d)), [true, false, true], 'live pid and an unparseable name stay however old');
});

test('a pass on another host never deletes this host\'s rename-aside, even when it sees no such pid (N-2)', () => {
  const root = backupRootOf(scratchDir());
  const ids = plantFive(root);
  let foreign: any = null;
  const failing = {
    ...fs,
    rmSync(target: any, options: any) {
      if (path.basename(target).startsWith('.tmp-del-') && foreign === null) {
        // Another host (or pid namespace) sweeps the shared root: it cannot see this pass's pid.
        foreign = sweepStaleTemps(root, { hostname: 'some-other-host', isAlive: () => false });
        throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
      }
      return fs.rmSync(target, options);
    },
  };
  const result = applyRetention({ backupRoot: root, keep: 4, protect: [ids[4]], fsImpl: failing });
  assert.strictEqual(foreign, 0, 'nothing removed by the foreign sweep');
  assert.strictEqual(result.failed.length, 1);
  assert.ok(fs.existsSync(path.join(root, ids[0], '.manifest.json')), 'the backup whose delete failed is back under its id');
});

test('a sweep in another pid namespace on the same hostname keeps the aside (N-7)', () => {
  const root = backupRootOf(scratchDir());
  const ids = plantFive(root);
  let foreign: any = null;
  const failing = {
    ...fs,
    rmSync(target: any, options: any) {
      if (path.basename(target).startsWith('.tmp-del-') && foreign === null) {
        // Same hostname (a container sharing the host's UTS namespace), a different pid namespace.
        foreign = sweepStaleTemps(root, { pidNamespace: 'pid:[4026539999]', isAlive: () => false });
        throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
      }
      return fs.rmSync(target, options);
    },
  };
  const result = applyRetention({ backupRoot: root, keep: 4, protect: [ids[4]], fsImpl: failing });
  assert.strictEqual(foreign, 0, 'the other namespace could not see the pid, so it must not judge it');
  assert.strictEqual(result.failed.length, 1);
  assert.ok(fs.existsSync(path.join(root, ids[0], '.manifest.json')), 'rolled back whole');
});

test('the host tag depends on the pid namespace when one is known, and on the hostname alone when not (N-7)', () => {
  assert.notStrictEqual(hostTag('h', 'pid:[1]'), hostTag('h', 'pid:[2]'));
  assert.notStrictEqual(hostTag('h', 'pid:[1]'), hostTag('other', 'pid:[1]'));
  assert.strictEqual(hostTag('h', ''), hostTag('h', ''));
  assert.match(hostTag(), /^[0-9a-f]{8}$/);
});

test('an aside made on another host, or in the old nameless layout, is kept and never listed (N-2)', () => {
  const root = backupRootOf(scratchDir());
  const ids = plantFive(root);
  const foreign = path.join(root, `.tmp-del-${ids[0]}-${hostTag('another-host')}-${deadPid()}-abcd1234`);
  const nameless = path.join(root, `.tmp-del-${ids[1]}-${deadPid()}-abcd1234`);
  fs.renameSync(path.join(root, ids[0]), foreign);
  fs.renameSync(path.join(root, ids[1]), nameless);
  applyRetention({ backupRoot: root, keep: 9 });
  assert.deepStrictEqual([foreign, nameless].map((d) => fs.existsSync(d)), [true, true]);
  assert.deepStrictEqual(listBackups(root).map((r: any) => r.id).sort(), ids.slice(2), 'neither is a backup in a listing');
});

test('keep 0 removes nothing and reports every backup as kept', () => {
  const root = backupRootOf(scratchDir());
  const ids = plantFive(root);
  const result = applyRetention({ backupRoot: root, keep: 0 });
  assert.deepStrictEqual(remaining(root), ids);
  assert.deepStrictEqual(result.removed, []);
  assert.strictEqual(result.kept, 5);
});

test('a dry run with reserve 1 lists one more for removal and deletes nothing', () => {
  const root = backupRootOf(scratchDir());
  const ids = plantFive(root);
  fs.mkdirSync(path.join(root, '.tmp-dead'));
  const plain = applyRetention({ backupRoot: root, keep: 3, dryRun: true });
  const reserved = applyRetention({ backupRoot: root, keep: 3, dryRun: true, reserve: 1, now: Date.now() + 2 * DAY });

  assert.deepStrictEqual(plain.wouldRemove, [ids[1], ids[0]]);
  assert.deepStrictEqual(reserved.wouldRemove, [ids[2], ids[1], ids[0]]);
  assert.strictEqual(reserved.kept, 3, 'the would-be backup counts as kept');
  assert.deepStrictEqual(reserved.removed, []);
  assert.strictEqual(reserved.sweptTemps, 0);
  assert.deepStrictEqual(remaining(root), ids);
  assert.ok(fs.existsSync(path.join(root, '.tmp-dead')), 'a dry run sweeps nothing');
});

test('manifest time outranks id time and mtime', () => {
  const root = backupRootOf(scratchDir());
  // The id says oldest, the mtime says oldest, the manifest says newest.
  const newest = plant(root, 'install_2020-01-01_00-00-00', '2026-12-01T00:00:00.000Z');
  fs.utimesSync(newest, new Date('2001-01-01'), new Date('2001-01-01'));
  const middle = plant(root, 'install_2030-01-01_00-00-00', '2026-06-01T00:00:00.000Z');
  fs.utimesSync(middle, new Date('2040-01-01'), new Date('2040-01-01'));
  plant(root, 'install_2031-01-01_00-00-00', '2026-01-01T00:00:00.000Z');

  const result = applyRetention({ backupRoot: root, keep: 2 });
  assert.deepStrictEqual(result.removed, ['install_2031-01-01_00-00-00']);
  assert.deepStrictEqual(remaining(root), ['install_2020-01-01_00-00-00', 'install_2030-01-01_00-00-00']);
});

test('manifest-less and 1.19 backups are counted and removed in order', () => {
  const dir = scratchDir();
  const root = backupRootOf(dir);
  const src = path.join(dir, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'CLAUDE.md'), 'x');
  plant(root, 'update_2026-05-01_00-00-00', '2026-05-01T00:00:00.000Z');
  plantFullBackup(root, 'install_2026-04-01_00-00-00', { tool: 'claude', srcDir: src, manifest: { timestamp: '2026-04-01T00:00:00.000Z' } });
  // No manifest: ordered by the time in its id (local time). A manifest without a time and a
  // name without one: ordered by mtime.
  fs.mkdirSync(path.join(root, 'install_2026-03-01_00-00-00', 'claude'), { recursive: true });
  const undated = path.join(root, 'handmade');
  fs.mkdirSync(undated);
  fs.writeFileSync(path.join(undated, '.manifest.json'), JSON.stringify({ operation: 'install', type: 'partial' }));
  fs.utimesSync(undated, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));

  const dry = applyRetention({ backupRoot: root, keep: 1, dryRun: true });
  assert.deepStrictEqual(dry.wouldRemove, ['install_2026-04-01_00-00-00', 'install_2026-03-01_00-00-00', 'handmade']);
  const result = applyRetention({ backupRoot: root, keep: 1 });
  assert.deepStrictEqual(result.removed, dry.wouldRemove);
  assert.deepStrictEqual(remaining(root), ['update_2026-05-01_00-00-00']);
  assert.strictEqual(result.kept, 1);
});

test('a directory that is not a DoFlow backup is neither counted nor removed, and displaces no restore point', () => {
  const root = backupRootOf(scratchDir());
  const ids = plantFive(root);
  const notes = path.join(root, 'my-notes');
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, 'todo.txt'), 'mine');
  fs.mkdirSync(path.join(root, 'broken-manifest'));
  fs.writeFileSync(path.join(root, 'broken-manifest', '.manifest.json'), '{not json');

  const dry = applyRetention({ backupRoot: root, keep: 3, dryRun: true });
  assert.deepStrictEqual(dry.wouldRemove, [ids[1], ids[0]]);
  const result = applyRetention({ backupRoot: root, keep: 3 });
  assert.deepStrictEqual(result.removed, [ids[1], ids[0]]);
  assert.strictEqual(result.kept, 3);
  assert.deepStrictEqual(remaining(root), ['broken-manifest', ids[2], ids[3], ids[4], 'my-notes'].sort());
  assert.strictEqual(fs.readFileSync(path.join(notes, 'todo.txt'), 'utf8'), 'mine');
});

test('temp directories and directory symlinks are neither counted nor removed', { skip: IS_WIN && 'symlinks need privileges on Windows' }, () => {
  const dir = scratchDir();
  const root = backupRootOf(dir);
  const ids = plantFive(root);
  const target = plant(path.join(dir, 'elsewhere'), 'install_2019-01-01_00-00-00', '2019-01-01T00:00:00.000Z');
  fs.symlinkSync(target, path.join(root, 'install_2019-01-01_00-00-00'));
  fs.mkdirSync(path.join(root, '.tmp-install_x-1-deadbeef'));
  fs.writeFileSync(path.join(root, '.tmp-install_x-1-deadbeef', '.owner.json'), JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() }));

  const result = applyRetention({ backupRoot: root, keep: 1 });
  assert.deepStrictEqual(result.removed, [ids[3], ids[2], ids[1], ids[0]]);
  assert.strictEqual(result.kept, 1);
  assert.ok(fs.lstatSync(path.join(root, 'install_2019-01-01_00-00-00')).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(target, '.manifest.json')), 'the link target is untouched');
  assert.ok(fs.existsSync(path.join(root, '.tmp-install_x-1-deadbeef')), 'a live run\'s temp is kept');
});

test('a backup another pass removed first is skipped without a failure', () => {
  const root = backupRootOf(scratchDir());
  const ids = plantFive(root);
  let listed = false;
  const fsImpl = {
    ...fs,
    readdirSync(p: any, opts: any) {
      const entries = fs.readdirSync(p, opts);
      if (!listed && p === root) {
        listed = true;
        fs.rmSync(path.join(root, ids[0]), { recursive: true });
      }
      return entries;
    },
  };
  const result = applyRetention({ backupRoot: root, keep: 3, fsImpl });
  assert.deepStrictEqual(result.removed, [ids[1]]);
  assert.deepStrictEqual(result.failed, []);
  assert.strictEqual(result.kept, 3);
  assert.deepStrictEqual(remaining(root), ids.slice(2));
});

test('a removal error is reported and the pass continues', () => {
  const root = backupRootOf(scratchDir());
  const ids = plantFive(root);
  const fsImpl = {
    ...fs,
    rmSync(p: any, opts: any) {
      // The folder is renamed aside before it is removed (FU-j55357), so the removal sees the aside name.
      if (path.basename(p).includes(ids[1])) throw Object.assign(new Error(`EACCES: permission denied, rmdir '${path.join(root, ids[1])}'`), { code: 'EACCES' });
      return fs.rmSync(p, opts);
    },
  };
  const result = applyRetention({ backupRoot: root, keep: 2, fsImpl });
  assert.deepStrictEqual(result.removed, [ids[2], ids[0]]);
  assert.deepStrictEqual(result.failed, [{ id: ids[1], error: `EACCES: permission denied, rmdir '${path.join(root, ids[1])}'` }]);
  assert.strictEqual(result.kept, 3);
});

test('the legacy root is refused and its backups keep their bytes', () => {
  const scope = scratchDir();
  const legacyRoot = path.join(scope, '.claude', 'backups');
  const dir = plant(legacyRoot, 'install_2026-01-01_00-00-00', '2026-01-01T00:00:00.000Z');
  const before = fs.readFileSync(path.join(dir, 'files', 'a.md'));
  plant(legacyRoot, 'install_2026-01-02_00-00-00', '2026-01-02T00:00:00.000Z');

  assert.throws(() => applyRetention({ backupRoot: legacyRoot, keep: 1 }), /legacy backup root/);
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'files', 'a.md')), before);
  assert.strictEqual(remaining(legacyRoot).length, 2);
});

test('a project pass leaves the global root untouched', () => {
  const home = scratchDir();
  const project = path.join(home, 'project');
  for (let d = 1; d <= 6; d += 1) plant(backupRootOf(home), `install_2026-02-0${d}_00-00-00`, `2026-02-0${d}T00:00:00.000Z`);
  plantFive(backupRootOf(project));

  const result = applyRetention({ backupRoot: backupRootOf(project), keep: 3 });
  assert.strictEqual(result.removed.length, 2);
  assert.strictEqual(remaining(backupRootOf(project)).length, 3);
  assert.strictEqual(remaining(backupRootOf(home)).length, 6);
});

test('a real pass sweeps stale temps and counts them', () => {
  const root = backupRootOf(scratchDir());
  plantFive(root);
  const temp = path.join(root, '.tmp-install_x-1-deadbeef');
  fs.mkdirSync(temp);
  fs.writeFileSync(path.join(temp, '.owner.json'), JSON.stringify({ pid: 1, hostname: 'elsewhere', startedAt: '2026-01-01T00:00:00.000Z' }));

  const result = applyRetention({ backupRoot: root, keep: 3, now: Date.parse('2026-01-03T00:00:00Z') });
  assert.strictEqual(result.sweptTemps, 1);
  assert.ok(!fs.existsSync(temp));
});

test('a missing root gives zero counts; a bad keep is refused', () => {
  const root = backupRootOf(scratchDir());
  assert.deepStrictEqual(applyRetention({ backupRoot: root, keep: 3 }), {
    keep: 3, kept: 0, removed: [], wouldRemove: [], failed: [], sweptTemps: 0,
  });
  assert.strictEqual(applyRetention({ backupRoot: root, keep: 3, dryRun: true, reserve: 1 }).kept, 1);
  assert.ok(!fs.existsSync(root));
  for (const keep of [undefined, -1, 1.5, '3']) {
    assert.throws(() => applyRetention({ backupRoot: root, keep }), /non-negative whole number/);
  }
});

test('backupSize sums regular files without following links, and is null when unreadable', { skip: IS_WIN && 'symlinks need privileges on Windows' }, () => {
  const dir = scratchDir();
  const bk = path.join(dir, 'bk');
  fs.mkdirSync(path.join(bk, 'files', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(bk, 'files', 'a.md'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(bk, 'files', 'sub', 'b.md'), Buffer.alloc(24));
  fs.writeFileSync(path.join(dir, 'big'), Buffer.alloc(5000));
  fs.symlinkSync(path.join(dir, 'big'), path.join(bk, 'files', 'link'));
  fs.symlinkSync(dir, path.join(bk, 'files', 'dirlink'));

  assert.strictEqual(backupSize(bk), 1024);
  assert.strictEqual(backupSize(path.join(dir, 'missing')), null);
});
