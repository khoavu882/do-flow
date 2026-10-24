'use strict';

// G43 — hybrid retrieval and evaluation boundaries (079 IC-004, IC-009, IC-010, DEC-014/016).
// These checks are deliberately separate from G33's historical A/B and baseline contract.
// The pure source checks run on the shipped tree and on one in-memory violation per rule.
//
// G43.1 pins the Semble boundary to the approved public API, bounded result order and offline
//       write/network policy; query must not use a build/save API.
// G43.2 reserves all six C result slots before holdout decryption; only failed pre-evaluation
//       checks may release that reservation.
// G43.3 gate output is aggregate-only and missing paid evidence cannot pass the gate.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');

const read = (rel: any) => fs.readFileSync(path.join(REPO, rel), 'utf8');

function providerFindings(bridge: any) {
  const findings: any = [];
  if (!/VERSION\s*=\s*['"]0\.7\.0['"]/.test(bridge)) findings.push('G43.1: bridge does not pin Semble 0.7.0');
  if (!/index\.search\([^\n]*top_k\s*=\s*200[^\n]*alpha\s*=\s*1\.0[^\n]*rerank\s*=\s*False/.test(bridge)) findings.push('G43.1: query is not bounded dense-only public search');
  if (!/Preserve the returned order/.test(bridge)) findings.push('G43.1: bridge does not preserve provider-native order');
  if (!/sys\.addaudithook\(audit\)/.test(bridge) || !/socket\./.test(bridge) || !/provider-write-outside-state/.test(bridge)) findings.push('G43.1: bridge lacks network and write-boundary policy');
  const queryStart = bridge.indexOf('if request["action"] == "query":');
  const queryEnd = bridge.indexOf('if request["action"] not in ("build", "refresh")', queryStart);
  const queryBranch = queryStart < 0 || queryEnd < 0 ? '' : bridge.slice(queryStart, queryEnd);
  if (!queryBranch || !/SembleIndex\.load_from_disk\(/.test(queryBranch) || /\.save\(|SembleIndex\.from_path\(|download/i.test(queryBranch)) findings.push('G43.1: query must use the public read API only');
  return findings;
}

function providerRuntimeFindings(provider: any) {
  const findings: any = [];
  if (!/HF_HUB_OFFLINE:\s*'1'/.test(provider) || !/TRANSFORMERS_OFFLINE:\s*'1'/.test(provider)) findings.push('G43.1: runtime does not force model libraries offline');
  if (!/SEMBLE_CACHE_LOCATION:\s*request\.action === 'query' \? temp : paths\.cache/.test(provider)) findings.push('G43.1: provider cache is not redirected to declared project-local locations');
  if (!/shell:\s*false/.test(provider)) findings.push('G43.1: provider subprocess does not disable shell interpretation');
  if (!/statsBytes:\s*65536/.test(provider)) findings.push('G43.1: query statistics sink has no declared byte cap');
  return findings;
}

function reservationFindings(protocol: any, preconditions: any) {
  const findings: any = [];
  if (!/const ID = ['"]hybrid-c-v1['"]/.test(protocol)) findings.push('G43.2: separate hybrid-c-v1 protocol id is missing');
  if (!/const CONFIGS = \['A', 'B', 'C'\]/.test(protocol) || !/const CORPORA = \['code', 'guidance'\]/.test(protocol)) findings.push('G43.2: C reservation does not cover A/B/C and both corpora');
  const reserveAt = preconditions.indexOf('reserveSixSlots(');
  const decryptAt = preconditions.indexOf('sealLib.decrypt(');
  if (reserveAt < 0 || decryptAt < 0 || reserveAt > decryptAt) findings.push('G43.2: six-slot reservation does not precede decryption');
  if (!/releaseBeforeEvaluation\(\{\s*repoRoot,\s*reservation\s*\}\)/.test(preconditions)) findings.push('G43.2: failed pre-evaluation checks do not use audited reservation release');
  return findings;
}

function gateFindings(gate: any) {
  const findings: any = [];
  if (!/const PROTOCOL = ['"]hybrid-c-v1['"]/.test(gate)) findings.push('G43.3: gate is not scoped to hybrid-c-v1');
  if (!/\['T-005', 'T-006'\][\s\S]*?verdict: 'UNREACHED'/.test(gate)) findings.push('G43.3: paid T-005/T-006 are not explicitly unreached');
  if (!/every\(\(r\) => r\.verdict === 'PASS'\)/.test(gate)) findings.push('G43.3: overall gate can pass without every threshold passing');
  if (!/incomplete/.test(gate)) findings.push('G43.3: incomplete promotion state is not reported');
  return findings;
}

function one(findings: any, expected: any) {
  assert.equal(findings.length, 1, `expected ${expected} as one finding, got:\n- ${findings.join('\n- ')}`);
  assert.match(findings[0], expected);
}

test('G43.1: pinned provider boundary is public, bounded, offline and query-read-only', () => {
  assert.deepEqual(providerFindings(read('src/runtime/knowledge/semble-bridge.py')), []);
  assert.deepEqual(providerRuntimeFindings(read('src/runtime/knowledge/semble-provider.ts')), []);
});

test('G43.1 control: provider API, ordering, network, write and query mutation violations are named', () => {
  const bridge = read('src/runtime/knowledge/semble-bridge.py');
  for (const [mutate, expected] of [
    [(s: any) => s.replace('VERSION = "0.7.0"', 'VERSION = "0.6.1"'), /pin Semble/],
    [(s: any) => s.replace('SembleIndex.load_from_disk(Path(request["indexPath"]))', 'SembleIndex.from_path(Path(request["indexPath"]))'), /public read API/],
    [(s: any) => s.replace('top_k=200, alpha=1.0, rerank=False', 'top_k=500, alpha=0.5, rerank=True'), /bounded dense-only/],
    [(s: any) => s.replace('        # Public scores are provider-native distinct ranks; sorting them cannot\n        # recover dense ties hidden inside Semble. Preserve the returned order.\n', ''), /preserve provider-native order/],
    [(s: any) => s.replace('    sys.addaudithook(audit)', ''), /network and write-boundary/],
    [(s: any) => s.replace('        results = index.search(request["query"], top_k=200, alpha=1.0, rerank=False)', '        index.save(Path(request["indexPath"]))\n        results = index.search(request["query"], top_k=200, alpha=1.0, rerank=False)'), /public read API/],
  ] as [(s: any) => any, RegExp][]) one(providerFindings((mutate as any)(bridge)), expected);
});

test('G43.1 runtime control: online mode, global cache, shell and unbounded statistics are named', () => {
  const provider = read('src/runtime/knowledge/semble-provider.ts');
  for (const [mutate, expected] of [
    [(s: any) => s.replace("HF_HUB_OFFLINE: '1'", "HF_HUB_OFFLINE: '0'"), /force model libraries offline/],
    [(s: any) => s.replace("SEMBLE_CACHE_LOCATION: request.action === 'query' ? temp : paths.cache", "SEMBLE_CACHE_LOCATION: process.env.HOME"), /project-local locations/],
    [(s: any) => s.replace('shell: false', 'shell: true'), /disable shell interpretation/],
    [(s: any) => s.replace('statsBytes: 65536', 'statsBytes: Infinity'), /byte cap/],
  ] as [(s: any) => any, RegExp][]) one(providerRuntimeFindings((mutate as any)(provider)), expected);
});

test('G43.2: C reserves six aggregate slots before decrypt and records only audited release', () => {
  assert.deepEqual(reservationFindings(read('bench/retrieval/lib/hybrid-protocol.ts'), read('bench/retrieval/lib/verbs/holdout-preconditions.ts')), []);
});

test('G43.2 control: old protocol identity, incomplete slots, late reserve and unaudited release are named', () => {
  const protocol = read('bench/retrieval/lib/hybrid-protocol.ts');
  const preconditions = read('bench/retrieval/lib/verbs/holdout-preconditions.ts');
  for (const [mutate, expected] of [
    [(s: any) => s.replace("const ID = 'hybrid-c-v1'", "const ID = 'legacy-ab'"), /protocol id/],
    [(s: any) => s.replace("const CONFIGS = ['A', 'B', 'C']", "const CONFIGS = ['A', 'B']"), /A\/B\/C/],
    [(s: any) => s.replace('    try { reservation = hybridProtocol.reserveSixSlots({ repoRoot, snapshotId: snapshot.snapshotId, sealMeta, resultFiles: ever }); }\n    catch (error: any) { return fail(\'f\', error.message); }\n  }\n  // (d)', '  }\n  // (d)'), /reservation does not precede decryption/],
    [(s: any) => s.replace('hybridProtocol.releaseBeforeEvaluation({ repoRoot, reservation });', 'fs.rmSync(reservation.reservation);'), /audited reservation release/],
  ] as [(s: any) => any, RegExp][]) one(reservationFindings((mutate as any)(protocol), (mutate as any)(preconditions)), expected);
});

test('G43.3: gate scope and promotion output preserve unresolved and paid-evidence gaps', () => {
  assert.deepEqual(gateFindings(read('bench/retrieval/lib/hybrid-gate.ts')), []);
});

test('G43.3 control: wrong protocol, paid pass, partial threshold pass and missing incomplete status are named', () => {
  const gate = read('bench/retrieval/lib/hybrid-gate.ts');
  for (const [mutate, expected] of [
    [(s: any) => s.replace("const PROTOCOL = 'hybrid-c-v1'", "const PROTOCOL = 'legacy-ab'"), /gate is not scoped/],
    [(s: any) => s.replace("return { id: threshold.id, verdict: 'UNREACHED', cause: 'paid measurement requires separate authorization' };", "return { id: threshold.id, verdict: 'PASS' };"), /paid T-005/],
    [(s: any) => s.replace("rows.every((r) => r.verdict === 'PASS')", "rows.some((r) => r.verdict === 'PASS')"), /every threshold/],
    [(s: any) => s.replace("'incomplete: T-005/T-006 require separate paid evidence' : 'incomplete'", "'complete' : 'complete'"), /incomplete promotion/],
  ] as [(s: any) => any, RegExp][]) one(gateFindings((mutate as any)(gate)), expected);
});
