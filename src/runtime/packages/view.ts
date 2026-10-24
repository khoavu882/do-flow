'use strict';

/**
 * The package view (122 IC-010): the effective state of every package, read-only, with no network, no
 * harness and no model call. Phase A holds the bundled first-party packages only, those listed in
 * `contribution-points.json` `bundled`; the lock, grants and store belong to later Phase B tasks, so `now`
 * is accepted and not read yet, while `settingsView` and `env` feed the `packages.disabled` overlay below.
 *
 * The resolved `packages.disabled` setting (IC-011) is applied last, over the memoised states: a listed id is `disabled`
 * with reason `disabled-by-<layer>`, and an invalid value disables every non-bundled package with `settings-invalid`
 * (PN-7, fail closed). The bundled package can be disabled by the person like any other. A caller passes
 * `settingsView['packages.disabled']` (`{ value, layer, state?, byId? }`); with none, the project settings of the working
 * directory are read, unless `fsImpl` is injected, which keeps the view hermetic.
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
const { parseSemVer } = require('../../helper/semver.ts');
const { loadPoints, pointRows } = require('./points.ts');
const { checkManifest, MANIFEST_FILE } = require('./manifest.ts');

const TIER_ORDER = ['inert', 'instruction', 'executable'];
const memo = new Map<string, any>();

/**
 * The running DoFlow version. A checkout or the npm package has `<repoRoot>/package.json`, read first. A projected
 * runtime (`<scope root>/.doflow/runtime`) ships none, but the install recorded the version in the lock it wrote beside
 * it, so `<scope root>/.doflow/doflow.lock` `sourceVersion` (set from the installing DoFlow's package.json) is read
 * instead, only for that layout and only when it is semver. The lock is parsed directly: `readLock` validates the whole
 * document and throws, where one field is all this needs. Anything else is null, which the checker reports as
 * host-incompatible (fail closed).
 */
function hostVersion(repoRoot: string): string | null {
  try { return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version || null; } catch { /* no package.json: try the lock */ }
  const parent = path.dirname(path.resolve(repoRoot));
  if (path.basename(path.resolve(repoRoot)) !== 'runtime' || path.basename(parent) !== '.doflow') return null;
  try {
    const version = JSON.parse(fs.readFileSync(path.join(parent, 'doflow.lock'), 'utf8')).sourceVersion;
    return typeof version === 'string' && parseSemVer(version) ? version : null;
  } catch { return null; }
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

const DISABLED_KEY = 'packages.disabled';

/**
 * The `packages.disabled` entry of the project settings of the working directory, in the shape a caller injects.
 * `byId` names the lowest layer that listed each id. A registry or settings fault is an invalid value: fail closed.
 */
function resolvedDisabledEntry(env: any): any {
  try {
    const resolution = require('../settings/resolve.ts').loadSettings({ projectRoot: process.cwd(), env: env ?? process.env }).get(DISABLED_KEY);
    const byId: Record<string, string> = {};
    for (const c of resolution.candidates) {
      if (c.status !== 'decided' || !Array.isArray(c.value)) continue;
      for (const id of c.value) byId[id] ??= c.layer;
    }
    return { value: resolution.value, layer: resolution.origin.layer, state: resolution.state, byId };
  } catch {
    return { value: null, layer: 'default', state: 'invalid' };
  }
}

/**
 * The packages with the `packages.disabled` entry applied (IC-010 state 3). Only a package that would be `active` or
 * `needs-trust` changes: `incompatible` and `suspended` outrank `disabled`. Returns `packages` itself when nothing changes.
 */
function applySettingsDisable(packages: any[], entry: any): any[] {
  if (!entry) return packages;
  const invalid = entry.state === 'invalid';
  const listed = new Set<string>(!invalid && Array.isArray(entry.value) ? entry.value : []);
  const reasonFor = (pkg: any): string | null => {
    if (invalid) return pkg.source?.type === 'bundled' ? null : 'settings-invalid';
    return listed.has(pkg.id) ? `disabled-by-${entry.byId?.[pkg.id] ?? entry.layer}` : null;
  };
  let changed = false;
  const out = packages.map((pkg: any) => {
    const reason = pkg.state === 'active' || pkg.state === 'needs-trust' ? reasonFor(pkg) : null;
    if (reason === null) return pkg;
    changed = true;
    return { ...pkg, state: 'disabled', reasons: [reason], contributions: pkg.contributions.map((c: any) => ({ ...c, active: false })) };
  });
  return changed ? out : packages;
}

/**
 * `{ packages, points, findings }`. `repoRoot` and `fsImpl` are for tests and the verbs; an injected `fsImpl`
 * bypasses the memo. A point registry that cannot be read leaves no bundled package to find: `packages` and
 * `points` are empty and the one finding is `state-unreadable` on `points`.
 */
function packageView({ settingsView, env, fsImpl = fs, repoRoot = REPO_ROOT }: { settingsView?: any; env?: any; fsImpl?: any; now?: any; repoRoot?: string } = {}): { packages: any[]; points: any[]; findings: any[] } {
  const base = baseView(repoRoot, fsImpl);
  const entry = settingsView ? settingsView[DISABLED_KEY] : fsImpl === fs ? resolvedDisabledEntry(env) : undefined;
  const packages = applySettingsDisable(base.packages, entry);
  return packages === base.packages ? base : { ...base, packages };
}

/** The states before any setting is applied; memoised per runtime root for the real file system. */
function baseView(repoRoot: string, fsImpl: any): { packages: any[]; points: any[]; findings: any[] } {
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

module.exports = { packageView, resetPackageView, hostVersion, applySettingsDisable };
