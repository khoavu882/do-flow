'use strict';

/**
 * `doflow package` (122 IC-012). Read-only, on the no-upkeep list: `points` lists the contribution points;
 * `check --path <dir>` prints the IC-004 findings of a package directory and its digests; `list [--id]` and
 * `show --id` print the package view (IC-010). Writing: `add --source <spec>` and `update --id <id>` write a plan
 * file and nothing else; `add --plan <planId>` and `update --plan <planId>` apply it (store and lock row, see
 * store.ts) and run storage upkeep like other writers. Exit 0 done, listed or clean, 1 the point registry is
 * unusable, a package is neither `active` nor `disabled`, an id is unknown, the package has errors or an apply
 * is refused, 2 usage; later actions land in the tasks that own them.
 *
 * The verb actions (B.6): `enable`, `disable`, `trust`, `exempt`, `revoke` and `verify [--repair]` are open to any
 * caller, never prompt or wait (beyond the global run lock), and each appends one audit row to `state.json` under the
 * scope's `run.lock`. `enable` and `disable` set the lock bit; `trust` and `exempt` only print the line a person
 * appends to `grants.jsonl` (DoFlow never writes it); `revoke` and `verify` write `state.json`. Each emits one
 * `package.verb` telemetry event (`action`, `result`, `tier_max`, no id or path). `remove` (B.7) is the seventh: it
 * deletes the package and prints what still names it. An id no package carries writes nothing for any of them.
 *
 * Projection (C.3, IC-017): `enable`, `disable`, `revoke`, `verify`, `remove` and a digest-changing `update --plan` bring
 * the projected skills and agents of every third-party package in line with the view (`syncProjection`), through the
 * lifecycle at global scope for the harnesses of the global lock's `targets`; `list` and `show` name the harnesses that
 * cannot take a package's skills or agents, and say when no harness is installed at global scope.
 */

