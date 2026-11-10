'use strict';

// Feature 152 A.1 (IC-001, IC-002; FR-001, FR-005, FR-006, FR-007, NFR-001, NFR-002): the read-only
// `sessions-history` verb.
//
//   doflow sessions-history [--days <n>] [--limit <n>] [--project-root <path>] [--json]
//
// Aggregates completed workflow sessions within a retention window (default 30 days) across
// `.doflow/state/sessions.log`, orchestration journals, and worker runs.
// Read-only: no locks, no worker executions, no network calls, no storage upkeep (NO_UPKEEP).
// All string leaves pass `maskJson`. Output is capped at OUTPUT_CAP_BYTES (4 MiB).

const fs = require('node:fs');
const path = require('node:path');
const { orchestrationRuns, selectRunEntries } = require('../implementation-gate.ts');
const { storeFileFor, readRuns } = require('../worker/run-store.ts');
const { configHome } = require('../config-home.ts');
const { maskJson } = require('../events/envelope.ts');
const { finishRuntime } = require('../cli-result.ts');

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const OUTPUT_CAP_BYTES = 4 * 1024 * 1024; // 4 MiB
const DAY_MS = 24 * 60 * 60 * 1000;
const VERB_FLAGS = new Set(['--days', '--limit', '--project-root', '--json']);

type Env = Record<string, string | undefined>;
interface Writable { write(text: string): any }

interface ScanOptions {
  days?: number | string | null;
  limit?: number | string | null;
  projectRoot?: string | null;
  cwd?: string | null;
  now?: Date | string | number | null;
  fsImpl?: any;
}

interface CommandOptions extends ScanOptions {
  json?: boolean;
  flags?: readonly string[];
  positional?: readonly string[];
  env?: Env;
  stdout?: Writable;
  stderr?: Writable;
}

interface StageSummary {
  id: string;
  name: string;
  skill: string | null;
  status: string;
  outcome: string;
  durationMs: number | null;
}

interface WorkerSummary {
  count: number;
  attempts: number;
  retries: number;
  quotaStops: number;
}

interface CostSummary {
  tokens: {
    input: number | null;
    output: number | null;
    total: number | null;
  };
  models: string[];
  telemetry: 'measured' | 'unknown';
}

interface SessionRecord {
  slug: string;
  taskId: string;
  taskClass: string;
  workflowName: string;
  harness: string | null;
  state: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  stages: StageSummary[];
  workers: WorkerSummary;
  cost: CostSummary;
  expired: boolean;
  project: {
    anchor: string;
    rel: string;
  };
}

interface SessionsHistoryBody {
  v: 1;
  window: {
    from: string;
    to: string;
    maxAgeDays: number;
  };
  sessions: SessionRecord[];
  limits: {
    shown: number;
    notShown: number;
    pruned: number;
  };
}

/** Reads the last 500 lines of sessions.log for START/END hints. */
function readSessionsLog(root: string, fsImpl: any = fs): Array<{ at: string; type: 'START' | 'END'; id: string; cwd: string }> {
  const candidates: string[] = [];
  try {
    const ch = configHome();
    if (ch && ch.dir) candidates.push(path.join(ch.dir, 'sessions.log'));
  } catch {}
  candidates.push(path.join(root, '.doflow', 'sessions.log'));

  for (const file of candidates) {
    try {
      if (fsImpl.existsSync(file)) {
        const text = fsImpl.readFileSync(file, 'utf8');
        const lines = text.trim().split('\n').slice(-500);
        const entries: Array<{ at: string; type: 'START' | 'END'; id: string; cwd: string }> = [];
        for (const line of lines) {
          const match = line.match(/^(\S+)\s+(START|END)\s+(\S+)(?:\s+(.*))?$/);
          if (match) {
            entries.push({ at: match[1], type: match[2] as 'START' | 'END', id: match[3], cwd: match[4] || 'unknown' });
          }
        }
        return entries;
      }
    } catch {}
  }
  return [];
}

