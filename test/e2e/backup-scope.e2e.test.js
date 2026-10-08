'use strict';
// backup-scope.e2e.test.js — one case per backup-scope-and-retention scenario, through the real
// bin/doflow.js in a scratch HOME. Backups are read through their `.manifest.json`; 1.19 backups
// come from the fixture helper because nothing in src/ writes that layout any more.
const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const { IS_WIN } = require('../helper-platform');
const { createScratch } = require('../helper/scratch-env');
const { plantFullBackup, plantPartialBackup } = require('../helper/backup-v1-fixture');

const SCRATCHES = [];
after(() => { for (const scratch of SCRATCHES) scratch.remove(); });

function newScratch() {
  const scratch = createScratch('doflow-backup-scope-');
  SCRATCHES.push(scratch);
  return scratch;
}

function spawnOptions(scratch, cwd) {
  const env = scratch.env();
  if (IS_WIN) env.USERPROFILE = scratch.home;
  return { cwd: cwd ?? scratch.dir, env, encoding: 'utf8', input: '\n', maxBuffer: 16 * 1024 * 1024 };
}

function run(scratch, args, { cwd } = {}) {
  return spawnSync('node', [DOFLOW, ...args], spawnOptions(scratch, cwd));
}

const INSTALL = ['install', '-g', '--force', '--mcp', 'none'];
const UPDATE = ['update', '-g', '--force', '--mcp', 'none'];

function install(scratch, targets, extra = []) {
  const r = run(scratch, [...INSTALL, '-t', targets, ...extra]);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  return r;
}

const backupRoot = (scratch) => path.join(scratch.home, '.doflow', 'backups');
const backupIds = (scratch) => (fs.existsSync(backupRoot(scratch))
  ? fs.readdirSync(backupRoot(scratch)).filter((n) => !n.startsWith('.')).sort() : []);
const readManifest = (scratch, id) => JSON.parse(fs.readFileSync(path.join(backupRoot(scratch), id, '.manifest.json'), 'utf8'));
const createdId = (r) => /Backup created: (\S+)/.exec(r.stderr)?.[1];

/** Regular files DoFlow's ledger owns under `<home>/<prefix>`, one per directory, sorted by path. */
function ownedFiles(scratch, prefix, count) {
  const ledger = JSON.parse(fs.readFileSync(path.join(scratch.home, '.doflow', 'state', 'ledger.json'), 'utf8'));
  const seenDirs = new Set();
  const found = [];
  for (const r of ledger.resources.filter((x) => x.kind === 'copy-tree-file').sort((a, b) => (a.target < b.target ? -1 : 1))) {
    if (!r.target.startsWith(path.join(scratch.home, prefix) + path.sep)) continue;
    const dir = path.dirname(r.target);
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    found.push(r.target);
    if (found.length === count) break;
  }
  assert.strictEqual(found.length, count, 'the ledger owns enough files');
  return found;
}

const rel = (scratch, file) => path.relative(scratch.home, file).split(path.sep).join('/');

function overwrite(files, label) {
  files.forEach((file, i) => fs.writeFileSync(file, `${label}-${i}\n`));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function hashTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile()) out[p] = sha(p);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

