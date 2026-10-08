'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  backupId, createFileBackup, restoreBackup, listBackups, applyRetention, assertSafeBackupId,
  backupReadRoots, BACKUP_ORIGIN_CURRENT, BACKUP_ORIGIN_LEGACY,
} = require('../../src/install/backup');
const { backupSetFromPaths } = require('../../src/install/backup-set');
const { plantFullBackup } = require('../helper/backup-v1-fixture');
const { writeManifest, readManifest, readInstallManifest, canonicalManifestPath, manifestPath } = require('../../src/install/manifest');
const { legacyBackupReadRoot, scopeRootFromCanonicalBackupRoot } = require('../../src/install/paths');
// `installPaths` is the exact expression install.js/update.js/rollback.js use to pick a backup root,
// so the tests below derive the write side from the installer's own resolver rather than restating a
// literal path that could silently drift from it.
const { installPaths } = require('../../src/cli/shared');

/** A backup dir with a readable `.manifest.json`, planted directly at `root` (no writer). */
function plantBackup(root, id, extra = {}) {
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-test-'));
}

/** A format-2 backup of `files` (absolute paths under `scopeRoot`), as install writes one. */
function backupFiles({ scopeRoot, files, backupRoot, operation = 'install' }) {
  const set = backupSetFromPaths({ items: files.map((f) => ({ path: f, harnesses: ['claude'] })), scope: 'project', scopeRoot });
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
  assert.deepStrictEqual(listBackups(backupRoot).map((r) => [r.id, r.type, r.format]), [[bid, 'full', 1]]);
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

test('restoreBackup (full) round-trips a tar.gz back into the dst dir', () => {
  const root = scratchDir();
  const claudeDir = path.join(root, 'claude-src');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'original content');
  const backupRoot = path.join(root, 'backups');
  const bid = 'install_2026-03-15_10-20-30';
  plantFullBackup(backupRoot, bid, { tool: 'claude', srcDir: claudeDir });

  // mutate, then restore
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'mutated!');
  restoreBackup({ bid, backupRoot, dirs: { claude: claudeDir } });

  assert.strictEqual(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8'), 'original content');
});

test('assertSafeBackupId rejects traversal/absolute ids', () => {
  assert.throws(() => assertSafeBackupId('../../etc'));
  assert.throws(() => assertSafeBackupId('a/b'));
  assert.throws(() => assertSafeBackupId(''));
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
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  // Plant a symlink at a predictable tmp-file path pointing at a victim file outside claudeDir.
  const victim = path.join(root, 'victim.txt');
  fs.writeFileSync(victim, 'ORIGINAL VICTIM CONTENT');
  const predictedTmp = path.join(claudeDir, `.install-manifest-${process.pid}-${FIXED_DATE.getTime()}.json.tmp`);
  fs.symlinkSync(victim, predictedTmp);

  assert.throws(
    () => writeManifest({ claudeDir, scriptVersion: '0.1.0', operation: 'install', repoRoot: REPO, tools: ['claude'], date: FIXED_DATE }),
    /EEXIST/,
    'exclusive-create (wx) must refuse to write through a pre-existing symlink at the predicted path',
  );
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'ORIGINAL VICTIM CONTENT', 'victim file must be untouched');
});

test('manifest write/read round-trip, atomic (no .tmp left behind)', () => {
  const root = scratchDir();
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  writeManifest({ claudeDir, scriptVersion: '0.1.0', operation: 'install', repoRoot: REPO, backupId: 'install_2026-03-15_10-20-30', tools: ['claude'], date: FIXED_DATE });

  const read = readManifest(claudeDir);
  assert.strictEqual(read.operation, 'install');
  assert.strictEqual(read.backupId, 'install_2026-03-15_10-20-30');
  assert.ok(read.tools.claude.installed);
  assert.ok(fs.existsSync(manifestPath(claudeDir)));
  assert.ok(!fs.readdirSync(claudeDir).some((f) => f.endsWith('.tmp')), 'no leftover tmp file');
});

test('manifest preserves other tools\' last_updated across incremental writes', () => {
  const root = scratchDir();
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeManifest({ claudeDir, scriptVersion: '0.1.0', operation: 'install', repoRoot: REPO, tools: ['claude', 'codex'], date: FIXED_DATE });
  const later = new Date('2026-03-16T00:00:00');
  writeManifest({ claudeDir, scriptVersion: '0.1.0', operation: 'update', repoRoot: REPO, tools: ['claude'], date: later });

  const read = readManifest(claudeDir);
  assert.strictEqual(read.operation, 'update');
  assert.ok(read.tools.codex.installed, 'codex entry from the earlier write must survive');
  assert.notStrictEqual(read.tools.claude.last_updated, read.tools.codex.last_updated);
});

