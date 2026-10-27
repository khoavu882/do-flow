'use strict';
// Format-2 writer, temp sweep and listing in src/install/backup.js. Sets are built by hand here, the
// way the set builder shapes them; every path lives under a scratch directory in the OS temporary folder.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const {
  BackupError, createFileBackup, sweepStaleTemps, listBackups, formatBytes, backupId,
} = require('../../src/install/backup.ts') as any;

const REPO = path.resolve(__dirname, '../..');
const DATE = new Date('2026-03-15T10:20:30');
const HOUR = 60 * 60 * 1000;

function scratchDir() {
  const dir = suiteTempDir('doflow-backup-format-');
  return dir;
}

function write(file: any, content: any, mode?: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode !== undefined) fs.chmodSync(file, mode);
  return file;
}

/** A BackupSet as the set builder returns it, stat'ed now. */
function handSet(scopeRoot: any, items: any, { scope = 'global', excluded = [] as any[] }: any = {}) {
  const entries = items.map(({ file, harnesses = ['claude'] }: any) => {
    const rel = path.relative(scopeRoot, file);
    const entry = {
      path: file,
      rel: rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep).join('/'),
      harnesses,
      reasons: ['change'],
      kind: 'absent',
      size: null,
      mode: null,
    };
    try {
      const st = fs.statSync(file);
      if (st.isFile()) Object.assign(entry, { kind: 'file', size: st.size, mode: st.mode & 0o7777 });
      else entry.kind = 'other';
    } catch { /* absent */ }
    return entry;
  }).sort((a: any, b: any) => (a.path < b.path ? -1 : 1));
  const files = entries.filter((e: any) => e.kind === 'file');
  return {
    scope,
    scopeRoot,
    entries,
    excluded,
    count: entries.length,
    existing: files.length,
    absent: entries.filter((e: any) => e.kind === 'absent').length,
    bytes: files.reduce((n: any, e: any) => n + e.size, 0),
  };
}

function backup(set: any, backupRoot: any, extra = {}) {
  return createFileBackup({
    operation: 'update', set, backupRoot, repoRoot: REPO, sourceCommit: 'abc123', version: '9.9.9', date: DATE, ...extra,
  });
}

function readManifest(dir: any) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.manifest.json'), 'utf8'));
}

test('createFileBackup lays out files/<rel> and external/<k>/<name> with the original bytes', () => {
  const root = scratchDir();
  const scopeRoot = path.join(root, 'home');
  const inside = write(path.join(scopeRoot, '.claude', 'CLAUDE.md'), 'inside bytes');
  const outside = write(path.join(root, 'opt', 'pi-agent', 'AGENTS.md'), 'outside bytes');
  const backupRoot = path.join(scopeRoot, '.doflow', 'backups');

  const result = backup(handSet(scopeRoot, [{ file: inside }, { file: outside, harnesses: ['pi'] }]), backupRoot);

  assert.strictEqual(result.id, backupId('update', DATE));
  assert.strictEqual(result.dir, path.join(backupRoot, result.id));
  assert.strictEqual(fs.readFileSync(path.join(result.dir, 'files', '.claude', 'CLAUDE.md'), 'utf8'), 'inside bytes');
  assert.strictEqual(fs.readFileSync(path.join(result.dir, 'external', '0', 'AGENTS.md'), 'utf8'), 'outside bytes');
  assert.deepStrictEqual(fs.readdirSync(result.dir).sort(), ['.manifest.json', 'external', 'files']);
  assert.deepStrictEqual(fs.readdirSync(backupRoot), [result.id], 'no temp directory is left behind');
});

