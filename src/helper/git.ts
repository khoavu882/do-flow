'use strict';
// git.ts — shared git helpers. Single source of truth for `sourceCommit()`, previously duplicated
// verbatim in src/install/backup.js, src/install/manifest.js, and src/install/context.js (each ran
// its own `git rev-parse` — up to 3 spawns per `doflow install` for the same value).
//
// First module of the TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md). Authored as `.ts` and
// run directly by Node's native type-stripping (process.features.typescript === 'strip', Node
// >=24.22.1), so no build step and no runtime dependency are added. The body stays CommonJS
// (`module.exports`) so a `require('../helper/git.ts')` from a `.js` caller keeps working while the
// rest of the tree is still `.js`; the explicit `.ts` extension on those requires is what the
// CommonJS resolver needs to find this file.
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
