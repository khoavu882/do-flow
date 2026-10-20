'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveBashHelper } = require('../helper/bash-helper.ts');

// `resolveActiveFeature` was moved here from `scaffold/generate.js` (which had it from
// bin/doflow.js) so the scaffold and the decision register ask the same resolver. The root comes
// from src/helper/repo-root.js rather than from counting this file's own depth: this code has
// already moved twice, and a miscounted expression would keep resolving, to the wrong directory.

/** The one resolver: beside this module in a checkout, a project `node_modules/` and a global npm install,
 *  else the copy projected next to an installed runtime (an installed runtime carries no `core/shared`). */
const PATHS_HELPER = resolveBashHelper('do-paths.sh');

/**
 * Which feature is active, answered by `do-paths.sh` rather than by walking `agent-docs/` here.
 *
 * Every other consumer of "the active feature" — every chain skill, the prerequisite gate, the
 * artifact validator — asks this script. A second implementation would disagree with them the
 * first time branch naming, the non-git directory-scan fallback or `--slug` disambiguation came
 * up, and it would disagree silently, because a scaffold generated for the wrong feature still
 * looks like a scaffold.
 *
 * @param {Object} options
 * @param {string} options.projectRoot working directory the resolution is relative to
 * @param {string|null} [options.slug] explicit feature override, passed straight through
 * @returns {{repoRoot:string, featureRoot:string, featureDir:string, featureFolder:string, paths:Object}|{error:string, message:string}}
 *   `paths` is the resolver's own parsed JSON (repo-root-relative artifact paths and has_* flags),
 *   so a caller needs no second resolver call.
 */
function resolveActiveFeature({ projectRoot, slug = null }: { projectRoot: string; slug?: string | null }): any {
  const helper = resolveBashHelper('do-paths.sh');
  if (!helper) {
    return { error: 'resolver-missing', message: 'the feature resolver (do-paths.sh) is missing from this install' };
  }
  const args: string[] = [helper, '--json', '--require', 'feature'];
  if (slug) args.push(`--slug=${slug}`);

  let stdout: string;
  try {
    stdout = execFileSync('bash', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error: any) {
    // Exit 2 is the resolver's one non-zero path (no active feature, or an ambiguous one) and it
    // still prints its error object on stdout — that object carries the hint the user needs, so
    // it is read rather than replaced with a generic message. Anything else (no bash, NFR-003)
    // has no stdout to read and reports the spawn failure instead.
    stdout = typeof error.stdout === 'string' ? error.stdout : '';
    if (!stdout.trim()) {
      const detail = error.code === 'ENOENT'
        ? 'bash is required to resolve the active feature and was not found on PATH'
        : (error.stderr || error.message || '').toString().trim();
      return { error: 'resolver-failed', message: `could not run the feature resolver: ${detail}` };
    }
  }

  let paths: any;
  try {
    paths = JSON.parse(stdout);
  } catch {
    return { error: 'resolver-unparseable', message: `the feature resolver returned output that is not JSON: ${stdout.trim().slice(0, 200)}` };
  }

  if (paths.error) {
    const hint = paths.hint ? ` — ${paths.hint}` : '';
    const candidates = Array.isArray(paths.candidate_slugs) && paths.candidate_slugs.length
      ? ` (candidates: ${paths.candidate_slugs.join(', ')})`
      : '';
    return { error: paths.error, message: `${paths.error}${candidates}${hint}` };
  }
  if (!paths.repo_root || !paths.feature_dir) {
    return { error: 'no-active-feature', message: 'the resolver named no active feature directory to scaffold' };
  }
  // `featureDir` is the folder in the checkout asked about (what every caller used before 115 and
  // still tests for "this checkout has the folder"). `featureRoot` is the checkout that holds the
  // folder (the main checkout when a linked worktree has none of its own) and `featureFolder` the
  // folder there: the `decision` verb reads and writes its register through those.
  const featureRoot = paths.feature_root || paths.repo_root;
  return {
    repoRoot: paths.repo_root,
    featureRoot,
    featureDir: path.resolve(paths.repo_root, paths.feature_dir),
    featureFolder: path.resolve(featureRoot, paths.feature_dir),
    paths,
  };
}

module.exports = { resolveActiveFeature, PATHS_HELPER };
