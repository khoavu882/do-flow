'use strict';

/**
 * Configuration B adapter (074 IC-008, PD-1): native `rg` for the code corpus and the snapshot's own
 * BM25 `searchGuidance` for the guidance corpus. Also home to the helpers configuration A and the
 * dispatcher share (`runTool`, `finalize`, `loadRetrieval`), because A and the dispatcher load
 * after this file and a shared helper must not point back at them.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { childEnv } = require('../runner.js');

const K_MAX = { code: 10, guidance: 5 };
const GUIDANCE_PREFIX = 'core/shared/guidance/';
const TOOL_TIMEOUT_MS = 30000;
const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Runs one external tool. Never throws: `{ran, status, stdout, stderr, cause}` where `ran` is false for
 * a missing binary or a 30 s timeout, and `cause` says why. A nonzero exit is the caller's to judge.
 */
function runTool(bin, args, { cwd, input, env, timeoutMs = TOOL_TIMEOUT_MS } = {}) {
  const run = spawnSync(bin, args, { cwd, input, env: childEnv(env), encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_BUFFER });
  if (run.error) {
    const cause = run.error.code === 'ENOENT' ? 'binary absent'
      : run.error.code === 'ETIMEDOUT' ? `timed out after ${timeoutMs / 1000}s` : run.error.message;
    return { ran: false, status: null, stdout: '', stderr: '', cause };
  }
  return { ran: true, status: run.status, stdout: run.stdout || '', stderr: run.stderr || '', cause: undefined };
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** Deduplicates by (path, startLine, endLine, heading), keeps first-seen order, cuts to `kMax`, renumbers rank from 1. */
function finalize(candidates, kMax) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = `${c.path}\0${c.startLine}\0${c.endLine}\0${c.heading}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...c, rank: out.length + 1 });
    if (out.length >= kMax) break;
  }
  return out;
}

function payloadOf(candidates) {
  return candidates.reduce((sum, c) => sum + c.snippetBytes, 0);
}

const retrievalCache = new Map();

/** The snapshot's own `retrieval.ts` (tokenize, searchGuidance), loaded from the export. */
function loadRetrieval(exportRoot) {
  const file = path.join(exportRoot, 'src', 'runtime', 'knowledge', 'retrieval.ts');
  if (!retrievalCache.has(file)) retrievalCache.set(file, require(file));
  return retrievalCache.get(file);
}

/** Parses `rg -n --no-heading` lines (`path:line:text`) relative to `exportRoot`. */
function parseRgLines(stdout, exportRoot) {
  const out = [];
  for (const raw of stdout.split('\n')) {
    const m = /^((?:[A-Za-z]:)?[^:]*):(\d+):(.*)$/.exec(raw);
    if (!m) continue;
    out.push({ path: toPosix(path.relative(exportRoot, m[1])), line: Number(m[2]), text: m[3] });
  }
  return out;
}

function cand(p, startLine, endLine, heading, provider, snippet) {
  return { path: p, startLine, endLine, heading, rank: 0, provider, snippet, snippetBytes: Buffer.byteLength(snippet, 'utf8') };
}

function answerOf({ result, freshness, candidates, providers, wallMs, extra }) {
  return { result, freshness, candidates, providers, payloadBytes: payloadOf(candidates), wallMs, ...extra };
}

function runCodeB(task, exportRoot, { bins, hasFd, listFiles, admittedPaths }) {
  const providers = [];
  const rgArgs = (extra, pattern) => ['-n', '--no-heading', '--color', 'never', ...extra, '-e', pattern,
    ...(Array.isArray(admittedPaths) ? ['--', ...admittedPaths.map((p) => path.resolve(exportRoot, p))] : [exportRoot])];
  const failed = (run) => {
    const cause = run.ran ? `rg exited ${run.status}` : run.cause;
    providers.push({ id: 'native.rg', state: 'unreached', cause });
    return { unreached: true };
  };

  if (task.literal) {
    const run = runTool(bins.rg, rgArgs(['-F'], task.literal));
    if (!run.ran || (run.status !== 0 && run.status !== 1)) { failed(run); return { providers, candidates: [] , unreached: true }; }
    providers.push({ id: 'native.rg', state: 'reached' });
    const hits = parseRgLines(run.stdout, exportRoot).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
    return { providers, candidates: finalize(hits.map((h) => cand(h.path, h.line, h.line, null, 'native.rg', h.text)), K_MAX.code) };
  }

  const { tokenize } = loadRetrieval(exportRoot);
  const terms = [...new Set(tokenize(task.query))];
  const files = new Map(); // path -> {terms: Map(term -> {first, text, count}), total, name: 0}
  const filesPerTerm = new Map();
  let rgOk = true;
  for (const term of terms) {
    const run = runTool(bins.rg, rgArgs(['-i', '-F'], term));
    if (!run.ran || (run.status !== 0 && run.status !== 1)) { failed(run); rgOk = false; break; }
    const seenFiles = new Set();
    for (const h of parseRgLines(run.stdout, exportRoot)) {
      if (!files.has(h.path)) files.set(h.path, { terms: new Map(), total: 0, name: 0 });
      const f = files.get(h.path);
      f.total += 1;
      const t = f.terms.get(term);
      if (!t) f.terms.set(term, { first: h.line, text: h.text });
      else if (h.line < t.first) { t.first = h.line; t.text = h.text; }
      seenFiles.add(h.path);
    }
    filesPerTerm.set(term, seenFiles.size);
  }
  if (!rgOk) return { providers, candidates: [], unreached: true };
  providers.push({ id: 'native.rg', state: 'reached' });

  // File-name step: fd when present, otherwise `rg --files` filtered by basename substring.
  const nameHits = new Map();
  if (Array.isArray(admittedPaths)) {
    for (const term of terms) for (const rel of admittedPaths) {
      if (path.posix.basename(toPosix(rel)).toLowerCase().includes(term)) nameHits.set(rel, (nameHits.get(rel) || 0) + 1);
    }
    providers.push({ id: 'fd', state: 'unreached', cause: 'manifest-scoped filename search' });
  } else if (hasFd) {
    for (const term of terms) {
      const run = runTool(bins.fd, ['--type', 'f', '--glob', `*${term}*`, exportRoot]);
      if (run.ran && run.status === 0) {
        for (const line of run.stdout.split('\n').filter(Boolean)) {
          const rel = toPosix(path.relative(exportRoot, line));
          nameHits.set(rel, (nameHits.get(rel) || 0) + 1);
        }
      }
    }
    providers.push({ id: 'fd', state: 'reached' });
  } else {
    providers.push({ id: 'fd', state: 'unreached', cause: 'binary absent; rg --files substitute' });
    const all = listFiles();
    for (const term of terms) {
      for (const rel of all) {
        if (path.posix.basename(rel).toLowerCase().includes(term)) nameHits.set(rel, (nameHits.get(rel) || 0) + 1);
      }
    }
  }
  for (const [rel, n] of nameHits) {
    if (!files.has(rel)) files.set(rel, { terms: new Map(), total: 0, name: 0 });
    files.get(rel).name = n;
  }

  const ranked = [...files.entries()].map(([p, f]) => ({ path: p, ...f, score: f.terms.size + f.name }))
    .sort((a, b) => (b.score - a.score) || (b.total - a.total) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const candidates = ranked.slice(0, K_MAX.code).map((f) => {
    if (f.terms.size === 0) return cand(f.path, null, null, null, 'native.rg', path.posix.basename(f.path));
    const term = [...f.terms.keys()].sort((a, b) => (filesPerTerm.get(a) - filesPerTerm.get(b)) || (a < b ? -1 : a > b ? 1 : 0))[0];
    const hit = f.terms.get(term);
    return cand(f.path, hit.first, hit.first, null, 'native.rg', hit.text);
  });
  return { providers, candidates: finalize(candidates, K_MAX.code) };
}

function runGuidanceB(task, exportRoot, { indexDir }) {
  const { searchGuidance } = loadRetrieval(exportRoot);
  const corpusDir = path.join(exportRoot, 'core', 'shared', 'guidance');
  let res;
  try {
    res = searchGuidance({ corpusDir, indexDir, query: task.query, k: K_MAX.guidance });
  } catch (error) {
    return { providers: [{ id: 'guidance.bm25', state: 'unreached', cause: error.message }], candidates: [], graphCandidates: [], unreached: true };
  }
  const toCand = (hit) => cand(`${GUIDANCE_PREFIX}${toPosix(hit.path)}`, null, null, hit.title == null ? null : hit.title, 'guidance.bm25', hit.snippet || '');
  const organic = res.results.filter((h) => !h.viaGraph);
  const graph = res.results.filter((h) => h.viaGraph);
  return {
    providers: [{ id: 'guidance.bm25', state: 'reached' }],
    candidates: finalize(organic.map(toCand), K_MAX.guidance),
    graphCandidates: finalize(graph.map(toCand), K_MAX.guidance),
  };
}

/**
 * Runs configuration B for one task against `exportRoot`. `indexDir` (guidance) defaults to a sibling
 * `index` directory of the export; `bins` and `hasFd` exist so a test can stand in a missing tool.
 */
function runB({ corpus, task, exportRoot, indexDir, bins = {}, hasFd, admittedPaths }) {
  const started = process.hrtime.bigint();
  const wall = () => Number(process.hrtime.bigint() - started) / 1e6;
  const tools = { rg: bins.rg || 'rg', fd: bins.fd || 'fd' };
  if (corpus === 'guidance') {
    const r = runGuidanceB(task, exportRoot, { indexDir: indexDir || path.join(path.dirname(exportRoot), 'index') });
    const result = r.unreached ? 'UNREACHED' : r.candidates.length > 0 ? 'RETRIEVED' : 'EMPTY';
    return answerOf({
      result, freshness: r.unreached ? 'UNKNOWN' : 'FRESH', candidates: r.candidates, providers: r.providers, wallMs: wall(),
      extra: { graphCandidates: r.graphCandidates },
    });
  }
  const present = (bin) => runTool(bin, ['--version']).ran;
  const fdPresent = hasFd === undefined ? present(tools.fd) : hasFd;
  let fileList;
  const listFiles = () => {
    if (!fileList) {
      const run = runTool(tools.rg, ['--files', exportRoot]);
      fileList = run.ran ? run.stdout.split('\n').filter(Boolean).map((f) => toPosix(path.relative(exportRoot, f))) : [];
    }
    return fileList;
  };
  const scopedListFiles = Array.isArray(admittedPaths) ? () => admittedPaths : listFiles;
  const r = runCodeB(task, exportRoot, { bins: tools, hasFd: fdPresent, listFiles: scopedListFiles, admittedPaths });
  const result = r.unreached ? 'UNREACHED' : r.candidates.length > 0 ? 'RETRIEVED' : 'EMPTY';
  return answerOf({ result, freshness: 'NOT_APPLICABLE', candidates: r.candidates, providers: r.providers, wallMs: wall() });
}

module.exports = { K_MAX, GUIDANCE_PREFIX, TOOL_TIMEOUT_MS, runTool, finalize, payloadOf, loadRetrieval, parseRgLines, toPosix, cand, answerOf, runB };
