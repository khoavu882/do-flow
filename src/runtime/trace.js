'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SESSION_GAP_MS,
  groupSessions,
  buildTrace,
  buildStats,
  buildDiscover,
  PROVIDER,
} = require('./trace-views');
const {
  shortTime,
  formatMs,
  finish,
  integrityNote,
  printEmptyLedgerNotice,
  DISCOVER_MARK,
} = require('./trace-render');

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

// buildTrace, buildStats and buildDiscover (the three views, plus the helpers they share) now
// live in ./trace-views.js; shortTime/formatMs/finish/integrityNote/printEmptyLedgerNotice (CLI
// rendering) now live in ./trace-render.js. Both are required at the top of this file and used,
// unchanged, by the handle*Command functions below.

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
