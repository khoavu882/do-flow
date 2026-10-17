'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');

/**
 * Combines ranked lists using Reciprocal Rank Fusion (RRF).
 * @param {Array<Array<{ id?: string, path?: string, locator?: string|Object }>>} rankedLists
 * @param {{ k?: number }} [options]
 * @returns {Array<{ id: string, rrfScore: number }>}
 */
function reciprocalRankFusion(rankedLists: any[][], { k = 60, fullPrecision = false }: { k?: number; fullPrecision?: boolean } = {}): any[] {
  const scores = new Map<string, number>();
  const items = new Map<string, any>();

  for (const list of rankedLists) {
    if (!Array.isArray(list)) continue;
    for (let rank = 0; rank < list.length; rank += 1) {
      const item = list[rank];
      if (!item) continue;
      const id = item.id
        || item.path
        || (item.locator ? (typeof item.locator === 'string' ? item.locator : `${item.locator.file}:${item.locator.line || 1}`) : null);
      if (!id) continue;
      const rrf = 1 / (k + rank + 1);
      scores.set(id, (scores.get(id) || 0) + rrf);
      if (!items.has(id)) items.set(id, item);
    }
  }

  const fused: any[] = [];
  for (const [id, rrfScore] of scores.entries()) {
    fused.push({
      ...items.get(id),
      id,
      rrfScore: fullPrecision ? rrfScore : Number(rrfScore.toFixed(6)),
    });
  }

  fused.sort((a: any, b: any) => b.rrfScore - a.rrfScore || (a.id < b.id ? -1 : 1));
  return fused;
}

/**
 * Normalizes a locator into a canonical repository-relative file path and line numbers.
 * @param {string|Object} raw
 * @param {string} [projectRoot]
 * @returns {{ file: string, line?: number, endLine?: number }}
 */
function normalizeLocator(raw: any, projectRoot: string = process.cwd()): { file: string; line?: number; endLine?: number } {
  if (!raw) return { file: '' };
  if (typeof raw === 'string') {
    const match = raw.match(/^([^:]+)(?::(\d+))?(?::(\d+))?$/);
    if (match) {
      const relFile = path.isAbsolute(match[1]) ? path.relative(projectRoot, match[1]) : match[1];
      return {
        file: relFile,
        ...(match[2] ? { line: parseInt(match[2], 10) } : {}),
      };
    }
    return { file: path.isAbsolute(raw) ? path.relative(projectRoot, raw) : raw };
  }
  if (typeof raw === 'object' && raw.file) {
    const relFile = path.isAbsolute(raw.file) ? path.relative(projectRoot, raw.file) : raw.file;
    return {
      file: relFile,
      ...(raw.line ? { line: raw.line } : {}),
      ...(raw.endLine ? { endLine: raw.endLine } : {}),
    };
  }
  return { file: '' };
}

/**
 * Fuses lexical and semantic search results using RRF and reads bounded live source.
 * Ranking scores are preserved in candidate metadata and kept strictly outside evidence verdicts.
 *
 * @param {Object} params
 * @param {Array<Object>} [params.lexicalResults=[]]
 * @param {Array<Object>} [params.semanticResults=[]]
 * @param {number} [params.k=60]
 * @param {number} [params.topN=10]
 * @param {string} [params.projectRoot]
 * @param {number} [params.maxSnippetLines=50]
 * @param {Object} [params.fsImpl]
 * @returns {Array<Object>} Fused candidates with bounded snippets
 */
function fuseHybridResults({
  lexicalResults = [],
  semanticResults = [],
  k = 60,
  topN = 10,
  projectRoot = process.cwd(),
  maxSnippetLines = 50,
  fsImpl = fs,
}: {
  lexicalResults?: any[];
  semanticResults?: any[];
  k?: number;
  topN?: number;
  projectRoot?: string;
  maxSnippetLines?: number;
  fsImpl?: any;
} = {}): any[] {
  const normLex = (Array.isArray(lexicalResults) ? lexicalResults : []).map((item: any, idx: number) => {
    const loc = normalizeLocator(item.locator || item.path || item.file, projectRoot);
    const id = `${loc.file}:${loc.line || 1}`;
    return { ...item, id, locator: loc, sourceList: 'lexical', originalRank: idx };
  });

  const normSem = (Array.isArray(semanticResults) ? semanticResults : []).map((item: any, idx: number) => {
    const loc = normalizeLocator(item.locator || item.path || item.file, projectRoot);
    const id = `${loc.file}:${loc.line || 1}`;
    return { ...item, id, locator: loc, sourceList: 'semantic', originalRank: idx };
  });

  const fused = reciprocalRankFusion([normLex, normSem], { k });
  const candidates = fused.slice(0, topN);

  for (const c of candidates) {
    if (!c.snippet && c.locator && c.locator.file) {
      const fullPath = path.resolve(projectRoot, c.locator.file);
      try {
        if (fsImpl.existsSync(fullPath)) {
          const content = fsImpl.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          const startLine = Math.max(1, (c.locator.line || 1) - 2);
          const endLine = Math.min(lines.length, startLine + maxSnippetLines - 1);
          c.snippet = lines.slice(startLine - 1, endLine).join('\n');
          c.liveRead = { startLine, endLine, totalFileLines: lines.length };
        }
      } catch {
        c.liveRead = null;
      }
    }
  }

  return candidates;
}

