'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { admitCodeCorpus } = require('../../src/runtime/knowledge/code-corpus.ts');
const { searchCodeLexical } = require('../../src/runtime/knowledge/code-lexical.ts');
const { executeCodeRetrieval } = require('../../src/runtime/knowledge/code-retrieval.ts');
const { handleRetrievalPlanCommand } = require('../../src/runtime/retrieval-plan.ts');
const { readPlan } = require('../../src/runtime/retrieval-record.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const router = { capabilities: {
  'code.exact-search': { providers: [{ id: 'native.rg' }] },
  'code.semantic-search': { providers: [{ id: 'semble.search' }, { id: 'native.rg' }] },
} };

function fixture(t) {
  const root = tempDir(t, 'doflow-code-retrieval-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/auth.js'), 'function parseToken(value) {\n  return refreshCredentials(value);\n}\n');
  const inventory = admitCodeCorpus({ root, files: ['src/auth.js'] });
  return { root, inventory };
}

function declare(root, taskId, need) {
  const log = console.log; console.log = () => {};
  try { return handleRetrievalPlanCommand({ taskId, action: 'declare', need, repoRoot: REPO_ROOT, stateRoot: root, json: true }); }
  finally { console.log = log; }
}

test('exact query is deterministic, live validated and never invokes Semble', async (t) => {
  const f = fixture(t); let semanticCalls = 0;
  const result = await executeCodeRetrieval({ query: 'parseToken', root: f.root, profile: 'hybrid', providers: {
    router, inventory: f.inventory,
    semanticQuery: async () => { semanticCalls += 1; throw new Error('exact query must not invoke Semble'); },
  } });
  assert.equal(result.exit, 0);
  assert.equal(result.response.queryClass, 'exact');
  assert.equal(result.response.effectiveProfile, 'lexical-only');
  assert.equal(semanticCalls, 0);
  assert.equal(result.response.results.length, 1);
  assert.deepEqual(result.response.results[0].locator, { file: 'src/auth.js', line: 1, endLine: 1 });
  assert.equal(result.response.absenceEstablished, false);
});

test('conceptual hybrid provider fault is preserved and followed by a distinct lexical fallback', async (t) => {
  const f = fixture(t); let lexicalCalls = 0;
  const result = await executeCodeRetrieval({ query: 'refresh user credentials', root: f.root, profile: 'hybrid', modelPath: '/fake/model', providers: {
    router, inventory: f.inventory,
    lexicalSearch: (options) => { lexicalCalls += 1; return searchCodeLexical(options); },
    semanticQuery: async () => ({ ok: false, reason: 'provider-unavailable', freshness: 'UNKNOWN', candidates: [] }),
  } });
  assert.equal(result.exit, 0);
  assert.equal(result.response.queryClass, 'conceptual');
  assert.equal(result.response.effectiveProfile, 'lexical-only');
  assert.equal(lexicalCalls, 2);
  assert.deepEqual(result.response.attempts.map((a) => a.provider), ['native.rg', 'semble.search', 'native.rg']);
  assert.notEqual(result.response.attempts[0].retrievalAttemptId, result.response.attempts[2].retrievalAttemptId);
  assert.equal(result.response.gaps[0].reason, 'provider-unavailable');
  assert.ok(result.response.results.length > 0);
  const lexicalOrigins = result.response.results[0].origins.filter((origin) => origin.provider === 'native.rg');
  assert.equal(lexicalOrigins.length, 2, 'same provider keeps both attempt origins without a second rank vote');
  assert.equal(result.response.absenceEstablished, false);
});

test('task binding is rejected before corpus/provider work and ad hoc calls stay unbound', async (t) => {
  const f = fixture(t); let calls = 0;
  const invalid = await executeCodeRetrieval({ query: 'parseToken', root: f.root, taskId: 'no-plan', need: 'missing', providers: {
    router, inventory: f.inventory, lexicalSearch: () => { calls += 1; return { candidates: [], complete: true }; },
  } });
  assert.equal(invalid.exit, 2);
  assert.equal(calls, 0);
  const adhoc = await executeCodeRetrieval({ query: 'parseToken', root: f.root, providers: { router, inventory: f.inventory } });
  assert.equal(adhoc.exit, 0);
  assert.equal(adhoc.response.queryRef, null);
  assert.equal(adhoc.response.activeTaskAttemptRef, null);
  assert.equal(fs.existsSync(path.join(f.root, '.doflow', 'state', 'evidence')), false);
});

