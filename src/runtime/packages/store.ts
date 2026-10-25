'use strict';

/**
 * Plans, the package store and the apply step (122 IC-006, IC-007, IC-012 `add` and `update` for a local
 * source, IC-024 storage). A plan is a file under `~/.doflow/packages/plans/` that changes no record and
 * activates nothing; applying one takes the global scope's `run.lock`, re-snapshots the source, recomputes both
 * digests, stages a copy, re-hashes it, renames it into `store/<id>/<contentDigest first 16 hex>/`, writes the
 * `.installed-from.json` marker beside the tree and writes the lock row last. A failure after the rename removes
 * the entry before the lock is touched. Nothing here writes the person grant file.
 *
 * The plan's `projection` (IC-006) names, per harness of the global lock's `targets`, the skills and agents the
 * package would project there and the listing bytes they add to that harness's always-loaded context; the
 * projection itself is the lifecycle's (IC-017, `src/lifecycle/index.ts`), which asks `projectionReach` here which
 * harness can take which point. Remote plans retain a fetched snapshot and apply it without fetching again.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { isPackageId, projectedName } = require('../../helper/package-ids.ts');
const { checkPackage, MANIFEST_FILE } = require('./manifest.ts');
const { loadPoints } = require('./points.ts');
const { walkTree, digestFiles, canonicalJson } = require('./digest.ts');
const { hostVersion } = require('./view.ts');
const { readLock, writeLock, defaultLock, lockPackages } = require('../../state/lockfile.ts');
const { atomicJsonWrite } = require('../../state/index.ts');
const { acquireRunLock } = require('../../state/run-lock.ts');
const { pinSource, fetchSource } = require('./source.ts');
const { pinnedSourceFindings } = require('./index-file.ts');

const PLAN_VERSION = 1;
const PLAN_ID = /^[0-9a-f]{16}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MARKER_SUFFIX = '.installed-from.json';
const TIER_ORDER = ['inert', 'instruction', 'executable'];

const sha256 = (data: string): string => crypto.createHash('sha256').update(data).digest('hex');
const isObject = (value: any): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);

/** `~/.doflow/packages` and its parts for a home directory. */
function packagePaths(homeDir: string): { base: string; plans: string; store: string; fetched: string } {
  const base = path.join(homeDir, '.doflow', 'packages');
  return { base, plans: path.join(base, 'plans'), store: path.join(base, 'store'), fetched: path.join(base, 'fetched') };
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

// ── projection reach and the plan's `projection` (IC-017, IC-006) ───────────────────────────────────

/** The built-in asset whose per-harness projection (renderer, transform, layout, destination) a package
 * contribution of each instruction point borrows, so it lands where and how DoFlow's own skills and agents do. */
const BORROWED_ASSET: Record<string, string> = { skill: 'skills.doflow', agent: 'agents.shared' };
const CAPABILITY: Record<string, string> = { skill: 'skills', agent: 'agents' };
const INSTRUCTION_POINTS = Object.keys(BORROWED_ASSET);

/**
 * Whether `harnessId` can take a package contribution of `point` (IC-017 harness reach): `{ ok: true, projection,
 * nativeDir }` with the borrowed asset's projection for that harness, else `{ ok: false, reason }`. The capability
 * is the harness's `skills` or `agents` capability in `harnesses.json`; `unavailable` is the gap NFR-003 names.
 */
function projectionReach(registry: any, harnessId: string, point: string): any {
  const harness = registry.harnesses.find((h: any) => h.id === harnessId);
  if (!harness) return { ok: false, reason: 'it is not a harness this DoFlow knows' };
  const name = CAPABILITY[point];
  if (!name) return { ok: false, reason: `${point} is not an instruction point` };
  const capability = harness.capabilities?.[name];
  if (!capability || capability.status === 'unavailable') return { ok: false, reason: `its ${name} capability is unavailable` };
  const asset = registry.assets.find((a: any) => a.id === BORROWED_ASSET[point]);
  const projection = asset?.projection?.[harnessId];
  if (!projection) return { ok: false, reason: `DoFlow projects no ${name} into it (capability ${capability.status})` };
  return { ok: true, projection, nativeDir: asset.nativeDir?.[harnessId] ?? '' };
}

/** The `name: value` pairs of a Markdown file's frontmatter, quotes stripped; empty when there is none. */
function frontmatterValues(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const values: Record<string, string> = {};
  for (const line of match ? match[1].split(/\r?\n/) : []) {
    const item = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (item) values[item[1]] = item[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return values;
}

/** The bytes a contribution adds to a harness's always-loaded listing: its name and description, plus a skill's
 * `when_to_use` (what G22 counts for DoFlow's own skills). 0 when the file cannot be read. */
function listingBytes(file: string, fsImpl: any): number {
  try {
    const values = frontmatterValues(String(fsImpl.readFileSync(file, 'utf8')));
    return ['name', 'description', 'when_to_use'].reduce((sum, key) => sum + Buffer.byteLength(values[key] ?? '', 'utf8'), 0);
  } catch { return 0; }
}

/** The instruction contributions of a manifest: `{ point, qualifiedId, name, path }`, `path` relative to the package root. */
function instructionEntries(manifest: any): any[] {
  return (Array.isArray(manifest?.contributions) ? manifest.contributions : [])
    .filter((c: any) => c && INSTRUCTION_POINTS.includes(c.point) && c.version === 1 && typeof c.id === 'string' && typeof (c.point === 'skill' ? c.dir : c.file) === 'string')
    .map((c: any) => ({ point: c.point, qualifiedId: `${manifest.id}.${c.id}`, name: projectedName(`${manifest.id}.${c.id}`) ?? `${manifest.id}-${c.id}`, path: c.point === 'skill' ? c.dir : c.file }));
}

/**
 * The plan's `projection` (IC-006): per harness of the global lock's `targets`, the projected names by point and
 * the listing bytes they add there; a contribution the harness cannot take is named under `unreachable` and in
 * `warnings`. `{}` for a package with no skill or agent, or when no harness is installed at global scope.
 */
function projectionPreview(dir: string, manifest: any, lock: any, { repoRoot = REPO_ROOT, registry, fsImpl = fs }: any = {}): { projection: Record<string, any>; warnings: string[] } {
  const entries = instructionEntries(manifest);
  const harnesses = (lock?.targets ?? []).map((t: any) => t?.harness).filter((h: any) => typeof h === 'string');
  const projection: Record<string, any> = {};
  const warnings: string[] = [];
  if (entries.length === 0 || harnesses.length === 0) return { projection, warnings };
  const reg = registry ?? require('../../registry/index.ts').loadRegistry({ repoRoot });
  for (const harness of harnesses) {
    const row: any = { listingBytes: 0 };
    for (const entry of entries) {
      const reach = projectionReach(reg, harness, entry.point);
      if (!reach.ok) {
        (row.unreachable ??= []).push(entry.name);
        warnings.push(`${harness} cannot take ${entry.point} ${entry.qualifiedId}: ${reach.reason}`);
        continue;
      }
      (row[entry.point] ??= []).push(entry.name);
      row.listingBytes += listingBytes(path.join(dir, ...entry.path.split('/'), ...(entry.point === 'skill' ? ['SKILL.md'] : [])), fsImpl);
    }
    projection[harness] = row;
  }
  return { projection, warnings };
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
 * Check a directory and write its plan. Local calls write only the plan. Remote calls supply a pinnedSource
 * and move their checked staging tree into fetched/<planId> before publishing the plan.
 */
function planPackage({ action, source, id, pinnedSource, expected, homeDir = os.homedir(), repoRoot = REPO_ROOT, now = Date.now(), hash, registry, fsImpl = fs }: any): any {
  if (pinnedSource) {
    const findings = pinnedSourceFindings(pinnedSource);
    if (findings.length) return { ok: false, findings };
  }
  const lock = readLock({ scope: 'global', homeDir }, { fsImpl });
  const rows = lockPackages(lock);
  let sourcePath = source;
  if (action === 'update') {
    const row = rows.find((r: any) => r.id === id);
    if (!row) return { ok: false, findings: [finding('id', 'bad-id', `no package with id '${id}' is recorded`, 'the id of a recorded package', id)] };
    if (row.source?.type !== 'local') return { ok: false, findings: [finding('source', 'bad-type', `package '${id}' has a remote source; remove it and use add --source or add --index with a new spec`, 'a local source for update, or a new add after remove', id)] };
    sourcePath = row.source.path;
  }
  const analysis = analyze(sourcePath, { repoRoot, fsImpl });
  if (!analysis.ok) return { ok: false, findings: analysis.findings };
  const { manifest } = analysis;
  if (expected && (manifest.id !== expected.id || manifest.version !== expected.version)) {
    return { ok: false, findings: [finding('source', 'bad-id', `fetched package ${manifest.id} ${manifest.version} does not match index selection ${expected.id} ${expected.version}`, expected)] };
  }
  if (action === 'add' && rows.some((r: any) => r.id === manifest.id)) {
    return { ok: false, findings: [finding('id', 'collision-package', `package '${manifest.id}' is already recorded; use update`, 'an id no recorded package uses', manifest.id)] };
  }
  if (action === 'update' && manifest.id !== id) {
    return { ok: false, findings: [finding('id', 'bad-id', `the manifest at ${sourcePath} names '${manifest.id}', not '${id}'`, id, id)] };
  }
  const source_ = pinnedSource ?? { type: 'local', path: sourcePath };
  const planId = planIdFor(`${analysis.contentDigest}\0${analysis.capabilityDigest}\0${canonicalJson(source_)}`, hash);
  const grantLines: Record<string, string> = {};
  if (tierMax(analysis.inventory) !== 'inert') {
    grantLines.trust = JSON.stringify({
      grant: 'trust', package: manifest.id, version: manifest.version, contentDigest: analysis.contentDigest,
      capabilityDigest: analysis.capabilityDigest, policy: analysis.trustPolicyVersion, at: grantTime(now),
    });
  }
  const preview = projectionPreview(sourcePath, manifest, lock, { repoRoot, registry, fsImpl });
  const plan = {
    plan: PLAN_VERSION, planId, createdAt: new Date(now).toISOString(), action, source: source_,
    package: { id: manifest.id, version: manifest.version, doflow: manifest.doflow },
    contentDigest: analysis.contentDigest, capabilityDigest: analysis.capabilityDigest, trustPolicyVersion: analysis.trustPolicyVersion,
    inventory: analysis.inventory, programs: analysis.programs, projection: preview.projection, findings: analysis.findings, grantLines,
  };
  const paths = packagePaths(homeDir);
  const planFile = path.join(paths.plans, `${planId}.json`);
  if (pinnedSource) {
    const snapshot = path.join(paths.fetched, planId);
    fsImpl.mkdirSync(paths.fetched, { recursive: true });
    if (fsImpl.existsSync(snapshot)) {
      if (digestOf(snapshot, analysis.limits, fsImpl) !== analysis.contentDigest) {
        return { ok: false, findings: [finding('contentDigest', 'digest-mismatch', `retained snapshot for plan ${planId} has changed`, analysis.contentDigest, manifest.id)] };
      }
    } else {
      fsImpl.renameSync(sourcePath, snapshot);
    }
    fsImpl.utimesSync(snapshot, new Date(now), new Date(now));
  }
  atomicJsonWrite(planFile, plan, { fsImpl });
  return { ok: true, plan, planFile, tierMax: tierMax(analysis.inventory), projectionWarnings: preview.warnings, instructions: instructionEntries(manifest).length };
}

/** Pin, fetch and retain a checked remote tree. The command has already checked the fetch grant. */
function planRemote({ source, pinned, expected, homeDir = os.homedir(), repoRoot = REPO_ROOT, env = process.env, now = Date.now(), registry, fsImpl = fs }: any): any {
  if (!pinned) {
    const pin = pinSource(source, { env });
    if (!pin.ok) return { ok: false, findings: [pin.finding] };
    pinned = pin.pinned;
  }
  const findings = pinnedSourceFindings(pinned);
  if (findings.length) return { ok: false, findings };
  const loaded = loadPoints({ repoRoot });
  if (!loaded.ok) return { ok: false, findings: [finding('points', 'state-unreadable', loaded.errors.join('; '), 'a valid point registry')] };
  const staging = path.join(packagePaths(homeDir).fetched, `.staging-${crypto.randomBytes(8).toString('hex')}`);
  fsImpl.mkdirSync(path.dirname(staging), { recursive: true });
  fsImpl.mkdirSync(staging);
  try {
    const fetched = fetchSource(pinned, { stagingDir: staging, env, limits: loaded.registry.limits });
    if (!fetched.ok) return fetched;
    const tree = path.join(staging, 'tree');
    fsImpl.mkdirSync(tree);
    for (const file of fetched.files) {
      const target = path.join(tree, ...file.path.split('/'));
      fsImpl.mkdirSync(path.dirname(target), { recursive: true });
      fsImpl.writeFileSync(target, file.data);
      fsImpl.chmodSync(target, file.mode);
    }
    return planPackage({ action: 'add', source: tree, pinnedSource: pinned, expected, homeDir, repoRoot, now, registry, fsImpl });
  } finally {
    fsImpl.rmSync(staging, { recursive: true, force: true });
  }
}

/** A plan file's content when it is the IC-006 shape with a local or pinned remote source, else a finding. */
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
    && isObject(plan.source) && ((plan.source.type === 'local' && typeof plan.source.path === 'string' && path.isAbsolute(plan.source.path))
      || (plan.action === 'add' && pinnedSourceFindings(plan.source).length === 0))
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
    runPass({ registry, roots, stores: ['packages-plans', 'packages-staging', 'packages-fetched', 'packages-fetch-staging'], mode: 'prune', setting: { 'user-doflow': setting }, now, env, fsImpl });
    if (setting === 'on') {
      const paths = packagePaths(homeDir);
      if (fsImpl.existsSync(paths.fetched)) {
        for (const name of fsImpl.readdirSync(paths.fetched)) {
          if (PLAN_ID.test(name) && !fsImpl.existsSync(path.join(paths.plans, `${name}.json`))) {
            fsImpl.rmSync(path.join(paths.fetched, name), { recursive: true, force: true });
          }
        }
      }
    }
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
  const remote = plan.source.type !== 'local';
  const sourceDir = remote ? path.join(packagePaths(homeDir).fetched, plan.planId) : plan.source.path;
  if (remote) {
    const loaded = loadPoints({ repoRoot });
    if (!loaded.ok) return { ok: false, findings: [finding('points', 'state-unreadable', loaded.errors.join('; '), 'a valid point registry', id)] };
    if (digestOf(sourceDir, loaded.registry.limits, fsImpl) !== plan.contentDigest) {
      return { ok: false, findings: [finding('contentDigest', 'digest-mismatch', `fetched snapshot for plan ${plan.planId} is missing or changed; plan again`, plan.contentDigest, id)] };
    }
  }
  const analysis = analyze(sourceDir, { repoRoot, fsImpl });
  if (!analysis.ok) return { ok: false, findings: analysis.findings };
  const changed = [
    ['contentDigest', analysis.contentDigest, plan.contentDigest], ['capabilityDigest', analysis.capabilityDigest, plan.capabilityDigest],
    ['id', analysis.manifest.id, id],
  ].filter(([, now_, planned]) => now_ !== planned);
  if (changed.length > 0) {
    return { ok: false, findings: changed.map(([field]) => finding(field, 'digest-mismatch', `${field} of ${sourceDir} differs from plan ${plan.planId}; plan again`, `the ${field} the plan recorded`, id)) };
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
    const source = walkTree(sourceDir, analysis.limits, { fsImpl });
    if (source.findings.length > 0) return mismatch(`${sourceDir} no longer passes the tree rules (${source.findings.map((f: any) => f.code).join(', ')}); plan again`);
    copyFiles(source.files, staging, fsImpl);
    if (typeof hooks.afterCopy === 'function') hooks.afterCopy(staging);
    if (digestOf(staging, analysis.limits, fsImpl) !== plan.contentDigest) return mismatch(`the staged copy of ${sourceDir} differs from plan ${plan.planId}; plan again`);

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

module.exports = { planIdFor, planPackage, planRemote, applyPlan, packagePaths, removeEntry, projectionReach, instructionEntries, PLAN_ID, MARKER_SUFFIX };
