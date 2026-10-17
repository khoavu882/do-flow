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