/** Strict code candidates are separate from the legacy guidance locator string convention. */
function normalizeCodeCandidates(items: any[], { projectRoot = process.cwd(), provider, capability, corpusIdentity = '', queryRef = null, retrievalAttemptRef = null }: any = {}): any {
  const { relativeCodePath } = require('./code-corpus.ts');
  const candidates: any[] = [];
  const rejected: any[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    let raw: any = item?.locator || item?.path || item?.file;
    let loc: any;
    if (typeof raw === 'string') {
      const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(raw);
      if (match) loc = { file: match[1], line: Number(match[2]), endLine: Number(match[3] || match[2]) };
      else loc = { file: raw, line: item.startLine ?? item.line ?? 1, endLine: item.endLine ?? item.startLine ?? item.line ?? 1 };
    } else if (raw && typeof raw === 'object') {
      loc = { file: raw.file, line: raw.line ?? raw.startLine ?? 1, endLine: raw.endLine ?? raw.line ?? raw.startLine ?? 1 };
    }
    if (loc && typeof loc.file === 'string' && path.isAbsolute(loc.file)) loc.file = path.relative(projectRoot, loc.file);
    const file = relativeCodePath(loc?.file);
    if (!file || !Number.isInteger(loc.line) || !Number.isInteger(loc.endLine) || loc.line < 1 || loc.endLine < loc.line) {
      rejected.push({ locator: raw ?? null, reason: 'invalid-locator' }); continue;
    }
    loc.file = file;
    const id = JSON.stringify([corpusIdentity, file, loc.line, loc.endLine]);
    const actualProvider = item.provider || provider;
    const actualCapability = item.capability || capability;
    const origin = { provider: actualProvider, capability: actualCapability, queryRef: item.queryRef ?? queryRef,
      retrievalAttemptRef: item.retrievalAttemptRef ?? retrievalAttemptRef,
      originalRank: candidates.length + 1, sourceVersion: item.sourceVersion ?? null };
    const origins = item.origins?.length ? item.origins.map((o: any) => ({ ...origin, ...o })) : [origin];
    candidates.push({ ...item, schemaVersion: 1, id, locator: loc, provider: actualProvider, capability: actualCapability, origins });
  }
  return { candidates, rejected };
}

/** One full-span vote per provider, all origins retained, full precision until presentation. */
function fuseRankedCandidates({ rankedLists, projectRoot = process.cwd(), corpusIdentity = '', k = 60 }: any): any {
  const { compareText } = require('./code-corpus.ts');
  const providerLists = new Map<string, any[]>();
  const origins = new Map<string, any[]>();
  const rejected: any[] = [];
  for (let listIndex = 0; listIndex < rankedLists.length; listIndex += 1) {
    const list = rankedLists[listIndex];
    const normalized = normalizeCodeCandidates(Array.isArray(list) ? list : list.candidates,
      { projectRoot, corpusIdentity, provider: list.provider || 'list-' + listIndex, capability: list.capability,
        queryRef: list.queryRef, retrievalAttemptRef: list.retrievalAttemptRef });
    rejected.push(...normalized.rejected);
    for (const item of normalized.candidates) {
      const provider = item.provider;
      if (!providerLists.has(provider)) providerLists.set(provider, []);
      providerLists.get(provider)!.push(item);
      if (!origins.has(item.id)) origins.set(item.id, []);
      const bucket = origins.get(item.id)!;
      for (const origin of item.origins) {
        const serialized = JSON.stringify(origin);
        if (!bucket.some((o: any) => JSON.stringify(o) === serialized)) bucket.push(origin);
      }
    }
  }
  const uniqueProviderLists = [...providerLists.values()].map((list: any[]) => {
    const seen = new Set<string>();
    return list.filter((item: any) => { if (seen.has(item.id)) return false; seen.add(item.id); return true; });
  });
  const candidates = reciprocalRankFusion(uniqueProviderLists, { k, fullPrecision: true }).map((item: any) => ({ ...item, origins: origins.get(item.id) }));
  candidates.sort((a: any, b: any) => b.rrfScore - a.rrfScore || compareText(a.locator.file, b.locator.file)
    || a.locator.line - b.locator.line || a.locator.endLine - b.locator.endLine);
  candidates.forEach((candidate: any, index: number) => { candidate.rank = index + 1; });
  return { candidates, rejected };
}

module.exports = {
  reciprocalRankFusion,
  normalizeLocator,
  normalizeCodeCandidates,
  fuseRankedCandidates,
  fuseHybridResults,
};
