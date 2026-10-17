'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { admitCodeCorpus } = require('../../src/runtime/knowledge/code-corpus.ts');
const { LIVE_LIMITS, validateCodeCandidates, projectEvidenceCandidates } = require('../../src/runtime/knowledge/code-validation.ts');

test('always live-reads source, rejects stale or out-of-corpus candidates and projects score-free evidence', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-validation-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.js'), 'one\ntrusted source\nthree\n');
  const inventory = admitCodeCorpus({ root, files: ['main.js'] });
  const [entry] = inventory.files;
  const candidate = { locator: { file: entry.path, line: 2, endLine: 2 }, provider: 'semble.search', capability: 'code.semantic-search',
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-validation-reuse-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'big.js'), body);
  fs.writeFileSync(path.join(root, 'small.js'), 'tail\n');
  const inventory = admitCodeCorpus({ root, files: ['big.js', 'small.js'] });
  const [big, small] = inventory.files;
  const at = (entry, line) => ({ locator: { file: entry.path, line, endLine: line }, provider: 'native.rg', capability: 'code.exact-search', sourceVersion: { fileHash: entry.fileHash } });
  const candidates = [at(big, 1), at(big, 5), at(big, 9), at(small, 1)];
  // Budget fits big.js once plus small.js; per-candidate re-reads would exhaust it at the second candidate.
  const limits = { maxReadBytes: big.sizeBytes + small.sizeBytes };
  const result = validateCodeCandidates({ inventory, candidates, topN: 10, limits });
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.results.map(r => `${r.locator.file}:${r.locator.line}`), ['big.js:1', 'big.js:5', 'big.js:9', 'small.js:1']);
  assert.equal(result.accounting.readBytes, big.sizeBytes + small.sizeBytes);
  assert.equal(result.results[1].snippet, `line 5 ${'x'.repeat(40)}`);
  assert.equal(result.complete, true);
  // A reused read still enforces per-candidate version identity.
  const stale = validateCodeCandidates({ inventory, candidates: [at(big, 1), { ...at(big, 2), sourceVersion: { fileHash: '0'.repeat(64) } }], limits });
  assert.deepEqual(stale.rejected.map(r => r.reason), ['source-changed']);
  // The documented aggregate cap still binds when distinct files exceed it.
  const capped = validateCodeCandidates({ inventory, candidates: [at(big, 1), at(small, 1)], limits: { maxReadBytes: big.sizeBytes } });
  assert.deepEqual(capped.rejected.map(r => r.reason), ['read-byte-limit']);
  assert.equal(capped.complete, false);
});

test('IC-007 default aggregate live-read cap is 1 MiB and stays a hard bound', t => {
  const root = fs.realpathSync(require('../helper/tmp').tempDir(t, 'doflow-code-validation-cap-'));
  const names = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'];
  // 300 KiB each: three fit under 1 MiB (a 256 KiB cap admits none), the rest exceed the remainder.
  for (const name of names) fs.writeFileSync(path.join(root, name), `// ${name}\n${'y'.repeat(300 * 1024 - 10)}\n`);
  const inventory = admitCodeCorpus({ root, files: names });
  const candidates = inventory.files.map((entry) => ({ locator: { file: entry.path, line: 1, endLine: 1 }, provider: 'native.rg',
    capability: 'code.exact-search', sourceVersion: { fileHash: entry.fileHash } }));
  const result = validateCodeCandidates({ inventory, candidates, topN: 10 });
  assert.equal(LIVE_LIMITS.maxReadBytes, 1024 * 1024);
  assert.deepEqual(result.results.map((r) => r.locator.file), ['a.js', 'b.js', 'c.js']);
  assert.deepEqual(result.rejected.map((r) => `${r.locator.file}:${r.reason}`), ['d.js:read-byte-limit', 'e.js:read-byte-limit']);
  assert.ok(result.accounting.readBytes <= LIVE_LIMITS.maxReadBytes, `read ${result.accounting.readBytes} bytes past the cap`);
  assert.equal(result.complete, false);
});
