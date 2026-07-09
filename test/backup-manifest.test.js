'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { backupId, createBackup, restoreBackup, listBackups, pruneBackups, assertSafeBackupId } = require('../src/backup');
const { writeManifest, readManifest, manifestPath } = require('../src/manifest');
const { installTool, assertWithinRoot } = require('../src/copy');

const FIXED_DATE = new Date('2026-03-15T10:20:30');
const REPO = path.resolve(__dirname, '..');

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-test-'));
}

test('backupId matches sync.sh format <op>_YYYY-MM-DD_HH-MM-SS', () => {
  assert.strictEqual(backupId('install', FIXED_DATE), 'install_2026-03-15_10-20-30');
});

test('createBackup (full) writes a tar.gz per tool + a .manifest.json', () => {
  const root = scratchDir();
  const claudeDir = path.join(root, 'claude-src');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'hello');
  const backupRoot = path.join(root, 'backups');

  const bid = createBackup({
    operation: 'install', tools: ['claude'], dirs: { claude: claudeDir },
    backupRoot, repoRoot: REPO, date: FIXED_DATE,
  });

  assert.strictEqual(bid, 'install_2026-03-15_10-20-30');
  assert.ok(fs.existsSync(path.join(backupRoot, bid, 'claude.tar.gz')));
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, bid, '.manifest.json'), 'utf8'));
  assert.strictEqual(manifest.type, 'full');
  assert.deepStrictEqual(manifest.tools_affected, ['claude']);
});

test('createBackup (partial) copies only the listed files into <tool>/<rel>', () => {
  const root = scratchDir();
  const claudeDir = path.join(root, 'claude-src');
  fs.mkdirSync(path.join(claudeDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'a.md'), 'A');
  fs.writeFileSync(path.join(claudeDir, 'sub', 'b.md'), 'B');
  const backupRoot = path.join(root, 'backups');

  const bid = createBackup({
    operation: 'update', tools: ['claude'], dirs: { claude: claudeDir },
    backupRoot, repoRoot: REPO, partialFiles: [path.join(claudeDir, 'a.md')], date: FIXED_DATE,
  });

  assert.ok(fs.existsSync(path.join(backupRoot, bid, 'claude', 'a.md')));
  assert.ok(!fs.existsSync(path.join(backupRoot, bid, 'claude', 'sub', 'b.md')), 'unlisted file must not be backed up');
});

test('restoreBackup (full) round-trips a tar.gz back into the dst dir', () => {
  const root = scratchDir();
  const claudeDir = path.join(root, 'claude-src');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'original content');
  const backupRoot = path.join(root, 'backups');
  const bid = createBackup({ operation: 'install', tools: ['claude'], dirs: { claude: claudeDir }, backupRoot, repoRoot: REPO, date: FIXED_DATE });

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

test('listBackups / pruneBackups: prune keeps exactly N newest', () => {
  const root = scratchDir();
  const backupRoot = path.join(root, 'backups');
  for (const id of ['install_2026-01-01_00-00-00', 'install_2026-01-02_00-00-00', 'install_2026-01-03_00-00-00']) {
    fs.mkdirSync(path.join(backupRoot, id), { recursive: true });
    fs.writeFileSync(path.join(backupRoot, id, '.manifest.json'), JSON.stringify({ id, operation: 'install', timestamp: id, type: 'full' }));
  }
  assert.strictEqual(listBackups(backupRoot).length, 3);

  const pruned = pruneBackups(backupRoot, 1);
  assert.strictEqual(pruned.length, 2);
  assert.strictEqual(listBackups(backupRoot).length, 1);
});

test('createBackup disambiguates a same-second id collision instead of overwriting', () => {
  const root = scratchDir();
  const claudeDir = path.join(root, 'claude-src');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'first');
  const backupRoot = path.join(root, 'backups');

  const bid1 = createBackup({ operation: 'install', tools: ['claude'], dirs: { claude: claudeDir }, backupRoot, repoRoot: REPO, date: FIXED_DATE });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'second');
  const bid2 = createBackup({ operation: 'install', tools: ['claude'], dirs: { claude: claudeDir }, backupRoot, repoRoot: REPO, date: FIXED_DATE });

  assert.notStrictEqual(bid1, bid2, 'colliding same-second calls must get distinct ids');
  assert.ok(fs.existsSync(path.join(backupRoot, bid1, 'claude.tar.gz')));
  assert.ok(fs.existsSync(path.join(backupRoot, bid2, 'claude.tar.gz')), 'second backup must not have been skipped/overwritten');
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

test('readManifest returns null when no manifest exists yet', () => {
  const root = scratchDir();
  assert.strictEqual(readManifest(path.join(root, '.claude')), null);
});

test('assertWithinRoot rejects a mapping dst that escapes the tool dir', () => {
  const root = scratchDir();
  assert.throws(() => assertWithinRoot(root, path.join(root, '..', 'escaped.md'), '../escaped.md'));
  assert.doesNotThrow(() => assertWithinRoot(root, path.join(root, 'ok.md'), 'ok.md'));
});

test('installTool refuses to copy when a mapping dst escapes dstRoot', () => {
  const root = scratchDir();
  const srcFile = path.join(root, 'src.md');
  fs.writeFileSync(srcFile, 'x');
  const dstRoot = path.join(root, 'dstroot');
  fs.mkdirSync(dstRoot, { recursive: true });
  assert.throws(() => installTool(root, [{ src: 'src.md', dst: '../escape.md' }], dstRoot), /outside install root/);
});
