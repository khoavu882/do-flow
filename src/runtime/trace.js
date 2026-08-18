'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Task-run telemetry — the JavaScript port of
 * `core/shared/scripts/doflow/evaluation/telemetry.py` (plan task B.3, component C9).
 *
 * Records a task's span: the events that happened inside it, how long it took, how many tokens it
 * consumed. Ported from observed behaviour (plan decision D3): the event record shape, the trace
 * key names, the six-decimal cost rounding and the default per-token rates are unchanged.
 *
 * Plan task C.3 added the second half of this file: the date-partitioned run ledger (FR-011) and
 * its three inspection views (FR-012). `TaskRunTelemetry` captures one *task's* span in memory;
 * `RunLedger` is the on-disk record of *dispatched runs*, written by `doflow-run` and by any
 * runtime call that names the capability it used.
 *
 * Three defects are fixed rather than reproduced, each explained at its site:
 *   1. Duration came from `time.time()`, a wall clock that an NTP step or a DST change can move
 *      backwards mid-run, producing negative or inflated durations.
 *   2. `estimated_cost_usd` was computed from two hard-coded rates regardless of which model the
 *      trace named, so the number was presented as measured cost for models it did not price.
 *   3. `export_trace` returned the live `events` array, so a caller mutating the exported trace
 *      silently rewrote the recorder's history.
 */

/**
 * The Python's literal rates, kept as the default so an existing caller sees the same number.
 * They price one specific model; a trace naming a different one gets a cost only if the caller
 * supplies its rates, because inventing a price for an unpriced model is inventing a metric.
 */
const DEFAULT_TOKEN_RATES = Object.freeze({
  inputPerToken: 0.000003,
  outputPerToken: 0.000015,
});

const COST_DECIMALS = 6;

/**
 * @param {number} value
 * @returns {number} rounded to six decimals, matching the Python's `round(x, 6)`
 */
function roundCost(value) {
  const factor = 10 ** COST_DECIMALS;
  return Math.round(value * factor) / factor;
}

class TaskRunTelemetry {
  /**
   * @param {string} taskId
   * @param {Object|string} [options] a string is accepted for parity with the Python's positional
   *   `agent` argument
   * @param {string} [options.agent='codex']
   * @param {string} [options.model='default']
   * @param {{inputPerToken: number, outputPerToken: number}|null} [options.rates]
   * @param {Function} [options.clock] injection seam for tests; returns elapsed milliseconds
   */
  constructor(taskId, options = {}) {
    const opts = typeof options === 'string' ? { agent: options } : options;
    this.taskId = taskId;
    this.agent = opts.agent || 'codex';
    this.model = opts.model || 'default';
    this.rates = opts.rates === undefined ? DEFAULT_TOKEN_RATES : opts.rates;
    this.events = [];

    // Defect fix (1): a monotonic source. `Date.now()` (like Python's `time.time()`) can step
    // backwards, and a negative duration in a benchmark record is worse than no duration.
    this.clock = opts.clock || (() => Number(process.hrtime.bigint() / 1000000n));
    this.startedAtMs = this.clock();
    this.startedAt = new Date().toISOString();
  }

  /**
   * Appends a structured event to the span.
   * @param {string} eventType
   * @param {Object} [details={}]
   * @returns {Object} the recorded event
   */
  recordEvent(eventType, details = {}) {
    const event = {
      timestamp: new Date().toISOString(),
      type: eventType,
      details,
    };
    this.events.push(event);
    return event;
  }

  /**
   * Milliseconds elapsed since the recorder was constructed.
   * @returns {number}
   */
  elapsedMs() {
    return Math.max(0, this.clock() - this.startedAtMs);
  }

