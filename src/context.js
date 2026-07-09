'use strict';
// context.js — resolved-scope/properties view, shown by `install --dry-run` and `status`.
// Purpose: once install targets can be $HOME (global) OR a project path, it stops being obvious
// at a glance which one a given invocation resolves to — this makes that explicit for debugging.
const path = require('node:path');
const { sourceCommit: gitSourceCommit } = require('./git');

/**
 * @param {{repoRoot:string, mappingsFile:string, global:boolean, projectRoot:string,
 *          targets:string[], dirs:Record<string,string>, sourceCommit?:string}} p
 *          `sourceCommit` lets a caller (bin/doflow.js) pass an already-resolved commit instead of
 *          this module spawning its own `git rev-parse`; omit it to resolve here (e.g. tests
 *          calling this module directly).
 * @returns {object} plain properties object (used by both the text and --json renderers)
 */
function resolveContext({ repoRoot, mappingsFile, global, projectRoot, targets, dirs, sourceCommit }) {
  return {
    scope: global ? 'global' : 'project',
    scopeRoot: global ? path.dirname(dirs.claude) : path.resolve(projectRoot),
    targets,
    dirs: Object.fromEntries(targets.map((t) => [t, dirs[t]])),
    repoRoot,
    sourceCommit: sourceCommit ?? gitSourceCommit(repoRoot),
    mappingsFile,
    nodeVersion: process.version,
  };
}

/** Human-readable "Resolved context" block, printed to stderr (keeps stdout clean like sync.sh's log()). */
function printContext(ctx) {
  const lines = [
    '[CONTEXT] Resolved install context',
    `  scope         : ${ctx.scope}  (root: ${ctx.scopeRoot})`,
    `  targets       : ${ctx.targets.join(', ')}`,
    ...ctx.targets.map((t) => `    ${t.padEnd(7)}-> ${ctx.dirs[t]}`),
    `  repo root     : ${ctx.repoRoot}`,
    `  source commit : ${ctx.sourceCommit}`,
    `  mappings file : ${ctx.mappingsFile}`,
    `  node          : ${ctx.nodeVersion}`,
  ];
  console.error(lines.join('\n'));
}

module.exports = { resolveContext, printContext };
