'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { admitCodeCorpus } = require('../../src/runtime/knowledge/code-corpus.ts');
const { LIVE_LIMITS, validateCodeCandidates, projectEvidenceCandidates } = require('../../src/runtime/knowledge/code-validation.ts');

test('always live-reads source, rejects stale or out-of-corpus candidates and projects score-free evidence', t => {
  const root = tempDir(t, 'doflow-code-validation-');
  fs.writeFileSync(path.join(root, 'main.js'), 'one\ntrusted source\nthree\n');
  const inventory = admitCodeCorpus({ root, files: ['main.js'] });
  const [entry] = inventory.files;
  const candidate: any = { locator: { file: entry.path, line: 2, endLine: 2 }, provider: 'semble.search', capability: 'code.semantic-search',
    sourceVersion: { fileHash: entry.fileHash }, rrfScore: 1.25, snippet: 'untrusted cached answer' };
  const result = validateCodeCandidates({ inventory, candidates: [candidate], topN: 2 });
  assert.equal(result.results[0].snippet, 'trusted source');
  const evidence = projectEvidenceCandidates(result.results[0], { need: 'n1' });
  assert.deepEqual(evidence[0].candidate.locator, { file: 'main.js', line: 2 });
  assert.equal(evidence[0].content, 'trusted source');
  assert.equal(Object.hasOwn(evidence[0].candidate, 'rrfScore'), false);
  assert.equal(validateCodeCandidates({ inventory, candidates: [{ ...candidate, sourceVersion: { fileHash: '0'.repeat(64) } }] }).rejected[0].reason, 'source-changed');
  assert.equal(validateCodeCandidates({ inventory, candidates: [{ ...candidate, locator: { file: '../outside', line: 1, endLine: 1 } }] }).rejected[0].reason, 'invalid-locator');
});

test('candidates on one file share one live read and charge the aggregate budget once', t => {
  const root = tempDir(t, 'doflow-code-validation-reuse-');
  const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'big.js'), body);
  fs.writeFileSync(path.join(root, 'small.js'), 'tail\n');
  const inventory = admitCodeCorpus({ root, files: ['big.js', 'small.js'] });
  const [big, small] = inventory.files;
  const at = (entry: any, line: any) => ({ locator: { file: entry.path, line, endLine: line }, provider: 'native.rg', capability: 'code.exact-search', sourceVersion: { fileHash: entry.fileHash } });
  const candidates: any = [at(big, 1), at(big, 5), at(big, 9), at(small, 1)];
  // Budget fits big.js once plus small.js; per-candidate re-reads would exhaust it at the second candidate.
  const limits: any = { maxReadBytes: big.sizeBytes + small.sizeBytes };
  const result = validateCodeCandidates({ inventory, candidates, topN: 10, limits });
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.results.map((r: any) => `${r.locator.file}:${r.locator.line}`), ['big.js:1', 'big.js:5', 'big.js:9', 'small.js:1']);
  assert.equal(result.accounting.readBytes, big.sizeBytes + small.sizeBytes);
  assert.equal(result.results[1].snippet, `line 5 ${'x'.repeat(40)}`);
  assert.equal(result.complete, true);
  // A reused read still enforces per-candidate version identity.
  const stale = validateCodeCandidates({ inventory, candidates: [at(big, 1), { ...at(big, 2), sourceVersion: { fileHash: '0'.repeat(64) } }], limits });
  assert.deepEqual(stale.rejected.map((r: any) => r.reason), ['source-changed']);
  // The documented aggregate cap still binds when distinct files exceed it.
  const capped = validateCodeCandidates({ inventory, candidates: [at(big, 1), at(small, 1)], limits: { maxReadBytes: big.sizeBytes } });
  assert.deepEqual(capped.rejected.map((r: any) => r.reason), ['read-byte-limit']);
  assert.equal(capped.complete, false);
});

test('IC-007 default aggregate live-read cap is 1 MiB and stays a hard bound', t => {
  const root = fs.realpathSync(require('../helper/tmp.ts').tempDir(t, 'doflow-code-validation-cap-'));
  const names: any = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'];
  // 300 KiB each: three fit under 1 MiB (a 256 KiB cap admits none), the rest exceed the remainder.
  for (const name of names) fs.writeFileSync(path.join(root, name), `// ${name}\n${'y'.repeat(300 * 1024 - 10)}\n`);
  const inventory = admitCodeCorpus({ root, files: names });
  const candidates = inventory.files.map((entry: any) => ({ locator: { file: entry.path, line: 1, endLine: 1 }, provider: 'native.rg',
    capability: 'code.exact-search', sourceVersion: { fileHash: entry.fileHash } }));
  const result = validateCodeCandidates({ inventory, candidates, topN: 10 });
  assert.equal(LIVE_LIMITS.maxReadBytes, 1024 * 1024);
  assert.deepEqual(result.results.map((r: any) => r.locator.file), ['a.js', 'b.js', 'c.js']);
  assert.deepEqual(result.rejected.map((r: any) => `${r.locator.file}:${r.reason}`), ['d.js:read-byte-limit', 'e.js:read-byte-limit']);
  assert.ok(result.accounting.readBytes <= LIVE_LIMITS.maxReadBytes, `read ${result.accounting.readBytes} bytes past the cap`);
  assert.equal(result.complete, false);
});

