'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { spawnSync, execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const registry = require('../../core/registry/storage.json');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { EVENTS_REL } = require('../../src/runtime/lifecycle/event-store.ts');
const { MARKER_REL } = require('../../src/runtime/lifecycle/store-upkeep.ts');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const TREE_IDS: any = ['project-state', 'user-state', 'config-home'];
const SNAPSHOT_ROOT_IDS: any = [...TREE_IDS, 'linked-doflow'];
const STAGES_TO_GATE: any = ['discovery'];
const DAY = 24 * 60 * 60 * 1000;

function fixture(t: any) {
  const dir = tempDir(t, 'doflow-console-read-contract-');
  const main = path.join(dir, 'main');
  const linked = path.join(dir, 'linked');
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  const gitConfig = path.join(dir, 'gitconfig');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  fs.writeFileSync(gitConfig, '');

  const env: any = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    DOFLOW_TELEMETRY: 'off',
    DOFLOW_RETENTION_HOURS: '1',
  };
  delete env.DOFLOW_UPKEEP;
  delete env.FORCE_COLOR;

  fs.mkdirSync(main, { recursive: true });
  fs.writeFileSync(path.join(main, 'README.md'), 'console read contract fixture\n');
  const slugs: any = ['console-main-feature', 'console-linked-feature', 'console-other-feature'];
  for (const slug of slugs) {
    const featureDir = path.join(main, 'agent-docs', 'doflow', slug);
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(path.join(featureDir, 'requirement.md'), `# ${slug}\n`);
  }

  const git = (...args: any[]) => execFileSync('git', ['-C', main, ...args], { env, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'console-read-contract@example.test');
  git('config', 'user.name', 'Console Read Contract');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  git('worktree', 'add', '-q', '-b', 'console-read-contract-linked', linked, 'HEAD');

  const linkedDoflow = path.join(linked, '.doflow');
  fs.mkdirSync(linkedDoflow, { recursive: true });

  const roots = resolveRoots({ registry, projectRoot: main, env });
  assert.equal(path.resolve(roots['project-state']), path.join(main, '.doflow', 'state'));
  roots['linked-doflow'] = linkedDoflow;
  for (const id of TREE_IDS) {
    assert.ok(roots[id], `${id} root should resolve with the fixture environment`);
    fs.mkdirSync(roots[id], { recursive: true });
    fs.writeFileSync(path.join(roots[id], `fixture-${id}.txt`), `${id} exists\n`);
  }
  return { dir, main, linked, env, roots, slugs };
}

function runCli(cwd: any, args: any, env: any) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
}

function runJson(cwd: any, args: any, env: any) {
  const result = runCli(cwd, args, env);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error: any) {
    assert.fail(`${args.join(' ')} did not print JSON: ${error.message}\n${result.stdout}`);
  }
}

function completeToGate(cwd: any, env: any, taskId: any, slug: any) {
  runJson(cwd, [
    'orchestrate', '--action', 'start', '--task-id', taskId, '--task-class', 'feature', '--slug', slug, '--json',
  ], env);
  let snapshot;
  for (const stage of STAGES_TO_GATE) {
    snapshot = runJson(cwd, [
      'orchestrate', '--action', 'complete-stage', '--task-id', taskId, '--stage', stage, '--slug', slug, '--json',
    ], env);
  }
  assert.equal(snapshot.state, 'AWAITING_GATE', `${taskId} should stop at the first approval gate`);
  assert.equal(snapshot.current.type, 'gate');
  return snapshot;
}

function writeEvent(folder: any, at: any, suffix: any, type: any, data: any) {
  fs.mkdirSync(folder, { recursive: true });
  const id = `${at.replace(/[-:.]/g, '')}-${suffix}`;
  fs.writeFileSync(path.join(folder, `${id}.json`), `${JSON.stringify({ v: 1, id, at, type, by: 'agent', data })}\n`);
}

function treeSnapshot(root: any) {
  const entries: any = {};
  const rootInfo = fs.lstatSync(root, { bigint: true });
  entries['.'] = {
    type: 'directory',
    mtimeNs: rootInfo.mtimeNs.toString(),
    ino: rootInfo.ino.toString(),
  };
  const visit = (dir: any) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      const info = fs.lstatSync(file, { bigint: true });
      if (info.isDirectory()) {
        entries[relative] = {
          type: 'directory',
          mtimeNs: info.mtimeNs.toString(),
          ino: info.ino.toString(),
        };
        visit(file);
      } else if (info.isFile()) {
        entries[relative] = {
          type: 'file',
          sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
          mtimeNs: info.mtimeNs.toString(),
          ino: info.ino.toString(),
        };
      } else if (info.isSymbolicLink()) {
        entries[relative] = {
          type: 'symlink',
          target: fs.readlinkSync(file),
          mtimeNs: info.mtimeNs.toString(),
        };
      } else {
        entries[relative] = { type: 'other', mode: info.mode };
      }
    }
  };
  visit(root);
  return entries;
}

function snapshotRoots(roots: any) {
  return Object.fromEntries(SNAPSHOT_ROOT_IDS.map((id: any) => [id, treeSnapshot(roots[id])]));
}

