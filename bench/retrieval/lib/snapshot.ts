'use strict';

/**
 * Pinned snapshot, manifest and their digests (074 IC-011, IC-012). Everything reads git objects of
 * the pinned commit, never the working tree, so a moved HEAD cannot change a measurement.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { canonicalJson, sha256Hex, toFileText } = require('./seal.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const RETRIEVAL_DIR = path.join(REPO_ROOT, 'bench', 'retrieval');
const SNAPSHOT_FILE = 'snapshot.json';
const MANIFEST_FILE = 'manifest.json';
const DEV_TASKS_PATH = 'bench/retrieval/tasks/dev.json';
const MANIFEST_PATH = 'bench/retrieval/manifest.json';
const EXCLUDE = ['bench/**', 'agent-docs/**', 'docs/**', 'graphify-out/**', 'node_modules/**', '.doflow/**'];
const CORPORA = {
  code: {
    scopes: ['src/**', 'bin/**', 'core/registry/**', 'core/harnesses/**', 'test/**'],
    exclude: [],
    dirtyRule: 'exclude-working-tree; include-by-setup-patch',
    matchRule: 'span-overlap',
    tokenizer: 'rg -F literal or per-term rg -i -F (IC-008)',
    kMax: 10,
  },
  guidance: {
    scopes: ['core/shared/guidance/**'],
    exclude: [],
    dirtyRule: 'exclude-working-tree; include-by-setup-patch',
    matchRule: 'path-heading',
    tokenizer: 'retrieval.ts tokenize at snapshot',
    kMax: 5,
  },
};
const REFRESH = {
  trigger: 'the pinned commit changes (retrieval migrate) or a listed tool changes version',
  owner: 'maintainer',
  command: 'npm run bench -- retrieval migrate --to <commit>',
};

const globCache = new Map();

/** Glob grammar: `**` any depth, `*` within one segment, nothing else (every other character is literal). */
function globToRegExp(pattern: any) {
  let re = globCache.get(pattern);
  if (re) return re;
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') { src += '.*'; i++; }
    else if (pattern[i] === '*') src += '[^/]*';
    else src += pattern[i].replace(/[\\^$.|?+()[\]{}]/g, '\\$&');
  }
  re = new RegExp(`^${src}$`);
  globCache.set(pattern, re);
  return re;
}

function matchesAny(patterns: any, file: any) {
  return patterns.some((p: any) => globToRegExp(p).test(file));
}