test('declared need capability is checked before provider execution', async (t) => {
  const f = fixture(t); const taskId = 't-capability-mismatch';
  const declared = declare(f.root, taskId, 'locate-concept');
  assert.equal(declared, 0);
  let calls = 0;
  const result = await executeCodeRetrieval({ query: 'parseToken', root: f.root, taskId, need: 'locate-concept', providers: {
    router, inventory: f.inventory, lexicalSearch: () => { calls += 1; return { candidates: [], complete: true }; },
  } });
  assert.equal(result.exit, 2);
  assert.equal(result.response.error, 'capability-mismatch');
  assert.equal(calls, 0);
});

test('semantic failure is appended to the existing retrieval plan with its original provider identity', async (t) => {
  const f = fixture(t); const taskId = 't-semantic-fault';
  assert.equal(declare(f.root, taskId, 'locate-concept'), 0);
  const result = await executeCodeRetrieval({ query: 'refresh user credentials', root: f.root, taskId, need: 'locate-concept', profile: 'hybrid', modelPath: '/fake/model', providers: {
    router, inventory: f.inventory,
    semanticQuery: async () => ({ ok: false, reason: 'provider-error', freshness: 'STALE', candidates: [] }),
  } });
  assert.equal(result.exit, 0);
  const attempts = readPlan(f.root, taskId).needs[0].attempts;
  const semantic = attempts.find((attempt) => attempt.provider === 'semble.search');
  assert.ok(semantic);
  assert.equal(semantic.status, 'UNREACHED');
  assert.equal(semantic.reason, 'policy-bypass');
  assert.equal(semantic.indexState, 'STALE');
  assert.equal(result.response.attempts.find((a) => a.provider === 'semble.search').recordedAttempt.n, semantic.n);
});

test('explicit index action calls lifecycle only and rejects simultaneous query', async (t) => {
  const f = fixture(t); let calls = 0;
  const providers = { router, inventory: f.inventory, lifecycle: async ({ action, modelPath }) => {
    calls += 1; assert.equal(action, 'build'); assert.equal(modelPath, '/fake/model');
    return { ok: true, action, complete: true, generation: 'g1' };
  } };
  const result = await executeCodeRetrieval({ root: f.root, scope: 'code', indexAction: 'build', modelPath: '/fake/model', providers });
  assert.equal(result.exit, 0);
  assert.equal(result.response.complete, true);
  assert.equal(calls, 1);
  const invalid = await executeCodeRetrieval({ root: f.root, query: 'parseToken', indexAction: 'refresh', modelPath: '/fake/model', providers });
  assert.equal(invalid.exit, 2);
  assert.equal(calls, 1);
});

test('a lexical bound hit is reported with its bounds cause, never as provider-error', async (t) => {
  const root = fs.realpathSync(require('../helper/tmp').tempDir(t, 'doflow-code-retrieval-bound-'));
  fs.writeFileSync(path.join(root, 'many.js'), Array.from({ length: 205 }, (_, i) => `parseToken(${i});`).join('\n') + '\n');
  const inventory = admitCodeCorpus({ root, files: ['many.js'] });
  const result = await executeCodeRetrieval({ query: 'parseToken', root, providers: { router, inventory } });
  assert.equal(result.exit, 0);
  assert.equal(result.response.attempts[0].reason, 'candidate-limit');
  assert.deepEqual(result.response.gaps.filter((g) => g.source === 'lexical'), [{ provider: 'native.rg', reason: 'candidate-limit', source: 'lexical' }]);
  assert.equal(JSON.stringify(result.response).includes('provider-error'), false);
  assert.equal(result.response.coverage.complete, false, 'a bound still leaves coverage partial');
  assert.ok(result.response.results.length > 0);
});

