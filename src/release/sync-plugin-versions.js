'use strict';

// ── One release version, projected into every distribution manifest ─────────────────────────────
//
// package.json is the single source of the release version. The three plugin manifests (Codex,
// Claude, Copilot) each repeat it, and v1.2.1 shipped with all three still reading 1.2.0 — the
// guard tests comparing them were failing correctly (architecture review R8). Hand-editing four
// files in step is exactly the drift class this repo removes elsewhere by generation, so the
// npm `version` lifecycle hook runs this script: `npm version <bump>` rewrites the manifests and
// stages them into the same release commit. The equality guards in test/install/doflow.test.js
// stay as the independent check that the projection actually happened.

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../helper/repo-root');

/** Every distribution manifest that repeats the release version, relative to the repo root. */
const PLUGIN_MANIFESTS = [
  'core/.codex-plugin/plugin.json',
  'core/.claude-plugin/plugin.json',
  'core/.plugin/plugin.json',
];

/**
 * Rewrites each plugin manifest's version to package.json's, preserving formatting by targeted
 * string replacement rather than re-serializing the whole file.
 * @param {Object} [options]
 * @param {string} [options.repoRoot]
 * @param {Object} [options.fsImpl]
 * @returns {{version: string, updated: Array<string>, unchanged: Array<string>}}
 */
function syncPluginVersions({ repoRoot = REPO_ROOT, fsImpl = fs } = {}) {
  const pkg = JSON.parse(fsImpl.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string' || pkg.version.trim() === '') {
    throw new Error('package.json declares no version to project');
  }

  const updated = [];
  const unchanged = [];
  for (const rel of PLUGIN_MANIFESTS) {
    const file = path.join(repoRoot, rel);
    const text = fsImpl.readFileSync(file, 'utf8');
    const manifest = JSON.parse(text);
    if (manifest.version === pkg.version) {
      unchanged.push(rel);
      continue;
    }
    const next = text.replace(/"version":\s*"[^"]*"/, `"version": "${pkg.version}"`);
    if (!/"version":\s*"/.test(text)) {
      throw new Error(`${rel} has no version field to rewrite — the manifest shape changed; update PLUGIN_MANIFESTS`);
    }
    fsImpl.writeFileSync(file, next, 'utf8');
    updated.push(rel);
  }
  return { version: pkg.version, updated, unchanged };
}

if (require.main === module) {
  const result = syncPluginVersions();
  for (const rel of result.updated) console.log(`synced ${rel} -> ${result.version}`);
  if (result.updated.length === 0) console.log(`all plugin manifests already at ${result.version}`);
}

module.exports = { syncPluginVersions, PLUGIN_MANIFESTS };