const { finishRuntime, captureCaught } = require('../cli-result.ts');
const path = require('node:path');
const { loadPoints, pointRows } = require('./points.ts');
const { checkPackage, MANIFEST_FILE } = require('./manifest.ts');
const { scaffoldPackage } = require('./scaffold.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { packageView, resetPackageView, hostVersion } = require('./view.ts');
const { readLock, writeLock, removeLock, defaultLock, lockPackages, LOCK_VERSION_BASE } = require('../../state/lockfile.ts');
const fs = require('node:fs');
const os = require('node:os');
const { planPackage, planRemote, applyPlan, removeEntry, PLAN_ID } = require('./store.ts');
const { readIndex, pickVersion } = require('./index-file.ts');
const { configHome } = require('../config-home.ts');
const { GRANTS_FILE, readGrants } = require('./grants.ts');
const { parseSource, fetchGrantLine } = require('./source.ts');
const { acquireRunLock } = require('../../state/run-lock.ts');
const { readState, appendAudit, recordRevocation, recordSuspension, clearSuspension, recordTombstone, repairState } = require('./state.ts');
const { capabilityDigest } = require('./digest.ts');
const { satisfiesHostRange } = require('../../helper/semver.ts');
const { isPackageId } = require('../../helper/package-ids.ts');
const { TelemetryWriter } = require('../trace/telemetry.ts');
// The settings readers load only for `package remove`'s reference scan, so `install` and every other verb stay off them (settings-hot-path).

const TIER_ORDER = ['inert', 'instruction', 'executable'];
const VERB_ACTIONS = ['enable', 'disable', 'trust', 'exempt', 'revoke', 'verify', 'remove'];

function pointLine(row: any): string {
  return `point ${row.id}: tier=${row.tier} status=${row.status} entry=${row.entry} versions=${row.versions.join(',') || '-'}`
    + (row.opensWith ? ` opensWith=${row.opensWith}` : '');
}

function findingLine(f: any): string {
  return `${f.severity} ${f.code} ${f.field}: ${f.message}`;
}

/** `check --path <dir>`: the findings and digests of a package directory; writes nothing. */
function handleCheck({ pkgPath, json, repoRoot, out }: any): number {
  if (typeof pkgPath !== 'string' || pkgPath.length === 0) {
    const message = 'check requires one --path <dir>';
    out(json ? JSON.stringify({ ok: false, error: 'usage', message }) : `doflow package: ${message}`);
    return finishRuntime(2);
  }
  const root = repoRoot || REPO_ROOT;
  const dir = path.resolve(pkgPath);
  const result = checkPackage(dir, { repoRoot: root, hostVersion: hostVersion(root), bundled: [] });
  if (json) {
    out(JSON.stringify({ path: dir, ok: result.ok, findings: result.findings, ...(result.contentDigest ? { contentDigest: result.contentDigest, capabilityDigest: result.capabilityDigest } : {}) }));
  } else {
    for (const f of result.findings) out(findingLine(f));
    out(result.ok ? `package ok: ${dir}` : `package refused: ${dir}`);
    if (result.ok) { out(`contentDigest ${result.contentDigest}`); out(`capabilityDigest ${result.capabilityDigest}`); }
  }
  return finishRuntime(result.ok ? 0 : 1);
}

function stateLine(p: any): string {
  return `package ${p.id} ${p.version ?? '-'} ${p.state}${p.firstParty ? ' first-party' : ''}${p.enabled ? '' : ' disabled'}`
    + (p.reasons.length > 0 ? ` reasons=${p.reasons.join(',')}` : '');
}

/** The global lock's `version`; 1 with no lock, null for an unreadable one. Read-only. */
function globalLockVersion(homeDir?: string): number | null {
  try { return readLock({ scope: 'global', ...(homeDir === undefined ? {} : { homeDir }) })?.version ?? LOCK_VERSION_BASE; } catch { return null; }
}

/** The one line `list` prints when the global lock is version 2 (IC-007): a DoFlow older than the lock format refuses to read it. `--json` keeps its key set (the Console contract); its `lockVersion` carries the same fact. */
const DOWNGRADE_LIMIT = 'the global lock is version 2 because it records packages: an older DoFlow cannot read this lock and refuses it';

/** The view options a handler was given (`undefined` ones fall back to the view's own defaults). */
const viewOptions = (o: any): any => ({ repoRoot: o.repoRoot, homeDir: o.homeDir, env: o.env, projectRoot: o.projectRoot, tmpDir: o.tmpDir, settingsView: o.settingsView });

/** A fresh package view: the process memo is cleared first, because a verb or a person just changed what it reads. */
function freshView(o: any): any {
  resetPackageView();
  return packageView(viewOptions(o));
}

/**
 * The grant lines an `active` third-party package runs on (IC-008: every run that uses a grant prints the line it
 * matched, the file path and its mtime). Empty for a first-party or inert package, and for any other state.
 */
function matchedGrants(pkg: any, o: any, cache: { read?: any } = {}): any[] {
  if (pkg.firstParty || pkg.state !== 'active' || !(pkg.grant?.trust || pkg.grant?.exempt)) return [];
  cache.read ??= readGrants({ env: o.env, projectRoot: o.projectRoot, ...(o.tmpDir === undefined ? {} : { tmpDir: o.tmpDir }) });
  const kinds = [pkg.grant.trust ? 'trust' : null, pkg.grant.exempt ? 'exempt' : null];
  return cache.read.grants
    .filter((g: any) => kinds.includes(g.grant) && g.package === pkg.id && g.version === pkg.version && g.contentDigest === pkg.contentDigest
      && (g.grant !== 'trust' || g.capabilityDigest === pkg.capabilityDigest))
    .map((g: any) => ({ kind: g.grant, line: g.raw, lineNumber: g.line, path: cache.read.path, mtime: cache.read.mtime }));
}

const matchedText = (matched: any[]): string[] => matched.flatMap((m: any) => [
  `matched ${m.kind} grant (line ${m.lineNumber} of the grants file):`, m.line, `grants file ${m.path}, modified ${m.mtime}`,
]);

/**
 * `list [--id]` and `show --id`: the package view, read-only. `lockVersion` is the `version` of the global lock
 * on disk, 1 when there is none (the version written while no package is recorded) and null when it cannot be
 * read; the lock is only read here, never written. `list` exits 1 when a package is neither
 * `active` nor `disabled` or any finding is an error (a corrupt point registry among them); an unknown id is exit 1.
 * Text output also prints the grant line, file path and mtime an active trusted package runs on; `--json` keeps the
 * Console contract unchanged.
 */
function handleView(o: any): number {
  const { action, id, json, out } = o;
  if (action === 'show' && (typeof id !== 'string' || id.length === 0)) {
    const message = 'show requires one --id <id>';
    out(json ? JSON.stringify({ ok: false, error: 'usage', message }) : `doflow package: ${message}`);
    return finishRuntime(2);
  }
  const view = freshView(o);
  const wanted = typeof id === 'string' ? view.packages.filter((p: any) => p.id === id) : view.packages;
  if (typeof id === 'string' && wanted.length === 0) {
    const message = `no package with id '${id}'`;
    out(json ? JSON.stringify({ ok: false, error: 'unknown-package', message }) : `doflow package: ${message}`);
    return finishRuntime(1);
  }
  const findings = typeof id === 'string' ? view.findings.filter((f: any) => f.package === id) : view.findings;
  const cache = {};
  const targets = json ? [] : globalTargets(o);
  if (action === 'show') {
    if (json) out(JSON.stringify(wanted[0]));
    else {
      out(stateLine(wanted[0]));
      for (const line of matchedText(matchedGrants(wanted[0], o, cache))) out(line);
      for (const line of reachLines(o, wanted[0], targets)) out(line);
    }
    return finishRuntime(0);
  }
  const lockVersion = globalLockVersion(o.homeDir);
  const v2 = lockVersion !== null && lockVersion > LOCK_VERSION_BASE;
  if (json) out(JSON.stringify({ points: view.points, packages: wanted, findings, lockVersion }));
  else {
    for (const p of wanted) {
      out(stateLine(p));
      for (const line of matchedText(matchedGrants(p, o, cache))) out(line);
      for (const line of reachLines(o, p, targets)) out(line);
    }
    if (wanted.length === 0) out('no packages');
    for (const f of findings) out(findingLine(f));
    if (v2) out(DOWNGRADE_LIMIT);
  }
  const unhealthy = wanted.some((p: any) => p.state !== 'active' && p.state !== 'disabled');
  return finishRuntime(unhealthy || findings.some((f: any) => f.severity === 'error') ? 1 : 0);
}

function usage(json: boolean, out: (line: string) => void, message: string): number {
  out(json ? JSON.stringify({ ok: false, error: 'usage', message }) : `doflow package: ${message}`);
  return finishRuntime(2);
}

function refusal(json: boolean, out: (line: string) => void, findings: any[], what: string): number {
  if (json) out(JSON.stringify({ ok: false, error: findings[0]?.code ?? 'refused', findings }));
  else { for (const f of findings) out(findingLine(f)); out(what); }
  return finishRuntime(1);
}

/** Compare source objects by keys and values, ignoring key order. */
function sameSource(left: any, right: any): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

/** Local and granted remote adds converge on the same digest-bound plan and apply. */
function handlePlan({ action, source, index, packageVersion, id, json, repoRoot, homeDir, env, projectRoot, tmpDir, now, registry, out }: any): number {
  let remote: any = null;
  let pinned: any = null;
  let expected: any;
  let label = typeof source === 'string' ? source : id;
  if (action === 'add') {
    if (index !== undefined) {
      if (typeof source === 'string') return usage(json, out, 'add takes --source or --index, not both');
      if (typeof index !== 'string' || index.length === 0 || typeof id !== 'string' || id.length === 0) {
        return usage(json, out, 'add --index requires one --index <file> and --id <id>');
      }
      const read = readIndex(index);
      if (!read.ok) return refusal(json, out, read.findings, `package refused: ${index}`);
      const picked = pickVersion(read.index, id, { version: packageVersion, host: hostVersion(repoRoot || REPO_ROOT) });
      if (!picked.ok) return refusal(json, out, picked.findings, `package refused: ${index}`);
      pinned = picked.entry.source;
      expected = { id, version: picked.entry.version };
      remote = pinned.type === 'git'
        ? { type: 'git', url: pinned.url, ref: pinned.commit, ...(pinned.path === undefined ? {} : { path: pinned.path }) }
        : { type: 'npm', name: pinned.name, version: pinned.version };
      label = `${index} (${id} ${picked.entry.version})`;
    } else {
      if (packageVersion !== undefined) return usage(json, out, '--version <v> requires --index');
      if (typeof source !== 'string' || source.length === 0) return usage(json, out, 'add requires one --source <spec>, --index <file> --id <id>, or --plan <planId>');
      const parsed = parseSource(source);
      if (!parsed.ok) return refusal(json, out, [parsed.finding], `package refused: ${source}`);
      if (parsed.source.type !== 'local') remote = parsed.source;
      else {
        let isDir = false;
        try { isDir = fs.statSync(path.resolve(source)).isDirectory(); } catch { /* not a directory */ }
        if (!isDir) return usage(json, out, `--source must be a local package directory (an absolute or cwd-relative path to an existing directory); '${source}' is not one`);
      }
    }
    if (remote) {
      const line = fetchGrantLine(remote, grantTime(now ?? Date.now()));
      const grants = readGrants({ env, projectRoot, ...(tmpDir === undefined ? {} : { tmpDir }) });
      const matched = grants.grants.some((grant: any) => grant.grant === 'fetch' && sameSource(grant.source, remote));
      if (!matched) {
        const finding = { package: null, field: 'source', code: 'grant-missing', severity: 'error', message: `no fetch grant names ${label}`, allowed: line };
        if (json) out(JSON.stringify({ ok: false, error: 'grant-missing', findings: [finding], grantLine: line }));
        else {
          out(findingLine(finding));
          const dir = configHome(env).dir;
          out(dir === null ? 'there is no config home, so no fetch grant can exist' : `a person appends this line to ${path.join(dir, GRANTS_FILE)} (DoFlow never writes that file):`);
          out(line);
          out(`package refused: ${label}`);
        }
        return finishRuntime(1);
      }
    }
  } else {
    if (index !== undefined || packageVersion !== undefined) return usage(json, out, '--index and --version <v> are for add');
    if (typeof id !== 'string' || id.length === 0) return usage(json, out, 'update requires one --id <id> or one --plan <planId>');
  }
  const result = remote
    ? planRemote({ source: remote, pinned, expected, homeDir, repoRoot, env, now, registry })
    : planPackage({ action, source: typeof source === 'string' ? path.resolve(source) : undefined, id, homeDir, repoRoot, registry });
  if (!result.ok) return refusal(json, out, result.findings, `package refused: ${remote ? label : typeof source === 'string' ? path.resolve(source) : id}`);
  const { plan, planFile } = result;
  if (json) { out(JSON.stringify({ ok: true, planFile, plan })); return finishRuntime(0); }
  if (plan.source.type === 'git') out(`pinned ${plan.source.url} ${plan.source.commit}`);
  if (plan.source.type === 'npm') out(`pinned ${plan.source.name}@${plan.source.version}`);
  const from = plan.source.type === 'local' ? plan.source.path : plan.source.type === 'git' ? plan.source.url : plan.source.name;
  out(`plan ${plan.planId}: ${action} ${plan.package.id} ${plan.package.version} from ${from}`);
  out(`written ${planFile} (a plan changes no record and activates nothing; DoFlow keeps it for 24 hours)`);
  for (const c of plan.inventory) out(`  ${c.point} ${c.qualifiedId} ${c.tier}`);
  if (plan.inventory.length === 0) out('  no contributions');
  for (const f of plan.findings) out(findingLine(f));
  for (const [harness, row] of Object.entries<any>(plan.projection)) {
    const names = ['skill', 'agent'].flatMap((point) => (row[point] ?? []).map((name: string) => `${point} ${name}`));
    out(`  projection ${harness}: ${names.length ? names.join(', ') : 'nothing'} (${row.listingBytes} listing bytes of always-loaded context)`);
  }
  for (const w of result.projectionWarnings ?? []) out(`warning: ${w}`);
  if (result.instructions > 0 && Object.keys(plan.projection).length === 0) out(NO_GLOBAL(plan.package.id));
  out(`contentDigest ${plan.contentDigest}`);
  out(`capabilityDigest ${plan.capabilityDigest}`);
  if (plan.grantLines.trust) {
    const dir = configHome(env).dir;
    out(dir === null ? 'this package needs a trust grant, but there is no config home, so none can exist' : `this package needs a trust grant; a person appends this line to ${path.join(dir, GRANTS_FILE)} (DoFlow never writes that file):`);
    out(plan.grantLines.trust);
  }
  out(`apply with: doflow package --action ${action} --plan ${plan.planId}`);
  return finishRuntime(0);
}

/** The ISO 8601 UTC time of a grant line: whole seconds, as the plan prints it (IC-008). */
const grantTime = (when: number): string => new Date(when).toISOString().replace(/\.\d+Z$/, 'Z');

/** The `trust` line for a package's recorded digests; key order is the IC-008 order the plan prints. */
function trustLineFor(row: { id: string; version: string; contentDigest: string; capabilityDigest: string }, policy: number, now: number): string {
  return JSON.stringify({ grant: 'trust', package: row.id, version: row.version, contentDigest: row.contentDigest, capabilityDigest: row.capabilityDigest, policy, at: grantTime(now) });
}

/** The trust policy version the running DoFlow's point registry declares. */
function trustPolicy(repoRoot?: string): number {
  const loaded = loadPoints(repoRoot ? { repoRoot } : {});
  return loaded.ok ? loaded.registry.trustPolicyVersion : 1;
}

/** The grants file path a person appends to, or null when no config home resolves (so no grant can exist). */
const grantsPath = (env: any): string | null => {
  const dir = configHome(env).dir;
  return dir === null ? null : path.join(dir, GRANTS_FILE);
};

/** `add --plan <planId>` and `update --plan <planId>`: apply a plan. Exit 0 applied, 1 refused or failed. */
function handleApply(o: any): number {
  const { action, plan, json, repoRoot, homeDir, env, hooks, out } = o;
  if (typeof plan !== 'string' || !PLAN_ID.test(plan)) return usage(json, out, '--plan takes a plan id printed by add or update (16 hex characters)');
  try {
    let before = new Map<string, string>();
    try { before = new Map(lockPackages(readLock({ scope: 'global', homeDir })).map((r: any) => [r.id, r.contentDigest])); } catch { /* the apply reports an unreadable lock */ }
    const result = applyPlan({ planId: plan, action, homeDir, repoRoot, env, hooks });
    if (!result.ok) return refusal(json, out, result.findings, `package refused: plan ${plan}`);
    // FR-021: an update that changed the content digest above inert voids trust; print the line for the new digests.
    let retrust: string[] = [];
    let retrustLine: string | null = null;
    let retrustNote: string | null = null;
    if (result.action === 'update' && before.has(result.id) && before.get(result.id) !== result.contentDigest) {
      const pkg = freshView(o).packages.find((p: any) => p.id === result.id);
      if (pkg && TIER_ORDER.indexOf(pkg.tierMax) > 0) {
        retrustLine = trustLineFor({ id: result.id, version: result.version, contentDigest: result.contentDigest, capabilityDigest: result.capabilityDigest }, trustPolicy(repoRoot), o.now);
        const file = grantsPath(env);
        retrust = file === null
          ? [`${result.id} acts again only after a person adds it, but there is no config home, so no grant can exist; the line would be:`, retrustLine]
          : [`${result.id} acts again only after a person adds it: append this line to ${file} (an older trust line for ${result.id} ${result.version} may stay: it no longer grants; DoFlow never writes that file):`, retrustLine];
        retrustNote = file === null
          ? 'the package acts again only after a person adds that line to the grants file; there is no config home, so no grant can exist'
          : `the package acts again only after a person adds that line to ${file}`;
      }
    }
    // A changed content digest leaves the package without a valid grant above inert: its skills and agents go (IC-017).
    let sync: any = null;
    if (result.action === 'update' && before.has(result.id) && before.get(result.id) !== result.contentDigest) {
      const hold = acquireRunLock({ scopeRoot: homeDir, scope: 'global', command: 'package update' });
      try { sync = syncProjection(o); } finally { hold.release(); }
    }
    if (json) out(JSON.stringify({ ...result, ...(retrustLine ? { grantLines: { trust: retrustLine }, grantFile: grantsPath(env), note: retrustNote } : {}), ...(sync ? projectionJson(sync) : {}) }));
    else {
      out(`${result.action === 'add' ? 'added' : 'updated'} ${result.id} ${result.version} ${result.enabled ? 'enabled' : 'disabled'}`);
      out(`store ${result.storeDir}`);
      out(`contentDigest ${result.contentDigest}`);
      if (result.leftover) out('warning: the previous store entry could not be removed');
      for (const line of retrust) out(line);
      if (retrustNote) out(retrustNote);
      for (const line of sync?.lines ?? []) out(line);
    }
    return finishRuntime(0);
  } catch (error: any) {
    if (error?.name === 'RunLockTimeoutError' || error?.name === 'RunLockError') {
      out(json ? JSON.stringify({ ok: false, error: 'run-lock', message: error.message }) : error.message);
      return finishRuntime(1);
    }
    captureCaught(error, 'package', 1);
    console.error(`[ERROR] package: ${error?.message || String(error)}`);
    return finishRuntime(1);
  }
}

// ── projection of package skills and agents (C.3, IC-017) ───────────────────────────────────────────

/** The harnesses of the global lock's `targets`: where package skills and agents go. [] with no lock or an unreadable one. */
function globalTargets(o: any): string[] {
  try { return (readLock({ scope: 'global', homeDir: o.homeDir })?.targets ?? []).map((t: any) => t?.harness).filter((h: any) => typeof h === 'string'); } catch { return []; }
}

/** The skill and agent contributions a package's view row lists. */
const instructionsOf = (pkg: any): any[] => (pkg?.contributions ?? []).filter((c: any) => c.point === 'skill' || c.point === 'agent');

/** The line saying a package's skills and agents reach no harness, because DoFlow is not installed at global scope. */
const NO_GLOBAL = (id: string): string => `no harness is installed at global scope, so ${id}'s skills and agents are projected into none (a project-scope install never takes them)`;

/** The registry `list`, `show` and the projection read (`o.registry` is a test seam). */
const registryOf = (o: any): any => o.registry ?? require('../../registry/index.ts').loadRegistry({ repoRoot: o.repoRoot ?? REPO_ROOT });

/** The harness-reach warnings (IC-017, NFR-003) of one package for `list` and `show`: a harness of the global lock that
 * cannot take one of its skills or agents, or the one line saying no harness is installed at global scope. */
function reachLines(o: any, pkg: any, targets: string[]): string[] {
  const entries = instructionsOf(pkg);
  if (pkg.firstParty || entries.length === 0) return [];
  if (targets.length === 0) return [NO_GLOBAL(pkg.id)];
  const { projectionReach } = require('./store.ts');
  const registry = registryOf(o);
  const lines: string[] = [];
  for (const harness of targets) {
    for (const c of entries) {
      const reach = projectionReach(registry, harness, c.point);
      if (!reach.ok) lines.push(`warning: ${harness} cannot take ${c.point} ${c.qualifiedId}: ${reach.reason}`);
    }
  }
  return lines;
}

/**
 * Bring the projected skills and agents of every third-party package in line with the package view (IC-017), under the
 * run lock the caller holds: an active package's are projected into each harness of the global lock's `targets`, any
 * other package's recorded files are removed (a person-edited copy is kept and named). It runs the lifecycle at global
 * scope only, planning the package targets alone, so the installed runtime (no DoFlow content) can run it. A fault is a
 * warning line and never changes the verb's exit code. Returns `{ lines, projected, unprojected, kept, warnings }`.
 */
function packageHasProjection(homeDir: string, packageId: string): boolean {
  try {
    const { stateRoot, readLedger } = require('../../state/index.ts');
    const root = stateRoot({ scope: 'global', projectRoot: homeDir, homeDir });
    return (readLedger(root)?.resources ?? []).some((row: any) =>
      typeof row.assetId === 'string' && row.assetId.startsWith(`pkg.${packageId}.`));
  } catch {
    return false;
  }
}

function syncProjection(o: any): any {
  const result: any = { lines: [], projected: [], unprojected: [], kept: [], warnings: [] };
  const targets = globalTargets(o);
  if (targets.length === 0) return result;
  try {
    const lifecycle = require('../../lifecycle/index.ts');
    const { stateRoot, readLedger, defaultLedger } = require('../../state/index.ts');
    const registry = registryOf(o);
    const root = stateRoot({ scope: 'global', projectRoot: o.homeDir, homeDir: o.homeDir });
    const ledger = readLedger(root) ?? defaultLedger({ scope: 'global', scopeRoot: o.homeDir });
    const adapters = require('../../cli/shared.ts').buildAdapterRegistry();
    resetPackageView();
    const view = packageView({ ...viewOptions(o), settingsView: {} });
    const plan = lifecycle.planLifecycle({ registry, adapters, scope: 'global', scopeRoot: o.homeDir, targets, ledger,
      context: { packagesOnly: true, packageView: view, homeDir: o.homeDir, operation: 'package' } });
    result.warnings = (plan.packageWarnings ?? []).map((w: any) => w.warning);
    if (plan.changes.length) lifecycle.applyLifecycle({ plan, registry, adapters, stateRoot: root, ledger, acceptPrerequisites: true });
    const byId = (list: any[]) => {
      const grouped = new Map<string, Set<string>>();
      for (const change of list) {
        const id = change.assetId.slice('pkg.'.length);
        if (!grouped.has(id)) grouped.set(id, new Set());
        grouped.get(id)!.add(change.harness);
      }
      return [...grouped].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([qualifiedId, harnesses]) => ({ qualifiedId, harnesses: [...harnesses].sort() }));
    };
    const live = plan.changes.filter((change: any) => lifecycle.isPackageAsset(change.assetId) && !change.retained);
    result.projected = byId(live.filter((change: any) => change.operation !== 'remove'));
    result.unprojected = byId(live.filter((change: any) => change.operation === 'remove'));
    result.kept = plan.targets.filter((t: any) => t.packagesOnly).flatMap((t: any) => t.notices);
  } catch (error: any) {
    result.warnings.push(`the projection into harnesses failed: ${error?.message || String(error)}`);
  }
  result.lines = [
    ...result.projected.map((p: any) => `projected ${p.qualifiedId} into ${p.harnesses.join(', ')}`),
    ...result.unprojected.map((p: any) => `unprojected ${p.qualifiedId} from ${p.harnesses.join(', ')}`),
    ...result.kept, ...result.warnings.map((w: string) => `warning: ${w}`),
  ];
  return result;
}

