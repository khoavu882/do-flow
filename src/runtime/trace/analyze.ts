'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * `trace analyze` (091 IC-001..IC-005, IC-011): three detectors over the spans view of spans.ts,
 * run per scope (each trace, each ungrouped `session:`/`day:` group), each with a state, plus the
 * verdict rule of `trace discover`. Findings print as two batches the existing verbs accept
 * unchanged: evidence items (`evidence --action add --batch -`) and proposals
 * (`followup --action add --batch <file>`).
 *
 * Read only and pure over the view: nothing is written, no wall-clock field, keys sorted, so the
 * same stores give the same bytes. No field is a score. The rider R1 `context` section reports
 * UserPromptSubmit emission metadata per session; it never changes the verdict or the exit code.
 * Loads no network module; the evidence ledger loads only for `--emit followups --task-id`.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { projectSpans } = require('./spans.ts');
const { percentile } = require('./views.ts');
const { finish } = require('./render.ts');
const { maskLine } = require('../mask.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

const FINDING = 'FINDING';
const CLEAR = 'CLEAR';
const NOT_DETERMINED = 'NOT_DETERMINED';
const THRESHOLD_KEYS = ['minSamples', 'tailRatio', 'minTailMs', 'retryRun'];
const SPAN_CAP = 20;
/** IC-011: a whitelist, so a reuse marker added later (089's `reused`) never counts as executed. */
const EXECUTED_SHARED = new Set(['none', 'leader']);
const EMIT = new Set(['evidence', 'followups']);
/** `--run`: a run key or a run id (the spans.ts rule). */
const RUN_ARG = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9._:-]+){0,2}$/;
/** followup.ts STATEMENT_MAX; not required from there, which would load the lifecycle store. */
const STATEMENT_MAX = 280;
/** The run shape mask.ts masks (LONG_RUN); a statement never carries one. */
const LONG_RUN = /[A-Za-z0-9+/=_-]{32,}/;
/** An evidence id as EvidenceLedger#generateId mints it; anything else is not cited. */
const EVIDENCE_ID = /^ev_[a-z0-9]+_[0-9a-f]{8}_[a-z0-9]+$/;

const sha16 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const cmp = (a: any, b: any): number => (a < b ? -1 : a > b ? 1 : 0);
const startMs = (s: any): number => (s.start === null ? Infinity : Date.parse(s.start));
const byStart = (a: any, b: any): number => startMs(a) - startMs(b) || cmp(a.spanId, b.spanId);
const sum = (list: number[]): number => list.reduce((n, v) => n + v, 0);

/** Object keys sorted at every level (the spans view rule). */
function sorted(value: any): any {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
  return value;
}

// ── thresholds (IC-003) ─────────────────────────────────────────────────────────────────────────

/** The `analysis` block as thresholds, or the usage error naming the first bad key. */
function checkThresholds(block: any): { thresholds?: any; error?: string } {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return { error: 'analysis block missing from core/registry/telemetry.json' };
  for (const key of THRESHOLD_KEYS) {
    if (!Number.isInteger(block[key]) || block[key] < 1) return { error: `analysis.${key} must be a positive integer (core/registry/telemetry.json)` };
  }
  return { thresholds: Object.fromEntries(THRESHOLD_KEYS.map((k) => [k, block[k]])) };
}

/** The registry's `analysis` block, read where spans.ts reads the kinds. */
function readThresholds(): { thresholds?: any; error?: string } {
  let block: any;
  try { block = JSON.parse(nodeFs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'telemetry.json'), 'utf8')).analysis; } catch { block = undefined; }
  return checkThresholds(block);
}

// ── detectors ───────────────────────────────────────────────────────────────────────────────────

/** Each trace and each ungrouped group is one scope. */
function scopesOf(view: any): any[] {
  return [
    ...view.traces.map((tr: any) => ({ scope: tr.traceId, scopeKind: 'trace', spans: tr.spans })),
    ...view.ungrouped.map((g: any) => ({ scope: g.group, scopeKind: g.group.startsWith('session:') ? 'session' : 'day', spans: g.spans })),
  ];
}

/**
 * A finding over `spans`: its id hashes every span id; the listed spans are the first 20 of `keep`
 * (the detector's order), shown by start then spanId, with `measures.spanCount` when capped.
 */
function finding(detector: string, sc: any, spans: any[], measures: any, keep: any[] = [...spans].sort(byStart)): any {
  const ids = spans.map((s) => s.spanId).sort();
  return {
    id: sha16(`${detector}\n${sc.scope}\n${ids.join(',')}`), detector, scope: sc.scope, scopeKind: sc.scopeKind,
    spans: keep.slice(0, SPAN_CAP).sort(byStart).map((s) => ({ spanId: s.spanId, locator: s.locator })),
    measures: spans.length > SPAN_CAP ? { ...measures, spanCount: spans.length } : measures,
  };
}

