'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const featureResolve = require('./feature-resolve.ts');

// Which feature a task record belongs to (feature 045 IC-001/IC-002, 115 IC-004).
//
// Task ids are short and repeat across features (`A.1` exists in every feature that has a Phase A),
// and the stores key records by the bare id. Every task record therefore lives under a subdirectory
// named for its feature whenever a feature slug resolves (`--slug`, else the branch's), with or
// without a decision register and wherever the feature folder is; a task id that is the feature's
// own slug, and a call with no feature at all, keep the flat layout. Records written flat before
// this rule stay readable in place: a namespaced read falls back to the flat file when it is this
// feature's or names no feature, and the first write lands in the namespace (D-3). Nothing is moved.

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

/** projectRoot -> the branch's feature slug or null. One resolver spawn per root per process. */
const featureCache = new Map<string, string | null>();

/** The resolver's raw answer, including thrown failures, shared by every consumer in this process. */
const resolvedFeatureCache = new Map<string, { value: any } | { error: unknown }>();

/** The record slug of the CLI call in progress (115 C-1): `--slug`, else the feature of the checkout
 * the verb runs in, computed once by the dispatcher (a function is called on first use, then kept)
 * and used by every store the call touches. `undefined` means no dispatcher call is in progress, and
 * a store resolves the branch of its own project root. */
let callSlug: string | null | undefined | (() => string | null) = undefined;

function setRecordSlug(slug: string | null | undefined | (() => string | null)): void {
  callSlug = slug === undefined || typeof slug === 'function' ? slug : (isSafeSlug(slug) ? slug : null);
}

function currentCallSlug(): string | null | undefined {
  if (typeof callSlug === 'function') {
    let value: any = null;
    try { value = callSlug(); } catch { /* a failed lookup routes nothing to a guessed feature */ }
    callSlug = isSafeSlug(value) ? value : null;
  }
  return callSlug as string | null | undefined;
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
    // The branch's answer is also the answer for its own slug named explicitly: one spawn serves both.
    const named = !slug && !value?.error ? value?.paths?.feature_slug : null;
    if (isSafeSlug(named)) {
      const namedKey = `${path.resolve(projectRoot)}\0${named}`;
      if (!resolvedFeatureCache.has(namedKey)) resolvedFeatureCache.set(namedKey, { value });
    }
    return value;
  } catch (error) {
    resolvedFeatureCache.set(key, { error });
    throw error;
  }
}

/** Whether a branch or a feature folder could name a feature here: a `.git` or an
 * `agent-docs/doflow` above the root. With neither the resolver has nothing to read and is skipped. */
function mayNameFeature(projectRoot: string): boolean {
  for (let dir = path.resolve(projectRoot); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'agent-docs', 'doflow'))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

/** The feature slug the resolver gives for a root's branch (or its one feature folder), else null. */
function branchSlugFor(projectRoot: string): string | null {
  const key = path.resolve(projectRoot);
  if (featureCache.has(key)) return featureCache.get(key)!;
  let value: string | null = null;
  try {
    if (mayNameFeature(projectRoot)) {
      const found = resolveFeature({ projectRoot });
      if (!found.error && found.paths && isSafeSlug(found.paths.feature_slug)) value = found.paths.feature_slug;
    }
  } catch { /* a resolver failure is "no feature", never an exception */ }
  featureCache.set(key, value);
  return value;
}

/**
 * The feature a call's records are keyed by when no `--slug` is given (115 C-1), as
 * `featureSlugFor` names it but through the cached resolver: a task id that names a feature folder in
 * the checkout is its own feature, else the branch's.
 * @param {{projectRoot: string, taskId?: string|null}} options
 * @returns {string|null}
 */
function callerFeatureSlug({ projectRoot, taskId = null }: { projectRoot: string; taskId?: string | null }): string | null {
  if (isSafeSlug(taskId)) {
    try { if (fs.statSync(path.join(projectRoot, 'agent-docs', 'doflow', taskId as string)).isDirectory()) return taskId as string; } catch { /* not a folder */ }
  }
  return branchSlugFor(projectRoot);
}

/**
 * @param {Object} options
 * @param {string} options.projectRoot
 * @param {string} options.taskId
 * @param {string|null} [options.slug] explicit feature; otherwise the call's record slug, then the branch
 * @returns {{namespace: string|null, slug: string|null, reason: string}}
 *   `reason` is `namespaced` when a namespace applies, else `no-feature` or `feature-level-id`.
 */
