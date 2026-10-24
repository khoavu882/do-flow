'use strict';

const crypto = require('node:crypto');
const { loadRegistry } = require('../../registry/index.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

/** Stable JSON: object keys sorted at every depth. */
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** IC-007: digest a worker descriptor using readiness's stable JSON representation. */
function descriptorDigest(worker: any): string {
  return `sha256:${crypto.createHash('sha256').update(stable(worker)).digest('hex')}`;
}

/** IC-019: built-in worker entries in registry order; row 122 adds the package half using view. */
function workerCatalogue({ registry, view }: any = {}): Array<{ id: string; worker: any; origin: 'builtin'; descriptorDigest: string }> {
  const reg = registry || loadRegistry({ repoRoot: REPO_ROOT });
  return (reg.harnesses || [])
    .filter((h: any) => h.worker && typeof h.worker === 'object')
    .map((h: any) => ({ id: h.id, worker: h.worker, origin: 'builtin' as const, descriptorDigest: descriptorDigest(h.worker) }));
}

module.exports = { workerCatalogue, descriptorDigest };
