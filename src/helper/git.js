'use strict';
// git.js — shared git helpers. Single source of truth for `sourceCommit()`, previously
// duplicated verbatim in src/backup.js, src/manifest.js, and src/context.js (each module ran its
// own `git rev-parse` — up to 3 spawns per `doflow install` invocation for the same value).
const { execFileSync } = require('node:child_process');

/** Short HEAD commit of the repo at `repoRoot`, or 'unknown' if not a git repo / git unavailable. */
function sourceCommit(repoRoot) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

module.exports = { sourceCommit };