test('code evidence projection emits a separate score-free item for every validated origin', () => {
  const candidate: any = {
    locator: { file: 'src/auth.js', line: 8, endLine: 10 },
    provider: 'semble.search', capability: 'code.semantic-search',
    rrfScore: 0.03, rank: 1, score: 0.8,
    origins: [
      { provider: 'semble.search', capability: 'code.semantic-search', retrievalAttemptRef: 'ra-sem' },
      { provider: 'native.rg', capability: 'code.semantic-search', retrievalAttemptRef: 'ra-lex' },
    ],
    sourceVersion: { gitCommit: null, fileHash: 'a'.repeat(64), isDirty: true },
    snippet: 'function refresh() {}', liveRead: { startLine: 8, endLine: 8 },
  };
  const projected = projectEvidenceCandidates(candidate, { need: 'locate-concept' });
  assert.equal(projected.length, 2);
  for (const item of projected) {
    assert.deepEqual(Object.keys(item).sort(), ['candidate', 'content']);
    assert.deepEqual(Object.keys(item.candidate).sort(), ['capability', 'locator', 'need', 'provider', 'sourceVersion']);
    assert.deepEqual(item.candidate.locator, { file: 'src/auth.js', line: 8 });
    assert.equal(item.candidate.need, 'locate-concept');
    assert.equal(item.content, 'function refresh() {}');
    assert.equal('score' in item.candidate, false);
    assert.equal('rrfScore' in item.candidate, false);
    assert.equal('origins' in item.candidate, false);
  }
  assert.deepEqual(projected.map((item: any) => item.candidate.provider), ['semble.search', 'native.rg']);
});

test('projection refuses candidates without a validated live read', () => {
  assert.throws(() => projectEvidenceCandidates({ locator: { file: 'src/a.js', line: 1 } }), /validated live read/);
});

// DEC-025 (IC-007): file-grain candidates validate their delivered span and range-check every origin on the same read.
const { fuseRankedCandidates } = require('../../src/runtime/knowledge/hybrid.ts');
function fileWorld(t: any, count: any, lines: any = 30) {
  const root = fs.realpathSync(tempDir(t, 'doflow-code-validation-grain-'));
  const names = Array.from({ length: count }, (_, i) => `f${String(i + 1).padStart(3, '0')}.js`);
  for (const name of names) fs.writeFileSync(path.join(root, name), Array.from({ length: lines }, (_, i) => `${name} line ${i + 1}`).join('\n') + '\n');
  const inventory = admitCodeCorpus({ root, files: names });
  const hash = Object.fromEntries(inventory.files.map((f: any) => [f.path, f.fileHash]));
  return { root, names, inventory, hash, size: Object.fromEntries(inventory.files.map((f: any) => [f.path, f.sizeBytes])) };
}
const lexOf = (w: any, names: any, line: any = 6) => ({ provider: 'native.rg', capability: 'code.semantic-search', retrievalAttemptRef: 'ra-lex',
  candidates: names.map((file: any) => ({ locator: { file, line, endLine: line }, sourceVersion: { fileHash: w.hash[file] } })) });
const semOf = (w: any, names: any, { line = 1, endLine = 20, stale = () => false, snippet }: any = {}) => ({ provider: 'semble.search', capability: 'code.semantic-search', retrievalAttemptRef: 'ra-sem',
  candidates: names.map((file: any) => ({ locator: { file, line, endLine }, ...(snippet ? { snippet } : {}),
    origins: [{ provider: 'semble.search', capability: 'code.semantic-search', retrievalAttemptRef: 'ra-sem', indexedSourceHash: stale(file) ? '0'.repeat(64) : w.hash[file] }] })) });
const fuseFiles = (w: any, lists: any, depth: any = 10) => fuseRankedCandidates({ rankedLists: lists, corpusIdentity: w.inventory.identity, grain: 'file', depth }).candidates;

