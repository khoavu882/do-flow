'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const {
  backupId, createFileBackup, listBackups, applyRetention, assertSafeBackupId,
} = require('../../src/install/backup.ts');
const { backupSetFromPaths } = require('../../src/install/backup-set.ts');
const { plantFullBackup } = require('../helper/backup-v1-fixture.ts');
const { writeManifest, readInstallManifest, canonicalManifestPath } = require('../../src/install/manifest.ts');
// `installPaths` is the exact expression install.js/update.js/rollback.js use to pick a backup root,
// so the tests below derive the write side from the installer's own resolver rather than restating a
// literal path that could silently drift from it.
const { installPaths } = require('../../src/cli/shared.ts');

/** A backup dir with a readable `.manifest.json`, planted directly at `root` (no writer). */
function plantBackup(root: any, id: any, extra = {}) {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(
    path.join(root, id, '.manifest.json'),
    JSON.stringify({ id, operation: 'install', timestamp: `2026-01-01T00:00:00.000Z`, type: 'full', ...extra }),
  );
  return path.join(root, id);
}

const FIXED_DATE = new Date('2026-03-15T10:20:30');
const REPO = path.resolve(__dirname, "../..");

function scratchDir() {
  return suiteTempDir('doflow-backup-manifest-');
}

/** A format-2 backup of `files` (absolute paths under `scopeRoot`), as install writes one. */
function backupFiles({ scopeRoot, files, backupRoot, operation = 'install' }: any) {
  const set = backupSetFromPaths({ items: files.map((f: any) => ({ path: f, harnesses: ['claude'] })), scope: 'project', scopeRoot });
  return createFileBackup({ operation, set, backupRoot, repoRoot: REPO, sourceCommit: 'test', version: '0.0.0', date: FIXED_DATE });
}

test('backupId matches sync.sh format <op>_YYYY-MM-DD_HH-MM-SS', () => {
  assert.strictEqual(backupId('install', FIXED_DATE), 'install_2026-03-15_10-20-30');
});

test('a 1.19 full backup (a tar.gz per tool + a .manifest.json) is listed as type full', () => {
  const root = scratchDir();
  const claudeDir = path.join(root, 'claude-src');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'hello');
  const backupRoot = path.join(root, 'backups');

  const bid = 'install_2026-03-15_10-20-30';
  plantFullBackup(backupRoot, bid, { tool: 'claude', srcDir: claudeDir });

  assert.ok(fs.existsSync(path.join(backupRoot, bid, 'claude.tar.gz')));
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, bid, '.manifest.json'), 'utf8'));
  assert.strictEqual(manifest.type, 'full');
  assert.deepStrictEqual(manifest.tools_affected, ['claude']);
  assert.deepStrictEqual(listBackups(backupRoot).map((r: any) => [r.id, r.type, r.format]), [[bid, 'full', 1]]);
});

test('createFileBackup copies only the listed files into files/<rel>', () => {
  const root = scratchDir();
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'a.md'), 'A');
  fs.writeFileSync(path.join(claudeDir, 'sub', 'b.md'), 'B');
  const backupRoot = path.join(root, '.doflow', 'backups');

  const { id: bid } = backupFiles({ scopeRoot: root, files: [path.join(claudeDir, 'a.md')], backupRoot, operation: 'update' });

  assert.ok(fs.existsSync(path.join(backupRoot, bid, 'files', '.claude', 'a.md')));
  assert.ok(!fs.existsSync(path.join(backupRoot, bid, 'files', '.claude', 'sub', 'b.md')), 'unlisted file must not be backed up');
});

test('assertSafeBackupId rejects traversal/absolute ids', () => {
  assert.throws(() => assertSafeBackupId('../../etc'));
  assert.throws(() => assertSafeBackupId('a/b'));
  assert.throws(() => assertSafeBackupId(''));
  assert.throws(() => assertSafeBackupId('.'), /Invalid backup id/, '"." is the backup root itself, not a backup');
  assert.doesNotThrow(() => assertSafeBackupId('install_2026-03-15_10-20-30'));
});

test('listBackups / applyRetention: retention keeps exactly N newest', () => {
  const root = scratchDir();
  const backupRoot = path.join(root, 'backups');
  for (const id of ['install_2026-01-01_00-00-00', 'install_2026-01-02_00-00-00', 'install_2026-01-03_00-00-00']) {
    fs.mkdirSync(path.join(backupRoot, id), { recursive: true });
    fs.writeFileSync(path.join(backupRoot, id, '.manifest.json'), JSON.stringify({ id, operation: 'install', timestamp: id, type: 'full' }));
  }
  assert.strictEqual(listBackups(backupRoot).length, 3);

  const { removed } = applyRetention({ backupRoot, keep: 1 });
  assert.strictEqual(removed.length, 2);
  assert.strictEqual(listBackups(backupRoot).length, 1);
});

