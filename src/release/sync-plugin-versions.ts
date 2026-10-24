'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

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
const { REPO_ROOT } = require('../helper/repo-root.ts');
const { contentDigest } = require('../runtime/packages/digest.ts');

/** Every distribution manifest that repeats the release version, relative to the repo root. */
const PLUGIN_MANIFESTS = [
  'core/.codex-plugin/plugin.json',
  'core/.claude-plugin/plugin.json',
  'core/.plugin/plugin.json',
];

/** The point registry that lists the bundled first-party packages (122 IC-015), relative to the repo root. */
const POINTS_FILE = 'core/registry/contribution-points.json';

/**
 * 122 PN-8: a bundled package's manifest repeats the release version (`version`, and `doflow` as the exact range
 * `=<version>`), and its directory's content digest is pinned in `contribution-points.json`. A bump changes the
 * manifest bytes, so the three move together: rewrite the manifest, hash the directory, pin the digest. Returns the
 * files it rewrote. Targeted replacement keeps the formatting of both files.
 */
function syncBundledPackages(version: string, repoRoot: string, fsImpl: any): string[] {
  const pointsFile = path.join(repoRoot, POINTS_FILE);
  let pointsText = fsImpl.readFileSync(pointsFile, 'utf8');
  const points = JSON.parse(pointsText);
  const rewritten: string[] = [];
  for (const entry of points.bundled) {
    const manifestRel = path.posix.join(entry.dir, 'doflow-package.json');
    const manifestFile = path.join(repoRoot, manifestRel);
    const text = fsImpl.readFileSync(manifestFile, 'utf8');
    const next = text
      .replace(/("version":\s*")[^"]*"/, (_m: string, head: string) => `${head}${version}"`)
      .replace(/("doflow":\s*")[^"]*"/, (_m: string, head: string) => `${head}=${version}"`);
    if (next !== text) {
      fsImpl.writeFileSync(manifestFile, next, 'utf8');
      rewritten.push(manifestRel);
    }
    const digest = contentDigest(path.join(repoRoot, entry.dir), { limits: points.limits, fsImpl });
    if (digest !== entry.contentDigest) {
      pointsText = pointsText.replace(entry.contentDigest, digest);
      rewritten.push(POINTS_FILE);
    }
  }
  if (rewritten.includes(POINTS_FILE)) fsImpl.writeFileSync(pointsFile, pointsText, 'utf8');
  return [...new Set(rewritten)];
}

/**
 * Rewrites each plugin manifest's version to package.json's, preserving formatting by targeted
 * string replacement rather than re-serializing the whole file. The bundled packages follow (`bundled`).
 * @param {Object} [options]
 * @param {string} [options.repoRoot]
 * @param {Object} [options.fsImpl]
 * @returns {{version: string, updated: Array<string>, unchanged: Array<string>, bundled: Array<string>}}
 */
function syncPluginVersions({ repoRoot = REPO_ROOT, fsImpl = fs }: { repoRoot?: string, fsImpl?: any } = {}): { version: string, updated: string[], unchanged: string[], bundled: string[] } {
  const pkg = JSON.parse(fsImpl.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string' || pkg.version.trim() === '') {
    throw new Error('package.json declares no version to project');
  }

  const updated: string[] = [];
  const unchanged: string[] = [];
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
  return { version: pkg.version, updated, unchanged, bundled: syncBundledPackages(pkg.version, repoRoot, fsImpl) };
}

if (require.main === module) {
  const result = syncPluginVersions();
  for (const rel of [...result.updated, ...result.bundled]) console.log(`synced ${rel} -> ${result.version}`);
  if (result.updated.length === 0 && result.bundled.length === 0) console.log(`all plugin manifests and bundled packages already at ${result.version}`);
}

module.exports = { syncPluginVersions, PLUGIN_MANIFESTS, POINTS_FILE };
