'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const adaptersA = require('./adapters-a.ts');
const adaptersB = require('./adapters-b.ts');
const { childEnv } = require('../runner.ts');

const BRIDGE = String.raw`'use strict';
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const { executeCodeRetrieval } = require(input.modulePath);
const providers = {};
if ((input.disabledProviders || []).includes('native.rg')) providers.lexicalSearch = () => ({ candidates: [], complete: false,
  rejections: [{ reason: 'provider-error' }], coverage: { complete: false }, accounting: {} });
if ((input.disabledProviders || []).includes('semble.search')) providers.semanticQuery = async () => ({ ok: false,
  reason: 'provider-unavailable', freshness: 'UNKNOWN', candidates: [] });
executeCodeRetrieval({ ...input.options, ...(Object.keys(providers).length ? { providers } : {}) }).then((result) => process.stdout.write(JSON.stringify(result))).catch((error) => {
  process.stdout.write(JSON.stringify({ exit: 1, response: { ok: false, error: 'coordinator-failed', cause: error.message } }));
});`;

function mapCodeResponse(result: any, wallMs = 0) {
  const body = result && result.response || {};
  const candidates = (body.results || []).map((item: any, index: any) => {
    const loc = item.locator || {};
    const text = item.content || item.snippet || '';
    return { path: loc.file, startLine: loc.line, endLine: loc.endLine, heading: null, rank: index + 1,
      provider: item.provider, snippet: text, snippetBytes: Buffer.byteLength(text, 'utf8'), origins: item.origins };
  });
  const rejected = (body.gaps || []).filter((g: any) => g.source === 'live-validation').length;
  const providers = (body.attempts || []).map((attempt: any) => ({ id: attempt.provider,
    state: attempt.complete ? 'reached' : 'unreached', ...(attempt.reason ? { cause: attempt.reason } : {}) }));
  // The coordinator records a semantic attempt complete only when the semantic provider answered (code-retrieval.ts).
  const semanticReached = (body.attempts || []).some((attempt: any) => attempt.provider === 'semble.search' && attempt.complete) ? 1 : 0;
  const resultStatus = result.exit !== 0 ? 'UNREACHED' : candidates.length ? 'RETRIEVED'
    : providers.length && providers.every((provider: any) => provider.state === 'unreached') ? 'UNREACHED' : 'EMPTY';
  return { result: resultStatus, freshness: (body.attempts || []).some((a: any) => a.provider === 'semble.search')
    ? ((body.attempts.find((a: any) => a.provider === 'semble.search') || {}).indexState || 'UNKNOWN') : 'NOT_APPLICABLE',
  candidates, providers, payloadBytes: candidates.reduce((sum: any, c: any) => sum + c.snippetBytes, 0), wallMs,
  rawValidity: { raw: candidates.length + rejected, delivered: candidates.length, rejected, gaps: (body.gaps || []).length, semanticReached }, effectiveProfile: body.effectiveProfile || 'lexical-only' };
}

/** The C index-build cost block for the report: measured when the build succeeded, unreached with its cause when not. */
function describeIndexBuild(response: any, wallMs: any) {
  const build = response || {};
  if (build.ok === true) {
    return { state: 'reached', buildMs: typeof build.elapsedMs === 'number' ? build.elapsedMs : wallMs, chunks: build.chunks,
      diskBytes: typeof build.artifactBytes === 'number' ? build.artifactBytes : { unmeasured: 'index builder reported no artifact size' },
      peakRssMB: { unmeasured: 'the index builder reports no resident-set size' }, freshness: build.freshness };
  }
  const cause = build.reason || (build.error ? `${build.error}${build.cause ? `: ${build.cause}` : ''}` : 'index build failed');
  const unmeasured = { unmeasured: cause };
  return { state: 'unreached', cause, buildMs: unmeasured, chunks: unmeasured, diskBytes: unmeasured, peakRssMB: unmeasured };
}

function buildCodeIndex({ exportRoot, admittedPaths, modelPath = process.env.SEMBLE_MODEL_PATH, semble }: any = {}) {
  if (!modelPath) return { ok: false, reason: 'local-model-required' };
  const modulePath = path.resolve(__dirname, '../../../src/runtime/knowledge/code-retrieval.ts');
  const run = spawnSync(process.execPath, ['-e', BRIDGE], { cwd: path.resolve(__dirname, '../../..'),
    input: JSON.stringify({ modulePath, options: { root: exportRoot, scopes: admittedPaths, modelPath, indexAction: 'build' } }),
    env: childEnv(semble && semble.env), encoding: 'utf8', timeout: 130000, maxBuffer: 2 * 1024 * 1024 });
  if (run.error || run.status !== 0) return { ok: false, reason: run.error ? run.error.message : `index builder exited ${run.status}` };
  try { const result = JSON.parse(run.stdout); return result.response || { ok: false, reason: 'invalid-index-response' }; }
  catch { return { ok: false, reason: 'invalid-index-response' }; }
}

