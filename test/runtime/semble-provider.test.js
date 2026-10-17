'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { admitCodeCorpus } = require('../../src/runtime/knowledge/code-corpus.ts');
const { runSembleQuery, semanticStatePaths, digest } = require('../../src/runtime/knowledge/semble-provider.ts');
const { runSembleLifecycle } = require('../../src/runtime/knowledge/semble-lifecycle.ts');

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'semble-provider-')));
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const modelPath = path.join(base, 'model'); fs.mkdirSync(modelPath);
  for (const file of ['config.json', 'tokenizer.json', 'model.safetensors']) fs.writeFileSync(path.join(modelPath, file), '{}');
  fs.writeFileSync(path.join(root, 'a.py'), 'answer = 42\n');
  fs.writeFileSync(path.join(root, 'z.py'), 'result = 42\n');
  const pkg = path.join(base, 'python');
  execFileSync('python3', [path.join(__dirname, 'fixtures/semble-provider-fake.py'), pkg]);
  const prior = process.env.PYTHONPATH; process.env.PYTHONPATH = pkg;
  t.after(() => { if (prior === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = prior; delete process.env.FAKE_PROVIDER_MODE; delete process.env.FAKE_OUTSIDE_PATH; fs.rmSync(base, { recursive: true, force: true }); });
  const inventory = admitCodeCorpus({ root, files: ['a.py', 'z.py'] });
  return { base, root, modelPath, inventory, options: { inventory, modelPath, python: 'python3' } };
}