test('bounds cause control: real lexical faults stay provider-error, deadlines stay timeouts, on both lexical paths', async (t) => {
  const { lexicalOutcome } = require('../../src/runtime/knowledge/code-retrieval.ts');
  const out = (...reasons) => lexicalOutcome({ complete: false, rejections: reasons.map((reason) => ({ reason })) });
  assert.deepEqual(lexicalOutcome({ complete: true, rejections: [] }), { failure: null, bound: null });
  assert.deepEqual(out('output-byte-limit'), { failure: null, bound: 'output-byte-limit' });
  assert.deepEqual(out('read-byte-limit', 'candidate-limit'), { failure: null, bound: 'read-byte-limit' });
  assert.deepEqual(out('symlink'), { failure: 'provider-error', bound: null });
  assert.deepEqual(out('candidate-limit', 'source-changed'), { failure: 'provider-error', bound: null }, 'a fault beside a bound is still a fault');
  assert.deepEqual(out('candidate-limit', 'deadline'), { failure: 'provider-timeout', bound: null });
  assert.deepEqual(out(), { failure: 'provider-error', bound: null });
  const f = fixture(t);
  const faulty = () => ({ candidates: [], complete: false, rejections: [{ reason: 'not-regular-file' }], accounting: {}, coverage: { complete: false } });
  const result = await executeCodeRetrieval({ query: 'refresh user credentials', root: f.root, profile: 'hybrid', modelPath: '/fake/model', providers: {
    router, inventory: f.inventory, lexicalSearch: faulty,
    semanticQuery: async () => ({ ok: false, reason: 'provider-unavailable', freshness: 'UNKNOWN', candidates: [] }) } });
  assert.deepEqual(result.response.attempts.map((a) => a.reason), ['provider-error', 'provider-unavailable', 'provider-error']);
  assert.deepEqual(result.response.gaps.map((g) => `${g.source}:${g.reason}`), ['lexical:provider-error', 'semantic:provider-unavailable', 'fallback:provider-error']);
});

// R4 (c): an exact request in a fresh process loads no semantic provider/lifecycle module, spawns
// nothing but the git inventory and creates no semantic state (the lock lives under .doflow/index).
const PROBE = String.raw`'use strict';
const cp = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path');
const spawned = [];
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
  const original = cp[name]; cp[name] = function (cmd, ...rest) { spawned.push(path.basename(String(cmd))); return original.call(this, cmd, ...rest); };
}
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const { executeCodeRetrieval } = require(input.modulePath);
executeCodeRetrieval(input.options).then((out) => process.stdout.write(JSON.stringify({ queryClass: out.response.queryClass,
  results: (out.response.results || []).length, attempts: out.response.attempts, spawned,
  loaded: Object.keys(require.cache).map((k) => path.basename(k)).filter((k) => /^semble-/.test(k)),
  state: fs.existsSync(path.join(input.options.root, '.doflow')) })));`;

