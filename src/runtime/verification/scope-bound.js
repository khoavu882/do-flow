'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveActiveFeature } = require('../feature-resolve');
const { resolveBashHelper } = require('../../helper/bash-helper');
const { listCheckouts } = require('../checkouts');

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

/** A `files:` value that says the task touches no file: `none`, alone or followed by an aside. */
const NONE_FIELD = /^none(?=$|[\s(;,`])/i;

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
    // `files: none (...)` states that a task changes no file; its words are not paths.
    if (NONE_FIELD.test(rest.trim().replace(/^`+/, ''))) continue;
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

const folderOf = (slug) => (slug ? `agent-docs/doflow/${slug}/` : null);

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Why no other checkout was consulted, in the words a reason text lists. */
function noMainCheckout(checkouts) {
  if (!checkouts.ok) {
    if (checkouts.reason === 'not-a-git-repository') return 'not a git repository';
    if (checkouts.reason === 'git-unavailable') return 'git is not available';
    return `git worktree list failed: ${checkouts.detail || 'no detail'}`;
  }
  if (checkouts.sandbox) return 'a DoFlow sandbox sees no other checkout';
  if (checkouts.mainReason === 'bare') return 'the repository is bare';
  if (checkouts.mainReason === 'missing') return 'the main checkout no longer exists';
  return 'this directory is the main checkout';
}

/**
 * The plan that bounds a change, taken from stated sources in a stated order: `--plan-path`, else
 * the feature folder in this checkout, else that folder in the main checkout when this is a linked
 * worktree. The first folder that exists wins, an explicit slug is never replaced by the branch's,
 * and a named plan that does not exist stops the search rather than falling through to a guess.
 * Every source consulted is listed in `searched`. Reads files and copies nothing.
 * @param {Object} options
 * @param {string} options.projectRoot
 * @param {string|null} [options.slug]
 * @param {string|null} [options.planPath] as the caller wrote it, relative to projectRoot
 * @param {Function} [options.exec] spawnSync-compatible, for the one `git worktree list`
 * @returns {{plan: string|null, planRel: string|null, origin: string|null, root: string|null, slug: string|null,
 *   folderRel: string|null, hasRegister: boolean, searched: Array<{place: string, result: string}>, reason: string|null}}
 */
function resolvePlanSource({ projectRoot, slug = null, planPath = null, exec = spawnSync }) {
  const searched = [];
  const result = (fields) => ({
    plan: null, planRel: null, origin: null, root: null, slug: null, folderRel: null, hasRegister: false, searched, reason: null, ...fields,
  });
  const resolve = (s) => {
    try {
      return resolveActiveFeature({ projectRoot, slug: s });
    } catch (error) {
      return { error: 'resolver-failed', message: `could not run the feature resolver: ${error.message}` };
    }
  };

  if (planPath) {
    const abs = path.resolve(projectRoot, planPath);
    const exists = isFile(abs);
    searched.push({ place: `--plan-path ${planPath}`, result: exists ? 'found' : 'does not exist' });
    if (!exists) return result({ planRel: planPath, origin: 'plan-path', reason: 'plan-path-missing' });
    // The flag is its own opt-in: no register is needed for a plan the caller named.
    let s = slug;
    if (!s) {
      const branch = resolve(null);
      if (!branch.error && branch.paths && branch.paths.feature_slug) s = branch.paths.feature_slug;
    }
    const parent = path.dirname(abs);
    if (!s && path.dirname(parent).split(path.sep).slice(-2).join('/') === 'agent-docs/doflow') s = path.basename(parent);
    return result({ plan: abs, planRel: planPath, origin: 'plan-path', slug: s || null, folderRel: folderOf(s), hasRegister: true });
  }

  const found = resolve(slug);
  if (found.error || !found.paths || !found.paths.feature_slug) {
    searched.push({ place: 'this checkout', result: found.message || 'the feature resolver named no feature' });
    return result({ reason: 'no-feature' });
  }
  const s = found.paths.feature_slug;
  const folderRel = folderOf(s);
  const withFolder = (fields) => {
    const plan = path.resolve(fields.root, fields.planRel);
    let reason = null;
    if (!isFile(plan)) reason = 'no-plan';
    else if (!fields.hasRegister) reason = 'no-register';
    return result({ ...fields, plan, slug: s, folderRel, reason });
  };

  const here = isDirectory(found.featureDir);
  searched.push({ place: `this checkout ${found.repoRoot}`, result: here ? `${folderRel} found` : `no ${folderRel}` });
  if (here) {
    return withFolder({
      origin: 'current-checkout', root: found.repoRoot, planRel: found.paths.plan || `${folderRel}plan.md`, hasRegister: found.paths.has_decisions === true,
    });
  }

  const checkouts = listCheckouts({ cwd: projectRoot, exec });
  if (!checkouts.isLinked) {
    searched.push({ place: 'main checkout', result: noMainCheckout(checkouts) });
    return result({ slug: s, folderRel, reason: 'none' });
  }
  const folder = path.join(checkouts.main, 'agent-docs', 'doflow', s);
  const there = isDirectory(folder);
  searched.push({ place: `main checkout ${checkouts.main}`, result: there ? `${folderRel} found` : `no ${folderRel}` });
  if (!there) return result({ slug: s, folderRel, reason: 'none' });
  return withFolder({
    origin: 'main-checkout', root: checkouts.main, planRel: `${folderRel}plan.md`, hasRegister: isFile(path.join(folder, 'decisions', 'register.json')),
  });
}

