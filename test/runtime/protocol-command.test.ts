'use strict';

// Feature 119 A.5 (IC-004): the read-only `doflow protocol` verb through `bin/doflow.js`, in a scratch HOME
// and a scratch project directory.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');

function scratch(t: any) {
  const dir = tempDir(t, 'doflow-protocol-cli-');
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(home);
  // A project that already keeps DoFlow state is where upkeep would write its ignore file and marker.
  fs.mkdirSync(path.join(cwd, '.doflow', 'state'), { recursive: true });
  const env: any = {
    ...process.env,
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    FORCE_COLOR: '', DOFLOW_CLI: CLI, DOFLOW_TELEMETRY: 'off',
  };
  delete env.DOFLOW_CONFIG_DIR;
  const cli = (args: any) => spawnSync(process.execPath, [CLI, 'protocol', ...args], { cwd, env, encoding: 'utf8' });
  return { root: dir, cwd, cli };
}

/** Every entry under `root` (directories too), as relative path -> content or null for a directory. */
function snapshot(root: any, base: any = root, out: any = {}) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) { out[`${rel}/`] = null; snapshot(full, base, out); }
    else out[rel] = fs.readFileSync(full, 'latin1');
  }
  return out;
}

test('resolve --kind debate prints debate-2: two rounds, decided by the orchestrator', (t) => {
  const s = scratch(t);
  const res = s.cli(['--action', 'resolve', '--kind', 'debate']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^protocol: id=debate-2 rounds=2 crossAnswer=true synthesizer=none decider=orchestrator /m);
  assert.match(res.stdout, /^protocol\.origins: id=registry /m);
  const json = JSON.parse(s.cli(['--action', 'resolve', '--kind', 'debate', '--json']).stdout);
  assert.equal(json.ok, true);
  assert.equal(json.protocol.id, 'debate-2');
  assert.equal(json.protocol.rounds, 2);
  assert.equal(json.protocol.decider, 'orchestrator');
});

test('resolve --kind review prints the enforcement line and carries the rows; a debate has none', (t) => {
  const s = scratch(t);
  const res = s.cli(['--action', 'resolve', '--kind', 'review']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^protocol\.enforcement: reviewer native=claude,gemini,opencode,copilot,kiro unenforced=codex,pi,antigravity$/m);
  const json = JSON.parse(s.cli(['--action', 'resolve', '--kind', 'review', '--json']).stdout);
  assert.equal(json.protocol.enforcement.length, 8);
  assert.deepEqual(json.protocol.enforcement.filter((row: any) => row.status === 'unenforced').map((row: any) => row.harness), ['codex', 'pi', 'antigravity']);
  const debate = JSON.parse(s.cli(['--action', 'resolve', '--kind', 'debate', '--json']).stdout);
  assert.deepEqual(debate.protocol.enforcement, []);
  assert.doesNotMatch(s.cli(['--action', 'resolve', '--kind', 'debate']).stdout, /protocol\.enforcement/);
});

test('resolve reads the project settings: a project debate.preset debate-3 prints debate-3 with origin project', (t) => {
  const s = scratch(t);
  fs.writeFileSync(path.join(s.cwd, '.doflow', 'settings.json'), JSON.stringify({ schema: 1, 'debate.preset': 'debate-3' }));
  const res = s.cli(['--action', 'resolve', '--kind', 'debate']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^protocol: id=debate-3 rounds=3 /m);
  assert.match(res.stdout, /^protocol\.origins: id=project /m);
  const json = JSON.parse(s.cli(['--action', 'resolve', '--kind', 'debate', '--json']).stdout);
  assert.equal(json.protocol.id, 'debate-3');
  assert.equal(json.protocol.origins.id, 'project');
  assert.deepEqual(json.protocol.disagreements, []);
});

test('resolve --kind review prints the rule values and each project blocker clause; a debate prints neither (C-5)', (t) => {
  const s = scratch(t);
  fs.writeFileSync(path.join(s.cwd, '.doflow', 'settings.json'), JSON.stringify({ schema: 1, 'review.blockerClauses': ['no new dependency'], 'review.sameFamily': 'refuse' }));
  const res = s.cli(['--action', 'resolve', '--kind', 'review']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^protocol\.rules: sameFamily=refuse crossFamilyRereview=on$/m);
  assert.match(res.stdout, /^protocol\.blocker: no new dependency$/m);
  const debate = s.cli(['--action', 'resolve', '--kind', 'debate']);
  assert.doesNotMatch(debate.stdout, /protocol\.rules|protocol\.blocker/);
});

test('C-11: resolve --kind debate prints only the invariants that apply to a debate, and the origin of a set preset', (t) => {
  const s = scratch(t);
  assert.match(s.cli(['--action', 'resolve', '--kind', 'debate']).stdout, /^protocol\.invariants: INV-6,INV-7$/m);
  assert.match(s.cli(['--action', 'resolve', '--kind', 'review']).stdout, /^protocol\.invariants: INV-1,INV-2,INV-3,INV-4,INV-5,INV-6,INV-7,INV-8$/m);
  fs.writeFileSync(path.join(s.cwd, '.doflow', 'settings.json'), JSON.stringify({ schema: 1, 'debate.preset': 'debate-2' }));
  assert.match(s.cli(['--action', 'resolve', '--kind', 'debate']).stdout, /^protocol\.origins: id=project /m);
});

