'use strict';

// Optional pinned external provider. No imports, model loads or writes occur until invoked.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn, spawnSync } = require('node:child_process');
const SEMBLE_VERSION = '0.7.0';
const SEMBLE_LIMITS = Object.freeze({ files: 2000, fileBytes: 1048576, sourceBytes: 67108864,
  chunks: 50000, artifactBytes: 268435456, modelBytes: 536870912, outputBytes: 2097152,
  statsBytes: 65536, libraryBytes: 134217728, queryMs: 10000, lifecycleMs: 120000, changedFiles: 500, changedBytes: 16777216 });
const digest = (value: any): string => crypto.createHash('sha256').update(value).digest('hex');
function fault(reason: string, freshness = 'UNKNOWN', cause?: string): any { return Object.assign(new Error(reason), { reason, freshness, ...(cause ? { cause } : {}) }); }
// Semble's own interpreter, found without a PATH wrapper: the `semble` launcher (PATH, then ~/.local/bin/semble) and the
// absolute interpreter its shebang names. The bridge then proves offline that this interpreter imports the pinned version.
// Ceiling: only a plain absolute shebang (uv/pipx layout); `env` indirection, arguments or a native launcher are unavailable.
function resolveSembleInterpreter({ env = process.env, home = os.homedir() }: any = {}): any {
  const dirs = String(env.PATH || '').split(path.delimiter).filter((dir: string) => path.isAbsolute(dir));
  const launcher = [...dirs.map((dir: string) => path.join(dir, 'semble')), path.join(home, '.local', 'bin', 'semble')]
    .find((file: string) => { try { return fs.statSync(file).isFile(); } catch { return false; } });
  if (!launcher) throw fault('provider-unavailable', 'UNKNOWN', 'no semble launcher on PATH or in ~/.local/bin');
  const head = Buffer.alloc(1024); const fd = fs.openSync(launcher, 'r');
  let count = 0; try { count = fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  const shebang = /^#!(\/\S+)[ \t]*\r?$/.exec(head.subarray(0, count).toString('utf8').split('\n')[0]);
  if (!shebang || path.basename(shebang[1]) === 'env') throw fault('provider-unavailable', 'UNKNOWN', `${launcher} does not name an absolute interpreter`);
  let usable = false; try { fs.accessSync(shebang[1], fs.constants.X_OK); usable = fs.statSync(shebang[1]).isFile(); } catch {}
  if (!usable) throw fault('provider-unavailable', 'UNKNOWN', `interpreter ${shebang[1]} named by ${launcher} is not executable`);
  return { python: shebang[1], launcher };
}
// Lifecycle preflight: the interpreter's installed Semble metadata must be the pin before any lock or mutation. No
// import, network or write happens here; the bridge re-checks the same pin under its audit policy on every call.
function checkSembleVersion(python: string): void {
  const run = spawnSync(python, ['-c', 'import importlib.metadata as m, sys; sys.stdout.write(m.version("semble"))'], { cwd: path.dirname(python),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  if (run.error || run.status !== 0) throw fault('provider-unavailable', 'UNKNOWN', `semble is not installed for ${python}`);
  const found = String(run.stdout).trim().slice(0, 32);
  if (found !== SEMBLE_VERSION) throw fault('provider-version-mismatch', 'UNKNOWN', `${python} has semble ${found}; the bridge pins ${SEMBLE_VERSION}`);
}
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
// Semble 0.7.0 saves BM25 as `bm25_index/index.npz`: numpy's stored (uncompressed) zip of six 1-D .npy members.
// Parse it here without NumPy so a garbled, compressed, oversized or inconsistent archive is refused before the loader.
const BM25_MEMBERS: Record<string, string> = { 'doc_order.npy': '|u1', 'terms.npy': '|u1', 'offsets.npy': '<i8', 'docs.npy': '<i4', 'tfs.npy': '<i4', 'doc_lengths.npy': '<i4' };
function npzMembers(buffer: Buffer): Map<string, Buffer> {
  const bad = () => fault('invalid-bm25-archive');
  const end = buffer.length - 22; // numpy writes no archive comment, so the end record closes the file
  if (end < 0 || buffer.readUInt32LE(end) !== 0x06054b50) throw bad();
  const count = buffer.readUInt16LE(end + 10); const size = buffer.readUInt32LE(end + 12); const directory = buffer.readUInt32LE(end + 16); let cursor = directory;
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 8) !== count || count !== Object.keys(BM25_MEMBERS).length || directory + size !== end) throw bad();
  const members = new Map<string, Buffer>(); let dataEnd = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw bad();
    const flags = buffer.readUInt16LE(cursor + 8); const method = buffer.readUInt16LE(cursor + 10); const crc = buffer.readUInt32LE(cursor + 16);
    const stored = buffer.readUInt32LE(cursor + 20); const length = buffer.readUInt32LE(cursor + 24); const local = buffer.readUInt32LE(cursor + 42);
    const nameLength = buffer.readUInt16LE(cursor + 28); const next = cursor + 46 + nameLength + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('latin1');
    // Stored only: a member can never claim more bytes than the archive holds (no decompression bomb).
    if (next > end || (flags & 1) || method !== 0 || stored !== length || !(name in BM25_MEMBERS) || members.has(name) || local < dataEnd || local + 30 + nameLength > directory) throw bad();
    if (buffer.readUInt32LE(local) !== 0x04034b50 || buffer.readUInt16LE(local + 8) !== 0 || buffer.readUInt16LE(local + 26) !== nameLength
      || buffer.subarray(local + 30, local + 30 + nameLength).toString('latin1') !== name) throw bad();
    const start = local + 30 + nameLength + buffer.readUInt16LE(local + 28); dataEnd = start + length;
    if (dataEnd > directory) throw bad();
    const data = buffer.subarray(start, dataEnd);
    if (zlib.crc32(data) !== crc) throw bad();
    members.set(name, data); cursor = next;
  }
  if (cursor !== end) throw bad();
  return members;
}
function npyVector(data: Buffer, descr: string): any {
  const bad = () => fault('invalid-bm25-archive');
  if (data.length < 10 || data.subarray(0, 6).toString('hex') !== '934e554d5059' || ![1, 2, 3].includes(data[6]) || data[7] !== 0) throw bad();
  const start = data[6] === 1 ? 10 : 12; if (data.length < start) throw bad();
  const headerLength = data[6] === 1 ? data.readUInt16LE(8) : data.readUInt32LE(8);
  const header = data.subarray(start, start + headerLength).toString('latin1');
  const shape = /['"]shape['"]\s*:\s*\(\s*(\d+)\s*,\s*\)/.exec(header); const width = +descr.slice(2);
  if (start + headerLength > data.length || !header.includes(`'descr': '${descr}'`) || !/['"]fortran_order['"]\s*:\s*False/.test(header) || !shape
    || data.length !== start + headerLength + (+shape[1] * width)) throw bad();
  const body = data.subarray(start + headerLength); const length = +shape[1];
  return { length, body, at: (i: number) => (width === 8 ? Number(body.readBigInt64LE(i * 8)) : width === 4 ? body.readInt32LE(i * 4) : body[i]) };
}
function unpackStrings(vector: any): string[] {
  const text = vector.body.toString('utf8');
  if (vector.length && !text.endsWith('\0')) throw fault('invalid-bm25-archive');
  return vector.length ? text.slice(0, -1).split('\0') : [];
}
// Mirrors Semble 0.7.0 BM25 `_check_consistent` and adds the document count; returns doc_order for the chunk-id cross-check.
function inspectBm25(buffer: Buffer): string[] {
  const members = npzMembers(buffer);
  const v: any = Object.fromEntries(Object.entries(BM25_MEMBERS).map(([name, descr]) => [name.slice(0, -4), npyVector(members.get(name) as Buffer, descr)]));
  const docOrder = unpackStrings(v.doc_order); const terms = unpackStrings(v.terms); const n = docOrder.length;
  let ok = new Set(docOrder).size === n && v.doc_lengths.length === n && v.offsets.length === terms.length + 1 && v.offsets.at(0) === 0
    && v.offsets.at(v.offsets.length - 1) === v.docs.length && v.tfs.length === v.docs.length;
  for (let i = 1; ok && i < v.offsets.length; i++) ok = v.offsets.at(i) >= v.offsets.at(i - 1);
  for (let i = 0; ok && i < v.docs.length; i++) ok = v.docs.at(i) >= 0 && v.docs.at(i) < n;
  if (!ok) throw fault('inconsistent-bm25-postings');
  return docOrder;
}
function inspectArtifacts(index: string, inventory: any, paths: any, model: any, limits: any): any {
  safeDirectories(paths.state, index); safeDirectories(paths.state, paths.mirror);
  const tree = scanTree(index, limits.artifactBytes, 32);
  const expected = ['bm25_index/index.npz', 'chunks.json', 'metadata.json', 'semantic_index/arguments.json', 'semantic_index/vectors.npy'];
  if (JSON.stringify(tree.files.map((f: any) => f.path).sort()) !== JSON.stringify(expected.sort())) throw fault('incomplete-index');
  const json = (name: string) => JSON.parse(regularBytes(path.join(index, name), limits.artifactBytes).toString('utf8'));
  const metadata = json('metadata.json'); const chunks = json('chunks.json');
  if (metadata.root_path !== paths.mirror || metadata.model_path !== model.path || metadata.cache_version !== 2 || metadata.chunk_size !== 750 || JSON.stringify(metadata.content_type) !== '["code"]') throw fault('incompatible-index');
  if (!Array.isArray(chunks) || chunks.length > limits.chunks) throw fault('invalid-chunk-pool');
  const docOrder = inspectBm25(regularBytes(path.join(index, 'bm25_index/index.npz'), limits.artifactBytes));
  if (docOrder.length !== chunks.length) throw fault('invalid-chunk-pool');
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
  if (offset !== chunks.length || JSON.stringify(ids) !== JSON.stringify(docOrder)) throw fault('inconsistent-artifacts');
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
// `library/` takes every redirected library cache/temp location. Semble 0.7.0 (semble-grammars 0.1.2) extracts sha-verified tree-sitter
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
      TMPDIR: library, TEMP: library, TMP: library, TOKENIZERS_PARALLELISM: 'false', SEMBLE_INDEX_WORKERS: '0' };
    const child = spawn(options.python, [options.bridgePath || path.join(__dirname, 'semble-bridge.py')], { cwd: paths.state, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
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
    const python = options.python || resolveSembleInterpreter().python;
    release = await acquireSemanticLock(paths); cleanupTemporary(paths);
    const manifest = readCompleted(paths, inventory, model, limits);
    checkSources(inventory, limits);
    const artifacts = inspectArtifacts(paths.index, inventory, paths, model, limits);
    if (artifacts.artifactIdentity !== manifest.artifactIdentity) throw fault('index-artifacts-changed');
    const queryTemp: string = fs.mkdtempSync(path.join(paths.state, 'query-')); temp = queryTemp;
    const result = await executeBridge({ action: 'query', query: options.query, indexPath: paths.index, modelPath: model.path,
      poolSize: artifacts.chunks, allowedWriteRoots: [queryTemp] }, { ...options, python, limits }, paths, queryTemp);
    if (!result.ok) throw fault(result.reason || 'provider-error', 'UNKNOWN', typeof result.cause === 'string' ? result.cause : undefined);
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
    // sourceReadBytes is the admitted corpus size; Semble 0.7.0's loader only stats sources, so it over-counts provider reads.
    return { ok: true, provider: 'semble.search', version: SEMBLE_VERSION, model, generation: manifest.generation, freshness: 'FRESH', candidates: result.candidates,
      accounting: { indexedChunks: artifacts.chunks, sourceReadBytes: inventory.files.reduce((n: number, f: any) => n + f.sizeBytes, 0), artifactBytes: artifacts.artifactBytes } };
  } catch (error: any) { return { ok: false, provider: 'semble.search', version: SEMBLE_VERSION, freshness: error.freshness || 'UNKNOWN', reason: error.reason || 'provider-unavailable',
    ...(typeof error.cause === 'string' ? { cause: error.cause } : {}), candidates: [] }; }
  finally { try { if (temp) fs.rmSync(temp, { recursive: true, force: true }); } catch {} try { if (release) release(); } catch {} }
}
module.exports = { SEMBLE_VERSION, SEMBLE_LIMITS, runSembleQuery, resolveSembleInterpreter, checkSembleVersion, semanticStatePaths, digest, fault, inside, safeDirectories,
  regularBytes, scanTree, inspectModel, inspectBm25, validateInventory, readSource, checkSources, inspectArtifacts, acquireSemanticLock, cleanupTemporary, executeBridge, readCompleted, modelLinkRoots };
