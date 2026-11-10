'use strict';

// Feature 151 A.2 (IC-003; FR-018, FR-019, FR-025, FR-027, NFR-001, NFR-002): the read-only
// `worker-matrix` verb.
//
//   doflow worker-matrix [--json]
//
// Every harness of `core/registry/harnesses.json` against every worker and orchestration cell that
// carries a string `status`, with each cell's evidence, verification and reason. The registry is the
// one the DoFlow install ships (`loadRegistry({ repoRoot: REPO_ROOT })`, as `worker --action describe`
// loads it), never a project file. `workerMatrixBody` returns `{exit, json}` and prints nothing;
// `handleWorkerMatrixCommand` prints it as one compact JSON line, with or without `--json`.
//
// Each evidence, verification and reason string is masked whole with `maskBody` and only then cut at
// a UTF-8 character start (D12, the lesson of feature 150 review R-1, where a cut split a home path).
// The body is built field by field: `binary`, `versionArgv`, `argv`, `promptVia`, `parser`,
// `quotaSignals`, `protectedPaths`, `modelChecks`, `retired` and any other registry field never reach
// it. Read-only: no harness binary is run, no probe record or binding is read, no network connection
// is opened and nothing is written.

const { loadRegistry } = require('../../registry/index.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { maskBody, printSafe } = require('../mask.ts');
const { finishRuntime } = require('../cli-result.ts');

/** IC-003: the most cell names one group lists; the rest are counted in `limits.cellsNotShown`. */
const MATRIX_CELLS_PER_GROUP = 32;
/** IC-003: the most evidence entries one cell lists. */
const MATRIX_EVIDENCE_LIMIT = 8;
/** IC-003: the most UTF-8 bytes of one masked evidence entry. */
const MATRIX_EVIDENCE_BYTES = 1024;
/** IC-003: the most UTF-8 bytes of one masked verification text. */
const MATRIX_VERIFICATION_BYTES = 4096;
/** IC-003: the most UTF-8 bytes of one masked reason. */
const MATRIX_REASON_BYTES = 1024;
/** IC-003: harnesses are added while the compact body stays at or under this many bytes. */
const MATRIX_BODY_BYTES = 1048576;

const GROUPS = Object.freeze(['worker', 'orchestration'] as const);
const STATUSES = Object.freeze(['supported', 'unknown', 'unsupported'] as const);
const FLAGS = new Set(['--json']);
const ID = /^[a-z][a-z0-9-]{0,31}$/;
const WORD = /^[a-z][a-z-]{0,31}$/;
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
/** Longest part of untrusted text echoed back in a stderr line. */
const ECHO_CHARS = 80;

type Group = typeof GROUPS[number];
type Env = Record<string, string | undefined>;
interface Writable { write(text: string): any }
interface MatrixOptions {
  json?: boolean;
  /** Every flag as typed (`flagsGiven`); an in-process caller may leave it empty. */
  flags?: readonly string[];
  positional?: readonly string[];
  /** Accepted for the dispatch form; the read takes nothing from it. */
  env?: Env;
  /** Accepted for the dispatch form; the registry is the install's, never the project's. */
  cwd?: string;
  /** A loaded registry, for tests; absent, the install's registry is loaded. */
  registry?: any;
  stdout?: Writable;
  stderr?: Writable;
}
type Answer = { exit: number; json: any; message: string | null };

const failure = (error: string, message: string): Answer => ({ exit: 2, json: { v: 1, ok: false, error }, message });
const registryInvalid = () => failure('registry-invalid', 'the harness registry cannot be loaded');
const plainObject = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCell = (value: any) => plainObject(value) && typeof value.status === 'string';
const matching = (value: any, pattern: RegExp): string | null => (typeof value === 'string' && pattern.test(value) ? value : null);

/** One line of untrusted text made safe to print: no control characters, bounded. */
function shown(text: unknown): string {
  const safe = String(printSafe(String(text))).replace(/[\r\n]+/g, ' ');
  return safe.length > ECHO_CHARS ? `${safe.slice(0, ECHO_CHARS)}...` : safe;
}

/** The first problem with the flags and positionals as typed, or null. */
function flagProblem(flags: readonly string[], positional: readonly string[]): string | null {
  let json = false;
  for (const raw of flags) {
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw : raw.slice(0, eq);
    if (!FLAGS.has(name)) return `unknown flag '${shown(raw)}'; only --json applies`;
    if (eq !== -1) return '--json takes no value';
    if (json) return '--json is given more than once';
    json = true;
  }
  if (positional.length > 0) return `takes no positional argument, got '${shown(positional[0])}'`;
  return null;
}

/**
 * `text` masked whole with `maskBody`, then cut to at most `cap` UTF-8 bytes at a character start.
 * Masking first means a cut can never leave a prefix of a value the mask would have replaced.
 */
function maskThenCut(text: string, cap: number): { text: string; cut: boolean } {
  const masked: string = maskBody(text).text;
  const bytes = Buffer.from(masked, 'utf8');
  if (bytes.length <= cap) return { text: masked, cut: false };
  let end = cap;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), cut: true };
}

