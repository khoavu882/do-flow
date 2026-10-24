'use strict';
// 115 C-2 and C-8. `context-emit` keeps its delivery record where `context-pack` keeps it: in the
// main checkout's store from a linked worktree, under the feature's namespace, never in the worktree
// (a `git worktree remove` would delete it). `plan-check` is read-only: it runs no storage upkeep, so
// it creates neither `.gitignore` nor `.doflow/state/upkeep-due` and changes no state already there.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');

const BIN = path.resolve(__dirname, '../../bin/doflow.js');
const LAUNCHED: any = { DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'w1', DOFLOW_ATTEMPT: '1', DOFLOW_SESSION_ROLE: 'worker' };
const SLUG = '945-emit';

function world(t: any) {
  const base = fs.realpathSync(tempDir(t, 'doflow-context-emit-redirect-'));
  const env: any = { HOME: base, XDG_CONFIG_HOME: path.join(base, 'config'), PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || '/tmp', GIT_CONFIG_GLOBAL: '/dev/null' };
  if (process.env.NODE_COMPILE_CACHE) env.NODE_COMPILE_CACHE = process.env.NODE_COMPILE_CACHE;
  const git = (cwd: any, ...args: any[]) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  const main = path.join(base, 'm');
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  fs.writeFileSync(path.join(main, 'src', 'a.js'), 'const x = 1;\n');
  fs.writeFileSync(path.join(main, '.gitignore'), 'agent-docs/\n.doflow/\n');
  git(main, 'init', '-q', '-b', 'main'); git(main, 'add', '-A'); git(main, 'commit', '-q', '-m', 'init');
  const wt = path.join(base, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', `feat/${SLUG}`, wt);
  const folder = path.join(wt, 'agent-docs', 'doflow', SLUG);
  fs.mkdirSync(path.join(folder, 'intention'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'intention', 'requirement.md'), '# Requirement\n\n## Summary\n\nEmit objective.\n');
  const run = (cwd: any, args: any, extra: any = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  return { base, main, wt, run };
}

/** Every file under a directory, relative to it; [] when it does not exist. */
function filesUnder(dir: any) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).filter((rel: any) => fs.statSync(path.join(dir, rel)).isFile()).sort();
}

test('context-emit from a linked worktree records its delivery in the main checkout, never in the worktree', (t) => {
  const { main, wt, run } = world(t);
  const emitted = run(wt, ['context-emit', '--event', 'launch', '--cwd', wt, '--task-id', 'A.1', '--json'], LAUNCHED);
  assert.equal(emitted.status, 0, emitted.stderr);
  const out = JSON.parse(emitted.stdout);
  assert.match(out.pack.packDigest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(out.text.includes('Emit objective.'), 'the pack reads the worktree\'s feature folder');
  assert.ok(!fs.existsSync(path.join(wt, '.doflow', 'state', 'delivery')), 'no delivery record in the worktree');
  const delivery = path.join(main, '.doflow', 'state', 'delivery', SLUG, 'A.1.json');
  assert.equal(JSON.parse(fs.readFileSync(delivery, 'utf8')).deliveries[0].packDigest, out.pack.packDigest);
  assert.equal(emitted.stderr, '', 'context-emit prints no redirect note');
});

test('plan-check runs no upkeep: an existing state is left as it was, and no .gitignore or upkeep-due appears', (t) => {
  const { base, run } = world(t);
  const project = path.join(base, 'p');
  fs.mkdirSync(path.join(project, '.doflow', 'state', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(project, '.doflow', 'state', 'evidence', 'A.1.json'), '{"taskId":"A.1"}\n');
  fs.writeFileSync(path.join(project, 'plan.md'), '# Plan\n\n- [ ] A.1 [US1] task — owner: x; files: src/a.js\n');
  const before = filesUnder(project).map((rel: any) => [rel, fs.readFileSync(path.join(project, rel), 'utf8')]);
  const res = run(project, ['plan-check', 'plan.md', '--json']);
  assert.ok([0, 1].includes(res.status), `${res.status}: ${res.stderr}`);
  assert.deepEqual(filesUnder(project).map((rel: any) => [rel, fs.readFileSync(path.join(project, rel), 'utf8')]), before, 'nothing was written');
  assert.ok(!fs.existsSync(path.join(project, '.gitignore')));
  assert.ok(!fs.existsSync(path.join(project, '.doflow', 'state', 'upkeep-due')));
});
