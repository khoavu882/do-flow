'use strict';

/**
 * `doflow package` (122 IC-012). Four read-only actions so far, all on the no-upkeep list: `points` lists the
 * contribution points; `check --path <dir>` prints the IC-004 findings of a package directory and its digests;
 * `list [--id]` and `show --id` print the package view (IC-010). Exit 0 listed or clean, 1 the point registry is
 * unusable, a package is neither `active` nor `disabled`, an id is unknown or the package has errors, 2 usage;
 * later actions (add, ...) land in the tasks that own them. Collisions against recorded packages are a Phase B concern.
 */

const { finishRuntime, captureCaught } = require('../cli-result.ts');
const path = require('node:path');
const { loadPoints, pointRows } = require('./points.ts');
const { checkPackage } = require('./manifest.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { packageView, hostVersion } = require('./view.ts');
const { readLock, LOCK_VERSION_BASE } = require('../../state/lockfile.ts');

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

function handlePackageCommand({ action, path: pkgPath, id, json = false, repoRoot, out = (line: string) => console.log(line) }: any = {}): number {
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
    const message = 'action must be points, check, list or show';
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