/** The names of one group: keys whose value has a string `status`, the union over harnesses in order. */
function groupNames(harnesses: any[], group: Group): { names: string[]; notShown: number } {
  const seen = new Set<string>();
  const all: string[] = [];
  for (const harness of harnesses) {
    const block = harness[group];
    if (!plainObject(block)) continue;
    for (const key of Object.keys(block)) {
      if (!seen.has(key) && isCell(block[key])) { seen.add(key); all.push(key); }
    }
  }
  return { names: all.slice(0, MATRIX_CELLS_PER_GROUP), notShown: Math.max(0, all.length - MATRIX_CELLS_PER_GROUP) };
}

/** The not-declared fill, the `describe` precedent (src/runtime/worker/readiness.ts:626 to :628). */
const notDeclared = () => ({
  status: 'unknown', declared: false, evidence: [], verification: null, verifiedOn: null, reason: 'not-declared', fallback: null, cut: false,
});

/** One cell, built field by field from the recorded entry. */
function cellOf(entry: any) {
  if (!isCell(entry)) return notDeclared();
  let cut = false;
  const recorded = Array.isArray(entry.evidence) ? entry.evidence.filter((item: any) => typeof item === 'string') : [];
  if (recorded.length > MATRIX_EVIDENCE_LIMIT) cut = true;
  const evidence = recorded.slice(0, MATRIX_EVIDENCE_LIMIT).map((item: string) => {
    const piece = maskThenCut(item, MATRIX_EVIDENCE_BYTES);
    if (piece.cut) cut = true;
    return piece.text;
  });
  let verification: string | null = null;
  if (typeof entry.verification === 'string') {
    const piece = maskThenCut(entry.verification, MATRIX_VERIFICATION_BYTES);
    if (piece.cut) cut = true;
    verification = piece.text;
  }
  const recognised = (STATUSES as readonly string[]).includes(entry.status);
  let reason: string | null = recognised ? null : 'unrecognised-status';
  if (recognised && typeof entry.reason === 'string') {
    const piece = maskThenCut(entry.reason, MATRIX_REASON_BYTES);
    if (piece.cut) cut = true;
    reason = piece.text;
  }
  return {
    status: recognised ? entry.status : 'unknown',
    declared: true,
    evidence,
    verification,
    verifiedOn: matching(entry.verifiedOn, DAY),
    reason,
    fallback: matching(entry.fallback, WORD),
    cut,
  };
}

/** One harness's row: its id, billing, profile and a cell for every group name. */
function harnessRow(harness: any, groups: Record<Group, string[]>) {
  const worker = plainObject(harness.worker) ? harness.worker : {};
  const cells: any = {};
  for (const group of GROUPS) {
    const block = plainObject(harness[group]) ? harness[group] : {};
    cells[group] = Object.fromEntries(groups[group].map((name) => [name, cellOf(Object.hasOwn(block, name) ? block[name] : undefined)]));
  }
  return { id: harness.id, billing: matching(worker.billing, WORD), profile: matching(worker.profile, ID), cells };
}

