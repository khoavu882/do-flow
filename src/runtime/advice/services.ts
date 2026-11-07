'use strict';

const path = require('node:path');
const { createAdviceClient } = require('./client.ts');
const { loadStorageRegistry } = require('../storage/registry.ts');
const { resolveRoots } = require('../storage/roots.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

/**
 * The store roots every advice call site hands the advice client and the dispatcher (`services.roots`). Without them
 * the client resolves its setting from nothing and answers `off`, so each call site passes these rather than relying
 * on a default. Throws when the storage registry cannot be loaded; a caller keeps its own catch.
 */
function resolveAdviceRoots({ projectRoot, env, repoRoot = REPO_ROOT }: { projectRoot: string; env?: Record<string, string | undefined>; repoRoot?: string }): Record<string, string | null> {
  return resolveRoots({ registry: loadStorageRegistry({ repoRoot }), projectRoot: path.resolve(projectRoot), env });
}

/**
 * The dispatcher services (`interceptDecisionPoint`'s second argument) for a hook that is handed none of its own: the
 * caller's `svc` (a test seam) wins field by field, and `roots` and `adviceClient` are otherwise built the way the
 * classify, review and brief call sites build them. Without them the dispatcher's default client resolves its setting
 * from no roots and answers `off`, so the hook would make no call and record nothing.
 */
function withAdviceServices({ svc, adviceRegistry, projectRoot, env }: { svc: any; adviceRegistry: any; projectRoot: string; env?: Record<string, string | undefined> }): any {
  const roots = svc.roots || resolveAdviceRoots({ projectRoot, env });
  const adviceClient = svc.adviceClient || createAdviceClient({ adviceRegistry, roots, fsImpl: svc.fsImpl });
  return { ...svc, roots, adviceClient };
}

module.exports = { resolveAdviceRoots, withAdviceServices };
