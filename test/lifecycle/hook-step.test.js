'use strict';

// hook-step.test.js: IC-037 (DEC-034). An install or update that changes the shared hooks tree also
// moves the hook front doors of the other harnesses installed in the same scope, in the same plan,
// backup and ledger write; a door edited outside DoFlow refuses the whole plan.
//
// Every cell is a real install into a scratch HOME and project; nothing outside it is read or written.
// The "older doors" are the bytes of develop commit 0fcd973 (the v2.0.0 merge-back, before the hook
// envelope), installed by that commit's own CLI taken from `git archive`.

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { suiteTempDir } = require('../helper/tmp');
const { IS_WIN } = require('../helper-platform');
const { loadRegistry } = require('../../src/registry/index.ts');
const { registryLifecycleView } = require('../../src/lifecycle/view.ts');
const { readScopes } = require('../../src/runtime/inventory/read-scopes.ts');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const OLDER = '0fcd973';
const OLDER_SKIP = IS_WIN ? 'the hook scripts are POSIX shell' : false;
const SKIP = IS_WIN ? 'the hook scripts are POSIX shell' : false;

const notice = (harness) => `refreshed ${harness} hook front doors to match the shared hooks tree`;
const CLAUDE_DOORS = path.join(REPO, 'core', 'harnesses', 'claude', 'hooks');

let olderCli = null;

before(() => {
  if (OLDER_SKIP) return;
  const reachable = spawnSync('git', ['cat-file', '-e', `${OLDER}^{commit}`], { cwd: REPO, encoding: 'utf8' });
  assert.equal(reachable.status, 0, `required baseline commit ${OLDER} is unreachable; fetch the full history before running IC-037 lifecycle tests${reachable.stderr ? `: ${reachable.stderr.trim()}` : ''}`);
  const dir = suiteTempDir('doflow-hook-step-older-');
  const archive = spawnSync('git', ['archive', '--format=tar', '-o', path.join(dir, 'older.tar'), OLDER], { cwd: REPO, encoding: 'utf8' });
  assert.equal(archive.status, 0, archive.stderr);
  assert.equal(spawnSync('tar', ['-x', '-f', path.join(dir, 'older.tar'), '-C', dir]).status, 0);
  olderCli = path.join(dir, 'bin', 'doflow.js');
});

/** A scratch directory with a `proj/` project and an empty HOME. */
function cell(name) {
  const scratch = createScratch(`doflow-hook-step-${name}-`);
  fs.mkdirSync(path.join(scratch.dir, 'proj'));
  const proj = path.join(scratch.dir, 'proj');
  // `answer` is what the child reads on stdin: update asks for a confirmation unless it is forced.
  const run = (args, { cli = CLI, cwd = scratch.dir, answer = 'y\n' } = {}) => {
    const done = spawnSync(process.execPath, [cli, ...args], { cwd, env: scratch.env({ DOFLOW_FAILURE_CAPTURE: 'off' }), input: answer, encoding: 'utf8' });
    return { status: done.status, stdout: done.stdout, stderr: done.stderr, output: `${done.stdout}\n${done.stderr}` };
  };
  return { scratch, proj, home: scratch.home, run };
}

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** Every file under `root`, relative path to content hash. */
function snapshot(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(root, full)] = sha(fs.readFileSync(full));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return files;
}

/** The part of a snapshot under `prefix`. */
const under = (files, prefix) => Object.fromEntries(Object.entries(files).filter(([rel]) => rel.startsWith(prefix)));

function ledgerRows(proj) {
  return JSON.parse(fs.readFileSync(path.join(proj, '.doflow', 'state', 'ledger.json'), 'utf8')).resources;
}

/** claude and pi installed by the older commit, so claude's doors are the pre-envelope ones. */
function installOlder(c) {
  const done = c.run(['install', 'proj', '-f', '--no-backup', '-t', 'claude,pi'], { cli: olderCli });
  assert.equal(done.status, 0, done.output);
  const door = path.join(c.proj, '.claude', 'hooks', 'pre-implement-gate.sh');
  assert.notDeepEqual(fs.readFileSync(door), fs.readFileSync(path.join(CLAUDE_DOORS, 'pre-implement-gate.sh')), `the ${OLDER} claude door equals this checkout's; the cell proves nothing`);
  return door;
}

/** Each claude door file equals the current source. */
function assertClaudeDoorsCurrent(c) {
  const names = fs.readdirSync(CLAUDE_DOORS);
  assert.ok(names.length > 0);
  for (const name of names) {
    assert.ok(fs.readFileSync(path.join(c.proj, '.claude', 'hooks', name)).equals(fs.readFileSync(path.join(CLAUDE_DOORS, name))), `${name} is not the current door`);
  }
}