function result(id: string, findings: any[], determined: boolean, detail: Record<string, string>): any {
  const status = findings.length ? FINDING : determined ? CLEAR : NOT_DETERMINED;
  return { id, status, detail: detail[status], findings };
}

/** Per scope and (kind, name): p95 >= tailRatio x p50 and p95 - p50 >= minTailMs. */
function latencyHotspots(scopes: any[], th: any, latency: any[]): any {
  const findings: any[] = [];
  let determined = false;
  for (const sc of scopes) {
    const groups = new Map<string, any>();
    for (const s of sc.spans) {
      if (!Number.isInteger(s.durationMs)) continue;
      const key = `${s.kind}\n${s.name ?? ''}`;
      if (!groups.has(key)) groups.set(key, { kind: s.kind, name: s.name ?? null, spans: [] });
      groups.get(key).spans.push(s);
    }
    for (const g of [...groups.values()].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.name ?? '', b.name ?? ''))) {
      if (g.spans.length < th.minSamples) continue;
      determined = true;
      const d = g.spans.map((s: any) => s.durationMs);
      const p50 = percentile(d, 0.5) as number;
      const p95 = percentile(d, 0.95) as number;
      const row = { kind: g.kind, name: g.name, count: d.length, p50Ms: p50, p95Ms: p95, totalMs: sum(d) };
      latency.push({ scope: sc.scope, ...row });
      if (p95 >= th.tailRatio * p50 && p95 - p50 >= th.minTailMs) {
        const slow = g.spans.filter((s: any) => s.durationMs > p50);
        findings.push(finding('latency-hotspots', sc, slow, row, [...slow].sort((a, b) => b.durationMs - a.durationMs || cmp(a.spanId, b.spanId))));
      }
    }
  }
  return result('latency-hotspots', findings, determined, {
    [FINDING]: `${findings.length} span name(s) have p95 >= ${th.tailRatio}x p50 and a tail of at least ${th.minTailMs} ms.`,
    [CLEAR]: `no span name with ${th.minSamples} or more durations has p95 >= ${th.tailRatio}x p50 and a tail of at least ${th.minTailMs} ms.`,
    [NOT_DETERMINED]: `no span name has ${th.minSamples} durations.`,
  });
}

/** IC-011: a status other than NOT_RUN or null, and `shared` none, leader or null. */
const executed = (s: any): boolean => s.attrs.status != null && s.attrs.status !== 'NOT_RUN'
  && (s.attrs.shared == null || EXECUTED_SHARED.has(s.attrs.shared));

/** Per scope: one check key passed by two or more executed checks with no FAIL of that key between. */
function redundantVerification(scopes: any[]): any {
  const findings: any[] = [];
  let determined = false;
  for (const sc of scopes) {
    const checks = sc.spans.filter((s: any) => s.kind === 'verify.check' && typeof s.attrs.check_key === 'string').sort(byStart);
    const passes = new Map<string, any[]>();
    for (const s of checks) {
      if (!executed(s)) continue;
      determined = true;
      if (s.attrs.status !== 'PASS') continue;
      if (!passes.has(s.attrs.check_key)) passes.set(s.attrs.check_key, []);
      passes.get(s.attrs.check_key)!.push(s);
    }
    for (const [key, list] of [...passes.entries()].sort(([a], [b]) => cmp(a, b))) {
      if (list.length < 2) continue;
      const first = list[0];
      const last = list[list.length - 1];
      if (checks.some((s: any) => s.attrs.check_key === key && s.attrs.status === 'FAIL' && byStart(first, s) < 0 && byStart(s, last) < 0)) continue;
      findings.push(finding('redundant-verification', sc, list, { checkKey: key, passes: list.length, tier: first.attrs.tier ?? null }));
    }
  }
  return result('redundant-verification', findings, determined, {
    [FINDING]: `${findings.length} check key(s) passed more than once with no failure between.`,
    [CLEAR]: 'no executed check key passed twice without a failure between.',
    [NOT_DETERMINED]: 'no executed verify.check carries a check_key.',
  });
}

/**
 * Per scope and task (a null task groups by scope): a maximal run of at least `retryRun` FAIL runs
 * with one failure class and no PASS between. The class is the sorted set of FAIL tiers under the
 * run, or `exit:<code>` when it has no tier spans. A run whose status is neither PASS nor FAIL
 * (null, UNRESOLVED, ...) neither extends nor breaks a sequence.
 */
