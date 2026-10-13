'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const b = require('../../bench/retrieval/lib/adapters-b.js');
const { tempDir } = require('../helper/tmp');

const REPO = path.resolve(__dirname, '..', '..');
const hasRg = spawnSync('rg', ['--version']).status === 0;
const opts = { skip: hasRg ? false : 'rg is not installed' };

const RETRIEVAL_STUB = `'use strict';
module.exports = { tokenize: (t) => String(t).toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 2) };
`;

function codeTree(t, files) {
  const root = tempDir(t, 'doflow-adapter-b-');
  const all = { 'src/runtime/knowledge/retrieval.ts': RETRIEVAL_STUB, ...files };
  for (const [f, body] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), body);
  }
  return root;
}

test('literal search ranks by path then line, one line per candidate, no scores', opts, (t) => {
  const root = codeTree(t, { 'src/b.ts': 'x\nneedle_fn()\n', 'src/a.ts': 'needle_fn();\nz\nneedle_fn();\n', 'src/c.ts': 'other\n' });
  const ans = b.runB({ corpus: 'code', task: { query: 'q', literal: 'needle_fn' }, exportRoot: root, hasFd: false });
  assert.equal(ans.result, 'RETRIEVED');
  assert.equal(ans.freshness, 'NOT_APPLICABLE');
  assert.deepEqual(ans.candidates.map((c) => [c.path, c.startLine, c.endLine, c.rank]), [['src/a.ts', 1, 1, 1], ['src/a.ts', 3, 3, 2], ['src/b.ts', 2, 2, 3]]);
  assert.deepEqual(ans.providers, [{ id: 'native.rg', state: 'reached' }]);
  assert.equal(ans.payloadBytes, ans.candidates.reduce((s, c) => s + c.snippetBytes, 0));
  assert.ok(ans.candidates.every((c) => c.provider === 'native.rg' && !('score' in c)));
  const none = b.runB({ corpus: 'code', task: { query: 'q', literal: 'absent_symbol_074' }, exportRoot: root, hasFd: false });
  assert.equal(none.result, 'EMPTY');
  assert.deepEqual(none.candidates, []);
});

test('term search: score is distinct terms matched, ties by match count then path; the line comes from the rarest term', opts, (t) => {
  const root = codeTree(t, {
    'src/both.ts': 'common line\nrare token here\ncommon again\n',
    'src/only-common.ts': 'common\ncommon\ncommon\n',
    'src/also-common.ts': 'common\n',
  });
  const ans = b.runB({ corpus: 'code', task: { query: 'common rare' }, exportRoot: root, hasFd: false });
  assert.deepEqual(ans.candidates.map((c) => c.path), ['src/both.ts', 'src/only-common.ts', 'src/also-common.ts']);
  assert.equal(ans.candidates[0].startLine, 2, 'rare matches one file, common matches three, so the rare term picks the line');
  assert.equal(ans.candidates[1].startLine, 1);
});

test('without fd the file-name step uses rg --files and records fd as unreached', opts, (t) => {
  const root = codeTree(t, { 'src/widget-loader.ts': 'nothing relevant\n', 'src/other.ts': 'widget mentioned\n' });
  const ans = b.runB({ corpus: 'code', task: { query: 'widget' }, exportRoot: root, hasFd: false });
  assert.deepEqual(ans.providers, [
    { id: 'native.rg', state: 'reached' },
    { id: 'fd', state: 'unreached', cause: 'binary absent; rg --files substitute' },
  ]);
  const named = ans.candidates.find((c) => c.path === 'src/widget-loader.ts');
  assert.ok(named, 'a file matched by name alone is a candidate');
  assert.equal(named.startLine, null);
  assert.equal(ans.candidates[0].path, 'src/other.ts', 'content match plus no name hit still outranks nothing');
});

