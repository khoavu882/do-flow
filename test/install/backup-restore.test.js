'use strict';
// Restore planning and execution in src/install/backup.js: format-2 backups restore per file, 1.19
// backups keep restoring through restoreBackup. Every path lives under a scratch directory.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createFileBackup, planRestore, executeRestore, restoreBackup,
} = require('../../src/install/backup');
const { plantFullBackup, plantPartialBackup } = require('../helper/backup-v1-fixture');
const { IS_WIN } = require('../helper-platform');

const REPO = path.resolve(__dirname, '../..');
const DATE = new Date('2026-03-15T10:20:30');
const CANNOT_DENY_WRITES = IS_WIN || process.getuid?.() === 0;

const scratches = [];
after(() => { for (const dir of scratches) fs.rmSync(dir, { recursive: true, force: true }); });

/** A scratch scope root with its canonical backup root. */
function scratchScope() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-backup-restore-')));
  scratches.push(dir);
  const scopeRoot = path.join(dir, 'home');
  fs.mkdirSync(scopeRoot);
  return { dir, scopeRoot, backupRoot: path.join(scopeRoot, '.doflow', 'backups') };
}

function write(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode !== undefined) fs.chmodSync(file, mode);
  return file;
}

function read(file) { return fs.readFileSync(file, 'utf8'); }

/** A format-2 backup written by hand, so a test can plant entries the writer would never produce. */
function plantV2(backupRoot, id, entries, extra = {}) {
  const bkDir = path.join(backupRoot, id);
  fs.mkdirSync(bkDir, { recursive: true });
  const files = entries.map(({ content, ...entry }) => {
    const record = { harnesses: ['claude'], ...entry };
    if (content !== undefined) {
      record.stored = record.stored ?? `files/${entry.path}`;
      record.size = Buffer.byteLength(content);
      record.mode = record.mode ?? 0o644;
      write(path.join(bkDir, record.stored), content);
    }
    return record;
  });
  write(path.join(bkDir, '.manifest.json'), JSON.stringify({
    id, operation: 'update', timestamp: '2026-03-15T09:00:00.000Z', type: 'files', format: 2, files, ...extra,
  }));
  return bkDir;
}

/** The set createFileBackup takes, for files under `scopeRoot`. */
function setOf(scopeRoot, items) {
  const entries = items.map(({ file, harnesses = ['claude'] }) => {
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    return {
      path: file,
      rel: path.relative(scopeRoot, file).split(path.sep).join('/'),
      harnesses,
      reasons: ['change'],
      kind: st ? 'file' : 'absent',
      size: st ? st.size : null,
      mode: st ? st.mode & 0o7777 : null,
    };
  });
  return { scope: 'global', scopeRoot, entries, excluded: [], count: entries.length };
}

function plan(ctx, bid, extra = {}) {
  return planRestore({
    bid, backupRoot: ctx.backupRoot, scope: 'global', scopeRoot: ctx.scopeRoot, targets: ['claude'], explicitTargets: false, dirs: {}, ...extra,
  });
}

test('a format-2 backup restores each file\'s bytes and mode', () => {
  const ctx = scratchScope();
  const file = write(path.join(ctx.scopeRoot, '.claude', 'CLAUDE.md'), 'original', 0o600);
  const { id } = createFileBackup({
    operation: 'update', set: setOf(ctx.scopeRoot, [{ file }]), backupRoot: ctx.backupRoot, repoRoot: REPO, sourceCommit: 'x', version: '0', date: DATE,
  });
  write(file, 'changed', 0o644);

  const p = plan(ctx, id);
  assert.strictEqual(p.format, 2);
  assert.strictEqual(p.type, 'files');
  assert.strictEqual(p.origin, 'current');
  const result = executeRestore(p, { backupRoot: ctx.backupRoot });

  assert.deepStrictEqual(result, { restored: [file], failed: [], absent: [], refused: [], untargeted: 0, legacy: false });
  assert.strictEqual(read(file), 'original');
  if (!IS_WIN) assert.strictEqual(fs.statSync(file).mode & 0o7777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['CLAUDE.md'], 'no restore temp is left behind');
});

