'use strict';

/**
 * Plans, the package store and the apply step (122 IC-006, IC-007, IC-012 `add` and `update` for a local
 * source, IC-024 storage). A plan is a file under `~/.doflow/packages/plans/` that changes no record and
 * activates nothing; applying one takes the global scope's `run.lock`, re-snapshots the source, recomputes both
 * digests, stages a copy, re-hashes it, renames it into `store/<id>/<contentDigest first 16 hex>/`, writes the
 * `.installed-from.json` marker beside the tree and writes the lock row last. A failure after the rename removes
 * the entry before the lock is touched. Nothing here writes the person grant file.
 *
 * Not here yet: `projection` is a placeholder `{}` until Phase C (projection into harnesses); trust voiding and
 * the new trust line printed by `update --plan` belong to B.6 (the data already makes it fall out: the lock row
 * names the new digests, and a grant names the old ones); remote sources are Phase E.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { isPackageId } = require('../../helper/package-ids.ts');
const { checkPackage, MANIFEST_FILE } = require('./manifest.ts');
const { loadPoints } = require('./points.ts');
const { walkTree, digestFiles, canonicalJson } = require('./digest.ts');
const { hostVersion } = require('./view.ts');
const { readLock, writeLock, defaultLock, lockPackages } = require('../../state/lockfile.ts');
const { atomicJsonWrite } = require('../../state/index.ts');
const { acquireRunLock } = require('../../state/run-lock.ts');

const PLAN_VERSION = 1;
const PLAN_ID = /^[0-9a-f]{16}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MARKER_SUFFIX = '.installed-from.json';
const TIER_ORDER = ['inert', 'instruction', 'executable'];

const sha256 = (data: string): string => crypto.createHash('sha256').update(data).digest('hex');
const isObject = (value: any): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);

/** `~/.doflow/packages` and its parts for a home directory. */
function packagePaths(homeDir: string): { base: string; plans: string; store: string } {
  const base = path.join(homeDir, '.doflow', 'packages');
  return { base, plans: path.join(base, 'plans'), store: path.join(base, 'store') };
}

function finding(field: string, code: string, message: string, allowed: any, pkg: string | null = null): any {
  return { package: pkg, field, code, severity: 'error', message, allowed };
}

/** The ISO 8601 UTC time of a grant line: whole seconds, as IC-008 prints it. */
const grantTime = (when: number): string => new Date(when).toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * Check a local package directory and describe what it would add. `{ ok: false, findings }` when the checker
 * reports an error; otherwise the manifest, both digests, the inventory (`point`, `qualifiedId`, `tier`, sorted)
 * and the trust policy version the digests were taken under.
 */
