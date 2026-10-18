'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const path = require('node:path');
const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const { SAFE_TOKEN, telemetryOff, TelemetryWriter } = require('../trace/telemetry.ts');
const { resolveRunsLocation } = require('../trace/ledger.ts');
const { DISPATCH_RUN_ID } = require('../dispatch/store.ts');
const { levelOf, v0Applies, v0Enabled, loadVerificationRegistry } = require('./registry.ts');

let defaultRegistry: any = null;
function getDefaultRegistry(): any {
  if (!defaultRegistry) {
    try {
      defaultRegistry = loadVerificationRegistry();
    } catch {
      defaultRegistry = null;
    }
  }
  return defaultRegistry;
}


/**
 * Verify telemetry (088 C.1, IC-006, DD-4): one `verify.run` line per verify run, one `verify.tier`
 * per report tier and one `verify.check` per check, written through `TelemetryWriter`.
 *
 * The report is never touched: timing comes from the runner's `metrics` WeakMap (keyed by each
 * check result object), so `verify --json` is the same bytes with telemetry on, off or faulted
 * (FR-002, NFR-005, NFR-007). Records are built with every design field; the writer keeps only
 * the keys `core/registry/telemetry.json` declares for the kind, so a later phase widens the lines
 * by declaring keys, not by changing this module. Fields whose source does not exist yet are null:
 * `level` until G.1, `v0` until G.2, `check_key` and `shared` until E.2.
 *
 * Where: `DOFLOW_CONFIG_DIR` when set, even over a nearer store; else the nearest `.doflow` above
 * `start` that holds `state/runs`, so a `.doflow` without a ledger (one left by an older runtime's
 * cwd-rooted verification logs) is walked past. With no project store nothing is written: no global
 * fallback, so the lines stay under the project's state (NFR-006), as the bridge's hook lines do.
 */

type Env = Record<string, string | undefined>;

/** ISO 8601 with ms for an epoch-ms number, else undefined (the writer then stamps its own clock). */
function isoAt(ms: unknown): string | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * The records for one verify run, in write order: run, then each tier followed by its checks.
 * Pure; a value that fails its registry type is nulled by the writer, never here.
 * @param {Object} input
 * @param {Object} input.report a `runContract` report, or the dispatch runner's `{status, startedAt, finishedAt, tiers: []}`
 * @param {WeakMap} [input.metrics] check result → `{ startedAt, durationMs }`
 * @param {{verifyId: string, source: string, taskId: *, risk: *, exitCode: *}} input.ctx
 * @returns {Array<Object>}
 */