test('canonical lifecycle manifest lives under .doflow', () => {
  const root = scratchDir();
  const projectRoot = path.join(root, 'project');
  const claudeDir = path.join(projectRoot, '.claude');
  const canonical = canonicalManifestPath(projectRoot);

  writeManifest({ scopeRoot: projectRoot, claudeDir, scriptVersion: '2.0.0', operation: 'install', repoRoot: REPO, tools: ['codex'], date: FIXED_DATE });
  assert.ok(fs.existsSync(canonical));
  assert.ok(!fs.existsSync(manifestPath(claudeDir)), 'new lifecycle writes must not anchor metadata under .claude');
  assert.equal(readInstallManifest({ scopeRoot: projectRoot }).operation, 'install');
});

test('canonical lifecycle manifest preserves metadata across incremental writes', () => {
  const root = scratchDir();
  const projectRoot = path.join(root, 'project');
  writeManifest({ scopeRoot: projectRoot, scriptVersion: 'canonical', operation: 'install', repoRoot: REPO, tools: ['claude', 'codex'], date: FIXED_DATE });
  writeManifest({ scopeRoot: projectRoot, scriptVersion: 'canonical', operation: 'update', repoRoot: REPO, tools: ['claude'], date: new Date('2026-03-16T00:00:00Z') });
  const read = readInstallManifest({ scopeRoot: projectRoot });
  assert.equal(read.operation, 'update');
  assert.ok(read.tools.codex.installed);
});

test('readManifest returns null when no manifest exists yet', () => {
  const root = scratchDir();
  assert.strictEqual(readManifest(path.join(root, '.claude')), null);
});

// --- the two roots must agree -------------------------------------------------------------------
// 7de6d5f moved the backup root from `<scopeRoot>/.claude/backups` into `<scopeRoot>/.doflow/backups`
// and bridged only the install manifest, so every pre-move restore point became invisible to
// list-backups/rollback while both sides stayed internally consistent. These tests assert the
// agreement itself: the root the installer writes to is a root the restore path reads from, and the
// legacy root stays readable but never writable or prunable.

test('the root the installer writes to is a root the restore path reads from', () => {
  const root = scratchDir();
  const scope = { global: false, projectRoot: root };
  const lifecyclePaths = installPaths(scope);          // write side: what install.js hands createFileBackup
  const writeRoot = lifecyclePaths.backupRoot;

  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'hello');
  const { id: bid } = backupFiles({ scopeRoot: lifecyclePaths.scopeRoot, files: [path.join(lifecyclePaths.scopeRoot, '.claude', 'CLAUDE.md')], backupRoot: writeRoot });

  // Read side: the roots backup.js itself consults for this scope.
  const readRoots = backupReadRoots(writeRoot);
  assert.ok(
    readRoots.some((r) => r.root === writeRoot && r.origin === BACKUP_ORIGIN_CURRENT),
    'the installer\'s backup root must be read as the current root by the restore path',
  );
  assert.deepStrictEqual(
    listBackups(writeRoot).map((r) => ({ id: r.id, origin: r.origin })),
    [{ id: bid, origin: BACKUP_ORIGIN_CURRENT }],
    'a backup written by the installer must be listed from the same root',
  );

  // The legacy bridge is derived by inverting the write side's own mapping, so a future move of the
  // write root that this inverse no longer recognises orphans every legacy restore point silently.
  assert.strictEqual(
    scopeRootFromCanonicalBackupRoot(writeRoot), lifecyclePaths.scopeRoot,
    'the read side must be able to recover the scope root from the installer\'s backup root',
  );
  assert.ok(
    readRoots.some((r) => r.root === legacyBackupReadRoot({ scopeRoot: lifecyclePaths.scopeRoot }) && r.origin === BACKUP_ORIGIN_LEGACY),
    'the legacy root must be one of the roots the restore path reads',
  );
});

