'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry } = require('../../registry/index.ts');
const { validateWorker } = require('../../registry/index.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { PARSERS } = require('./parsers.ts');

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

/** IC-019: built-in worker entries in registry order, followed by active package workers in qualified id order. */
function workerCatalogue({ registry, view, repoRoot = REPO_ROOT }: any = {}): Array<{ id: string; worker: any; origin: 'builtin' | 'package'; packageId?: string; descriptorDigest: string }> {
  const reg = registry || loadRegistry({ repoRoot });
  const builtin = (reg.harnesses || [])
    .filter((h: any) => h.worker && typeof h.worker === 'object')
    .map((h: any) => ({
      id: h.id,
      worker: h.worker,
      origin: 'builtin' as const,
      descriptorDigest: descriptorDigest(h.worker),
    }));

  const pkgWorkers: Array<{ id: string; worker: any; origin: 'package'; packageId: string; descriptorDigest: string }> = [];
  try {
    const { packageView } = require('../packages/view.ts');
    const { MANIFEST_FILE } = require('../packages/manifest.ts');
    const v = view || packageView({ repoRoot });
    for (const pkg of v.packages || []) {
      if (pkg.state !== 'active' || !pkg.storeDir) continue;
      let manifest: any;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(pkg.storeDir, MANIFEST_FILE), 'utf8'));
      } catch {
        continue;
      }
      const contributions = Array.isArray(manifest.contributions) ? manifest.contributions : [];
      for (const c of contributions) {
        if (c.point !== 'worker' || c.version !== 1 || typeof c.id !== 'string' || typeof c.file !== 'string') continue;
        const qid = `${pkg.id}.${c.id}`;
        const workerFile = path.resolve(pkg.storeDir, c.file);
        if (!workerFile.startsWith(path.resolve(pkg.storeDir) + path.sep)) continue;
        let rawWorker: any;
        try {
          rawWorker = JSON.parse(fs.readFileSync(workerFile, 'utf8'));
        } catch {
          continue;
        }

        const errors: string[] = [];
        const location = `package '${pkg.id}' worker '${c.id}'`;
        validateWorker(rawWorker, location, errors);
        if (rawWorker?.structuredOutput?.parser && !Object.hasOwn(PARSERS, rawWorker.structuredOutput.parser)) {
          errors.push(`parser '${rawWorker.structuredOutput.parser}' is not in core PARSERS`);
        }
        if (errors.length > 0) continue;

        const program = (manifest.programs || []).find((p: any) => (c.programs || []).includes(p.id) || p.id === c.id);

        const worker = {
          ...rawWorker,
          family: 'unverified',
          ...(program ? { program, storeEntry: pkg.storeDir } : {}),
        };

        pkgWorkers.push({
          id: qid,
          worker,
          origin: 'package',
          packageId: pkg.id,
          descriptorDigest: descriptorDigest(rawWorker),
        });
      }
    }
  } catch {
    // view or packages unreadable
  }

  pkgWorkers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...builtin, ...pkgWorkers];
}

module.exports = { workerCatalogue, descriptorDigest };