test('createFileBackup writes the format-2 manifest: keys, summary, excluded, mode, one line per element', () => {
  const root = scratchDir();
  const scopeRoot = path.join(root, 'home');
  const kept = write(path.join(scopeRoot, '.claude', 'CLAUDE.md'), '12345', 0o640);
  // Windows has no 0o640: chmod only toggles read-only, so the mode the file really reports is the one expected.
  const keptMode = fs.statSync(kept).mode & 0o7777;
  const missing = path.join(scopeRoot, '.claude', 'skills', 'do', 'SKILL.md');
  const outside = write(path.join(root, 'opt', 'AGENTS.md'), 'abc');
  const set = handSet(scopeRoot, [
    { file: kept }, { file: missing }, { file: outside, harnesses: ['pi', 'codex'] },
  ], { excluded: [{ path: path.join(scopeRoot, '.claude.json'), reason: 'mcp-entries-only' }] });
  const backupRoot = path.join(scopeRoot, '.doflow', 'backups');

  const result = backup(set, backupRoot, { operation: 'pre-rollback', restores: 'update_2026-01-01_00-00-00' });
  const text = fs.readFileSync(path.join(result.dir, '.manifest.json'), 'utf8');
  const manifest = JSON.parse(text);

  assert.deepStrictEqual(Object.keys(manifest), [
    'id', 'operation', 'timestamp', 'source_path', 'source_commit', 'type', 'tools_affected', 'format',
    'doflow_version', 'scope', 'scope_root', 'restores', 'summary', 'excluded', 'files',
  ]);
  assert.strictEqual(manifest.id, result.id);
  assert.strictEqual(manifest.operation, 'pre-rollback');
  assert.strictEqual(manifest.timestamp, DATE.toISOString());
  assert.strictEqual(manifest.source_path, REPO);
  assert.strictEqual(manifest.source_commit, 'abc123');
  assert.strictEqual(manifest.type, 'files');
  assert.deepStrictEqual(manifest.tools_affected, ['claude', 'codex', 'pi']);
  assert.strictEqual(manifest.format, 2);
  assert.strictEqual(manifest.doflow_version, '9.9.9');
  assert.strictEqual(manifest.scope, 'global');
  assert.strictEqual(manifest.scope_root, scopeRoot);
  assert.strictEqual(manifest.restores, 'update_2026-01-01_00-00-00');
  assert.deepStrictEqual(manifest.summary, { files: 3, existed: 2, absent: 1, bytes: 8 });
  assert.deepStrictEqual(manifest.excluded, [{ path: '.claude.json', reason: 'mcp-entries-only' }]);
  assert.deepStrictEqual(manifest.files, [
    { path: '.claude/CLAUDE.md', existed: true, size: 5, mode: keptMode, stored: 'files/.claude/CLAUDE.md', harnesses: ['claude'] },
    { path: '.claude/skills/do/SKILL.md', existed: false, harnesses: ['claude'] },
    { path: outside, outside: true, existed: true, size: 3, mode: manifest.files[2].mode, stored: 'external/0/AGENTS.md', harnesses: ['pi', 'codex'] },
  ]);
  assert.ok(Number.isInteger(manifest.files[0].mode) && text.includes(`"mode":${keptMode},`), 'mode is a decimal integer');
  assert.ok(!('stored' in manifest.files[1]), 'an absent entry has no stored path');
  const elementLines = text.split('\n').filter((l: any) => /^ {4}\{"path":/.test(l));
  assert.strictEqual(elementLines.length, 4, 'each files and excluded element is one line');
  assert.ok(text.endsWith('}\n'));
  assert.deepStrictEqual(
    { files: result.files, existed: result.existed, absent: result.absent, bytes: result.bytes },
    manifest.summary,
  );
});

test('createFileBackup records a file deleted after the set was built as absent', () => {
  const root = scratchDir();
  const file = write(path.join(root, '.claude', 'gone.md'), 'soon gone');
  const set = handSet(root, [{ file }]);
  fs.rmSync(file);

  const result = backup(set, path.join(root, '.doflow', 'backups'));
  assert.deepStrictEqual(readManifest(result.dir).files, [{ path: '.claude/gone.md', existed: false, harnesses: ['claude'] }]);
  assert.strictEqual(result.absent, 1);
  assert.ok(!fs.existsSync(path.join(result.dir, 'files')));
});

test('createFileBackup returns null for an empty set and creates nothing', () => {
  const root = scratchDir();
  const backupRoot = path.join(root, '.doflow', 'backups');
  assert.strictEqual(backup(handSet(root, []), backupRoot), null);
  assert.ok(!fs.existsSync(path.join(root, '.doflow')));
});

test('createFileBackup gives two backups made in one second <id> and <id>-2', () => {
  const root = scratchDir();
  const file = write(path.join(root, '.claude', 'a.md'), 'first');
  const backupRoot = path.join(root, '.doflow', 'backups');
  const first = backup(handSet(root, [{ file }]), backupRoot);
  write(file, 'second');
  const second = backup(handSet(root, [{ file }]), backupRoot);

  assert.strictEqual(first.id, backupId('update', DATE));
  assert.strictEqual(second.id, `${first.id}-2`);
  assert.strictEqual(readManifest(second.dir).id, second.id);
  assert.strictEqual(fs.readFileSync(path.join(first.dir, 'files', '.claude', 'a.md'), 'utf8'), 'first');
  assert.strictEqual(fs.readFileSync(path.join(second.dir, 'files', '.claude', 'a.md'), 'utf8'), 'second');
});

test('createFileBackup takes the next id when another run wins the rename, and rewrites the manifest id', () => {
  const root = scratchDir();
  const file = write(path.join(root, '.claude', 'a.md'), 'mine');
  const backupRoot = path.join(root, '.doflow', 'backups');
  const base = backupId('update', DATE);
  let raced = false;
  const fsImpl = {
    ...fs,
    renameSync(from: any, to: any) {
      if (!raced) {
        // Another run completes its backup under the same id between our existence check and rename.
        raced = true;
        write(path.join(to, '.manifest.json'), '{"id":"theirs"}');
      }
      return fs.renameSync(from, to);
    },
  };

  const result = backup(handSet(root, [{ file }]), backupRoot, { fsImpl });
  assert.strictEqual(result.id, `${base}-2`);
  assert.strictEqual(readManifest(result.dir).id, `${base}-2`);
  assert.strictEqual(fs.readFileSync(path.join(backupRoot, base, '.manifest.json'), 'utf8'), '{"id":"theirs"}', 'the other run\'s backup is untouched');
  assert.deepStrictEqual(fs.readdirSync(backupRoot).sort(), [base, `${base}-2`]);
});

test('two overlapping createFileBackup calls with one date each finish a complete backup under its own id', () => {
  const root = scratchDir();
  const file = write(path.join(root, '.claude', 'a.md'), 'first run');
  const backupRoot = path.join(root, '.doflow', 'backups');
  const base = backupId('update', DATE);
  const firstSet = handSet(root, [{ file }]);
  let second: any = null;
  const fsImpl = {
    ...fs,
    renameSync(from: any, to: any) {
      if (!second) {
        // The first run has copied its files and written its manifest; the second runs start to
        // finish now, sweeping, writing and renaming while the first one's temp is still open.
        write(file, 'second run');
        second = backup(handSet(root, [{ file }]), backupRoot);
        assert.ok(fs.existsSync(from), 'the second run\'s sweep keeps a live run\'s temp');
      }
      return fs.renameSync(from, to);
    },
  };

  const first = backup(firstSet, backupRoot, { fsImpl });
  assert.strictEqual(second.id, base);
  assert.strictEqual(first.id, `${base}-2`);
  for (const [result, content] of [[first, 'first run'], [second, 'second run']]) {
    assert.strictEqual(readManifest(result.dir).id, result.id);
    assert.strictEqual(fs.readFileSync(path.join(result.dir, 'files', '.claude', 'a.md'), 'utf8'), content);
  }
  assert.deepStrictEqual(fs.readdirSync(backupRoot).sort(), [base, `${base}-2`], 'no temp is left behind');
});

test('createFileBackup throws BackupError on a copy error and leaves no backup and no temp', () => {
  const root = scratchDir();
  const file = write(path.join(root, '.claude', 'a.md'), 'x');
  const backupRoot = path.join(root, '.doflow', 'backups');
  const fsImpl = {
    ...fs,
    copyFileSync() { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); },
  };

  assert.throws(
    () => backup(handSet(root, [{ file }]), backupRoot, { fsImpl }),
    (err: any) => err instanceof BackupError && err.code === 'backup-failed'
      && err.message === `could not copy ${file}: EIO`,
  );
  assert.deepStrictEqual(fs.readdirSync(backupRoot), [], 'neither the id directory nor a .tmp- directory remains');
});