/** The `projection` key a verb's `--json` output carries when the sync did or reported anything. */
function projectionJson(sync: any): any {
  const { projected, unprojected, kept, warnings } = sync;
  return projected.length || unprojected.length || kept.length || warnings.length ? { projection: { projected, unprojected, kept, warnings } } : {};
}

/** Whether the sync removed any file (the disable and revoke sentences depend on it). */
const removedAny = (sync: any): boolean => sync.unprojected.length > 0 || sync.kept.length > 0;

// ── verb actions (B.6): enable, disable, trust, exempt, revoke, verify ──────────────────────────────

/** Lines telling a person to append `line` to the grants file (or that no grant can exist without a config home). */
function appendInstruction(env: any, line: string, what: string): string[] {
  const file = grantsPath(env);
  return file === null
    ? [`there is no config home (set XDG_CONFIG_HOME or HOME), so no grant can exist and ${what}; the line would be:`, line]
    : [`${what}; a person appends this line to ${file} (DoFlow never writes that file):`, line];
}

const stamp = (o: any): string => new Date(o.now).toISOString();

/** One `audit` row; an unreadable `state.json` is reported by `verify`, never by the action that tried to log. */
function audit(o: any, verb: string, packageId: string, result: string): void {
  try { appendAudit({ homeDir: o.homeDir }, { verb, packageId: isPackageId(packageId) ? packageId : '*', result, at: stamp(o) }); } catch { /* see verify */ }
}

