'use strict';

// `doflow advise --action report` (141 IC-008, common figures). Read-only: no model call, no write. The records hold no
// user text (only digests, picks and counts), so nothing user-written reaches the output. Every figure carries its n.
// Lines written before the dispatcher existed lack `mode` and `elevated`; they stay readable and count as `unrecorded`.

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { readWindow } = require('./record.ts');
const { evaluateBenchBar } = require('./bench-gate.ts');

const SCHEMA = 1;
const MAX_AGE_DAYS = 90;
const SCOPE = 'this project only';
const FOOTER = 'Records are from this project only; every figure shows its n.';
const VERDICTS_FILE = 'core/registry/advice-verdicts.json';
const DAY_MS = 24 * 60 * 60 * 1000;

function isObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Nearest-rank percentile over a sorted ascending array; null when empty. */
function nearestRank(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function summarize(values: number[]): { n: number; p50: number | null; p90: number | null; p95: number | null } {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  return { n: sorted.length, p50: nearestRank(sorted, 0.5), p90: nearestRank(sorted, 0.9), p95: nearestRank(sorted, 0.95) };
}

function kindFigures(picks: any[], misses: any[], outcomes: Map<string, any>): any {
  if (picks.length === 0 && misses.length === 0) {
    return { n: { picks: 0, misses: 0 }, missesByReason: {}, agreeStatic: null, agreeOutcome: null, elevated: null, modes: null, durationMs: null, missDurationMs: null };
  }
  const missesByReason: Record<string, number> = {};
  for (const miss of misses) {
    const reason = typeof miss.reason === 'string' && miss.reason ? miss.reason : 'unknown';
    missesByReason[reason] = (missesByReason[reason] || 0) + 1;
  }
  const withStatic = picks.filter((p) => typeof p.static === 'string');
  const withOutcome = picks.filter((p) => typeof p.pickId === 'string' && outcomes.has(p.pickId));
  const modes = { shadow: 0, act: 0, unrecorded: 0 };
  for (const pick of picks) {
    if (pick.mode === 'shadow') modes.shadow += 1;
    else if (pick.mode === 'act') modes.act += 1;
    else modes.unrecorded += 1;
  }
  return {
    n: { picks: picks.length, misses: misses.length },
    missesByReason,
    agreeStatic: { n: withStatic.length, agree: withStatic.filter((p) => p.pick === p.static).length },
    agreeOutcome: { n: withOutcome.length, agree: withOutcome.filter((p) => outcomes.get(p.pickId) === p.pick).length },
    elevated: picks.filter((p) => p.elevated === true).length,
    modes,
    durationMs: summarize(picks.map((p) => p.durationMs)),
    missDurationMs: summarize(misses.map((m) => m.durationMs)),
  };
}

function readVerdicts(repoRoot: string, kinds: Set<string>, evaluate: any): any[] {
  let file: any;
  try { file = JSON.parse(fs.readFileSync(path.join(repoRoot, VERDICTS_FILE), 'utf8')); } catch { return []; }
  if (!isObject(file) || !Array.isArray(file.verdicts)) return [];
  const rows: any[] = [];
  for (const v of file.verdicts) {
    if (!isObject(v) || typeof v.kind !== 'string' || typeof v.model !== 'string' || !kinds.has(v.kind)) continue;
    const arm = typeof v.arm === 'string' ? v.arm : null;
    let judged: any = null;
    try { judged = evaluate(v.kind, v.model, { arm }); } catch { /* an evaluator failure reads as stale below */ }
    const reason = typeof judged?.reason === 'string' ? judged.reason : 'bench verdicts unreadable';
    const stale = !judged || /^(verdict stale|bench verdicts unreadable|verdict inconsistent)/.test(reason);
    rows.push({ kind: v.kind, model: v.model, arm, result: typeof v.result === 'string' ? v.result : null, stale, reason: stale ? reason : null });
  }
  return rows;
}

/**
 * Builds the report object. `kind`, when given, narrows it to one kind. `kinds` lists the kinds to show (registry kinds).
 * Never writes; `evaluate` and `repoRoot` are injectable for tests.
 */
function buildReport({
  roots, kinds, kind = null, now = () => new Date(), fsImpl = fs, evaluate = evaluateBenchBar, repoRoot = REPO_ROOT,
}: any = {}): any {
  const at = new Date(typeof now === 'function' ? now() : now);
  const { records, unreadable } = readWindow({ roots, now: () => at, maxAgeDays: MAX_AGE_DAYS, fsImpl });
  const shown: string[] = kind ? [kind] : [...(kinds || [])];
  const picksBy = new Map<string, any[]>();
  const missesBy = new Map<string, any[]>();
  const outcomes = new Map<string, { at: string; actual: string }>();
  for (const { record } of records) {
    if (typeof record.kind === 'string' && record.type === 'pick') {
      if (!picksBy.has(record.kind)) picksBy.set(record.kind, []);
      picksBy.get(record.kind)!.push(record);
    } else if (typeof record.kind === 'string' && record.type === 'miss') {
      if (!missesBy.has(record.kind)) missesBy.set(record.kind, []);
      missesBy.get(record.kind)!.push(record);
    } else if (record.type === 'outcome' && typeof record.pickId === 'string' && typeof record.actual === 'string') {
      const prior = outcomes.get(record.pickId);
      if (!prior || String(record.at) >= prior.at) outcomes.set(record.pickId, { at: String(record.at), actual: record.actual });
    }
  }
  if (!kind) {
    for (const seen of [...picksBy.keys(), ...missesBy.keys()]) if (!shown.includes(seen)) shown.push(seen);
  }
  const actuals = new Map<string, string>([...outcomes].map(([id, o]) => [id, o.actual]));
  const kindsOut: Record<string, any> = {};
  for (const id of shown) kindsOut[id] = kindFigures(picksBy.get(id) || [], missesBy.get(id) || [], actuals);
  return {
    schema: SCHEMA,
    scope: SCOPE,
    window: { from: new Date(at.getTime() - MAX_AGE_DAYS * DAY_MS).toISOString().slice(0, 10), to: at.toISOString().slice(0, 10), maxAgeDays: MAX_AGE_DAYS },
    unreadable,
    kinds: kindsOut,
    verdicts: readVerdicts(repoRoot, new Set(shown), evaluate),
  };
}

function ratio(part: { n: number; agree: number }): string {
  return part.n === 0 ? 'no data (n=0)' : `${part.agree} of ${part.n} (${Math.round((part.agree / part.n) * 100)}%), n=${part.n}`;
}

function duration(label: string, d: any): string {
  return d.n === 0 ? `  ${label}: no data (n=0)` : `  ${label} (n=${d.n}): p50 ${d.p50}, p90 ${d.p90}, p95 ${d.p95}`;
}

function renderText(report: any): string {
  const lines = [
    `Advice report (${report.scope})`,
    `Window: ${report.window.from} to ${report.window.to} (${report.window.maxAgeDays} days)`,
  ];
  if (report.unreadable > 0) lines.push(`Unreadable lines skipped: ${report.unreadable}`);
  for (const [id, f] of Object.entries<any>(report.kinds)) {
    lines.push('', id);
    if (f.agreeStatic === null) { lines.push('  no data'); continue; }
    const reasons = Object.entries(f.missesByReason).map(([reason, count]) => `${reason} ${count}`).join(', ');
    lines.push(`  picks: ${f.n.picks}; misses: ${f.n.misses}${reasons ? ` (${reasons})` : ''}`);
    lines.push(`  agrees with the static answer: ${ratio(f.agreeStatic)}`);
    lines.push(`  agrees with the recorded outcome: ${ratio(f.agreeOutcome)}`);
    lines.push(`  elevated: ${f.elevated} of ${f.n.picks} picks`);
    lines.push(`  modes (n=${f.n.picks}): shadow ${f.modes.shadow}, act ${f.modes.act}, unrecorded ${f.modes.unrecorded}`);
    lines.push(duration('pick duration ms', f.durationMs));
    lines.push(duration('miss duration ms', f.missDurationMs));
  }
  if (report.verdicts.length > 0) {
    lines.push('', 'Bench verdicts');
    for (const v of report.verdicts) {
      lines.push(`  ${v.kind} ${v.model}${v.arm ? ` (arm ${v.arm})` : ''}: ${v.result ?? 'unknown'}${v.stale ? `, stale: ${v.reason}` : ''}`);
    }
  }
  lines.push('', FOOTER);
  return lines.join('\n');
}

module.exports = { buildReport, renderText, FOOTER };
