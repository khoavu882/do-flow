'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// Retrieval over the guidance index. Ranking is BM25 — pure, deterministic, and the correctness
// floor: BM25 plus the import graph answer questions well enough that no downstream stage depends
// on embeddings being present. Dense/rerank slots (models.json `slots`, resolved by
// model-router's resolveRetrievalSlot) stay inert until a slot is declared AND enabled — an
// absent embedding provider degrades to lexical-only, never to a silent half-answer.

const fs = require('node:fs');
const path = require('node:path');
const { buildIndex, loadIndex, isFresh } = require('./index-store.ts');
const { finishRuntime, usageError, captureCaught } = require('../cli-result.ts');
const { resolveRunsLocation } = require('../trace/ledger.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'as', 'by', 'at',
  'from', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those',
  'do', 'does', 'did', 'how', 'what', 'when', 'which', 'who', 'why', 'not', 'no', 'yes', 'can',
]);

function tokenize(text: any): string[] {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

/** Deterministic BM25 (Okapi) over preloaded chunks. Corpus sizes here are thousands of chunks at
 * most, so scoring at query time from plain arrays beats maintaining incremental postings. */
function bm25Rank(queryText: string, chunks: any[], { k = 5 }: { k?: number } = {}): any[] {
  const queryTerms = [...new Set(tokenize(queryText))];
  if (!queryTerms.length || !chunks.length) return [];
  const docTokens = chunks.map((chunk: any) => tokenize(`${chunk.title ?? ''} ${chunk.text}`));
  const avgLen = docTokens.reduce((sum: number, tokens: string[]) => sum + tokens.length, 0) / docTokens.length || 1;

  const df = new Map<string, number>();
  for (const term of queryTerms) {
    let count = 0;
    for (const tokens of docTokens) if (tokens.includes(term)) count += 1;
    df.set(term, count);
  }

  const scored: Array<{ score: number; chunk: any }> = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const tokens = docTokens[i];
    if (!tokens.length) continue;
    const tf = new Map<string, number>();
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
function buildImportGraph(corpusDir: string, { fsImpl = fs }: { fsImpl?: any } = {}): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  try { fsImpl.readdirSync(corpusDir); } catch { return edges; }
  const walk = (dir: string, rel: string) => {
    for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(abs, relPath); continue; }
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      const text = (() => { try { return fsImpl.readFileSync(abs, 'utf8'); } catch { return ''; } })();
      const targets = new Set<string>();
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
function expandViaGraph(hits: any[], chunks: any[], graph: Map<string, string[]>, { maxExtra = 3 }: { maxExtra?: number } = {}): any[] {
  const hitPaths = new Set(hits.map((h: any) => h.path));
  const seen = new Set<string>();
  const extras: any[] = [];
  for (const hit of hits) {
    for (const target of graph.get(hit.path) ?? []) {
      if (hitPaths.has(target) || seen.has(target)) continue;
      seen.add(target);
      const linkedChunks = chunks.filter((c: any) => c.path === target);
      if (!linkedChunks.length) continue;
      const best = linkedChunks.reduce((a: any, b: any) => (b.text.length > a.text.length ? b : a));
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

// The shortlist is the first-stage list the rerank kind may be asked about (141 IC-010): at most the 16 labels A to P,
// so the registry's `params.maxCandidates` (never above 16) always fits. It is never printed.
const SHORTLIST_LIMIT = 16;

/** Ensure the on-disk index matches the corpus, rebuilding only what changed, then rank.
 * Returns {results, shortlist, rebuilt}. `shortlist` is `[{ ref, title, text }]` for the first `maxCandidates` BM25 hits,
 * taken before graph expansion, with the chunk's own text (`results` keeps the 200-character snippet).
 * A missing corpus is the caller's usage problem, thrown loudly. */
function searchGuidance({ corpusDir, indexDir, query, k = 5, maxCandidates = SHORTLIST_LIMIT, fsImpl = fs }: { corpusDir: string; indexDir: string; query: string; k?: number; maxCandidates?: number; fsImpl?: any } = {} as any): any {
  if (!fsImpl.existsSync(corpusDir)) {
    throw new Error(`No guidance tree found at '${corpusDir}' — run \`doflow install\` first`);
  }
  let rebuiltFiles: string[] | null = null;
  if (!isFresh({ corpusDir, indexDir, fsImpl })) {
    const build = buildIndex({ corpusDir, indexDir, fsImpl });
    rebuiltFiles = build.rebuilt;
  }
  const loaded = loadIndex({ indexDir, fsImpl });
  if (!loaded) throw new Error(`Index at '${indexDir}' is unreadable after rebuild`);
  // BM25 order is a stable prefix (ties break on chunk id), so the first k of a longer list are the same k hits.
  const hits = bm25Rank(query, loaded.chunks, { k: Math.max(k, Math.min(Math.max(0, maxCandidates), SHORTLIST_LIMIT)) });
  const ranked = hits.slice(0, k).map((hit: any) => ({
    path: hit.path,
    title: hit.title,
    score: Number(hit.score.toFixed(4)),
    snippet: `${hit.text}`.replace(/\s+/g, ' ').slice(0, 200),
  }));
  const shortlist = hits.slice(0, Math.min(Math.max(0, maxCandidates), SHORTLIST_LIMIT))
    .map((hit: any) => ({ ref: hit.path, title: hit.title ?? '', text: `${hit.text}` }));
  const graphHits = expandViaGraph(ranked, loaded.chunks, buildImportGraph(corpusDir, { fsImpl }));
  return { results: [...ranked, ...graphHits], shortlist, rebuilt: rebuiltFiles };
}

/**
 * Shadow rerank hook (141 IC-010), shared by guidance and code retrieve. Called after the output is printed. It asks the
 * advisor, detached and unawaited, to order the first-stage `candidates` (`[{ ref, title, text }]`), and records the
 * answer as a `rerank` pick. It never reads or changes what was printed, the exit status or the order of the results,
 * and it catches every error: a hook fault, a missing registry or a refused criteria setting is silent here (the
 * criteria warning is shown by `advise --action report`, so `retrieve` output equals the kind-off run).
 * Skipped when the kind is off (which includes advice off), or fewer than `params.minCandidates` candidates exist.
 * `services` is the test seam of the dispatcher (`adviceClient`, `shadowConfig`, `roots`, `fsImpl`, `adviceRegistry`).
 */
function fireShadowRerank({ query, candidates, firstStageMs, projectRoot, env, services }: any): void {
  try {
    const svc = services && typeof services === 'object' ? services : {};
    const root = projectRoot || process.cwd();
    const environment = env || process.env;
    if (!Array.isArray(candidates) || candidates.length < 2) return;
    const { resolveShadowConfig } = require('../advice/shadow-config.ts');
    const shadowConfig = svc.shadowConfig || resolveShadowConfig('rerank', { projectRoot: root, env: environment, fsImpl: svc.fsImpl, roots: svc.roots });
    if (!shadowConfig || (shadowConfig.mode !== 'shadow' && shadowConfig.mode !== 'act')) return;
    const adviceRegistry = svc.adviceRegistry || (() => {
      const loaded = require('../advice/registry.ts').loadAdviceRegistry({ repoRoot: REPO_ROOT });
      return loaded.ok ? loaded.registry : null;
    })();
    const kind = adviceRegistry?.kinds?.find((entry: any) => entry?.id === 'rerank');
    if (!kind || candidates.length < kind.params.minCandidates) return;
    const { resolveRerankCriteria } = require('../advice/criteria.ts');
    const { buildRerankQuestionSet, interpretRerankAnswers, rerankPayload } = require('../advice/rerank.ts');
    const { interceptDecisionPoint } = require('../advice/shadow-dispatcher.ts');
    const criteria = resolveRerankCriteria({ kind, adviceRegistry, projectRoot: root, env: environment, fsImpl: svc.fsImpl });
    const built = buildRerankQuestionSet({
      query, candidates, params: kind.params, arm: kind.params.arm, criteria, scoreLadder: kind.scoreLadder, limits: adviceRegistry.limits,
    });
    if (!built.ok) return;
    const describe = (call: any) => {
      const read = interpretRerankAnswers(call.answers, built.labels, built.arm);
      if (!read.valid) return null;
      const rerank = {
        ...rerankPayload({
          arm: built.arm, labels: built.labels, refs: built.refs, order: read.order, truncated: built.truncated, params: kind.params,
          firstStageMs, expected: read.expected, confidence: read.confidence, criteriaDigest: criteria.digest,
        }),
        criteriaSource: criteria.source,
      };
      return { pick: read.order[0], extra: { rerank } };
    };
    interceptDecisionPoint({
      kind: 'rerank', caller: 'retrieve', state: built.questionSet.state, staticPick: 'A', questionSet: built.questionSet,
      adviceRegistry, budgetMs: kind.budgetMs, describe, projectRoot: root, env: environment,
    }, { ...svc, shadowConfig }).catch(() => {});
  } catch { /* advice is advisory: nothing here may change a retrieve result */ }
}

/** CLI handler for `doflow retrieve`. The corpus is the caller's installed guidance tree; the
 * index lives beside it under `.doflow/index/`. Same two-roots posture as readiness: templates and
 * code from this install, knowledge from the project being worked on. The `.doflow` root is
 * $DOFLOW_CONFIG_DIR, else the nearest one above `stateRoot` that holds a guidance tree, else the
 * home install; the index is kept beside the corpus chosen. */
function handleRetrieveCommand(options: any = {}): any {
  const { query, top, json = false, stateRoot } = options;
  if (options.scope !== undefined && options.scope !== 'guidance' && options.scope !== 'code') {
    return usageError('retrieve', `--scope must be guidance or code, got '${options.scope}'`, json);
  }
  if (options.scope === 'code' || options.indexAction !== undefined) {
    if (options.scope !== 'code') return usageError('retrieve', '--index-action requires --scope code', json);
    return handleCodeRetrieveCommand(options);
  }
  const { configDir } = resolveRunsLocation({ start: stateRoot, containing: 'guidance' });
  const corpusDir = path.join(configDir, 'guidance');
  const indexDir = path.join(configDir, 'index', 'guidance');
  if (!query || !String(query).trim()) {
    return usageError('retrieve', '--query is required (what should be looked up in the guidance tree?)', json);
  }
  const limit = Math.max(1, Math.min(Number(top) || 5, 25));
  try {
    const startedAt = Date.now();
    const { results, shortlist, rebuilt } = searchGuidance({ corpusDir, indexDir, query: String(query), k: limit });
    const firstStageMs = Date.now() - startedAt;
    if (!json && rebuilt) console.log(`[INFO] Index refreshed (${rebuilt.length} file(s) re-chunked)`);
    if (json) {
      console.log(JSON.stringify({ query, results }, null, 2));
    } else if (!results.length) {
      console.log('[OK] No matching guidance found.');
    } else {
      results.forEach((result: any, i: number) => {
        console.log(`${i + 1}. [${result.score}] ${result.path}${result.title ? ` — ${result.title}` : ''}`);
        console.log(`   ${result.snippet}`);
      });
    }
    fireShadowRerank({ query: String(query), candidates: shortlist, firstStageMs, projectRoot: options.projectRoot, env: options.env, services: options.adviceServices });
    return finishRuntime(0);
  } catch (error: any) {
    captureCaught(error, 'retrieve', 1);
    console.error(`[ERROR] retrieve: ${error.message}`);
    return finishRuntime(1);
  }
}

/** Additive code path. The guidance branch above retains its existing output and exit behavior. The search root is
 * `root` or cwd, never `stateRoot`: in a linked worktree the state root is the main checkout's feature store. */
function handleCodeRetrieveCommand(options: any): any {
  const { executeCodeRetrieval } = require('./code-retrieval.ts');
  const startedAt = Date.now();
  return executeCodeRetrieval({ ...options, root: options.root || process.cwd() }).then((outcome: any) => {
    const response = outcome.response;
    if (options.json) console.log(JSON.stringify(response, null, 2));
    else if (!response.ok) console.error(`[ERROR] retrieve: ${response.error}${response.cause ? ` (${response.cause})` : ''}${response.summary ? ` — ${response.summary}` : ''}`);
    else if (response.action) console.log(`${response.complete ? '[OK]' : '[ERROR]'} ${response.action} code index${response.generation ? ` ${response.generation}` : ''}`);
    else if (!response.results.length) console.log('[OK] No matching code found in the attempted scope. absenceEstablished=false');
    else response.results.forEach((candidate: any, index: number) => {
      console.log(`${index + 1}. ${candidate.locator.file}:${candidate.locator.line}-${candidate.locator.endLine}`);
      if (candidate.snippet) console.log(`   ${candidate.snippet}`);
    });
    if (!options.json && response.gaps?.length) for (const gap of response.gaps) console.error(`[INFO] retrieve gap: ${gap.provider || gap.source || 'retrieval'} ${gap.reason}`);
    if (response.ok && !response.action && Array.isArray(response.results)) {
      // The shortlist is the delivered candidates, locator and snippet; `profile` does not change the hook.
      const candidates = response.results.slice(0, SHORTLIST_LIMIT).map((candidate: any) => ({
        ref: `${candidate?.locator?.file}:${candidate?.locator?.line}`, title: '', text: typeof candidate?.snippet === 'string' ? candidate.snippet : '',
      }));
      fireShadowRerank({ query: String(options.query ?? '').trim(), candidates, firstStageMs: Date.now() - startedAt, projectRoot: options.projectRoot, env: options.env, services: options.adviceServices });
    }
    return finishRuntime(outcome.exit);
  }).catch((error: any) => {
    captureCaught(error, 'retrieve', 1);
    if (options.json) console.log(JSON.stringify({ ok: false, schemaVersion: 1, scope: 'code', error: 'retrieval-failed', cause: error.message }, null, 2));
    else console.error(`[ERROR] retrieve: ${error.message}`);
    return finishRuntime(1);
  });
}

const {
  reciprocalRankFusion,
  normalizeLocator,
  fuseHybridResults,
} = require('./hybrid.ts');

module.exports = {
  bm25Rank,
  tokenize,
  searchGuidance,
  buildImportGraph,
  expandViaGraph,
  handleRetrieveCommand,
  handleCodeRetrieveCommand,
  STOPWORDS,
  reciprocalRankFusion,
  normalizeLocator,
  fuseHybridResults,
};