/**
 * Where C serves a class (DEC-004, DEC-024): the production coordinator for code exact and conceptual,
 * A's path for the graph-routed code classes (IC-009), B's path for everything else.
 */
function servedBy(corpus: any, cls: any) {
  if (corpus === 'code' && (cls === 'exact-lookup' || cls === 'conceptual-discovery')) return 'coordinator';
  if (corpus === 'code' && (cls === 'impact-refactor' || cls === 'verification-failure')) return 'delegated-A';
  return 'delegated-B';
}

/** The code classes C answers through A's own path (IC-009: impact/refactor keeps A's graph route). */
function delegatesToA(task: any) {
  return servedBy('code', task.class) === 'delegated-A';
}

/** The provider B's path serves per corpus; the same ids adapters.js checks against `setup.disable` for B. */
const B_PROVIDER: any = { code: 'native.rg', guidance: 'guidance.bm25' };

/** C reuses the shipped coordinator in a child process so the benchmark's sync runner stays compatible. */
function runC({ corpus, task, exportRoot, indexRoot = exportRoot, capabilities, bins = {}, semble, scratchDir, admittedPaths, executeCodeRetrieval, spawn = spawnSync }: any) {
  const route = servedBy(corpus, task.class);
  const disabled = (task.setup && task.setup.disable) || [];
  // A delegated class honours an injected fault exactly as the configuration it runs as: B checks
  // `setup.disable` before it queries (adapters.js runConfig); A checks it per provider in its chain (runA).
  if (route === 'delegated-B') {
    if (disabled.includes(B_PROVIDER[corpus])) {
      return { result: 'UNREACHED', freshness: corpus === 'guidance' ? 'UNKNOWN' : 'NOT_APPLICABLE', candidates: [],
        providers: [{ id: B_PROVIDER[corpus], state: 'unreached', cause: 'disabled by setup.disable' }], payloadBytes: 0, wallMs: 0 };
    }
    return adaptersB.runB({ corpus, task, exportRoot, bins, admittedPaths });
  }
  if (route === 'delegated-A') return adaptersA.runA({ task, exportRoot, indexRoot, capabilities, bins, semble, scratchDir, admittedPaths });
  // An unbound IC-001 request declares exact intent by quoting (IC-002); the classifier strips exactly
  // one quote pair, so a multiword literal stays one fixed string instead of routing conceptual.
  const query = task.class === 'exact-lookup' ? `"${task.literal}"` : task.query;
  const options = { root: exportRoot, scopes: admittedPaths, query, top: 10,
    profile: task.class === 'exact-lookup' ? 'lexical-only' : 'hybrid',
    ...(process.env.SEMBLE_MODEL_PATH ? { modelPath: process.env.SEMBLE_MODEL_PATH } : {}) };
  const started = process.hrtime.bigint();
  const wallMs = () => Number(process.hrtime.bigint() - started) / 1e6;
  let result;
  if (executeCodeRetrieval) result = executeCodeRetrieval(options);
  else {
    const modulePath = path.resolve(__dirname, '../../../src/runtime/knowledge/code-retrieval.ts');
    const run = spawn(process.execPath, ['-e', BRIDGE], { cwd: path.resolve(__dirname, '../../..'),
    input: JSON.stringify({ modulePath, options, disabledProviders: disabled }), env: childEnv(semble && semble.env), encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    if (run.error || run.status !== 0) return { result: 'UNREACHED', freshness: 'UNKNOWN', candidates: [],
      providers: [{ id: 'semble.search', state: 'unreached', cause: run.error ? run.error.message : `coordinator exited ${run.status}` }], payloadBytes: 0, wallMs: wallMs() };
    try { result = JSON.parse(run.stdout); } catch { return { result: 'UNREACHED', freshness: 'UNKNOWN', candidates: [],
      providers: [{ id: 'semble.search', state: 'unreached', cause: 'coordinator returned invalid JSON' }], payloadBytes: 0, wallMs: wallMs() }; }
  }
  if (result && typeof result.then === 'function') throw new Error('injected C coordinator must be synchronous');
  return mapCodeResponse(result, wallMs());
}

module.exports = { BRIDGE, mapCodeResponse, describeIndexBuild, buildCodeIndex, servedBy, delegatesToA, runC };
