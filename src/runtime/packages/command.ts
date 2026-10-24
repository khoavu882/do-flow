'use strict';

/**
 * `doflow package` (122 IC-012). Two read-only actions so far, both on the no-upkeep list: `points` lists the
 * contribution points; `check --path <dir>` prints the IC-004 findings of a package directory and its digests.
 * Exit 0 listed or clean, 1 the point registry is unusable or the package has errors, 2 usage; later actions
 * (list, add, ...) land in the tasks that own them. Collisions against recorded packages are a Phase B concern.
 */

const { finishRuntime, captureCaught } = require('../cli-result.ts');
const path = require('node:path');
const { loadPoints, pointRows } = require('./points.ts');
const { checkPackage } = require('./manifest.ts');
const fs = require('node:fs');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

function pointLine(row: any): string {
  return `point ${row.id}: tier=${row.tier} status=${row.status} entry=${row.entry} versions=${row.versions.join(',') || '-'}`
    + (row.opensWith ? ` opensWith=${row.opensWith}` : '');
}

/** The running DoFlow version; null when package.json is not shipped or unreadable, which the checker reports as host-incompatible. */
function hostVersion(repoRoot: string): string | null {
  try { return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version || null; } catch { return null; }
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

function handlePackageCommand({ action, path: pkgPath, json = false, repoRoot, out = (line: string) => console.log(line) }: any = {}): number {
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
    const message = 'action must be points or check';
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