function probe(t, query, profile) {
  const root = fs.realpathSync(tempDir(t, 'doflow-code-exact-probe-'));
  const model = fs.realpathSync(tempDir(t, 'doflow-code-exact-model-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/auth.js'), 'function parseToken(value) {\n  return refreshCredentials(value);\n}\n');
  const modulePath = path.resolve(__dirname, '../../src/runtime/knowledge/code-retrieval.ts');
  const run = require('node:child_process').spawnSync(process.execPath, ['-e', PROBE], { encoding: 'utf8',
    input: JSON.stringify({ modulePath, options: { root, query, profile, modelPath: model, top: 5 } }), env: { ...process.env, SEMBLE_MODEL_PATH: model } });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('R4c: exact under a hybrid request with a model path loads no Semble module, spawns only git and creates no semantic state', (t) => {
  for (const query of ['parseToken', '"function parseToken"']) {
    const out = probe(t, query, 'hybrid');
    assert.equal(out.queryClass, 'exact');
    assert.equal(out.results, 1);
    assert.deepEqual(out.loaded, [], 'semble-provider.ts / semble-lifecycle.ts are never imported');
    assert.deepEqual([...new Set(out.spawned)], ['git'], 'no Python bridge or interpreter probe');
    assert.equal(out.state, false, 'no .doflow index state or semantic lock');
    assert.deepEqual(out.attempts.map((a) => a.provider), ['native.rg']);
  }
});

test('R4c control: a conceptual hybrid request does import the Semble provider (the probe detects semantic loading)', (t) => {
  const out = probe(t, 'where are user credentials refreshed', 'hybrid');
  assert.equal(out.queryClass, 'conceptual');
  assert.ok(out.loaded.includes('semble-provider.ts'), JSON.stringify(out.loaded));
  assert.ok(out.attempts.some((a) => a.provider === 'semble.search'));
});

// R5 (DEC-020): exact admits without per-file hashes and reads each file once; every delivered candidate is
// still hashed on its live read, and every containment, change, ignore and size check still refuses.
const crypto = require('node:crypto');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function exactWorld(t, extra = {}) {
  const root = fs.realpathSync(tempDir(t, 'doflow-code-exact-r5-'));
  const files = { 'src/a.js': 'const x = 1;\nfunction loadRegistry() {}\n', 'src/b.js': 'nothing here\n', ...extra };
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), body); }
  return root;
}
async function exactRun(root, query, more = {}) {
  const inventories = [];
  const admit = (o) => { const inv = admitCodeCorpus(o); inventories.push(inv); return inv; };
  const out = await executeCodeRetrieval({ query, root, ...more, providers: { router, admitCodeCorpus: admit, ...(more.providers || {}) } });
  return { response: out.response, inventory: inventories[0], hits: out.response.results.map((r) => `${r.locator.file}:${r.locator.line}`) };
}

test('R5: exact admits unhashed and hashes each delivered candidate on its live read; conceptual keeps full hashing', async (t) => {
  const root = exactWorld(t);
  const exact = await exactRun(root, '"function loadRegistry"');
  assert.deepEqual(exact.hits, ['src/a.js:2']);
  assert.ok(exact.inventory.files.every((f) => f.fileHash === null), 'no per-file sha256 at admission');
  assert.equal(exact.response.results[0].sourceVersion.fileHash, sha(path.join(root, 'src/a.js')));
  assert.equal(exact.response.results[0].liveRead.startLine, 2);
  const conceptual = await exactRun(root, 'where is the registry loaded');
  assert.equal(conceptual.response.queryClass, 'conceptual');
  assert.ok(conceptual.inventory.files.every((f) => /^[0-9a-f]{64}$/.test(f.fileHash)), 'conceptual admission still hashes every file');
});

test('R5 control: a file changed after the exact pass is rejected by live validation, not delivered', async (t) => {
  const root = exactWorld(t);
  const lexicalSearch = (o) => { const out = searchCodeLexical(o); fs.appendFileSync(path.join(root, 'src/a.js'), '// edited\n'); return out; };
  const run = await exactRun(root, '"function loadRegistry"', { providers: { lexicalSearch } });
  assert.deepEqual(run.hits, []);
  assert.ok(run.response.gaps.some((g) => g.source === 'live-validation' && g.reason === 'source-changed'));
});

test('R5 control: a directory swapped for a symlink during the exact pass drops what was read under it', (t) => {
  const root = exactWorld(t);
  const inventory = admitCodeCorpus({ root, hashFiles: false, verifyDirsOnce: true });
  let swapped = false;
  const fsImpl = { ...fs, readSync: (...args) => {
    const n = fs.readSync(...args);
    if (!swapped) { swapped = true; fs.renameSync(path.join(root, 'src'), path.join(root, 'src-moved')); fs.symlinkSync(path.join(root, 'src-moved'), path.join(root, 'src')); }
    return n;
  } };
  const out = searchCodeLexical({ inventory, query: '"function loadRegistry"', fsImpl });
  assert.equal(swapped, true);
  assert.deepEqual(out.candidates, []);
  assert.equal(out.complete, false);
  assert.ok(out.rejections.some((r) => r.path === 'src/a.js' && r.reason === 'source-changed'));
});

