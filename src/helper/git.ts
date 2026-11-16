'use strict';
// git.ts — shared git helpers. Single source of truth for `sourceCommit()`, previously duplicated
// verbatim in src/install/backup.js, src/install/manifest.js, and src/install/context.js (each ran
// its own `git rev-parse` — up to 3 spawns per `doflow install` for the same value).
const { execFileSync } = require('node:child_process');

/** Short HEAD commit of the repo at `repoRoot`, or 'unknown' if not a git repo / git unavailable. */
function sourceCommit(repoRoot: string): string {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

module.exports = { sourceCommit };
