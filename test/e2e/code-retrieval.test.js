'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { spawnSync } = require('node:child_process');

const BIN = path.resolve(__dirname, '../../bin/doflow.js');

function fixture(t) {
  const root = tempDir(t, 'doflow-code-retrieve-cli-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/auth.js'), 'function parseToken() { return true; }\n');
  return root;
}

test('retrieve --scope code exposes the versioned exact response and root-bound live snippet', (t) => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [BIN, 'retrieve', '--scope', 'code', '--root', root,
    '--query', 'parseToken', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.schemaVersion, 1);
  assert.equal(response.scope, 'code');
  assert.equal(response.queryClass, 'exact');
  assert.equal(response.effectiveProfile, 'lexical-only');
  assert.equal(response.results[0].locator.file, 'src/auth.js');
  assert.match(response.results[0].snippet, /function parseToken/);
  assert.equal(response.absenceEstablished, false);
});

test('invalid task binding exits 2 before code retrieval and guidance remains the default help contract', (t) => {
  const root = fixture(t);
  const invalid = spawnSync(process.execPath, [BIN, 'retrieve', '--scope', 'code', '--root', root,
    '--query', 'parseToken', '--task-id', 'missing-task', '--need', 'missing-need', '--json'],
  { cwd: root, encoding: 'utf8' });
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.equal(JSON.parse(invalid.stdout).error, 'invalid-task-binding');
  const help = spawnSync(process.execPath, [BIN, '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /BM25 guidance search by default/);
});

// R5: unbound code retrieval in a linked worktree skips feature-store routing; --task-id or --slug keeps it.
test('unbound retrieve --scope code in a linked worktree searches the worktree without feature-store routing; --slug keeps the routing', (t) => {
  const base = fs.realpathSync(tempDir(t, 'doflow-code-retrieve-wt-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.FORCE_COLOR;
  const git = (cwd, ...args) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  const main = path.join(base, 'm');
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  fs.writeFileSync(path.join(main, 'src', 'a.js'), 'const routedLiteral = 1;\n');
  fs.writeFileSync(path.join(main, '.gitignore'), 'agent-docs/\n.doflow/\n');
  git(main, 'init', '-q', '-b', 'main'); git(main, 'add', '-A'); git(main, 'commit', '-q', '-m', 'init');
  for (const [rel, body] of [['intention/requirement.md', '# r\n'], ['design/design.md', '# d\n'], ['plan.md', '- [ ] A.1 x — owner: x; files: src/a.js\n']]) {
    const file = path.join(main, 'agent-docs', 'doflow', '930-wt', rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body);
  }
  git(main, 'worktree', 'add', '-q', '-b', 'feat/930-wt', path.join(base, 'wt'));
  const wt = path.join(base, 'wt');
  fs.writeFileSync(path.join(wt, 'src', 'wt-only.js'), 'routedLiteral();\n');
  const retrieve = (...extra) => spawnSync(process.execPath, [BIN, 'retrieve', '--scope', 'code', '--query', 'routedLiteral', ...extra, '--json'], { cwd: wt, env, encoding: 'utf8' });

  const unbound = retrieve();
  assert.equal(unbound.status, 0, unbound.stderr);
  assert.doesNotMatch(unbound.stderr, /records are kept in the main checkout/);
  const response = JSON.parse(unbound.stdout);
  assert.equal(response.root, wt, 'the worktree is searched, not the main checkout');
  assert.deepEqual(response.results.map((r) => r.locator.file).sort(), ['src/a.js', 'src/wt-only.js']);

  const slugged = retrieve('--slug', '930-wt');
  assert.equal(slugged.status, 0, slugged.stderr);
  assert.match(slugged.stderr, /records are kept in the main checkout/, 'an explicit --slug keeps feature-store routing');
});

// X3: an unstaged tracked delete is an admission coverage gap, never a lexical provider-error.
test('retrieve --scope code with an unstaged tracked delete reports an admission gap and no provider-error', (t) => {
  const root = fs.realpathSync(tempDir(t, 'doflow-code-retrieve-x3-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.FORCE_COLOR;
  const git = (...args) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: root, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/auth.js'), 'function parseToken() { return true; }\n');
  fs.writeFileSync(path.join(root, 'src/gone.js'), 'parseToken();\n');
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'init');
  fs.unlinkSync(path.join(root, 'src/gone.js'));
  const result = spawnSync(process.execPath, [BIN, 'retrieve', '--scope', 'code', '--root', root, '--query', 'parseToken', '--json'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.deepEqual(response.results.map((r) => r.locator.file), ['src/auth.js']);
  assert.deepEqual(response.gaps, [{ source: 'admission', reason: 'source-unreadable', count: 1 }]);
  assert.equal(response.coverage.complete, false);
  assert.equal(response.attempts[0].reason, undefined, 'native.rg is not marked provider-error');
});