test('resolve --kind debate --preset debate-3 prints three rounds and the verifier as synthesizer', (t) => {
  const s = scratch(t);
  const res = s.cli(['--action', 'resolve', '--kind', 'debate', '--preset', 'debate-3', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const { protocol } = JSON.parse(res.stdout);
  assert.equal(protocol.id, 'debate-3');
  assert.equal(protocol.rounds, 3);
  assert.equal(protocol.synthesizer, 'verifier');
  assert.equal(protocol.origins.id, 'run');
});

test('resolve --kind review has no diff, so the scope is unknown and the protocol is the deep one; --task-class sets the floor', (t) => {
  const s = scratch(t);
  const plain = JSON.parse(s.cli(['--action', 'resolve', '--kind', 'review', '--json']).stdout);
  assert.equal(plain.protocol.id, 'review-deep');
  assert.equal(plain.protocol.origins.id, 'risk');
  const low = JSON.parse(s.cli(['--action', 'resolve', '--kind', 'review', '--risk', 'LOW', '--task-class', 'feature', '--json']).stdout);
  assert.equal(low.protocol.id, 'review-deep');
  assert.ok(low.protocol.seats.length >= 2);
});

test('list --json names all four presets and INV-1..INV-7', (t) => {
  const s = scratch(t);
  const res = s.cli(['--action', 'list', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.presets.map((p: any) => p.id), ['review-deep', 'review-single', 'debate-3', 'debate-2']);
  assert.deepEqual(out.invariants.map((i: any) => i.id), ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5', 'INV-6', 'INV-7', 'INV-8']);
  const byKind = JSON.parse(s.cli(['--action', 'list', '--kind', 'debate', '--json']).stdout);
  assert.deepEqual(byKind.presets.map((p: any) => p.id), ['debate-3', 'debate-2']);
  const text = s.cli(['--action', 'list']);
  assert.equal(text.status, 0, text.stderr);
  for (const id of ['review-deep', 'review-single', 'debate-3', 'debate-2', 'INV-1', 'INV-7', 'INV-8']) assert.ok(text.stdout.includes(id), id);
});

test('a looser preset than the protocol needs is refused with exit 1', (t) => {
  const s = scratch(t);
  const res = s.cli(['--action', 'resolve', '--kind', 'review', '--task-class', 'feature', '--preset', 'review-single']);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stdout, /preset-looser/);
  const json = JSON.parse(s.cli(['--action', 'resolve', '--kind', 'review', '--task-class', 'feature', '--preset', 'review-single', '--json']).stdout);
  assert.equal(json.ok, false);
  assert.equal(json.error, 'preset-looser');
});

test('an unknown preset, and a preset of the other kind, is refused with exit 1', (t) => {
  const s = scratch(t);
  const unknown = s.cli(['--action', 'resolve', '--kind', 'review', '--preset', 'nope']);
  assert.equal(unknown.status, 1, unknown.stderr);
  assert.match(unknown.stdout, /preset-unknown/);
  const other = s.cli(['--action', 'resolve', '--kind', 'review', '--preset', 'debate-2']);
  assert.equal(other.status, 1, other.stderr);
  assert.match(other.stdout, /preset-unknown/);
});

test('usage errors exit 2', (t) => {
  const s = scratch(t);
  const bad: any = [
    [],
    ['--action', 'nope'],
    ['--action'],
    ['--action', 'resolve'],
    ['--action', 'resolve', '--kind', 'nope'],
    ['--action', 'resolve', '--kind'],
    ['--action', 'resolve', '--kind', 'review', '--task-class', 'nope'],
    ['--action', 'resolve', '--kind', 'review', '--task-class'],
    ['--action', 'resolve', '--kind', 'review', '--risk', 'SEVERE'],
    ['--action', 'resolve', '--kind', 'review', '--preset', ''],
    ['--action', 'resolve', '--kind', 'review', '--preset', 'Bad Id'],
    ['--action', 'list', '--kind', 'nope'],
    ['--action', 'list', '--preset', 'review-deep'],
  ];
  for (const args of bad) {
    const res = s.cli(args);
    assert.equal(res.status, 2, `${args.join(' ')}: status ${res.status}, stdout ${res.stdout}, stderr ${res.stderr}`);
  }
  const json = JSON.parse(s.cli(['--action', 'nope', '--json']).stdout);
  assert.equal(json.ok, false);
  assert.equal(json.error, 'usage');
});

test('the verb writes nothing: no project file, no .doflow entry, nothing in HOME', (t) => {
  const s = scratch(t);
  const before = snapshot(s.root);
  for (const args of [
    ['--action', 'list'],
    ['--action', 'resolve', '--kind', 'debate'],
    ['--action', 'resolve', '--kind', 'review', '--task-class', 'feature', '--json'],
    ['--action', 'resolve', '--kind', 'review', '--task-class', 'feature', '--preset', 'review-single'],
  ]) s.cli(args);
  assert.deepEqual(snapshot(s.root), before);
});