/** The lock row of a recorded package, or undefined. */
const rowOf = (o: any, id: string): any => lockPackages(readLock({ scope: 'global', homeDir: o.homeDir })).find((r: any) => r.id === id);

/** The row that records the bundled package as disabled: closed shape (IC-007), digests derived as B.4 does. */
function bundledRow(o: any, pkg: any): any {
  let capability = pkg.contentDigest;
  try {
    const loaded = loadPoints(o.repoRoot ? { repoRoot: o.repoRoot } : {});
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg.storeDir, MANIFEST_FILE), 'utf8'));
    const tiers: Record<string, string> = Object.fromEntries(loaded.registry.points.map((p: any) => [p.id, p.tier]));
    capability = capabilityDigest(manifest, { trustPolicyVersion: loaded.registry.trustPolicyVersion, tiers });
  } catch { /* the registry digest stands in: the row only has to record the bit */ }
  return { id: pkg.id, version: pkg.version ?? hostVersion(o.repoRoot ?? REPO_ROOT) ?? '0.0.0', source: { type: 'bundled' }, contentDigest: pkg.contentDigest, capabilityDigest: capability, enabled: false, addedAt: grantTime(o.now) };
}

/** Set the lock bit of `pkg`. A bundled package is on by default: enabling drops its row, disabling adds one. Returns whether the lock changed. */
function setEnabled(o: any, pkg: any, enabled: boolean): boolean {
  const lock = readLock({ scope: 'global', homeDir: o.homeDir });
  const rows = lockPackages(lock);
  const row = rows.find((r: any) => r.id === pkg.id);
  let next: any[];
  if (pkg.firstParty) {
    if (enabled) { if (!row) return false; next = rows.filter((r: any) => r.id !== pkg.id); }
    else { if (row && !row.enabled) return false; next = [...rows.filter((r: any) => r.id !== pkg.id), bundledRow(o, pkg)]; }
  } else {
    if (!row || row.enabled === enabled) return false;
    next = rows.map((r: any) => (r.id === pkg.id ? { ...r, enabled } : r));
  }
  writeLock({ scope: 'global', homeDir: o.homeDir }, { ...(lock ?? defaultLock({ scope: 'global', scopeRoot: o.homeDir })), packages: next });
  return true;
}