function resolveTaskScope({ projectRoot, taskId, slug = null }: { projectRoot: string; taskId: string; slug?: string | null }): { namespace: string | null; slug: string | null; reason: string } {
  const call = slug ? undefined : currentCallSlug();
  const feature = slug ? (isSafeSlug(slug) ? slug : null) : call !== undefined ? call : branchSlugFor(projectRoot);
  if (!feature) return { namespace: null, slug: null, reason: 'no-feature' };
  if (taskId === feature) return { namespace: null, slug: feature, reason: 'feature-level-id' };
  return { namespace: feature, slug: feature, reason: 'namespaced' };
}

/**
 * Whether a flat record may be read as `slug`'s (D-3): it names that feature (`featureSlug` on a
 * run, `slug` on a readiness record) or names none. A file that does not parse names nobody, so a
 * namespaced read never falls back to it.
 * @param {string} file
 * @param {string|null} slug
 * @param {Object} [fsImpl]
 * @returns {boolean}
 */
function flatRecordIsOurs(file: string, slug: string | null, fsImpl: any = fs): boolean {
  let data: any;
  try { data = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return false; }
  const named = [data?.featureSlug, data?.slug].find((value) => typeof value === 'string' && value !== '');
  return named === undefined || named === slug;
}

/**
 * The directory a task's record file for one store is written in (IC-002, 115 IC-004).
 * @param {Object} options
 * @param {string} options.projectRoot
 * @param {string} options.store state subdirectory: evidence | research | outcome | retrieval | ...
 * @param {string} options.taskId
 * @param {string|null} [options.slug]
 * @returns {string}
 */
function taskStoreDir({ projectRoot, store, taskId, slug = null }: { projectRoot: string; store: string; taskId: string; slug?: string | null }): string {
  const base = path.join(projectRoot, '.doflow', 'state', store);
  const { namespace } = resolveTaskScope({ projectRoot, taskId, slug });
  return namespace ? path.join(base, namespace) : base;
}

/**
 * One task record (115 C-1, D-3): `file`, where it is written (always the namespace when one
 * applies); `read`, where it is read from (that file when it exists, else a flat file of the same
 * name that `flatRecordIsOurs`); and `seed`, a `prepare` for the write lock that starts a namespaced
 * file not written yet from that flat one, so a store that rebuilds from disk keeps what it read.
 * @param {Object} options
 * @param {string} options.projectRoot
 * @param {string} options.store
 * @param {string} options.taskId
 * @param {string|null} [options.slug]
 * @param {string} [options.name] the file name (default `<taskId>.json`)
 * @param {Object} [options.fsImpl]
 * @returns {{file: string, read: string, seed: () => void}}
 */
function taskRecord({ projectRoot, store, taskId, slug = null, name = null, fsImpl = fs }: any): { file: string; read: string; seed: () => void } {
  const scope = resolveTaskScope({ projectRoot, taskId, slug });
  return recordIn({ base: path.join(projectRoot, '.doflow', 'state', store), namespace: scope.namespace, name: name || `${taskId}.json`, fsImpl });
}

/**
 * `taskRecord` for a store directory and a namespace already known (the orchestrator's run journal).
 * @param {{base: string, namespace: string|null, name: string, fsImpl?: Object}} options
 * @returns {{file: string, read: string, seed: () => void}}
 */
function recordIn({ base, namespace, name, fsImpl = fs }: any): { file: string; read: string; seed: () => void } {
  const file = path.join(base, ...(namespace ? [namespace] : []), name);
  const flat = path.join(base, name);
  const fallback = (): string | null => (namespace && !fsImpl.existsSync(file) && fsImpl.existsSync(flat)
    && flatRecordIsOurs(flat, namespace, fsImpl) ? flat : null);
  const seed = () => {
    const from = fallback();
    // Required on use: the record mover (a declared writer of every task store) loads the storage registry.
    if (from) require('./state-root.ts').placeRecord(file, fsImpl.readFileSync(from), fsImpl);
  };
  return { file, read: fallback() || file, seed };
}

/**
 * Whether an explicit, well-formed slug names no feature folder in any of the given checkouts. The
 * records still go under that slug; a typo would start a namespace nobody reads, which is worth one
 * line to the caller.
 * @param {Object} options
 * @param {Array<string>} options.projectRoots
 * @param {string} options.slug
 * @returns {boolean}
 */
function slugNamesNoFeature({ projectRoots, slug }: { projectRoots: string[]; slug: string }): boolean {
  return !projectRoots.some((projectRoot) => {
    try {
      const found = resolveFeature({ projectRoot, slug });
      return !found.error && fs.existsSync(found.featureDir);
    } catch { return false; }
  });
}

module.exports = { resolveFeature, resolveTaskScope, taskStoreDir, taskRecord, recordIn, flatRecordIsOurs, setRecordSlug, callerFeatureSlug, clearTaskScopeCache, isSafeSlug, invalidSlugRefusal, slugNamesNoFeature };
