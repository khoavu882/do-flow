'use strict';

/**
 * The package view (122 IC-010): the effective state of every package, read-only, with no network, no
 * harness and no model call. It holds the bundled first-party packages (those listed in
 * `contribution-points.json` `bundled`) and the third-party packages the global lock records
 * (`~/.doflow/doflow.lock` `packages`, stored at `~/.doflow/packages/store/<id>/<contentDigest first 16 hex>/`).
 *
 * A third-party package takes the first state that applies, in this order: `incompatible` (the manifest, a
 * contribution or the IC-005 tree fails the checker against the running core, or the host is outside its `doflow`
 * range with no matching `exempt` grant), `suspended` (the store entry or its manifest is missing, or the tree
 * re-hashes to another content digest: `content-changed`), `disabled` (the lock bit is false), `needs-trust` (the tier
 * is above inert and no valid `trust` grant exists), else `active`. Only an ENABLED entry is walked and re-hashed
 * (the IC-005 caps apply to that walk). A DISABLED entry is read no further than its manifest, which is
 * checked lexically (no contribution file, no tree walk, no digest), so a byte flip in a disabled entry shows once
 * it is enabled. With no third-party row nothing under the store, the grants file or `state.json` is read. The grants
 * (`readGrants`, IC-008) and revocations (`readState`, IC-009) are read once per build, only when a third-party row
 * exists; they and the lock are read and never written.
 *
 * The memo is keyed on everything the view reads: the runtime root, the home (lock, store, state), the config home
 * (grants), the project root and the temp dir (where the grants file may lie). A caller that injects `fsImpl`
 * bypasses it. `resetPackageView` clears it for tests.
 *
 * The resolved `packages.disabled` setting (IC-011) is applied last, over the memoised states: a listed id is `disabled`
 * with reason `disabled-by-<layer>`, and an invalid value disables every non-bundled package with `settings-invalid`
 * (PN-7, fail closed). The bundled package can be disabled by the person like any other. A caller passes
 * `settingsView['packages.disabled']` (`{ value, layer, state?, byId? }`); with none, the project settings of the working
 * directory are read, unless `fsImpl` is injected, which keeps the view hermetic.
 *
 * A bundled package is `active` unless its directory or manifest is missing or invalid, then `incompatible`
 * with IC-004 reason codes; a lock row with source `bundled` and `enabled: false` disables it. It is trusted at
 * runtime and verified at release (IC-015): only the manifest's shape
 * and lexical paths are checked here (no contribution file is read, nothing under `core/shared` is needed), and
 * its tree is never re-hashed (guard G68 checks the registry digest); `contentDigest` is the registry's value.
 * The projected runtime ships no `package.json`, so the host version of a bundled package then falls back to the
 * package's own manifest `version` (PN-8 keeps the two equal); a readable `package.json` that differs still
 * makes it `host-incompatible`. Each package is judged alone, so a fault in one never changes
 * another and the view itself never throws (FR-009).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { parseSemVer } = require('../../helper/semver.ts');
const { configHome } = require('../config-home.ts');
const { readLock, lockPackages } = require('../../state/lockfile.ts');
const { loadPoints, pointRows } = require('./points.ts');
const { checkManifest, checkPackage, MANIFEST_FILE } = require('./manifest.ts');
const { readGrants, detectedProjectRoot } = require('./grants.ts');
const { readState, grantRevoked } = require('./state.ts');
const { loadCoreProtocols } = require('../review/protocols.ts');

const TIER_ORDER = ['inert', 'instruction', 'executable'];
const memo = new Map<string, any>();
const fullMemo = new Map<string, any>();
// Building a third-party view loads the core protocol registry, whose validation asks for the first-party preset ids
// (`firstPartyPresets`), which asks for this view. A call made while one is being built gets the bundled-only view,
// which is all that question needs.
let building = 0;

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

/** The contributions a manifest names, as view rows (`active: false` until the state is known). `qualify` gives the qualified id. */
function contributionList(manifest: any, tiers: Record<string, string>, qualify: (c: any) => string): any[] {
  const list = Array.isArray(manifest?.contributions) ? manifest.contributions : [];
  return list.filter((c: any) => c && typeof c === 'object' && typeof c.point === 'string' && typeof c.id === 'string').map((c: any) => ({
    point: c.point, version: c.version, qualifiedId: qualify(c), tier: tiers[c.point] ?? null, active: false,
  }));
}

