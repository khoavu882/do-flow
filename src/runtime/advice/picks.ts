'use strict';

// Feature 151 A.3 (IC-001, IC-002; FR-015, FR-016, FR-025, NFR-001, NFR-002): the read-only
// `advice-picks` verb.
//
//   doflow advice-picks [--kind <id>] [--json]
//
// Picks per UTC day over the report's 90-day window, each day `read` or `unknown`, and the newest
// `PICKS_LIMIT` picks with the closed fields only. The record roots are resolved as `advise` resolves
// them (`loadRuntime`, src/runtime/advice/cli.ts:31 to :39: `resolveRoots` over the storage registry
// with the project root), replicated here so that neither `advice/cli.ts`, `advice/client.ts` nor any
// settings writer is loaded (DEC-026). `advicePicksBody` returns `{exit, json}` and prints nothing;
// `handleAdvicePicksCommand` prints it as one compact JSON line, with or without `--json`.
//
// Each raw `pick`, `static` and outcome `actual` is masked whole with `maskBody` and then kept only
// when it matches `ANSWER`, else `(withheld)` (D12). The body is built field by field, so no
// question, instruction, option, probability, prompt, provider, task id or other record field reaches
// it, and every string leaf passes `maskJson` once more. Read-only: partition files are only read;
// no lock, network connection, model call, telemetry, upkeep or write.

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { loadAdviceRegistry } = require('./registry.ts');
const { loadStorageRegistry } = require('../storage/registry.ts');
const { resolveRoots } = require('../storage/roots.ts');
const { readWindow } = require('./record.ts');
const { maskBody, printSafe } = require('../mask.ts');
const { maskJson } = require('../events/envelope.ts');
const { finishRuntime } = require('../cli-result.ts');

/** The report's window (src/runtime/advice/report.ts:15); not exported there, so restated and tested equal. */
const MAX_AGE_DAYS = 90;
/** IC-001 (D4): the most picks listed; the rest of the window's are counted in `limits.notShown`. */
const PICKS_LIMIT = 50;
/** IC-001: the most kinds listed; records of a kind past it are counted in `limits.skipped`. */
const PICK_KINDS_LIMIT = 32;
/** IC-001 (D12): an answer shown as it is; any other string is `(withheld)`. */
const ANSWER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const WITHHELD = '(withheld)';
const KIND = /^[a-z][a-z0-9-]{0,31}$/;
/** `PICK_ID`, src/runtime/advice/record.ts:115. */
const PICK_ID = /^adv-[0-9]{13}-[0-9a-f]{6}$/;
const ISO_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/;
const TYPES = new Set(['pick', 'miss', 'outcome']);
const STORES = Object.freeze(['project-state', 'user-state'] as const);
const FLAGS = new Set(['--kind', '--json']);
const DAY_MS = 24 * 60 * 60 * 1000;
/** Longest part of untrusted text echoed back in a stderr line. */
const ECHO_CHARS = 80;

type Env = Record<string, string | undefined>;
interface Writable { write(text: string): any }
interface PicksOptions {
  /** The `--kind` value: a registry kind id or `adhoc`; absent, every kind. */
  kind?: unknown;
  json?: boolean;
  /** Every flag as typed (`flagsGiven`); an in-process caller may leave it empty. */
  flags?: readonly string[];
  positional?: readonly string[];
  /** The environment the record roots are resolved from (`HOME`, `XDG_CONFIG_HOME`); default `process.env`. */
  env?: Env;
  /** The project root; default `process.cwd()`. */
  cwd?: string;
  /** The clock: a function returning a time, or a time; default now. */
  now?: unknown;
  /** The file system the registries and records are read through, for tests. */
  fsImpl?: any;
  stdout?: Writable;
  stderr?: Writable;
}
type Answer = { exit: number; json: any; message: string | null };

const failure = (error: string, message: string): Answer => ({ exit: 2, json: { v: 1, ok: false, error }, message });
const usage = (message: string) => failure('usage', message);
const given = (value: unknown) => value !== undefined && value !== null;
const isTime = (value: unknown): value is string => typeof value === 'string' && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value));

/** One line of untrusted text made safe to print: no control characters, bounded. */
function shown(text: unknown): string {
  const safe = String(printSafe(String(text))).replace(/[\r\n]+/g, ' ');
  return safe.length > ECHO_CHARS ? `${safe.slice(0, ECHO_CHARS)}...` : safe;
}