test('DEC-025 merged candidate projects exactly one score-free item per provider with the delivered locator and live text', (t) => {
  const w = fileWorld(t, 1);
  const fused = fuseFiles(w, [lexOf(w, w.names), semOf(w, w.names)]);
  const live = validateCodeCandidates({ inventory: w.inventory, candidates: fused, topN: 5 });
  assert.equal(live.results.length, 1, 'agreement is one delivered candidate (HEAD: two)');
  const projected = projectEvidenceCandidates(live.results[0], { need: 'locate-concept' });
  assert.deepEqual(projected.map((p: any) => p.candidate.provider), ['native.rg', 'semble.search']);
  for (const item of projected) {
    assert.deepEqual(item.candidate.locator, { file: 'f001.js', line: 1 });
    assert.equal(item.content.split('\n').length, 20);
    for (const key of ['endLine', 'origins', 'rank', 'rrfScore', 'score']) assert.equal(key in item.candidate, false, key);
  }
});

test('DEC-025 live text only: the chunk is delivered when semantic voted, the line when lexical only; provider snippets never appear', (t) => {
  const w = fileWorld(t, 2);
  const fused: any = fuseFiles(w, [lexOf(w, w.names), semOf(w, ['f001.js'], { snippet: 'POISON' })]);
  const live = validateCodeCandidates({ inventory: w.inventory, candidates: fused, topN: 5 });
  assert.deepEqual(live.results.map((r: any) => `${r.locator.file}:${r.locator.line}-${r.locator.endLine}`), ['f001.js:1-20', 'f002.js:6-6']);
  assert.equal(live.results[0].snippet.split('\n')[0], 'f001.js line 1');
  assert.equal(live.results[1].snippet, 'f002.js line 6');
  assert.equal(JSON.stringify(live).includes('POISON'), false);
});

test('DEC-025 one live read per file: N agreed files charge exactly the sum of their sizes', (t) => {
  const w = fileWorld(t, 5);
  const live = validateCodeCandidates({ inventory: w.inventory, candidates: fuseFiles(w, [lexOf(w, w.names), semOf(w, w.names)]), topN: 10 });
  assert.equal(live.results.length, 5, 'one slot per file (HEAD: 10)');
  assert.equal(live.accounting.readBytes, Object.values(w.size).reduce((a, b) => a + b, 0));
});

test('DEC-025 a stale merged origin hash rejects the whole file as source-changed, counted once', (t) => {
  const w = fileWorld(t, 3);
  const fused: any = fuseFiles(w, [lexOf(w, w.names), semOf(w, w.names, { stale: (f: any) => f === 'f002.js' })]);
  const live = validateCodeCandidates({ inventory: w.inventory, candidates: fused, topN: 10 });
  assert.deepEqual(live.results.map((r: any) => r.locator.file), ['f001.js', 'f003.js']);
  assert.deepEqual(live.rejected.map((r: any) => `${r.locator.file}:${r.reason}`), ['f002.js:source-changed']);
  assert.equal(live.complete, false);
});

test('DEC-025 an out-of-range secondary origin is dropped with its cause; an invalid delivered span rejects the candidate once', (t) => {
  const w = fileWorld(t, 2);
  const fused = fuseFiles(w, [lexOf(w, ['f001.js'], 999), semOf(w, ['f001.js'])]);
  const live = validateCodeCandidates({ inventory: w.inventory, candidates: fused, topN: 5 });
  assert.equal(live.results.length, 1);
  assert.equal(live.results[0].locator.endLine, 20);
  assert.deepEqual(live.results[0].origins.map((o: any) => o.provider), ['semble.search']);
  assert.deepEqual(live.rejectedOrigins, [{ locator: { file: 'f001.js', line: 999, endLine: 999 }, provider: 'native.rg', retrievalAttemptRef: 'ra-lex', reason: 'line-out-of-range' }]);
  assert.deepEqual(live.rejected, []);
  assert.equal(live.complete, false, 'a dropped origin leaves coverage partial');
  const bad = validateCodeCandidates({ inventory: w.inventory, candidates: fuseFiles(w, [lexOf(w, ['f002.js']), semOf(w, ['f002.js'], { line: 10, endLine: 900 })]), topN: 5 });
  assert.deepEqual(bad.rejected.map((r: any) => r.reason), ['line-out-of-range']);
  assert.equal(bad.results.length, 0);
  assert.equal(bad.rejectedOrigins, undefined, 'the rejected candidate is counted once, not per origin');
  const valid = validateCodeCandidates({ inventory: w.inventory, candidates: fuseFiles(w, [lexOf(w, ['f001.js']), semOf(w, ['f001.js'])]), topN: 5 });
  assert.equal(valid.rejectedOrigins, undefined);
  assert.equal(valid.complete, true);
});
