'use strict';

// Optional pinned external provider. No imports, model loads or writes occur until invoked.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const SEMBLE_VERSION = '0.6.1';
const SEMBLE_LIMITS = Object.freeze({ files: 2000, fileBytes: 1048576, sourceBytes: 67108864,
  chunks: 50000, artifactBytes: 268435456, modelBytes: 536870912, outputBytes: 2097152,
  statsBytes: 65536, libraryBytes: 134217728, queryMs: 10000, lifecycleMs: 120000, changedFiles: 500, changedBytes: 16777216 });
const digest = (value: any): string => crypto.createHash('sha256').update(value).digest('hex');
function fault(reason: string, freshness = 'UNKNOWN'): any { return Object.assign(new Error(reason), { reason, freshness }); }
function semanticStatePaths(inventory: any): any {
  const state = path.join(inventory.root, '.doflow', 'index', 'code', 'semble', digest(`${inventory.root}\n${inventory.scopeIgnoreDigest}`));
  const mirror = path.join(state, 'mirror');
  const cache = path.join(state, 'cache');
  return { root: inventory.root, state, mirror, cache, index: path.join(cache, digest(mirror), 'index'),
    manifest: path.join(state, 'manifest.json'), marker: path.join(state, 'in-progress.json'), lock: path.join(state, 'operation.lock') };
}
function inside(root: string, file: string): boolean { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
function safeDirectories(root: string, target: string, create = false): void {
  if (!inside(root, target)) throw fault('path-outside-state');
  let cursor = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try { const st = fs.lstatSync(cursor); if (!st.isDirectory() || st.isSymbolicLink()) throw fault('unsafe-state-directory'); }
    catch (error: any) { if (error.code !== 'ENOENT' || !create) throw error; fs.mkdirSync(cursor); }
  }
}
function regularBytes(file: string, max: number): any {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > max) throw fault('unsafe-or-oversized-file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const start = fs.fstatSync(fd);
    if (start.ino !== before.ino || start.dev !== before.dev) throw fault('source-changed', 'STALE');
    const buffer = Buffer.alloc(start.size + 1); const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(fd);
    if (count !== start.size || after.size !== start.size || after.mtimeMs !== start.mtimeMs || after.ctimeMs !== start.ctimeMs) throw fault('source-changed', 'STALE');
    return buffer.subarray(0, count);
  } finally { fs.closeSync(fd); }
}
// `transient` (live provider sinks only) skips entries that vanish mid-walk; `linkRoots` (model only)
// admits a symlink whose realpath is a regular file inside one of those roots, counted at its target size.
function scanTree(root: string, maxBytes: number, maxFiles = 10000, { transient = false, linkRoots = [] as string[] } = {}): any {
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw fault('unsafe-directory');
  let bytes = 0; let entries = 0; const files: any[] = [];
  const gone = (error: any) => { if (!transient || error?.code !== 'ENOENT') throw error; };
  const walk = (dir: string) => {
    let names: string[] = [];
    try { names = fs.readdirSync(dir).sort(); } catch (error: any) { gone(error); }
    for (const name of names) {
      if (++entries > maxFiles * 4 + 32) throw fault('resource-limit');
      const full = path.join(dir, name); let st: any; let real: string | undefined;
      try { st = fs.lstatSync(full); } catch (error: any) { gone(error); continue; }
      if (st.isSymbolicLink()) {
        if (!linkRoots.length) throw fault('unsafe-artifact');
        try { real = fs.realpathSync(full); st = fs.lstatSync(real); } catch { throw fault('unsafe-artifact'); }
        if (!st.isFile() || !linkRoots.some((r: string) => real !== r && inside(r, real as string))) throw fault('unsafe-artifact');
      }
      if (!st.isFile() && !st.isDirectory()) throw fault('unsafe-artifact');
      if (st.isDirectory()) walk(full);
      else { bytes += st.size; files.push({ path: path.relative(root, full).split(path.sep).join('/'), sizeBytes: st.size, ...(real ? { real } : {}) });
        if (bytes > maxBytes || files.length > maxFiles) throw fault('resource-limit'); }
    }
  };
  walk(root); return { bytes, files };
}
// Hugging Face snapshot layout only: <hub>/models--<id>/snapshots/<rev>/* link into content-addressed blobs.
function modelLinkRoots(modelPath: string): string[] {
  const snapshots = path.dirname(modelPath); const repo = path.dirname(snapshots);
  if (path.basename(snapshots) !== 'snapshots' || !/^models--[^/\\]+$/.test(path.basename(repo))) return [];
  return [path.join(repo, 'blobs'), path.join(path.dirname(repo), 'blobs')].filter((dir: string) => {
    try { return fs.lstatSync(dir).isDirectory() && fs.realpathSync(dir) === dir; } catch { return false; }
  });
}
function inspectModel(modelPath: string, limits: any = SEMBLE_LIMITS): any {
  if (typeof modelPath !== 'string' || !path.isAbsolute(modelPath) || fs.realpathSync(modelPath) !== modelPath) throw fault('local-model-required');
  const inventory = scanTree(modelPath, limits.modelBytes, 10000, { linkRoots: modelLinkRoots(modelPath) });
  for (const required of ['config.json', 'tokenizer.json', 'model.safetensors']) if (!inventory.files.some((f: any) => f.path === required)) throw fault('local-model-incomplete');
  const hashes = inventory.files.map((f: any) => [f.path, digest(regularBytes(f.real || path.join(modelPath, f.path), limits.modelBytes))]);
  return { path: modelPath, identity: digest(JSON.stringify(hashes)), bytes: inventory.bytes };
}
function validateInventory(inventory: any, limits: any): void {
  if (!inventory?.complete || !path.isAbsolute(inventory.root) || fs.realpathSync(inventory.root) !== inventory.root || !inventory.scopeIgnoreDigest || !inventory.identity) throw fault('incomplete-corpus');
  if (!Array.isArray(inventory.files) || inventory.files.length > limits.files) throw fault('corpus-limit');
  const seen = new Set(); let bytes = 0;
  for (const entry of inventory.files) {
    if (typeof entry.path !== 'string' || entry.path.includes('\\') || entry.path.split('/').some((p: string) => !p || p === '.' || p === '..') || path.isAbsolute(entry.path) || seen.has(entry.path)) throw fault('unsafe-corpus-path');
    seen.add(entry.path);
    if (!/^[0-9a-f]{64}$/.test(entry.fileHash) || entry.sizeBytes > limits.fileBytes || entry.sizeBytes < 0) throw fault('corpus-hash-or-size');
    bytes += entry.sizeBytes;
  }
  if (bytes > limits.sourceBytes) throw fault('corpus-limit');
}
function readSource(inventory: any, entry: any, limits: any): any {
  const absolute = path.join(inventory.root, entry.path);
  if (entry.absolutePath !== absolute || fs.realpathSync(absolute) !== absolute) throw fault('unsafe-source-path');
  const data = regularBytes(absolute, limits.fileBytes);
  if (data.length !== entry.sizeBytes || digest(data) !== entry.fileHash) throw fault('source-changed', 'STALE');
  return data;
}
function checkSources(inventory: any, limits: any): void {
  for (const entry of inventory.files) readSource(inventory, entry, limits);
  // Re-admission detects changed ignore files, scope policy and added/deleted members too.
  const { fingerprintCorpus } = require('./code-corpus.ts');
  const next = fingerprintCorpus(inventory);
  if (!next.complete || next.identity !== inventory.identity || next.scopeIgnoreDigest !== inventory.scopeIgnoreDigest) throw fault('corpus-changed', 'STALE');
}
function inspectArtifacts(index: string, inventory: any, paths: any, model: any, limits: any): any {
  safeDirectories(paths.state, index); safeDirectories(paths.state, paths.mirror);
  const tree = scanTree(index, limits.artifactBytes, 32);
  const expected = ['bm25_index/index.json', 'chunks.json', 'metadata.json', 'semantic_index/arguments.json', 'semantic_index/vectors.npy'];
  if (JSON.stringify(tree.files.map((f: any) => f.path).sort()) !== JSON.stringify(expected.sort())) throw fault('incomplete-index');
  const json = (name: string) => JSON.parse(regularBytes(path.join(index, name), limits.artifactBytes).toString('utf8'));
  const metadata = json('metadata.json'); const chunks = json('chunks.json'); const bm25 = json('bm25_index/index.json');
  if (metadata.root_path !== paths.mirror || metadata.model_path !== model.path || metadata.cache_version !== 1 || metadata.chunk_size !== 750 || JSON.stringify(metadata.content_type) !== '["code"]') throw fault('incompatible-index');
  if (!Array.isArray(chunks) || chunks.length > limits.chunks || !Array.isArray(bm25.doc_order) || bm25.doc_order.length !== chunks.length || new Set(bm25.doc_order).size !== chunks.length) throw fault('invalid-chunk-pool');
  // Check NPY header without loading NumPy; reject shape/size bombs before its allocator runs.
  const vectors = regularBytes(path.join(index, 'semantic_index/vectors.npy'), limits.artifactBytes);
  if (vectors.length < 10 || vectors.subarray(0, 6).toString('hex') !== '934e554d5059' || vectors[6] !== 1 || vectors[7] !== 0) throw fault('invalid-vector-header');
  const headerLength = vectors.readUInt16LE(8); const header = vectors.subarray(10, 10 + headerLength).toString('ascii');
  const shape = /['"]shape['"]\s*:\s*\(\s*(\d+)\s*,\s*(\d+)\s*,?\s*\)/.exec(header);
  const dtype = /['"]descr['"]\s*:\s*['"]([<>=|][fiu])(\d+)['"]/.exec(header);
  if (!shape || !dtype || +shape[1] !== chunks.length || +shape[2] < 1 || +shape[2] > 65536 || ![1, 2, 4, 8].includes(+dtype[2]) || vectors.length !== 10 + headerLength + (+shape[1] * +shape[2] * +dtype[2])) throw fault('inconsistent-vector-shape');
  const admitted = new Map(inventory.files.map((e: any) => [e.path, e]));
  let offset = 0; const ids: string[] = [];
  for (const [file, value] of Object.entries(metadata.files || {}) as any) {
    if (!admitted.has(file) || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.count) || value.start !== offset || value.count < 0 || !Number.isInteger(value.mtime_ns)) throw fault('invalid-index-manifest');
    for (let slot = 0; slot < value.count; slot++) {
      const chunk = chunks[offset + slot];
      if (!chunk || chunk.file_path !== file || !Number.isSafeInteger(chunk.start_line) || !Number.isSafeInteger(chunk.end_line) || chunk.start_line < 1 || chunk.end_line < chunk.start_line) throw fault('unsafe-chunk-path-or-range');
      ids.push(`${file}:${slot}`);
    }
    offset += value.count;
  }
  if (offset !== chunks.length || JSON.stringify(ids) !== JSON.stringify(bm25.doc_order) || JSON.stringify(Object.keys(bm25.documents || {}).sort()) !== JSON.stringify(ids.slice().sort())) throw fault('inconsistent-artifacts');
  // All metadata paths are admitted; constructor source reads can never escape this copied mirror.
  const mirror = scanTree(paths.mirror, limits.sourceBytes, limits.files);
  if (JSON.stringify(mirror.files.map((f: any) => f.path).sort()) !== JSON.stringify([...admitted.keys()].sort())) throw fault('mirror-membership-mismatch');
  for (const [file, entry] of admitted as any) if (digest(regularBytes(path.join(paths.mirror, file), limits.fileBytes)) !== entry.fileHash) throw fault('mirror-hash-mismatch', 'STALE');
  return { chunks: chunks.length, artifactBytes: tree.bytes, artifactIdentity: digest(JSON.stringify(tree.files.map((f: any) => [f.path, digest(regularBytes(path.join(index, f.path), limits.artifactBytes))]))) };
}
async function acquireSemanticLock(paths: any): Promise<any> {
  safeDirectories(paths.root, paths.state, true);
  const deadline = Date.now() + 100;
  while (true) {
    try { const fd = fs.openSync(paths.lock, 'wx'); fs.writeFileSync(fd, `${process.pid}\n`); return () => { fs.closeSync(fd); fs.unlinkSync(paths.lock); }; }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; if (Date.now() >= deadline) throw fault('lock-contention'); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
}
function cleanupTemporary(paths: any): void {
  for (const name of fs.readdirSync(paths.state)) {
    if (!/^(query|staging)-[A-Za-z0-9-]+$/.test(name)) continue;
    const dir = path.join(paths.state, name);
    scanTree(dir, SEMBLE_LIMITS.artifactBytes, 10000); fs.rmSync(dir, { recursive: true });
  }
}
// Per-invocation disposable sandbox: `stats/` is Semble's statistics sink (query SEMBLE_CACHE_LOCATION, 64 KiB);
// `library/` takes every redirected library cache/temp location. Semble 0.6.1 extracts sha-verified tree-sitter
// grammars from its own bundled archive there (77 libraries, 79.6 MB uncompressed on macos-arm64), so it is
// bounded by `libraryBytes` instead of the statistics cap.
function bridgeSandbox(sandbox: string): any {
  const temp = path.join(sandbox, 'stats'); const library = path.join(sandbox, 'library');
  for (const dir of [temp, library]) if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  return { temp, library };
}
function checkSandbox(sinks: any, limits: any, transient = false): void {
  scanTree(sinks.temp, limits.statsBytes, 128, { transient });
  scanTree(sinks.library, limits.libraryBytes, 512, { transient });
}
function executeBridge(request: any, options: any, paths: any, sandbox: string): Promise<any> {
  const limits = options.limits; const deadline = request.action === 'query' ? limits.queryMs : limits.lifecycleMs;
  const sinks = bridgeSandbox(sandbox); const { temp, library } = sinks;
  return new Promise(resolve => {
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONHASHSEED: '0', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_DATASETS_OFFLINE: '1',
      SEMBLE_CACHE_LOCATION: request.action === 'query' ? temp : paths.cache, HF_HOME: library, HUGGINGFACE_HUB_CACHE: library,
      TRANSFORMERS_CACHE: library, XDG_CACHE_HOME: library, SEMBLE_GRAMMARS_CACHE_DIR: path.join(library, 'grammars'), TORCH_HOME: library,
      TMPDIR: library, TEMP: library, TMP: library, TOKENIZERS_PARALLELISM: 'false' };
    const child = spawn(options.python || 'python3', [options.bridgePath || path.join(__dirname, 'semble-bridge.py')], { cwd: paths.state, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = ''; let outputBytes = 0; let failure: string | null = null; let done = false;
    const stop = (reason: string) => { if (!failure) failure = reason; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('provider-timeout'), deadline);
    // A live child creates and removes files while we walk; only a real overrun is a resource limit.
    const sandboxFault = (error: any) => error?.reason === 'resource-limit' ? 'provider-resource-limit' : 'provider-unsafe-write';
    const poll = setInterval(() => { try { checkSandbox(sinks, limits, true); if (request.savePath && fs.existsSync(request.savePath)) scanTree(request.savePath, limits.artifactBytes, 32, { transient: true }); } catch (error: any) { stop(sandboxFault(error)); } }, 10);
    const finish = (result: any) => { if (done) return; done = true; clearTimeout(timer); clearInterval(poll); resolve(result); };
    child.stdout.on('data', (chunk: any) => { outputBytes += chunk.length; if (outputBytes > limits.outputBytes) stop('provider-output-limit'); else stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: any) => { outputBytes += chunk.length; if (outputBytes > limits.outputBytes) stop('provider-output-limit'); });
    child.on('error', () => finish({ ok: false, reason: 'provider-unavailable' }));
    child.on('close', (code: number) => {
      if (failure) return finish({ ok: false, reason: failure });
      try { checkSandbox(sinks, limits); } catch (error: any) { return finish({ ok: false, reason: sandboxFault(error) }); }
      if (code !== 0) return finish({ ok: false, reason: 'provider-error' });
      try { const result = JSON.parse(stdout); if (result.version !== SEMBLE_VERSION || typeof result.ok !== 'boolean') throw Error(); finish(result); }
      catch { finish({ ok: false, reason: 'invalid-provider-output' }); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request));
  });
}
function readCompleted(paths: any, inventory: any, model: any, limits: any, allowChanged = false): any {
  if (fs.existsSync(paths.marker)) throw fault('index-in-progress');
  let manifest: any;
  try { manifest = JSON.parse(regularBytes(paths.manifest, 2097152).toString('utf8')); } catch { throw fault('index-missing-or-corrupt'); }
  if (manifest.schemaVersion !== 1 || manifest.complete !== true || !manifest.generation || !manifest.artifactIdentity) throw fault('unknown-index-identity');
  if (manifest.root !== inventory.root || manifest.scopeIgnoreDigest !== inventory.scopeIgnoreDigest || manifest.providerVersion !== SEMBLE_VERSION || manifest.model?.identity !== model.identity || manifest.model?.path !== model.path) throw fault('index-identity-mismatch', 'STALE');
  if (!allowChanged && manifest.corpusIdentity !== inventory.identity) throw fault('index-source-mismatch', 'STALE');
  return manifest;
}
async function runSembleQuery(options: any): Promise<any> {
  const limits = { ...SEMBLE_LIMITS, ...options.limits }; const inventory = options.inventory;
  let release: any; let temp: string | undefined;
  try {
    validateInventory(inventory, limits); const model = inspectModel(options.modelPath, limits); const paths = semanticStatePaths(inventory);
    release = await acquireSemanticLock(paths); cleanupTemporary(paths);
    const manifest = readCompleted(paths, inventory, model, limits);
    checkSources(inventory, limits);
    const artifacts = inspectArtifacts(paths.index, inventory, paths, model, limits);
    if (artifacts.artifactIdentity !== manifest.artifactIdentity) throw fault('index-artifacts-changed');
    temp = fs.mkdtempSync(path.join(paths.state, 'query-'));
    const result = await executeBridge({ action: 'query', query: options.query, indexPath: paths.index, modelPath: model.path,
      poolSize: artifacts.chunks, allowedWriteRoots: [temp] }, { ...options, limits }, paths, temp);
    if (!result.ok) throw fault(result.reason || 'provider-error');
    if (!result.runtimeIdentity || JSON.stringify(result.runtimeIdentity) !== JSON.stringify(manifest.runtimeIdentity)) throw fault('provider-runtime-identity-mismatch', 'STALE');
    if (!Array.isArray(result.candidates) || result.candidates.length > 200) throw fault('invalid-provider-output');
    const admitted = new Map(inventory.files.map((f: any) => [f.path, f]));
    for (const candidate of result.candidates) {
      const loc = candidate.locator;
      if (!loc || !admitted.has(loc.file) || !Number.isSafeInteger(loc.line) || !Number.isSafeInteger(loc.endLine) || loc.line < 1 || loc.endLine < loc.line || !Number.isFinite(candidate.score)) throw fault('invalid-provider-candidate');
      candidate.indexedSourceIdentity = (admitted.get(loc.file) as any).fileHash;
    }
    checkSources(inventory, limits);
    if (inspectModel(options.modelPath, limits).identity !== model.identity) throw fault('model-changed', 'STALE');
    return { ok: true, provider: 'semble.search', version: SEMBLE_VERSION, model, generation: manifest.generation, freshness: 'FRESH', candidates: result.candidates,
      accounting: { indexedChunks: artifacts.chunks, sourceReadBytes: inventory.files.reduce((n: number, f: any) => n + f.sizeBytes, 0), artifactBytes: artifacts.artifactBytes } };
  } catch (error: any) { return { ok: false, provider: 'semble.search', version: SEMBLE_VERSION, freshness: error.freshness || 'UNKNOWN', reason: error.reason || 'provider-unavailable', candidates: [] }; }
  finally { try { if (temp) fs.rmSync(temp, { recursive: true, force: true }); } catch {} try { if (release) release(); } catch {} }
}
module.exports = { SEMBLE_VERSION, SEMBLE_LIMITS, runSembleQuery, semanticStatePaths, digest, fault, inside, safeDirectories,
  regularBytes, scanTree, inspectModel, validateInventory, readSource, checkSources, inspectArtifacts, acquireSemanticLock, cleanupTemporary, executeBridge, readCompleted, modelLinkRoots };
