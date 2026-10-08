'use strict';
// backup-harness-parity.e2e.test.js — for every harness in the registry, a global update backs up
// the file it changed and never a foreign file beside it, and rollback restores exactly that file.
// Each harness runs in its own scratch HOME through the real bin/doflow.js.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const { IS_WIN } = require('../helper-platform');
const { createScratch } = require('../helper/scratch-env');
const { toolDirs } = require('../../src/install/targets');
const { harnesses } = require('../../core/registry/harnesses.json');

const SCRATCHES = [];
after(() => { for (const scratch of SCRATCHES) scratch.remove(); });

function run(scratch, args) {
  const env = scratch.env();
  if (IS_WIN) env.USERPROFILE = scratch.home;
  return spawnSync('node', [DOFLOW, ...args], { cwd: scratch.dir, env, encoding: 'utf8', input: '\n', maxBuffer: 16 * 1024 * 1024 });
}

/** The harness's global home: its toolDirs entry, or `<home>/.gemini` for antigravity, which has none. */
function harnessHome(scratch, id) {
  scratch.apply();
  try {
    return id === 'antigravity' ? path.join(scratch.home, '.gemini') : toolDirs({ global: true })[id];
  } finally {
    scratch.restore();
  }
}

/** A regular file the ledger owns for `id` that is not an MCP entry; a plain copied file is preferred. */
function ownedFile(scratch, id) {
  const ledger = JSON.parse(fs.readFileSync(path.join(scratch.home, '.doflow', 'state', 'ledger.json'), 'utf8'));
  const candidates = ledger.resources
    .filter((r) => r.harness === id && r.kind !== 'mcp-server' && typeof r.target === 'string')
    .filter((r) => { try { return fs.statSync(r.target).isFile(); } catch { return false; } });
  const chosen = candidates.find((r) => r.kind === 'copy-tree-file') ?? candidates[0];
  return chosen ? chosen.target : null;
}

for (const { id } of harnesses) {
  test(`${id}: update backs up the changed owned file only, and rollback restores it`, (t) => {
    const scratch = createScratch(`doflow-parity-${id}-`);
    SCRATCHES.push(scratch);
    const install = run(scratch, ['install', '-g', '--force', '-t', id, '--mcp', 'none']);
    assert.strictEqual(install.status, 0, install.stderr);

    const owned = ownedFile(scratch, id);
    if (!owned) { t.skip(`a global ${id} install plans no file of its own`); return; }

    const foreignDir = path.join(harnessHome(scratch, id), 'foreign-parity');
    const foreign = path.join(foreignDir, 'sessions.bin');
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(foreign, Buffer.alloc(1024 * 1024, 7));
    fs.writeFileSync(owned, `overwritten for ${id}\n`);
    const backupRoot = path.join(scratch.home, '.doflow', 'backups');
    const before = new Set(fs.readdirSync(backupRoot));

    const update = run(scratch, ['update', '-g', '--force', '-t', id, '--mcp', 'none']);
    assert.strictEqual(update.status, 0, update.stderr);
    const added = fs.readdirSync(backupRoot).filter((n) => !before.has(n) && n.startsWith('update_'));
    assert.strictEqual(added.length, 1, update.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, added[0], '.manifest.json'), 'utf8'));

    const entry = manifest.files.find((f) => path.resolve(scratch.home, f.path) === owned);
    assert.ok(entry, `${owned} is in ${manifest.files.map((f) => f.path).join(', ')}`);
    assert.strictEqual(fs.readFileSync(path.join(backupRoot, added[0], ...entry.stored.split('/')), 'utf8'), `overwritten for ${id}\n`);
    assert.ok(!manifest.files.some((f) => path.resolve(scratch.home, f.path).startsWith(foreignDir + path.sep)));
    assert.ok(manifest.tools_affected.includes(id), manifest.tools_affected.join(','));
    assert.notStrictEqual(fs.readFileSync(owned, 'utf8'), `overwritten for ${id}\n`);

    const rollback = run(scratch, ['rollback', manifest.id, '-g', '--force']);
    assert.strictEqual(rollback.status, 0, rollback.stderr);
    assert.strictEqual(fs.readFileSync(owned, 'utf8'), `overwritten for ${id}\n`);
    assert.strictEqual(fs.readFileSync(foreign).length, 1024 * 1024);
    assert.ok(fs.readFileSync(foreign).every((b) => b === 7));
  });
}