function git(repoRoot: any, args: any, options = {}) {
  return execFileSync('git', ['-C', repoRoot, ...args], { maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function commitExists(repoRoot: any, commit: any) {
  try { git(repoRoot, ['cat-file', '-e', `${commit}^{commit}`]); return true; } catch { return false; }
}

/** Corpora a path belongs to under a snapshot's scopes and exclusions. */
function corporaOf(file: any, snapshot: any) {
  if (matchesAny(snapshot.exclude, file)) return [];
  return Object.keys(snapshot.corpora).filter((name) => {
    const spec = snapshot.corpora[name];
    return matchesAny(spec.scopes, file) && !matchesAny(spec.exclude, file);
  });
}

/** Manifest entries from `git ls-tree -r -l <commit>`, sorted by (path, corpus). */
function buildManifest(repoRoot: any, commit: any, snapshot: any) {
  const out = git(repoRoot, ['ls-tree', '-r', '-l', '-z', commit]).toString('utf8');
  const entries = [];
  for (const record of out.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [, type, blob, size] = record.slice(0, tab).split(/\s+/);
    if (type !== 'blob') continue;
    const file = record.slice(tab + 1);
    for (const corpus of corporaOf(file, snapshot)) entries.push({ path: file, corpus, blob, bytes: Number(size) });
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.corpus < b.corpus ? -1 : a.corpus > b.corpus ? 1 : 0));
}

function manifestDigest(entries: any) {
  return sha256Hex(canonicalJson(entries));
}

/** Differences between two entry lists, as path lists. `changed` means the same (path, corpus) with another blob. */
function diffManifest(expected: any, actual: any) {
  const key = (e: any) => `${e.corpus}\0${e.path}`;
  const exp: any = new Map(expected.map((e: any) => [key(e), e]));
  const act = new Map(actual.map((e: any) => [key(e), e]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, e] of (act as any)) {
    if (!exp.has(k)) added.push(e.path);
    else if (exp.get(k).blob !== e.blob) changed.push(e.path);
  }
  for (const [k, e] of (exp as any)) if (!act.has(k)) removed.push(e.path);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/** The snapshot object in IC-011 key order. */
function buildSnapshot({ commit, seed, snapshotId = 1, manifestSha256, tools, env, devSha256 }: any) {
  return {
    schemaVersion: 1,
    snapshotId,
    commit,
    seed,
    refresh: { ...REFRESH },
    exclude: [...EXCLUDE],
    corpora: JSON.parse(JSON.stringify(CORPORA)),
    manifestPath: MANIFEST_PATH,
    manifestSha256,
    tools,
    node: env.node,
    os: env.os,
    arch: env.arch,
    taskFiles: { dev: { path: DEV_TASKS_PATH, sha256: devSha256 } },
  };
}

function writeJsonFile(file: any, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, toFileText(value));
}

/**
 * Writes the initial `snapshot.json` and `manifest.json` (PD-5). The dev-task digest is the SHA-256
 * of an empty file until `refreshTaskSha` runs after the dev merge. `tools` defaults to the
 * versions installed on this machine (environment.js).
 */
function writeInitial({
  commit, seed, repoRoot = REPO_ROOT, outDir = RETRIEVAL_DIR, snapshotId = 1, tools,
  env = { node: process.version, os: process.platform, arch: process.arch },
}: any) {
  if (!commitExists(repoRoot, commit)) throw new Error(`pinned commit ${commit} is absent (shallow clone or unfetched); fetch full history`);
  const skeleton = buildSnapshot({ commit, seed, snapshotId, manifestSha256: '', tools: [], env, devSha256: sha256Hex('') });
  const entries = buildManifest(repoRoot, commit, skeleton);
  const snapshot = {
    ...skeleton,
    manifestSha256: manifestDigest(entries),
    tools: tools || require('./environment.ts').captureTools(),
  };
  writeJsonFile(path.join(outDir, MANIFEST_FILE), { schemaVersion: 1, commit, entries });
  writeJsonFile(path.join(outDir, SNAPSHOT_FILE), snapshot);
  return snapshot;
}

/** Recomputes `taskFiles.dev.sha256` from the dev task file's bytes and rewrites `snapshot.json`. */
function refreshTaskSha({ repoRoot = REPO_ROOT, snapshotFile = path.join(RETRIEVAL_DIR, SNAPSHOT_FILE) } = {}) {
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  const devFile = path.join(repoRoot, snapshot.taskFiles.dev.path);
  snapshot.taskFiles.dev.sha256 = sha256Hex(fs.existsSync(devFile) ? fs.readFileSync(devFile) : '');
  writeJsonFile(snapshotFile, snapshot);
  return snapshot;
}

function loadSnapshot(file = path.join(RETRIEVAL_DIR, SNAPSHOT_FILE)) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadManifest(file = path.join(RETRIEVAL_DIR, MANIFEST_FILE)) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = {
  REPO_ROOT, RETRIEVAL_DIR, SNAPSHOT_FILE, MANIFEST_FILE, DEV_TASKS_PATH, MANIFEST_PATH, EXCLUDE, CORPORA, REFRESH,
  globToRegExp, matchesAny, git, commitExists, corporaOf, buildManifest, manifestDigest, diffManifest,
  buildSnapshot, writeInitial, refreshTaskSha, loadSnapshot, loadManifest, writeJsonFile,
};
