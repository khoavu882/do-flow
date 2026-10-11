'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Combines ranked lists using Reciprocal Rank Fusion (RRF).
 * @param {Array<Array<{ id?: string, path?: string, locator?: string|Object }>>} rankedLists
 * @param {{ k?: number }} [options]
 * @returns {Array<{ id: string, rrfScore: number }>}
 */
function reciprocalRankFusion(rankedLists, { k = 60 } = {}) {
  const scores = new Map();
  const items = new Map();

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
      if (!items.has(id)) {
        items.set(id, item);
      }
    }
  }

  const fused = [];
  for (const [id, rrfScore] of scores.entries()) {
    fused.push({
      ...items.get(id),
      id,
      rrfScore: Number(rrfScore.toFixed(6)),
    });
  }

  fused.sort((a, b) => b.rrfScore - a.rrfScore || (a.id < b.id ? -1 : 1));
  return fused;
}

/**
 * Normalizes a locator into a canonical repository-relative file path and line numbers.
 * @param {string|Object} raw
 * @param {string} [projectRoot]
 * @returns {{ file: string, line?: number, endLine?: number }}
 */
function normalizeLocator(raw, projectRoot = process.cwd()) {
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
} = {}) {
  const normLex = (Array.isArray(lexicalResults) ? lexicalResults : []).map((item, idx) => {
    const loc = normalizeLocator(item.locator || item.path || item.file, projectRoot);
    const id = `${loc.file}:${loc.line || 1}`;
    return { ...item, id, locator: loc, sourceList: 'lexical', originalRank: idx };
  });

  const normSem = (Array.isArray(semanticResults) ? semanticResults : []).map((item, idx) => {
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

module.exports = {
  reciprocalRankFusion,
  normalizeLocator,
  fuseHybridResults,
};