test('createFileBackup refuses the legacy root before writing anything', () => {
  const root = scratchDir();
  const file = write(path.join(root, '.claude', 'a.md'), 'x');
  const legacyRoot = path.join(root, '.claude', 'backups');
  assert.throws(() => backup(handSet(root, [{ file }]), legacyRoot), /legacy backup root/);
  assert.ok(!fs.existsSync(legacyRoot));
});

test('a temp records when the run started, not the date the backup is named for (FU-kj372j)', () => {
  const root = scratchDir();
  const file = write(path.join(root, '.claude', 'a.md'), 'x');
  const backupRoot = path.join(root, '.doflow', 'backups');
  const pastDate = new Date(Date.now() - 3 * 24 * HOUR);
  let owner: any = null;
  let sweptWhileRunning = null;
  const fsImpl = {
    ...fs,
    copyFileSync(from: any, to: any, ...rest: any[]) {
      const tmp = path.join(backupRoot, fs.readdirSync(backupRoot).find((n: any) => n.startsWith('.tmp-')));
      owner = JSON.parse(fs.readFileSync(path.join(tmp, '.owner.json'), 'utf8'));
      // Another run sweeps while this one is still copying; the owner process (this one) is alive.
      sweptWhileRunning = sweepStaleTemps(backupRoot, { isAlive: () => true });
      return fs.copyFileSync(from, to, ...rest);
    },
  };
  const made = backup(handSet(root, [{ file }]), backupRoot, { fsImpl, date: pastDate });
  assert.ok(made, 'the backup was made');
  assert.ok(owner && Math.abs(Date.parse(owner.startedAt) - Date.now()) < 60 * 1000, `startedAt is ${owner?.startedAt}`);
  assert.strictEqual(sweptWhileRunning, 0, 'a live run\'s temp is not swept because its backup date is old');
  assert.ok(fs.existsSync(path.join(backupRoot, made.id, '.manifest.json')), 'the backup finished intact');
});

