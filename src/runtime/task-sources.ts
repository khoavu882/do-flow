'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// Task source records (feature 080, design C5, IC-013): what a task's declared `files:` looked like
// at claim, and how that compares with what they look like at resume.
//
// `measureSources` is a probe: it reads the filesystem, so the caller runs it before the ledger
// lock (claim before `mutate()`, resume before any lock). It starts no process: each file is hashed
// by 076's `sourceVersionFor` with a null tree state, which never runs git. `compareSources` is pure.

const fs = require('node:fs');
const path = require('node:path');
const { sourceVersionFor } = require('./source-version.ts');

/** IC-013: a file larger than this is `unhashable`, `too-large`, and is never read. */
const MAX_HASH_BYTES = 1024 * 1024;
/** IC-013: only the first this-many `files:` entries are measured; more sets `sourcesTruncated`. */
const MAX_SOURCES = 64;

/** IC-013: `*`, `?`, whitespace or `(` anywhere, or a trailing `:<n>` / `:<n>-<n>` line annotation. */
const PATTERN = /[*?\s(]|:\d+(?:-\d+)?$/;

interface SourceRecord {
  file: string;
  kind: 'file' | 'absent' | 'unhashable' | 'unverifiable';
  fileHash: string | null;
  why?: 'directory' | 'link' | 'too-large' | 'read-error' | 'pattern';
}

interface SourceMeasurement {
  sources: SourceRecord[];
  sourcesTruncated: boolean;
  /** The declared entries recorded `unhashable` or `unverifiable`, in `sources` order. */
  sourcesUnverifiable: string[];
  /** The execution worktree did not exist when measured; IC-013 makes the task unverifiable. */
  execWorktreeMissing: boolean;
}

type SourceChange = 'unchanged' | 'changed' | 'created' | 'removed';

type SourceComparison =
  | { unverifiable: true; files: [] }
  | { unverifiable: false; files: Array<{ file: string; change: SourceChange }> };

/** The entry as resolved on disk: trimmed, leading `./` dropped (the IC-016 normalisation). */
function normalizeEntry(file: string): string {
  return String(file).trim().replace(/^(\.\/)+/, '');
}

function exists(dir: string | null | undefined): boolean {
  if (!dir) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** One `lstat` per candidate root, in order; the first root holding the entry wins. */
function locate(entry: string, roots: string[]): { root: string; stat: any } | null {
  for (const root of roots) {
    try {
      return { root, stat: fs.lstatSync(path.resolve(root, entry)) };
    } catch {
      // Not under this root: try the next.
    }
  }
  return null;
}

function measureOne(declared: string, roots: string[]): SourceRecord {
  const file = String(declared);
  const entry = normalizeEntry(file);
  if (PATTERN.test(entry)) return { file, kind: 'unverifiable', fileHash: null, why: 'pattern' };

  const found = locate(entry, roots);
  if (!found) return { file, kind: 'absent', fileHash: null };
  const { root, stat } = found;
  if (stat.isSymbolicLink()) return { file, kind: 'unhashable', fileHash: null, why: 'link' };
  if (stat.isDirectory()) return { file, kind: 'unhashable', fileHash: null, why: 'directory' };
  if (!stat.isFile()) return { file, kind: 'unhashable', fileHash: null, why: 'read-error' };
  // The size check precedes any read: an oversized file is never opened.
  if (stat.size > MAX_HASH_BYTES) return { file, kind: 'unhashable', fileHash: null, why: 'too-large' };

  const fileHash = sourceVersionFor(root, { file: entry }, null).fileHash;
  if (!fileHash) return { file, kind: 'unhashable', fileHash: null, why: 'read-error' };
  return { file, kind: 'file', fileHash };
}

/**
 * IC-013: measures the task's first 64 `files:` entries, each resolved under `execWorktree`, else
 * under the other `roots` (the `loadPlan` roots) in order where it exists. A missing
 * `execWorktree` is reported as `execWorktreeMissing` and the remaining roots are still measured.
 */
function measureSources(task: { files?: string[] | null }, execWorktree: string | null, roots: string[] = []): SourceMeasurement {
  const declared = Array.isArray(task?.files) ? task.files : [];
  const execWorktreeMissing = Boolean(execWorktree) && !exists(execWorktree);
  const candidates = [...new Set([
    ...(execWorktree && !execWorktreeMissing ? [path.resolve(execWorktree)] : []),
    ...roots.map((root) => path.resolve(root)),
  ])];
  const sources = declared.slice(0, MAX_SOURCES).map((file) => measureOne(file, candidates));
  return {
    sources,
    sourcesTruncated: declared.length > MAX_SOURCES,
    sourcesUnverifiable: sources.filter(opaque).map((s) => s.file),
    execWorktreeMissing,
  };
}

function opaque(s: SourceRecord): boolean {
  return s.kind === 'unhashable' || s.kind === 'unverifiable';
}

function changeOf(before: SourceRecord, after: SourceRecord): SourceChange {
  if (before.kind === 'absent') return after.kind === 'absent' ? 'unchanged' : 'created';
  if (after.kind === 'absent') return 'removed';
  return before.fileHash === after.fileHash ? 'unchanged' : 'changed';
}

/**
 * IC-013: compares an attempt's recorded `sources` with a fresh measurement of the same entries.
 * The whole task is `unverifiable` when the attempt has no `sources`, was truncated, the execution
 * worktree is gone, a recorded entry is missing from `after`, or any entry is `unhashable` or
 * `unverifiable` at either time.
 */
function compareSources(
  before: { sources?: SourceRecord[] | null; sourcesTruncated?: boolean } | null,
  after: SourceMeasurement,
): SourceComparison {
  const unverifiable: SourceComparison = { unverifiable: true, files: [] };
  if (!before || !Array.isArray(before.sources) || before.sourcesTruncated) return unverifiable;
  if (!after || after.execWorktreeMissing || after.sourcesTruncated) return unverifiable;
  const now = new Map(after.sources.map((s) => [s.file, s]));
  const files: Array<{ file: string; change: SourceChange }> = [];
  for (const was of before.sources) {
    const is = now.get(was.file);
    if (!is || opaque(was) || opaque(is)) return unverifiable;
    files.push({ file: was.file, change: changeOf(was, is) });
  }
  return { unverifiable: false, files };
}

module.exports = { MAX_HASH_BYTES, MAX_SOURCES, measureSources, compareSources };
