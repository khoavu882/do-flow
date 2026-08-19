'use strict';

/**
 * Read-side views over the run ledger (FR-012): the three inspection views — trajectory,
 * aggregate stats and missed opportunities — plus the helpers they share.
 *
 * Split out of `trace.js` (plan task H.3): this module only *reads* the normalized records
 * `RunLedger#read` produces and formats them into a view model. It never touches the filesystem
 * and never writes a ledger record — that stays the sole responsibility of `trace.js`'s
 * `RunLedger` class (NFR-004: one write path into `state/runs/`).
 */

// ---------------------------------------------------------------------------------- view shared

/** A run is a shell process; a gap this long between two of them is a new sitting, not the same
 * workflow. Used only when records carry no explicit `session`, and always reported alongside the
 * view so the reader knows the boundary was inferred rather than recorded. */
const SESSION_GAP_MS = 30 * 60 * 1000;

/** Nearest-rank percentile over an unsorted numeric array. */
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1];
}

/**
 * Splits records into workflow-sized groups.
 * @param {Object[]} records
 * @param {Object} [options]
 * @param {number} [options.gapMs=SESSION_GAP_MS]
 * @returns {{grouping: 'session-field'|'idle-gap', sessions: Array<{id: string, startedAt: string|null, endedAt: string|null, records: Object[]}>}}
 */
function groupSessions(records, { gapMs = SESSION_GAP_MS } = {}) {
  if (!records.length) return { grouping: 'idle-gap', sessions: [] };

  // An explicit session id is a recorded fact; an idle gap is an inference. Prefer the fact, and
  // only when every record carries one — a half-labelled history would mix the two silently.
  if (records.every((record) => record.session)) {
    const order = [];
    const byId = new Map();
    for (const record of records) {
      if (!byId.has(record.session)) { byId.set(record.session, []); order.push(record.session); }
      byId.get(record.session).push(record);
    }
    return {
      grouping: 'session-field',
      sessions: order.map((id) => ({
        id,
        startedAt: byId.get(id)[0].timestamp,
        endedAt: byId.get(id)[byId.get(id).length - 1].timestamp,
        records: byId.get(id),
      })),
    };
  }

  const sessions = [];
  let current = null;
  for (const record of records) {
    const previous = current && current.records[current.records.length - 1];
    const contiguous = previous && record.at !== null && previous.at !== null && record.at - previous.at <= gapMs;
    if (!current || !contiguous) {
      current = { id: record.timestamp || `run-${sessions.length + 1}`, startedAt: record.timestamp, endedAt: record.timestamp, records: [] };
      sessions.push(current);
    }
    current.records.push(record);
    current.endedAt = record.timestamp;
  }
  return { grouping: 'idle-gap', sessions };
}

/** The ledger provenance every view carries, so a reader can always tell what was actually read. */
function ledgerSummary(read) {
  return {
    dir: read.dir,
    exists: read.exists,
    partitions: read.files.length,
    recordCount: read.records.length,
    malformedLines: read.malformedLines,
    unreadableFiles: read.unreadableFiles,
    windowDays: read.days,
  };
}

/** How many records carry each optional field. Every view reports this, because the difference
 * between "no missed opportunities" and "no data to look for them in" is exactly this table. */
function fieldCoverage(records) {
  const count = (predicate) => records.filter(predicate).length;
  return {
    capability: count((r) => Boolean(r.capability)),
    provider: count((r) => Boolean(r.provider)),
    resultCount: count((r) => r.resultCount !== undefined),
    outputBytes: count((r) => r.outputBytes !== undefined),
    exitCode: count((r) => r.exitCode !== undefined),
    durationMs: count((r) => r.durationMs !== undefined),
  };
}

// ---------------------------------------------------------------------------- view 1: trajectory

/**
 * The trajectory of the current or most recent workflow (FR-012).
 * @param {Object} read result of `RunLedger#read`
 * @param {Object} [options]
 * @param {number} [options.gapMs]
 * @returns {Object} view model
 */