/** The unknown-id refusal shared by every id-taking verb: nothing is written, not even an audit row. */
function unknownId(o: any): number {
  const message = `no package with id '${o.id}'`;
  o.out(o.json ? JSON.stringify({ ok: false, error: 'unknown-package', message }) : `doflow package: ${message}`);
  return finishRuntime(1);
}

const highestTier = (tiers: Array<string | null>): string | null => {
  const ranks = tiers.map((t) => TIER_ORDER.indexOf(t as string)).filter((r) => r >= 0);
  return ranks.length > 0 ? TIER_ORDER[Math.max(...ranks)] : null;
};

/** The printed result of `enable` and `disable`: the state, the trust line when one is owed, the matched grant lines. */
function reportState(o: any, after: any, extra: string[] = [], sync: any = null): number {
  const matched = matchedGrants(after, o);
  const owes = after.state === 'needs-trust';
  const row = owes ? rowOf(o, after.id) : null;
  const line = row ? trustLineFor(row, trustPolicy(o.repoRoot), o.now) : null;
  const file = grantsPath(o.env);
  if (o.json) {
    o.out(JSON.stringify({ ok: true, action: o.action, id: after.id, state: after.state, reasons: after.reasons, enabled: after.enabled, matched,
      ...(line ? { grantLines: { trust: line }, grantFile: file } : {}), ...(sync ? projectionJson(sync) : {}) }));
  } else {
    o.out(stateLine(after));
    for (const text of extra) o.out(text);
    if (line) {
      o.out(`${after.id} is enabled but needs a trust grant (${after.reasons.join(', ')}); it acts only after a person adds the line`);
      for (const text of appendInstruction(o.env, line, `${after.id} stays inactive until the grant exists`)) o.out(text);
      if (after.reasons.includes('state-unreadable')) o.out('state.json or the grants file is unreadable: see package --action verify --repair');
    }
    for (const text of matchedText(matched)) o.out(text);
    for (const text of sync?.lines ?? []) o.out(text);
  }
  return finishRuntime(0);
}

function verbEnable(o: any, pkg: any, ctx: any): number {
  if (pkg.state === 'incompatible') {
    audit(o, 'enable', pkg.id, 'incompatible');
    const message = `package ${pkg.id} cannot be enabled: incompatible (${pkg.reasons.join(', ')})`;
    o.out(o.json ? JSON.stringify({ ok: false, error: 'incompatible', reasons: pkg.reasons, message }) : message);
    return finishRuntime(1);
  }
  setEnabled(o, pkg, true);
  // A package that is active now has its skills and agents projected; any other package is brought in line too (IC-017).
  const sync = syncProjection(o);
  const after = freshView(o).packages.find((p: any) => p.id === pkg.id) ?? pkg;
  ctx.tierMax = after.tierMax;
  audit(o, 'enable', pkg.id, after.state);
  if (instructionsOf(after).length && !after.firstParty && globalTargets(o).length === 0) sync.lines.push(NO_GLOBAL(after.id));
  return reportState(o, after, [], sync);
}

function verbDisable(o: any, pkg: any, ctx: any): number {
  setEnabled(o, pkg, false);
  const sync = syncProjection(o);
  const after = freshView(o).packages.find((p: any) => p.id === pkg.id) ?? pkg;
  ctx.tierMax = after.tierMax;
  audit(o, 'disable', pkg.id, after.state);
  return reportState(o, after, [removedAny(sync) ? 'the grant is kept' : 'the grant is kept; nothing is projected into a harness yet, so there is nothing to unproject'], sync);
}

function verbTrust(o: any, pkg: any): number {
  audit(o, 'trust', pkg.id, 'ok');
  if (pkg.firstParty) {
    o.out(o.json ? JSON.stringify({ ok: true, action: 'trust', id: pkg.id, required: false }) : `${pkg.id} is a bundled first-party package and needs no grant`);
    return finishRuntime(0);
  }
  const row = rowOf(o, pkg.id);
  const line = trustLineFor(row, trustPolicy(o.repoRoot), o.now);
  const required = TIER_ORDER.indexOf(pkg.tierMax) > 0;
  if (o.json) o.out(JSON.stringify({ ok: true, action: 'trust', id: pkg.id, required, grantLines: { trust: line }, grantFile: grantsPath(o.env) }));
  else {
    if (!required) o.out(`${pkg.id} is inert: no grant is required, the line below is only needed if its tier changes`);
    for (const text of appendInstruction(o.env, line, `${pkg.id} ${row.version} acts when its recorded digests are trusted`)) o.out(text);
  }
  return finishRuntime(0);
}

