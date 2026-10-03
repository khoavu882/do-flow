'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveActiveFeature } = require('./feature-resolve');

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
function isSafeSlug(slug) {
  return typeof slug === 'string' && SAFE_SLUG.test(slug) && !slug.includes('..');
}

/**
 * The refusal for a slug that fails the shape check, in the shape do-paths.sh prints, or null when
 * the slug is fine or was not given.
 * @param {*} slug
 * @returns {{error: 'invalid-slug', message: string, hint: string}|null}
 */
function invalidSlugRefusal(slug) {
  if (typeof slug !== 'string' || slug === '' || isSafeSlug(slug)) return null;
  return { error: 'invalid-slug', message: `slug "${slug}" is not a valid feature slug: ${SLUG_RULE}`, hint: SLUG_RULE };
}

/** (projectRoot, slug) -> { slug, hasRegister } | { reason }. One resolver spawn per key per process. */
const featureCache = new Map();

/** A slug the CLI named explicitly (`--slug`), applied to every store call in this process that was
 * not given its own. The dispatcher sets it once so the verbs whose handlers build their ledger
 * internally (readiness, evidence) route the same way as the ones that take `slug` directly. */
let defaultSlug = null;

function setDefaultSlug(slug) {
  defaultSlug = typeof slug === 'string' && slug !== '' ? slug : null;
}

function clearTaskScopeCache() {
  featureCache.clear();
}

/** The resolver reports the git top level, which is the project root or one of its ancestors, and
 * the feature folders live directly under it — so no `agent-docs/doflow` on the way up means there
 * is nothing to resolve and the spawn is skipped. */
function hasFeatureFolderAbove(projectRoot) {
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

function featureFor(projectRoot, slug) {
  const key = `${path.resolve(projectRoot)}\0${slug || ''}`;
  if (featureCache.has(key)) return featureCache.get(key);
  let value = { reason: 'no-feature' };
  try {
    if (hasFeatureFolderAbove(projectRoot)) {
      const found = resolveActiveFeature({ projectRoot, slug: slug || null });
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
function resolveTaskScope({ projectRoot, taskId, slug = null }) {
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
function slugNamesNoFeature({ projectRoot, slug }) {
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
function taskStoreDir({ projectRoot, store, taskId, slug = null }) {
  const base = path.join(projectRoot, '.doflow', 'state', store);
  const { namespace } = resolveTaskScope({ projectRoot, taskId, slug });
  return namespace ? path.join(base, namespace) : base;
}

module.exports = { resolveTaskScope, taskStoreDir, setDefaultSlug, clearTaskScopeCache, isSafeSlug, invalidSlugRefusal, slugNamesNoFeature };
