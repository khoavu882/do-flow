'use strict';
// 079 review X2/X18: `retrieve` keeps its search root and its state root apart in a linked worktree, guidance
// retrieval keeps its pre-079 dispatch, and an unknown --scope is a usage error.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { readPlan } = require('../../src/runtime/retrieval-record.ts');

const BIN = path.resolve(__dirname, '../../bin/doflow.js');
const SLUG = '931-roots';

/** A main checkout holding the feature folder, a linked worktree on the feature branch with a file only it has,
 * and a guidance tree reached through DOFLOW_CONFIG_DIR so nothing reads the home install. */
function linkedWorld(t) {
  const base = fs.realpathSync(tempDir(t, 'doflow-retrieve-roots-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', DOFLOW_CONFIG_DIR: path.join(base, 'config') };
  delete env.FORCE_COLOR;
  const git = (cwd, ...args) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  const main = path.join(base, 'm');
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  fs.writeFileSync(path.join(main, 'src', 'a.js'), 'const rootsLiteral = 1;\n');
  fs.writeFileSync(path.join(main, '.gitignore'), 'agent-docs/\n.doflow/\n');
  git(main, 'init', '-q', '-b', 'main'); git(main, 'add', '-A'); git(main, 'commit', '-q', '-m', 'init');
  for (const [rel, body] of [['intention/requirement.md', '# r\n'], ['design/design.md', '# d\n'], ['plan.md', '- [ ] A.1 x — owner: x; files: src/a.js\n']]) {
    const file = path.join(main, 'agent-docs', 'doflow', SLUG, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body);
  }
  const wt = path.join(base, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', `feat/${SLUG}`, wt);
  fs.writeFileSync(path.join(wt, 'src', 'wt-only.js'), 'rootsLiteral();\n');
  fs.mkdirSync(path.join(env.DOFLOW_CONFIG_DIR, 'guidance'), { recursive: true });
  fs.writeFileSync(path.join(env.DOFLOW_CONFIG_DIR, 'guidance', 'routing.md'), '# Routing\n\nRouting guidance for retrieval roots.\n');
  const doflow = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: wt, env, encoding: 'utf8' });
  return { main, wt, doflow };
}

const NOTE = /records are kept in the main checkout/;
const files = (out) => JSON.parse(out.stdout).results.map((r) => r.locator.file).sort();

test('bound code retrieve in a linked worktree searches the worktree and keeps the main checkout as the state root', (t) => {
  const { main, wt, doflow } = linkedWorld(t);
  const slugged = doflow('retrieve', '--scope', 'code', '--query', 'rootsLiteral', '--slug', SLUG, '--json');
  assert.equal(slugged.status, 0, slugged.stderr);
  assert.equal(JSON.parse(slugged.stdout).root, wt, '--slug routes state, not the search');
  assert.deepEqual(files(slugged), ['src/a.js', 'src/wt-only.js']);
  assert.match(slugged.stderr, NOTE, 'the state still lives in the main checkout');

  const declared = doflow('retrieval-plan', '--action', 'declare', '--task-id', 'A.1', '--need', 'locate-known-symbol', '--json');
  assert.equal(declared.status, 0, declared.stderr + declared.stdout);
  const bound = doflow('retrieve', '--scope', 'code', '--query', 'rootsLiteral', '--task-id', 'A.1', '--need', 'locate-known-symbol', '--json');
  assert.equal(bound.status, 0, bound.stderr + bound.stdout);
  const response = JSON.parse(bound.stdout);
  assert.equal(response.root, wt, '--task-id routes state, not the search');
  assert.deepEqual(files(bound), ['src/a.js', 'src/wt-only.js']);
  // A found answer records nothing (RETRIEVED derives from evidence); an empty one records EMPTY, which shows where state goes.
  const empty = doflow('retrieve', '--scope', 'code', '--query', 'noSuchRootsLiteral', '--task-id', 'A.1', '--need', 'locate-known-symbol', '--json');
  assert.equal(empty.status, 0, empty.stderr + empty.stdout);
  const plan = readPlan(main, 'A.1', SLUG);
  assert.deepEqual((plan.needs[0].attempts || []).map((a) => [a.provider, a.status]), [['native.rg', 'EMPTY']], 'the attempt is recorded in the main checkout store');
  assert.equal(readPlan(wt, 'A.1', SLUG), null, 'nothing is recorded in the worktree');
});

test('guidance retrieve in a linked worktree keeps the pre-079 dispatch, bound or not: no routing, no note', (t) => {
  const { doflow } = linkedWorld(t);
  for (const extra of [[], ['--slug', SLUG], ['--slug', 'no-such-feature'], ['--task-id', 'A.1']]) {
    const out = doflow('retrieve', '--query', 'routing guidance', ...extra, '--json');
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stderr, '', `no note on stderr for ${extra.join(' ') || 'an unbound call'}`);
    const body = JSON.parse(out.stdout);
    assert.deepEqual(Object.keys(body), ['query', 'results']);
    assert.equal(body.results[0].path, 'routing.md');
  }
  const scoped = doflow('retrieve', '--scope', 'guidance', '--query', 'routing guidance', '--json');
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.equal(JSON.parse(scoped.stdout).results[0].path, 'routing.md', '--scope guidance is the default spelled out');
});

test('an unknown --scope is a usage error (exit 2) naming the valid scopes, and runs nothing', (t) => {
  const { doflow } = linkedWorld(t);
  const json = doflow('retrieve', '--scope', 'cdoe', '--query', 'routing guidance', '--json');
  assert.equal(json.status, 2, json.stdout);
  const body = JSON.parse(json.stdout);
  assert.deepEqual([body.error, body.exitCode], ['usage', 2]);
  assert.match(body.summary, /--scope must be guidance or code, got 'cdoe'/);
  const plain = doflow('retrieve', '--scope', 'cdoe', '--query', 'routing guidance');
  assert.equal(plain.status, 2);
  assert.equal(plain.stdout, '');
  assert.match(plain.stderr, /--scope must be guidance or code/);
});