function buildVerifyRecords({ report, metrics = null, ctx }: any): any[] {
  const verifyId = ctx.verifyId;
  const runStart = Date.parse(report.startedAt);
  const runEnd = Date.parse(report.finishedAt);
  // Timestamp of a record with no start of its own (a tier with no check, an in-run duplicate):
  // the latest instant seen so far, so line timestamps never go backwards.
  let cursor = Number.isFinite(runStart) ? runStart : undefined;
  let checksRun = 0;
  const body: any[] = [];
  const commandKeys = new Map<string, string | null>();

  for (const tier of Array.isArray(report.tiers) ? report.tiers : []) {
    const checks: any[] = [];
    let tierMs: number | null = null;
    let tierStart: number | undefined;
    for (const check of Array.isArray(tier.checks) ? tier.checks : []) {
      const timing = check && typeof check === 'object' && metrics ? metrics.get(check) : undefined;
      let durationMs: number | null = null;
      let at = cursor;
      let checkKey: string | null = null;
      let shared: string | null = null;
      let tests: number | null = null;
      let testsFailed: number | null = null;
      let cpuMs: number | null = null;
      let resourceBasis: string | null = null;

      if (check && check.status === 'NOT_RUN') {
        durationMs = null;
      } else if (timing) {
        checksRun += 1;
        if (Number.isFinite(timing.startedAt)) at = timing.startedAt;
        if (Number.isFinite(timing.durationMs)) durationMs = Math.round(timing.durationMs);
        if (at !== undefined) cursor = Math.max(cursor ?? at, at + (durationMs ?? 0));
        checkKey = timing.checkKey ?? null;
        shared = timing.shared ?? 'none';
        tests = typeof timing.tests === 'number' ? timing.tests : null;
        testsFailed = typeof timing.testsFailed === 'number' ? timing.testsFailed : null;
        cpuMs = typeof timing.cpuMs === 'number' ? timing.cpuMs : null;
        resourceBasis = timing.resourceBasis ?? null;
        if (check && check.command && checkKey) {
          commandKeys.set(check.command, checkKey);
        }
      } else if (check && check.deduplicated) {
        durationMs = 0; // reused the result of an identical check earlier in this run (S-10)
        shared = 'in-run';
        checkKey = (check.command && commandKeys.get(check.command)) ?? null;
      }
      if (durationMs !== null) tierMs = (tierMs ?? 0) + durationMs;
      if (tierStart === undefined) tierStart = at;
      checks.push({
        kind: 'verify.check',
        timestamp: isoAt(at),
        verify_id: verifyId,
        tier: tier.id,
        status: check ? check.status : null,
        exit_code: check ? (check.exitCode ?? null) : null,
        duration_ms: durationMs,
        tests,
        tests_failed: testsFailed,
        cpu_ms: cpuMs,
        resource_basis: resourceBasis,
        check_key: checkKey,
        shared,
      });
    }
    const selection = tier.selection || {};
    body.push({
      kind: 'verify.tier',
      timestamp: isoAt(tierStart ?? cursor),
      verify_id: verifyId,
      tier: tier.id,
      status: tier.status,
      duration_ms: tierMs, // derived: the sum of its checks (IC-006 basis derived-sum)
      selection_basis: selection.basis ?? null,
      selected: selection.selectedCount ?? null,
      total: selection.totalCount ?? null,
      fallback: selection.fallback ?? null,
    }, ...checks);
  }

  const dispatchRun = ctx.dispatchRun ?? ctx.dispatch_run;
  const reg = ctx.registry || getDefaultRegistry();
  const risk = ctx.risk ?? null;
  const level = ctx.level ?? (risk ? levelOf(reg, risk) : null);
  const applies = ctx.v0Applies !== undefined ? Boolean(ctx.v0Applies) : (risk ? v0Applies(reg, risk) : false);

  let v0: 'on' | 'off' | null = null;
  if (ctx.source === 'dispatch') {
    v0 = null;
  } else if (ctx.v0 === 'off' || ctx.v0 === false) {
    v0 = 'off';
  } else if (ctx.v0 === 'on' || ctx.v0 === true) {
    v0 = applies ? 'on' : null;
  } else if (ctx.v0 === null) {
    v0 = null;
  } else {
    const isEnabled = v0Enabled(ctx.env || process.env, ctx.configDir);
    if (!isEnabled) {
      v0 = 'off';
    } else {
      v0 = applies ? 'on' : null;
    }
  }

  const run = {
    kind: 'verify.run',
    timestamp: isoAt(runStart),
    verify_id: verifyId,
    source: ctx.source,
    task: typeof ctx.taskId === 'string' && SAFE_TOKEN.test(ctx.taskId) ? ctx.taskId : null,
    dispatch_run: ctx.source === 'dispatch' && typeof dispatchRun === 'string' && DISPATCH_RUN_ID.test(dispatchRun)
      ? dispatchRun
      : null,
    risk,
    level,
    status: report.status,
    exit_code: ctx.exitCode ?? null,
    // Wall time between the report's own stamps: the engine clock, not a monotonic one.
    duration_ms: Number.isFinite(runStart) && Number.isFinite(runEnd) ? Math.max(0, runEnd - runStart) : null,
    checks_run: checksRun,
    v0,
  };
  return [run, ...body];
}

/**
 * The directory the writer should walk up from, or null when no project store exists.
 * @param {string} [start]
 * @param {Object} env
 * @param {Object} fsImpl
 * @returns {string|null}
 */
function storeStart(start: string | undefined, env: Env, fsImpl: any): string | null {
  const at = resolveRunsLocation({ start, env, fsImpl, containing: path.join('state', 'runs') });
  if (at.origin === 'DOFLOW_CONFIG_DIR') return start || process.cwd(); // the writer reads the same variable
  return at.origin === 'project' ? path.dirname(at.configDir) : null;
}

/**
 * Writes the verify lines for one run. Never throws; any fault writes nothing (NFR-005).
 * @param {Object} input
 * @param {Object} input.report
 * @param {WeakMap} [input.metrics]
 * @param {{source: 'verb'|'dispatch', taskId: *, risk: *, exitCode: *}} input.ctx
 * @param {Object} [input.env=process.env]
 * @param {string} [input.start] the verify's working directory (walk-up origin)
 * @param {Function} [input.now] writer clock; test seam
 * @param {Object} [input.fsImpl] test seam
 */
function emitVerifyTelemetry({ report, metrics = null, ctx, env = process.env, start, now, fsImpl = nodeFs }: any): void {
  try {
    if (telemetryOff(env)) return;
    const from = storeStart(start, env, fsImpl);
    if (from === null) return;
    const records = buildVerifyRecords({ report, metrics, ctx: { env: ctx?.env || env, ...ctx, verifyId: crypto.randomBytes(8).toString('hex') } });
    new TelemetryWriter({ env, fsImpl, start: from, ...(now ? { now } : {}) }).write(records);
  } catch {
    // Telemetry changes no outcome (FR-002, NFR-005).
  }
}

module.exports = { buildVerifyRecords, emitVerifyTelemetry };