test('R5 control: exact still refuses symlinks, symlinked directories, escapes, ignored files and oversized files', async (t) => {
  const outside = fs.realpathSync(tempDir(t, 'doflow-code-exact-outside-'));
  fs.mkdirSync(path.join(outside, 'dir'));
  fs.writeFileSync(path.join(outside, 'secret.js'), 'function loadRegistry() { leak }\n');
  fs.writeFileSync(path.join(outside, 'dir', 'c.js'), 'function loadRegistry() { leak }\n');
  const root = exactWorld(t, { 'gen/out.js': 'function loadRegistry() { ignored }\n', 'big/huge.js': `function loadRegistry() {}\n${'x'.repeat(200)}\n`, '.sembleignore': 'gen/\n' });
  fs.symlinkSync(path.join(outside, 'secret.js'), path.join(root, 'src', 'link.js'));
  fs.symlinkSync(path.join(outside, 'dir'), path.join(root, 'linkdir'));
  const run = await exactRun(root, '"function loadRegistry"', { corpusLimits: { maxFileBytes: 100 } });
  assert.deepEqual(run.hits, ['src/a.js:2'], 'only the in-root regular, unignored, in-cap file');
  assert.equal(run.response.coverage.corpusComplete, false);
  const reasons = Object.fromEntries(run.inventory.skipped.map((s) => [s.path, s.reason]));
  assert.equal(reasons['src/link.js'], 'not-regular-file');
  assert.equal(reasons['big/huge.js'], 'file-byte-limit');
  assert.equal(run.inventory.files.some((f) => f.path.startsWith('gen/')), false);
  // Paths an inventory never admits are refused again at read time.
  const throughDir = admitCodeCorpus({ root, files: ['linkdir/c.js', 'src/a.js'], hashFiles: false, verifyDirsOnce: true });
  assert.deepEqual(throughDir.files.map((f) => f.path), ['src/a.js']);
  assert.equal(throughDir.skipped[0].reason, 'not-regular-file');
  const forged = { ...throughDir, files: [...throughDir.files, { path: 'linkdir/c.js' }, { path: '../secret.js' }] };
  const lex = searchCodeLexical({ inventory: forged, query: '"function loadRegistry"' });
  assert.deepEqual(lex.candidates.map((c) => c.locator.file), ['src/a.js']);
  assert.deepEqual(lex.rejections.map((r) => r.reason).sort(), ['invalid-path', 'symlink']);
});

// DEC-025 through the production coordinator: conceptual hybrid fuses by file with D = requested top.
function grainWorld(t, count, lines = 30) {
  const root = fs.realpathSync(tempDir(t, 'doflow-code-retrieval-grain-'));
  const names = Array.from({ length: count }, (_, i) => `src/f${String(i + 1).padStart(3, '0')}.js`);
  fs.mkdirSync(path.join(root, 'src'));
  for (const name of names) fs.writeFileSync(path.join(root, name), Array.from({ length: lines }, (_, i) => `// ${name} ${i + 1}`).join('\n') + '\n');
  const inventory = admitCodeCorpus({ root, files: names });
  const hash = Object.fromEntries(inventory.files.map((f) => [f.path, f.fileHash]));
  return { root, names, inventory, hash };
}
const injectedLexical = (w, names, line = 6) => () => ({ complete: true, rejections: [], coverage: { complete: true }, accounting: {},
  candidates: names.map((file) => ({ locator: { file, line, endLine: line }, sourceVersion: { gitCommit: null, fileHash: w.hash[file], isDirty: null } })) });
const injectedSemantic = (w, names, { endLine = 20 } = {}) => async () => ({ ok: true, freshness: 'FRESH',
  candidates: names.map((file) => ({ locator: { file, line: 1, endLine }, score: 1, indexedSourceIdentity: w.hash[file] })) });
const conceptual = (w, top, providers, profile = 'hybrid') => executeCodeRetrieval({ query: 'where are tokens refreshed', root: w.root, top, profile,
  modelPath: '/fake/model', providers: { router, inventory: w.inventory, ...providers } }).then((r) => r.response);