test('createFileBackup disambiguates a same-second id collision instead of overwriting', () => {
  const root = scratchDir();
  const claudeMd = path.join(root, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
  fs.writeFileSync(claudeMd, 'first');
  const backupRoot = path.join(root, '.doflow', 'backups');

  const { id: bid1 } = backupFiles({ scopeRoot: root, files: [claudeMd], backupRoot });
  fs.writeFileSync(claudeMd, 'second');
  const { id: bid2 } = backupFiles({ scopeRoot: root, files: [claudeMd], backupRoot });

  assert.notStrictEqual(bid1, bid2, 'colliding same-second calls must get distinct ids');
  assert.strictEqual(fs.readFileSync(path.join(backupRoot, bid1, 'files', '.claude', 'CLAUDE.md'), 'utf8'), 'first');
  assert.strictEqual(fs.readFileSync(path.join(backupRoot, bid2, 'files', '.claude', 'CLAUDE.md'), 'utf8'), 'second', 'second backup must not have been skipped/overwritten');
});

test('manifest temp file is written next to the manifest, not shared os.tmpdir() (symlink-race fix)', () => {
  const root = scratchDir();
  const metaDir = path.dirname(canonicalManifestPath(root));
  fs.mkdirSync(metaDir, { recursive: true });

  // Plant a symlink at a predictable tmp-file path pointing at a victim file outside the metadata dir.
  const victim = path.join(root, 'victim.txt');
  fs.writeFileSync(victim, 'ORIGINAL VICTIM CONTENT');
  const predictedTmp = path.join(metaDir, `.install-manifest-${process.pid}-${FIXED_DATE.getTime()}.json.tmp`);
  fs.symlinkSync(victim, predictedTmp);

  assert.throws(
    () => writeManifest({ scopeRoot: root, scriptVersion: '0.1.0', operation: 'install', repoRoot: REPO, tools: ['claude'], date: FIXED_DATE }),
    /EEXIST/,
    'exclusive-create (wx) must refuse to write through a pre-existing symlink at the predicted path',
  );
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'ORIGINAL VICTIM CONTENT', 'victim file must be untouched');
});

test('manifest write/read round-trip, atomic (no .tmp left behind)', () => {
  const root = scratchDir();
  writeManifest({ scopeRoot: root, scriptVersion: '0.1.0', operation: 'install', repoRoot: REPO, backupId: 'install_2026-03-15_10-20-30', tools: ['claude'], date: FIXED_DATE });

  const read = readInstallManifest({ scopeRoot: root });
  assert.strictEqual(read.operation, 'install');
  assert.strictEqual(read.backupId, 'install_2026-03-15_10-20-30');
  assert.ok(read.tools.claude.installed);
  assert.ok(fs.existsSync(canonicalManifestPath(root)));
  assert.ok(!fs.readdirSync(path.dirname(canonicalManifestPath(root))).some((f: any) => f.endsWith('.tmp')), 'no leftover tmp file');
  assert.ok(!fs.existsSync(path.join(root, '.claude')), 'lifecycle metadata is never anchored under .claude');
});

test('canonical lifecycle manifest preserves metadata across incremental writes', () => {
  const root = scratchDir();
  writeManifest({ scopeRoot: root, scriptVersion: 'canonical', operation: 'install', repoRoot: REPO, tools: ['claude', 'codex'], date: FIXED_DATE });
  writeManifest({ scopeRoot: root, scriptVersion: 'canonical', operation: 'update', repoRoot: REPO, tools: ['claude'], date: new Date('2026-03-16T00:00:00Z') });
  const read = readInstallManifest({ scopeRoot: root });
  assert.equal(read.operation, 'update');
  assert.ok(read.tools.codex.installed, 'codex entry from the earlier write must survive');
  assert.notStrictEqual(read.tools.claude.last_updated, read.tools.codex.last_updated);
});

test('readInstallManifest returns null when no manifest exists yet', () => {
  assert.strictEqual(readInstallManifest({ scopeRoot: scratchDir() }), null);
});

// --- the root the installer writes to is the root list-backups reads --------------------------------

test('the root the installer writes to is the root list-backups reads', () => {
  const root = scratchDir();
  const scope = { global: false, projectRoot: root };
  const lifecyclePaths = installPaths(scope);          // write side: what install.js hands createFileBackup
  const writeRoot = lifecyclePaths.backupRoot;

  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'hello');
  const { id: bid } = backupFiles({ scopeRoot: lifecyclePaths.scopeRoot, files: [path.join(lifecyclePaths.scopeRoot, '.claude', 'CLAUDE.md')], backupRoot: writeRoot });

  assert.deepStrictEqual(
    listBackups(writeRoot).map((r: any) => ({ id: r.id, backupRoot: r.backupRoot })),
    [{ id: bid, backupRoot: writeRoot }],
    'a backup written by the installer must be listed from the same root',
  );
});

test('a restore point under <scope>/.claude/backups is not listed and is not pruned', () => {
  const root = scratchDir();
  const lifecyclePaths = installPaths({ global: false, projectRoot: root });
  const oldDir = plantBackup(path.join(lifecyclePaths.scopeRoot, '.claude', 'backups'), 'install_2026-01-01_00-00-00');
  for (const id of ['install_2026-06-01_00-00-00', 'install_2026-06-02_00-00-00']) {
    plantBackup(lifecyclePaths.backupRoot, id, { timestamp: `${id.slice(8, 18).replace(/_/g, '')}T00:00:00.000Z` });
  }
  assert.deepStrictEqual(listBackups(lifecyclePaths.backupRoot).map((r: any) => r.id).sort(), ['install_2026-06-01_00-00-00', 'install_2026-06-02_00-00-00']);
  applyRetention({ backupRoot: lifecyclePaths.backupRoot, keep: 1 });
  assert.ok(fs.existsSync(path.join(oldDir, '.manifest.json')), 'the old root is never touched');
});