/** Pure aggregator over orchestration runs and worker stores. */
function scanSessionsHistory(options: ScanOptions = {}): SessionsHistoryBody {
  const fsImpl = options.fsImpl || fs;
  const projectRoot = path.resolve(options.projectRoot || options.cwd || process.cwd());

  const daysParsed = Number(options.days);
  const maxAgeDays = Number.isSafeInteger(daysParsed) && daysParsed >= 1 && daysParsed <= MAX_DAYS ? daysParsed : DEFAULT_DAYS;

  const limitParsed = Number(options.limit);
  const limit = Number.isSafeInteger(limitParsed) && limitParsed >= 1 && limitParsed <= MAX_LIMIT ? limitParsed : DEFAULT_LIMIT;

  const now = options.now ? new Date(options.now) : new Date();
  const toIso = now.toISOString();
  const fromMs = now.getTime() - maxAgeDays * DAY_MS;
  const fromIso = new Date(fromMs).toISOString();

  let listed: any = { ok: true, entries: [] };
  try {
    listed = orchestrationRuns({ stateRoot: projectRoot });
  } catch {
    listed = { ok: true, entries: [] };
  }

  const entries: any[] = (listed && listed.ok && Array.isArray(listed.entries))
    ? selectRunEntries(listed.entries)
    : [];

  const sessionsLogEntries = readSessionsLog(projectRoot, fsImpl);

  const matchedSessions: SessionRecord[] = [];
  let prunedCount = 0;

  for (const entry of entries) {
    const record = entry.record;
    if (!record || typeof record !== 'object') continue;

    const slug = String(entry.slug || record.featureSlug || record.slug || record.taskId || 'unknown');
    const taskId = String(record.taskId || slug);
    const taskClass = String(record.taskClass || 'unknown');
    const workflowName = String(record.workflowName || 'Feature Delivery');
    const state = String(record.state || 'UNKNOWN');

    const history: any[] = Array.isArray(record.history) ? record.history : [];
    const startedAt = record.startedAt || history[0]?.at || null;
    const endedAt = (state === 'COMPLETED' || state === 'FAILED')
      ? (history.findLast((h: any) => h?.action === 'complete-run' || h?.action === 'complete-stage' || h?.action === 'decide-gate')?.at || record.updatedAt || null)
      : null;

    const startedMs = startedAt ? new Date(startedAt).getTime() : NaN;

    // Check 30-day retention cutoff
    if (Number.isFinite(startedMs) && startedMs < fromMs) {
      prunedCount += 1;
      continue;
    }

    const durationMs = (startedAt && endedAt)
      ? Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime())
      : null;

    // Stages from program and history
    const program: any[] = Array.isArray(record.program) ? record.program : [];
    const stages: StageSummary[] = [];

    let prevAt = startedAt;
    for (const node of program) {
      if (node.type !== 'stage') continue;
      const stageId = String(node.id);
      const stageName = String(node.name || stageId);
      const skill = node.skill ? String(node.skill) : null;

      const completion = history.find((h: any) => h && h.node === stageId && (h.action === 'complete-stage' || h.action === 'skip-stage'));
      const stageOutcome = completion
        ? String(completion.outcome || completion.executionStatus || 'completed')
        : String(node.outcome || node.executionStatus || node.status || 'pending');

      const stageAt = completion?.at || null;
      let stageDurationMs: number | null = null;
      if (stageAt && prevAt) {
        stageDurationMs = Math.max(0, new Date(stageAt).getTime() - new Date(prevAt).getTime());
        prevAt = stageAt;
      }

      stages.push({
        id: stageId,
        name: stageName,
        skill,
        status: node.status || (completion ? 'completed' : 'pending'),
        outcome: stageOutcome,
        durationMs: stageDurationMs,
      });
    }

    // Worker runs from worker store
    let runsMap: Record<string, any> = {};
    try {
      const storeFile = storeFileFor(entry.root || projectRoot, slug);
      if (fsImpl.existsSync(storeFile)) {
        runsMap = readRuns(storeFile, fsImpl);
      }
    } catch {}

    const workerRunsList: any[] = Object.values(runsMap || {});
    const distinctAttempts = new Set(workerRunsList.map((r) => `${r.task}:${r.token}`)).size;
    const retriesCount = workerRunsList.filter((r) => Number.isInteger(r.token) && r.token > 1).length;
    const quotaStops = workerRunsList.filter((r) => r.report?.quota || r.end?.state === 'quota').length;

    const workersSummary: WorkerSummary = {
      count: workerRunsList.length,
      attempts: distinctAttempts,
      retries: retriesCount,
      quotaStops,
    };

    // Determine harness
    let harness: string | null = null;
    const workerWithHarness = workerRunsList.find((r) => typeof r.harness === 'string' && r.harness);
    if (workerWithHarness) {
      harness = workerWithHarness.harness;
    } else {
      const logMatch = sessionsLogEntries.find((s) => s.cwd && entry.root && s.cwd.includes(entry.root));
      if (logMatch) harness = 'session-log';
    }

    // Token telemetry and cost aggregation
    let hasMeasuredTokens = false;
    let inputTokens = 0;
    let outputTokens = 0;
    const modelsSet = new Set<string>();

    for (const wr of workerRunsList) {
      if (wr.report && typeof wr.report === 'object') {
        if (wr.report.model && typeof wr.report.model === 'string') {
          modelsSet.add(wr.report.model);
        }
        if (wr.report.tokens && typeof wr.report.tokens === 'object') {
          const inp = Number(wr.report.tokens.input);
          const out = Number(wr.report.tokens.output);
          if (Number.isFinite(inp) || Number.isFinite(out)) {
            hasMeasuredTokens = true;
            if (Number.isFinite(inp)) inputTokens += inp;
            if (Number.isFinite(out)) outputTokens += out;
          }
        }
      }
      if (wr.descriptor?.profile?.model && typeof wr.descriptor.profile.model === 'string') {
        modelsSet.add(wr.descriptor.profile.model);
      }
    }

    const costSummary: CostSummary = {
      tokens: {
        input: hasMeasuredTokens ? inputTokens : null,
        output: hasMeasuredTokens ? outputTokens : null,
        total: hasMeasuredTokens ? (inputTokens + outputTokens) : null,
      },
      models: [...modelsSet].sort(),
      telemetry: hasMeasuredTokens ? 'measured' : 'unknown',
    };

    const relPath = entry.root ? path.relative(projectRoot, entry.root) : '';

    matchedSessions.push({
      slug,
      taskId,
      taskClass,
      workflowName,
      harness,
      state,
      startedAt,
      endedAt,
      durationMs,
      stages,
      workers: workersSummary,
      cost: costSummary,
      expired: false,
      project: {
        anchor: '<project>',
        rel: relPath,
      },
    });
  }

  // Sort newest first
  matchedSessions.sort((a, b) => {
    const timeA = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const timeB = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return timeB - timeA;
  });

  const totalFound = matchedSessions.length;
  const shownSessions = matchedSessions.slice(0, limit);

  const rawBody: SessionsHistoryBody = {
    v: 1,
    window: {
      from: fromIso,
      to: toIso,
      maxAgeDays,
    },
    sessions: shownSessions,
    limits: {
      shown: shownSessions.length,
      notShown: Math.max(0, totalFound - shownSessions.length),
      pruned: prunedCount,
    },
  };

  return maskJson(rawBody);
}

