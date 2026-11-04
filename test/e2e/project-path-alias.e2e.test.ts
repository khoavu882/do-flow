'use strict';
// project-path-alias.e2e.test.ts — a project installed through one spelling of its path (a symlinked
// parent directory, as macOS does with /var -> /private/var) is still owned by DoFlow when update,
// reconcile and remove run from the other spelling (the real path, which is what a shell cwd reports).
// Before the fix the ledger rows held the aliased path, the verbs compared them with the real one,
// and codex and pi reported their own files as "not owned by DoFlow". The symlink is made inside the
// scratch directory so the case also runs on Linux. Every case runs the real bin/doflow.js.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const { IS_WIN } = require('../helper-platform.ts');
const { createScratch } = require('../helper/scratch-env.ts');

const CASE_TIMEOUT_MS = 240_000;
const TARGETS = 'claude,codex,pi,opencode,copilot';
const SCRATCHES: any = [];
after(() => { for (const scratch of SCRATCHES) scratch.remove(); });

function run(scratch: any, args: string[], cwd: string) {
  const env = scratch.env({ GIT_CONFIG_GLOBAL: '/dev/null' });
  return spawnSync(process.execPath, [DOFLOW, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

/** A git project at `<dir>/real/proj`, reachable as `<dir>/link/proj` through a directory symlink. */
function aliasedProject() {
  const scratch = createScratch('doflow-path-alias-');
  SCRATCHES.push(scratch);
  const realParent = path.join(scratch.dir, 'real');
  const aliasParent = path.join(scratch.dir, 'link');
  fs.mkdirSync(path.join(realParent, 'proj'), { recursive: true });
  fs.symlinkSync(realParent, aliasParent, 'dir');
  const real = path.join(realParent, 'proj');
  const aliased = path.join(aliasParent, 'proj');
  assert.strictEqual(fs.realpathSync(aliased), fs.realpathSync(real));
  assert.notStrictEqual(aliased, fs.realpathSync(aliased));
  const git = spawnSync('git', ['init', '-q'], { cwd: real, env: scratch.env({ GIT_CONFIG_GLOBAL: '/dev/null' }), encoding: 'utf8' });
  assert.strictEqual(git.status, 0, git.stderr);
  return { scratch, real, aliased };
}

function ok(result: any, label: string) {
  assert.strictEqual(result.status, 0, `${label} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /not owned by DoFlow|not owned by the neutral ledger/, label);
}

for (const installAs of ['aliased', 'real'] as const) {
  test(`install through the ${installAs} path, then update, reconcile and remove from the real cwd`, { skip: IS_WIN && 'symlinks need privileges on Windows', timeout: CASE_TIMEOUT_MS }, () => {
    const { scratch, real, aliased } = aliasedProject();
    const installPath = installAs === 'aliased' ? aliased : real;
    ok(run(scratch, ['install', installPath, '-t', TARGETS, '-f', '--mcp', 'none'], scratch.dir), 'install');

    ok(run(scratch, ['status'], real), 'status');
    ok(run(scratch, ['update', '-t', TARGETS, '-f'], real), 'update');
    ok(run(scratch, ['reconcile', '-f'], real), 'reconcile');

    // Project verbs given the other spelling explicitly reach the same records.
    ok(run(scratch, ['update', installAs === 'aliased' ? real : aliased, '-t', TARGETS, '-f'], scratch.dir), 'update via the other spelling');

    ok(run(scratch, ['remove', '-t', TARGETS, '-f'], real), 'remove');
    const status = run(scratch, ['status', '--json'], real);
    ok(status, 'status after remove');
    const ledgerFile = path.join(real, '.doflow', 'state', 'ledger.json');
    const rows = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).resources : [];
    assert.deepStrictEqual(rows, [], 'a complete remove leaves no ledger rows');

    // Reinstall after remove is not asserted: pi, opencode and copilot leave an empty AGENTS.md /
    // .github/copilot-instructions.md behind and then refuse it, with consistent paths too (separate defect).
  });
}