test('a file recorded absent is listed and left in place', () => {
  const ctx = scratchScope();
  const kept = write(path.join(ctx.scopeRoot, '.claude', 'kept.md'), 'kept');
  const created = path.join(ctx.scopeRoot, '.claude', 'skills', 'new.md');
  const { id } = createFileBackup({
    operation: 'install', set: setOf(ctx.scopeRoot, [{ file: kept }, { file: created }]), backupRoot: ctx.backupRoot, repoRoot: REPO, sourceCommit: 'x', version: '0', date: DATE,
  });
  write(created, 'written by the run');

  const p = plan(ctx, id);
  assert.deepStrictEqual(p.absent, [created]);
  const result = executeRestore(p, { backupRoot: ctx.backupRoot });
  assert.deepStrictEqual(result.absent, [created]);
  assert.deepStrictEqual(result.restored, [kept]);
  assert.strictEqual(read(created), 'written by the run', 'a file the run created is never deleted');
});

test('a target that cannot be written fails alone; the others restore', { skip: CANNOT_DENY_WRITES && 'needs a permission refusal: skipped as root or on Windows' }, () => {
  const ctx = scratchScope();
  const ok = path.join(ctx.scopeRoot, '.claude', 'ok.md');
  const locked = path.join(ctx.scopeRoot, '.codex', 'locked.md');
  write(ok, 'now');
  write(locked, 'now');
  plantV2(ctx.backupRoot, 'update_x', [
    { path: '.claude/ok.md', existed: true, content: 'before' },
    { path: '.codex/locked.md', existed: true, content: 'before' },
  ]);
  fs.chmodSync(path.dirname(locked), 0o555);
  try {
    const result = executeRestore(plan(ctx, 'update_x'), { backupRoot: ctx.backupRoot });
    assert.deepStrictEqual(result.restored, [ok]);
    assert.strictEqual(result.failed.length, 1);
    assert.strictEqual(result.failed[0].path, locked);
    assert.strictEqual(result.failed[0].reason, 'EACCES');
    assert.strictEqual(read(ok), 'before');
    assert.strictEqual(read(locked), 'now');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(locked)), ['locked.md']);
  } finally {
    fs.chmodSync(path.dirname(locked), 0o755);
  }
});