/** CLI entry point for `doflow sessions-history`. */
function handleSessionsHistoryCommand(options: CommandOptions = {}): number {
  const flags = options.flags || [];
  const positional = options.positional || [];

  for (const f of flags) {
    const key = f.split('=')[0];
    if (!VERB_FLAGS.has(key)) {
      const err = `doflow: unknown flag '${f}'\n`;
      if (options.stderr) options.stderr.write(err);
      else process.stderr.write(err);
      return finishRuntime(2);
    }
  }

  if (positional.length > 0) {
    const err = `doflow sessions-history: unexpected argument '${positional[0]}'\n`;
    if (options.stderr) options.stderr.write(err);
    else process.stderr.write(err);
    return finishRuntime(2);
  }

  let body: SessionsHistoryBody;
  try {
    body = scanSessionsHistory(options);
  } catch (error: any) {
    const err = `doflow sessions-history: ${error?.message || 'failed to scan sessions'}\n`;
    if (options.stderr) options.stderr.write(err);
    else process.stderr.write(err);
    return finishRuntime(2);
  }

  const jsonStr = JSON.stringify(body);
  if (Buffer.byteLength(jsonStr, 'utf8') > OUTPUT_CAP_BYTES) {
    const err = `doflow sessions-history: payload exceeds ${OUTPUT_CAP_BYTES} bytes\n`;
    if (options.stderr) options.stderr.write(err);
    else process.stderr.write(err);
    return finishRuntime(2);
  }

  if (options.json) {
    const out = `${jsonStr}\n`;
    if (options.stdout) options.stdout.write(out);
    else process.stdout.write(out);
    return finishRuntime(0);
  }

  // Non-JSON tabular output
  const lines: string[] = [
    `Sessions History (Window: ${body.window.maxAgeDays} days, Shown: ${body.limits.shown}, Not shown: ${body.limits.notShown})`,
    '------------------------------------------------------------------------------------------------',
    'STARTED              STATE       CLASS      DURATION    WORKERS  SLUG',
    '------------------------------------------------------------------------------------------------',
  ];

  for (const s of body.sessions) {
    const started = s.startedAt ? s.startedAt.slice(0, 19).replace('T', ' ') : 'unknown            ';
    const state = s.state.padEnd(11);
    const cls = s.taskClass.padEnd(10);
    const durSec = s.durationMs !== null ? `${Math.round(s.durationMs / 1000)}s`.padEnd(11) : '-'.padEnd(11);
    const workers = String(s.workers.count).padEnd(8);
    lines.push(`${started}  ${state} ${cls} ${durSec} ${workers} ${s.slug}`);
  }

  const out = `${lines.join('\n')}\n`;
  if (options.stdout) options.stdout.write(out);
  else process.stdout.write(out);
  return finishRuntime(0);
}

module.exports = {
  scanSessionsHistory,
  handleSessionsHistoryCommand,
  DEFAULT_DAYS,
  MAX_DAYS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  OUTPUT_CAP_BYTES,
  VERB_FLAGS,
};