function retryLoops(scopes: any[], th: any): any {
  const findings: any[] = [];
  let determined = false;
  for (const sc of scopes) {
    const runs = sc.spans.filter((s: any) => s.kind === 'verify.run').sort(byStart);
    if (runs.some((s: any) => s.attrs.status != null)) determined = true;
    const tiers = new Map<string, any[]>();
    for (const s of sc.spans) {
      if (s.kind !== 'verify.tier' || typeof s.attrs.verify_id !== 'string') continue;
      if (!tiers.has(s.attrs.verify_id)) tiers.set(s.attrs.verify_id, []);
      tiers.get(s.attrs.verify_id)!.push(s);
    }
    const classOf = (r: any): string => {
      const under = tiers.get(r.attrs.verify_id) || [];
      if (!under.length) return `exit:${r.attrs.exit_code ?? null}`;
      return [...new Set(under.filter((s) => s.attrs.status === 'FAIL').map((s) => s.attrs.tier ?? s.name))].sort().join(',');
    };
    const groups = new Map<string | null, any[]>();
    for (const r of runs) {
      const task = r.attrs.task ?? null;
      if (!groups.has(task)) groups.set(task, []);
      groups.get(task)!.push(r);
    }
    for (const [task, list] of groups) {
      let seq: any[] = [];
      let cls: string | null = null;
      const close = () => {
        if (seq.length >= th.retryRun) {
          findings.push(finding('retry-loops', sc, seq, { task, runs: seq.length, failureClass: cls, grouping: task === null ? 'scope' : 'task' }));
        }
        seq = [];
        cls = null;
      };
      for (const r of list) {
        if (r.attrs.status === 'PASS') { close(); continue; }
        if (r.attrs.status !== 'FAIL') continue;
        const c = classOf(r);
        if (seq.length && c !== cls) close();
        seq.push(r);
        cls = c;
      }
      close();
    }
  }
  return result('retry-loops', findings, determined, {
    [FINDING]: `${findings.length} task(s) failed verification ${th.retryRun} or more times in a row with the same failure class.`,
    [CLEAR]: `no task failed verification ${th.retryRun} times in a row with the same failure class.`,
    [NOT_DETERMINED]: 'no verify.run carries a status.',
  });
}

/**
 * Rider R1: per session, over hook spans that carry `session` (a `test` span is a folded post hook
 * line, so it counts as a call): calls, emissions (`emit` or `refused:*`), their bytes, and the
 * emissions whose digest an earlier emission of the session already had.
 */
function contextOf(scopes: any[]): any {
  const hooks = scopes.flatMap((sc) => sc.spans).filter((s: any) => s.kind === 'hook' || s.kind === 'test').sort(byStart);
  if (!hooks.some((s: any) => typeof s.attrs.emit_reason === 'string')) return { status: NOT_DETERMINED, sessions: [] };
  const rows = new Map<string, any>();
  for (const s of hooks) {
    const session = s.attrs.session;
    if (typeof session !== 'string') continue;
    if (!rows.has(session)) rows.set(session, { session, hookCalls: 0, emissions: 0, emittedBytes: 0, duplicates: 0, duplicateBytes: 0, reasons: {}, seen: new Set() });
    const row = rows.get(session);
    row.hookCalls += 1;
    const reason = s.attrs.emit_reason;
    if (typeof reason !== 'string') continue;
    row.reasons[reason] = (row.reasons[reason] || 0) + 1;
    if (reason !== 'emit' && !reason.startsWith('refused:')) continue;
    const bytes = Number.isInteger(s.attrs.emit_bytes) ? s.attrs.emit_bytes : 0;
    row.emissions += 1;
    row.emittedBytes += bytes;
    const digest = s.attrs.emit_digest;
    if (typeof digest !== 'string') continue;
    if (row.seen.has(digest)) { row.duplicates += 1; row.duplicateBytes += bytes; } else row.seen.add(digest);
  }
  return { status: 'MEASURED', sessions: [...rows.values()].sort((a, b) => cmp(a.session, b.session)).map(({ seen, ...row }) => row) };
}

/**
 * The IC-002 analysis view of a spans view. Pure.
 * @param {Object} view `{v, traces, ungrouped, gaps}` from projectSpans
 * @param {{minSamples: number, tailRatio: number, minTailMs: number, retryRun: number}} thresholds
 */
