'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Handoff and result envelopes (feature 082, IC-010, IC-011, IC-012).
 *
 *   - `buildHandoff` and `buildResult` are pure: every list arrives as input, so no git call, file
 *     read or environment read happens here (DEC-005). Neither envelope carries a transcript, an
 *     environment value or a verification argv (NFR-006).
 *   - `undeclared` is the changed paths, rename and copy sources included, outside the task's
 *     `files:` after trimming and dropping a leading `./` (DEC-033). The normalization is this
 *     module's own copy of `task-graph.ts`'s private `normalizeFile`, so that 080 file stays
 *     byte-identical (DEC-059).
 *   - `writeEnvelope` writes canonical JSON (keys sorted, no whitespace), so the file's byte size is
 *     the bound it checks: 16384 for a handoff, 32768 for a result (DEC-027). Over the bound, lists
 *     are cut in IC-012's fixed order, each to the longest prefix that fits, the tail going to a
 *     sidecar named by an `overflow` entry; then `task.text` or `summary` is cut on a UTF-8
 *     boundary. Every write is a temporary file in the same directory, then a rename.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { maskLine } = require('../mask.ts');

const ENVELOPE_DIR = 'dispatch-envelopes';
const BOUNDS: Record<string, number> = { handoff: 16384, result: 32768 };
/** IC-012: the cut order, each list cut to its longest fitting prefix before the next is touched. */
const CUT_ORDER: Record<string, string[]> = {
  handoff: ['sources', 'deltas.changes', 'acceptance'],
  result: ['changes', 'undeclared', 'evidence', 'blockers'],
};
const TEXT_BYTES = 2000;
const CUT_MARK = '[cut]';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/;

/** IC-010: the fixed loop rules every handoff begins with, in this order. */
const FIXED_CONSTRAINTS = [
  'edit only inside worktree.path',
  'leave worktree.branch checked out',
  'do not push, fetch or change git config',
  'write nothing outside the worktree',
  'spawn children only through dispatch --action spawn within grant',
];

/** IC-012: JSON with object keys sorted at every level and no whitespace; 080's `canonicalJson`
 * (`task-run.ts`, not exported), copied. */
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** DEC-059: a `files:` entry compared after trimming and dropping a leading `./` (copy of
 * `task-graph.ts`'s module-private `normalizeFile`). */
function normalizeFile(file: string) {
  return String(file).trim().replace(/^(\.\/)+/, '');
}

/** The longest prefix of `text` that is at most `maxBytes` UTF-8 bytes and ends on a character. */
function cutUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(String(text), 'utf8');
  if (buf.length <= maxBytes) return String(text);
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

function bytesOf(value: any): number {
  return Buffer.byteLength(canonical(value), 'utf8');
}

/** IC-010: the repository-relative artifact whose index carries an acceptance id. */
function acceptanceSource(slug: string, id: string): string {
  const base = `agent-docs/doflow/${slug}`;
  return /^IC-/.test(id) ? `${base}/design/specs.md` : `${base}/intention/requirement.md`;
}

/** IC-010. `input.acceptance` is the task's acceptance ids; every other list is taken as given. */
function buildHandoff(input: any) {
  const task = input.task || {};
  const files = Array.isArray(task.files) ? task.files.map(String) : [];
  const writeSet = files.length ? `files: ${files.join(', ')}` : 'files: none declared';
  return {
    schema: 'doflow-handoff-v1',
    dispatchId: input.dispatchId,
    dispatchRunId: input.dispatchRunId,
    slug: input.slug,
    mode: input.mode,
    task: {
      id: task.id,
      phase: task.phase,
      owner: task.owner == null ? null : task.owner,
      text: cutUtf8(maskLine(task.text == null ? '' : task.text).text, TEXT_BYTES),
      files,
      dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : [],
    },
    constraints: [...FIXED_CONSTRAINTS, writeSet],
    acceptance: (input.acceptance || []).map((id: string) => ({ id: String(id), source: acceptanceSource(input.slug, String(id)) })),
    sources: (input.sources || []).map((s: any) => ({ path: s.path, sha256: s.sha256 == null ? null : s.sha256 })),
    deltas: {
      runBase: input.deltas && input.deltas.runBase,
      attemptBase: input.deltas && input.deltas.attemptBase,
      changes: ((input.deltas && input.deltas.changes) || []).map((c: any) => ({
        path: c.path, change: c.change, dispatchId: c.dispatchId == null ? null : c.dispatchId,
      })),
    },
    budget: {
      reserveTokens: input.budget && input.budget.reserveTokens != null ? input.budget.reserveTokens : null,
      attemptSeconds: input.budget && input.budget.attemptSeconds != null ? input.budget.attemptSeconds : null,
      attempts: { used: input.budget.attempts.used, limit: input.budget.attempts.limit },
    },
    grant: input.grant ? { depth: input.grant.depth, children: input.grant.children, tokens: input.grant.tokens } : null,
    worktree: { path: input.worktree.path, branch: input.worktree.branch, base: input.worktree.base },
    report: {
      parser: input.report && input.report.parser ? input.report.parser : null,
      spawn: input.report && Array.isArray(input.report.spawn) ? input.report.spawn.map(String) : null,
    },
    overflow: [],
  };
}

/** IC-011: changed paths, rename and copy sources included, outside the task's normalized files. */
function undeclaredChanges(changes: any[], files: any[]): string[] {
  const declared = new Set((files || []).map(normalizeFile).filter(Boolean));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    for (const p of [change.from, change.path]) {
      if (p == null) continue;
      const file = normalizeFile(p);
      if (!file || declared.has(file) || seen.has(file)) continue;
      seen.add(file);
      out.push(file);
    }
  }
  return out;
}

