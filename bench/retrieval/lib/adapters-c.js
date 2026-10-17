'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const adaptersA = require('./adapters-a.js');
const adaptersB = require('./adapters-b.js');
const { childEnv } = require('../runner.js');

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

function mapCodeResponse(result, wallMs = 0) {
  const body = result && result.response || {};
  const candidates = (body.results || []).map((item, index) => {
    const loc = item.locator || {};
    const text = item.content || item.snippet || '';
    return { path: loc.file, startLine: loc.line, endLine: loc.endLine, heading: null, rank: index + 1,
      provider: item.provider, snippet: text, snippetBytes: Buffer.byteLength(text, 'utf8'), origins: item.origins };
  });
  const rejected = (body.gaps || []).filter((g) => g.source === 'live-validation').length;
  const providers = (body.attempts || []).map((attempt) => ({ id: attempt.provider,
    state: attempt.complete ? 'reached' : 'unreached', ...(attempt.reason ? { cause: attempt.reason } : {}) }));
  const resultStatus = result.exit !== 0 ? 'UNREACHED' : candidates.length ? 'RETRIEVED'
    : providers.length && providers.every((provider) => provider.state === 'unreached') ? 'UNREACHED' : 'EMPTY';
  return { result: resultStatus, freshness: (body.attempts || []).some((a) => a.provider === 'semble.search')
    ? ((body.attempts.find((a) => a.provider === 'semble.search') || {}).indexState || 'UNKNOWN') : 'NOT_APPLICABLE',
  candidates, providers, payloadBytes: candidates.reduce((sum, c) => sum + c.snippetBytes, 0), wallMs,
  rawValidity: { raw: candidates.length + rejected, delivered: candidates.length, rejected, gaps: (body.gaps || []).length }, effectiveProfile: body.effectiveProfile || 'lexical-only' };
}

/** The C index-build cost block for the report: measured when the build succeeded, unreached with its cause when not. */
function describeIndexBuild(response, wallMs) {
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

function buildCodeIndex({ exportRoot, admittedPaths, modelPath = process.env.SEMBLE_MODEL_PATH, semble } = {}) {
  if (!modelPath) return { ok: false, reason: 'local-model-required' };
  const modulePath = path.resolve(__dirname, '../../../src/runtime/knowledge/code-retrieval.ts');
  const run = spawnSync(process.execPath, ['-e', BRIDGE], { cwd: path.resolve(__dirname, '../../..'),
    input: JSON.stringify({ modulePath, options: { root: exportRoot, scopes: admittedPaths, modelPath, indexAction: 'build' } }),
    env: childEnv(semble && semble.env), encoding: 'utf8', timeout: 130000, maxBuffer: 2 * 1024 * 1024 });
  if (run.error || run.status !== 0) return { ok: false, reason: run.error ? run.error.message : `index builder exited ${run.status}` };
  try { const result = JSON.parse(run.stdout); return result.response || { ok: false, reason: 'invalid-index-response' }; }
  catch { return { ok: false, reason: 'invalid-index-response' }; }
}

/** The code classes C answers through A's own path (IC-009: impact/refactor keeps A's graph route). */
function delegatesToA(task) {
  return task.class === 'impact-refactor' || task.class === 'verification-failure';
}

/** C reuses the shipped coordinator in a child process so the benchmark's sync runner stays compatible. */
function runC({ corpus, task, exportRoot, indexRoot = exportRoot, capabilities, bins = {}, semble, scratchDir, admittedPaths, executeCodeRetrieval, spawn = spawnSync }) {
  if (corpus === 'guidance') return adaptersB.runB({ corpus, task, exportRoot, bins });
  if (delegatesToA(task)) {
    const answer = adaptersA.runA({ task, exportRoot, indexRoot, capabilities, bins, semble, scratchDir, admittedPaths });
    return answer;
  }
  if (!['exact-lookup', 'conceptual-discovery'].includes(task.class)) return adaptersB.runB({ corpus, task, exportRoot, bins, admittedPaths });
  const query = task.class === 'exact-lookup' ? task.literal : task.query;
  const disabled = (task.setup && task.setup.disable) || [];
  const options = { root: exportRoot, scopes: admittedPaths, query, top: 10,
    profile: task.class === 'exact-lookup' ? 'lexical-only' : 'hybrid',
    ...(task.class === 'exact-lookup' ? { intent: 'exact' } : {}),
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

module.exports = { BRIDGE, mapCodeResponse, describeIndexBuild, buildCodeIndex, delegatesToA, runC };
