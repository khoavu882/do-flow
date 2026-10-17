'use strict';

const crypto = require('node:crypto');
const { resolveRetrievalBinding, appendRetrievalAttempt } = require('../retrieval-record.ts');
const { CapabilityRouter } = require('../capability-router.ts');
const { admitCodeCorpus } = require('./code-corpus.ts');
const { classifyCodeQuery, searchCodeLexical } = require('./code-lexical.ts');
const { runSembleQuery } = require('./semble-provider.ts');
const { runSembleLifecycle } = require('./semble-lifecycle.ts');
const { fuseRankedCandidates } = require('./hybrid.ts');
const { validateCodeCandidates } = require('./code-validation.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

const CAPABILITY = Object.freeze({ exact: 'code.exact-search', conceptual: 'code.semantic-search' });
const INDEX_STATES = new Set(['FRESH', 'STALE', 'UNKNOWN', 'NOT_APPLICABLE']);

function responseError(exit, error, details = {}) {
  return { exit, response: { ok: false, schemaVersion: 1, scope: 'code', error, ...details } };
}

function registeredProviders(router, capability) {
  const providers = router?.capabilities?.[capability]?.providers;
  return Array.isArray(providers) ? providers.map((p) => p.id).filter(Boolean) : [];
}

function failureReason(reason, freshness) {
  if (reason === 'lock-contention' || reason === 'index-in-progress' || reason === 'index-source-mismatch' || reason === 'corpus-changed') return 'policy-bypass';
  if (reason === 'provider-timeout' || reason === 'lifecycle-timeout' || reason === 'deadline') return 'timeout';
  if (freshness === 'STALE') return 'policy-bypass';
  if (reason === 'provider-unavailable' || reason === 'local-model-required' || reason === 'index-missing-or-corrupt') return 'provider-unavailable';
  return 'provider-error';
}

// A lexical stop at a configured bound is partial coverage with that bound as its cause, not a provider fault.
const LEXICAL_BOUNDS = new Set(['candidate-limit', 'output-byte-limit', 'read-byte-limit']);
function lexicalOutcome(result) {
  if (result.complete) return { failure: null, bound: null };
  const reasons = (result.rejections || []).map((r) => r.reason);
  if (reasons.includes('deadline')) return { failure: 'provider-timeout', bound: null };
  if (reasons.length && reasons.every((r) => LEXICAL_BOUNDS.has(r))) return { failure: null, bound: reasons[0] };
  return { failure: 'provider-error', bound: null };
}

function validFreshness(value) { return INDEX_STATES.has(value) ? value : 'UNKNOWN'; }

function appendOutcome({ binding, projectRoot, taskId, slug, intent, need, router, provider, capability, id, candidates, indexState, failure, bound = null, complete }) {
  let stored = null;
  if (binding) {
    let status; let reason;
    if (failure) { status = 'UNREACHED'; reason = failureReason(failure, indexState); }
    else if (!candidates.length && complete) {
      if (indexState === 'STALE') { status = 'EMPTY'; reason = 'index-stale'; }
      else if (indexState === 'UNKNOWN') { status = 'UNVERIFIED'; reason = 'index-unverifiable'; }
      else { status = 'EMPTY'; reason = 'empty-answer'; }
    } else if (!candidates.length) { status = 'UNREACHED'; reason = 'timeout'; }
    if (status) {
      const list = registeredProviders(router, capability);
      stored = appendRetrievalAttempt({ projectRoot, taskId, intent, provider, status, reason, indexState,
        slug, attemptRef: binding.attemptRef, expectedCapability: need.capability,
        expectedPrimaryProvider: need.provider, registeredProviders: list });
    }
  }
  return { retrievalAttemptId: id, provider, capability, indexState, candidateCount: candidates.length,
    complete: Boolean(complete), ...(failure || bound ? { reason: failure || bound } : {}), ...(stored ? { recordedAttempt: stored.attempt } : {}) };
}

function toCandidateList(candidates, { provider, capability, queryRef, retrievalAttemptRef, indexed = false }) {
  return candidates.map((item, index) => ({
    ...item,
    provider,
    capability,
    queryRef,
    retrievalAttemptRef,
    ...(indexed && item.indexedSourceIdentity ? { origins: [{ provider, capability, queryRef, retrievalAttemptRef,
      originalRank: index + 1, indexedSourceHash: item.indexedSourceIdentity }] } : {}),
  }));
}

/** Coalesce repeated attempts by one provider without granting another RRF vote. */
function coalesceProviderLists(lists) {
  const providers = new Map();
  for (const list of lists) {
    const provider = list.provider;
    if (!providers.has(provider)) providers.set(provider, new Map());
    const spans = providers.get(provider);
    (list.candidates || []).forEach((candidate, index) => {
      const loc = candidate.locator || {};
      const key = JSON.stringify([loc.file, loc.line, loc.endLine]);
      const origin = { provider, capability: list.capability, queryRef: list.queryRef ?? null,
        retrievalAttemptRef: list.retrievalAttemptRef, originalRank: index + 1,
        sourceVersion: candidate.sourceVersion ?? null,
        ...(candidate.indexedSourceIdentity ? { indexedSourceHash: candidate.indexedSourceIdentity } : {}) };
      if (!spans.has(key)) spans.set(key, { ...candidate, provider, capability: list.capability, rank: index + 1, origins: [origin] });
      else {
        const prior = spans.get(key);
        prior.rank = Math.min(prior.rank, index + 1);
        if (!prior.origins.some((item) => item.retrievalAttemptRef === origin.retrievalAttemptRef)) prior.origins.push(origin);
      }
    });
  }
  const result = [];
  for (const [provider, spans] of providers) {
    const candidates = [...spans.values()].sort((a, b) => a.rank - b.rank
      || String(a.locator?.file).localeCompare(String(b.locator?.file))
      || (a.locator?.line || 0) - (b.locator?.line || 0)
      || (a.locator?.endLine || 0) - (b.locator?.endLine || 0));
    result.push({ provider, capability: candidates[0]?.capability, candidates });
  }
  return result;
}

/** Shared production coordinator used by CLI retrieve and benchmark C. It prints nothing. */
async function executeCodeRetrieval(options = {}) {
  const query = typeof options.query === 'string' ? options.query.trim() : '';
  const taskId = options.taskId || null;
  const rawNeed = options.need;
  if (Array.isArray(rawNeed) && rawNeed.length > 1) return responseError(2, 'one-need-per-request');
  const intent = Array.isArray(rawNeed) ? rawNeed[0] || null : rawNeed || null;
  const slug = options.slug || null;
  const profile = options.profile || 'lexical-only';
  const requestedTop = options.top === undefined ? 5 : Number(options.top);
  const rootInput = options.root || options.projectRoot || options.stateRoot || process.cwd();
  const providers = options.providers || {};
  if (profile !== 'lexical-only' && profile !== 'hybrid') return responseError(2, 'invalid-profile', { validProfiles: ['lexical-only', 'hybrid'] });
  if (!Number.isInteger(requestedTop) || requestedTop < 1 || requestedTop > 25) return responseError(2, 'invalid-top', { validRange: '1..25' });
  if (options.indexAction !== undefined && !['build', 'refresh'].includes(options.indexAction)) return responseError(2, 'invalid-index-action');
  if (options.indexAction && query) return responseError(2, 'index-action-rejects-query');
  if (options.indexAction && (taskId || intent)) return responseError(2, 'index-action-does-not-accept-task-binding');
  if (Boolean(taskId) !== Boolean(intent)) return responseError(2, 'task-id-and-need-required-together');
  let searchRoot; let projectRoot;
  try {
    const path = require('node:path'); const fs = require('node:fs');
    searchRoot = fs.realpathSync(path.resolve(rootInput));
    projectRoot = fs.realpathSync(path.resolve(options.stateRoot || searchRoot));
  }
  catch { return responseError(2, 'invalid-root', { root: rootInput }); }

  if (options.indexAction) {
    if (!options.modelPath) return responseError(2, 'model-path-required');
    try {
      const inventory = (providers.admitCodeCorpus || admitCodeCorpus)({ root: searchRoot, scopes: options.scopes, limits: options.corpusLimits });
      if (!inventory.complete) return { exit: 1, response: { schemaVersion: 1, scope: 'code', action: options.indexAction, ...inventory, complete: false, error: 'incomplete-corpus' } };
      const run = providers.lifecycle || runSembleLifecycle;
      const result = await run({ inventory, modelPath: options.modelPath, action: options.indexAction, limits: options.semanticLimits });
      return { exit: result.ok ? 0 : 1, response: { schemaVersion: 1, scope: 'code', ...result } };
    } catch (error) {
      return { exit: 1, response: { schemaVersion: 1, scope: 'code', action: options.indexAction, complete: false,
        error: 'lifecycle-error', cause: error?.message || String(error), repair: 'Correct the cause and run an explicit bounded build or refresh.' } };
    }
  }
  if (!query || Buffer.byteLength(query, 'utf8') > 4096) return responseError(2, 'invalid-query', { expected: '1..4096 UTF-8 bytes' });

  let binding = null;
  let need = null;
  let classification;
  try {
    const classifier = providers.classifyCodeQuery || classifyCodeQuery;
    classification = classifier(query, { intent });
    if (taskId) {
      binding = resolveRetrievalBinding({ projectRoot, taskId, intent, slug });
      if (!binding.ok) return responseError(2, 'invalid-task-binding', { summary: binding.message });
      need = binding.need;
      const requiredCapability = CAPABILITY[classification.queryClass];
      if (need.capability !== requiredCapability) return responseError(2, 'capability-mismatch', {
        need: intent, declaredCapability: need.capability, requiredCapability, queryClass: classification.queryClass,
      });
    }
  } catch (error) {
    return responseError(2, 'invalid-task-binding', { summary: error?.message || String(error) });
  }

  const capability = CAPABILITY[classification.queryClass];
  let router;
  try { router = providers.router || new CapabilityRouter({ repoRoot: options.repoRoot || REPO_ROOT }); }
  catch (error) { return { exit: 1, response: { schemaVersion: 1, scope: 'code', error: 'registry-unavailable', cause: error?.message || String(error) } }; }
  const registered = registeredProviders(router, capability);
  if (!registered.includes('native.rg')) return responseError(2, 'lexical-provider-not-registered', { capability });
  if (profile === 'hybrid' && classification.queryClass === 'conceptual' && !registered.includes('semble.search')) {
    return responseError(2, 'semantic-provider-not-registered', { capability });
  }
  let inventory;
  try {
    const admit = providers.admitCodeCorpus || admitCodeCorpus;
    inventory = providers.inventory || admit({ root: searchRoot, scopes: options.scopes, limits: options.corpusLimits });
  } catch (error) {
    return { exit: 1, response: { schemaVersion: 1, scope: 'code', queryClass: classification.queryClass,
      requestedProfile: profile, effectiveProfile: 'lexical-only', error: 'corpus-admission-failed', cause: error?.message || String(error) } };
  }

  const topN = requestedTop;
  const attempts = [];
  const gaps = [];
  const rankedLists = [];
  const coverage = { corpusComplete: Boolean(inventory.complete), lexical: [], semantic: null, live: null, complete: Boolean(inventory.complete) };
  const accounting = { corpusFiles: inventory.files?.length || 0, corpusBytes: inventory.accounting?.sourceBytes || 0,
    semanticSourceReadBytes: 0, lexicalReadBytes: 0, liveReadBytes: 0, deliveredCandidates: 0 };
  let lexicalExecuted = false;
  let semanticExecuted = false;
  let semanticComplete = false;
  const queryRef = binding?.queryRef ?? null;
  const makeId = () => 'ra-' + crypto.randomUUID();
  const lexical = providers.lexicalSearch || searchCodeLexical;
  const runLexical = (id) => {
    const result = lexical({ ...options.lexicalLimits, inventory, query, classification, intent, maxCandidates: 200, queryRef,
      retrievalAttemptRef: id });
    return result;
  };

  try {
    const lexicalId = makeId();
    let lexResult;
    try { lexResult = runLexical(lexicalId); }
    catch (error) { lexResult = { candidates: [], complete: false, rejections: [{ reason: 'provider-error' }], accounting: {}, coverage: { complete: false } }; }
    lexicalExecuted = true;
    accounting.lexicalReadBytes += lexResult.accounting?.readBytes || 0;
    coverage.lexical.push(lexResult.coverage || { complete: Boolean(lexResult.complete) });
    const lexCandidates = toCandidateList(lexResult.candidates || [], { provider: 'native.rg', capability, queryRef, retrievalAttemptRef: lexicalId });
    rankedLists.push({ provider: 'native.rg', capability, queryRef, retrievalAttemptRef: lexicalId, candidates: lexCandidates });
    const lexOutcome = lexicalOutcome(lexResult);
    attempts.push(appendOutcome({ binding, projectRoot, taskId, slug, intent, need, router, provider: 'native.rg', capability,
      id: lexicalId, candidates: lexCandidates, indexState: 'NOT_APPLICABLE', ...lexOutcome, complete: Boolean(lexResult.complete) }));
    if (lexOutcome.failure || lexOutcome.bound) gaps.push({ provider: 'native.rg', reason: lexOutcome.failure || lexOutcome.bound, source: 'lexical' });

    if (profile === 'hybrid' && classification.queryClass === 'conceptual') {
      const semanticId = makeId();
      let semResult;
      const modelPath = options.modelPath || process.env.SEMBLE_MODEL_PATH || null;
      if (!modelPath) semResult = { ok: false, reason: 'local-model-required', freshness: 'UNKNOWN', candidates: [] };
      else {
        try { semResult = await (providers.semanticQuery || runSembleQuery)({ inventory, query, top: 200, modelPath, limits: options.semanticLimits }); }
        catch (error) { semResult = { ok: false, reason: 'provider-error', freshness: 'UNKNOWN', cause: error?.message || String(error), candidates: [] }; }
      }
      const semFreshness = validFreshness(semResult.freshness);
      accounting.semanticSourceReadBytes += semResult.accounting?.sourceReadBytes || 0;
      if (semResult.ok) {
        semanticExecuted = true; semanticComplete = semFreshness === 'FRESH';
        const semCandidates = toCandidateList(semResult.candidates || [], { provider: 'semble.search', capability, queryRef,
          retrievalAttemptRef: semanticId, indexed: true });
        rankedLists.push({ provider: 'semble.search', capability, queryRef, retrievalAttemptRef: semanticId, candidates: semCandidates });
        attempts.push(appendOutcome({ binding, projectRoot, taskId, slug, intent, need, router, provider: 'semble.search', capability,
          id: semanticId, candidates: semCandidates, indexState: semFreshness, complete: true }));
      } else {
        const reason = semResult.reason || 'provider-unavailable';
        attempts.push(appendOutcome({ binding, projectRoot, taskId, slug, intent, need, router, provider: 'semble.search', capability,
          id: semanticId, candidates: [], indexState: semFreshness, failure: reason, complete: false }));
        gaps.push({ provider: 'semble.search', reason, freshness: semFreshness, source: 'semantic' });
        const fallbackId = makeId();
        let fallback;
        try { fallback = runLexical(fallbackId); }
        catch (error) { fallback = { candidates: [], complete: false, rejections: [{ reason: 'provider-error' }], accounting: {}, coverage: { complete: false } }; }
        accounting.lexicalReadBytes += fallback.accounting?.readBytes || 0;
        coverage.lexical.push(fallback.coverage || { complete: Boolean(fallback.complete), fallback: true });
        const fallbackCandidates = toCandidateList(fallback.candidates || [], { provider: 'native.rg', capability, queryRef, retrievalAttemptRef: fallbackId });
        rankedLists.push({ provider: 'native.rg', capability, queryRef, retrievalAttemptRef: fallbackId, candidates: fallbackCandidates });
        const fallbackOutcome = lexicalOutcome(fallback);
        attempts.push(appendOutcome({ binding, projectRoot, taskId, slug, intent, need, router, provider: 'native.rg', capability,
          id: fallbackId, candidates: fallbackCandidates, indexState: 'NOT_APPLICABLE', ...fallbackOutcome, complete: Boolean(fallback.complete) }));
        if (fallbackOutcome.failure || fallbackOutcome.bound) gaps.push({ provider: 'native.rg', reason: fallbackOutcome.failure || fallbackOutcome.bound, source: 'fallback' });
      }
    }

    const fused = fuseRankedCandidates({ rankedLists: coalesceProviderLists(rankedLists), projectRoot: searchRoot, corpusIdentity: inventory.identity, k: 60 });
    if (fused.rejected?.length) gaps.push({ source: 'fusion', reason: 'invalid-candidate', count: fused.rejected.length });
    if (fused.candidates.length > 200) gaps.push({ source: 'fusion', reason: 'candidate-limit', count: fused.candidates.length - 200 });
    const validate = providers.validateCandidates || validateCodeCandidates;
    const live = validate({ inventory, candidates: fused.candidates.slice(0, 200), topN });
    coverage.live = live.coverage;
    const semanticRequested = profile === 'hybrid' && classification.queryClass === 'conceptual';
    coverage.complete = Boolean(inventory.complete && coverage.lexical.every((item) => item.complete !== false)
      && (!semanticRequested || (semanticExecuted && semanticComplete)) && fused.candidates.length <= 200
      && live.complete && gaps.length === 0);
    accounting.liveReadBytes = live.accounting?.readBytes || 0;
    accounting.deliveredCandidates = live.results?.length || 0;
    for (const rejected of live.rejected || []) gaps.push({ source: 'live-validation', reason: rejected.reason });
    const effectiveProfile = profile === 'hybrid' && classification.queryClass === 'conceptual' && semanticExecuted && semanticComplete && lexicalExecuted
      ? 'hybrid' : 'lexical-only';
    return { exit: 0, response: { ok: true, schemaVersion: 1, scope: 'code', root: searchRoot,
      queryClass: classification.queryClass, classificationBasis: classification.classificationBasis,
      requestedProfile: profile, effectiveProfile, queryRef, activeTaskAttemptRef: binding?.attemptRef ?? null,
      results: live.results || [], attempts, gaps, coverage, accounting, absenceEstablished: false } };
  } catch (error) {
    return { exit: 1, response: { ok: false, schemaVersion: 1, scope: 'code', queryClass: classification.queryClass,
      requestedProfile: profile, effectiveProfile: 'lexical-only', error: 'retrieval-failed', cause: error?.message || String(error), attempts, gaps, coverage, accounting,
      absenceEstablished: false } };
  }
}

module.exports = { executeCodeRetrieval, coalesceProviderLists, lexicalOutcome, CAPABILITY };
