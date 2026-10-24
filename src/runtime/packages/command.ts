'use strict';

/**
 * `doflow package` (122 IC-012). Read-only, on the no-upkeep list: `points` lists the contribution points;
 * `check --path <dir>` prints the IC-004 findings of a package directory and its digests; `list [--id]` and
 * `show --id` print the package view (IC-010). Writing: `add --source <dir>` and `update --id <id>` write a plan
 * file and nothing else; `add --plan <planId>` and `update --plan <planId>` apply it (store and lock row, see
 * store.ts) and run storage upkeep like other writers. Exit 0 done, listed or clean, 1 the point registry is
 * unusable, a package is neither `active` nor `disabled`, an id is unknown, the package has errors or an apply
 * is refused, 2 usage; later actions land in the tasks that own them.
 */

const { finishRuntime, captureCaught } = require('../cli-result.ts');
const path = require('node:path');
const { loadPoints, pointRows } = require('./points.ts');
const { checkPackage } = require('./manifest.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { packageView, hostVersion } = require('./view.ts');
const { readLock, LOCK_VERSION_BASE } = require('../../state/lockfile.ts');
const fs = require('node:fs');
const os = require('node:os');
const { planPackage, applyPlan, PLAN_ID } = require('./store.ts');
const { configHome } = require('../config-home.ts');
const { GRANTS_FILE } = require('./grants.ts');

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
function globalLockVersion(): number | null {
  try { return readLock({ scope: 'global' })?.version ?? LOCK_VERSION_BASE; } catch { return null; }
}

/**
 * `list [--id]` and `show --id`: the package view, read-only. `lockVersion` is the `version` of the global lock
 * on disk, 1 when there is none (the version written while no package is recorded) and null when it cannot be
 * read; the lock is only read here, never written. `list` exits 1 when a package is neither
 * `active` nor `disabled` or any finding is an error (a corrupt point registry among them); an unknown id is exit 1.
 */
function handleView({ action, id, json, repoRoot, out }: any): number {
  if (action === 'show' && (typeof id !== 'string' || id.length === 0)) {
    const message = 'show requires one --id <id>';
    out(json ? JSON.stringify({ ok: false, error: 'usage', message }) : `doflow package: ${message}`);
    return finishRuntime(2);
  }
  const view = packageView(repoRoot ? { repoRoot } : {});
  const wanted = typeof id === 'string' ? view.packages.filter((p: any) => p.id === id) : view.packages;
  if (typeof id === 'string' && wanted.length === 0) {
    const message = `no package with id '${id}'`;
    out(json ? JSON.stringify({ ok: false, error: 'unknown-package', message }) : `doflow package: ${message}`);
    return finishRuntime(1);
  }
  const findings = typeof id === 'string' ? view.findings.filter((f: any) => f.package === id) : view.findings;
  if (action === 'show') {
    out(json ? JSON.stringify(wanted[0]) : stateLine(wanted[0]));
    return finishRuntime(0);
  }
  if (json) out(JSON.stringify({ points: view.points, packages: wanted, findings, lockVersion: globalLockVersion() }));
  else {
    for (const p of wanted) out(stateLine(p));
    if (wanted.length === 0) out('no packages');
    for (const f of findings) out(findingLine(f));
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

/** `add --source <dir>` and `update --id <id>`: write the plan file, print it and how to apply it. Changes no record. */
function handlePlan({ action, source, id, json, repoRoot, homeDir, env, out }: any): number {
  if (action === 'add') {
    if (typeof source !== 'string' || source.length === 0) return usage(json, out, 'add requires one --source <dir> or one --plan <planId>');
    let isDir = false;
    try { isDir = fs.statSync(path.resolve(source)).isDirectory(); } catch { /* not a directory */ }
    if (!isDir) return usage(json, out, `--source must be a local package directory (an absolute or cwd-relative path to an existing directory); '${source}' is not one`);
  } else if (typeof id !== 'string' || id.length === 0) {
    return usage(json, out, 'update requires one --id <id> or one --plan <planId>');
  }
  const result = planPackage({ action, source: typeof source === 'string' ? path.resolve(source) : undefined, id, homeDir, repoRoot });
  if (!result.ok) return refusal(json, out, result.findings, `package refused: ${typeof source === 'string' ? path.resolve(source) : id}`);
  const { plan, planFile } = result;
  if (json) { out(JSON.stringify({ ok: true, planFile, plan })); return finishRuntime(0); }
  out(`plan ${plan.planId}: ${action} ${plan.package.id} ${plan.package.version} from ${plan.source.path}`);
  out(`written ${planFile} (a plan changes no record and activates nothing; DoFlow keeps it for 24 hours)`);
  for (const c of plan.inventory) out(`  ${c.point} ${c.qualifiedId} ${c.tier}`);
  if (plan.inventory.length === 0) out('  no contributions');
  for (const f of plan.findings) out(findingLine(f));
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

/** `add --plan <planId>` and `update --plan <planId>`: apply a plan. Exit 0 applied, 1 refused or failed. */
function handleApply({ action, plan, json, repoRoot, homeDir, env, hooks, out }: any): number {
  if (typeof plan !== 'string' || !PLAN_ID.test(plan)) return usage(json, out, '--plan takes a plan id printed by add or update (16 hex characters)');
  try {
    const result = applyPlan({ planId: plan, action, homeDir, repoRoot, env, hooks });
    if (!result.ok) return refusal(json, out, result.findings, `package refused: plan ${plan}`);
    if (json) out(JSON.stringify(result));
    else {
      out(`${result.action === 'add' ? 'added' : 'updated'} ${result.id} ${result.version} ${result.enabled ? 'enabled' : 'disabled'}`);
      out(`store ${result.storeDir}`);
      out(`contentDigest ${result.contentDigest}`);
      if (result.leftover) out('warning: the previous store entry could not be removed');
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

function handlePackageCommand({ action, path: pkgPath, id, source, plan, json = false, repoRoot, homeDir = os.homedir(), env = process.env, hooks, out = (line: string) => console.log(line) }: any = {}): number {
  if (action === 'add' || action === 'update') {
    const given = action === 'add' ? source : id;
    if (typeof plan === 'string' && plan.length > 0) {
      if (typeof given === 'string') return usage(json, out, `${action} takes ${action === 'add' ? '--source' : '--id'} or --plan, not both`);
      return handleApply({ action, plan, json, repoRoot, homeDir, env, hooks, out });
    }
    try {
      return handlePlan({ action, source, id, json, repoRoot, homeDir, env, out });
    } catch (error: any) {
      captureCaught(error, 'package', 1);
      console.error(`[ERROR] package: ${error?.message || String(error)}`);
      return finishRuntime(1);
    }
  }
  if (action === 'list' || action === 'show') {
    try {
      return handleView({ action, id, json, repoRoot, out });
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
    const message = 'action must be points, check, list, show, add or update';
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
