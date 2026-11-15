'use strict';

// Feature 161 IC-003, IC-004: the `artifacts` index of a `layers:<pk>` channel, and the only way a
// `file:<pk>:<fk>` lane turns its fileKey back into a file.
//
// Listed, per checkout of the project (file rules: core/shared/scripts/doflow/bash/do-exec-paths.sh,
// src/runtime/dispatch/envelope.ts, src/runtime/dispatch/grants.ts, src/runtime/worker/supervisor.ts):
//   agent-docs/doflow/<feature>/exec/task-<id>-brief.md     task-brief          (.json: task-brief-record)
//   agent-docs/doflow/<feature>/exec/group-<id>-brief.md    group-brief         (.json: group-brief-record)
//   agent-docs/doflow/<feature>/exec/task-<id>-report.md    task-report
//   .doflow/state/dispatch-envelopes/<dispatchId>.handoff.json   handoff
//   .doflow/state/dispatch-envelopes/<dispatchId>.result.json    result
//   .doflow/state/dispatch-envelopes/<requestId>.prompt.txt      spawn-prompt (dispatchId = the request id)
//   .doflow/state/worker-output/<runId>.out.log | .err.log       worker-out, worker-err (never .last.log)
//   .doflow/state/session-prompts/<runId>.prompt.txt             session-prompt (165: a started session's prompt)
// Only `lstat` regular files are listed (a symbolic link is skipped, and no directory on the way
// down from the checkout may be a link); an id or feature that is not id-shaped (so any `/`, `\` or `..`) is skipped; at most
// ARTIFACT_LIMIT, newest first. fileKey = sha16(checkoutRoot + "\0" + relPath) with `/` separators.
// The listed items carry no path; `files` (fileKey -> {path, kind}) stays inside the core.
// Read-only: directories are listed and files are `lstat`ed, nothing is opened.

const fs = require('node:fs');
const path = require('node:path');
const { sha16 } = require('../scaffold/fingerprint.ts');
const { cwdHash } = require('../context/identity.ts');
const { isSafeSlug } = require('../task-scope.ts');

/** IC-003: the most artifacts one index lists. */
const ARTIFACT_LIMIT = 64;
/** The most names read from one directory. Ceiling: a directory with more is listed in part. */
const LIST_CAP = 2000;
/** An id as it may appear in a file name: no separator, no `..`, no leading dot. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RUN_ID = /^w-[0-9a-f]{12}$/;

type Kind = 'task-brief' | 'task-brief-record' | 'group-brief' | 'group-brief-record' | 'task-report' | 'handoff' | 'result' | 'spawn-prompt' | 'worker-out' | 'worker-err' | 'session-prompt';
type Rule = { re: RegExp; kind: Kind; field: 'task' | 'group' | 'dispatchId' | 'runId' };

const EXEC_RULES: readonly Rule[] = Object.freeze([
  { re: /^task-(.+)-brief\.md$/, kind: 'task-brief', field: 'task' },
  { re: /^task-(.+)-brief\.json$/, kind: 'task-brief-record', field: 'task' },
  { re: /^task-(.+)-report\.md$/, kind: 'task-report', field: 'task' },
  { re: /^group-(.+)-brief\.md$/, kind: 'group-brief', field: 'group' },
  { re: /^group-(.+)-brief\.json$/, kind: 'group-brief-record', field: 'group' },
]);
const DISPATCH_RULES: readonly Rule[] = Object.freeze([
  { re: /^(.+)\.handoff\.json$/, kind: 'handoff', field: 'dispatchId' },
  { re: /^(.+)\.result\.json$/, kind: 'result', field: 'dispatchId' },
  { re: /^(.+)\.prompt\.txt$/, kind: 'spawn-prompt', field: 'dispatchId' },
]);
const SESSION_PROMPT_RULES: readonly Rule[] = Object.freeze([
  { re: /^(w-[0-9a-f]{12})\.prompt\.txt$/, kind: 'session-prompt', field: 'runId' },
]);
const WORKER_RULES: readonly Rule[] = Object.freeze([
  { re: /^(w-[0-9a-f]{12})\.out\.log$/, kind: 'worker-out', field: 'runId' },
  { re: /^(w-[0-9a-f]{12})\.err\.log$/, kind: 'worker-err', field: 'runId' },
]);

/** The relative directories each checkout contributes and the rules of their files. */
const DISPATCH_DIR = ['.doflow', 'state', 'dispatch-envelopes'];
const WORKER_DIR = ['.doflow', 'state', 'worker-output'];
const SESSION_PROMPT_DIR = ['.doflow', 'state', 'session-prompts'];
const FEATURES_DIR = ['agent-docs', 'doflow'];

interface Artifact {
  fileKey: string; kind: Kind; worktreeKey: string; feature: string | null;
  task?: string; group?: string; dispatchId?: string; runId?: string; bytes: number; at: string;
}
interface Scan { items: Artifact[]; files: Map<string, { path: string; kind: Kind; root: string }> }

/** fileKey = sha16(checkoutRoot + "\0" + relPath), `relPath` with `/` separators: the one formula the index and the
 * start-session reply (165 IC-001) both use. */
function fileKeyOf(checkout: string, rel: string): string {
  return sha16(`${checkout}\0${rel}`);
}

