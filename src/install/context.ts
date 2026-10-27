'use strict';
// context.js — resolved-scope/properties view, shown by `install --dry-run` and `status`.
// Purpose: once install targets can be $HOME (global) OR a project path, it stops being obvious
// at a glance which one a given invocation resolves to — this makes that explicit for debugging.
//
// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): authored as `.ts`, run directly by Node
// native type-stripping — no build step, no runtime dependency. Body stays CommonJS so a `.js`
// caller's `require('../install/context.ts')` keeps working while the tree is still `.js`.
const path = require('node:path');
const { sourceCommit: gitSourceCommit } = require('../helper/git.ts');

interface ResolveContextInput {
  repoRoot: string;
  global: boolean;
  projectRoot: string;
  targets: string[];
  dirs: Record<string, string>;
  sourceCommit?: string;
  managedResources?: object[];
}

/**
 * `sourceCommit` lets a caller (bin/doflow.js) pass an already-resolved commit instead of this
 * module spawning its own `git rev-parse`; omit it to resolve here (e.g. tests calling this module
 * directly). Returns a plain properties object (used by both the text and --json renderers).
 */
function resolveContext({ repoRoot, global, projectRoot, targets, dirs, sourceCommit, managedResources }: ResolveContextInput): any {
  const context: any = {
    scope: global ? 'global' : 'project',
    scopeRoot: global ? path.dirname(dirs.claude) : path.resolve(projectRoot),
    targets,
    dirs: Object.fromEntries(targets.map((t) => [t, dirs[t]])),
    repoRoot,
    sourceCommit: sourceCommit ?? gitSourceCommit(repoRoot),
    nodeVersion: process.version,
  };
  // The lifecycle engine may provide its ownership ledger for status/verify output. Do not add
  // an empty field for existing callers: their JSON/text output remains backwards compatible.
  if (managedResources !== undefined) context.managedResources = managedResources;
  return context;
}

/** Human-readable "Resolved context" block, printed to stderr (keeps stdout clean like sync.sh's log()). */
function printContext(ctx: any): void {
  const lines = [
    '[CONTEXT] Resolved install context',
    `  scope         : ${ctx.scope}  (root: ${ctx.scopeRoot})`,
    `  targets       : ${ctx.targets.join(', ')}`,
    ...ctx.targets.map((t: string) => `    ${t.padEnd(7)}-> ${ctx.dirs[t] ?? '(resolved by adapter)'}`),
    `  repo root     : ${ctx.repoRoot}`,
    `  source commit : ${ctx.sourceCommit}`,
    `  node          : ${ctx.nodeVersion}`,
  ];
  if (ctx.managedResources !== undefined) lines.push(`  managed resources: ${ctx.managedResources.length}`);
  console.error(lines.join('\n'));
}

module.exports = { resolveContext, printContext };
