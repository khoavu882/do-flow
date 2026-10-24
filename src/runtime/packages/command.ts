'use strict';

/**
 * `doflow package` (122 IC-012). A.3 ships the `points` action: the read-only list of contribution points. It
 * writes nothing and is on the no-upkeep list. Exit 0 listed, 1 the point registry is unusable, 2 usage; later
 * actions (check, list, add, ...) land in the tasks that own them.
 */

const { finishRuntime, captureCaught } = require('../cli-result.ts');
const { loadPoints, pointRows } = require('./points.ts');

function pointLine(row: any): string {
  return `point ${row.id}: tier=${row.tier} status=${row.status} entry=${row.entry} versions=${row.versions.join(',') || '-'}`
    + (row.opensWith ? ` opensWith=${row.opensWith}` : '');
}

function handlePackageCommand({ action, json = false, repoRoot, out = (line: string) => console.log(line) }: any = {}): number {
  if (action !== 'points') {
    const message = 'action must be points';
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