function verbExempt(o: any, pkg: any): number {
  const refuse = (result: string, message: string): number => {
    audit(o, 'exempt', pkg.id, result);
    o.out(o.json ? JSON.stringify({ ok: false, error: result, message }) : message);
    return finishRuntime(1);
  };
  if (pkg.firstParty) return refuse('bundled', `${pkg.id} is a bundled first-party package and needs no exemption`);
  const host = hostVersion(o.repoRoot ?? REPO_ROOT);
  let range: any;
  try { range = JSON.parse(fs.readFileSync(path.join(pkg.storeDir, MANIFEST_FILE), 'utf8')).doflow; } catch { range = null; }
  if (typeof range !== 'string') return refuse('manifest-unreadable', `cannot read the host range of ${pkg.id}: its store entry has no readable manifest`);
  if (host === null) return refuse('host-unknown', 'the running DoFlow version cannot be read, so no exemption can be written for it');
  if (satisfiesHostRange(host, range)) return refuse('inside-range', `DoFlow ${host} is inside the range ${range} of ${pkg.id}: no exemption is needed`);
  const row = rowOf(o, pkg.id);
  const line = JSON.stringify({ grant: 'exempt', package: row.id, version: row.version, contentDigest: row.contentDigest, host, acceptRisk: true, at: grantTime(o.now) });
  audit(o, 'exempt', pkg.id, 'ok');
  if (o.json) o.out(JSON.stringify({ ok: true, action: 'exempt', id: pkg.id, host, range, grantLines: { exempt: line }, grantFile: grantsPath(o.env) }));
  else for (const text of appendInstruction(o.env, line, `${pkg.id} ${row.version} runs on DoFlow ${host}, outside its range ${range}, only on this exemption`)) o.out(text);
  return finishRuntime(0);
}

function verbRevoke(o: any, pkg: any, ctx: any): number {
  const row = pkg.firstParty ? null : rowOf(o, pkg.id);
  // Whole seconds, rounded down: a line printed in the same second still sorts before the revocation (fail closed).
  const at = new Date(Math.floor(o.now / 1000) * 1000).toISOString();
  try {
    recordRevocation({ homeDir: o.homeDir }, { packageId: pkg.id, contentDigest: row ? row.contentDigest : pkg.contentDigest, at });
  } catch (error: any) {
    const message = `cannot record the revocation: ${error.message}`;
    o.out(o.json ? JSON.stringify({ ok: false, error: 'state-unreadable', message }) : message);
    return finishRuntime(1);
  }
  const sync = syncProjection(o);
  const after = freshView(o).packages.find((p: any) => p.id === pkg.id) ?? pkg;
  ctx.tierMax = after.tierMax;
  audit(o, 'revoke', pkg.id, after.state);
  if (o.json) o.out(JSON.stringify({ ok: true, action: 'revoke', id: pkg.id, state: after.state, reasons: after.reasons, ...projectionJson(sync) }));
  else {
    o.out(stateLine(after));
    o.out(`revoked trust for ${pkg.id} at its recorded content digest; only a trust line printed after ${at} counts${removedAny(sync) ? '' : ', and nothing is projected into a harness yet, so there is nothing to unproject'}`);
    for (const text of sync.lines) o.out(text);
  }
  return finishRuntime(0);
}

// ── remove (B.7) ────────────────────────────────────────────────────────────────────────────────────

/** The user, project and local settings files of the current directory, in that order (the reader `config list` uses). */
function settingsLayerFiles(o: any): Array<{ layer: string; file: string }> {
  const files: Array<{ layer: string; file: string }> = [];
  const home = configHome(o.env).dir;
  if (home !== null) files.push({ layer: 'user', file: path.join(home, 'settings.json') });
  const layers = require('../settings/project-layers.ts').projectLayerSource(o.projectRoot ?? process.cwd()).layersFrom;
  if (layers !== null) files.push({ layer: 'project', file: path.join(layers, 'settings.json') }, { layer: 'local', file: path.join(layers, 'settings.local.json') });
  return files;
}

/** The `findings.json` files under `<project>/.doflow/`, sorted. Symbolic links and dispatch worktrees are not entered. */
function findingsFiles(projectRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: any[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a: any, b: any) => (a.name < b.name ? -1 : 1)); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'dispatch-worktrees' && depth < 12) walk(full, depth + 1); } else if (entry.isFile() && entry.name === 'findings.json') found.push(full);
    }
  };
  walk(path.join(projectRoot, '.doflow'), 0);
  return found;
}

/**
 * The read-only removal scan (IC-012): the settings values and findings records that still name one of `ids`.
 * Rows are `{ kind: 'setting', layer, key, value }` and `{ kind: 'record', path, field: 'protocol.id', value }`; a
 * layer file that cannot be read is `unscanned`. Nothing is written.
 */
function scanReferences(o: any, ids: Set<string>, keys: string[]): { dangling: any[]; unscanned: any[] } {
  const dangling: any[] = [];
  const unscanned: any[] = [];
  const names = (value: any): boolean => (typeof value === 'string' ? ids.has(value) : Array.isArray(value) && value.some((item: any) => ids.has(item)));
  if (keys.length > 0) {
    const { loadSettingsRegistry } = require('../settings/registry.ts');
    const { readLayerFile } = require('../settings/files.ts');
    const loaded = loadSettingsRegistry({ repoRoot: o.repoRoot ?? REPO_ROOT });
    for (const { layer, file } of settingsLayerFiles(o)) {
      if (!loaded.ok) { unscanned.push({ layer, path: file, reason: 'the settings registry is unreadable' }); continue; }
      const read = readLayerFile(file, { registry: loaded.registry, includeDocument: true });
      if (read.status === 'invalid') { unscanned.push({ layer, path: file, reason: read.reason }); continue; }
      for (const key of keys) {
        const value = read.document?.[key];
        if (names(value)) dangling.push({ kind: 'setting', layer, key, value });
      }
    }
  }
  for (const file of findingsFiles(o.projectRoot ?? process.cwd())) {
    try {
      if (fs.statSync(file).size > 1048576) continue;
      const id = JSON.parse(fs.readFileSync(file, 'utf8'))?.protocol?.id;
      if (typeof id === 'string' && ids.has(id)) dangling.push({ kind: 'record', path: file, field: 'protocol.id', value: id });
    } catch { /* not a findings record this scan can read */ }
  }
  return { dangling, unscanned };
}

/** Drop the lock row of `id`; a lock left with no package and no target is deleted (B.1's rule, as `recordLock` does). */
function dropLockRow(o: any, id: string): void {
  const lock = readLock({ scope: 'global', homeDir: o.homeDir });
  if (!lock) return;
  const rows = lockPackages(lock).filter((r: any) => r.id !== id);
  if (rows.length === 0 && (lock.targets ?? []).length === 0) removeLock({ scope: 'global', homeDir: o.homeDir });
  else writeLock({ scope: 'global', homeDir: o.homeDir }, { ...lock, packages: rows });
}