/** Plants a format-2 backup older than anything a run writes now; `n` orders the plants. */
function plantV2(root, n) {
  const day = String(n).padStart(2, '0');
  const id = `install_2020-01-${day}_00-00-00`;
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id, operation: 'install', timestamp: `2020-01-${day}T00:00:00.000Z`, source_path: '/doflow', source_commit: 'unknown',
    type: 'files', tools_affected: [], format: 2, doflow_version: '1.19.0', scope: 'global', scope_root: path.dirname(path.dirname(root)),
    restores: null, summary: { files: 0, existed: 0, absent: 0, bytes: 0 }, excluded: [], files: [],
  };
  fs.writeFileSync(path.join(dir, '.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return id;
}

/** The byte count a `list-backups` SIZE cell stands for, rounded up. */
function sizeBound(cell) {
  const m = /^([\d.]+) (B|KiB|MiB|GiB)$/.exec(cell);
  assert.ok(m, `size cell: ${cell}`);
  return Math.ceil(Number(m[1]) * { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[m[2]]);
}

/** `{ id, type, origin, size }` for each row of the `list-backups` table. */
function listRows(scratch, extra = []) {
  const r = run(scratch, ['list-backups', '-g', ...extra]);
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.split('\n').map((line) => /^(\S+)\s+(\S+)\s+(\S+)\s+(current|legacy)\s+(\S+(?: \S+)?)\s+\S+$/.exec(line))
    .filter(Boolean).map((m) => ({ id: m[1], operation: m[2], type: m[3], origin: m[4], size: m[5] }));
}

const canChmod = !IS_WIN && typeof process.getuid === 'function' && process.getuid() !== 0;

/** install, edit `count` owned files and update: the starting point of the update and rollback cases. */
function updatedScenario(scratch, count = 5) {
  install(scratch, 'claude');
  const files = ownedFiles(scratch, '.claude', count);
  overwrite(files, 'edited');
  const update = run(scratch, [...UPDATE, '-t', 'claude']);
  assert.strictEqual(update.status, 0, update.stderr);
  return { files, update, id: createdId(update) };
}

test('foreign data is not archived: an update backs up its changed files and none of the harness home around them', () => {
  const scratch = newScratch();
  install(scratch, 'claude,codex');
  const foreign = [path.join(scratch.home, '.codex', 'sessions', 'rollout.jsonl'), path.join(scratch.home, '.claude', 'projects', 'p', 'chat.jsonl')];
  write(foreign[0], Buffer.alloc(3 * 1024 * 1024, 1));
  write(foreign[1], Buffer.alloc(2 * 1024 * 1024, 2));
  const files = ownedFiles(scratch, '.claude', 4);
  overwrite(files, 'edited');

  const update = run(scratch, [...UPDATE, '-t', 'claude,codex']);
  assert.strictEqual(update.status, 0, update.stderr);
  const manifest = readManifest(scratch, createdId(update));
  assert.deepStrictEqual(manifest.files.map((f) => f.path).sort(), files.map((f) => rel(scratch, f)).sort());

  const names = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { names.push(e.name); if (e.isDirectory()) walk(path.join(dir, e.name)); } };
  walk(backupRoot(scratch));
  assert.ok(!names.some((n) => n === 'sessions' || n === 'projects' || n === 'rollout.jsonl' || n === 'chat.jsonl'), names.join(' '));

  const row = listRows(scratch).find((x) => x.id === manifest.id);
  assert.ok(sizeBound(row.size) <= manifest.summary.bytes + 192 * 1024, `${row.size} for ${manifest.summary.bytes} bytes of files`);
  assert.ok(sizeBound(row.size) < 1024 * 1024, `${row.size} is far below the 5 MiB of foreign data`);
});

test('update backs up its own files: the edited ones, as they were', () => {
  const scratch = newScratch();
  install(scratch, 'claude');
  const files = ownedFiles(scratch, '.claude', 5);
  overwrite(files, 'edited');
  const update = run(scratch, [...UPDATE, '-t', 'claude']);
  assert.strictEqual(update.status, 0, update.stderr);
  const id = createdId(update);
  const manifest = readManifest(scratch, id);
  assert.deepStrictEqual(manifest.files.map((f) => f.path).sort(), files.map((f) => rel(scratch, f)).sort());
  for (const [i, file] of files.entries()) {
    const entry = manifest.files.find((f) => f.path === rel(scratch, file));
    assert.strictEqual(entry.existed, true);
    assert.strictEqual(fs.readFileSync(path.join(backupRoot(scratch), id, ...entry.stored.split('/')), 'utf8'), `edited-${i}\n`);
  }
});

test('rollback restores exactly the backup and snapshots only those files', () => {
  const scratch = newScratch();
  const { files, id } = updatedScenario(scratch);
  const foreign = path.join(scratch.home, '.claude', 'projects', 'notes.txt');
  write(foreign, 'user data\n');
  overwrite(files, 'later');
  write(foreign, 'user data, edited later\n');

  const r = run(scratch, ['rollback', id, '-g', '--force']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Rollback to '.+' complete: restored 5 file\(s\)/);
  files.forEach((file, i) => assert.strictEqual(fs.readFileSync(file, 'utf8'), `edited-${i}\n`));
  assert.strictEqual(fs.readFileSync(foreign, 'utf8'), 'user data, edited later\n');

  const snapshotId = backupIds(scratch).find((n) => n.startsWith('pre-rollback_'));
  const snapshot = readManifest(scratch, snapshotId);
  assert.strictEqual(snapshot.restores, id);
  assert.deepStrictEqual(snapshot.files.map((f) => f.path).sort(), files.map((f) => rel(scratch, f)).sort());
  const stored = snapshot.files.find((f) => f.path === rel(scratch, files[0]));
  assert.strictEqual(fs.readFileSync(path.join(backupRoot(scratch), snapshotId, ...stored.stored.split('/')), 'utf8'), 'later-0\n');
});

test('rollback names what it leaves in place and exits 0', () => {
  const scratch = newScratch();
  install(scratch, 'claude');
  const [gone1, gone2] = ownedFiles(scratch, '.claude', 2);
  fs.rmSync(gone1);
  fs.rmSync(gone2);
  const update = run(scratch, [...UPDATE, '-t', 'claude']);
  assert.strictEqual(update.status, 0, update.stderr);
  const id = createdId(update);
  assert.ok(readManifest(scratch, id).files.every((f) => f.existed === false));

  const r = run(scratch, ['rollback', id, '-g', '--force']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /Left in place 2 file\(s\)/);
  assert.ok(r.stderr.includes(gone1) && r.stderr.includes(gone2), r.stderr);
  assert.ok(fs.existsSync(gone1) && fs.existsSync(gone2));
});

test('rollback that cannot write one file restores the others and exits 1', { skip: !canChmod && 'needs POSIX permissions and a non-root user' }, (t) => {
  const scratch = newScratch();
  const { files, id } = updatedScenario(scratch, 3);
  overwrite(files, 'later');
  const lockedDir = path.dirname(files[0]);
  fs.chmodSync(lockedDir, 0o555);
  t.after(() => fs.chmodSync(lockedDir, 0o755));

  const r = run(scratch, ['rollback', id, '-g', '--force']);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(`Could not restore ${files[0]}`), r.stderr);
  assert.match(r.stderr, /restored 2, could not restore 1/);
  assert.strictEqual(fs.readFileSync(files[0], 'utf8'), 'later-0\n');
  assert.strictEqual(fs.readFileSync(files[1], 'utf8'), 'edited-1\n');
  assert.strictEqual(fs.readFileSync(files[2], 'utf8'), 'edited-2\n');
});