/** The first problem with the flags, positionals and `--kind` value as given, or null. */
function flagProblem(flags: readonly string[], positional: readonly string[], kind: unknown): string | null {
  const seen = new Set<string>();
  for (const raw of flags) {
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw : raw.slice(0, eq);
    if (!FLAGS.has(name)) return `unknown flag '${shown(raw)}'; only --kind, --json apply`;
    if (name === '--json' && eq !== -1) return '--json takes no value';
    if (seen.has(name)) return `${name} is given more than once`;
    seen.add(name);
  }
  if (positional.length > 0) return `takes no positional argument, got '${shown(positional[0])}'`;
  if (seen.has('--kind') && !given(kind)) return '--kind requires a kind id';
  if (given(kind) && (typeof kind !== 'string' || kind === '')) return '--kind requires a kind id';
  return null;
}

/** D12: masked whole, then shown only when it is a label; any other value is withheld. */
function answerOf(value: unknown): string {
  if (typeof value !== 'string') return WITHHELD;
  const masked: string = maskBody(value).text;
  return ANSWER.test(masked) ? masked : WITHHELD;
}

const staticOf = (value: unknown): string | null => (typeof value === 'string' ? answerOf(value) : null);

/** Agreement between two shown answers; null when either is missing or withheld. */
function agreeOf(a: string | null, b: string | null): boolean | null {
  if (a === null || b === null || a === WITHHELD || b === WITHHELD) return null;
  return a === b;
}

/** The registry's kind ids and the record roots, or null when a registry cannot be loaded. */
function loadSources(options: PicksOptions, fsImpl: any): { ids: string[]; roots: Record<string, string | null> } | null {
  try {
    const advice = loadAdviceRegistry({ repoRoot: REPO_ROOT, fsImpl });
    const kinds = advice.ok ? advice.registry?.kinds : null;
    if (!Array.isArray(kinds) || !kinds.every((entry: any) => typeof entry?.id === 'string' && KIND.test(entry.id))) return null;
    const storage = loadStorageRegistry({ repoRoot: REPO_ROOT, fsImpl });
    const projectRoot = path.resolve(options.cwd ?? process.cwd());
    const roots = resolveRoots({ registry: storage, projectRoot, global: false, env: options.env ?? process.env });
    return { ids: kinds.map((entry: any) => entry.id), roots };
  } catch {
    return null;
  }
}

/** Every UTC date from `from` to `to` inclusive, oldest first. */
function datesOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let at = Date.parse(`${from}T00:00:00.000Z`); ; at += DAY_MS) {
    const day = new Date(at).toISOString().slice(0, 10);
    if (day > to) return out;
    out.push(day);
  }
}