/**
 * `remove --id <id>`: disable, lifecycle removal, store entry, lock row, revocation, then the `removed` tombstone, all under
 * the run lock; then the scan. The bundled package cannot be removed (FR-004: it can be disabled). An unreadable
 * `state.json` refuses before anything changes, because the revocation and the tombstone could not be written.
 */
function verbRemove(o: any, pkg: any, ctx: any): number {
  const refuse = (result: string, message: string): number => {
    audit(o, 'remove', pkg.id, result);
    o.out(o.json ? JSON.stringify({ ok: false, error: result, message }) : message);
    return finishRuntime(1);
  };
  if (pkg.firstParty) return refuse('bundled', `${pkg.id} is the bundled first-party package and cannot be removed; turn it off with: doflow package --action disable --id ${pkg.id}`);
  const row = rowOf(o, pkg.id);
  if (readState({ homeDir: o.homeDir }).unreadable) return refuse('state-unreadable', 'cannot record the revocation: the package state file is unreadable; run: doflow package --action verify --repair');

  const qualifiedIds: string[] = pkg.contributions.map((c: any) => c.qualifiedId);
  const loaded = loadPoints(o.repoRoot ? { repoRoot: o.repoRoot } : {});
  const keys = loaded.ok ? [...new Set<string>(loaded.registry.points.filter((p: any) => pkg.contributions.some((c: any) => c.point === p.id)).flatMap((p: any) => p.referencedBy))] : [];
  const scan = scanReferences(o, new Set(qualifiedIds), keys);
  const grants = readGrants({ env: o.env, projectRoot: o.projectRoot, ...(o.tmpDir === undefined ? {} : { tmpDir: o.tmpDir }) });
  const dangling = grants.entries.filter((g: any) => g.grant !== 'fetch' && g.package === pkg.id).map((g: any) => ({ line: g.line, kind: g.grant, version: g.version }));

  setEnabled(o, pkg, false); // disable first: a run that stops below leaves the package off
  // Lifecycle removal of the package's projected skills and agents and their ledger rows, before the store entry goes.
  const sync = syncProjection(o);
  const idDir = path.dirname(pkg.storeDir);
  const leftover = fs.existsSync(idDir) && !removeEntry(idDir, path.basename(pkg.storeDir), fs);
  dropLockRow(o, pkg.id);
  // Whole seconds, rounded down, as `revoke` does: a trust line printed in the same second still sorts before the revocation.
  recordRevocation({ homeDir: o.homeDir }, { packageId: pkg.id, contentDigest: row.contentDigest, at: new Date(Math.floor(o.now / 1000) * 1000).toISOString() });
  recordTombstone({ homeDir: o.homeDir }, { packageId: pkg.id, qualifiedIds, at: stamp(o) });
  audit(o, 'remove', pkg.id, 'removed');

  const file = grantsPath(o.env);
  if (o.json) {
    o.out(JSON.stringify({ ok: true, action: 'remove', id: pkg.id, version: row.version, qualifiedIds, dangling: scan.dangling, unscanned: scan.unscanned, grants: dangling, grantFile: file, leftover, ...projectionJson(sync) }));
    return finishRuntime(0);
  }
  o.out(`removed ${pkg.id} ${row.version}`);
  for (const text of sync.lines) o.out(text);
  if (leftover) o.out('warning: the store entry could not be removed');
  for (const d of scan.dangling) {
    o.out(d.kind === 'setting' ? `dangling setting ${d.layer} ${d.key} = ${JSON.stringify(d.value)}` : `dangling record ${d.path} ${d.field} = ${JSON.stringify(d.value)}`);
  }
  for (const u of scan.unscanned) o.out(`not scanned: ${u.layer} settings ${u.path} (${u.reason})`);
  if (scan.dangling.length === 0 && scan.unscanned.length === 0) o.out('no dangling references');
  else if (scan.dangling.length > 0) o.out('nothing was rewritten: edit those settings and records yourself');
  for (const g of dangling) o.out(`grant line ${g.line} (${g.kind} ${g.version}) in ${file} still names ${pkg.id}; DoFlow never edits that file, and you may delete the line`);
  return finishRuntime(0);
}

/** `verify [--repair]`: re-hash every enabled third-party entry through the view; record or clear suspensions. */
function verbVerify(o: any, ctx: any): number {
  let view = freshView(o);
  let repaired = false;
  let notes: string[] = [];
  let read = readState({ homeDir: o.homeDir });
  if (o.repair) {
    if (read.unreadable) {
      const grants = readGrants({ env: o.env, projectRoot: o.projectRoot, ...(o.tmpDir === undefined ? {} : { tmpDir: o.tmpDir }) });
      repairState({ homeDir: o.homeDir }, { grantEntries: grants.entries, at: stamp(o) });
      repaired = true;
      view = freshView(o);
      read = readState({ homeDir: o.homeDir });
    } else notes = ['state.json is readable, so --repair left it as it is'];
  }
  const checked = view.packages.filter((p: any) => !p.firstParty && p.enabled);
  ctx.tierMax = highestTier(checked.map((p: any) => p.tierMax));
  const findings: any[] = [];
  for (const p of checked) {
    if (p.state === 'suspended' || p.state === 'incompatible') findings.push({ package: p.id, state: p.state, reasons: p.reasons });
  }
  for (const f of view.findings) if (f.severity === 'error' && f.package === null) findings.push({ package: null, state: f.code, reasons: [f.field] });
  if (read.unreadable && !findings.some((f) => f.state === 'state-unreadable')) findings.push({ package: null, state: 'state-unreadable', reasons: ['state.json'] });
  if (!read.unreadable) {
    for (const p of checked) {
      const had = read.state.suspended.find((s: any) => s.package === p.id);
      if (p.state === 'suspended') {
        const reason = p.reasons[0];
        recordSuspension({ homeDir: o.homeDir }, { packageId: p.id, reason, projected: packageHasProjection(o.homeDir, p.id), since: had?.reason === reason ? had.since : stamp(o) });
      } else if (had) clearSuspension({ homeDir: o.homeDir }, { packageId: p.id });
    }
    if (!repaired) audit(o, 'verify', '*', findings.length === 0 ? 'ok' : `findings:${findings.length}`);
  }
  // Projects what is active and unprojects what is not, a suspended package's among them (IC-017).
  const sync = syncProjection(o);
  require('../../lifecycle/index.ts').settleSuspendedProjection({ homeDir: o.homeDir });
  if (o.json) o.out(JSON.stringify({ ok: findings.length === 0, action: 'verify', repaired, packages: checked.map((p: any) => ({ id: p.id, state: p.state, reasons: p.reasons })), findings, ...projectionJson(sync) }));
  else {
    for (const text of notes) o.out(text);
    if (repaired) o.out('state.json was unreadable and is rewritten: every grant line present now is revoked until a person adds a fresh line');
    for (const p of checked) o.out(p.state === 'suspended' || p.state === 'incompatible' ? `package ${p.id} ${p.state} reasons=${p.reasons.join(',')}` : `package ${p.id} intact`);
    for (const f of findings.filter((x) => x.package === null)) {
      o.out(`${f.state}: ${f.reasons.join(',')}${f.state === 'state-unreadable' ? '; run package --action verify --repair' : ''}`);
    }
    for (const text of sync.lines) o.out(text);
    o.out(findings.length === 0 ? `verify: ${checked.length} enabled third-party package${checked.length === 1 ? '' : 's'} intact` : `verify: ${findings.length} finding${findings.length === 1 ? '' : 's'}`);
  }
  return finishRuntime(findings.length === 0 ? 0 : 1);
}