describe('IC-037: the installer keeps front doors in step with the shared hooks tree', { skip: SKIP, concurrency: 4 }, () => {
  test('claude on older doors plus `update -t pi` refreshes the claude doors, says so, and keeps their rows with claude', { skip: OLDER_SKIP }, () => {
    const c = cell('refresh');
    installOlder(c);
    const updated = c.run(['update', 'proj', '-t', 'pi']);
    assert.equal(updated.status, 0, updated.output);
    assert.ok(updated.stdout.includes(`[INFO] claude: ${notice('claude')}`), updated.stdout);
    assertClaudeDoorsCurrent(c);

    const rows = ledgerRows(c.proj);
    for (const name of fs.readdirSync(CLAUDE_DOORS)) {
      const target = path.join(c.proj, '.claude', 'hooks', name);
      const mine = rows.filter((row) => row.target === target);
      assert.equal(mine.length, 1, `${name}: ${mine.length} ledger rows`);
      assert.equal(mine[0].harness, 'claude');
      assert.equal(mine[0].assetId, 'claude.hooks-scripts');
      assert.equal(String(mine[0].fingerprint).replace(/^sha256:/, ''), sha(fs.readFileSync(path.join(CLAUDE_DOORS, name))), `${name}: stale fingerprint`);
    }
    // The run did not name claude, so nothing but its doors moved: pi's rows are still pi's.
    assert.ok(rows.filter((row) => row.target.includes(`${path.sep}.pi${path.sep}`)).every((row) => row.harness === 'pi'));

    // Nothing is left to refresh: the next update is quiet about it.
    const again = c.run(['update', 'proj', '-t', 'pi']);
    assert.equal(again.status, 0, again.output);
    assert.ok(!again.output.includes('hook front doors'), again.output);
  });

  test('a tree change with the doors already current plans no companion and prints no notice', { skip: SKIP }, () => {
    const c = cell('current');
    assert.equal(c.run(['install', 'proj', '-f', '--no-backup', '-t', 'claude,pi']).status, 0);
    const treeFile = path.join(c.proj, '.doflow', 'shared', 'hooks', 'policies', 'lib.sh');
    fs.rmSync(treeFile);
    const doors = under(snapshot(c.proj), '.claude/hooks');
    const updated = c.run(['update', 'proj', '-t', 'pi']);
    assert.equal(updated.status, 0, updated.output);
    assert.ok(fs.existsSync(treeFile), 'the update restores the tree file, so the tree did change');
    assert.ok(!updated.output.includes('hook front doors'), updated.output);
    assert.deepEqual(under(snapshot(c.proj), '.claude/hooks'), doors);
  });

  test('an edited claude door refuses the plan with exit 1 and leaves the tree and every door byte-unchanged', { skip: OLDER_SKIP }, () => {
    const c = cell('edited');
    const door = installOlder(c);
    fs.appendFileSync(door, '# edited by hand\n');
    const before = snapshot(c.scratch.dir);
    const updated = c.run(['update', 'proj', '-t', 'pi']);
    assert.equal(updated.status, 1, updated.output);
    assert.ok(updated.stderr.includes('[ERROR] claude lifecycle refused: claude.hooks-scripts: pre-implement-gate.sh was modified outside DoFlow'), updated.stderr);
    assert.ok(updated.stderr.includes('claude hook front doors must move with the shared hooks tree; run: doflow update -t pi,claude (add -f to overwrite edited doors)'), updated.stderr);
    assert.deepEqual(snapshot(c.scratch.dir), before, 'a refused plan writes nothing, not even a backup or a ledger row');
  });

  test('-f overwrites the edited door with the rest of the plan', { skip: OLDER_SKIP }, () => {
    const c = cell('force');
    const door = installOlder(c);
    fs.appendFileSync(door, '# edited by hand\n');
    const updated = c.run(['update', 'proj', '-t', 'pi', '-f']);
    assert.equal(updated.status, 0, updated.output);
    assert.ok(updated.stdout.includes(`[INFO] claude: ${notice('claude')}`), updated.stdout);
    assertClaudeDoorsCurrent(c);
  });

  test('--dry-run lists the companion and writes nothing', { skip: OLDER_SKIP }, () => {
    const c = cell('dry');
    installOlder(c);
    const before = snapshot(c.scratch.dir);
    const dry = c.run(['update', 'proj', '-t', 'pi', '--dry-run']);
    assert.equal(dry.status, 0, dry.output);
    assert.ok(dry.stdout.includes(`[DRY]   claude: ${notice('claude')}`), dry.stdout);
    assert.deepEqual(snapshot(c.scratch.dir), before);
  });

  test('rollback restores the doors and the tree together', { skip: OLDER_SKIP }, () => {
    const c = cell('rollback');
    installOlder(c);
    const guarded = (files) => ({ ...under(files, '.claude/hooks'), ...under(files, '.doflow/shared/hooks') });
    const before = guarded(snapshot(c.proj));
    const updated = c.run(['update', 'proj', '-t', 'pi']);
    assert.equal(updated.status, 0, updated.output);
    const moved = Object.keys(before).filter((rel) => guarded(snapshot(c.proj))[rel] !== before[rel]);
    assert.ok(moved.some((rel) => rel.startsWith('.claude/hooks')) && moved.some((rel) => rel.startsWith('.doflow/shared/hooks')), 'the update moved doors and tree');
    const bid = updated.output.match(/Backup created: (\S+)/)?.[1];
    assert.ok(bid, updated.output);

    // Files the update created stay (a rollback restores what the backup holds); every file that
    // was there before is back to its old bytes, doors and tree alike.
    const rolled = c.run(['rollback', bid, '-f'], { cwd: c.proj });
    assert.equal(rolled.status, 0, rolled.output);
    const after = guarded(snapshot(c.proj));
    for (const rel of Object.keys(before)) assert.equal(after[rel], before[rel], `${rel} is not restored`);
  });

  test('a lifecycle at project scope plans nothing at user scope', { skip: OLDER_SKIP }, () => {
    const c = cell('scope');
    // pi at project scope and claude at user scope, both on the older bytes.
    assert.equal(c.run(['install', 'proj', '-f', '--no-backup', '-t', 'pi'], { cli: olderCli }).status, 0);
    assert.equal(c.run(['install', '-g', '-f', '--no-backup', '-t', 'claude'], { cli: olderCli }).status, 0);
    const doors = under(snapshot(c.home), '.claude/hooks');
    assert.ok(Object.keys(doors).length > 0);
    const updated = c.run(['update', 'proj', '-t', 'pi']);
    assert.equal(updated.status, 0, updated.output);
    assert.ok(!updated.output.includes('hook front doors'), updated.output);
    assert.deepEqual(under(snapshot(c.home), '.claude/hooks'), doors);
  });

  test('remove never refreshes another harness', { skip: SKIP }, () => {
    const c = cell('remove');
    assert.equal(c.run(['install', 'proj', '-f', '--no-backup', '-t', 'claude,pi']).status, 0);
    const door = path.join(c.proj, '.claude', 'hooks', 'pre-implement-gate.sh');
    fs.rmSync(door);
    const dry = c.run(['remove', 'proj', '-t', 'pi', '--dry-run']);
    assert.equal(dry.status, 0, dry.output);
    assert.ok(!dry.output.includes('hook front doors'), dry.output);
    const removed = c.run(['remove', 'proj', '-t', 'pi', '-f']);
    assert.equal(removed.status, 0, removed.output);
    assert.ok(!removed.output.includes('hook front doors'), removed.output);
    assert.equal(fs.existsSync(door), false, 'a removal does not put a door back');
  });

  test('only the doors move: another file of the same harness that is out of step stays as it is', { skip: SKIP }, () => {
    const c = cell('restricted');
    assert.equal(c.run(['install', 'proj', '-f', '--no-backup', '-t', 'claude,pi']).status, 0);
    const door = path.join(c.proj, '.claude', 'hooks', 'pre-implement-gate.sh');
    const skills = path.join(c.proj, '.claude', 'skills');
    const skill = path.join(skills, fs.readdirSync(skills)[0], 'SKILL.md');
    assert.ok(fs.existsSync(skill));
    fs.rmSync(door);
    fs.rmSync(skill);
    fs.rmSync(path.join(c.proj, '.doflow', 'shared', 'hooks', 'policies', 'lib.sh'));
    const updated = c.run(['update', 'proj', '-t', 'pi']);
    assert.equal(updated.status, 0, updated.output);
    assert.ok(updated.stdout.includes(`[INFO] claude: ${notice('claude')}`), updated.stdout);
    assert.ok(fs.existsSync(door), 'the door is back');
    assert.equal(fs.existsSync(skill), false, 'a skill is not a door; this run did not name claude');
  });

  // DEC-034 is about install and update. A read-only verb restricted to pi (status, reconcile and the
  // inventory all read their plan through the same view) plans exactly pi, however stale claude's doors are.
  test('inventory, status and reconcile restricted to pi plan no companion; install and update do', { skip: OLDER_SKIP }, () => {
    const c = cell('operations');
    installOlder(c);
    const registry = loadRegistry({ repoRoot: REPO });
    const scope = { global: false, projectRoot: c.proj };
    const view = (operation) => registryLifecycleView({ registry, repoRoot: REPO, scope, targets: ['pi'], operation });
    const harnesses = (plan) => plan.targets.map((target) => target.harness).sort();
    c.scratch.apply();
    try {
      assert.deepEqual(harnesses(readScopes({ registry, repoRoot: REPO, projectRoot: c.proj, targets: ['pi'], locks: { global: null, project: null } }).project.plan), ['pi'], 'inventory');
      assert.deepEqual(harnesses(view(undefined).plan), ['pi'], 'status and reconcile build the view with no operation');
      assert.deepEqual(harnesses(view('verify').plan), ['pi'], 'any other operation');
      assert.deepEqual(harnesses(view('update').plan), ['claude', 'pi'], 'update');
      assert.deepEqual(harnesses(view('install').plan), ['claude', 'pi'], 'install');
    } finally {
      c.scratch.restore();
    }
  });

  test('`install -t pi` refreshes the claude doors too', { skip: OLDER_SKIP }, () => {
    const c = cell('install-companion');
    installOlder(c);
    const installed = c.run(['install', 'proj', '-f', '--no-backup', '-t', 'pi']);
    assert.equal(installed.status, 0, installed.output);
    assert.ok(installed.stdout.includes(`[INFO] claude: ${notice('claude')}`), installed.stdout);
    assertClaudeDoorsCurrent(c);
  });

  // Every hook front-door component of IC-037, one harness each: its door is made out of step in the
  // way that harness's adapter can see (a missing file, or an absent `hooks` key for Gemini), the
  // shared tree is made to change, and an update naming another harness has to bring the door back.
  const DOORS = [
    { harness: 'claude', via: 'pi', spoil: (p) => fs.rmSync(path.join(p, '.claude', 'hooks', 'pre-implement-gate.sh')),
      back: (p) => fs.existsSync(path.join(p, '.claude', 'hooks', 'pre-implement-gate.sh')) },
    { harness: 'codex', via: 'pi', spoil: (p) => fs.rmSync(path.join(p, '.codex', 'hooks.json')),
      back: (p) => fs.existsSync(path.join(p, '.codex', 'hooks.json')) },
    { harness: 'gemini', via: 'pi', spoil: (p) => {
      const file = path.join(p, '.gemini', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete settings.hooks;
      fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    }, back: (p) => Boolean(JSON.parse(fs.readFileSync(path.join(p, '.gemini', 'settings.json'), 'utf8')).hooks) },
    { harness: 'kiro', via: 'pi',
      spoil: (p) => { fs.rmSync(path.join(p, '.kiro', 'hooks', 'pre-implement-gate.sh')); fs.rmSync(path.join(p, '.kiro', 'agents', 'doflow.json')); },
      back: (p) => fs.existsSync(path.join(p, '.kiro', 'hooks', 'pre-implement-gate.sh')) && fs.existsSync(path.join(p, '.kiro', 'agents', 'doflow.json')) },
    { harness: 'antigravity', via: 'pi', spoil: (p) => fs.rmSync(path.join(p, '.agents', 'hooks', 'pre-implementation-gate.sh')),
      back: (p) => fs.existsSync(path.join(p, '.agents', 'hooks', 'pre-implementation-gate.sh')) },
    { harness: 'pi', via: 'claude', spoil: (p) => fs.rmSync(path.join(p, '.pi', 'extensions', 'doflow-guard.js')),
      back: (p) => fs.existsSync(path.join(p, '.pi', 'extensions', 'doflow-guard.js')) },
  ];
  for (const { harness, via, spoil, back } of DOORS) {
    test(`${harness}: an out-of-step door is refreshed by \`update -t ${via}\`, with one notice, under --dry-run first`, { skip: SKIP }, () => {
      const c = cell(`door-${harness}`);
      const installed = c.run(['install', 'proj', '-f', '--no-backup', '-t', `${harness},${via}`]);
      assert.equal(installed.status, 0, installed.output);
      spoil(c.proj);
      assert.equal(back(c.proj), false, 'the door is out of step');
      fs.rmSync(path.join(c.proj, '.doflow', 'shared', 'hooks', 'policies', 'lib.sh'));

      const before = snapshot(c.scratch.dir);
      const dry = c.run(['update', 'proj', '-t', via, '--dry-run']);
      assert.equal(dry.status, 0, dry.output);
      assert.equal(dry.stdout.split('\n').filter((line) => line.includes('hook front doors')).join('\n'), `[DRY]   ${harness}: ${notice(harness)}`, dry.stdout);
      assert.deepEqual(snapshot(c.scratch.dir), before);

      const updated = c.run(['update', 'proj', '-t', via]);
      assert.equal(updated.status, 0, updated.output);
      assert.equal(updated.stdout.split('\n').filter((line) => line.includes('hook front doors')).join('\n'), `[INFO] ${harness}: ${notice(harness)}`, updated.stdout);
      assert.equal(back(c.proj), true, 'the door is back');
      assert.ok(ledgerRows(c.proj).some((row) => row.harness === harness), `${harness} keeps its ledger rows`);
    });
  }
});
