'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dispatcher = require('../../bench/retrieval/lib/adapters.ts');
const { tempDir } = require('../helper/tmp.ts');

// git apply and git archive run under the runner's system core.autocrlf, so a Windows checkout of the
// patched file may carry CRLF; the fact asserted is the content, so line endings are normalised there only.
const lf = (text: string) => (process.platform === 'win32' ? text.replace(/\r\n/g, '\n') : text);

function exportTree(t: any) {
  const root = path.join(tempDir(t, 'doflow-dispatch-'), 'tree');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'x.ts'), 'a\nb\nc\n');
  fs.mkdirSync(path.join(root, 'graphify-out'));
  fs.writeFileSync(path.join(root, 'graphify-out', 'graph.json'), '{}');
  return root;
}

const PATCH = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,3 +1,3 @@
 a
-b
+B
 c
`;
const cand = (p: any, s: any, e: any, rank: any = 0, h: any = null) => ({ path: p, startLine: s, endLine: e, heading: h, rank, provider: 'p', snippet: 'abcd', snippetBytes: 4 });
const ok = (candidates: any, extra: any = {}) => ({ result: 'RETRIEVED', freshness: 'NOT_APPLICABLE', candidates, providers: [], payloadBytes: 999, wallMs: 1, ...extra });
const snapshot: any = { corpora: { code: { kMax: 10 }, guidance: { kMax: 5 } } };

test('guidance configuration A is configuration B and is not computed twice', (t) => {
  const root = exportTree(t);
  const impl: any = { runA: () => assert.fail('A must not run'), runB: () => assert.fail('B is the caller\'s'), runVerification: () => assert.fail('no') };
  assert.deepEqual(dispatcher.runConfig({ config: 'A', corpus: 'guidance', task: { id: 'DG-001', class: 'exact-lookup' }, exportRoot: root, snapshot, impl }), { sameAs: 'B' });
  assert.throws(() => dispatcher.runConfig({ config: 'C', corpus: 'code', task: {}, exportRoot: root, impl }), /unknown configuration/);
});

test('answers are deduplicated, cut to k_max and re-measured', (t) => {
  const root = exportTree(t);
  const many = Array.from({ length: 14 }, (_, i) => cand(`src/f${i}.ts`, 1, 1));
  const impl: any = { runB: () => ok([cand('src/a.ts', 1, 2), cand('src/a.ts', 1, 2), ...many]), runA: () => ok([...many]) };
  const b = dispatcher.runConfig({ config: 'B', corpus: 'code', task: { id: 'DC-001', class: 'exact-lookup' }, exportRoot: root, snapshot, impl });
  assert.equal(b.candidates.length, 10);
  assert.deepEqual(b.candidates.slice(0, 2).map((c: any) => c.path), ['src/a.ts', 'src/f0.ts']);
  assert.deepEqual(b.candidates.map((c: any) => c.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(b.payloadBytes, 40);
  const g: any = dispatcher.runConfig({ config: 'B', corpus: 'guidance', task: { id: 'DG-001', class: 'exact-lookup' }, exportRoot: root, snapshot,
    impl: { runB: () => ok(Array.from({ length: 8 }, (_, i) => cand(`g${i}.md`, null, null, 0, `H${i}`)), { graphCandidates: [cand('z.md', null, null, 0, 'Z')] }) } });
  assert.equal(g.candidates.length, 5);
  assert.equal(g.graphCandidates.length, 1);
});

test('a setup patch is applied to a per-task copy; the export and its index stay untouched, and the copy is removed', (t) => {
  const root = exportTree(t);
  const seen: any = {};
  const impl: any = {
    runB: ({ exportRoot }: any) => { seen.b = lf(fs.readFileSync(path.join(exportRoot, 'src', 'x.ts'), 'utf8')); seen.bRoot = exportRoot; return ok([]); },
    runA: ({ exportRoot, indexRoot }: any) => {
      seen.a = lf(fs.readFileSync(path.join(exportRoot, 'src', 'x.ts'), 'utf8'));
      seen.aCopy = exportRoot; seen.indexRoot = indexRoot; seen.copyHasIndex = fs.existsSync(path.join(exportRoot, 'graphify-out'));
      return ok([]);
    },
  };
  const task: any = { id: 'DC-007', class: 'dirty-tree', setup: { patchText: PATCH } };
  dispatcher.runConfig({ config: 'B', corpus: 'code', task, exportRoot: root, snapshot, impl });
  assert.equal(seen.b, 'a\nB\nc\n');
  dispatcher.runConfig({ config: 'A', corpus: 'code', task, exportRoot: root, snapshot, impl });
  assert.equal(seen.a, 'a\nB\nc\n');
  assert.equal(seen.indexRoot, root, 'A queries the index built before the patch');
  assert.equal(seen.copyHasIndex, false, 'the copy carries no index output');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'x.ts'), 'utf8'), 'a\nb\nc\n', 'the export is not patched');
  assert.equal(fs.existsSync(seen.aCopy), false, 'the per-task copy is removed');
  assert.equal(fs.existsSync(path.join(root, 'graphify-out', 'graph.json')), true);
});

test('setup.patch (dev) is read from the repo; a patch that does not apply throws with the task id', (t) => {
  const root = exportTree(t);
  const repo = tempDir(t, 'doflow-dispatch-repo-');
  fs.mkdirSync(path.join(repo, 'bench', 'retrieval', 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'bench', 'retrieval', 'fixtures', 'p.patch'), PATCH);
  let body;
  const impl: any = { runB: ({ exportRoot }: any) => { body = lf(fs.readFileSync(path.join(exportRoot, 'src', 'x.ts'), 'utf8')); return ok([]); } };
  dispatcher.runConfig({ config: 'B', corpus: 'code', task: { id: 'DC-002', class: 'stale-index', setup: { patch: 'bench/retrieval/fixtures/p.patch' } }, exportRoot: root, snapshot, repoRoot: repo, impl });
  assert.equal(body, 'a\nB\nc\n');
  assert.throws(() => dispatcher.runConfig({ config: 'B', corpus: 'code', task: { id: 'DC-003', class: 'dirty-tree', setup: { patchText: PATCH.replace('-b', '-zzz') } }, exportRoot: root, snapshot, impl }),
    /setup patch for DC-003 does not apply/);
});

test('B treats a disabled provider as unreached; verification-failure goes to the raw command runner', (t) => {
  const root = exportTree(t);
  const impl: any = { runB: () => assert.fail('B must not run'), runVerification: ({ config }: any) => ({ result: 'RETRIEVED', ran: config }) };
  const off = dispatcher.runConfig({ config: 'B', corpus: 'code', task: { id: 'DC-004', class: 'unavailable-provider', setup: { disable: ['native.rg'] } }, exportRoot: root, snapshot, impl });
  assert.equal(off.result, 'UNREACHED');
  assert.deepEqual(off.providers, [{ id: 'native.rg', state: 'unreached', cause: 'disabled by setup.disable' }]);
  const v = dispatcher.runConfig({ config: 'B', corpus: 'code', task: { id: 'DC-005', class: 'verification-failure', setup: { command: ['x'] } }, exportRoot: root, snapshot, impl });
  assert.deepEqual(v, { result: 'RETRIEVED', ran: 'B' });
  const a = dispatcher.runConfig({ config: 'A', corpus: 'code', task: { id: 'DC-006', class: 'verification-failure', setup: { command: ['x'] } }, exportRoot: root, snapshot,
    impl: { runA: () => ({ result: 'RETRIEVED', candidates: [], payloadBytes: 321, output: 'o', exitCode: 1 }) } });
  assert.equal(a.payloadBytes, 321, 'a command answer keeps its output size');
});

test('applyPatch: child env lacks DOFLOW_HOLDOUT_KEY and *_API_KEY', { skip: process.platform === 'win32' ? 'POSIX shebang' : false }, (t) => {
  const root = exportTree(t);
  const bin = tempDir(t, 'doflow-dispatch-envbin-');
  const envFile = path.join(tempDir(t, 'doflow-dispatch-envout-'), 'env.json');
  const stubGit = path.join(bin, 'git');
  fs.writeFileSync(stubGit, `#!/usr/bin/env node\nconst fs = require('fs');\nfs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));\nprocess.exit(0);\n`);
  fs.chmodSync(stubGit, 0o755);
  const prevPath = process.env.PATH;
  const prevHoldout = process.env.DOFLOW_HOLDOUT_KEY;
  const prevApiKey = process.env.TEST_API_KEY;
  process.env.PATH = `${bin}:${prevPath}`;
  process.env.DOFLOW_HOLDOUT_KEY = 'secret-holdout-12345';
  process.env.TEST_API_KEY = 'secret-api-key';
  try {
    dispatcher.applyPatch({ id: 'DC-007', setup: { patchText: PATCH } }, root, root);
    const captured = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.equal('DOFLOW_HOLDOUT_KEY' in captured, false);
    assert.equal('TEST_API_KEY' in captured, false);
  } finally {
    process.env.PATH = prevPath;
    if (prevHoldout !== undefined) process.env.DOFLOW_HOLDOUT_KEY = prevHoldout; else delete process.env.DOFLOW_HOLDOUT_KEY;
    if (prevApiKey !== undefined) process.env.TEST_API_KEY = prevApiKey; else delete process.env.TEST_API_KEY;
  }
});

test('FX.4: holdout setup patch failure carries no task id and no git-apply output', (t) => {
  const root = exportTree(t);
  const badPatch = PATCH.replace('-b', '-zzz');
  assert.throws(
    () => dispatcher.applyPatch({ id: 'HC-001', split: 'holdout', setup: { patchText: badPatch } }, root, root),
    (err: any) => {
      assert.equal(err.message, 'setup patch failed for a holdout task');
      assert.ok(!err.message.includes('HC-001'));
      assert.ok(!err.message.includes('error:'));
      return true;
    }
  );
});