const stripRefs = (results) => JSON.parse(JSON.stringify(results, (key, value) => (key === 'retrievalAttemptRef' ? 'ref' : value)));

test('DEC-025 coordinator 12-file probe: hybrid top 10 reaches 10 distinct files with both origins (HEAD: 5)', async (t) => {
  const w = grainWorld(t, 12);
  const response = await conceptual(w, 10, { lexicalSearch: injectedLexical(w, w.names), semanticQuery: injectedSemantic(w, w.names) });
  assert.equal(response.effectiveProfile, 'hybrid');
  assert.deepEqual(response.results.map((r) => r.locator.file), w.names.slice(0, 10));
  assert.ok(response.results.every((r) => r.locator.line === 1 && r.locator.endLine === 20 && r.origins.length === 2));
  assert.deepEqual(response.gaps, []);
});

test('DEC-025 top-k and 200-examined bounds hold at file grain; one live read per examined file', async (t) => {
  const w = grainWorld(t, 300, 3);
  // Every semantic hash is stale, so each merged or semantic-only file is rejected and examination runs to the cap.
  const response = await conceptual(w, 25, { lexicalSearch: injectedLexical(w, w.names.slice(0, 150), 2),
    semanticQuery: async () => ({ ok: true, freshness: 'FRESH', candidates: w.names.map((file) => ({ locator: { file, line: 1, endLine: 3 }, indexedSourceIdentity: '0'.repeat(64) })) }) });
  assert.equal(response.results.length, 0, 'no lexical span slips through on its own slot (HEAD delivers them)');
  assert.equal(response.coverage.live.examinedCandidates, 200);
  assert.equal(response.gaps.filter((g) => g.source === 'live-validation' && g.reason === 'source-changed').length, 200);
  assert.deepEqual(response.gaps.find((g) => g.source === 'fusion'), { source: 'fusion', reason: 'candidate-limit', count: 100 });
  const size = fs.statSync(path.join(w.root, w.names[0])).size;
  assert.ok(w.inventory.files.every((f) => f.sizeBytes === size));
  assert.equal(response.accounting.liveReadBytes, 200 * size, 'one read per examined file');
  const capped = await conceptual(w, 25, { lexicalSearch: injectedLexical(w, w.names.slice(0, 150), 2), semanticQuery: injectedSemantic(w, w.names, { endLine: 3 }) });
  assert.equal(capped.results.length, 25);
  assert.equal(new Set(capped.results.map((r) => r.locator.file)).size, 25);
});

test('DEC-025 a stale semantic origin on an agreed file rejects that file as source-changed, counted, with no refill past the window', async (t) => {
  const w = grainWorld(t, 3);
  const response = await conceptual(w, 2, { lexicalSearch: injectedLexical(w, w.names),
    semanticQuery: async () => ({ ok: true, freshness: 'FRESH', candidates: w.names.map((file) => ({ locator: { file, line: 1, endLine: 20 },
      indexedSourceIdentity: file === w.names[0] ? '0'.repeat(64) : w.hash[file] })) }) });
  assert.deepEqual(response.results.map((r) => r.locator.file), [w.names[1], w.names[2]]);
  assert.deepEqual(response.gaps, [{ source: 'live-validation', reason: 'source-changed' }]);
});

test('DEC-025 an invalid secondary origin is a live-validation-origin gap; bench rawValidity is unchanged', async (t) => {
  const w = grainWorld(t, 2);
  const response = await conceptual(w, 5, { lexicalSearch: injectedLexical(w, w.names, 999), semanticQuery: injectedSemantic(w, w.names) });
  assert.equal(response.results.length, 2);
  assert.deepEqual(response.gaps.map((g) => `${g.source}:${g.reason}:${g.provider}`), ['live-validation-origin:line-out-of-range:native.rg', 'live-validation-origin:line-out-of-range:native.rg']);
  assert.equal(response.coverage.complete, false);
  const { mapCodeResponse } = require('../../bench/retrieval/lib/adapters-c.js');
  const mapped = mapCodeResponse({ exit: 0, response });
  assert.deepEqual([mapped.rawValidity.raw, mapped.rawValidity.delivered, mapped.rawValidity.rejected], [2, 2, 0]);
});