/** The highest tier among view contribution rows; null when none has a known tier. */
function tierMaxOf(contributions: any[]): string | null {
  const ranks = contributions.map((c: any) => TIER_ORDER.indexOf(c.tier)).filter((r: number) => r >= 0);
  return ranks.length > 0 ? TIER_ORDER[Math.max(...ranks)] : null;
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
          state.contributions = contributionList(manifest, tiers, (c: any) => c.id /* IC-003: the first-party package keeps bare built-in ids */);
          state.tierMax = tierMaxOf(state.contributions);
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

/** Why a `trust` grant does not hold for `state`, or null when one does. The first that applies: unreadable, missing, content, policy, capabilities, revoked. */
function trustReason(state: any, ctx: any): string | null {
  const { grants, stateRead, pointsRegistry } = ctx;
  if (stateRead.unreadable || grants.findings.some((f: any) => f.code === 'state-unreadable')) return 'state-unreadable';
  // Lines for one version with other digests coexist (IC-008 duplicate key): judge the one whose digests match, else
  // the one with the matching content digest, else any (each of those reads content-changed).
  const lines = grants.grants.filter((g: any) => g.grant === 'trust' && g.package === state.id && g.version === state.version);
  const grant = lines.find((g: any) => g.contentDigest === state.contentDigest && g.capabilityDigest === state.capabilityDigest)
    ?? lines.find((g: any) => g.contentDigest === state.contentDigest) ?? lines[0];
  if (!grant) return 'grant-missing';
  if (grant.contentDigest !== state.contentDigest) return 'content-changed';
  if (grant.policy < pointsRegistry.trustPolicyVersion) return 'policy-changed';
  if (grant.capabilityDigest !== state.capabilityDigest) return 'capabilities-changed';
  if (grantRevoked(stateRead, grant)) return 'revoked';
  return null;
}

/** The valid `exempt` grant for exactly this package version, content digest and host version (IC-008), or null. */
function exemptGrantFor(row: any, ctx: any): any {
  if (!ctx.host) return null;
  return ctx.grants.grants.find((g: any) => g.grant === 'exempt' && g.acceptRisk === true && g.package === row.id && g.version === row.version
    && g.contentDigest === row.contentDigest && g.host === ctx.host && !grantRevoked(ctx.stateRead, g)) ?? null;
}

/** The state of one third-party package (a lock row). Never throws. */
function thirdPartyState(row: any, ctx: any): { state: any; findings: any[] } {
  const { fsImpl, pointsRegistry } = ctx;
  const storeDir = path.join(ctx.storeRoot, row.id, row.contentDigest.slice(0, 16));
  const state: any = {
    id: row.id, version: row.version, source: row.source, firstParty: false, tierMax: null, enabled: row.enabled,
    state: 'active', reasons: [], contributions: [], grant: { trust: false, exempt: false },
    contentDigest: row.contentDigest, capabilityDigest: row.capabilityDigest, storeDir,
  };
  let findings: any[] = [];
  const settle = (name: string, reasons: string[]) => {
    state.state = name;
    state.reasons = reasons;
    for (const c of state.contributions) c.active = name === 'active';
    return { state, findings };
  };
  try {
    let text: string | null = null;
    try { text = String(fsImpl.readFileSync(path.join(storeDir, MANIFEST_FILE), 'utf8')); } catch { /* the store entry is missing */ }
    if (text === null) {
      findings = [finding(row.id, `store/${row.id}/${row.contentDigest.slice(0, 16)}`, 'file-missing', `the store entry for ${row.id} has no ${MANIFEST_FILE}`, 'an intact store entry')];
      return settle('suspended', ['content-changed']);
    }
    let manifest: any = null;
    try { manifest = JSON.parse(text); } catch { /* the checker reports it */ }
    const tiers: Record<string, string> = Object.fromEntries(pointsRegistry.points.map((p: any) => [p.id, p.tier]));
    if (manifest && typeof manifest === 'object') {
      state.contributions = contributionList(manifest, tiers, (c: any) => `${row.id}.${c.id}`);
      state.tierMax = tierMaxOf(state.contributions);
    }

    const exempt = exemptGrantFor(row, ctx);
    const options = { pointsRegistry, hostVersion: ctx.host, bundled: [], repoRoot: ctx.repoRoot, fsImpl, protocols: ctx.protocols, hostExempt: exempt !== null };
    let checked: any = null;
    if (row.enabled) {
      checked = checkPackage(storeDir, options);
      findings = checked.findings;
    } else {
      findings = checkManifest(text, options); // no `root`: the manifest alone, lexically; nothing else under the entry is read
    }
    findings = findings.map((f: any) => ({ ...f, package: f.package ?? row.id }));
    if (manifest && typeof manifest === 'object' && manifest.id !== row.id) {
      findings.push(finding(row.id, 'id', 'bad-id', `manifest id ${JSON.stringify(manifest.id)} differs from the recorded id '${row.id}'`, row.id));
    }
    const errors = findings.filter((f: any) => f.severity === 'error');
    if (errors.length > 0) return settle('incompatible', [...new Set<string>(errors.map((f: any) => f.code))]);
    state.grant.exempt = findings.some((f: any) => f.code === 'host-incompatible' && f.severity === 'warning');

    if (checked && checked.contentDigest !== row.contentDigest) {
      findings.push(finding(row.id, 'contentDigest', 'digest-mismatch', `the store entry for ${row.id} hashes to ${checked.contentDigest}, not the recorded ${row.contentDigest}`, 'the recorded content digest'));
      return settle('suspended', ['content-changed']);
    }
    if (checked) state.capabilityDigest = checked.capabilityDigest;
    if (!row.enabled) return settle('disabled', ['disabled-by-lock']);
    if (state.tierMax !== 'inert' && state.tierMax !== null) {
      const reason = trustReason(state, ctx);
      if (reason !== null) return settle('needs-trust', [reason]);
      state.grant.trust = true;
    }
    return settle('active', []);
  } catch (error: any) {
    findings = [finding(row.id, 'store', 'state-unreadable', `cannot evaluate the package: ${error?.message || String(error)}`, 'a readable store entry')];
    return settle('incompatible', ['state-unreadable']);
  }
}

/**
 * The bundled view plus the third-party packages of the global lock. Returns `bundled` itself when the lock holds
 * nothing that changes it. An unreadable lock adds one `state-unreadable` finding and no package.
 */
function withLock(bundled: { packages: any[]; points: any[]; findings: any[] }, o: any): { packages: any[]; points: any[]; findings: any[] } {
  let rows: any[];
  try {
    rows = lockPackages(readLock({ scope: 'global', homeDir: o.home }, { fsImpl: o.fsImpl }));
  } catch (error: any) {
    return { ...bundled, findings: [...bundled.findings, finding(null, 'doflow.lock', 'state-unreadable', error?.message || String(error), 'a readable doflow.lock')] };
  }
  let packages = bundled.packages.map((pkg: any) => {
    const row = rows.find((r: any) => r.id === pkg.id && r.source?.type === 'bundled');
    if (!row || row.enabled || pkg.state !== 'active') return pkg;
    return { ...pkg, enabled: false, state: 'disabled', reasons: ['disabled-by-lock'], contributions: pkg.contributions.map((c: any) => ({ ...c, active: false })) };
  });
  const thirdParty = rows.filter((r: any) => r.source?.type !== 'bundled');
  if (thirdParty.length === 0) return packages.some((p: any, i: number) => p !== bundled.packages[i]) ? { ...bundled, packages } : bundled;

  const loaded = loadPoints({ repoRoot: o.repoRoot, fsImpl: o.fsImpl });
  if (!loaded.ok) return { ...bundled, packages };
  const core = loadCoreProtocols({ repoRoot: o.repoRoot, fsImpl: o.fsImpl });
  const grants = readGrants({ env: o.env, fsImpl: o.fsImpl, projectRoot: o.projectRoot, ...(o.tmpDir === undefined ? {} : { tmpDir: o.tmpDir }) });
  const stateRead = readState({ homeDir: o.home, fsImpl: o.fsImpl });
  const ctx = {
    repoRoot: o.repoRoot, fsImpl: o.fsImpl, pointsRegistry: loaded.registry, host: hostVersion(o.repoRoot), grants, stateRead,
    protocols: core.ok ? core.registry : undefined, storeRoot: path.join(o.home, '.doflow', 'packages', 'store'),
  };
  const bundledIds = new Set<string>(bundled.packages.map((p: any) => p.id));
  const findings = [...bundled.findings, ...grants.findings, ...stateRead.findings];
  for (const row of thirdParty) {
    if (bundledIds.has(row.id)) {
      findings.push(finding(row.id, 'id', 'collision-package', `the lock records '${row.id}' from a ${row.source?.type} source, but that id belongs to a bundled package`, 'an id no bundled package uses'));
      continue;
    }
    const one = thirdPartyState(row, ctx);
    packages = [...packages, one.state];
    findings.push(...one.findings);
  }
  return { packages, points: bundled.points, findings };
}

const DISABLED_KEY = 'packages.disabled';

/**
 * The `packages.disabled` entry of the project settings of the working directory, in the shape a caller injects.
 * `byId` names the lowest layer that listed each id. A registry or settings fault is an invalid value: fail closed.
 * The settings are read as a view of this one key (`only`): a full load validates every key of a layer file, and the
 * `review.preset` and `debate.preset` value lists hold the presets of active packages (IC-014), which is this view
 * again. The key's own list (`packages.ids`) reads the lock alone, so this read never re-enters the view.
 */
function resolvedDisabledEntry(env: any): any {
  try {
    const resolution = require('../settings/resolve.ts').loadSettings({ projectRoot: process.cwd(), env: env ?? process.env, only: [DISABLED_KEY] }).get(DISABLED_KEY);
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
 * `{ packages, points, findings }`. `repoRoot`, `fsImpl`, `homeDir` (the account home, default: `HOME` of `env`, else
 * `os.homedir()`), `projectRoot` (default: the project detected from the working directory, `detectedProjectRoot`;
 * `null` means no project) and `tmpDir` (default: the system temp directory; both only decide whether the grants file
 * counts, IC-008) are for tests and the verbs; an injected `fsImpl` bypasses
 * the memo. A point registry that cannot be read leaves no package to find: `packages` and `points` are empty and the
 * one finding is `state-unreadable` on `points`.
 */
function packageView({ settingsView, env, fsImpl = fs, repoRoot = REPO_ROOT, homeDir, projectRoot, tmpDir }: { settingsView?: any; env?: any; fsImpl?: any; now?: any; repoRoot?: string; homeDir?: string; projectRoot?: string | null; tmpDir?: string } = {}): { packages: any[]; points: any[]; findings: any[] } {
  const base = fullView({ repoRoot, fsImpl, env, homeDir, projectRoot, tmpDir });
  const entry = settingsView ? settingsView[DISABLED_KEY] : fsImpl === fs ? resolvedDisabledEntry(env) : undefined;
  const packages = applySettingsDisable(base.packages, entry);
  return packages === base.packages ? base : { ...base, packages };
}

/** The states before `packages.disabled` is applied: the bundled view plus the lock's third-party packages, memoised on everything they read. */
function fullView(o: any): { packages: any[]; points: any[]; findings: any[] } {
  const bundled = baseView(o.repoRoot, o.fsImpl);
  if (building > 0 || bundled.points.length === 0) return bundled;
  const environment = o.env ?? process.env;
  const home = o.homeDir ?? (typeof environment.HOME === 'string' && path.isAbsolute(environment.HOME) ? environment.HOME : os.homedir());
  const projectRoot = o.projectRoot === undefined ? detectedProjectRoot({ homeDir: home, fsImpl: o.fsImpl })
    : o.projectRoot === null ? null : path.resolve(o.projectRoot);
  const key = JSON.stringify([path.resolve(o.repoRoot), path.resolve(home), configHome(environment).dir, projectRoot, o.tmpDir ?? null]);
  if (o.fsImpl === fs && fullMemo.has(key)) return fullMemo.get(key);
  building += 1;
  let result: { packages: any[]; points: any[]; findings: any[] };
  try {
    result = withLock(bundled, { ...o, env: environment, home, projectRoot });
  } finally {
    building -= 1;
  }
  if (o.fsImpl === fs) fullMemo.set(key, result);
  return result;
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

function resetPackageView(): void { memo.clear(); fullMemo.clear(); }

module.exports = { packageView, resetPackageView, hostVersion, applySettingsDisable };