test('a symlinked target is written through and stays a link', { skip: IS_WIN && 'symlinks need privileges on Windows' }, () => {
  const ctx = scratchScope();
  const real = write(path.join(ctx.scopeRoot, 'dotfiles', 'CLAUDE.md'), 'now');
  const link = path.join(ctx.scopeRoot, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(real, link);
  plantV2(ctx.backupRoot, 'update_x', [{ path: '.claude/CLAUDE.md', existed: true, content: 'before' }]);

  const result = executeRestore(plan(ctx, 'update_x'), { backupRoot: ctx.backupRoot });
  assert.deepStrictEqual(result.restored, [link]);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.strictEqual(read(real), 'before');
});

test('unsafe entries are refused with their reasons and nothing is written for them', () => {
  const ctx = scratchScope();
  const outsideFile = path.join(ctx.dir, 'opt', 'AGENTS.md');
  plantV2(ctx.backupRoot, 'update_x', [
    { path: '../escape.md', existed: true, content: 'x', stored: 'files/escape.md' },
    { path: path.join(ctx.dir, 'abs.md'), existed: true, content: 'x', stored: 'files/abs.md' },
    { path: outsideFile, outside: true, existed: true, content: 'x', stored: 'external/0/AGENTS.md' },
    { path: '.claude/socket', existed: true, kind: 'other' },
    { path: '.claude/escaped-store.md', existed: true, stored: '../../../../etc/hosts' },
    { path: '.claude/missing-store.md', existed: true, stored: 'files/.claude/missing-store.md', mode: 420, size: 1 },
  ]);

  const project = plan(ctx, 'update_x', { scope: 'project' });
  assert.deepStrictEqual(project.refused, [
    { path: '../escape.md', reason: 'unsafe path' },
    { path: path.join(ctx.dir, 'abs.md'), reason: 'unsafe path' },
    { path: outsideFile, reason: 'outside the project root' },
    { path: path.join(ctx.scopeRoot, '.claude', 'socket'), reason: 'not a regular file when backed up' },
    { path: path.join(ctx.scopeRoot, '.claude', 'escaped-store.md'), reason: 'content missing from backup' },
    { path: path.join(ctx.scopeRoot, '.claude', 'missing-store.md'), reason: 'content missing from backup' },
  ]);
  assert.deepStrictEqual(project.restore, []);
  executeRestore(project, { backupRoot: ctx.backupRoot });
  assert.ok(!fs.existsSync(path.join(ctx.dir, 'escape.md')));
  assert.ok(!fs.existsSync(path.join(ctx.dir, 'abs.md')));
  assert.ok(!fs.existsSync(outsideFile));

  // In global scope an entry outside the scope root restores to its absolute path.
  const global = plan(ctx, 'update_x', { scope: 'global' });
  assert.deepStrictEqual(global.restore.map((r) => r.path), [outsideFile]);
  executeRestore(global, { backupRoot: ctx.backupRoot });
  assert.strictEqual(read(outsideFile), 'x');
});

test('--target restores only the named harnesses and counts the rest; no --target restores all', () => {
  const ctx = scratchScope();
  plantV2(ctx.backupRoot, 'update_x', [
    { path: '.claude/a.md', existed: true, content: 'a', harnesses: ['claude'] },
    { path: '.codex/b.md', existed: true, content: 'b', harnesses: ['codex'] },
    { path: '.agents/c.md', existed: true, content: 'c', harnesses: ['codex', 'claude'] },
    { path: '.codex/new.md', existed: false, harnesses: ['codex'] },
  ]);

  const targeted = plan(ctx, 'update_x', { targets: ['claude'], explicitTargets: true });
  assert.deepStrictEqual(targeted.restore.map((r) => r.path), [
    path.join(ctx.scopeRoot, '.claude', 'a.md'), path.join(ctx.scopeRoot, '.agents', 'c.md'),
  ]);
  assert.strictEqual(targeted.untargeted, 2);
  assert.deepStrictEqual(targeted.absent, []);

  const all = plan(ctx, 'update_x', { targets: ['claude'], explicitTargets: false });
  assert.strictEqual(all.restore.length, 3);
  assert.strictEqual(all.untargeted, 0);
  assert.deepStrictEqual(all.absent, [path.join(ctx.scopeRoot, '.codex', 'new.md')]);
});

test('the snapshot lists exactly what the restore will write, for format 2, 1.19 full and 1.19 partial', () => {
  const ctx = scratchScope();
  plantV2(ctx.backupRoot, 'update_x', [
    { path: '.claude/a.md', existed: true, content: 'a', harnesses: ['claude'] },
    { path: '.claude/gone.md', existed: false },
  ]);
  const v2 = plan(ctx, 'update_x');
  assert.deepStrictEqual(v2.snapshot, v2.restore.map((r) => ({ path: r.path, harnesses: r.harnesses })));
  assert.deepStrictEqual(v2.snapshot, [{ path: path.join(ctx.scopeRoot, '.claude', 'a.md'), harnesses: ['claude'] }]);

  const claudeDir = path.join(ctx.scopeRoot, '.claude');
  const src = path.join(ctx.dir, 'src');
  write(path.join(src, 'CLAUDE.md'), 'full');
  write(path.join(src, 'skills', 'do', 'SKILL.md'), 'skill');
  plantFullBackup(ctx.backupRoot, 'install_2026-01-01_00-00-00', { tool: 'claude', srcDir: src });
  const full = plan(ctx, 'install_2026-01-01_00-00-00', { dirs: { claude: claudeDir } });
  assert.strictEqual(full.format, 1);
  assert.strictEqual(full.type, 'full');
  assert.deepStrictEqual(full.v1, { tools: [{ tool: 'claude', dstDir: claudeDir, source: 'claude.tar.gz' }] });
  assert.deepStrictEqual(full.snapshot.map((s) => s.path).sort(), [
    path.join(claudeDir, 'CLAUDE.md'), path.join(claudeDir, 'skills', 'do', 'SKILL.md'),
  ].sort());
  assert.ok(full.snapshot.every((s) => s.harnesses.length === 1 && s.harnesses[0] === 'claude'));
  assert.deepStrictEqual([full.restore, full.absent, full.refused], [[], [], []]);

  plantPartialBackup(ctx.backupRoot, 'update_2026-01-02_00-00-00', { tool: 'claude', files: { 'a.md': 'A', 'sub/b.md': 'B' } });
  const partial = plan(ctx, 'update_2026-01-02_00-00-00', { dirs: { claude: claudeDir } });
  assert.strictEqual(partial.type, 'partial');
  assert.deepStrictEqual(partial.v1, { tools: [{ tool: 'claude', dstDir: claudeDir, source: 'claude/' }] });
  assert.deepStrictEqual(partial.snapshot, [
    { path: path.join(claudeDir, 'a.md'), harnesses: ['claude'] },
    { path: path.join(claudeDir, 'sub', 'b.md'), harnesses: ['claude'] },
  ]);
});

test('archive listings drop directories, ./ prefixes and .. members', () => {
  const ctx = scratchScope();
  const claudeDir = path.join(ctx.scopeRoot, '.claude');
  fs.mkdirSync(path.join(ctx.backupRoot, 'install_x'), { recursive: true });
  write(path.join(ctx.backupRoot, 'install_x', 'claude.tar.gz'), 'not read');
  const listTar = () => ['./', './CLAUDE.md', './skills/', './skills/x.md', '../evil.md', './a/../../evil.md', ''];
  const p = plan(ctx, 'install_x', { dirs: { claude: claudeDir }, listTar });
  assert.deepStrictEqual(p.snapshot.map((s) => s.path), [path.join(claudeDir, 'CLAUDE.md'), path.join(claudeDir, 'skills', 'x.md')]);
});

test('a backup from a newer DoFlow, or a missing id, is refused before anything is read further', () => {
  const ctx = scratchScope();
  plantV2(ctx.backupRoot, 'update_x', [], { format: 3 });
  assert.throws(() => plan(ctx, 'update_x'), {
    message: 'Backup update_x was made by a newer DoFlow (format 3); this version cannot restore it',
  });
  assert.throws(() => plan(ctx, 'update_none'), { message: 'Backup not found: update_none' });
  assert.throws(() => plan(ctx, '../escape'), /Invalid backup id/);
});

test('1.19 full and partial backups restore through executeRestore exactly as restoreBackup does', () => {
  const ctx = scratchScope();
  const claudeDir = path.join(ctx.scopeRoot, '.claude');
  const src = path.join(ctx.dir, 'src');
  write(path.join(src, 'CLAUDE.md'), 'from the archive');
  write(path.join(src, 'skills', 'x.md'), 'skill from the archive');
  plantFullBackup(ctx.backupRoot, 'install_2026-01-01_00-00-00', { tool: 'claude', srcDir: src });
  plantPartialBackup(ctx.backupRoot, 'update_2026-01-02_00-00-00', { tool: 'claude', files: { 'CLAUDE.md': 'from the copy' } });
  const dirs = { claude: claudeDir };
  const snapshotOf = () => ({ main: read(path.join(claudeDir, 'CLAUDE.md')), skill: read(path.join(claudeDir, 'skills', 'x.md')) });

  for (const bid of ['install_2026-01-01_00-00-00', 'update_2026-01-02_00-00-00']) {
    write(path.join(claudeDir, 'CLAUDE.md'), 'edited');
    write(path.join(claudeDir, 'skills', 'x.md'), 'edited skill');
    const result = executeRestore(plan(ctx, bid, { dirs }), { backupRoot: ctx.backupRoot });
    assert.deepStrictEqual(result, { restored: ['claude'], failed: [], absent: [], refused: [], untargeted: 0, legacy: true });
    const viaPlan = snapshotOf();

    write(path.join(claudeDir, 'CLAUDE.md'), 'edited');
    write(path.join(claudeDir, 'skills', 'x.md'), 'edited skill');
    restoreBackup({ bid, backupRoot: ctx.backupRoot, dirs });
    assert.deepStrictEqual(viaPlan, snapshotOf(), `${bid} restores the same bytes both ways`);
  }
  assert.strictEqual(read(path.join(claudeDir, 'CLAUDE.md')), 'from the copy');
  assert.strictEqual(read(path.join(claudeDir, 'skills', 'x.md')), 'edited skill', 'a partial restore leaves unlisted files alone');
});

test('restoreBackup refuses a format-2 backup instead of restoring nothing', () => {
  const ctx = scratchScope();
  plantV2(ctx.backupRoot, 'update_x', [{ path: '.claude/a.md', existed: true, content: 'a' }]);
  assert.throws(
    () => restoreBackup({ bid: 'update_x', backupRoot: ctx.backupRoot, dirs: { claude: path.join(ctx.scopeRoot, '.claude') } }),
    { message: 'Backup update_x is format 2; restore it with doflow rollback' },
  );
});

test('a dry run reports the restore and writes nothing', () => {
  const ctx = scratchScope();
  const file = write(path.join(ctx.scopeRoot, '.claude', 'a.md'), 'now');
  plantV2(ctx.backupRoot, 'update_x', [
    { path: '.claude/a.md', existed: true, content: 'before' },
    { path: '.claude/new/b.md', existed: true, content: 'before' },
  ]);

  const result = executeRestore(plan(ctx, 'update_x'), { backupRoot: ctx.backupRoot, dryRun: true });
  assert.deepStrictEqual(result.restored, [file, path.join(ctx.scopeRoot, '.claude', 'new', 'b.md')]);
  assert.strictEqual(read(file), 'now');
  assert.ok(!fs.existsSync(path.join(ctx.scopeRoot, '.claude', 'new')));
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['a.md']);
});