/** Why a declared-scope token is refused, or null when it is a repository-relative path. */
function refusedToken(token) {
  if (token === '') return 'it is empty';
  if (/[\s\\\0]/.test(token)) return 'it contains whitespace';
  if (token.startsWith('/') || token.startsWith('~') || /^[A-Za-z]:/.test(token)) return 'it is absolute';
  if (token === '.') return 'it names the whole repository';
  const segments = token.split('/');
  if (segments[segments.length - 1] === '') segments.pop();
  if (segments.some((seg) => seg === '.' || seg === '..')) return 'it climbs out with ..';
  return null;
}

/**
 * A declared scope: one comma-separated list of repository-relative paths, a trailing `/` meaning
 * a directory. One refused token refuses the whole text, so a typo never shrinks the bound
 * silently. Duplicates are dropped and order is kept.
 * @param {string} text
 * @returns {{paths: Array<string>, reason: null}|{paths: null, reason: string}}
 */
function parseDeclaredScope(text) {
  const paths = [];
  for (const raw of String(text).trim().split(',')) {
    const written = raw.trim();
    const token = written.replace(/^(\.\/)+/, '');
    // `./` alone strips to nothing, but what it names is the repository root, not an empty entry.
    const why = written !== '' && token === '' ? 'it names the whole repository' : refusedToken(token);
    if (why) return { paths: null, reason: `'${written}' is not a repository-relative path: ${why}` };
    if (!paths.includes(token)) paths.push(token);
  }
  return { paths, reason: null };
}

/**
 * The change-scope bound: the plan's task files plus its feature folder, unioned with a declared
 * scope, plan entries first. Neither narrows the other, and nothing is derived from the changed
 * files. With neither, `bound` is null and `reason` is the first source that failed.
 * @param {Object} options
 * @param {string} options.projectRoot
 * @param {string|null} [options.slug]
 * @param {string|null} [options.planPath]
 * @param {{paths: Array<string>, origin: 'verify-flag'|'readiness-record', record?: string}|null} [options.declared]
 * @param {Function} [options.exec]
 * @returns {{bound: Object|null, reason: string|null, searched: Array<Object>, planSource: Object}}
 */
