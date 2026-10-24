'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');

/** Resolve a registry-declared source path against the repo root, refusing escapes. Shared by the
 * common projection module and by per-adapter native-projection normalizers, which is why it lives
 * in its own module rather than in index.js — a normalizer importing index.js would be a cycle.
 * `sourceRoot` checks containment against that root using real paths, as required by IC-017.
 * When omitted, the existing lexical repository-root check is preserved. */
function resolveRegistrySource(registry: any, source: any, label: string, sourceRoot?: string): string {
  if (sourceRoot !== undefined) {
    if (typeof sourceRoot !== 'string' || !sourceRoot) {
      throw new Error(`Registry ${label} sourceRoot must be a non-empty string`);
    }
    if (typeof source !== 'string' || !source) throw new Error(`Registry ${label} source is required`);
    let realRoot: string;
    let realSource: string;
    try {
      realRoot = fs.realpathSync(path.resolve(sourceRoot));
      realSource = fs.realpathSync(path.resolve(sourceRoot, source));
    } catch (error: any) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        throw new Error(`Registry ${label} source is missing under source root: ${source}`);
      }
      throw error;
    }
    if (!realSource.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`Registry ${label} source escapes source root: ${source}`);
    }
    return realSource;
  }
  if (typeof registry.repoRoot !== 'string' || !registry.repoRoot) throw new Error(`Registry repoRoot is required for ${label}`);
  if (typeof source !== 'string' || !source) throw new Error(`Registry ${label} source is required`);
  const root = path.resolve(registry.repoRoot);
  const resolved = path.resolve(root, source);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Registry ${label} source escapes repository: ${source}`);
  return resolved;
}

module.exports = { resolveRegistrySource };
