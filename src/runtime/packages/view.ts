'use strict';

/**
 * The package view (122 IC-010): the effective state of every package, read-only, with no network, no
 * harness and no model call. Phase A holds the bundled first-party packages only, those listed in
 * `contribution-points.json` `bundled`; the lock, grants, settings and store belong to Phase B, so
 * `settingsView`, `env` and `now` are accepted and not read yet.
 *
 * A bundled package is `active` unless its directory or manifest is missing or invalid, then `incompatible`
 * with IC-004 reason codes. It is trusted at runtime and verified at release (IC-015): only the manifest's shape
 * and lexical paths are checked here (no contribution file is read, nothing under `core/shared` is needed), and
 * its tree is never re-hashed (guard G68 checks the registry digest); `contentDigest` is the registry's value.
 * The projected runtime ships no `package.json`, so the host version of a bundled package then falls back to the
 * package's own manifest `version` (PN-8 keeps the two equal); a readable `package.json` that differs still
 * makes it `host-incompatible`. Each package is judged alone, so a fault in one never changes
 * another and the view itself never throws (FR-009). The result is memoised per process; `resetPackageView`
 * clears it for tests.
 */

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { loadPoints, pointRows } = require('./points.ts');
const { checkManifest, MANIFEST_FILE } = require('./manifest.ts');

const TIER_ORDER = ['inert', 'instruction', 'executable'];
const memo = new Map<string, any>();

/** The running DoFlow version; null when package.json is not shipped or unreadable, which the checker reports as host-incompatible. */
function hostVersion(repoRoot: string): string | null {
  try { return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version || null; } catch { return null; }
}

function finding(pkg: string | null, field: string, code: string, message: string, allowed: any): any {
  return { package: pkg, field, code, severity: 'error', message, allowed };
}

/** True when `target` is `root` itself or inside it. */
const within = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Resolve a bundled `dir` inside the runtime root; `{ error }` is the finding when it is missing or leaves the root. */
function bundledDir(repoRoot: string, entry: any, fsImpl: any): { dir?: string; error?: any } {
  const abs = path.resolve(repoRoot, entry.dir);
  const escapes = finding(entry.id, 'dir', 'path-escapes-root', `bundled dir '${entry.dir}' leaves the runtime root`, 'a directory inside the runtime root');
  if (!within(path.resolve(repoRoot), abs)) return { error: escapes };
  try {
    if (!fsImpl.statSync(abs).isDirectory()) return { error: finding(entry.id, 'dir', 'file-missing', `bundled dir '${entry.dir}' is not a directory`, 'a package directory') };
    if (!within(fsImpl.realpathSync(repoRoot), fsImpl.realpathSync(abs))) return { error: escapes };
  } catch {
    return { error: finding(entry.id, 'dir', 'file-missing', `bundled dir '${entry.dir}' does not exist`, 'a package directory') };
  }
  return { dir: abs };
}