function compute(options: PicksOptions): Answer {
  const problem = flagProblem(options.flags ?? [], options.positional ?? [], options.kind);
  if (problem) return usage(problem);
  const now = options.now === undefined ? new Date() : typeof options.now === 'function' ? options.now() : options.now;
  const at = new Date(now as any);
  if (Number.isNaN(at.getTime())) return usage('the clock gives no valid time');
  const fsImpl = options.fsImpl ?? fs;
  const sources = loadSources(options, fsImpl);
  if (!sources) return failure('registry-invalid', 'the advice or storage registry cannot be loaded');
  const { ids, roots } = sources;
  const kind = given(options.kind) ? options.kind as string : null;
  if (kind !== null && !ids.includes(kind) && kind !== 'adhoc') {
    return usage(`unknown --kind '${shown(kind)}'; known kinds: ${[...ids, 'adhoc'].join(', ')}`);
  }

  const from = new Date(at.getTime() - MAX_AGE_DAYS * DAY_MS).toISOString().slice(0, 10);
  const to = at.toISOString().slice(0, 10);
  const window = readWindow({ roots, now: () => at, maxAgeDays: MAX_AGE_DAYS, fsImpl });

  // First pass: drop records with no usable type, kind or at; keep the latest outcome per pickId (the
  // report's rule, src/runtime/advice/report.ts:227 to :230); note the kinds seen, in read order. A
  // partition dated after `to` is outside the window and ignored whole.
  let skipped = 0;
  const outcomes = new Map<string, { at: string; actual: string }>();
  const usable: Array<{ record: any; day: string }> = [];
  const seen: string[] = [];
  for (const { record, day } of window.records) {
    if (day > to) continue;
    if (!TYPES.has(record.type) || !isTime(record.at)) { skipped += 1; continue; }
    if (record.type === 'outcome') {
      if (typeof record.pickId === 'string' && typeof record.actual === 'string') {
        const prior = outcomes.get(record.pickId);
        if (!prior || Date.parse(record.at) >= Date.parse(prior.at)) outcomes.set(record.pickId, { at: record.at, actual: record.actual });
      }
      continue;
    }
    if (typeof record.kind !== 'string' || !KIND.test(record.kind)) { skipped += 1; continue; }
    if (!ids.includes(record.kind) && !seen.includes(record.kind)) seen.push(record.kind);
    usable.push({ record, day });
  }
  const kinds = kind !== null ? [kind] : [...ids, ...seen].slice(0, PICK_KINDS_LIMIT);
  const listed = new Set(kinds);

  // Second pass: the picks of the kinds listed, counted per partition date. Without `--kind`, a
  // record of a kind past `PICK_KINDS_LIMIT` is counted in `skipped`.
  const counts = new Map<string, Map<string, number>>();
  const candidates: any[] = [];
  for (const { record, day } of usable) {
    if (!listed.has(record.kind)) { if (kind === null) skipped += 1; continue; }
    if (record.type !== 'pick') continue;
    if (!counts.has(day)) counts.set(day, new Map());
    const perKind = counts.get(day)!;
    perKind.set(record.kind, (perKind.get(record.kind) ?? 0) + 1);
    candidates.push(record);
  }

  const anyUnreadable = STORES.some((store) => window.stores[store] === 'unreadable');
  const partitionsBy = new Map<string, Array<{ read: boolean; unreadableLines: number }>>();
  for (const partition of window.partitions) {
    if (!partitionsBy.has(partition.day)) partitionsBy.set(partition.day, []);
    partitionsBy.get(partition.day)!.push(partition);
  }
  const days = datesOf(from, to).map((day) => {
    const partitions = partitionsBy.get(day) ?? [];
    const perKind = counts.get(day);
    const picks: Record<string, number> = {};
    for (const id of kinds) if (perKind?.get(id)) picks[id] = perKind.get(id)!;
    return {
      day,
      coverage: !anyUnreadable && partitions.every((p) => p.read) ? 'read' : 'unknown',
      unreadableLines: partitions.reduce((sum, p) => sum + p.unreadableLines, 0),
      picks,
    };
  });

  const idOf = (record: any): string | null => (typeof record.pickId === 'string' && PICK_ID.test(record.pickId) ? record.pickId : null);
  candidates.sort((a, b) => {
    const byTime = Date.parse(b.at) - Date.parse(a.at);
    if (byTime !== 0) return byTime;
    const ia = idOf(a) ?? '';
    const ib = idOf(b) ?? '';
    return ib < ia ? -1 : ib > ia ? 1 : 0;
  });
  const picks = candidates.slice(0, PICKS_LIMIT).map((record) => {
    const pick = answerOf(record.pick);
    const statik = staticOf(record.static);
    const found = typeof record.pickId === 'string' ? outcomes.get(record.pickId) : undefined;
    let outcome: { actual: string; at: string; agree: boolean | null } | null = null;
    if (found) {
      const actual = answerOf(found.actual);
      outcome = { actual, at: found.at, agree: agreeOf(actual, pick) };
    }
    return {
      pickId: idOf(record),
      kind: record.kind as string,
      at: record.at as string,
      mode: record.mode === 'shadow' || record.mode === 'act' ? record.mode as string : 'unrecorded',
      pick,
      static: statik,
      agree: agreeOf(pick, statik),
      outcome,
    };
  });

  const body = {
    v: 1,
    window: { from, to, maxAgeDays: MAX_AGE_DAYS },
    kind,
    kinds,
    stores: { 'project-state': window.stores['project-state'], 'user-state': window.stores['user-state'] },
    days,
    picks,
    limits: { shown: picks.length, notShown: candidates.length - picks.length, skipped },
  };
  return { exit: 0, json: maskJson(body), message: null };
}

/**
 * IC-001: the picks body for the options given. Prints nothing. Returns `{exit: 0, json: body}`, or
 * `{exit: 2, json: {v: 1, ok: false, error: 'usage' | 'registry-invalid'}}`.
 */
function advicePicksBody(options: PicksOptions = {}): { exit: number; json: any } {
  const { exit, json } = compute(options);
  return { exit, json };
}

/**
 * `doflow advice-picks` (IC-001): one compact JSON line on stdout, with or without `--json`; a
 * failure also prints one `doflow advice-picks: <reason>` line on stderr. Returns and sets the exit
 * code: 0, or 2 `usage` or `registry-invalid`.
 */
function handleAdvicePicksCommand(options: PicksOptions = {}): number {
  const answer = compute(options);
  const stdout: Writable = options.stdout ?? process.stdout;
  const stderr: Writable = options.stderr ?? process.stderr;
  const safe = (w: Writable, text: string) => { try { w.write(text); } catch { /* the stream is gone: the exit code still says it */ } };
  safe(stdout, `${JSON.stringify(answer.json)}\n`);
  if (answer.message) safe(stderr, `doflow advice-picks: ${answer.message}\n`);
  return finishRuntime(answer.exit);
}

module.exports = {
  handleAdvicePicksCommand, advicePicksBody,
  MAX_AGE_DAYS, PICKS_LIMIT, PICK_KINDS_LIMIT, ANSWER,
};
