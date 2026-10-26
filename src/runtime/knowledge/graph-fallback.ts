'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { traverseGraphRelationships, clampBounds } = require('./graph-adapter.ts');
const { resolveRolloutProfile } = require('../profiles/resolve.ts');

type GraphFreshnessStatus = 'FRESH' | 'STALE' | 'MISSING' | 'CORRUPT';

interface GraphFreshnessInfo {
  status: GraphFreshnessStatus;
  graphPath: string;
  graphMtimeMs: number | null;
  newestSourceMtimeMs: number | null;
  detail: string;
}

interface RelationshipQueryOptions {
  projectRoot: string;
  symbol: string;
  intent: 'trace-dependency' | 'estimate-blast-radius';
  bounds?: any;
  allowStale?: boolean; // default: false
}

interface CandidateLocator {
  file: string;
  line?: number;
  endLine?: number;
  symbol?: string;
}

interface ResolvedCandidate {
  locator: CandidateLocator;
  rank: number;
  score: number;
  source: 'graphify.query' | 'native.rg';
  relation?: string;
}

interface RelationshipResolution {
  query: string;
  intent: string;
  provider: 'graphify.query' | 'native.rg';
  status: 'HEALTHY' | 'FALLBACK' | 'UNAVAILABLE';
  freshness: GraphFreshnessStatus;
  fallbackReason?: 'index-stale' | 'index-missing' | 'index-corrupt' | 'graph-empty' | 'profile-disabled' | 'lexical-failed';
  candidates: ResolvedCandidate[];
  isAbsence: boolean;
  absenceReason?: string;
}

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'graphify-out',
  '.doflow',
  'dist',
  'build',
  'out',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
]);

function findNewestSourceMtime(
  dir: string,
  fsImpl: any = fs,
  limit: number = 2000
): { mtimeMs: number | null; count: number } {
  let newest: number | null = null;
  let count = 0;
  const queue = [dir];

  while (queue.length > 0 && count < limit) {
    const current = queue.shift()!;
    let entries: any[] = [];
    try {
      entries = fsImpl.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      const isDir = typeof entry === 'string' ? fsImpl.statSync(path.join(current, name)).isDirectory() : entry.isDirectory();

      if (name.startsWith('.') && isDir) continue;
      if (SKIP_DIRS.has(name)) continue;

      const fullPath = path.join(current, name);
      if (isDir) {
        queue.push(fullPath);
      } else {
        const isFile = typeof entry === 'string' ? fsImpl.statSync(fullPath).isFile() : entry.isFile();
        if (isFile) {
          count++;
          try {
            const stat = fsImpl.statSync(fullPath);
            if (newest === null || stat.mtimeMs > newest) {
              newest = stat.mtimeMs;
            }
          } catch {
            // ignore vanishing files
          }
        }
      }
    }
  }

  return { mtimeMs: newest, count };
}

function evaluateGraphFreshness(
  projectRoot: string,
  fsImpl: any = fs
): GraphFreshnessInfo {
  const graphPath = path.join(projectRoot, 'graphify-out', 'graph.json');

  let stat: any;
  try {
    stat = fsImpl.statSync(graphPath);
  } catch {
    const sourceInfo = findNewestSourceMtime(projectRoot, fsImpl);
    return {
      status: 'MISSING',
      graphPath,
      graphMtimeMs: null,
      newestSourceMtimeMs: sourceInfo.mtimeMs,
      detail: `Graph file not found at ${graphPath}`,
    };
  }

  const graphMtimeMs = stat.mtimeMs;

  try {
    const raw = fsImpl.readFileSync(graphPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      return {
        status: 'CORRUPT',
        graphPath,
        graphMtimeMs,
        newestSourceMtimeMs: null,
        detail: 'Graph JSON does not conform to expected schema (missing nodes/edges arrays)',
      };
    }
  } catch (err: any) {
    return {
      status: 'CORRUPT',
      graphPath,
      graphMtimeMs,
      newestSourceMtimeMs: null,
      detail: `Graph JSON is corrupt or unparseable: ${err.message}`,
    };
  }

  const sourceInfo = findNewestSourceMtime(projectRoot, fsImpl);
  const newestSourceMtimeMs = sourceInfo.mtimeMs;

  const behindMs = newestSourceMtimeMs !== null ? Math.floor(newestSourceMtimeMs - graphMtimeMs) : 0;

  if (behindMs > 50) {
    return {
      status: 'STALE',
      graphPath,
      graphMtimeMs,
      newestSourceMtimeMs,
      detail: `Graph index (${new Date(graphMtimeMs).toISOString()}) is older than newest source (${new Date(newestSourceMtimeMs!).toISOString()})`,
    };
  }

  return {
    status: 'FRESH',
    graphPath,
    graphMtimeMs,
    newestSourceMtimeMs,
    detail: 'Graph index is fresh and up-to-date with source repository',
  };
}