/**
 * The names in `checkout/<parts>` when every directory on the way down from the checkout is a real
 * directory (no component is a link), else none.
 */
function names(checkout: string, parts: readonly string[], fsImpl: any): string[] {
  try {
    let dir = checkout;
    for (const part of parts) {
      dir = path.join(dir, part);
      if (!fsImpl.lstatSync(dir).isDirectory()) return [];
    }
    return fsImpl.readdirSync(dir).map(String).sort().slice(0, LIST_CAP);
  } catch {
    return [];
  }
}

/** The feature directories of a checkout that are real directories with a safe slug, as path parts under it. */
function featureDirs(checkout: string, fsImpl: any): Array<{ feature: string; parts: string[] }> {
  const out: Array<{ feature: string; parts: string[] }> = [];
  for (const feature of names(checkout, FEATURES_DIR, fsImpl)) {
    if (!isSafeSlug(feature) || !ID.test(feature)) continue;
    try { if (!fsImpl.lstatSync(path.join(checkout, ...FEATURES_DIR, feature)).isDirectory()) continue; } catch { continue; }
    out.push({ feature, parts: [...FEATURES_DIR, feature] });
  }
  return out;
}

/**
 * The directories an index reads, per checkout, for a channel's sources: the features directory,
 * each feature directory, each `exec` directory, the dispatch-envelopes, worker-output and session-prompts directories.
 */
function artifactDirs(checkouts: readonly string[], fsImpl: any = fs): { features: string[]; featureDirs: string[]; exec: string[]; state: string[] } {
  const out = { features: [] as string[], featureDirs: [] as string[], exec: [] as string[], state: [] as string[] };
  for (const checkout of checkouts) {
    out.features.push(path.join(checkout, ...FEATURES_DIR));
    for (const { parts } of featureDirs(checkout, fsImpl)) {
      const dir = path.join(checkout, ...parts);
      out.featureDirs.push(dir);
      out.exec.push(path.join(dir, 'exec'));
    }
    out.state.push(path.join(checkout, ...DISPATCH_DIR), path.join(checkout, ...WORKER_DIR), path.join(checkout, ...SESSION_PROMPT_DIR));
  }
  return out;
}

/**
 * Lists the artifacts of a project's checkouts (main first, as the project index lists them).
 * @param {string[]} checkouts absolute checkout roots
 * @returns {{items: Artifact[], files: Map<string, {path: string, kind: string, root: string}>}} at most
 *   ARTIFACT_LIMIT items, newest `at` first (then fileKey), and the same set as fileKey -> file (with its checkout).
 */
function scanArtifacts(checkouts: readonly string[], fsImpl: any = fs): Scan {
  const found: Array<{ item: Artifact; file: string; root: string; ms: number }> = [];
  const take = (checkout: string, parts: readonly string[], rules: readonly Rule[], feature: string | null): void => {
    const dir = path.join(checkout, ...parts);
    for (const name of names(checkout, parts, fsImpl)) {
      const rule = rules.find((r) => r.re.test(name));
      if (!rule) continue;
      const value = (rule.re.exec(name) as RegExpExecArray)[1];
      if (!ID.test(value) || value.includes('..') || (rule.field === 'runId' && !RUN_ID.test(value))) continue;
      const file = path.join(dir, name);
      let st: any;
      try { st = fsImpl.lstatSync(file); } catch { continue; }
      if (!st.isFile()) continue; // a symbolic link, a directory or anything else is never listed
      const rel = path.relative(checkout, file).split(path.sep).join('/');
      const item: Artifact = {
        fileKey: fileKeyOf(checkout, rel), kind: rule.kind, worktreeKey: cwdHash(checkout), feature,
        [rule.field]: value, bytes: st.size, at: new Date(st.mtimeMs).toISOString(),
      } as Artifact;
      found.push({ item, file, root: checkout, ms: st.mtimeMs });
    }
  };
  for (const checkout of checkouts) {
    for (const { feature, parts } of featureDirs(checkout, fsImpl)) take(checkout, [...parts, 'exec'], EXEC_RULES, feature);
    take(checkout, DISPATCH_DIR, DISPATCH_RULES, null);
    take(checkout, WORKER_DIR, WORKER_RULES, null);
    take(checkout, SESSION_PROMPT_DIR, SESSION_PROMPT_RULES, null);
  }
  found.sort((a, b) => b.ms - a.ms || (a.item.fileKey < b.item.fileKey ? -1 : a.item.fileKey > b.item.fileKey ? 1 : 0));
  const kept = found.slice(0, ARTIFACT_LIMIT);
  return { items: kept.map((f) => f.item), files: new Map(kept.map((f) => [f.item.fileKey, { path: f.file, kind: f.item.kind, root: f.root }])) };
}

/**
 * IC-004: the file a `file:<pk>:<fk>` lane may read: the one the project's current index lists
 * under `fileKey` with the checkout it is under, else null (the lane is then `gone`). The path never leaves the core.
 */
function findArtifact(checkouts: readonly string[], fileKey: string, fsImpl: any = fs): { path: string; kind: Kind; root: string } | null {
  return scanArtifacts(checkouts, fsImpl).files.get(fileKey) ?? null;
}

module.exports = { scanArtifacts, findArtifact, artifactDirs, fileKeyOf, ARTIFACT_LIMIT };
