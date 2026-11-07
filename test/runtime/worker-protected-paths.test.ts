'use strict';

// FU-kjcv6t: the protected-path matcher and the `protected-path` eligibility gap in dispatch mode selection.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { matchProtectedPath, protectedPathGap } = require('../../src/runtime/worker/protected-paths.ts');
const loop = require('../../src/runtime/dispatch/loop.ts');
const { loadRegistry } = require('../../src/registry/index.ts');

const REPO = path.resolve(__dirname, '../..');
const REG = loadRegistry({ repoRoot: REPO });
const CODEX = REG.harnesses.find((h: any) => h.id === 'codex').worker;
const PROTECTED = ['.git', '.agents', '.codex', '.aws'];

const hit = (files: any, paths: any = PROTECTED) => matchProtectedPath(files, paths);

test('FU-kjcv6t: the shipped codex entry lists the four paths the live probe found protected', () => {
  assert.deepEqual(CODEX.isolatedEdit.protectedPaths, PROTECTED);
});

test('FU-kjcv6t matcher: a protected name at the declared path root is blocked', () => {
  assert.deepEqual(hit(['.git/hooks/pre-commit']), { protectedPath: '.git', file: '.git/hooks/pre-commit' });
  assert.deepEqual(hit(['src/a.js', '.codex/config.toml']), { protectedPath: '.codex', file: '.codex/config.toml' });
  assert.equal(hit(['.agents/rules/x.md']).protectedPath, '.agents');
  assert.equal(hit(['.aws/credentials']).protectedPath, '.aws');
  assert.equal(hit(['.git']).protectedPath, '.git', 'the directory itself');
});

test('FU-kjcv6t matcher: ./ prefixes, redundant segments, backslashes and letter case still match at the root', () => {
  assert.equal(hit(['./.git/config']).protectedPath, '.git');
  assert.equal(hit(['a/../.git/config']).protectedPath, '.git');
  assert.equal(hit(['.git\\config']).protectedPath, '.git');
  assert.equal(hit(['.GIT/config']).protectedPath, '.git');
});

test('FU-kjcv6t matcher: a nested segment is not matched (sub/.git was writable in the probe)', () => {
  assert.equal(hit(['sub/.git/config']), null);
  assert.equal(hit(['sub/.agents/y']), null);
  assert.equal(hit(['a/b/.codex/config.toml']), null);
});

test('FU-kjcv6t matcher: names that only look alike are not matched', () => {
  assert.equal(hit(['.github/workflows/ci.yml']), null);
  assert.equal(hit(['.ssh/config']), null);
  assert.equal(hit(['.gitignore']), null);
  assert.equal(hit(['.gitattributes', '.codexrc', '.awsome/x']), null);
  assert.equal(hit(['src/index.js', 'docs/readme.md']), null);
});

test('FU-kjcv6t matcher: a multi-segment protected path blocks its own subtree only', () => {
  assert.equal(hit(['.codex/hooks/x.sh'], ['.codex/hooks']).file, '.codex/hooks/x.sh');
  assert.equal(hit(['.codex/config.toml'], ['.codex/hooks']), null);
});

test('FU-kjcv6t matcher: paths outside the workspace and bad input never match', () => {
  assert.equal(hit(['../.git/config']), null);
  assert.equal(hit(['/abs/.git/config']), null);
  assert.equal(hit(['', '.', null, 7]), null);
  assert.equal(hit('.git/config'), null);
  assert.equal(matchProtectedPath(['.git/config'], undefined), null);
  assert.equal(hit([], PROTECTED), null);
});

test('FU-kjcv6t gap: shape, matched path in the reason, and only for a supported entry that lists paths', () => {
  assert.deepEqual(protectedPathGap(CODEX, ['src/a.js', '.git/hooks/x']), {
    requirement: 'protected-path', result: 'failed', reason: 'protected-path:.git (.git/hooks/x)',
  });
  assert.equal(protectedPathGap(CODEX, ['sub/.git/x', '.github/y']), null);
  assert.equal(protectedPathGap({ isolatedEdit: { status: 'supported', argv: [] } }, ['.git/x']), null, 'no list, no gap');
  assert.equal(protectedPathGap({ isolatedEdit: { status: 'unknown', protectedPaths: ['.git'] } }, ['.git/x']), null);
  assert.equal(protectedPathGap({}, ['.git/x']), null);
  assert.equal(protectedPathGap(null, ['.git/x']), null);
});

// ── eligibility in selectMode ────────────────────────────────────────────────────────────────────

const cand = (harness: string) => ({ harness, eligible: true, gaps: [] });
const select = (files: any, candidates: any[] = [cand('codex')], extra: any = {}) => loop.selectMode({
  policy: 'auto', registry: REG, cache: { candidates: structuredClone(candidates) }, files, ...extra,
});

test('FU-kjcv6t eligibility: a task declaring a root .git file is not dispatched to codex and runs sequentially with the gap', () => {
  const r = select(['src/a.js', '.git/hooks/pre-commit']);
  assert.deepEqual([r.mode, r.harness], ['sequential', null]);
  assert.equal(r.selection.chosen, 'sequential');
  assert.deepEqual(r.selection.candidates[0].gaps, [{ requirement: 'protected-path', result: 'failed', reason: 'protected-path:.git (.git/hooks/pre-commit)' }]);
  assert.equal(r.selection.candidates[0].eligible, false);
});

test('FU-kjcv6t eligibility: .codex/config.toml and root .agents files are refused; nested, .github, .ssh and ordinary files are not', () => {
  assert.equal(select(['.codex/config.toml']).mode, 'sequential');
  assert.equal(select(['.agents/rules/x.md']).mode, 'sequential');
  for (const file of ['sub/.git/config', 'sub/.agents/y', '.github/workflows/ci.yml', '.ssh/config', 'src/ordinary.js']) {
    const r = select([file]);
    assert.deepEqual([r.mode, r.harness], ['subagent', 'codex'], file);
    assert.deepEqual(r.selection.candidates[0].gaps, [], file);
  }
});

test('FU-kjcv6t eligibility: no declared files, or a harness without a list, keeps the candidate eligible', () => {
  assert.equal(select([]).harness, 'codex');
  assert.equal(select(undefined).harness, 'codex');
  const claude = select(['.git/config'], [cand('claude')]);
  assert.deepEqual([claude.mode, claude.harness], ['subagent', 'claude'], 'claude declares no protectedPaths');
});

test('FU-kjcv6t eligibility: the next eligible rung takes the task when only codex is gapped; the shared candidate cache is not changed', () => {
  const cache = { candidates: [cand('claude'), cand('codex')].reverse() };
  const before = structuredClone(cache.candidates);
  const r = loop.selectMode({ policy: 'auto', registry: REG, cache, files: ['.git/x'] });
  assert.deepEqual([r.mode, r.harness], ['subagent', 'claude']);
  assert.deepEqual(cache.candidates, before, 'a later task with other files sees the original candidates');
});
