'use strict';

// Retrieval over the guidance index. Ranking is BM25 — pure, deterministic, and the correctness
// floor: BM25 plus the import graph answer questions well enough that no downstream stage depends
// on embeddings being present. Dense/rerank slots stay unimplemented until a provider is declared
// in models.yaml — an absent embedding provider degrades to lexical-only, never to a silent
// half-answer.

const fs = require('node:fs');
const path = require('node:path');
const { buildIndex, loadIndex, isFresh } = require('./index-store');
const { finishRuntime, usageError } = require('../cli-result');

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'as', 'by', 'at',
  'from', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those',
  'do', 'does', 'did', 'how', 'what', 'when', 'which', 'who', 'why', 'not', 'no', 'yes', 'can',
]);

function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

/** Deterministic BM25 (Okapi) over preloaded chunks. Corpus sizes here are thousands of chunks at
 * most, so scoring at query time from plain arrays beats maintaining incremental postings. */
function bm25Rank(queryText, chunks, { k = 5 } = {}) {
  const queryTerms = [...new Set(tokenize(queryText))];
  if (!queryTerms.length || !chunks.length) return [];
  const docTokens = chunks.map((chunk) => tokenize(`${chunk.title ?? ''} ${chunk.text}`));
  const avgLen = docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / docTokens.length || 1;

  const df = new Map();
  for (const term of queryTerms) {
    let count = 0;
    for (const tokens of docTokens) if (tokens.includes(term)) count += 1;
    df.set(term, count);
  }

  const scored = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const tokens = docTokens[i];
    if (!tokens.length) continue;
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const freq = tf.get(term) ?? 0;
      if (!freq) continue;
      const occurrences = df.get(term) || 0;
      const idf = Math.log(1 + (chunks.length - occurrences + 0.5) / (occurrences + 0.5));
      score += idf * ((freq * (BM25_K1 + 1)) / (freq + BM25_K1 * (1 - BM25_B + BM25_B * (tokens.length / avgLen))));
    }
    if (score > 0) scored.push({ score, chunk: chunks[i] });
  }
  scored.sort((a, b) => b.score - a.score || (a.chunk.id < b.chunk.id ? -1 : 1));
  return scored.slice(0, k).map(({ chunk, score }) => ({ ...chunk, score }));
}

/** Registry-derived document graph: every `@file.md` import inside a corpus document is an edge.
 * Guidance's own path-anchor rule makes these resolvable against the corpus root, which turns the
 * content itself into the knowledge graph — no LLM extraction, no external store. */
function buildImportGraph(corpusDir, { fsImpl = fs } = {}) {
  const edges = new Map();
  try { fsImpl.readdirSync(corpusDir); } catch { return edges; }
  const walk = (dir, rel) => {
    for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(abs, relPath); continue; }
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      const text = (() => { try { return fsImpl.readFileSync(abs, 'utf8'); } catch { return ''; } })();
      const targets = new Set();
      for (const match of text.matchAll(/(?:^|\s)@([^\s`]+\.md)\b/g)) {
        const target = path.posix.normalize(match[1].replace(/^\.\//, ''));
        if (target.startsWith('..') || path.isAbsolute(target)) continue;
        targets.add(target);
      }
      if (targets.size) edges.set(relPath, [...targets]);
    }
  };
  walk(corpusDir, '');
  return edges;
}

/** Expand BM25 hits along import edges (1 hop): a linked document is "what to read next" for the
 * question that surfaced its anchor. Graph results are capped separately and never displace
 * lexical hits — they extend the answer instead of reranking it. */
function expandViaGraph(hits, chunks, graph, { maxExtra = 3 } = {}) {
  const hitPaths = new Set(hits.map((h) => h.path));
  const seen = new Set();
  const extras = [];
  for (const hit of hits) {
    for (const target of graph.get(hit.path) ?? []) {
      if (hitPaths.has(target) || seen.has(target)) continue;
      seen.add(target);
      const linkedChunks = chunks.filter((c) => c.path === target);
      if (!linkedChunks.length) continue;
      const best = linkedChunks.reduce((a, b) => (b.text.length > a.text.length ? b : a));
      extras.push({
        path: best.path,
        title: best.title,
        score: null,
        snippet: `${best.text}`.replace(/\s+/g, ' ').slice(0, 200),
        viaGraph: hit.path,
      });
      if (extras.length >= maxExtra) return extras;
    }
  }
  return extras;
}

/** Ensure the on-disk index matches the corpus, rebuilding only what changed, then rank.
 * Returns {results, rebuilt}. A missing corpus is the caller's usage problem, thrown loudly. */
function searchGuidance({ corpusDir, indexDir, query, k = 5, fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(corpusDir)) {
    throw new Error(`No guidance tree found at '${corpusDir}' — run \`doflow install\` first`);
  }
  let rebuiltFiles = null;
  if (!isFresh({ corpusDir, indexDir, fsImpl })) {
    const build = buildIndex({ corpusDir, indexDir, fsImpl });
    rebuiltFiles = build.rebuilt;
  }
  const loaded = loadIndex({ indexDir, fsImpl });
  if (!loaded) throw new Error(`Index at '${indexDir}' is unreadable after rebuild`);
  const ranked = bm25Rank(query, loaded.chunks, { k }).map((hit) => ({
    path: hit.path,
    title: hit.title,
    score: Number(hit.score.toFixed(4)),
    snippet: `${hit.text}`.replace(/\s+/g, ' ').slice(0, 200),
  }));
  const graphHits = expandViaGraph(ranked, loaded.chunks, buildImportGraph(corpusDir, { fsImpl }));
  return { results: [...ranked, ...graphHits], rebuilt: rebuiltFiles };
}

/** CLI handler for `doflow retrieve`. The corpus is the caller's installed guidance tree; the
 * index lives beside it under `.doflow/index/`. Same two-roots posture as readiness: templates and
 * code from this install, knowledge from the project being worked on. */
function handleRetrieveCommand({ query, top, json = false, stateRoot } = {}) {
  const state = stateRoot || process.cwd();
  const corpusDir = path.join(state, '.doflow', 'guidance');
  const indexDir = path.join(state, '.doflow', 'index', 'guidance');
  if (!query || !String(query).trim()) {
    return usageError('retrieve', '--query is required (what should be looked up in the guidance tree?)', json);
  }
  const limit = Math.max(1, Math.min(Number(top) || 5, 25));
  try {
    const { results, rebuilt } = searchGuidance({ corpusDir, indexDir, query: String(query), k: limit });
    if (!json && rebuilt) console.log(`[INFO] Index refreshed (${rebuilt.length} file(s) re-chunked)`);
    if (json) {
      console.log(JSON.stringify({ query, results }, null, 2));
    } else if (!results.length) {
      console.log('[OK] No matching guidance found.');
    } else {
      results.forEach((result, i) => {
        console.log(`${i + 1}. [${result.score}] ${result.path}${result.title ? ` — ${result.title}` : ''}`);
        console.log(`   ${result.snippet}`);
      });
    }
    return finishRuntime(0);
  } catch (error) {
    console.error(`[ERROR] retrieve: ${error.message}`);
    return finishRuntime(1);
  }
}

module.exports = { bm25Rank, tokenize, searchGuidance, buildImportGraph, expandViaGraph, handleRetrieveCommand, STOPWORDS };
