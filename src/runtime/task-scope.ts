'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const featureResolve = require('./feature-resolve.ts');

// Which feature a task record belongs to (feature 045, IC-001/IC-002).
//
// Task ids are short and repeat across features (`A.1` exists in every feature that has a Phase A),
// and the stores key records by the bare id. A task in one feature therefore read the evidence,
// claims and outcome another feature had written under the same id. A feature that has a decision
// register now keeps its records in a subdirectory named for the feature; a feature without one,
// and a task id that is the feature's own slug, keep the flat layout, so no existing record is
// moved, renamed or rewritten (FR-007) and a namespaced read never falls back to the flat file.

const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SLUG_RULE = 'use letters, digits, dot, underscore or dash, start with a letter or digit, and no ".."';

/** The one shape check for a feature slug (IC-009); do-paths.sh applies the same rule in bash. */
function isSafeSlug(slug: any): boolean {
  return typeof slug === 'string' && SAFE_SLUG.test(slug) && !slug.includes('..');
}

/**
 * The refusal for a slug that fails the shape check, in the shape do-paths.sh prints, or null when
 * the slug is fine or was not given.
 * @param {*} slug
 * @returns {{error: 'invalid-slug', message: string, hint: string}|null}
 */
function invalidSlugRefusal(slug: any): { error: 'invalid-slug'; message: string; hint: string } | null {
  if (typeof slug !== 'string' || slug === '' || isSafeSlug(slug)) return null;
  return { error: 'invalid-slug', message: `slug "${slug}" is not a valid feature slug: ${SLUG_RULE}`, hint: SLUG_RULE };
}

/** (projectRoot, slug) -> { slug, hasRegister } | { reason }. One resolver spawn per key per process. */
const featureCache = new Map<string, any>();

/** The resolver's raw answer, including thrown failures, shared by every consumer in this process. */
const resolvedFeatureCache = new Map<string, { value: any } | { error: unknown }>();

/** A slug the CLI named explicitly (`--slug`), applied to every store call in this process that was
 * not given its own. The dispatcher sets it once so the verbs whose handlers build their ledger
 * internally (readiness, evidence) route the same way as the ones that take `slug` directly. */
let defaultSlug: string | null = null;

function setDefaultSlug(slug: any): void {
  defaultSlug = typeof slug === 'string' && slug !== '' ? slug : null;
}

function clearTaskScopeCache(): void {
  featureCache.clear();
  resolvedFeatureCache.clear();
}

/**
 * Resolve once per process per (root, slug). The resolver spawns do-paths.sh, and every store and
 * the decisions lookup must see the same answer.
 */
function resolveFeature({ projectRoot, slug = null }: { projectRoot: string; slug?: string | null }): any {
  const key = `${path.resolve(projectRoot)}\0${slug || ''}`;
  if (resolvedFeatureCache.has(key)) {
    const cached = resolvedFeatureCache.get(key)!;
    if ('error' in cached) throw cached.error;
    return cached.value;
  }
  try {
    const value = featureResolve.resolveActiveFeature({ projectRoot, slug: slug || null });
    resolvedFeatureCache.set(key, { value });
    return value;
  } catch (error) {
    resolvedFeatureCache.set(key, { error });
    throw error;
  }
}

/** The resolver reports the git top level, which is the project root or one of its ancestors, and
 * the feature folders live directly under it — so no `agent-docs/doflow` on the way up means there
 * is nothing to resolve and the spawn is skipped. */
function hasFeatureFolderAbove(projectRoot: string): boolean {
  let dir = path.resolve(projectRoot);
  for (;;) {
    try {
      if (fs.statSync(path.join(dir, 'agent-docs', 'doflow')).isDirectory()) return true;
    } catch { /* not here */ }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function featureFor(projectRoot: string, slug: string | null | undefined): any {
  const key = `${path.resolve(projectRoot)}\0${slug || ''}`;
  if (featureCache.has(key)) return featureCache.get(key);
  let value: any = { reason: 'no-feature' };
  try {
    if (hasFeatureFolderAbove(projectRoot)) {
      const found = resolveFeature({ projectRoot, slug: slug || null });
      if (!found.error && found.paths && isSafeSlug(found.paths.feature_slug)) {
        value = { slug: found.paths.feature_slug, hasRegister: found.paths.has_decisions === true, exists: fs.existsSync(found.featureDir) };
      }
    }
  } catch { /* a resolver failure is "no feature", never an exception */ }
  featureCache.set(key, value);
  return value;
}

/**
 * @param {Object} options
 * @param {string} options.projectRoot
 * @param {string} options.taskId
 * @param {string|null} [options.slug] explicit feature; otherwise the `--slug` default, then the branch
 * @returns {{namespace: string|null, slug: string|null, reason: string}}
 *   `reason` is `namespaced` when a namespace applies, else `no-feature`, `no-register` or
 *   `feature-level-id`.
 */
function resolveTaskScope({ projectRoot, taskId, slug = null }: { projectRoot: string; taskId: string; slug?: string | null }): { namespace: string | null; slug: string | null; reason: string } {
  const feature = featureFor(projectRoot, slug || defaultSlug);
  if (feature.reason) return { namespace: null, slug: null, reason: feature.reason };
  if (!feature.hasRegister) return { namespace: null, slug: feature.slug, reason: 'no-register' };
  if (taskId === feature.slug) return { namespace: null, slug: feature.slug, reason: 'feature-level-id' };
  return { namespace: feature.slug, slug: feature.slug, reason: 'namespaced' };
}

/**
 * Whether an explicit slug, already known to be well-formed, names no feature folder here. The
 * records then go to the shared task store, which is today's behaviour and is worth one line to the
 * caller because the slug they typed did nothing.
 * @param {Object} options
 * @param {string} options.projectRoot
 * @param {string} options.slug
 * @returns {boolean}
 */
function slugNamesNoFeature({ projectRoot, slug }: { projectRoot: string; slug: string }): boolean {
  const feature = featureFor(projectRoot, slug);
  return Boolean(feature.reason) || feature.exists === false;
}

/**
 * The directory a task's record file for one store lives in (IC-002).
 * @param {Object} options
 * @param {string} options.projectRoot
 * @param {string} options.store state subdirectory: evidence | research | outcome | retrieval
 * @param {string} options.taskId
 * @param {string|null} [options.slug]
 * @returns {string}
 */
function taskStoreDir({ projectRoot, store, taskId, slug = null }: { projectRoot: string; store: string; taskId: string; slug?: string | null }): string {
  const base = path.join(projectRoot, '.doflow', 'state', store);
  const { namespace } = resolveTaskScope({ projectRoot, taskId, slug });
  return namespace ? path.join(base, namespace) : base;
}

module.exports = { resolveFeature, resolveTaskScope, taskStoreDir, setDefaultSlug, clearTaskScopeCache, isSafeSlug, invalidSlugRefusal, slugNamesNoFeature };