/** IC-011. `input.files` is the task's declared `files:`; `changes` come from git, computed by the
 * caller over the attempt commit. `summary` arrives masked and is cut to 2000 bytes here. */
function buildResult(input: any) {
  const changes = (input.changes || []).map((c: any) => ({ path: c.path, change: c.change, from: c.from == null ? null : c.from }));
  return {
    schema: 'doflow-result-v1',
    dispatchId: input.dispatchId,
    task: input.task,
    token: input.token,
    epoch: input.epoch,
    mode: input.mode,
    outcome: input.outcome,
    staleReason: input.staleReason == null ? null : input.staleReason,
    failureClass: input.failureClass == null ? null : input.failureClass,
    summary: cutUtf8(input.summary == null ? '' : String(input.summary), TEXT_BYTES),
    status: input.status,
    base: input.base,
    commit: input.commit == null ? null : input.commit,
    changes,
    undeclared: undeclaredChanges(changes, input.files),
    evidence: (input.evidence || []).map((e: any) => ({ id: e.id, kind: 'test-result', exitCode: e.exitCode == null ? null : e.exitCode })),
    blockers: (input.blockers || []).map(String),
    usage: { tokens: input.usage.tokens, basis: input.usage.basis, source: input.usage.source },
    workerRun: input.workerRun
      ? { id: input.workerRun.id, output: input.workerRun.output ? { stdout: input.workerRun.output.stdout, stderr: input.workerRun.output.stderr } : null }
      : null,
    isolation: input.isolation ? { status: input.isolation.status, reasons: (input.isolation.reasons || []).map(String) } : null,
    overflow: [],
  };
}

function getList(value: any, list: string): any[] {
  return list.split('.').reduce((node: any, key: string) => node[key], value);
}

function setList(value: any, list: string, items: any[]) {
  const keys = list.split('.');
  const last = keys.pop() as string;
  keys.reduce((node: any, key: string) => node[key], value)[last] = items;
}

/** Writes `text` to `file` through a temporary file in the same directory, then a rename. */
function writeAtomic(file: string, text: string) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* the original error is the one reported */ }
    throw err;
  }
}

/**
 * IC-012. Writes `value` (a built envelope) to `<stateRoot>/dispatch-envelopes/<dispatchId>.<kind>.json`
 * in canonical form within its bound, sidecars first. Returns `{ path, pointer, bytes, overflow,
 * sidecars }`; `pointer` and each sidecar pointer are relative to `stateRoot`.
 */
function writeEnvelope({ stateRoot, dispatchId, kind, value }: { stateRoot: string, dispatchId: string, kind: string, value: any }) {
  if (!(kind in BOUNDS)) throw new TypeError(`unknown envelope kind '${kind}'`);
  if (typeof dispatchId !== 'string' || !SAFE_ID.test(dispatchId)) throw new TypeError(`invalid dispatch id '${dispatchId}'`);
  const bound = BOUNDS[kind];
  const envelope = JSON.parse(canonical(value));
  if (!Array.isArray(envelope.overflow)) envelope.overflow = [];
  const sidecars: Array<{ list: string, pointer: string, items: any[] }> = [];

  for (const list of CUT_ORDER[kind]) {
    if (bytesOf(envelope) <= bound) break;
    const items = getList(envelope, list);
    if (!items.length) continue;
    const pointer = `${ENVELOPE_DIR}/${dispatchId}.${list.replace(/\./g, '-')}.json`;
    const entry = { list, pointer, total: items.length, kept: 0 };
    envelope.overflow.push(entry);
    const fits = (k: number) => {
      setList(envelope, list, items.slice(0, k));
      entry.kept = k;
      return bytesOf(envelope) <= bound;
    };
    // Longest fitting prefix: size grows with the prefix length, so a binary search finds it.
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid; else hi = mid - 1;
    }
    fits(lo);
    sidecars.push({ list, pointer, items: items.slice(lo) });
  }

  if (bytesOf(envelope) > bound) {
    const holder = kind === 'handoff' ? envelope.task : envelope;
    const field = kind === 'handoff' ? 'text' : 'summary';
    const mark = kind === 'result' ? CUT_MARK : '';
    const original = String(holder[field]);
    const fits = (n: number) => {
      holder[field] = cutUtf8(original, n) + mark;
      return bytesOf(envelope) <= bound;
    };
    let lo = 0;
    let hi = Buffer.byteLength(original, 'utf8');
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid; else hi = mid - 1;
    }
    if (!fits(lo)) throw new Error(`${kind} envelope for ${dispatchId} exceeds ${bound} bytes with every list and its text cut`);
  }

  const dir = path.join(stateRoot, ENVELOPE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const sidecar of sidecars) writeAtomic(path.join(stateRoot, sidecar.pointer), canonical(sidecar.items));
  const text = canonical(envelope);
  const file = path.join(dir, `${dispatchId}.${kind}.json`);
  writeAtomic(file, text);
  return {
    path: file,
    pointer: `${ENVELOPE_DIR}/${dispatchId}.${kind}.json`,
    bytes: Buffer.byteLength(text, 'utf8'),
    overflow: envelope.overflow,
    sidecars: sidecars.map((s) => s.pointer),
  };
}

module.exports = {
  ENVELOPE_DIR,
  BOUNDS,
  CUT_ORDER,
  FIXED_CONSTRAINTS,
  canonical,
  normalizeFile,
  cutUtf8,
  buildHandoff,
  buildResult,
  writeEnvelope,
};