test('sweepStaleTemps removes dead and expired temps, keeps live ones, ignores non-dot directories', () => {
  const root = scratchDir();
  const backupRoot = path.join(root, '.doflow', 'backups');
  const now = Date.parse('2026-03-15T12:00:00Z');
  const recent = new Date(now - HOUR).toISOString();
  const plantTemp = (name: any, owner?: any) => {
    fs.mkdirSync(path.join(backupRoot, name), { recursive: true });
    if (owner) write(path.join(backupRoot, name, '.owner.json'), JSON.stringify(owner));
  };
  plantTemp('.tmp-dead', { pid: 111, hostname: 'this-host', startedAt: recent });
  plantTemp('.tmp-live', { pid: 222, hostname: 'this-host', startedAt: recent });
  plantTemp('.tmp-other-host', { pid: 111, hostname: 'other-host', startedAt: recent });
  plantTemp('.tmp-expired', { pid: 222, hostname: 'this-host', startedAt: new Date(now - 25 * HOUR).toISOString() });
  plantTemp('.tmp-no-owner');
  fs.mkdirSync(path.join(backupRoot, 'install_2026-01-01_00-00-00'));
  fs.mkdirSync(path.join(backupRoot, 'tmp-not-dot'));
  const isAlive = (pid: any) => pid === 222;

  assert.strictEqual(sweepStaleTemps(backupRoot, { now, isAlive, hostname: 'this-host' }), 2);
  assert.deepStrictEqual(fs.readdirSync(backupRoot).sort(), [
    '.tmp-live', '.tmp-no-owner', '.tmp-other-host', 'install_2026-01-01_00-00-00', 'tmp-not-dot',
  ]);

  // An owner-less temp goes once its directory is more than 24 hours old.
  assert.strictEqual(sweepStaleTemps(backupRoot, { now: Date.now() + 25 * HOUR, isAlive, hostname: 'this-host' }), 3);
  assert.deepStrictEqual(fs.readdirSync(backupRoot).sort(), ['install_2026-01-01_00-00-00', 'tmp-not-dot']);
});

