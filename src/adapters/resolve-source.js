'use strict';

const path = require('node:path');

/** Resolve a registry-declared source path against the repo root, refusing escapes. Shared by the
 * common projection module and by per-adapter native-projection normalizers, which is why it lives
 * in its own module rather than in index.js — a normalizer importing index.js would be a cycle. */
function resolveRegistrySource(registry, source, label) {
  if (typeof registry.repoRoot !== 'string' || !registry.repoRoot) throw new Error(`Registry repoRoot is required for ${label}`);
  if (typeof source !== 'string' || !source) throw new Error(`Registry ${label} source is required`);
  const root = path.resolve(registry.repoRoot);
  const resolved = path.resolve(root, source);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Registry ${label} source escapes repository: ${source}`);
  return resolved;
}

module.exports = { resolveRegistrySource };