function buildAnalysis(view: any, thresholds: any): any {
  const scopes = scopesOf(view);
  const latency: any[] = [];
  const detectors = [latencyHotspots(scopes, thresholds, latency), redundantVerification(scopes), retryLoops(scopes, thresholds)];
  const undetermined = detectors.filter((d) => d.status === NOT_DETERMINED).length;
  let verdict: string;
  if (detectors.some((d) => d.status === FINDING)) verdict = 'findings';
  else if (undetermined === detectors.length) verdict = 'insufficient-data';
  else if (undetermined) verdict = 'no-findings-in-the-analyses-that-could-run';
  else verdict = 'no-findings';
  return {
    v: 1, view: 'analyze', thresholds: { ...thresholds }, scopes: scopes.length, verdict, detectors,
    latency: latency.sort((a, b) => cmp(a.scope, b.scope) || cmp(a.kind, b.kind) || cmp(a.name ?? '', b.name ?? '')),
    context: contextOf(scopes),
  };
}

const findingsOf = (analysis: any): any[] => analysis.detectors.flatMap((d: any) => d.findings);

// ── batches (IC-004, IC-005) ────────────────────────────────────────────────────────────────────

/**
 * One `runtime-observation` item per finding. The command names only the flags that change the
 * view, never the project argument; the content holds `finding <id>` once.
 */
function buildEvidenceBatch(analysis: any, { run = null, global = false }: any = {}): any[] {
  const command = ['doflow trace analyze --json', run ? `--run ${run}` : null, global ? '-g' : null].filter(Boolean).join(' ');
  return findingsOf(analysis).map((f: any) => ({
    kind: 'runtime-observation',
    provenance: 'extracted',
    source: { provider: 'doflow', capability: 'trace.analyze' },
    observation: { command, exitCode: 1 },
    content: [`trace-analyze finding ${f.id}`, `detector=${f.detector}`,
      // An ungrouped scope already reads `<kind>:<id>`; a trace scope gains its `trace:` prefix.
      `scope=${f.scopeKind === 'trace' ? `trace:${f.scope}` : f.scope}`,
      `spans=${f.spans.map((s: any) => s.spanId).join(',')}`,
      ...Object.keys(f.measures).sort().map((k) => `${k}=${f.measures[k] ?? '-'}`)].join(' '),
  }));
}

/** The statement's metric: a fixed prefix, the variable name part and the value. */
function metricOf(f: any): { prefix: string; name: string; value: number } {
  const m = f.measures;
  if (f.detector === 'latency-hotspots') return { prefix: `p95_ms:${m.kind}/`, name: m.name ?? '-', value: m.p95Ms };
  if (f.detector === 'redundant-verification') return { prefix: 'passes:', name: m.tier ?? '-', value: m.passes };
  return { prefix: 'failed_runs:', name: m.task ?? f.scopeKind, value: m.runs };
}

/** Ledger items whose content names the finding, newest first, at most two. */
function citedIds(f: any, items: any[] | null): string[] {
  if (!Array.isArray(items)) return [];
  const needle = `finding ${f.id}`;
  return items.filter((it) => it && typeof it.id === 'string' && EVIDENCE_ID.test(it.id) && typeof it.content === 'string' && it.content.includes(needle))
    .sort((a, b) => cmp(b.freshness?.observedAt ?? '', a.freshness?.observedAt ?? '') || cmp(b.id, a.id))
    .slice(0, 2).map((it) => it.id);
}

/**
 * The IC-005 statement. Over 280 characters, the second evidence id goes, then the name part is
 * truncated until the line fits and carries no 32-character run; a name the masker would change
 * (a key word such as `token`, an address) is replaced by `h<first 8 hex of its sha256>`.
 */
function statementFor(f: any, ids: string[]): string {
  const { prefix, name, value } = metricOf(f);
  const line = (part: string, cite: string[]) => {
    const metric = `${prefix}${part}`;
    return `trace-analyze ${f.detector} ${f.id}: metric ${metric}=${value}; baseline span set finding ${f.id}; `
      + `evidence ${cite.length ? cite.join(',') : 'unrecorded'}; verify: re-run trace analyze on a later window and compare ${metric}`;
  };
  const masked = (s: string) => maskLine(s).text !== s;
  const digest = `h${sha16(name).slice(0, 8)}`;
  let cite = ids;
  if (cite.length > 1 && line(name, cite).length > STATEMENT_MAX) cite = cite.slice(0, 1);
  const part = masked(line(name, cite)) ? digest : name;
  for (let len = part.length; len > 0; len -= 1) {
    const text = line(part.slice(0, len), cite);
    if (text.length <= STATEMENT_MAX && !LONG_RUN.test(text) && !masked(text)) return text;
  }
  return line(digest, cite);
}