test('listBackups surfaces legacy-root restore points, tagged by origin', () => {
  const root = scratchDir();
  const scope = { global: false, projectRoot: root };
  const lifecyclePaths = installPaths(scope);
  const legacyRoot = legacyBackupReadRoot({ scopeRoot: lifecyclePaths.scopeRoot });

  plantBackup(legacyRoot, 'install_2026-01-01_00-00-00');
  plantBackup(lifecyclePaths.backupRoot, 'install_2026-06-01_00-00-00', { timestamp: '2026-06-01T00:00:00.000Z' });

  const rows = listBackups(lifecyclePaths.backupRoot);
  assert.strictEqual(rows.length, 2, 'both roots must be listed');
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.strictEqual(byId.get('install_2026-01-01_00-00-00').origin, BACKUP_ORIGIN_LEGACY);
  assert.strictEqual(byId.get('install_2026-01-01_00-00-00').backupRoot, legacyRoot);
  assert.strictEqual(byId.get('install_2026-06-01_00-00-00').origin, BACKUP_ORIGIN_CURRENT);
  assert.strictEqual(byId.get('install_2026-06-01_00-00-00').backupRoot, lifecyclePaths.backupRoot);
});

test('restoreBackup resolves an id that only exists in the legacy root', () => {
  const root = scratchDir();
  const scope = { global: false, projectRoot: root };
  const lifecyclePaths = installPaths(scope);
  const legacyRoot = legacyBackupReadRoot({ scopeRoot: lifecyclePaths.scopeRoot });
  const dstDir = path.join(root, 'dst-claude');

  // A legacy full backup: a tar.gz per tool plus its own manifest, exactly as DoFlow 1.19 wrote them.
  const srcDir = path.join(root, 'src-claude');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'CLAUDE.md'), 'legacy content');
  const bid = 'install_2026-01-01_00-00-00';
  plantBackup(legacyRoot, bid);
  require('node:child_process').execFileSync('tar', ['-czf', path.join(legacyRoot, bid, 'claude.tar.gz'), '-C', srcDir, '.']);

  restoreBackup({ bid, backupRoot: lifecyclePaths.backupRoot, dirs: { claude: dstDir } });
  assert.strictEqual(fs.readFileSync(path.join(dstDir, 'CLAUDE.md'), 'utf8'), 'legacy content');
});

test('applyRetention never touches the legacy root, and refuses to run against it', () => {
  const root = scratchDir();
  const scope = { global: false, projectRoot: root };
  const lifecyclePaths = installPaths(scope);
  const legacyRoot = legacyBackupReadRoot({ scopeRoot: lifecyclePaths.scopeRoot });

  const legacyDir = plantBackup(legacyRoot, 'install_2026-01-01_00-00-00');
  for (const id of ['install_2026-06-01_00-00-00', 'install_2026-06-02_00-00-00', 'install_2026-06-03_00-00-00']) {
    plantBackup(lifecyclePaths.backupRoot, id, { timestamp: `${id.slice(8, 18).replace(/_/g, '')}T00:00:00.000Z` });
  }
  assert.strictEqual(listBackups(lifecyclePaths.backupRoot).length, 4, 'all four are visible before pruning');

  const pruned = applyRetention({ backupRoot: lifecyclePaths.backupRoot, keep: 1 }).removed;
  assert.ok(fs.existsSync(legacyDir), 'pruning must not delete a legacy-root backup');
  assert.ok(fs.existsSync(path.join(legacyDir, '.manifest.json')), 'the legacy backup must be intact, not emptied');
  assert.ok(!pruned.includes('install_2026-01-01_00-00-00'), 'a legacy backup must never be reported as pruned');
  assert.strictEqual(pruned.length, 2, 'retention applies to the canonical root only');
  assert.strictEqual(listBackups(lifecyclePaths.backupRoot).length, 2, 'one canonical survivor plus the untouched legacy backup');

  // backupRoot accepts any string, so a mistaken legacy root must fail loudly rather than delete a
  // user's only restore points.
  assert.throws(() => applyRetention({ backupRoot: legacyRoot, keep: 1 }), /legacy backup root/);
  assert.ok(fs.existsSync(legacyDir), 'the refused prune must have deleted nothing');
});

test('createFileBackup refuses to write into the legacy root', () => {
  const root = scratchDir();
  const legacyRoot = legacyBackupReadRoot({ scopeRoot: root });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'x');
  assert.throws(
    () => backupFiles({ scopeRoot: root, files: [path.join(root, 'AGENTS.md')], backupRoot: legacyRoot }),
    /legacy backup root/,
    'new backups must land only in the canonical root',
  );
  assert.ok(!fs.existsSync(legacyRoot), 'the refused write must not have created the legacy root');
});