/** The state of one bundled package. Never throws. */
function bundledState(entry: any, ctx: any): { state: any; findings: any[] } {
  const { repoRoot, fsImpl, pointsRegistry, host, bundledIds } = ctx;
  const tiers: Record<string, string> = Object.fromEntries(pointsRegistry.points.map((p: any) => [p.id, p.tier]));
  const state: any = {
    id: entry.id, version: null, source: { type: 'bundled' }, firstParty: true, tierMax: null, enabled: true,
    state: 'active', reasons: [], contributions: [], grant: { trust: true, exempt: false },
    contentDigest: entry.contentDigest, capabilityDigest: null, storeDir: null,
  };
  let findings: any[] = [];
  try {
    const located = bundledDir(repoRoot, entry, fsImpl);
    if (located.error) findings = [located.error];
    else {
      state.storeDir = located.dir;
      let text: string | null = null;
      try { text = fsImpl.readFileSync(path.join(located.dir as string, MANIFEST_FILE), 'utf8'); } catch { /* reported below */ }
      if (text === null) {
        findings = [finding(entry.id, MANIFEST_FILE, 'file-missing', `${MANIFEST_FILE} is missing`, `a ${MANIFEST_FILE} at the package root`)];
      } else {
        let manifest: any = null;
        try { manifest = JSON.parse(text); } catch { /* the checker reports it */ }
        const hostFor = host ?? (typeof manifest?.version === 'string' ? manifest.version : null);
        // `protocols` is unused for a bundled entry without `root`; passing it stops the checker from loading the
        // merged registry, which would build this view again.
        findings = checkManifest(text, { pointsRegistry, hostVersion: hostFor, bundled: bundledIds, repoRoot, fsImpl, protocols: { presets: {} } })
          .map((f: any) => ({ ...f, package: f.package ?? entry.id }));
        if (manifest && typeof manifest === 'object') {
          if (typeof manifest.version === 'string') state.version = manifest.version;
          if (manifest.id !== entry.id) {
            findings.push(finding(entry.id, 'id', 'bad-id', `manifest id ${JSON.stringify(manifest.id)} differs from the bundled id '${entry.id}'`, entry.id));
          }
          const list = Array.isArray(manifest.contributions) ? manifest.contributions : [];
          state.contributions = list.filter((c: any) => c && typeof c === 'object' && typeof c.point === 'string' && typeof c.id === 'string').map((c: any) => ({
            point: c.point, version: c.version, qualifiedId: c.id /* IC-003: the first-party package keeps bare built-in ids */, tier: tiers[c.point] ?? null, active: false,
          }));
          const ranks = state.contributions.map((c: any) => TIER_ORDER.indexOf(c.tier)).filter((r: number) => r >= 0);
          if (ranks.length > 0) state.tierMax = TIER_ORDER[Math.max(...ranks)];
        }
      }
    }
  } catch (error: any) {
    findings = [finding(entry.id, 'dir', 'state-unreadable', `cannot evaluate the bundled package: ${error?.message || String(error)}`, 'a readable package directory')];
  }
  const errors = findings.filter((f) => f.severity === 'error');
  if (errors.length > 0) {
    state.state = 'incompatible';
    state.reasons = [...new Set<string>(errors.map((f) => f.code))];
  }
  for (const c of state.contributions) c.active = state.state === 'active';
  return { state, findings };
}

/**
 * `{ packages, points, findings }`. `repoRoot` and `fsImpl` are for tests and the verbs; an injected `fsImpl`
 * bypasses the memo. A point registry that cannot be read leaves no bundled package to find: `packages` and
 * `points` are empty and the one finding is `state-unreadable` on `points`.
 */
function packageView({ repoRoot = REPO_ROOT, fsImpl = fs }: { settingsView?: any; env?: any; fsImpl?: any; now?: any; repoRoot?: string } = {}): { packages: any[]; points: any[]; findings: any[] } {
  const key = path.resolve(repoRoot);
  if (fsImpl === fs && memo.has(key)) return memo.get(key);
  const loaded = loadPoints({ repoRoot, fsImpl });
  let result: { packages: any[]; points: any[]; findings: any[] };
  if (!loaded.ok) {
    result = { packages: [], points: [], findings: [finding(null, 'points', 'state-unreadable', loaded.errors.join('; '), 'a readable point registry')] };
  } else {
    const pointsRegistry = loaded.registry;
    const ctx = { repoRoot, fsImpl, pointsRegistry, host: hostVersion(repoRoot), bundledIds: pointsRegistry.bundled.map((b: any) => b.id) };
    const packages: any[] = [];
    const findings: any[] = [];
    for (const entry of pointsRegistry.bundled) {
      const one = bundledState(entry, ctx);
      packages.push(one.state);
      findings.push(...one.findings);
    }
    result = { packages, points: pointRows(pointsRegistry), findings };
  }
  if (fsImpl === fs) memo.set(key, result);
  return result;
}

function resetPackageView(): void { memo.clear(); }

module.exports = { packageView, resetPackageView, hostVersion };