function buildTrace(read, { gapMs = SESSION_GAP_MS } = {}) {
  const ledger = ledgerSummary(read);
  const { grouping, sessions } = groupSessions(read.records, { gapMs });
  if (!sessions.length) {
    return {
      view: 'trace',
      ledger,
      grouping,
      gapMinutes: Math.round(gapMs / 60000),
      trajectory: null,
      // Stated as an absence of data, never as a clean bill of health.
      reason: read.exists
        ? 'the ledger exists but holds no readable run records'
        : 'no ledger has been written yet at this location',
    };
  }

  const session = sessions[sessions.length - 1];
  const steps = session.records.map((record, index) => ({
    n: index + 1,
    timestamp: record.timestamp,
    verb: record.verb,
    exitCode: record.exitCode ?? null,
    durationMs: record.durationMs ?? null,
    capability: record.capability ?? null,
    provider: record.provider ?? null,
    stage: record.stage ?? null,
    outcome: record.outcome ?? (record.exitCode === undefined ? null : record.exitCode === 0 ? 'ok' : 'failed'),
  }));
  const start = session.records[0].at;
  const end = session.records[session.records.length - 1].at;

  return {
    view: 'trace',
    ledger,
    grouping,
    gapMinutes: Math.round(gapMs / 60000),
    priorSessions: sessions.length - 1,
    trajectory: {
      id: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      wallDurationMs: start !== null && end !== null ? Math.max(0, end - start) : null,
      dispatchedMs: steps.reduce((total, step) => total + (step.durationMs ?? 0), 0),
      stepCount: steps.length,
      failedSteps: steps.filter((step) => step.exitCode !== null && step.exitCode !== 0).length,
      steps,
    },
  };
}

// ----------------------------------------------------------------------------- view 2: aggregate

/**
 * Aggregate local usage (FR-012).
 * @param {Object} read result of `RunLedger#read`
 * @returns {Object} view model
 */