  /**
   * Compiles the run's trace record.
   * @param {boolean} success
   * @param {number} [inputTokens=0]
   * @param {number} [outputTokens=0]
   * @returns {Object} trace record
   */
  exportTrace(success, inputTokens = 0, outputTokens = 0) {
    // Defect fix (2): cost is only reported when rates are known for this run. The default rates
    // reproduce the Python's number exactly; a caller that clears them (`rates: null`) gets `null`
    // rather than a confident figure derived from another model's price list.
    const estimatedCostUsd = this.rates
      ? roundCost(inputTokens * this.rates.inputPerToken + outputTokens * this.rates.outputPerToken)
      : null;

    return {
      taskId: this.taskId,
      agent: this.agent,
      model: this.model,
      success: Boolean(success),
      startedAt: this.startedAt,
      durationMs: this.elapsedMs(),
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      eventCount: this.events.length,
      // Defect fix (3): a copy. The Python handed out its internal list, so an exported trace and
      // the recorder aliased the same array.
      events: this.events.map((e) => ({ ...e })),
    };
  }
}

// ---------------------------------------------------------------------------------- run ledger
//
// The ledger is one JSONL file per UTC date under `<config>/state/runs/`, appended to by
// `core/shared/scripts/doflow/bin/doflow-run` for every verb it dispatches. This module owns the
// reading side plus the writing side for capability-level events the shell dispatcher cannot see
// (which capability was requested, which provider answered, how much it returned).
//
// Two rules constrain everything below.
//   NFR-004 — records are metadata. The dispatcher deliberately records an argument *count* and
//   never an argument value; `sanitizeRunEvent` keeps that discipline for anything written here by
//   allowing a closed set of fields, validating every string against a token pattern that cannot
//   express a path, a URL, a quote or a space, and dropping everything else by name.
//   FR-011 note — tracing must never change what the traced command returned. Every function here
//   answers rather than throws: a missing directory, an unreadable file and a corrupt line are all
//   normal states of a best-effort ledger.

const RUNS_DIRNAME = 'runs';
const LEDGER_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** A run is a shell process; a gap this long between two of them is a new sitting, not the same
 * workflow. Used only when records carry no explicit `session`, and always reported alongside the
 * view so the reader knows the boundary was inferred rather than recorded. */
const SESSION_GAP_MS = 30 * 60 * 1000;

/**
 * The complete writable field set. Anything not listed here never reaches the ledger.
 * `wire` is the on-disk key: snake_case, matching the five fields `doflow-run` already writes, so
 * one file never mixes two naming conventions.
 */
const RUN_FIELDS = Object.freeze([
  { key: 'verb', wire: 'verb', type: 'token' },
  { key: 'kind', wire: 'kind', type: 'token' },
  { key: 'capability', wire: 'capability', type: 'token' },
  { key: 'provider', wire: 'provider', type: 'token' },
  { key: 'outcome', wire: 'outcome', type: 'token' },
  { key: 'stage', wire: 'stage', type: 'token' },
  { key: 'workflow', wire: 'workflow', type: 'token' },
  { key: 'taskClass', wire: 'task_class', type: 'token' },
  { key: 'session', wire: 'session', type: 'token' },
  { key: 'exitCode', wire: 'exit_code', type: 'int' },
  { key: 'durationMs', wire: 'duration_ms', type: 'uint' },
  { key: 'argCount', wire: 'arg_count', type: 'uint' },
  { key: 'resultCount', wire: 'result_count', type: 'uint' },
  { key: 'inputBytes', wire: 'input_bytes', type: 'uint' },
  { key: 'outputBytes', wire: 'output_bytes', type: 'uint' },
  { key: 'retryCount', wire: 'retry_count', type: 'uint' },
]);

/**
 * Identifiers only. No space, no quote, no slash, no dot-dot — a capability id (`code.exact-search`)
 * and a provider id (`semble.search`) fit; a file path, a query string, a command line, a URL and
 * anything with a secret's usual punctuation do not. This is the mechanical half of NFR-004: a
 * caller cannot smuggle content through a field that only accepts an identifier.
 */
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Timestamps are written by us or by the dispatcher's `date -u`; anything else is not a timestamp. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/;