test('with fd the file-name step adds one point per listed file', opts, (t) => {
  const root = codeTree(t, { 'src/a.ts': 'widget\n', 'src/b.ts': 'widget\n' });
  const stub = path.join(tempDir(t, 'doflow-fd-stub-'), 'fd');
  fs.writeFileSync(stub, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(path.join(root, 'src/b.ts'))});\n`);
  fs.chmodSync(stub, 0o755);
  const ans = b.runB({ corpus: 'code', task: { query: 'widget' }, exportRoot: root, bins: { fd: stub }, hasFd: true });
  assert.deepEqual(ans.candidates.map((c) => c.path), ['src/b.ts', 'src/a.ts'], 'the fd-listed file scores 2 against 1');
  assert.deepEqual(ans.providers, [{ id: 'native.rg', state: 'reached' }, { id: 'fd', state: 'reached' }]);
});

test('a missing rg binary is UNREACHED with a cause', (t) => {
  const root = codeTree(t, { 'src/a.ts': 'x\n' });
  const ans = b.runB({ corpus: 'code', task: { query: 'q', literal: 'x' }, exportRoot: root, bins: { rg: 'doflow-no-such-rg-074' }, hasFd: false });
  assert.equal(ans.result, 'UNREACHED');
  assert.deepEqual(ans.providers, [{ id: 'native.rg', state: 'unreached', cause: 'binary absent' }]);
  assert.deepEqual(ans.candidates, []);
});

test('finalize deduplicates by locator, cuts to k and renumbers ranks', () => {
  const c = (p, s, e, h) => ({ path: p, startLine: s, endLine: e, heading: h, rank: 99, provider: 'x', snippet: '', snippetBytes: 0 });
  const out = b.finalize([c('a', 1, 1, null), c('a', 1, 1, null), c('a', 1, 1, 'H'), c('b', 2, 3, null), c('c', 1, 1, null)], 3);
  assert.deepEqual(out.map((x) => [x.path, x.heading, x.rank]), [['a', null, 1], ['a', 'H', 2], ['b', null, 3]]);
});

test('guidance corpus uses the snapshot BM25: organic hits, graph hits apart, FRESH, repo-relative paths', { skip: process.platform === 'win32' ? 'symlink' : false }, (t) => {
  const root = tempDir(t, 'doflow-adapter-b-guidance-');
  fs.mkdirSync(path.join(root, 'core', 'shared'), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'src'), path.join(root, 'src'));
  const g = path.join(root, 'core', 'shared', 'guidance');
  fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, 'alpha.md'), '## Alpha\nzebra migration of quasar nodes\n@beta.md\n');
  fs.writeFileSync(path.join(g, 'beta.md'), '## Beta\nunrelated text\n');
  const ans = b.runB({ corpus: 'guidance', task: { query: 'zebra quasar' }, exportRoot: root, indexDir: path.join(tempDir(t, 'doflow-adapter-b-index-'), 'index') });
  assert.equal(ans.result, 'RETRIEVED');
  assert.equal(ans.freshness, 'FRESH');
  assert.equal(ans.candidates[0].path, 'core/shared/guidance/alpha.md');
  assert.equal(ans.candidates[0].heading, 'Alpha');
  assert.equal(ans.candidates[0].startLine, null);
  assert.deepEqual(ans.providers, [{ id: 'guidance.bm25', state: 'reached' }]);
  assert.ok(Array.isArray(ans.graphCandidates));
  assert.ok(ans.graphCandidates.every((c) => !ans.candidates.some((o) => o.path === c.path)), 'graph hits are not organic hits');
  const empty = b.runB({ corpus: 'guidance', task: { query: 'qqqqqqq' }, exportRoot: root, indexDir: path.join(tempDir(t, 'doflow-adapter-b-index-'), 'index') });
  assert.equal(empty.result, 'EMPTY');
  assert.equal(empty.freshness, 'FRESH');
});

test('adapter B: child env lacks DOFLOW_HOLDOUT_KEY and *_API_KEY', (t) => {
  const root = codeTree(t, { 'src/a.ts': 'x\n' });
  const bin = tempDir(t, 'doflow-adapter-b-envbin-');
  const envFile = path.join(tempDir(t, 'doflow-adapter-b-envout-'), 'env.json');
  const stubRg = path.join(bin, 'rg');
  fs.writeFileSync(stubRg, `#!/usr/bin/env node\nconst fs = require('fs');\nfs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));\nconsole.log('src/a.ts:1:x');\n`);
  fs.chmodSync(stubRg, 0o755);
  const prevHoldout = process.env.DOFLOW_HOLDOUT_KEY;
  const prevApiKey = process.env.TEST_API_KEY;
  process.env.DOFLOW_HOLDOUT_KEY = 'secret-holdout-12345';
  process.env.TEST_API_KEY = 'secret-api-key';
  try {
    b.runB({ corpus: 'code', task: { query: 'q', literal: 'x' }, exportRoot: root, bins: { rg: stubRg }, hasFd: false });
    const captured = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.equal('DOFLOW_HOLDOUT_KEY' in captured, false);
    assert.equal('TEST_API_KEY' in captured, false);
  } finally {
    if (prevHoldout !== undefined) process.env.DOFLOW_HOLDOUT_KEY = prevHoldout; else delete process.env.DOFLOW_HOLDOUT_KEY;
    if (prevApiKey !== undefined) process.env.TEST_API_KEY = prevApiKey; else delete process.env.TEST_API_KEY;
  }
});
