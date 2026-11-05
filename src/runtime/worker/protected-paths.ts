'use strict';

// FU-kjcv6t (082 protected-path gap): a harness's sandbox may refuse writes to some paths inside the
// workspace (codex under `exec -s workspace-write`: .git, .agents, .codex, .aws). The registry lists them
// as `worker.isolatedEdit.protectedPaths`. A task whose declared files reach one cannot be an edit task
// for that worker, so eligibility gives it the gap `protected-path` and the task runs sequentially
// instead of failing `worker-denied` after launch.
//
// A protected path blocks only at the workspace root: codex wrote to a nested `sub/.git` in the live probe,
// so a declared file matches by its root-relative leading segments, never by a segment further down.
// Matching ignores letter case because the denial was observed on a case-insensitive file system, where
// `.Git` is the same directory as `.git`; a false match only moves a task to the sequential path.

const path = require('node:path');

/** The root-relative segments of a declared `files:` entry, or null when it does not name a path inside
 * the workspace (empty, absolute, or climbing out through `..`). */
function rootSegments(file: unknown): string[] | null {
  if (typeof file !== 'string') return null;
  const slashed = file.trim().replace(/\\/g, '/');
  if (!slashed || slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return null;
  const normal = path.posix.normalize(slashed);
  if (normal === '.' || normal === '..' || normal.startsWith('../')) return null;
  return normal.split('/').filter(Boolean);
}

/** The first protected path that a declared file starts with, as `{ protectedPath, file }`, or null.
 * Order: declared files first, then protected paths, both in the order given. */
function matchProtectedPath(files: unknown, protectedPaths: unknown): { protectedPath: string, file: string } | null {
  if (!Array.isArray(files) || !Array.isArray(protectedPaths)) return null;
  for (const file of files) {
    const segments = rootSegments(file);
    if (!segments) continue;
    const lowered = segments.map((segment) => segment.toLowerCase());
    for (const protectedPath of protectedPaths) {
      const wanted = rootSegments(protectedPath);
      if (!wanted) continue;
      if (wanted.length <= lowered.length && wanted.every((segment, index) => segment.toLowerCase() === lowered[index])) {
        return { protectedPath: String(protectedPath), file: String(file).trim() };
      }
    }
  }
  return null;
}

/** The eligibility gap for a worker descriptor and a task's declared files, or null: the shape of the
 * other candidate gaps (`requirement`, `result`, `reason`), with the matched path in the reason. */
function protectedPathGap(worker: any, files: unknown): { requirement: string, result: string, reason: string } | null {
  const entry = worker && worker.isolatedEdit;
  if (!entry || entry.status !== 'supported' || !Array.isArray(entry.protectedPaths)) return null;
  const hit = matchProtectedPath(files, entry.protectedPaths);
  return hit ? { requirement: 'protected-path', result: 'failed', reason: `protected-path:${hit.protectedPath} (${hit.file})` } : null;
}

module.exports = { matchProtectedPath, protectedPathGap };
