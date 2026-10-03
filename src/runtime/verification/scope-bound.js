'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveActiveFeature } = require('../feature-resolve');
const { REPO_ROOT } = require('../../helper/repo-root');

// The change-scope bound of a planned feature, and the baseline a change is measured from
// (feature 045, IC-003 / IC-004).
//
// The change-scope tier compares what a change touched against a bound declared before
// implementation. Nothing declared one, so the tier read UNRESOLVED for every feature. The plan
// already names the files each task will touch, so the bound is derived from it; there is no
// extra step an agent has to remember.

const GIT_STATE = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bash', 'do-git-state.sh');

/** `- [ ] A.1 ...` / `- [x] B.2 ...`: a checklist task line, as plan.md writes them. */
const TASK_LINE = /^\s*-\s*\[[ xX]\]\s+[A-Za-z]+\.\d+\b/;

/**
 * Paths a plan's task lines name after `files:`, in order, without duplicates.
 * @param {string} planText
 * @returns {Array<string>}
 */
function taskFilesFromPlan(planText) {
  const paths = [];
  for (const line of String(planText || '').split('\n')) {
    if (!TASK_LINE.test(line)) continue;
    const at = line.indexOf('files:');
    if (at === -1) continue;
    const rest = line.slice(at + 'files:'.length);
    const semicolon = rest.indexOf(';');
    for (const raw of (semicolon === -1 ? rest : rest.slice(0, semicolon)).split(',')) {
      const entry = raw.trim().replace(/^`+|`+$/g, '').trim();
      if (entry) paths.push(entry);
    }
  }
  return [...new Set(paths)];
}

/**
 * The bound the feature's plan declares, or null when there is none to derive.
 *
 * Null when no feature resolves, the plan is absent, or the plan names no task files — in each
 * case the tier stays UNRESOLVED as before, rather than failing every change against a bound that
 * is only the feature folder.
 * @param {Object} options
 * @param {string} options.projectRoot
 * @param {string|null} [options.slug]
 * @returns {{allowedPaths: Array<string>, source: string}|null}
 */
function buildScopeBound({ projectRoot, slug = null }) {
  let found;
  try {
    found = resolveActiveFeature({ projectRoot, slug });
  } catch {
    return null;
  }
  if (found.error || !found.paths || !found.paths.plan || !found.paths.feature_slug) return null;
  const planFile = path.resolve(found.repoRoot, found.paths.plan);
  let text;
  try {
    text = fs.readFileSync(planFile, 'utf8');
  } catch {
    return null;
  }
  const files = taskFilesFromPlan(text);
  if (files.length === 0) return null;
  return {
    allowedPaths: [...files, `agent-docs/doflow/${found.paths.feature_slug}/`],
    source: found.paths.plan,
  };
}

/**
 * The commit a change is measured from: the merge base of HEAD and the integration ref that
 * `do-git-state.sh` reports. `{ref, mergeBase}` when it resolves, else `{reason}` saying why not.
 * @param {Object} options
 * @param {string} options.cwd
 * @param {Function} [options.exec] spawnSync-compatible
 * @returns {{ref: string, mergeBase: string}|{reason: string}}
 */
function resolveIntegrationBase({ cwd, exec = spawnSync }) {
  const run = (cmd, args) => {
    try {
      return exec(cmd, args, { cwd, encoding: 'utf8', timeout: 30000 });
    } catch (error) {
      return { error };
    }
  };
  const state = run('bash', [GIT_STATE, '--json']);
  let ref = null;
  if (state && !state.error && state.status === 0) {
    try { ref = JSON.parse(state.stdout).integration_ref || null; } catch { /* reported below */ }
  }
  if (!ref) return { reason: 'no integration ref could be resolved' };
  const base = run('git', ['merge-base', ref, 'HEAD']);
  const mergeBase = base && !base.error && base.status === 0 ? String(base.stdout || '').trim() : '';
  if (!mergeBase) return { reason: `no merge base with '${ref}'` };
  return { ref, mergeBase };
}

module.exports = { buildScopeBound, taskFilesFromPlan, resolveIntegrationBase };