function resolveScopeBound({ projectRoot, slug = null, planPath = null, declared = null, exec = spawnSync }) {
  const planSource = resolvePlanSource({ projectRoot, slug, planPath, exec });
  let reason = planSource.reason;
  const allowed = [];
  const sources = [];
  if (reason === null) {
    let text = null;
    try {
      text = fs.readFileSync(planSource.plan, 'utf8');
    } catch {
      reason = 'no-plan';
    }
    const files = text === null ? [] : taskFilesFromPlan(text);
    if (text !== null && files.length === 0) reason = 'no-task-files';
    if (files.length > 0) {
      allowed.push(...files);
      if (planSource.folderRel) allowed.push(planSource.folderRel);
      sources.push({ kind: 'plan', path: planSource.planRel, origin: planSource.origin, root: planSource.root });
    }
  }
  if (declared && Array.isArray(declared.paths) && declared.paths.length > 0) {
    allowed.push(...declared.paths);
    sources.push({ kind: 'declared', paths: [...declared.paths], origin: declared.origin, ...(declared.record ? { record: declared.record } : {}) });
  }
  if (allowed.length === 0) return { bound: null, reason, searched: planSource.searched, planSource };
  const source = sources[0].kind === 'plan' ? planSource.planRel : (declared.record || '--scope');
  return {
    bound: { allowedPaths: [...new Set(allowed)], source, sources, baseline: 'integration' },
    reason: null,
    searched: planSource.searched,
    planSource,
  };
}

/**
 * The bound a plan declares, as 1.21.0 returned it: `{allowedPaths, source}`, or null.
 * @param {Object} options
 * @param {string} options.projectRoot
 * @param {string|null} [options.slug]
 * @returns {{allowedPaths: Array<string>, source: string}|null}
 */
function buildScopeBound({ projectRoot, slug = null }) {
  const { bound } = resolveScopeBound({ projectRoot, slug });
  return bound ? { allowedPaths: bound.allowedPaths, source: bound.source } : null;
}

function originText(origin, root) {
  if (origin === 'main-checkout') return `main checkout ${root}`;
  if (origin === 'plan-path') return '--plan-path';
  return 'current checkout';
}

/**
 * The change-scope tier's reason when nothing bounds the change: where was looked and the command
 * that bounds it.
 * @param {Object} options
 * @param {string} options.reason a `resolveScopeBound` reason
 * @param {string} options.taskId
 * @param {Object} options.planSource the `resolvePlanSource` result
 * @returns {string}
 */
function scopeReasonText({ reason, taskId, planSource }) {
  const places = planSource.searched.map((s) => `${s.place}: ${s.result}`).join('; ');
  const where = `${planSource.folderRel} (${originText(planSource.origin, planSource.root)})`;
  switch (reason) {
    case 'no-plan':
      return `change-scope: the feature folder ${where} has no plan.md, so nothing bounds this change. Looked in: ${places}. Pass --scope <path>[,<path>...] or --plan-path <plan.md>. Nothing was changed.`;
    case 'no-register':
      return `change-scope: the feature folder ${where} has no decisions/register.json, so its plan bounds nothing (features from before the register keep that behaviour). Pass --scope <path>[,<path>...] or --plan-path <plan.md> to bound this change. Nothing was changed.`;
    case 'no-task-files':
      return `change-scope: ${planSource.planRel} names no files: in any task, so it bounds nothing. Add files: to its tasks or pass --scope <path>[,<path>...]. Nothing was changed.`;
    case 'plan-path-missing':
      return `change-scope: --plan-path ${planSource.planRel} does not exist; no other source is consulted when a plan is named. Pass an existing plan.md or drop --plan-path. Nothing was changed.`;
    default:
      return `change-scope: no plan or declared scope bounds this change. Looked in: ${places}. A change with no plan needs a declared scope: doflow-run verify --task-id ${taskId} --scope <path>[,<path>...] (a trailing / is a directory); to use a plan, pass --plan-path <plan.md> or --slug <feature>. Nothing was changed.`;
  }
}

/**
 * Where a resolved bound came from, as the `bound:` line prints it.
 * @param {Array<Object>} sources a bound's `sources`
 * @returns {string}
 */
function boundSourcesText(sources) {
  return sources.map((s) => (s.kind === 'plan'
    ? `plan ${s.path} (${originText(s.origin, s.root)})`
    : `declared ${s.paths.join(',')} (${s.origin === 'readiness-record' ? `readiness record ${s.record}` : '--scope'})`)).join(' + ');
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

module.exports = {
  buildScopeBound,
  taskFilesFromPlan,
  resolveIntegrationBase,
  resolvePlanSource,
  parseDeclaredScope,
  resolveScopeBound,
  scopeReasonText,
  boundSourcesText,
};
