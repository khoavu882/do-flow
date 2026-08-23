'use strict';

// harness-paths.js — the one validator and resolver for the native path facts DoFlow declares in
// core/registry/harnesses.json under each harness's "paths" section (Stage 3 of the structure
// refactor). Adapters consume these declarations through resolveHarnessPaths() instead of
// hardcoding directory joins; whatever cannot be expressed here without branching (env-var
// overrides, conditional user directories, content-embedded placeholders) stays in its adapter
// behind an inline justification comment naming why it cannot be declared.
//
// The schema is deliberately minimal — no template engine, no expression language, no string
// interpolation beyond plain segment joins:
//
//   "paths": {
//     "<surface>": <rule>                                    — same rule for both scopes
//                 | { "project": <rule>, "user": <rule> }    — per-scope rules; an omitted scope
//                                                              resolves to null (the surface
//                                                              genuinely does not exist there)
//   }
//
//   <rule> ::= { "base": "root" | "home", "segments": ["<segment>", ...] }
//
// "root" is the scope's install root: the project directory at project scope, the home directory
// at user scope (adapters historically name that same value scopeRoot at user scope). "home" is
// always the home directory. Segments are plain single path segments — no separators, no "..".
// XDG-style directories (~/.config/opencode) are just home-rooted segment joins: no adapter in
// this repository consults $XDG_* today, so the schema carries no xdg base rather than declaring
// vocabulary nothing reads.

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('./repo-root');

const PATH_BASES = new Set(['root', 'home']);
const SURFACE_NAME = /^[a-z][a-zA-Z0-9]*$/;
const SEGMENT = /^(?!\.\.$)[^\\/]+$/;
const SCOPES = ['project', 'user'];

function issue(errors, location, message) { errors.push(`${location}: ${message}`); }

/** Validate one {base, segments} rule. Returns errors via the pushed array. */
function validateRule(rule, location, errors) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    issue(errors, location, 'must be an object'); return;
  }
  for (const key of Object.keys(rule)) {
    if (!['base', 'segments'].includes(key)) issue(errors, location, `unsupported key '${key}'`);
  }
  if (!PATH_BASES.has(rule.base)) issue(errors, location, `base must be one of ${[...PATH_BASES].join(', ')}`);
  const segments = rule.segments;
  if (!Array.isArray(segments) || segments.some((segment) => typeof segment !== 'string' || !SEGMENT.test(segment))) {
    issue(errors, location, "segments must be an array of plain single path segments (no '/', no '\\', no '..')");
  }
}

/** Validate one harness's whole paths section. Unknown keys and malformed rules are rejected
 * loudly: a typo'd declaration must fail the registry load, not silently fall back to whatever
 * the adapter used to hardcode. Returns an array of error messages (empty when valid). */
function validatePathsSection(section, location) {
  const errors = [];
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    return [`${location}: must be an object`];
  }
  for (const [name, value] of Object.entries(section)) {
    const at = `${location}.${name}`;
    if (!SURFACE_NAME.test(name)) { issue(errors, at, `surface name '${name}' must be camelCase`); continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { issue(errors, at, 'must be an object'); continue; }
    const hasBase = value.base !== undefined || value.segments !== undefined;
    const scopedKeys = SCOPES.filter((scope) => value[scope] !== undefined);
    const knownKeys = [...SCOPES, 'base', 'segments'];
    for (const key of Object.keys(value)) {
      if (!knownKeys.includes(key)) issue(errors, at, `unsupported key '${key}'`);
    }
    if (hasBase && scopedKeys.length) {
      issue(errors, at, 'must be either a single {base, segments} rule or per-scope {project, user} rules, not both');
      continue;
    }
    if (hasBase) { validateRule(value, at, errors); continue; }
    if (!scopedKeys.length) { issue(errors, at, `requires a rule or at least one of ${SCOPES.join('/')}`); continue; }
    for (const scope of scopedKeys) validateRule(value[scope], `${at}.${scope}`, errors);
  }
  return errors;
}

/** Resolve one rule to an absolute path. */
function resolveRule(rule, { root, home }) {
  const base = rule.base === 'home' ? home : root;
  return path.join(base, ...(rule.segments || []));
}

/**
 * Resolve a harness's declared paths section against runtime scope inputs.
 * `scope` accepts the adapters' historical spellings ('global' == 'user').
 * Returns { <surface>: absolutePath | null } — null when the scope has no rule for a surface —
 * plus `root`, the scope's install root itself (an input, not a declaration).
 */
function resolveHarnessPaths(section, { scope, scopeRoot, homeDir } = {}) {
  const userScope = scope === 'user' || scope === 'global';
  const home = path.resolve(homeDir || scopeRoot);
  const root = userScope ? home : path.resolve(scopeRoot);
  const resolved = { root };
  for (const [name, value] of Object.entries(section || {})) {
    const rule = (value.base !== undefined || value.segments !== undefined)
      ? value
      : (value[userScope ? 'user' : 'project'] ?? null);
    resolved[name] = rule ? resolveRule(rule, { root, home }) : null;
  }
  return resolved;
}

let declaredCache;
/** Every harness's declared paths section, keyed by harness id, read straight from
 * core/registry/harnesses.json (memoized per process — the file ships inside the package).
 * Adapters default their factories to this, so a factory called with no arguments and the CLI
 * wiring in src/cli/shared.js#buildAdapterRegistry consume byte-identical declarations. */
function declaredHarnessPaths(repoRoot = REPO_ROOT) {
  if (declaredCache && declaredCache.repoRoot === path.resolve(repoRoot)) return declaredCache.paths;
  const file = path.join(path.resolve(repoRoot), 'core', 'registry', 'harnesses.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const paths = Object.fromEntries((parsed.harnesses || []).map((harness) => [harness.id, harness.paths ?? {}]));
  declaredCache = { repoRoot: path.resolve(repoRoot), paths };
  return paths;
}

module.exports = { PATH_BASES, validatePathsSection, resolveHarnessPaths, declaredHarnessPaths };