test('default keeps three backups and says so', () => {
  const scratch = newScratch();
  for (let n = 1; n <= 5; n += 1) plantV2(backupRoot(scratch), n);
  const r = install(scratch, 'claude');
  const id = createdId(r);
  assert.ok(id, r.stderr);
  const ids = backupIds(scratch);
  assert.strictEqual(ids.length, 3);
  assert.ok(ids.includes(id));
  assert.match(r.stderr, /Backups: kept 3, removed 3/);
});

test('--prune N overrides the default', () => {
  const scratch = newScratch();
  install(scratch, 'claude');
  for (let n = 1; n <= 8; n += 1) plantV2(backupRoot(scratch), n);
  overwrite(ownedFiles(scratch, '.claude', 1), 'edited');
  const r = run(scratch, [...UPDATE, '-t', 'claude', '--prune', '5']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(backupIds(scratch).length, 5);
  assert.match(r.stderr, /Backups: kept 5/);
});

test('--prune 0 keeps every backup', () => {
  const scratch = newScratch();
  for (let n = 1; n <= 8; n += 1) plantV2(backupRoot(scratch), n);
  const r = install(scratch, 'claude', ['--prune', '0']);
  assert.strictEqual(backupIds(scratch).length, 9);
  assert.match(r.stderr, /removed 0 \(--prune 0 keeps every backup\)/);
});

test('a bad --prune value stops before anything is written', () => {
  const scratch = newScratch();
  const text = run(scratch, [...INSTALL, '--prune', 'abc']);
  assert.strictEqual(text.status, 2, text.stderr);
  const negative = run(scratch, [...INSTALL, '--prune', '-2']);
  assert.strictEqual(negative.status, 1, negative.stderr);
  assert.ok(!fs.existsSync(path.join(scratch.home, '.claude')));
});

test('a large backup folder is listed with sizes and cut to three', () => {
  const scratch = newScratch();
  const src = path.join(scratch.dir, 'archive-src');
  const planted = [];
  for (let n = 1; n <= 12; n += 1) {
    write(path.join(src, 'blob.bin'), crypto.randomBytes(64 * 1024));
    const id = `install_2020-02-${String(n).padStart(2, '0')}_00-00-00`;
    plantFullBackup(backupRoot(scratch), id, { tool: 'claude', srcDir: src, manifest: { timestamp: `2020-02-${String(n).padStart(2, '0')}T00:00:00.000Z` } });
    planted.push(id);
  }
  const rows = listRows(scratch);
  assert.strictEqual(rows.length, 12);
  assert.ok(rows.every((row) => row.type === 'full' && sizeBound(row.size) >= 64 * 1024), JSON.stringify(rows));

  const r = install(scratch, 'claude');
  assert.strictEqual(backupIds(scratch).length, 3);
  assert.match(r.stderr, /removed 10/);
});

test('backups from before the move to .doflow are never touched', () => {
  const scratch = newScratch();
  const legacyRoot = path.join(scratch.home, '.claude', 'backups');
  plantPartialBackup(legacyRoot, 'install_2019-01-01_00-00-00', { tool: 'claude', files: { 'a.md': 'one' } });
  plantPartialBackup(legacyRoot, 'update_2019-01-02_00-00-00', { tool: 'claude', files: { 'b.md': 'two' } });
  const before = hashTree(legacyRoot);
  assert.strictEqual(Object.keys(before).length, 4);

  install(scratch, 'claude', ['--prune', '1']);
  assert.deepStrictEqual(hashTree(legacyRoot), before);
  overwrite(ownedFiles(scratch, '.claude', 2), 'edited');
  const update = run(scratch, [...UPDATE, '-t', 'claude', '--prune', '1']);
  assert.strictEqual(update.status, 0, update.stderr);
  assert.deepStrictEqual(hashTree(legacyRoot), before);
  const rollback = run(scratch, ['rollback', createdId(update), '-g', '--force']);
  assert.strictEqual(rollback.status, 0, rollback.stderr);
  assert.deepStrictEqual(hashTree(legacyRoot), before);

  const legacyRows = listRows(scratch).filter((row) => row.origin === 'legacy');
  assert.deepStrictEqual(legacyRows.map((row) => row.id).sort(), ['install_2019-01-01_00-00-00', 'update_2019-01-02_00-00-00']);
});

test('project scope prunes the project folder and leaves the global one', () => {
  const scratch = newScratch();
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(project);
  for (let n = 1; n <= 6; n += 1) plantV2(backupRoot(scratch), n);
  const projectRoot = path.join(project, '.doflow', 'backups');
  for (let n = 1; n <= 5; n += 1) plantV2(projectRoot, n);

  const r = run(scratch, ['install', project, '--force', '--mcp', 'none', '-t', 'claude']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readdirSync(projectRoot).length, 3);
  assert.strictEqual(backupIds(scratch).length, 6);
});

test('a dry run reports what the real run then backs up and writes nothing', () => {
  const scratch = newScratch();
  install(scratch, 'claude');
  const files = ownedFiles(scratch, '.claude', 3);
  overwrite(files, 'edited');
  const before = backupIds(scratch);

  const dry = run(scratch, [...UPDATE, '-t', 'claude', '--dry-run']);
  assert.strictEqual(dry.status, 0, dry.stderr);
  const m = /Would back up (\d+) file\(s\), .*\((\d+) bytes; \d+ not present yet\)/.exec(dry.stdout);
  assert.ok(m, dry.stdout);
  assert.deepStrictEqual(backupIds(scratch), before);
  const leftovers = fs.readdirSync(backupRoot(scratch)).filter((n) => n.startsWith('.tmp-'));
  assert.deepStrictEqual(leftovers, []);

  const real = run(scratch, [...UPDATE, '-t', 'claude']);
  assert.strictEqual(real.status, 0, real.stderr);
  const { summary } = readManifest(scratch, createdId(real));
  assert.strictEqual(Number(m[1]), summary.files);
  assert.strictEqual(Number(m[2]), summary.bytes);
});

test('a dry run on a fresh home creates no backup folder', () => {
  const scratch = newScratch();
  const dry = run(scratch, ['install', '-g', '--dry-run', '--mcp', 'none', '-t', 'claude']);
  assert.strictEqual(dry.status, 0, dry.stderr);
  const m = /Would back up (\d+) file\(s\)/.exec(dry.stdout);
  assert.ok(m, dry.stdout);
  assert.ok(!fs.existsSync(path.join(scratch.home, '.doflow', 'backups')));
  const real = install(scratch, 'claude');
  assert.strictEqual(Number(m[1]), readManifest(scratch, createdId(real)).summary.files);
});

test('older backups are listed and roll back to their own bytes', () => {
  const scratch = newScratch();
  const src = path.join(scratch.dir, 'archive-src');
  write(path.join(src, 'from-archive.txt'), 'archive bytes');
  plantFullBackup(backupRoot(scratch), 'install_2020-03-01_00-00-00', { tool: 'claude', srcDir: src, manifest: { timestamp: '2020-03-01T00:00:00.000Z' } });
  plantPartialBackup(backupRoot(scratch), 'update_2020-03-02_00-00-00', { tool: 'claude', files: { 'from-partial.txt': 'partial bytes' }, manifest: { timestamp: '2020-03-02T00:00:00.000Z' } });
  const rows = listRows(scratch);
  assert.deepStrictEqual(rows.map((row) => [row.id, row.type]), [['update_2020-03-02_00-00-00', 'partial'], ['install_2020-03-01_00-00-00', 'full']]);

  const full = run(scratch, ['rollback', 'install_2020-03-01_00-00-00', '-g', '--force']);
  assert.strictEqual(full.status, 0, full.stderr);
  assert.match(full.stderr, /whole-home archive/);
  assert.strictEqual(fs.readFileSync(path.join(scratch.home, '.claude', 'from-archive.txt'), 'utf8'), 'archive bytes');

  const partial = run(scratch, ['rollback', 'update_2020-03-02_00-00-00', '-g', '--force']);
  assert.strictEqual(partial.status, 0, partial.stderr);
  assert.strictEqual(fs.readFileSync(path.join(scratch.home, '.claude', 'from-partial.txt'), 'utf8'), 'partial bytes');
});

test('a backup that cannot be written stops the run, and a dead run\'s temp folder is cleaned up next time', { skip: !canChmod && 'needs POSIX permissions and a non-root user' }, (t) => {
  const scratch = newScratch();
  install(scratch, 'claude');
  overwrite(ownedFiles(scratch, '.claude', 2), 'edited');
  const before = hashTree(path.join(scratch.home, '.claude'));
  const idsBefore = backupIds(scratch);
  fs.chmodSync(backupRoot(scratch), 0o555);
  t.after(() => fs.chmodSync(backupRoot(scratch), 0o755));

  const failed = run(scratch, [...UPDATE, '-t', 'claude']);
  assert.strictEqual(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /Backup failed, nothing was changed/);
  assert.deepStrictEqual(hashTree(path.join(scratch.home, '.claude')), before);
  assert.deepStrictEqual(listRows(scratch).map((row) => row.id).sort(), idsBefore);

  fs.chmodSync(backupRoot(scratch), 0o755);
  const dead = spawnSync(process.execPath, ['-e', '']);
  assert.ok(dead.pid > 0);
  const temp = path.join(backupRoot(scratch), `.tmp-x-${dead.pid}-deadbeef`);
  write(path.join(temp, '.owner.json'), `${JSON.stringify({ pid: dead.pid, hostname: os.hostname(), startedAt: '2020-01-01T00:00:00.000Z' })}\n`);
  const next = run(scratch, [...UPDATE, '-t', 'claude']);
  assert.strictEqual(next.status, 0, next.stderr);
  assert.ok(!fs.existsSync(temp));
});

test('two runs at once each keep a complete backup of their own', async () => {
  const scratch = newScratch();
  install(scratch, 'claude');
  overwrite(ownedFiles(scratch, '.claude', 4), 'edited');
  const before = new Set(backupIds(scratch));

  const start = () => new Promise((resolve, reject) => {
    const child = spawn('node', [DOFLOW, ...INSTALL, '-t', 'claude'], spawnOptions(scratch));
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr }));
    child.stdin.end('\n');
  });
  const results = await Promise.all([start(), start()]);
  for (const r of results) assert.strictEqual(r.status, 0, r.stderr);

  const added = backupIds(scratch).filter((id) => !before.has(id));
  assert.strictEqual(added.length, 2, `${added} ${results.map((r) => r.stderr).join('\n')}`);
  for (const id of added) assert.strictEqual(readManifest(scratch, id).format, 2);
});

test('--no-backup alone is refused, and with --force it skips the backup', () => {
  const scratch = newScratch();
  const alone = run(scratch, ['install', '-g', '--mcp', 'none', '-t', 'claude', '--no-backup']);
  assert.strictEqual(alone.status, 1, alone.stderr);

  const forced = run(scratch, [...INSTALL, '-t', 'claude', '--no-backup']);
  assert.strictEqual(forced.status, 0, forced.stderr);
  assert.match(forced.stderr, /Skipping backup/);
  assert.ok(!fs.existsSync(backupRoot(scratch)));
});
