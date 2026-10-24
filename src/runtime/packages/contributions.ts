'use strict';

/**
 * The contribution seam (122 IC-013). A point's owner calls `contributionsFor(point, version)` inside its own
 * loader (`loadProtocols` for the preset points); there is no shared loader for all registries. It returns the
 * entries of `active` packages only, each one through the point's validator, in ascending `qualifiedId` order.
 * A reserved point, an undeclared point or an unsupported version is a programming error and throws; a package
 * fault never does (FR-009): the entry is left out and, when the caller passes `problems`, named there.
 *
 * Phase A: the view holds the bundled first-party packages only. They are trusted at runtime and verified at
 * release (IC-015), so their entries go through the validator in core mode, which reads only the registries
 * under `core/registry/`; the package-mode extras (read-only agents, comparability) are checked by guard G68.
 * Phase B adds third-party packages and their package-mode validation here.
 */

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { packageView } = require('./view.ts');
const { loadPoints, POINT_VALIDATORS } = require('./points.ts');
const { MANIFEST_FILE } = require('./manifest.ts');
const { loadCoreProtocols, lensIds } = require('../review/protocols.ts');

const PRESET_KIND: Record<string, string> = { 'review-preset': 'review', 'debate-preset': 'debate' };

/**
 * `Array<{ qualifiedId, localId, packageId, firstParty, data, dir, provenance: { contentDigest, source } }>`.
 * Options: `view` (a package view; default: the view of `repoRoot`), `repoRoot`, `fsImpl`, `protocols` (the core
 * registry, to skip a re-read), `problems` (an array that collects one message per left-out entry).
 */
function contributionsFor(pointId: string, pointVersion: number, { view, repoRoot = REPO_ROOT, fsImpl = fs, protocols, problems }: any = {}): any[] {
  const loaded = loadPoints({ repoRoot, fsImpl });
  if (!loaded.ok) return []; // no point registry, no package: the view reports it
  const point = loaded.registry.points.find((p: any) => p.id === pointId);
  if (!point) throw new Error(`contributionsFor: point '${pointId}' is not declared`);
  if (point.status !== 'open') throw new Error(`contributionsFor: point '${pointId}' is ${point.status} and opens with ${point.opensWith}`);
  if (!point.versions.includes(pointVersion)) throw new Error(`contributionsFor: point '${pointId}' has no version ${pointVersion} (supported: ${point.versions.join(', ')})`);

  const skip = (qualified: string, why: string): void => { problems?.push(`${pointId} contribution '${qualified}' is left out: ${why}`); };
  const validator = POINT_VALIDATORS[point.validator];
  let context: any = null;
  const out: any[] = [];
  for (const pkg of (view ?? packageView({ repoRoot, fsImpl })).packages) {
    if (pkg.state !== 'active' || !pkg.storeDir || !pkg.firstParty) continue; // Phase B: third-party packages join here
    let entries: any[];
    try {
      entries = JSON.parse(fsImpl.readFileSync(path.join(pkg.storeDir, MANIFEST_FILE), 'utf8')).contributions;
    } catch (error: any) {
      problems?.push(`package ${pkg.id} is left out: ${MANIFEST_FILE} cannot be read (${error.message})`);
      continue;
    }
    for (const entry of entries) {
      if (entry.point !== pointId || entry.version !== pointVersion) continue;
      const qualified: string = entry.id; // the first-party package keeps bare built-in ids (IC-003)
      if (point.entry !== 'file' || typeof entry.file !== 'string') { skip(qualified, 'not a file entry'); continue; }
      const file = path.resolve(pkg.storeDir, entry.file);
      if (!file.startsWith(path.resolve(pkg.storeDir) + path.sep)) { skip(qualified, `${entry.file} leaves the package`); continue; }
      let data: any;
      try {
        data = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      } catch (error: any) {
        skip(qualified, `${entry.file} cannot be read as JSON (${error.message})`);
        continue;
      }
      if (context === null) {
        const core = protocols ? { ok: true, registry: protocols } : loadCoreProtocols({ repoRoot, fsImpl });
        if (!core.ok) { skip(qualified, 'the core protocol registry is unusable'); continue; }
        context = { lensIds: lensIds(core.registry), hardRoundCap: core.registry.hardRoundCap };
      }
      const errors: string[] = validator(entry.id, data, context);
      if (errors.length > 0) { skip(qualified, errors.join('; ')); continue; }
      out.push({
        qualifiedId: qualified, localId: entry.id, packageId: pkg.id, firstParty: true, data, dir: null,
        provenance: { contentDigest: pkg.contentDigest, source: pkg.source },
      });
    }
  }
  return out.sort((a, b) => (a.qualifiedId < b.qualifiedId ? -1 : a.qualifiedId > b.qualifiedId ? 1 : 0));
}

/**
 * The preset ids the bundled packages contribute, by kind, for `validateProtocols` (an `order` entry may name
 * one without `presets` holding it). Read from the manifests whatever their state, so an incompatible package
 * still names its ids; `opaque` is true when some bundled package names none (point registry or manifest
 * unreadable), because then an unresolved `order` id may be one of its own.
 */
function firstPartyPresets({ repoRoot = REPO_ROOT, fsImpl = fs, view }: any = {}): { review: string[]; debate: string[]; opaque: boolean } {
  const result = { review: [] as string[], debate: [] as string[], opaque: false };
  const packages = (view ?? packageView({ repoRoot, fsImpl })).packages;
  if (packages.length === 0 && !loadPoints({ repoRoot, fsImpl }).ok) result.opaque = true;
  for (const pkg of packages) {
    for (const c of pkg.contributions) {
      const kind = PRESET_KIND[c.point];
      if (kind) (result as any)[kind].push(c.qualifiedId);
    }
    if (pkg.contributions.length === 0) result.opaque = true;
  }
  return result;
}

module.exports = { contributionsFor, firstPartyPresets };