/**
 * The neutral-state runs directory for an install root (`<root>/.doflow`).
 * @param {string} configDir an install root, e.g. `<project>/.doflow` or `~/.doflow`
 * @returns {string}
 */
function runsDir(configDir) {
  return path.join(configDir, 'state', RUNS_DIRNAME);
}

/**
 * Mirrors the dispatcher's own `resolve_config_dir` (design §4.1) so a view reads the same ledger
 * the dispatcher wrote. Resolving from `process.cwd()` alone would miss every run recorded by a
 * dispatcher invoked from a subdirectory of the project, and report an empty ledger for a project
 * that has been traced all day.
 * @param {Object} [options]
 * @param {string} [options.start] directory to walk up from (default: cwd)
 * @param {boolean} [options.global=false] force the home-scoped install
 * @param {Object} [options.env=process.env]
 * @param {string} [options.homeDir]
 * @param {Object} [options.fsImpl=fs]
 * @returns {{dir: string, configDir: string, origin: string, searched: string[]}}
 */
function resolveRunsLocation({ start, global: forceGlobal = false, env = process.env, homeDir = os.homedir(), fsImpl = fs } = {}) {
  const searched = [];
  const home = path.resolve(homeDir || '.');
  if (forceGlobal) {
    const configDir = path.join(home, '.doflow');
    return { dir: runsDir(configDir), configDir, origin: 'global', searched: [configDir] };
  }
  if (env.DOFLOW_CONFIG_DIR) {
    const configDir = path.resolve(env.DOFLOW_CONFIG_DIR);
    return { dir: runsDir(configDir), configDir, origin: 'DOFLOW_CONFIG_DIR', searched: [configDir] };
  }
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    const candidate = path.join(dir, '.doflow');
    searched.push(candidate);
    let found = false;
    try {
      found = fsImpl.statSync(candidate).isDirectory();
    } catch {
      found = false; // Not readable is the same as not there for a lookup that must not throw.
    }
    if (found) return { dir: runsDir(candidate), configDir: candidate, origin: 'project', searched };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const configDir = path.join(home, '.doflow');
  searched.push(configDir);
  return { dir: runsDir(configDir), configDir, origin: 'global-fallback', searched };
}

/**
 * Reduces an arbitrary object to a writable ledger record.
 * @param {Object} input
 * @param {Object} [options]
 * @param {Date} [options.now]
 * @returns {{record: Object|null, dropped: string[], reason?: string}} `dropped` names the rejected
 *   fields and never carries their values — a rejection report that echoed the value would leak
 *   exactly the content the rejection exists to keep out.
 */
function sanitizeRunEvent(input, { now = new Date() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { record: null, dropped: [], reason: 'event must be an object' };
  }
  const byKey = new Map(RUN_FIELDS.map((field) => [field.key, field]));
  const byWire = new Map(RUN_FIELDS.map((field) => [field.wire, field]));
  const record = {};
  const dropped = [];

  const timestamp = typeof input.timestamp === 'string' && ISO_TIMESTAMP.test(input.timestamp)
    ? input.timestamp
    : now.toISOString();
  if (input.timestamp !== undefined && timestamp !== input.timestamp) dropped.push('timestamp');
  record.timestamp = timestamp;

  for (const [name, value] of Object.entries(input)) {
    if (name === 'timestamp') continue;
    const field = byKey.get(name) || byWire.get(name);
    if (!field) { dropped.push(name); continue; }
    if (value === undefined || value === null) continue;
    if (field.type === 'token') {
      if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) { dropped.push(name); continue; }
      record[field.wire] = value;
    } else {
      const numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(numeric)) { dropped.push(name); continue; }
      const truncated = Math.trunc(numeric);
      if (field.type === 'uint' && truncated < 0) { dropped.push(name); continue; }
      record[field.wire] = truncated;
    }
  }

  // A record with no verb cannot be attributed to anything, and every view groups by verb.
  if (!record.verb) return { record: null, dropped, reason: 'event has no usable verb' };
  return { record, dropped };
}