/**
 * One proposal per finding for `followup --action add --batch <file>`.
 * @param {Object} analysis
 * @param {Object[]|null} ledgerItems the `--task-id` ledger's items, or null without `--task-id`
 */
function buildProposalBatch(analysis: any, ledgerItems: any[] | null): any[] {
  return findingsOf(analysis).map((f: any) => ({ statement: statementFor(f, citedIds(f, ledgerItems)), stage: 'maintain', source: { kind: 'manual' } }));
}

// ── the verb (IC-001) ───────────────────────────────────────────────────────────────────────────

function printAnalysis(analysis: any): void {
  console.log(`verdict ${analysis.verdict} scopes ${analysis.scopes}`);
  for (const d of analysis.detectors) console.log(`${d.id} ${d.status} findings ${d.findings.length}`);
  for (const f of findingsOf(analysis)) {
    const { prefix, name, value } = metricOf(f);
    console.log(`${f.detector} ${f.id} ${f.scopeKind} ${prefix}${name}=${value}`);
  }
  const c = analysis.context;
  if (c.status !== 'MEASURED') {
    console.log(`context ${c.status} (no hook line carries emit_reason)`);
    return;
  }
  const total = (key: string) => sum(c.sessions.map((s: any) => s[key]));
  console.log(`context MEASURED sessions ${c.sessions.length} hook-calls ${total('hookCalls')} emissions ${total('emissions')}`
    + ` emitted-bytes ${total('emittedBytes')} duplicates ${total('duplicates')} duplicate-bytes ${total('duplicateBytes')}`);
}

/**
 * `doflow trace analyze [--run <key|id>] [--json] [--emit evidence|followups] [--task-id <id>] [-g] [<project>]`.
 * Exit 0 no finding, 1 findings, 2 usage. Writes nothing.
 * @param {Object} options
 * @param {string[]} [options.positional] the arguments after `analyze`: at most the project root
 * @param {string} [options.stateRoot] where `--task-id`'s evidence ledger is read (the evidence verb's store root)
 * @param {Object} [options.analysis] the `analysis` block, instead of the registry's
 */
function handleTraceAnalyze({ positional = [], run, json = false, global = false, emit, taskId, env = process.env, fsImpl = nodeFs, stateRoot, analysis: block }: any = {}): number {
  const asJson = json || (emit !== undefined && emit !== null);
  const usage = (detail: string) => {
    if (asJson) console.log(JSON.stringify({ error: 'usage', detail }));
    else console.error(`doflow trace analyze: ${detail}`);
    return finish(2);
  };
  if (positional.length > 1) return usage('usage: trace analyze [--run <runKey|run>] [--json] [--emit evidence|followups] [--task-id <id>] [-g] [<project>]');
  if (run !== undefined && run !== null && (typeof run !== 'string' || !RUN_ARG.test(run))) return usage('--run expects a run key (<hash>/<run>/<lineage>) or a run id');
  if (emit !== undefined && emit !== null && !EMIT.has(emit)) return usage('--emit expects evidence or followups');
  if (taskId !== undefined && taskId !== null && emit !== 'followups') return usage('--task-id needs --emit followups');
  const th = block === undefined ? readThresholds() : checkThresholds(block);
  if (th.error) return usage(th.error);
  const projectRoot = global ? undefined : path.resolve(positional[0] || '.');

  let ledgerItems: any[] | null = null;
  if (emit === 'followups' && taskId !== undefined && taskId !== null) {
    try {
      const { EvidenceLedger } = require('../evidence-ledger.ts');
      const ledger = new EvidenceLedger({ repoRoot: stateRoot || projectRoot || process.cwd() });
      ledger.load(taskId);
      ledgerItems = ledger.queryEvidence({ taskId });
    } catch {
      return usage('cannot read the evidence ledger of --task-id (expected letters, digits, dot, dash or underscore)');
    }
  }

  const analysis = buildAnalysis(projectSpans({ projectRoot, run: run ?? null, global, env, fsImpl }), th.thresholds);
  if (emit === 'evidence') console.log(JSON.stringify(sorted(buildEvidenceBatch(analysis, { run, global })), null, 2));
  else if (emit === 'followups') console.log(JSON.stringify(sorted(buildProposalBatch(analysis, ledgerItems)), null, 2));
  else if (json) console.log(JSON.stringify(sorted(analysis), null, 2));
  else printAnalysis(analysis);
  return finish(findingsOf(analysis).length ? 1 : 0);
}

module.exports = { buildAnalysis, buildEvidenceBatch, buildProposalBatch, printAnalysis, readThresholds, checkThresholds, handleTraceAnalyze };