async function executeLexicalSearch(
  symbol: string,
  projectRoot: string,
  options?: { rgSearchImpl?: any }
): Promise<{ ok: boolean; matches: Array<{ file: string; line: number; content: string }>; reason?: string }> {
  if (options?.rgSearchImpl) {
    try {
      const matches = await options.rgSearchImpl(symbol, projectRoot);
      return Array.isArray(matches) ? { ok: true, matches } : { ok: false, matches: [], reason: 'lexical-search-returned-invalid-results' };
    }
    catch (error: any) { return { ok: false, matches: [], reason: error?.message || 'lexical-search-failed' }; }
  }

  try {
    const stdout = execFileSync('rg', ['--no-heading', '-n', '-w', symbol, '.'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const lines = stdout.trim().split('\n').filter(Boolean);
    const results: Array<{ file: string; line: number; content: string }> = [];

    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length >= 3) {
        const file = parts[0].replace(/^\.\//, '');
        const lineNum = parseInt(parts[1], 10) || 1;
        const content = parts.slice(2).join(':').trim();
        results.push({ file, line: lineNum, content });
      }
    }
    return { ok: true, matches: results };
  } catch (error: any) {
    if (error?.status === 1 || error?.code === 1) return { ok: true, matches: [] };
    return { ok: false, matches: [], reason: error?.message || error?.code || 'lexical-search-failed' };
  }
}

async function resolveRelationshipQuery(
  options: RelationshipQueryOptions,
  services?: { router?: any; fsImpl?: any; rgSearchImpl?: any; graphData?: any }
): Promise<RelationshipResolution> {
  const fsImpl = services?.fsImpl || fs;
  const freshness = evaluateGraphFreshness(options.projectRoot, fsImpl);
  const allowStale = options.allowStale === true;

  // The rollout profile turns the graph off only when one was chosen (env or settings), a rollback is active or
  // the value is invalid; a project that sets no profile (origin registry-default) keeps the graph.
  const profile = resolveRolloutProfile({
    projectRoot: options.projectRoot, fsImpl: typeof fsImpl.readFileSync === 'function' ? fsImpl : undefined,
  });
  const profileChosen = !(profile.origin.source === 'default' && profile.origin.detail === 'registry-default');
  const graphOff = profileChosen && profile.capabilities.graph === 'off';

  const isGraphUsable = !graphOff
    && (freshness.status === 'FRESH' || (allowStale && freshness.status === 'STALE'));

  if (isGraphUsable) {
    const direction = options.intent === 'estimate-blast-radius' ? 'upstream' : 'both';
    const traversal = await traverseGraphRelationships({
      projectRoot: options.projectRoot,
      seeds: [options.symbol],
      direction,
      bounds: options.bounds,
      graphData: services?.graphData,
      fsImpl,
    });

    if (traversal.ok && traversal.nodes.length > 0) {
      const candidates: ResolvedCandidate[] = traversal.nodes.map((node: any, index: number) => {
        let file = node.file ? node.file : node.id;
        if (path.isAbsolute(file)) {
          file = path.relative(options.projectRoot, file);
        }
        return {
          locator: {
            file,
            line: node.line,
            symbol: node.label || node.id,
          },
          rank: index + 1,
          score: Math.max(0.1, Number((1.0 - index * 0.05).toFixed(2))),
          source: 'graphify.query',
          relation: node.kind,
        };
      });

      return {
        query: options.symbol,
        intent: options.intent,
        provider: 'graphify.query',
        status: 'HEALTHY',
        freshness: freshness.status,
        candidates,
        isAbsence: false,
      };
    }

    const lexical = await executeLexicalSearch(options.symbol, options.projectRoot, {
      rgSearchImpl: services?.rgSearchImpl,
    });
    if (!lexical.ok) return {
      query: options.symbol, intent: options.intent, provider: 'native.rg', status: 'UNAVAILABLE',
      freshness: freshness.status, fallbackReason: 'lexical-failed', candidates: [], isAbsence: false,
      absenceReason: `Lexical fallback failed: ${lexical.reason}`,
    };
    const lexMatches = lexical.matches;

    if (lexMatches.length > 0) {
      const candidates: ResolvedCandidate[] = lexMatches.slice(0, 50).map((match, index) => ({
        locator: {
          file: match.file,
          line: match.line,
          symbol: options.symbol,
        },
        rank: index + 1,
        score: Math.max(0.1, Number((0.8 - index * 0.02).toFixed(2))),
        source: 'native.rg',
      }));

      return {
        query: options.symbol,
        intent: options.intent,
        provider: 'native.rg',
        status: 'FALLBACK',
        freshness: freshness.status,
        fallbackReason: 'graph-empty',
        candidates,
        isAbsence: false,
      };
    }

    return {
      query: options.symbol,
      intent: options.intent,
      provider: 'native.rg',
      status: 'FALLBACK',
      freshness: freshness.status,
      fallbackReason: 'graph-empty',
      candidates: [],
      isAbsence: true,
      absenceReason: `Both graph traversal and lexical search confirmed zero occurrences of '${options.symbol}'`,
    };
  }

  const fallbackReason: 'index-stale' | 'index-missing' | 'index-corrupt' | 'profile-disabled' = graphOff
    ? 'profile-disabled'
    : freshness.status === 'STALE'
      ? 'index-stale'
      : freshness.status === 'MISSING'
      ? 'index-missing'
      : 'index-corrupt';

  const lexical = await executeLexicalSearch(options.symbol, options.projectRoot, {
    rgSearchImpl: services?.rgSearchImpl,
  });
  if (!lexical.ok) return {
    query: options.symbol, intent: options.intent, provider: 'native.rg', status: 'UNAVAILABLE',
    freshness: freshness.status, fallbackReason: 'lexical-failed', candidates: [], isAbsence: false,
    absenceReason: `Lexical fallback failed: ${lexical.reason}`,
  };
  const lexMatches = lexical.matches;

  if (lexMatches.length > 0) {
    const candidates: ResolvedCandidate[] = lexMatches.slice(0, 50).map((match, index) => ({
      locator: {
        file: match.file,
        line: match.line,
        symbol: options.symbol,
      },
      rank: index + 1,
      score: Math.max(0.1, Number((0.8 - index * 0.02).toFixed(2))),
      source: 'native.rg',
    }));

    return {
      query: options.symbol,
      intent: options.intent,
      provider: 'native.rg',
      status: 'FALLBACK',
      freshness: freshness.status,
      fallbackReason,
      candidates,
      isAbsence: false,
    };
  }

  return {
    query: options.symbol,
    intent: options.intent,
    provider: 'native.rg',
    status: 'FALLBACK',
    freshness: freshness.status,
    fallbackReason,
    candidates: [],
    isAbsence: true,
    absenceReason: `Lexical search confirmed zero occurrences of '${options.symbol}' across repository`,
  };
}

module.exports = {
  findNewestSourceMtime,
  evaluateGraphFreshness,
  executeLexicalSearch,
  resolveRelationshipQuery,
};