test('public bridge builds then queries bounded semantic top-k, preserves provider order and never saves query index', async t => {
  const f = fixture(t); const built = await runSembleLifecycle({ ...f.options, action: 'build' });
  assert.equal(built.ok, true, JSON.stringify(built));
  const paths = semanticStatePaths(f.inventory);
  const before = digest(fs.readFileSync(path.join(paths.index, 'metadata.json')));
  const result = await runSembleQuery({ ...f.options, query: 'find answer' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.candidates.map(c => c.locator.file), ['z.py', 'a.py']);
  assert.equal(result.accounting.sourceReadBytes, 24);
  assert.equal(digest(fs.readFileSync(path.join(paths.index, 'metadata.json'))), before);
  assert.deepEqual(fs.readdirSync(paths.state).sort(), ['cache', 'manifest.json', 'mirror']);
});

test('stale source, incomplete marker and missing model bypass before loader', async t => {
  const f = fixture(t); assert.equal((await runSembleLifecycle({ ...f.options, action: 'build' })).ok, true);
  fs.writeFileSync(path.join(f.root, 'a.py'), 'answer = 43\n');
  const stale = await runSembleQuery({ ...f.options, query: 'answer' });
  assert.equal(stale.ok, false); assert.equal(stale.freshness, 'STALE');
  const paths = semanticStatePaths(f.inventory); fs.writeFileSync(paths.marker, '{}');
  assert.equal((await runSembleQuery({ ...f.options, query: 'answer' })).reason, 'index-in-progress');
  assert.equal((await runSembleQuery({ ...f.options, modelPath: 'remote/model', query: 'answer' })).ok, false);
});

test('corrupt chunk traversal, model mismatch, index caps and locks fail honestly', async t => {
  const f = fixture(t); await runSembleLifecycle({ ...f.options, action: 'build' });
  const paths = semanticStatePaths(f.inventory);
  fs.writeFileSync(paths.lock, 'other');
  assert.equal((await runSembleQuery({ ...f.options, query: 'answer' })).reason, 'lock-contention');
  fs.unlinkSync(paths.lock);
  const chunksFile = path.join(paths.index, 'chunks.json'); const chunks = JSON.parse(fs.readFileSync(chunksFile));
  chunks[0].file_path = '../outside.py'; fs.writeFileSync(chunksFile, JSON.stringify(chunks));
  assert.equal((await runSembleQuery({ ...f.options, query: 'answer' })).reason, 'unsafe-chunk-path-or-range');
  fs.writeFileSync(path.join(f.modelPath, 'config.json'), '{"changed":true}');
  assert.equal((await runSembleQuery({ ...f.options, query: 'answer' })).freshness, 'STALE');
  assert.equal((await runSembleQuery({ ...f.options, query: 'answer', limits: { modelBytes: 1 } })).ok, false);
});

test('audit policy blocks network and writes outside state; time/output/stats failures clean sink and lock', async t => {
  const f = fixture(t); await runSembleLifecycle({ ...f.options, action: 'build' });
  process.env.FAKE_OUTSIDE_PATH = path.join(f.base, 'outside');
  for (const mode of ['network', 'outside-write', 'stats-overflow', 'sleep']) {
    process.env.FAKE_PROVIDER_MODE = mode;
    const result = await runSembleQuery({ ...f.options, query: 'answer', limits: { queryMs: mode === 'sleep' ? 80 : 10000 } });
    assert.equal(result.ok, false, mode); assert.equal(result.freshness, 'UNKNOWN');
    const paths = semanticStatePaths(f.inventory);
    assert.deepEqual(fs.readdirSync(paths.state).sort(), ['cache', 'manifest.json', 'mirror']);
  }
  assert.equal(fs.existsSync(process.env.FAKE_OUTSIDE_PATH), false);
});

test('bridge spy receives bounded top-k and exact public API flags under offline/cache controls', async t => {
  const f = fixture(t); await runSembleLifecycle({ ...f.options, action: 'build' });
  const paths = semanticStatePaths(f.inventory); const temp = fs.mkdtempSync(path.join(paths.state, 'query-'));
  const { executeBridge, SEMBLE_LIMITS } = require('../../src/runtime/knowledge/semble-provider.ts');
  const result = await executeBridge({ action: 'query', query: 'answer', indexPath: paths.index, poolSize: 2, allowedWriteRoots: [temp] }, { limits: SEMBLE_LIMITS, python: 'python3' }, paths, temp);
  assert.equal(result.ok, true);
  const calls = fs.readFileSync(path.join(temp, 'library', 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c => c.action), ['load', 'search']);
  assert.deepEqual(calls[1], { action: 'search', top_k: 200, alpha: 1, rerank: false });
});

function hfModel(base) {
  // <hub>/models--org--m/snapshots/<rev>/* -> ../../blobs/<sha>; one blob links again into <hub>/blobs (xet layout).
  const hub = path.join(base, 'hub'); const repo = path.join(hub, 'models--org--m');
  const snapshot = path.join(repo, 'snapshots', 'rev1'); const blobs = path.join(repo, 'blobs');
  fs.mkdirSync(snapshot, { recursive: true }); fs.mkdirSync(blobs); fs.mkdirSync(path.join(hub, 'blobs', 'f1'), { recursive: true });
  fs.writeFileSync(path.join(blobs, 'b-config'), '{}'); fs.writeFileSync(path.join(blobs, 'b-tok'), '{}');
  fs.writeFileSync(path.join(hub, 'blobs', 'f1', 'b-weights'), '{}');
  fs.symlinkSync('../../blobs/f1/b-weights', path.join(blobs, 'b-model'));
  fs.symlinkSync('../../blobs/b-config', path.join(snapshot, 'config.json'));
  fs.symlinkSync('../../blobs/b-tok', path.join(snapshot, 'tokenizer.json'));
  fs.symlinkSync('../../blobs/b-model', path.join(snapshot, 'model.safetensors'));
  return { hub, repo, snapshot, blobs };
}

test('F1: Hugging Face snapshot links into its own blob stores are admitted with the dereferenced identity', async t => {
  const f = fixture(t); const { inspectModel } = require('../../src/runtime/knowledge/semble-provider.ts');
  const hf = hfModel(f.base);
  const model = inspectModel(hf.snapshot);
  assert.equal(model.identity, inspectModel(f.modelPath).identity, 'same bytes and names as a dereferenced copy');
  assert.equal(model.bytes, 6);
  const built = await runSembleLifecycle({ ...f.options, modelPath: hf.snapshot, action: 'build' });
  assert.equal(built.ok, true, JSON.stringify(built));
  const result = await runSembleQuery({ ...f.options, modelPath: hf.snapshot, query: 'answer' });
  assert.equal(result.ok, true, JSON.stringify(result));
  // Target-size caps still apply to linked blobs.
  assert.equal((await runSembleQuery({ ...f.options, modelPath: hf.snapshot, query: 'answer', limits: { modelBytes: 5 } })).reason, 'resource-limit');
});

test('F1 negative controls: links escaping the blob stores, to directories, dangling, or outside HF layout stay unsafe', t => {
  const f = fixture(t); const { inspectModel } = require('../../src/runtime/knowledge/semble-provider.ts');
  const reason = (dir) => { try { inspectModel(dir); return 'admitted'; } catch (error) { return error.reason; } };
  const hf = hfModel(f.base);
  const extra = path.join(hf.snapshot, 'extra.json');
  fs.writeFileSync(path.join(f.base, 'secret.json'), 'outside');
  fs.symlinkSync(path.join(f.base, 'secret.json'), extra);
  assert.equal(reason(hf.snapshot), 'unsafe-artifact', 'escape outside blob stores');
  fs.unlinkSync(extra); fs.writeFileSync(path.join(hf.snapshot, 'peer.json'), '{}');
  fs.symlinkSync('peer.json', extra);
  assert.equal(reason(hf.snapshot), 'unsafe-artifact', 'link to a snapshot file, not a blob');
  fs.unlinkSync(extra); fs.mkdirSync(path.join(hf.blobs, 'dir'));
  fs.symlinkSync('../../blobs/dir', extra);
  assert.equal(reason(hf.snapshot), 'unsafe-artifact', 'link to a directory');
  fs.unlinkSync(extra); fs.symlinkSync('../../blobs/missing', extra);
  assert.equal(reason(hf.snapshot), 'unsafe-artifact', 'dangling link');
  fs.unlinkSync(extra); assert.equal(reason(hf.snapshot), 'admitted');
  fs.symlinkSync(path.join(f.modelPath, 'config.json'), path.join(f.modelPath, 'alias.json'));
  assert.equal(reason(f.modelPath), 'unsafe-artifact', 'plain model directories admit no links at all');
  assert.equal(reason(path.join(hf.repo, 'snapshots')), 'unsafe-artifact', 'only a snapshot revision dir gets blob roots');
});

test('F2: grammar extraction into the library cache does not trip the statistics cap; both sinks stay bounded', async t => {
  const f = fixture(t);
  process.env.FAKE_PROVIDER_MODE = 'grammar-extract';
  const built = await runSembleLifecycle({ ...f.options, action: 'build' });
  assert.equal(built.ok, true, JSON.stringify(built));
  const queried = await runSembleQuery({ ...f.options, query: 'answer' });
  assert.equal(queried.ok, true, JSON.stringify(queried));
  const paths = semanticStatePaths(f.inventory);
  assert.deepEqual(fs.readdirSync(paths.state).sort(), ['cache', 'manifest.json', 'mirror']);
  assert.equal((await runSembleQuery({ ...f.options, query: 'answer', limits: { libraryBytes: 65536 } })).reason, 'provider-resource-limit');
  process.env.FAKE_PROVIDER_MODE = 'library-overflow';
  assert.equal((await runSembleQuery({ ...f.options, query: 'answer', limits: { libraryBytes: 65536 } })).reason, 'provider-resource-limit');
  process.env.FAKE_PROVIDER_MODE = 'stats-overflow';
  assert.equal((await runSembleQuery({ ...f.options, query: 'answer' })).reason, 'provider-resource-limit');
  assert.deepEqual(fs.readdirSync(paths.state).sort(), ['cache', 'manifest.json', 'mirror']);
});

test('F2: files vanishing mid-walk are skipped only on live sinks, never mapped to a resource limit', async t => {
  const f = fixture(t); await runSembleLifecycle({ ...f.options, action: 'build' });
  const { scanTree } = require('../../src/runtime/knowledge/semble-provider.ts');
  const dir = fs.mkdtempSync(path.join(f.base, 'sink-')); fs.writeFileSync(path.join(dir, 'kept'), 'k'); fs.writeFileSync(path.join(dir, 'gone'), 'g');
  const real = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (p, ...rest) => { if (path.basename(String(p)) === 'gone') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return real(p, ...rest); });
  assert.deepEqual(scanTree(dir, 10, 8, { transient: true }).files.map(x => x.path), ['kept']);
  assert.throws(() => scanTree(dir, 10, 8), (error) => error.code === 'ENOENT' && !error.reason, 'strict scans still fail on a vanished entry');
  t.mock.restoreAll();
  process.env.FAKE_PROVIDER_MODE = 'tmp-churn';
  for (let i = 0; i < 3; i++) {
    const result = await runSembleQuery({ ...f.options, query: 'answer' });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
});

test('interpreter discovery: the semble launcher shebang names the bridge interpreter, no PATH wrapper needed', async t => {
  const f = fixture(t); const { resolveSembleInterpreter } = require('../../src/runtime/knowledge/semble-provider.ts');
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  const bin = path.join(f.base, 'bin'); fs.mkdirSync(bin);
  const launcher = path.join(bin, 'semble'); fs.writeFileSync(launcher, `#!${python}\nimport sys\n`, { mode: 0o755 });
  const home = path.join(f.base, 'home'); fs.mkdirSync(home);
  assert.deepEqual(resolveSembleInterpreter({ env: { PATH: bin }, home }), { python, launcher });
  // PATH miss falls back to ~/.local/bin/semble.
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true }); fs.copyFileSync(launcher, path.join(home, '.local', 'bin', 'semble'));
  assert.equal(resolveSembleInterpreter({ env: { PATH: path.join(f.base, 'empty') }, home }).python, python);
  // Production default: no `python` option, PATH holds only the launcher directory (python3 is not on it).
  const { python: _explicit, ...options } = f.options;
  const prior = process.env.PATH; process.env.PATH = bin; t.after(() => { process.env.PATH = prior; });
  assert.equal((await runSembleLifecycle({ ...options, action: 'build' })).ok, true);
  const result = await runSembleQuery({ ...options, query: 'answer' });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('interpreter discovery negative controls: missing launcher, env shebang, missing interpreter, wrong or absent Semble', async t => {
  const f = fixture(t); const { resolveSembleInterpreter } = require('../../src/runtime/knowledge/semble-provider.ts');
  const bin = path.join(f.base, 'bin'); fs.mkdirSync(bin); const home = path.join(f.base, 'home'); fs.mkdirSync(home);
  const cause = (env) => { try { resolveSembleInterpreter({ env, home }); return 'resolved'; } catch (error) { return `${error.reason}: ${error.cause}`; } };
  assert.match(cause({ PATH: bin }), /^provider-unavailable: no semble launcher/);
  fs.writeFileSync(path.join(bin, 'semble'), '#!/usr/bin/env python3\n', { mode: 0o755 });
  assert.match(cause({ PATH: bin }), /^provider-unavailable: .* does not name an absolute interpreter/);
  fs.writeFileSync(path.join(bin, 'semble'), `#!${path.join(f.base, 'gone', 'python3')}\n`, { mode: 0o755 });
  assert.match(cause({ PATH: bin }), /^provider-unavailable: interpreter .* is not executable/);
  // A missing launcher fails the lifecycle before any lock or mutation.
  const { python: _explicit, ...options } = f.options;
  const prior = process.env.PATH; process.env.PATH = path.join(f.base, 'empty');
  const priorHome = process.env.HOME; process.env.HOME = home;
  t.after(() => { process.env.PATH = prior; process.env.HOME = priorHome; });
  const refused = await runSembleLifecycle({ ...options, action: 'build' });
  assert.equal(refused.reason, 'provider-unavailable'); assert.match(refused.cause, /no semble launcher/);
  assert.equal(fs.existsSync(semanticStatePaths(f.inventory).state), false);
  process.env.PATH = prior; process.env.HOME = priorHome;
  // The bridge proves the pinned version and reports what it found.
  assert.equal((await runSembleLifecycle({ ...f.options, action: 'build' })).ok, true);
  const dist = path.join(process.env.PYTHONPATH, 'semble-0.6.1.dist-info');
  fs.writeFileSync(path.join(dist, 'METADATA'), 'Name: semble\nVersion: 0.7.0\n');
  const mismatch = await runSembleQuery({ ...f.options, query: 'answer' });
  assert.equal(mismatch.reason, 'provider-version-mismatch'); assert.match(mismatch.cause, /has semble 0\.7\.0; the bridge pins 0\.6\.1/);
  const paths = semanticStatePaths(f.inventory); const manifest = fs.readFileSync(paths.manifest, 'utf8');
  const preflight = await runSembleLifecycle({ ...f.options, action: 'build' });
  assert.equal(preflight.reason, 'provider-version-mismatch'); assert.match(preflight.cause, /has semble 0\.7\.0; the bridge pins 0\.6\.1/);
  assert.equal(fs.existsSync(paths.marker), false, 'a wrong version is refused before the in-progress marker');
  assert.equal(fs.readFileSync(paths.manifest, 'utf8'), manifest, 'the published generation is untouched');
  fs.rmSync(dist, { recursive: true });
  const absent = await runSembleQuery({ ...f.options, python: execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim(), query: 'answer' });
  assert.equal(absent.reason, 'provider-unavailable'); assert.match(absent.cause, /semble is not installed/);
});
