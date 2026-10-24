'use strict';

// IC-007: a relative locator.file is hashed in sourceRoot (the checkout the verb runs in), at write
// time and at check time; the store root is for records only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { measureFreshness, FreshnessValidator } = require('../../src/runtime/freshness.ts');
const { toEvidence } = require('../../src/runtime/candidate.ts');

const IDENT: any = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid'];

// main checkout (the store root) plus a linked worktree on another branch where src/a.js differs.
function pair(t: any) {
  const base = tempDir(t, 'doflow-freshness-source-root-');
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const env: any = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  const main = path.join(base, 'main');
  const wt = path.join(base, 'wt');
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  const git = (cwd: any, ...args: any[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'src', 'a.js'), 'module.exports = "main";\n');
  git(main, 'add', 'src/a.js');
  git(main, ...IDENT, 'commit', '-qm', 'initial');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
  fs.writeFileSync(path.join(wt, 'src', 'a.js'), 'module.exports = "worktree";\n');
  return { main, wt, git };
}

const locator: any = { file: 'src/a.js', line: 1 };
const hashOf = (root: any, file: any = 'src/a.js') =>
  `sha256:${require('node:crypto').createHash('sha256').update(fs.readFileSync(path.resolve(root, file))).digest('hex')}`;
const check = (item: any, opts: any) => new FreshnessValidator(opts).checkEvidenceFreshness(item).status;

test('measureFreshness hashes a relative locator in sourceRoot', (t) => {
  const { main, wt } = pair(t);
  const f = measureFreshness(main, locator, null, wt);
  assert.equal(f.fileHash, hashOf(wt));
  assert.notEqual(f.fileHash, hashOf(main));
});

test('omitted sourceRoot keeps today behaviour: the root argument is hashed', (t) => {
  const { main, wt } = pair(t);
  assert.equal(measureFreshness(main, locator, null).fileHash, hashOf(main));
  assert.equal(measureFreshness(wt, locator, null).fileHash, hashOf(wt));
  const item: any = { locator, freshness: measureFreshness(main, locator, null) };
  assert.equal(check(item, { repoRoot: main }), 'FRESH');
});

test('check against sourceRoot = worktree is FRESH; store root as sourceRoot is STALE (negative control)', (t) => {
  const { main, wt } = pair(t);
  const item: any = { locator, freshness: measureFreshness(main, locator, null, wt) };
  assert.equal(check(item, { repoRoot: main, sourceRoot: wt }), 'FRESH');
  assert.equal(check(item, { repoRoot: main, sourceRoot: main }), 'STALE', 'hashing the store copy is the bug IC-007 closes');
  assert.equal(check(item, { repoRoot: main }), 'STALE', 'default sourceRoot is repoRoot');
  fs.writeFileSync(path.join(wt, 'src', 'a.js'), 'module.exports = "edited";\n');
  assert.equal(check(item, { repoRoot: main, sourceRoot: wt }), 'STALE', 'a real edit in the worktree still expires it');
});

test('an absolute locator is hashed as is whatever the roots', (t) => {
  const { main, wt } = pair(t);
  const abs: any = { file: path.join(wt, 'src', 'a.js') };
  const f = measureFreshness(main, abs, null, main);
  assert.equal(f.fileHash, hashOf(wt));
  const item: any = { locator: abs, freshness: f };
  assert.equal(check(item, { repoRoot: main, sourceRoot: main }), 'FRESH');
  assert.equal(check(item, { repoRoot: wt, sourceRoot: wt }), 'FRESH');
});

test('toEvidence hashes in ctx.sourceRoot and defaults to the root', (t) => {
  const { main, wt } = pair(t);
  const treeState: any = { gitCommit: null, isDirty: false, fingerprint: null };
  const item: any = { kind: 'exact-search', provenance: 'extracted', source: { provider: 'test', capability: 'exact-search' }, locator, content: 'x' };
  const ctx: any = { taskId: 't-1', root: main, treeState };
  const withSource = toEvidence({ item }, { ...ctx, sourceRoot: wt });
  assert.equal(withSource.freshness.fileHash, hashOf(wt));
  const plain = toEvidence({ item }, ctx);
  assert.equal(plain.freshness.fileHash, hashOf(main));
  assert.deepEqual(Object.keys(withSource.freshness).sort(), Object.keys(plain.freshness).sort(), 'no new freshness field');
});

test('file deleted in the worktree but present in main (not under a feature folder): result STALE', (t) => {
  const { main, wt } = pair(t);
  fs.writeFileSync(path.join(wt, 'src', 'a.js'), fs.readFileSync(path.join(main, 'src', 'a.js')));
  const item: any = { locator: { file: 'src/a.js' }, freshness: measureFreshness(main, { file: 'src/a.js' }, null, wt) };
  assert.equal(check(item, { repoRoot: main, sourceRoot: wt }), 'FRESH');
  fs.unlinkSync(path.join(wt, 'src', 'a.js'));
  assert.equal(check(item, { repoRoot: main, sourceRoot: wt }), 'STALE');
});

test('a feature-folder locator (agent-docs/doflow/<slug>/x.md) that exists only in main (worktree lacks the folder): FRESH', (t) => {
  const { main, wt } = pair(t);
  const docRel = 'agent-docs/doflow/slug-1/x.md';
  fs.mkdirSync(path.join(main, 'agent-docs', 'doflow', 'slug-1'), { recursive: true });
  fs.writeFileSync(path.join(main, docRel), '# Spec\n');
  const loc: any = { file: docRel };
  const item: any = { locator: loc, freshness: measureFreshness(main, loc, null, main) };
  assert.equal(fs.existsSync(path.join(wt, 'agent-docs', 'doflow', 'slug-1')), false);
  assert.equal(check(item, { repoRoot: main, sourceRoot: wt }), 'FRESH');
});
