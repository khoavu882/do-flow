'use strict';

// Index store for the guidance corpus. The index is derived state under the project's
// own `.doflow/index/`: every indexed file is addressed by its sha256, so freshness is intrinsic —
// a manifest whose digests no longer match the tree IS stale, by construction, and rebuilding only
// re-chunks what actually changed. Chunks are stored as JSONL so the store stays diffable and
// streamable without a database dependency.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chunkMarkdown } = require('./chunker');

const INDEX_VERSION = 1;
const MANIFEST_FILE = 'manifest.json';
const CHUNKS_FILE = 'chunks.jsonl';

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Every .md file under the corpus root, as sorted relative paths (deterministic builds). */
function listMarkdownFiles(corpusDir, { fsImpl = fs } = {}) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(path.relative(corpusDir, abs));
    }
  };
  walk(corpusDir);
  return out.sort((a, b) => (a < b ? -1 : 1));
}

function readManifest(indexDir, { fsImpl = fs } = {}) {
  try {
    return JSON.parse(fsImpl.readFileSync(path.join(indexDir, MANIFEST_FILE), 'utf8'));
  } catch { return null; }
}

function loadChunksByPath(indexDir, { fsImpl = fs } = {}) {
  const byPath = new Map();
  let raw;
  try { raw = fsImpl.readFileSync(path.join(indexDir, CHUNKS_FILE), 'utf8'); } catch { return byPath; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let chunk;
    try { chunk = JSON.parse(line); } catch { continue; }
    if (!byPath.has(chunk.path)) byPath.set(chunk.path, []);
    byPath.get(chunk.path).push(chunk);
  }
  return byPath;
}

/** Build (or incrementally refresh) the index. Files whose digest already sits in the manifest
 * reuse their stored chunks byte-for-byte; only changed or new files are re-chunked. Returns
 * {files, chunks, rebuilt[], reusedCount}. */
function buildIndex({ corpusDir, indexDir, fsImpl = fs } = {}) {
  const relPaths = listMarkdownFiles(corpusDir, { fsImpl });
  const previous = readManifest(indexDir, { fsImpl });
  const previousFiles = previous?.files ?? {};
  const reusableChunks = loadChunksByPath(indexDir, { fsImpl });

  const files = {};
  const allChunks = [];
  const rebuilt = [];
  let reusedCount = 0;
  for (const rel of relPaths) {
    const content = fsImpl.readFileSync(path.join(corpusDir, rel), 'utf8');
    const digest = sha256(Buffer.from(content, 'utf8'));
    const prior = previousFiles[rel];
    if (prior && prior.digest === digest && reusableChunks.has(rel)) {
      const chunks = reusableChunks.get(rel);
      files[rel] = { digest, chunks: chunks.length };
      allChunks.push(...chunks);
      reusedCount += 1;
      continue;
    }
    const chunks = chunkMarkdown(content, { path: rel });
    files[rel] = { digest, chunks: chunks.length };
    allChunks.push(...chunks);
    rebuilt.push(rel);
  }

  fsImpl.mkdirSync(indexDir, { recursive: true });
  const body = allChunks.map((chunk) => JSON.stringify(chunk)).join('\n') + (allChunks.length ? '\n' : '');
  const tmpChunks = `${path.join(indexDir, CHUNKS_FILE)}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmpChunks, body, 'utf8');
  fsImpl.renameSync(tmpChunks, path.join(indexDir, CHUNKS_FILE));
  const manifest = {
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    files,
  };
  const tmpManifest = `${path.join(indexDir, MANIFEST_FILE)}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2), 'utf8');
  fsImpl.renameSync(tmpManifest, path.join(indexDir, MANIFEST_FILE));

  // Dropped files leave no orphan chunks behind: the rewrite above already excludes them.
  return { files: relPaths.length, chunks: allChunks.length, rebuilt, reusedCount, manifest };
}

/** Load the index for querying. Returns null when absent/malformed; staleness is the caller's
 * policy decision (see ensureFreshIndex), never a silent assumption here. */
function loadIndex({ indexDir, fsImpl = fs } = {}) {
  const manifest = readManifest(indexDir, { fsImpl });
  if (!manifest || manifest.version !== INDEX_VERSION) return null;
  const chunks = [];
  let raw;
  try { raw = fsImpl.readFileSync(path.join(indexDir, CHUNKS_FILE), 'utf8'); } catch { return null; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { chunks.push(JSON.parse(line)); } catch { return null; }
  }
  return { manifest, chunks };
}

/** True when every corpus file's current digest matches the manifest. Missing extra corpus files
 * (present on disk, absent from the manifest) also count as stale — they are not yet searchable. */
function isFresh({ corpusDir, indexDir, fsImpl = fs } = {}) {
  const manifest = readManifest(indexDir, { fsImpl });
  if (!manifest) return false;
  const relPaths = listMarkdownFiles(corpusDir, { fsImpl });
  if (relPaths.length !== Object.keys(manifest.files ?? {}).length) return false;
  for (const rel of relPaths) {
    const recorded = manifest.files?.[rel];
    if (!recorded) return false;
    try {
      const digest = sha256(fsImpl.readFileSync(path.join(corpusDir, rel)));
      if (digest !== recorded.digest) return false;
    } catch { return false; }
  }
  return true;
}

module.exports = {
  INDEX_VERSION, MANIFEST_FILE, CHUNKS_FILE,
  listMarkdownFiles, buildIndex, loadIndex, isFresh, sha256,
};