function analyze(dir: string, { repoRoot = REPO_ROOT, fsImpl = fs }: any = {}): any {
  const loaded = loadPoints({ repoRoot });
  const checked = checkPackage(dir, { repoRoot, hostVersion: hostVersion(repoRoot), bundled: [], fsImpl, ...(loaded.ok ? { pointsRegistry: loaded.registry } : {}) });
  if (!checked.ok) return { ok: false, findings: checked.findings };
  const manifest = JSON.parse(String(fsImpl.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8')));
  const tiers: Record<string, string> = Object.fromEntries(loaded.registry.points.map((p: any) => [p.id, p.tier]));
  const inventory = (manifest.contributions ?? [])
    .map((c: any) => ({ point: c.point, qualifiedId: `${manifest.id}.${c.id}`, tier: tiers[c.point] }))
    .sort((a: any, b: any) => (a.point < b.point ? -1 : a.point > b.point ? 1 : a.qualifiedId < b.qualifiedId ? -1 : a.qualifiedId > b.qualifiedId ? 1 : 0));
  const programs = [...(manifest.programs ?? [])].sort((a: any, b: any) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  return {
    ok: true, findings: checked.findings, manifest, inventory, programs, contentDigest: checked.contentDigest, capabilityDigest: checked.capabilityDigest,
    trustPolicyVersion: loaded.registry.trustPolicyVersion, limits: loaded.registry.limits,
  };
}

/** The highest tier in an inventory (`inert` for none). */
const tierMax = (inventory: any[]): string => inventory.reduce((top: string, c: any) => (TIER_ORDER.indexOf(c.tier) > TIER_ORDER.indexOf(top) ? c.tier : top), 'inert');

/**
 * The plan id: the first 16 hex of sha256(content NUL capability NUL canonical source) (IC-006). The storage
 * engine reads a name that starts with 13 decimal digits as a millisecond timestamp, which would let the
 * plans store prune a fresh plan at once (about 1 id in 450), so such a candidate is rerolled by hashing
 * the same text with `NUL <n>` appended, n = 1, 2, ... The result stays 16 hex and is still a function of the
 * inputs. `hash` is a test seam.
 */
function planIdFor(text: string, hash: (text: string) => string = sha256): string {
  for (let n = 0; ; n += 1) {
    const candidate = hash(n === 0 ? text : `${text}\0${n}`).slice(0, 16);
    if (!/^[0-9]{13}/.test(candidate)) return candidate;
  }
}

/**
 * Write the plan for a local source. `action` is `add` or `update`; `update` reads the source from the recorded
 * row of `id`. Returns `{ ok: true, plan, planFile }` or `{ ok: false, findings }`; the only thing written is
 * the plan file, and nothing is written when anything refuses.
 */
function planPackage({ action, source, id, homeDir = os.homedir(), repoRoot = REPO_ROOT, now = Date.now(), hash, fsImpl = fs }: any): any {
  const rows = lockPackages(readLock({ scope: 'global', homeDir }, { fsImpl }));
  let sourcePath = source;
  if (action === 'update') {
    const row = rows.find((r: any) => r.id === id);
    if (!row) return { ok: false, findings: [finding('id', 'bad-id', `no package with id '${id}' is recorded`, 'the id of a recorded package', id)] };
    if (row.source?.type !== 'local') return { ok: false, findings: [finding('source', 'bad-type', `package '${id}' was added from a ${row.source?.type} source, which update cannot read yet`, 'a local source', id)] };
    sourcePath = row.source.path;
  }
  const analysis = analyze(sourcePath, { repoRoot, fsImpl });
  if (!analysis.ok) return { ok: false, findings: analysis.findings };
  const { manifest } = analysis;
  if (action === 'add' && rows.some((r: any) => r.id === manifest.id)) {
    return { ok: false, findings: [finding('id', 'collision-package', `package '${manifest.id}' is already recorded; use update`, 'an id no recorded package uses', manifest.id)] };
  }
  if (action === 'update' && manifest.id !== id) {
    return { ok: false, findings: [finding('id', 'bad-id', `the manifest at ${sourcePath} names '${manifest.id}', not '${id}'`, id, id)] };
  }
  const source_ = { type: 'local', path: sourcePath };
  const planId = planIdFor(`${analysis.contentDigest}\0${analysis.capabilityDigest}\0${canonicalJson(source_)}`, hash);
  const grantLines: Record<string, string> = {};
  if (tierMax(analysis.inventory) !== 'inert') {
    grantLines.trust = JSON.stringify({
      grant: 'trust', package: manifest.id, version: manifest.version, contentDigest: analysis.contentDigest,
      capabilityDigest: analysis.capabilityDigest, policy: analysis.trustPolicyVersion, at: grantTime(now),
    });
  }
  const plan = {
    plan: PLAN_VERSION, planId, createdAt: new Date(now).toISOString(), action, source: source_,
    package: { id: manifest.id, version: manifest.version, doflow: manifest.doflow },
    contentDigest: analysis.contentDigest, capabilityDigest: analysis.capabilityDigest, trustPolicyVersion: analysis.trustPolicyVersion,
    inventory: analysis.inventory, programs: analysis.programs, projection: {}, findings: analysis.findings, grantLines,
  };
  const planFile = path.join(packagePaths(homeDir).plans, `${planId}.json`);
  atomicJsonWrite(planFile, plan, { fsImpl });
  return { ok: true, plan, planFile, tierMax: tierMax(analysis.inventory) };
}

/** A plan file's content when it is the IC-006 shape for a local source, else a finding. */
function readPlan(planId: string, homeDir: string, fsImpl: any): any {
  const planFile = path.join(packagePaths(homeDir).plans, `${planId}.json`);
  let text: string;
  try { text = String(fsImpl.readFileSync(planFile, 'utf8')); } catch (error: any) {
    if (error?.code === 'ENOENT') return { finding: finding('plan', 'file-missing', `no plan ${planId}; a plan is kept for 24 hours`, 'a plan id printed by add or update') };
    return { finding: finding('plan', 'state-unreadable', `plan ${planId} cannot be read: ${error?.message}`, 'a readable plan file') };
  }
  let plan: any;
  try { plan = JSON.parse(text); } catch { plan = null; }
  const ok = isObject(plan) && plan.plan === PLAN_VERSION && plan.planId === planId && (plan.action === 'add' || plan.action === 'update')
    && isObject(plan.source) && plan.source.type === 'local' && typeof plan.source.path === 'string' && path.isAbsolute(plan.source.path)
    && isObject(plan.package) && isPackageId(plan.package.id) && DIGEST.test(plan.contentDigest) && DIGEST.test(plan.capabilityDigest);
  if (!ok) return { finding: finding('plan', 'state-unreadable', `plan ${planId} is not a plan this DoFlow wrote`, 'a plan written by package add or update') };
  return { plan };
}

/** Copy the regular files of `files` under `dest`, normalising the mode to the execute bit alone. */
function copyFiles(files: any[], dest: string, fsImpl: any): void {
  for (const file of files) {
    const target = path.join(dest, ...file.rel.split('/'));
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.copyFileSync(file.abs, target);
    fsImpl.chmodSync(target, file.exec ? 0o755 : 0o644);
  }
}

/** The IC-005 content digest of a directory, or null when its tree breaks a tree rule. */
function digestOf(dir: string, limits: any, fsImpl: any): string | null {
  const walked = walkTree(dir, limits, { fsImpl });
  return walked.findings.length > 0 ? null : digestFiles(walked.files, fsImpl);
}

/** Remove a store entry's tree and marker, and the id directory when that leaves it empty. Never throws. */
function removeEntry(idDir: string, digest16: string, fsImpl: any): boolean {
  try {
    fsImpl.rmSync(path.join(idDir, digest16), { recursive: true, force: true });
    fsImpl.rmSync(path.join(idDir, `${digest16}${MARKER_SUFFIX}`), { force: true });
    if (fsImpl.readdirSync(idDir).length === 0) fsImpl.rmdirSync(idDir);
    return true;
  } catch { return false; }
}

/**
 * Storage upkeep for the package stores. `upkeepAfterVerb` visits the state and config roots only (its
 * `MOMENT_ROOTS`), so the declared rows `packages-plans` and `packages-staging` carry no moment and the plans
 * (24 hours) and stale staging directories under `~/.doflow/packages` are pruned here, by the engine, whenever
 * a plan is applied. It honours the prune setting and `DOFLOW_UPKEEP=off`, and never throws.
 */
function pruneStale({ homeDir, env, now, fsImpl }: any): void {
  if (env.DOFLOW_UPKEEP === 'off') return;
  try {
    const { loadStorageRegistry } = require('../storage/registry.ts');
    const { resolveRoots, readPruneSetting } = require('../storage/roots.ts');
    const { runPass } = require('../storage/engine.ts');
    const registry = loadStorageRegistry({ repoRoot: REPO_ROOT });
    const roots = resolveRoots({ registry, global: true, env: { ...env, HOME: homeDir } });
    const { setting } = readPruneSetting({ roots, rootId: 'user-doflow', fsImpl });
    runPass({ registry, roots, stores: ['packages-plans', 'packages-staging'], mode: 'prune', setting: { 'user-doflow': setting }, now, env, fsImpl });
  } catch { /* upkeep must never affect the apply */ }
}

/**
 * Apply a plan (`add --plan` or `update --plan`). `action` names the verb the caller ran: a plan of the other
 * kind is refused. Returns `{ ok: true, ... }` or `{ ok: false, findings }` (a refusal writes no store entry and
 * leaves the lock byte-identical); an unexpected failure throws after the entry it made is removed and the run
 * lock released. `hooks` are test seams: `afterCopy(stagingDir)` runs after the copy and before the re-hash,
 * `afterRename(entryDir)` runs right after the rename.
 */
function applyPlan({ planId, action = null, homeDir = os.homedir(), repoRoot = REPO_ROOT, env = process.env, now = Date.now(), hooks = {}, fsImpl = fs }: any): any {
  const read = readPlan(planId, homeDir, fsImpl);
  if (read.finding) return { ok: false, findings: [read.finding] };
  const { plan } = read;
  if (action !== null && plan.action !== action) {
    return { ok: false, findings: [finding('action', 'bad-type', `plan ${planId} is ${plan.action === 'add' ? 'an add' : 'an update'} plan`, `a plan made by ${action}`, plan.package.id)] };
  }
  const hold = acquireRunLock({ scopeRoot: homeDir, scope: 'global', command: `package ${plan.action}` });
  try {
    pruneStale({ homeDir, env, now, fsImpl });
    return applyLocked({ plan, homeDir, repoRoot, now, hooks, fsImpl });
  } finally {
    hold.release();
  }
}

function applyLocked({ plan, homeDir, repoRoot, now, hooks, fsImpl }: any): any {
  const id = plan.package.id;
  const lock = readLock({ scope: 'global', homeDir }, { fsImpl });
  const rows = lockPackages(lock);
  const previous = rows.find((r: any) => r.id === id) ?? null;
  if (plan.action === 'add' && previous) {
    return { ok: false, findings: [finding('id', 'collision-package', `package '${id}' is already recorded; use update`, 'an id no recorded package uses', id)] };
  }
  if (plan.action === 'update' && !previous) {
    return { ok: false, findings: [finding('id', 'bad-id', `no package with id '${id}' is recorded`, 'the id of a recorded package', id)] };
  }
  const analysis = analyze(plan.source.path, { repoRoot, fsImpl });
  if (!analysis.ok) return { ok: false, findings: analysis.findings };
  const changed = [
    ['contentDigest', analysis.contentDigest, plan.contentDigest], ['capabilityDigest', analysis.capabilityDigest, plan.capabilityDigest],
    ['id', analysis.manifest.id, id],
  ].filter(([, now_, planned]) => now_ !== planned);
  if (changed.length > 0) {
    return { ok: false, findings: changed.map(([field]) => finding(field, 'digest-mismatch', `${field} of ${plan.source.path} differs from plan ${plan.planId}; plan again`, `the ${field} the plan recorded`, id)) };
  }

  const { store } = packagePaths(homeDir);
  const digest16 = plan.contentDigest.slice(0, 16);
  const staging = path.join(store, `.staging-${plan.planId}`);
  const idDir = path.join(store, id);
  const entry = path.join(idDir, digest16);
  fsImpl.mkdirSync(store, { recursive: true });
  fsImpl.rmSync(staging, { recursive: true, force: true });
  const mismatch = (message: string) => {
    fsImpl.rmSync(staging, { recursive: true, force: true });
    return { ok: false, findings: [finding('contentDigest', 'digest-mismatch', message, `the contentDigest the plan recorded`, id)] };
  };
  try {
    const source = walkTree(plan.source.path, analysis.limits, { fsImpl });
    if (source.findings.length > 0) return mismatch(`${plan.source.path} no longer passes the tree rules (${source.findings.map((f: any) => f.code).join(', ')}); plan again`);
    copyFiles(source.files, staging, fsImpl);
    if (typeof hooks.afterCopy === 'function') hooks.afterCopy(staging);
    if (digestOf(staging, analysis.limits, fsImpl) !== plan.contentDigest) return mismatch(`the staged copy of ${plan.source.path} differs from plan ${plan.planId}; plan again`);

    fsImpl.mkdirSync(idDir, { recursive: true });
    let created = false;
    if (fsImpl.existsSync(entry)) {
      // A leftover of an interrupted run, or an update that changed capabilities only: reuse it when it holds the planned bytes.
      fsImpl.rmSync(staging, { recursive: true, force: true });
      if (digestOf(entry, analysis.limits, fsImpl) !== plan.contentDigest) {
        return { ok: false, findings: [finding('store', 'integrity-mismatch', `the store entry for ${id} ${digest16} does not hold the planned bytes`, 'an intact store entry', id)] };
      }
    } else {
      fsImpl.renameSync(staging, entry);
      created = true;
    }
    const row = {
      id, version: analysis.manifest.version, source: plan.source, contentDigest: plan.contentDigest, capabilityDigest: plan.capabilityDigest,
      enabled: previous ? previous.enabled : false, addedAt: previous ? previous.addedAt : new Date(now).toISOString(),
    };
    try {
      if (typeof hooks.afterRename === 'function') hooks.afterRename(entry);
      atomicJsonWrite(`${entry}${MARKER_SUFFIX}`, {
        marker: 1, planId: plan.planId, action: plan.action, source: plan.source, contentDigest: plan.contentDigest,
        capabilityDigest: plan.capabilityDigest, installedAt: new Date(now).toISOString(),
      }, { fsImpl });
      writeLock({ scope: 'global', homeDir }, { ...(lock ?? defaultLock({ scope: 'global', scopeRoot: homeDir })), packages: [...rows.filter((r: any) => r.id !== id), row] }, { fsImpl });
    } catch (error) {
      if (created) removeEntry(idDir, digest16, fsImpl);
      throw error;
    }
    const oldDigest16 = previous ? previous.contentDigest.slice(0, 16) : null;
    const leftover = oldDigest16 !== null && oldDigest16 !== digest16 && !removeEntry(idDir, oldDigest16, fsImpl);
    return { ok: true, action: plan.action, id, version: row.version, enabled: row.enabled, storeDir: entry, contentDigest: row.contentDigest, capabilityDigest: row.capabilityDigest, leftover };
  } finally {
    fsImpl.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { planIdFor, planPackage, applyPlan, packagePaths, removeEntry, PLAN_ID, MARKER_SUFFIX };