/**
 * Reads one on-disk line into the canonical camelCase shape the views work in. Accepts both the
 * dispatcher's snake_case keys and the camelCase a JavaScript caller would write.
 * @param {*} raw parsed JSON value
 * @returns {Object|null} null when the line is not a usable record
 */
function normalizeRunRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = { timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : null };
  for (const field of RUN_FIELDS) {
    const value = raw[field.wire] !== undefined ? raw[field.wire] : raw[field.key];
    if (value === undefined || value === null) continue;
    if (field.type === 'token') {
      if (typeof value === 'string' && value !== '') out[field.key] = value;
    } else {
      const numeric = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(numeric)) out[field.key] = Math.trunc(numeric);
    }
  }
  if (!out.verb) return null;
  const parsed = out.timestamp ? Date.parse(out.timestamp) : NaN;
  out.at = Number.isNaN(parsed) ? null : parsed;
  return out;
}

class RunLedger {
  /**
   * @param {Object} [options]
   * @param {string} [options.dir] the runs directory; resolved from `configDir`/cwd when omitted
   * @param {string} [options.configDir] an install root (`<project>/.doflow`)
   * @param {Object} [options.fsImpl=fs]
   * @param {Function} [options.clock] returns the current Date; injection seam for tests
   */
  constructor({ dir, configDir, fsImpl = fs, clock = () => new Date() } = {}) {
    this.fsImpl = fsImpl;
    this.clock = clock;
    if (dir) this.dir = path.resolve(dir);
    else if (configDir) this.dir = runsDir(path.resolve(configDir));
    else this.dir = resolveRunsLocation({ fsImpl }).dir;
  }

  /**
   * Appends one metadata record. Always succeeds: an unwritable state directory degrades
   * observability, never the run being observed.
   * @param {Object} event
   * @returns {{written: boolean, file?: string, record?: Object, dropped: string[], reason?: string}}
   */
  append(event) {
    const { record, dropped, reason } = sanitizeRunEvent(event, { now: this.clock() });
    if (!record) return { written: false, dropped, reason };
    try {
      this.fsImpl.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `${record.timestamp.slice(0, 10)}.jsonl`);
      this.fsImpl.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
      return { written: true, file, record, dropped };
    } catch (error) {
      return { written: false, record, dropped, reason: error.message };
    }
  }

  /**
   * Reads the ledger. A missing directory, an unreadable partition and a corrupt line are reported
   * as counts on the result rather than raised — but they *are* reported, so a view can say "3
   * lines were unreadable" instead of quietly analysing a truncated history.
   * @param {Object} [options]
   * @param {number} [options.days] keep only partitions dated within the last N calendar days
   * @returns {{dir: string, exists: boolean, files: string[], records: Object[], malformedLines: number, unreadableFiles: string[], days: number|null}}
   */
  read({ days = null } = {}) {
    const result = {
      dir: this.dir,
      exists: false,
      files: [],
      records: [],
      malformedLines: 0,
      unreadableFiles: [],
      days: days && days > 0 ? days : null,
    };

    let entries;
    try {
      entries = this.fsImpl.readdirSync(this.dir);
    } catch {
      return result; // No ledger yet is the normal state of a fresh install, not a failure.
    }
    result.exists = true;

    let names = entries.filter((name) => LEDGER_FILE_RE.test(name)).sort();
    if (result.days) {
      // Calendar days, not "the last N files": a quiet week must not silently widen the window.
      const cutoff = new Date(this.clock().getTime() - (result.days - 1) * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      names = names.filter((name) => name.slice(0, 10) >= cutoff);
    }
    result.files = names;

    for (const name of names) {
      let text;
      try {
        text = this.fsImpl.readFileSync(path.join(this.dir, name), 'utf8');
      } catch {
        result.unreadableFiles.push(name);
        continue;
      }
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          // A partially written line is expected: the dispatcher appends from concurrent shells.
          result.malformedLines += 1;
          continue;
        }
        const record = normalizeRunRecord(parsed);
        if (record) result.records.push(record);
        else result.malformedLines += 1;
      }
    }

    // Undated records sort last rather than being dropped: they still count toward usage.
    result.records.sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER));
    return result;
  }
}