/** Run one verb under the global scope's `run.lock`, then emit `package.verb`. */
function handleVerb(o: any): number {
  const { action, id, json, out } = o;
  const ctx: { tierMax: string | null } = { tierMax: null };
  let code: number;
  if (action !== 'verify' && (typeof id !== 'string' || id.length === 0)) code = usage(json, out, `${action} requires one --id <id>`);
  else if (action !== 'verify' && !freshView(o).packages.some((p: any) => p.id === id)) code = unknownId(o); // before the run lock: an unknown id leaves not even the lock's directory behind
  else {
    try {
      const hold = acquireRunLock({ scopeRoot: o.homeDir, scope: 'global', command: `package ${action}` });
      try {
        if (action === 'verify') code = verbVerify(o, ctx);
        else {
          const pkg = freshView(o).packages.find((p: any) => p.id === id);
          ctx.tierMax = pkg ? pkg.tierMax : null;
          if (!pkg) code = unknownId(o);
          else if (action === 'enable') code = verbEnable(o, pkg, ctx);
          else if (action === 'disable') code = verbDisable(o, pkg, ctx);
          else if (action === 'trust') code = verbTrust(o, pkg);
          else if (action === 'exempt') code = verbExempt(o, pkg);
          else if (action === 'remove') code = verbRemove(o, pkg, ctx);
          else code = verbRevoke(o, pkg, ctx);
        }
      } finally {
        hold.release();
      }
    } catch (error: any) {
      if (error?.name === 'RunLockTimeoutError' || error?.name === 'RunLockError') {
        out(json ? JSON.stringify({ ok: false, error: 'run-lock', message: error.message }) : error.message);
        code = finishRuntime(1);
      } else {
        captureCaught(error, 'package', 1);
        console.error(`[ERROR] package: ${error?.message || String(error)}`);
        code = finishRuntime(1);
      }
    }
  }
  emitVerb(o, action, code, ctx.tierMax);
  return code;
}

/** One `package.verb` event (IC-024): closed enums only, never a package id or a path. Telemetry never changes the outcome. */
function emitVerb(o: any, action: string, code: number, tierMax: string | null): void {
  try {
    const writer = o.writer || new TelemetryWriter({ env: o.env, start: process.cwd() });
    writer.write([{ kind: 'package.verb', action, result: code === 0 ? 'ok' : code === 2 ? 'usage' : 'refused', tier_max: tierMax }]);
  } catch { /* a telemetry fault changes nothing */ }
}

function handlePackageCommand({ action, path: pkgPath, id, source, index, packageVersion, plan, repair, points, dir, cwd = process.cwd(), fsImpl, json = false, repoRoot, homeDir = os.homedir(), env = process.env, projectRoot, tmpDir, settingsView, writer, now = Date.now(), hooks, registry, out = (line: string) => console.log(line) }: any = {}): number {
  const o = { action, id, index, packageVersion, repair: repair === true, json, repoRoot, homeDir, env, projectRoot, tmpDir, settingsView, writer, now, hooks, registry, out };
  if (action === 'new') {
    const result = scaffoldPackage({ id, points, dir, cwd, homeDir, env, repoRoot, now, fsImpl, grantsPath: grantsPath(env) });
    const code = result.ok ? 0 : result.usage ? 2 : 1;
    emitVerb(o, 'new', code, result.ok ? result.tierMax : null);
    if (json) {
      const { usage: _usage, ...body } = result;
      out(JSON.stringify(body));
    } else if (result.ok) {
      out(`created ${result.dir}`);
      for (const file of result.files) out(path.join(result.dir, ...file.split('/')));
      for (const f of result.findings) out(findingLine(f));
      if (result.ignoredByGit === true) out("the project's own ignore rules hide this folder; a person may add !.doflow/package/ to the project's .gitignore");
      for (const step of result.next) out(`next: ${step.step}: ${step.command ? `${step.command}; ` : ''}${step.note}`);
    } else {
      for (const f of result.findings) out(findingLine(f));
    }
    return finishRuntime(code);
  }
  if (VERB_ACTIONS.includes(action)) return handleVerb(o);
  if (action === 'add' || action === 'update') {
    const given = action === 'add' ? source : id;
    if (typeof plan === 'string' && plan.length > 0) {
      if (typeof given === 'string' || index !== undefined || packageVersion !== undefined || (action === 'add' && id !== undefined)) {
        return usage(json, out, `${action} takes --plan alone, without source, index, id or version selection`);
      }
      return handleApply({ ...o, plan });
    }
    try {
      return handlePlan({ ...o, source });
    } catch (error: any) {
      captureCaught(error, 'package', 1);
      console.error(`[ERROR] package: ${error?.message || String(error)}`);
      return finishRuntime(1);
    }
  }
  if (action === 'list' || action === 'show') {
    try {
      return handleView(o);
    } catch (error: any) {
      captureCaught(error, 'package', 1);
      console.error(`[ERROR] package: ${error?.message || String(error)}`);
      return finishRuntime(1);
    }
  }
  if (action === 'check') {
    try {
      return handleCheck({ pkgPath, json, repoRoot, out });
    } catch (error: any) {
      captureCaught(error, 'package', 1);
      console.error(`[ERROR] package: ${error?.message || String(error)}`);
      return finishRuntime(1);
    }
  }
  if (action !== 'points') {
    const message = 'action must be points, check, list, show, add, update, new, enable, disable, trust, exempt, revoke, verify or remove';
    out(json ? JSON.stringify({ ok: false, error: 'usage', message }) : `doflow package: ${message}`);
    return finishRuntime(2);
  }
  try {
    const loaded = loadPoints(repoRoot ? { repoRoot } : {});
    if (!loaded.ok) {
      const message = loaded.errors.join('; ');
      out(json ? JSON.stringify({ ok: false, error: 'points-invalid', message }) : `package: points-invalid: ${message}`);
      return finishRuntime(1);
    }
    const rows = pointRows(loaded.registry);
    if (json) out(JSON.stringify({ points: rows }));
    else for (const row of rows) out(pointLine(row));
    return finishRuntime(0);
  } catch (error: any) {
    captureCaught(error, 'package', 1);
    console.error(`[ERROR] package: ${error?.message || String(error)}`);
    return finishRuntime(1);
  }
}

module.exports = { handlePackageCommand };