function buildStats(read) {
  const records = read.records;
  const ledger = ledgerSummary(read);
  const durations = records.map((r) => r.durationMs).filter((value) => typeof value === 'number');

  const tally = (keyOf) => {
    const map = new Map();
    for (const record of records) {
      const key = keyOf(record);
      if (!key) continue;
      const entry = map.get(key) || { key, count: 0, failures: 0, totalMs: 0, durations: [] };
      entry.count += 1;
      if (record.exitCode !== undefined && record.exitCode !== 0) entry.failures += 1;
      if (typeof record.durationMs === 'number') { entry.totalMs += record.durationMs; entry.durations.push(record.durationMs); }
      map.set(key, entry);
    }
    return [...map.values()]
      .map((entry) => ({
        key: entry.key,
        count: entry.count,
        failures: entry.failures,
        totalMs: entry.totalMs,
        p50Ms: percentile(entry.durations, 0.5),
        p95Ms: percentile(entry.durations, 0.95),
      }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  };

  const dated = records.filter((r) => r.timestamp);
  return {
    view: 'stats',
    ledger,
    recordCount: records.length,
    span: {
      first: dated.length ? dated[0].timestamp : null,
      last: dated.length ? dated[dated.length - 1].timestamp : null,
      activeDays: read.files.length,
    },
    outcomes: {
      succeeded: records.filter((r) => r.exitCode === 0).length,
      failed: records.filter((r) => r.exitCode !== undefined && r.exitCode !== 0).length,
      // Counted separately rather than folded into "succeeded": an unrecorded exit code is not a
      // success, and the three defects this feature is correcting were all of that shape.
      unrecorded: records.filter((r) => r.exitCode === undefined).length,
    },
    durations: {
      measured: durations.length,
      totalMs: durations.reduce((total, value) => total + value, 0),
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: durations.length ? Math.max(...durations) : null,
    },
    byVerb: tally((r) => r.verb),
    byCapability: tally((r) => r.capability),
    byProvider: tally((r) => r.provider),
    byDay: tally((r) => (r.timestamp ? r.timestamp.slice(0, 10) : null)).sort((a, b) => a.key.localeCompare(b.key)),
    coverage: fieldCoverage(records),
  };
}

// ------------------------------------------------------------------- view 3: missed opportunities

/** Capability ids the opportunity analyses reason about, kept in one place so a registry rename
 * shows up as one edit rather than four scattered string literals. */
const CAPABILITY = Object.freeze({
  exactSearch: 'code.exact-search',
  semanticSearch: 'code.semantic-search',
  relationships: 'code.relationships',
  impact: 'code.impact-analysis',
  compress: 'command.compress',
});

const PROVIDER = Object.freeze({
  semantic: 'semble.search',
  structural: 'graphify.query',
  compressor: 'rtk',
});

/** A search returning this many hits was a question about the codebase, not a lookup of a known
 * symbol — the result set is too large to have been the answer the caller wanted. */
const BROWSING_RESULT_SET = 40;
/** Three exact searches inside one sitting with no structural query is reference-walking by hand. */
const REPEATED_SEARCHES = 3;
/** Roughly 5k tokens of raw stdout — the point at which compression stops being a rounding error. */
const LARGE_OUTPUT_BYTES = 20000;
/** One retry is normal. Two failed verifications in one sitting is a pattern. */
const RETRY_THRESHOLD = 2;

const NOT_DETERMINED = 'NOT_DETERMINED';
const NOT_APPLICABLE = 'NOT_APPLICABLE';
const FINDING = 'FINDING';
const CLEAR = 'CLEAR';

/** Health of a provider as this analysis needs it: only `HEALTHY` counts as "was available". */
function providerAvailable(providerHealth, id) {
  const entry = providerHealth ? providerHealth[id] : undefined;
  if (!entry) return null; // unknown — not the same as unavailable
  return entry.status === 'HEALTHY';
}

/**
 * Missed opportunities (FR-012).
 *
 * Every analysis returns one of four states and each is load-bearing:
 *   FINDING        — the ledger shows the cheaper capability was available and was not used.
 *   CLEAR          — the analysis ran against data that could have shown the pattern and did not.
 *   NOT_DETERMINED — the ledger lacks the field the analysis needs. Reported, never rounded to CLEAR.
 *   NOT_APPLICABLE — the better provider is not installed, so nothing was missed.
 *
 * @param {Object} read result of `RunLedger#read`
 * @param {Object} [options]
 * @param {Object} [options.providerHealth] map of provider id -> {status}, from `health.js`
 * @param {number} [options.gapMs]
 * @returns {Object} view model
 */
function buildDiscover(read, { providerHealth = null, gapMs = SESSION_GAP_MS } = {}) {
  const records = read.records;
  const ledger = ledgerSummary(read);
  const coverage = fieldCoverage(records);
  const { grouping, sessions } = groupSessions(records, { gapMs });

  // Said once, because three of the four analyses depend on the same absent field and each must
  // say why it could not answer rather than defaulting to "nothing found".
  const noCapabilityData = {
    status: NOT_DETERMINED,
    detail: 'no record in this window names a capability. The dispatcher records verb-level metadata only '
      + '(verb, exit code, duration, argument count), so which capability a run used is not recoverable from it. '
      + 'Capability-level records are written by runtime calls that resolve a capability to a provider.',
  };

  const analyses = [];

  // 1. A broad search that was really a semantic question.
  analyses.push((() => {
    const base = { id: 'search-was-a-question', title: 'Broad searches that were really semantic questions' };
    if (!records.length) return { ...base, status: NOT_DETERMINED, detail: 'the ledger holds no runs to analyse.' };
    if (coverage.capability === 0) return { ...base, ...noCapabilityData };
    const available = providerAvailable(providerHealth, PROVIDER.semantic);
    if (available === null) return { ...base, status: NOT_DETERMINED, detail: `whether \`${PROVIDER.semantic}\` could have answered was not probed, so a missed opportunity cannot be distinguished from an unavailable alternative.` };
    if (!available) return { ...base, status: NOT_APPLICABLE, detail: `\`${PROVIDER.semantic}\` is not answering on this machine, so exact search was the only option available.` };

    const broad = records.filter((r) => r.capability === CAPABILITY.exactSearch && (r.resultCount ?? 0) >= BROWSING_RESULT_SET);
    if (coverage.resultCount === 0) {
      return { ...base, status: NOT_DETERMINED, detail: 'exact searches are recorded but none carries a result count, which is the signal that separates a lookup from a browse.' };
    }
    if (!broad.length) return { ...base, status: CLEAR, detail: `no exact search in this window returned ${BROWSING_RESULT_SET}+ hits.` };
    return {
      ...base,
      status: FINDING,
      detail: `${broad.length} exact search${broad.length === 1 ? '' : 'es'} returned ${BROWSING_RESULT_SET}+ hits while semantic search was available. A result set that large is a question about the codebase, not a lookup.`,
      observed: broad.slice(0, 10).map((r) => ({ timestamp: r.timestamp, provider: r.provider ?? null, resultCount: r.resultCount })),
      largestResultSet: Math.max(...broad.map((r) => r.resultCount)),
      recommendation: `Ask the question directly: \`route\` the need to \`${CAPABILITY.semanticSearch}\` (provider \`${PROVIDER.semantic}\`) before falling back to a pattern search.`,
    };
  })());

  // 2. Manual relationship exploration where a structural provider was available.
  analyses.push((() => {
    const base = { id: 'manual-relationship-walk', title: 'Relationship exploration done by hand' };
    if (!records.length) return { ...base, status: NOT_DETERMINED, detail: 'the ledger holds no runs to analyse.' };
    if (coverage.capability === 0) return { ...base, ...noCapabilityData };
    const available = providerAvailable(providerHealth, PROVIDER.structural);
    if (available === null) return { ...base, status: NOT_DETERMINED, detail: `whether \`${PROVIDER.structural}\` could have answered was not probed, so a missed opportunity cannot be distinguished from an unavailable alternative.` };
    if (!available) return { ...base, status: NOT_APPLICABLE, detail: `\`${PROVIDER.structural}\` is not answering on this machine, so structural queries were not an available alternative.` };

    const offenders = sessions
      .map((session) => ({
        id: session.id,
        startedAt: session.startedAt,
        searches: session.records.filter((r) => r.capability === CAPABILITY.exactSearch).length,
        structural: session.records.filter((r) => r.capability === CAPABILITY.relationships || r.capability === CAPABILITY.impact).length,
      }))
      .filter((session) => session.searches >= REPEATED_SEARCHES && session.structural === 0);
    if (!offenders.length) return { ...base, status: CLEAR, detail: `no session ran ${REPEATED_SEARCHES}+ exact searches without also querying the code graph.` };
    return {
      ...base,
      status: FINDING,
      detail: `${offenders.length} session${offenders.length === 1 ? '' : 's'} ran ${REPEATED_SEARCHES}+ exact searches and never queried the code graph. Walking callers and dependents by repeated search is what the structural provider exists to replace.`,
      observed: offenders.slice(0, 10),
      recommendation: `Route callers/dependents/blast-radius questions to \`${CAPABILITY.relationships}\` or \`${CAPABILITY.impact}\` (provider \`${PROVIDER.structural}\`) instead of iterating exact searches.`,
    };
  })());

  // 3. Large raw command output where compression was available.
  analyses.push((() => {
    const base = { id: 'uncompressed-output', title: 'Large raw command output left uncompressed' };
    if (!records.length) return { ...base, status: NOT_DETERMINED, detail: 'the ledger holds no runs to analyse.' };
    if (coverage.outputBytes === 0) {
      return { ...base, status: NOT_DETERMINED, detail: 'no record carries an output byte volume, which is the only signal that distinguishes a large raw dump from a small one. The shell dispatcher does not measure what a verb printed.' };
    }
    const available = providerAvailable(providerHealth, PROVIDER.compressor);
    if (available === null) return { ...base, status: NOT_DETERMINED, detail: `whether \`${PROVIDER.compressor}\` could have compressed the output was not probed.` };
    if (!available) return { ...base, status: NOT_APPLICABLE, detail: `\`${PROVIDER.compressor}\` is not answering on this machine, so compression was not an available alternative.` };

    const bulky = records.filter((r) => (r.outputBytes ?? 0) >= LARGE_OUTPUT_BYTES && r.provider !== PROVIDER.compressor);
    if (!bulky.length) return { ...base, status: CLEAR, detail: `no uncompressed run returned ${LARGE_OUTPUT_BYTES} bytes or more.` };
    const wasted = bulky.reduce((total, r) => total + r.outputBytes, 0);
    return {
      ...base,
      status: FINDING,
      detail: `${bulky.length} run${bulky.length === 1 ? '' : 's'} returned ${LARGE_OUTPUT_BYTES}+ bytes of raw output (${wasted} bytes in total) while a compressor was available.`,
      observed: bulky.slice(0, 10).map((r) => ({ timestamp: r.timestamp, verb: r.verb, provider: r.provider ?? null, outputBytes: r.outputBytes })),
      recommendation: `Route the high-volume commands through \`${CAPABILITY.compress}\` (provider \`${PROVIDER.compressor}\`) rather than reading raw stdout into context.`,
    };
  })());

  // 4. Implementation retries indicating readiness evidence was incomplete before editing.
  //    This is the one analysis that works on the dispatcher's verb-only records, because its
  //    signal is which verbs ran in what order — not what any of them was about.
  analyses.push((() => {
    const base = { id: 'retries-without-readiness', title: 'Implementation retries with no readiness check beforehand' };
    if (!records.length) return { ...base, status: NOT_DETERMINED, detail: 'the ledger holds no runs to analyse.' };
    const retrying = sessions
      .map((session) => ({
        id: session.id,
        startedAt: session.startedAt,
        failedVerifications: session.records.filter((r) => r.verb === 'verify' && r.exitCode !== undefined && r.exitCode !== 0).length,
        recoveries: session.records.filter((r) => r.verb === 'recover').length,
        readinessCalls: session.records.filter((r) => r.verb === 'readiness').length,
      }))
      .filter((session) => session.failedVerifications >= RETRY_THRESHOLD || session.recoveries >= 1);
    if (!retrying.length) {
      // The retry signal is a `verify` that FAILED (non-zero exit_code) or a `recover` run. A
      // `verify` record with no exit_code carries neither, and that is the shape the shell
      // dispatcher writes on its own — so counting bare `verify` records as coverage let this
      // report CLEAR over a window it could not read, unable to tell a clean run from nothing but
      // failures. CLEAR must mean "the analysis ran against data that could have shown the pattern
      // and did not"; without a readable exit_code it could not have. Found by C.7's coverage
      // guard, which pinned the wrong behaviour and fails once it is corrected.
      const readableVerifications = records.filter(
        (r) => r.verb === 'verify' && Number.isInteger(r.exit_code),
      ).length;
      const recoveries = records.filter((r) => r.verb === 'recover').length;
      const observedRetrySignals = readableVerifications + recoveries;
      return {
        ...base,
        status: observedRetrySignals ? CLEAR : NOT_DETERMINED,
        detail: observedRetrySignals
          ? 'verification ran in this window and no session hit the retry threshold.'
          : 'no `verify` with a recorded exit code and no `recover` run appears in this window, so there is no retry behaviour to judge.',
      };
    }
    const unguarded = retrying.filter((session) => session.readinessCalls === 0);
    if (!unguarded.length) {
      return {
        ...base,
        status: NOT_DETERMINED,
        detail: `${retrying.length} session${retrying.length === 1 ? '' : 's'} retried verification, but each also called \`readiness\`. The ledger records that \`readiness\` ran, not what state it returned, so whether the evidence was actually sufficient cannot be decided from here — read the readiness report for those tasks.`,
        observed: retrying.slice(0, 10),
      };
    }
    return {
      ...base,
      status: FINDING,
      detail: `${unguarded.length} session${unguarded.length === 1 ? '' : 's'} retried verification (or entered recovery) without ever calling \`readiness\`. Retrying an implementation is the symptom; missing evidence before the first edit is the usual cause.`,
      observed: unguarded.slice(0, 10),
      recommendation: 'Run `readiness` for the task class before the first edit and resolve the named missing evidence, rather than discovering the gap through a failing verification.',
    };
  })());

  const findings = analyses.filter((analysis) => analysis.status === FINDING);
  const undetermined = analyses.filter((analysis) => analysis.status === NOT_DETERMINED);

  // The verdict never claims a clean bill of health over data that could not answer the question.
  let verdict;
  if (findings.length) verdict = 'findings';
  else if (undetermined.length === analyses.length) verdict = 'insufficient-data';
  else if (undetermined.length) verdict = 'no-findings-in-the-analyses-that-could-run';
  else verdict = 'no-findings';

  return {
    view: 'discover',
    ledger,
    grouping,
    sessionsAnalyzed: sessions.length,
    coverage,
    providerHealthProbed: Boolean(providerHealth),
    analyses,
    findings,
    verdict,
  };
}

module.exports = {
  SESSION_GAP_MS,
  groupSessions,
  buildTrace,
  buildStats,
  buildDiscover,
  PROVIDER,
};