test('sweepStaleTemps returns 0 for a missing root and refuses the legacy root', () => {
  const root = scratchDir();
  assert.strictEqual(sweepStaleTemps(path.join(root, '.doflow', 'backups')), 0);
  assert.throws(() => sweepStaleTemps(path.join(root, '.claude', 'backups')), /legacy backup root/);
});

test('listBackups skips temps and reports format, completeness and size for each kind', () => {
  const root = scratchDir();
  const backupRoot = path.join(root, '.doflow', 'backups');
  const file = write(path.join(root, '.claude', 'a.md'), 'twelve bytes');
  const v2 = backup(handSet(root, [{ file }]), backupRoot);
  write(path.join(backupRoot, 'install_2026-01-02_00-00-00', '.manifest.json'), JSON.stringify({
    id: 'install_2026-01-02_00-00-00', operation: 'install', timestamp: '2026-01-02T00:00:00.000Z', type: 'full', tools_affected: ['claude'],
  }));
  write(path.join(backupRoot, 'install_2026-01-02_00-00-00', 'claude.tar.gz'), Buffer.alloc(100));
  write(path.join(backupRoot, 'leftover', 'claude', 'x.md'), Buffer.alloc(10));
  write(path.join(backupRoot, '.tmp-update-1-deadbeef', '.owner.json'), '{}');

  const rows = listBackups(backupRoot);
  const byId: any = new Map(rows.map((r: any) => [r.id, r]));
  assert.deepStrictEqual([...byId.keys()].sort(), ['install_2026-01-02_00-00-00', 'leftover', v2.id].sort());

  const manifestBytes = fs.statSync(path.join(v2.dir, '.manifest.json')).size;
  assert.deepStrictEqual(
    { format: byId.get(v2.id).format, complete: byId.get(v2.id).complete, type: byId.get(v2.id).type, bytes: byId.get(v2.id).bytes },
    { format: 2, complete: true, type: 'files', bytes: 12 + manifestBytes },
  );
  const full: any = byId.get('install_2026-01-02_00-00-00');
  const fullManifestBytes = fs.statSync(path.join(backupRoot, full.id, '.manifest.json')).size;
  assert.deepStrictEqual(
    { format: full.format, complete: full.complete, type: full.type, bytes: full.bytes },
    { format: 1, complete: true, type: 'full', bytes: 100 + fullManifestBytes },
  );
  const leftover: any = byId.get('leftover');
  assert.deepStrictEqual(
    { operation: leftover.operation, type: leftover.type, timestamp: leftover.timestamp, format: leftover.format, complete: leftover.complete, bytes: leftover.bytes },
    { operation: 'unknown', type: '?', timestamp: '-', format: null, complete: false, bytes: 10 },
  );
});

test('listBackups orders by manifest time over directory mtime', () => {
  const root = scratchDir();
  const backupRoot = path.join(root, 'backups');
  const plant = (id: any, timestamp: any, mtime: any) => {
    write(path.join(backupRoot, id, '.manifest.json'), JSON.stringify({ id, operation: 'install', timestamp, type: 'full' }));
    fs.utimesSync(path.join(backupRoot, id), mtime, mtime);
  };
  plant('alpha', '2026-05-01T00:00:00.000Z', new Date('2020-01-01T00:00:00Z'));
  plant('beta', '2026-04-01T00:00:00.000Z', new Date('2030-01-01T00:00:00Z'));
  plant('gamma', '2026-06-01T00:00:00.000Z', new Date('2010-01-01T00:00:00Z'));

  assert.deepStrictEqual(listBackups(backupRoot).map((r: any) => r.id), ['gamma', 'alpha', 'beta']);
});

test('formatBytes prints ? for unknown, bytes below 1 KiB, one decimal above', () => {
  assert.strictEqual(formatBytes(null), '?');
  assert.strictEqual(formatBytes(0), '0 B');
  assert.strictEqual(formatBytes(1023), '1023 B');
  assert.strictEqual(formatBytes(1024), '1.0 KiB');
  assert.strictEqual(formatBytes(1536), '1.5 KiB');
  assert.strictEqual(formatBytes(5 * 1024 ** 3), '5.0 GiB');
});