// ---------------------------------------------------------------------------------- view shared

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
      const observedRetrySignals = records.filter((r) => r.verb === 'verify' || r.verb === 'recover').length;
      return {
        ...base,
        status: observedRetrySignals ? CLEAR : NOT_DETERMINED,
        detail: observedRetrySignals
          ? 'verification ran in this window and no session hit the retry threshold.'
          : 'no `verify` or `recover` run appears in this window, so there is no retry behaviour to judge.',
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

// -------------------------------------------------------------------------------- CLI rendering

/** ISO timestamp to a compact local-independent `MM-DD HH:MM:SS`. Keeps columns narrow without
 * inventing a timezone the record does not carry. */
function shortTime(timestamp) {
  if (typeof timestamp !== 'string' || timestamp.length < 19) return '(undated)';
  return `${timestamp.slice(5, 10)} ${timestamp.slice(11, 19)}`;
}

function formatMs(value) {
  if (typeof value !== 'number') return '-';
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

/**
 * Records a view's exit code and hands it back to the caller.
 *
 * The design's uniform contract (§4.2) is `0` answered, `1` a finding to act on, `2` a usage error.
 * A handler sets `process.exitCode` rather than calling `process.exit`, so buffered stdout is
 * flushed before the process ends — and it also returns the code, so a test can assert it without
 * spawning a process.
 * @param {number} code
 * @returns {number}
 */
function finish(code) {
  process.exitCode = code;
  return code;
}

/**
 * What the view could not read, stated in the view rather than only in the JSON. A history that
 * silently lost a partition is a history a reader would over-trust.
 * @param {Object} ledger
 * @returns {string|null}
 */
function integrityNote(ledger) {
  const parts = [];
  if (ledger.malformedLines) parts.push(`${ledger.malformedLines} unreadable ledger line(s) skipped`);
  if (ledger.unreadableFiles.length) parts.push(`${ledger.unreadableFiles.length} unreadable partition(s): ${ledger.unreadableFiles.join(', ')}`);
  return parts.length ? `Note: ${parts.join('; ')}.` : null;
}

/** One place that turns a resolved location into the sentence an empty ledger deserves. */
function printEmptyLedgerNotice(ledger, reason) {
  console.log(`  ${reason}`);
  console.log(`  Location: ${ledger.dir}`);
  console.log('  An empty ledger is a normal state for a fresh install. It is not evidence that');
  console.log('  nothing ran, and no conclusion about usage can be drawn from it.');
}

/**
 * Handles `doflow trace` — the trajectory of the current or most recent workflow.
 * @param {Object} options
 * @param {boolean} [options.json=false]
 * @param {number} [options.days]
 * @param {boolean} [options.global=false]
 * @param {string} [options.projectRoot]
 * @returns {number} process exit code
 */
function handleTraceCommand({ json = false, days = null, global: useGlobal = false, projectRoot } = {}) {
  const location = resolveRunsLocation({ start: projectRoot, global: useGlobal });
  const view = buildTrace(new RunLedger({ dir: location.dir }).read({ days }));
  view.origin = location.origin;

  if (json) {
    console.log(JSON.stringify(view, null, 2));
    return finish(0);
  }

  console.log('\nDoFlow Run Trace — most recent workflow');
  console.log('═'.repeat(78));
  if (!view.trajectory) {
    printEmptyLedgerNotice(view.ledger, view.reason);
    console.log('═'.repeat(78) + '\n');
    return finish(0);
  }
  const t = view.trajectory;
  console.log(`Started:   ${t.startedAt}`);
  console.log(`Ended:     ${t.endedAt}`);
  console.log(`Steps:     ${t.stepCount} (${t.failedSteps} failed) · dispatched ${formatMs(t.dispatchedMs)} of ${formatMs(t.wallDurationMs)} wall`);
  console.log(`Boundary:  ${view.grouping === 'session-field' ? 'recorded session id' : `inferred from a ${view.gapMinutes}-minute idle gap`}${view.priorSessions ? ` · ${view.priorSessions} earlier session(s) in this window` : ''}`);
  console.log('─'.repeat(78));
  console.log('#'.padEnd(5) + 'TIME'.padEnd(16) + 'VERB'.padEnd(18) + 'OUTCOME'.padEnd(10) + 'TOOK'.padEnd(9) + 'CAPABILITY');
  for (const step of t.steps) {
    console.log(
      String(step.n).padEnd(5) +
      shortTime(step.timestamp).padEnd(16) +
      step.verb.padEnd(18) +
      String(step.outcome ?? 'unknown').padEnd(10) +
      formatMs(step.durationMs).padEnd(9) +
      (step.capability ?? (step.provider ?? '-'))
    );
  }
  const note = integrityNote(view.ledger);
  if (note) {
    console.log('─'.repeat(78));
    console.log(note);
  }
  console.log('═'.repeat(78) + '\n');
  return finish(0);
}

/**
 * Handles `doflow stats` — aggregate local usage.
 * @param {Object} options
 * @returns {number} process exit code
 */
function handleStatsCommand({ json = false, days = null, global: useGlobal = false, projectRoot } = {}) {
  const location = resolveRunsLocation({ start: projectRoot, global: useGlobal });
  const view = buildStats(new RunLedger({ dir: location.dir }).read({ days }));
  view.origin = location.origin;

  if (json) {
    console.log(JSON.stringify(view, null, 2));
    return finish(0);
  }

  console.log('\nDoFlow Run Statistics');
  console.log('═'.repeat(78));
  if (!view.recordCount) {
    printEmptyLedgerNotice(view.ledger, view.ledger.exists ? 'the ledger holds no readable run records' : 'no ledger has been written yet at this location');
    console.log('═'.repeat(78) + '\n');
    return finish(0);
  }
  console.log(`Records:   ${view.recordCount} across ${view.span.activeDays} day partition(s)${view.ledger.windowDays ? ` (last ${view.ledger.windowDays} days)` : ''}`);
  console.log(`Window:    ${view.span.first} → ${view.span.last}`);
  console.log(`Outcomes:  ${view.outcomes.succeeded} ok · ${view.outcomes.failed} failed · ${view.outcomes.unrecorded} exit code not recorded`);
  console.log(`Duration:  p50 ${formatMs(view.durations.p50Ms)} · p95 ${formatMs(view.durations.p95Ms)} · max ${formatMs(view.durations.maxMs)} (${view.durations.measured} measured)`);
  console.log('─'.repeat(78));
  console.log('VERB'.padEnd(20) + 'RUNS'.padEnd(8) + 'FAILED'.padEnd(9) + 'P50'.padEnd(9) + 'P95');
  for (const row of view.byVerb) {
    console.log(row.key.padEnd(20) + String(row.count).padEnd(8) + String(row.failures).padEnd(9) + formatMs(row.p50Ms).padEnd(9) + formatMs(row.p95Ms));
  }
  if (view.byCapability.length || view.byProvider.length) {
    console.log('─'.repeat(78));
    console.log('CAPABILITY'.padEnd(30) + 'RUNS'.padEnd(8) + 'FAILED');
    for (const row of view.byCapability) {
      console.log(row.key.padEnd(30) + String(row.count).padEnd(8) + String(row.failures));
    }
    console.log('PROVIDER'.padEnd(30) + 'RUNS'.padEnd(8) + 'FAILED');
    for (const row of view.byProvider) {
      console.log(row.key.padEnd(30) + String(row.count).padEnd(8) + String(row.failures));
    }
  } else {
    console.log('─'.repeat(78));
    console.log('No record in this window names a capability or provider — these are written by');
    console.log('runtime calls that resolve one, not by the shell dispatcher.');
  }
  const note = integrityNote(view.ledger);
  if (note) console.log(note);
  console.log('═'.repeat(78) + '\n');
  return finish(0);
}

const DISCOVER_MARK = Object.freeze({
  FINDING: '! FINDING',
  CLEAR: '✓ CLEAR',
  NOT_DETERMINED: '? UNKNOWN',
  NOT_APPLICABLE: '- N/A',
});

/**
 * Handles `doflow discover` — missed opportunities.
 * @param {Object} options
 * @param {Object} [options.providerHealth] injected for tests; probed from `health.js` otherwise
 * @returns {number} process exit code — 1 when there is a finding to act on
 */
function handleDiscoverCommand({ json = false, days = null, global: useGlobal = false, projectRoot, providerHealth } = {}) {
  const location = resolveRunsLocation({ start: projectRoot, global: useGlobal });
  const read = new RunLedger({ dir: location.dir }).read({ days });

  // Required lazily and defensively: a discover run must still answer if provider probing is
  // unavailable for any reason — it simply reports the analyses it could not settle.
  let health = providerHealth;
  if (health === undefined) {
    try {
      health = require('./health').probeProviders({ ids: Object.values(PROVIDER) });
    } catch {
      health = null;
    }
  }

  const view = buildDiscover(read, { providerHealth: health });
  view.origin = location.origin;

  if (json) {
    console.log(JSON.stringify(view, null, 2));
    return finish(view.findings.length ? 1 : 0);
  }

  console.log('\nDoFlow Missed Opportunities');
  console.log('═'.repeat(78));
  console.log(`Ledger:    ${view.ledger.dir}`);
  console.log(`Analysed:  ${view.ledger.recordCount} record(s), ${view.sessionsAnalyzed} session(s)${view.ledger.windowDays ? ` (last ${view.ledger.windowDays} days)` : ''}`);
  console.log(`Verdict:   ${view.verdict}`);
  const note = integrityNote(view.ledger);
  if (note) console.log(note.replace('Note:', 'Integrity:'));
  console.log('─'.repeat(78));
  for (const analysis of view.analyses) {
    console.log(`${DISCOVER_MARK[analysis.status].padEnd(12)}${analysis.title}`);
    console.log(`            ${analysis.detail}`);
    if (analysis.observed && analysis.observed.length) {
      for (const item of analysis.observed.slice(0, 5)) {
        console.log(`              · ${JSON.stringify(item)}`);
      }
    }
    if (analysis.recommendation) console.log(`            → ${analysis.recommendation}`);
    console.log('');
  }
  if (view.verdict === 'insufficient-data') {
    console.log('No analysis could be settled from this ledger. That is a statement about the data,');
    console.log('not a clean bill of health.');
  }
  console.log('═'.repeat(78) + '\n');
  return finish(view.findings.length ? 1 : 0);
}

module.exports = {
  TaskRunTelemetry,
  DEFAULT_TOKEN_RATES,
  RunLedger,
  runsDir,
  resolveRunsLocation,
  sanitizeRunEvent,
  normalizeRunRecord,
  groupSessions,
  buildTrace,
  buildStats,
  buildDiscover,
  handleTraceCommand,
  handleStatsCommand,
  handleDiscoverCommand,
  SESSION_GAP_MS,
  RUN_FIELDS,
};