/** The whole body for the harness rows shown. */
function bodyOf(version: number | null, groups: Record<Group, string[]>, rows: any[], notShown: number, cellsNotShown: number) {
  const counts: any = {};
  let cut = 0;
  for (const group of GROUPS) {
    const tally: Record<string, number> = { supported: 0, unknown: 0, unsupported: 0 };
    for (const row of rows) {
      for (const name of groups[group]) {
        const cell = row.cells[group][name];
        tally[cell.status] += 1;
        if (cell.cut) cut += 1;
      }
    }
    counts[group] = tally;
  }
  return {
    v: 1,
    registryVersion: version,
    groups: { worker: groups.worker, orchestration: groups.orchestration },
    harnesses: rows,
    counts,
    limits: { shown: rows.length, notShown, cellsNotShown, cut },
  };
}

function compute(registry: any): Answer {
  const harnesses = registry?.harnesses;
  if (!Array.isArray(harnesses) || !harnesses.every((h: any) => plainObject(h) && typeof h.id === 'string' && ID.test(h.id))) return registryInvalid();
  const raw = registry.versions?.harnesses;
  const version = Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  const worker = groupNames(harnesses, 'worker');
  const orchestration = groupNames(harnesses, 'orchestration');
  const groups = { worker: worker.names, orchestration: orchestration.names };
  const cellsNotShown = worker.notShown + orchestration.notShown;
  // Harnesses are added in registry order while the body fits; the first that does not, and every
  // one after it, is counted in `notShown`. A whole stringify per harness: seven today, so the
  // repeated work is a few hundred KiB.
  const rows: any[] = [];
  for (const harness of harnesses) {
    const row = harnessRow(harness, groups);
    const candidate = bodyOf(version, groups, [...rows, row], harnesses.length - rows.length - 1, cellsNotShown);
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MATRIX_BODY_BYTES) break;
    rows.push(row);
  }
  return { exit: 0, json: bodyOf(version, groups, rows, harnesses.length - rows.length, cellsNotShown), message: null };
}

/** The install's registry, or null when it cannot be loaded. */
function installRegistry(): any {
  try {
    return loadRegistry({ repoRoot: REPO_ROOT });
  } catch {
    return null;
  }
}

/**
 * IC-003: the matrix body for `registry` (a loaded registry; absent, the install's). Prints nothing.
 * Returns `{exit: 0, json: body}` or `{exit: 2, json: {v: 1, ok: false, error: 'registry-invalid'}}`.
 */
function workerMatrixBody(registry?: any): { exit: number; json: any } {
  const { exit, json } = compute(registry === undefined ? installRegistry() : registry);
  return { exit, json };
}

/**
 * `doflow worker-matrix` (IC-003): one compact JSON line on stdout, with or without `--json`; a
 * failure also prints one `doflow worker-matrix: <reason>` line on stderr. Returns and sets the exit
 * code: 0, or 2 `usage` (any flag but `--json`, or a positional) or `registry-invalid`.
 */
function handleWorkerMatrixCommand(options: MatrixOptions = {}): number {
  const problem = flagProblem(options.flags ?? [], options.positional ?? []);
  const answer = problem
    ? failure('usage', problem)
    : compute(options.registry === undefined ? installRegistry() : options.registry);
  const stdout: Writable = options.stdout ?? process.stdout;
  const stderr: Writable = options.stderr ?? process.stderr;
  const safe = (w: Writable, text: string) => { try { w.write(text); } catch { /* the stream is gone: the exit code still says it */ } };
  safe(stdout, `${JSON.stringify(answer.json)}\n`);
  if (answer.message) safe(stderr, `doflow worker-matrix: ${answer.message}\n`);
  return finishRuntime(answer.exit);
}

module.exports = {
  handleWorkerMatrixCommand, workerMatrixBody,
  MATRIX_CELLS_PER_GROUP, MATRIX_EVIDENCE_LIMIT, MATRIX_EVIDENCE_BYTES,
  MATRIX_VERIFICATION_BYTES, MATRIX_REASON_BYTES, MATRIX_BODY_BYTES,
};
