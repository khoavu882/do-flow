'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveActiveFeature } = require('../feature-resolve');
const { resolveBashHelper } = require('../../helper/bash-helper');

// The change-scope bound of a planned feature, and the baseline a change is measured from
// (feature 045, IC-003 / IC-004).
//
// The change-scope tier compares what a change touched against a bound declared before
// implementation. Nothing declared one, so the tier read UNRESOLVED for every feature. The plan
// already names the files each task will touch, so the bound is derived from it; there is no
// extra step an agent has to remember.

/** `- [ ] A.1 ...` / `- [x] B.2 ...`: a checklist task line, as plan.md writes them. */
const TASK_LINE = /^\s*-\s*\[[ xX]\]\s+[A-Za-z]+\.\d+\b/;

/** `files:` (any case) as a field of its own: at the start of the line, after whitespace or after a `;`. A word
 * that merely ends in it (`profiles:`) is not the field. */
const FILES_FIELD = /(?:^|[;\s])files:/gi;

/**
 * Paths a plan's task lines name after `files:`, in order, without duplicates.
 *
 * The field is the last `files:` on the task line (a description may mention the word earlier). It
 * runs to the next `;` or the end of the line; a list that ends with `,` continues on the next
 * indented line, which is how a long list is wrapped.
 * @param {string} planText
 * @returns {Array<string>}
 */
function taskFilesFromPlan(planText) {
  const lines = String(planText || '').split('\n');
  const paths = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!TASK_LINE.test(lines[i])) continue;
    let at = -1;
    for (const m of lines[i].matchAll(FILES_FIELD)) at = m.index + m[0].length;
    if (at === -1) continue;
    let rest = lines[i].slice(at);
    for (;;) {
      const semicolon = rest.indexOf(';');
      const field = semicolon === -1 ? rest : rest.slice(0, semicolon);
      for (const raw of field.split(',')) {
        // A leading `./` is the same path: changed files are reported without it.
        const entry = raw.trim().replace(/^`+|`+$/g, '').trim().replace(/^(\.\/)+/, '');
        if (entry) paths.push(entry);
      }
      const wraps = semicolon === -1 && field.trimEnd().endsWith(',')
        && i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !TASK_LINE.test(lines[i + 1]);
      if (!wraps) break;
      i += 1;
      rest = lines[i];
    }
  }
  return [...new Set(paths)];
}

/**
 * The bound the feature's plan declares, or null when there is none to derive.
 *
 * Null when no feature resolves, the feature has no decision register, the plan is absent, or the
 * plan names no task files — in each case the tier stays UNRESOLVED as before. The register is the
 * opt-in signal, as it is for task record isolation: a feature from before it keeps v1.12.0's
 * behaviour (NFR-001), and a plan with no task files would otherwise fail every change against a
 * bound that is only the feature folder.
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
  if (found.paths.has_decisions !== true) return null;
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
 * `do-git-state.sh` reports. `{ref, mergeBase}` when it resolves, else `{reason, note?}` saying why not;
 * `note` is the tier detail when the reason has wording of its own (a missing integration branch).
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
  const gitState = resolveBashHelper('do-git-state.sh');
  const state = gitState ? run('bash', [gitState, '--json']) : null;
  let ref = null;
  if (state && !state.error && state.status === 0) {
    try { ref = JSON.parse(state.stdout).integration_ref || null; } catch { /* reported below */ }
  }
  if (!ref) return { reason: gitState ? 'no integration ref could be resolved' : 'the DoFlow helper scripts are missing from this install (do-git-state.sh)' };
  const exists = run('git', ['rev-parse', '--verify', '--quiet', ref]);
  if (!exists || exists.error || exists.status !== 0) {
    return { reason: `integration branch '${ref}' not found`, note: `integration branch '${ref}' not found; working tree only` };
  }
  const base = run('git', ['merge-base', ref, 'HEAD']);
  const mergeBase = base && !base.error && base.status === 0 ? String(base.stdout || '').trim() : '';
  if (!mergeBase) return { reason: `no merge base with '${ref}'` };
  return { ref, mergeBase };
}

module.exports = { buildScopeBound, taskFilesFromPlan, resolveIntegrationBase };