test('DEC-025 exact keeps span grain: two matching lines in one file stay two results and Semble is never invoked', async (t) => {
  const root = fs.realpathSync(tempDir(t, 'doflow-code-retrieval-exact-grain-'));
  fs.writeFileSync(path.join(root, 'a.js'), 'parseToken(1);\nother();\nparseToken(2);\n');
  const inventory = admitCodeCorpus({ root, files: ['a.js'] });
  let semanticCalls = 0;
  const { response } = await executeCodeRetrieval({ query: 'parseToken', root, top: 5, profile: 'hybrid', modelPath: '/fake/model',
    providers: { router, inventory, semanticQuery: async () => { semanticCalls += 1; return { ok: true, freshness: 'FRESH', candidates: [] }; } } });
  assert.equal(semanticCalls, 0);
  assert.deepEqual(response.results.map((r) => [r.id, r.locator.line]), [[JSON.stringify([inventory.identity, 'a.js', 1, 1]), 1], [JSON.stringify([inventory.identity, 'a.js', 3, 3]), 3]]);
  assert.ok(response.results.every((r) => r.origins.every((o) => !('locator' in o))), 'exact origins are unchanged');
});

test('DEC-025 lexical-only conceptual output is unchanged: span ids, one slot per lexical span, no origin locators', async (t) => {
  const w = grainWorld(t, 4);
  const base = injectedLexical(w, w.names)();
  const extra = { locator: { file: w.names[0], line: 9, endLine: 9 }, sourceVersion: { fileHash: w.hash[w.names[0]] } };
  const response = await conceptual(w, 10, { lexicalSearch: () => ({ ...base, candidates: [...base.candidates, extra] }) }, 'lexical-only');
  const spans = [...w.names.map((f) => [f, 6]), [w.names[0], 9]];
  assert.deepEqual(response.results.map((r) => r.id), spans.map(([f, l]) => JSON.stringify([w.inventory.identity, f, l, l])), 'two spans on one file keep two slots');
  assert.deepEqual(response.results.map((r) => r.rrfScore), spans.map((_, i) => 1 / (61 + i)));
  assert.ok(response.results.every((r) => r.origins.length === 1 && !('locator' in r.origins[0])));
});

test('DEC-025 empty semantic answer: hybrid profile, results identical to lexical-only, no false absence', async (t) => {
  const w = grainWorld(t, 4);
  const lexicalSearch = injectedLexical(w, w.names);
  const hybrid = await conceptual(w, 10, { lexicalSearch, semanticQuery: async () => ({ ok: true, freshness: 'FRESH', candidates: [] }) });
  const lexical = await conceptual(w, 10, { lexicalSearch }, 'lexical-only');
  assert.equal(hybrid.effectiveProfile, 'hybrid');
  assert.deepEqual(stripRefs(hybrid.results), stripRefs(lexical.results));
  assert.equal(hybrid.absenceEstablished, false);
});

test('DEC-025 semantic fault fallback: lexical-only profile, attempt order kept, same delivered order and spans as lexical-only', async (t) => {
  const w = grainWorld(t, 4);
  const lexicalSearch = injectedLexical(w, [...w.names].reverse());
  const fault = await conceptual(w, 10, { lexicalSearch, semanticQuery: async () => ({ ok: false, reason: 'provider-unavailable', freshness: 'UNKNOWN', candidates: [] }) });
  const lexical = await conceptual(w, 10, { lexicalSearch }, 'lexical-only');
  assert.equal(fault.effectiveProfile, 'lexical-only');
  assert.deepEqual(fault.attempts.map((a) => a.provider), ['native.rg', 'semble.search', 'native.rg']);
  assert.deepEqual(fault.results.map((r) => [r.id, r.locator]), lexical.results.map((r) => [r.id, r.locator]));
  assert.equal(fault.absenceEstablished, false);
});