function readSet(cwd: any, env: any) {
  const list = runJson(cwd, ['orchestrate', '--action', 'list', '--json'], env);
  const statuses: any = new Map();
  for (const row of list.runs) {
    assert.ok(row.featureSlug, `run ${row.taskId} should have a feature slug`);
    const status = runJson(cwd, [
      'orchestrate', '--action', 'status', '--task-id', row.taskId, '--slug', row.featureSlug, '--json',
    ], env);
    statuses.set(`${row.featureSlug}\0${row.taskId}`, status);
  }
  for (const args of [['capabilities', '--json'], ['indicators', '--json'], ['--version']]) {
    const result = runCli(cwd, args, env);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  }
  return { list, statuses };
}

test('P1 CLI reads leave all DoFlow trees unchanged and list agrees with status across a linked worktree', t => {
  const f = fixture(t);
  const runs: any = [
    { taskId: 'console-main-run', slug: f.slugs[0], cwd: f.main },
    { taskId: 'console-linked-run', slug: f.slugs[1], cwd: f.linked },
  ];
  for (const run of runs) completeToGate(run.cwd, f.env, run.taskId, run.slug);

  const store = path.join('.doflow', 'state', 'orchestration');
  for (const run of runs) {
    const mainJournal = path.join(f.main, store, run.slug, `${run.taskId}.json`);
    assert.ok(fs.existsSync(mainJournal), `${run.taskId} should be stored in the main checkout`);
    if (run.cwd === f.linked) {
      assert.equal(fs.existsSync(path.join(f.linked, store, run.slug, `${run.taskId}.json`)), false);
    }
  }

  const otherTaskId = 'console-other-run';
  const otherSlug = f.slugs[2];
  const sourceJournal = path.join(f.main, store, runs[0].slug, `${runs[0].taskId}.json`);
  const otherJournal = JSON.parse(fs.readFileSync(sourceJournal, 'utf8'));
  otherJournal.taskId = otherTaskId;
  otherJournal.featureSlug = otherSlug;
  const otherFile = path.join(f.linked, store, otherSlug, `${otherTaskId}.json`);
  fs.mkdirSync(path.dirname(otherFile), { recursive: true });
  fs.writeFileSync(otherFile, `${JSON.stringify(otherJournal, null, 2)}\n`);

  const followup = runJson(f.main, [
    'followup', '--action', 'add', '--source', 'manual', '--statement', 'keep lifecycle store initialized', '--json',
  ], f.env);
  assert.equal(followup.ok, true);
  // Add prepares before its own event exists; the next lifecycle read marks the populated store.
  runJson(f.main, ['followup', '--action', 'list', '--json'], f.env);
  const marker = path.join(f.main, MARKER_REL);
  assert.ok(fs.existsSync(marker), 'followup add should create the lifecycle migration marker');

  const events = path.join(f.main, EVENTS_REL);
  writeEvent(events, '2020-01-01T00:00:00.000Z', '000000', 'followup.added', {
    id: 'FU-aaaaaa', statement: 'expired settled item', source: { kind: 'manual' },
  });
  writeEvent(events, '2020-01-01T00:01:00.000Z', '000001', 'followup.settled', {
    id: 'FU-aaaaaa', as: 'dismissed', reason: 'expired',
  });
  fs.rmSync(marker);

  const due = `${Math.floor((Date.now() - 365 * DAY) / 1000)}\n`;
  for (const id of TREE_IDS) fs.writeFileSync(path.join(f.roots[id], 'upkeep-due'), due);

  const switchOnEnv: any = { ...f.env, DOFLOW_UPKEEP: 'off' };
  const readsByCaller: any = [];
  for (const cwd of [f.main, f.linked]) {
    const before = snapshotRoots(f.roots);
    const reads = readSet(cwd, switchOnEnv);
    const after = snapshotRoots(f.roots);
    assert.deepEqual(after, before, `DOFLOW_UPKEEP=off read set changed a DoFlow tree from ${cwd}`);
    readsByCaller.push(reads);
  }

  for (const reads of readsByCaller) {
    const rows = reads.list.runs;
    assert.deepEqual(reads.list.unreadable, []);
    assert.deepEqual(rows.map((row: any) => row.taskId).sort(), [...runs.map((run: any) => run.taskId), otherTaskId].sort());
    for (const row of rows) {
      const status = reads.statuses.get(`${row.featureSlug}\0${row.taskId}`);
      assert.ok(status, `status should be collected for ${row.featureSlug}/${row.taskId}`);
      assert.equal(row.revision, status.revision, `${row.featureSlug}/${row.taskId} revision`);
      assert.equal(row.state, status.state, `${row.featureSlug}/${row.taskId} state`);
      assert.deepEqual(row.current, status.current, `${row.featureSlug}/${row.taskId} current`);
    }
    assert.equal(rows.find((row: any) => row.taskId === runs[0].taskId).origin, 'current');
    assert.equal(rows.find((row: any) => row.taskId === runs[1].taskId).origin, 'current');
    assert.equal(rows.find((row: any) => row.taskId === otherTaskId).origin, 'other');
  }

  const controlBefore = snapshotRoots(f.roots);
  readSet(f.main, f.env);
  const controlAfter = snapshotRoots(f.roots);
  const changedTrees = TREE_IDS.filter((id: any) => !isDeepStrictEqual(controlBefore[id], controlAfter[id]));
  assert.ok(changedTrees.length > 0,
    'Fixture is vacuous: the same read set without DOFLOW_UPKEEP=off changed none of the three trees');
});
