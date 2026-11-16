'use strict';

// Row 171 IC-004: the harness ids, their binaries and the retired ids, read from
// <repoRoot>/core/registry/harnesses.json once per root. Every list of "the harnesses" in src/ derives
// from here, so a new harness is a registry edit and no list changes.
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../helper/repo-root.ts');

interface HarnessIds {
  active: readonly string[];
  binaries: Readonly<Record<string, string>>;
  retired: readonly string[];
}

/** The id lists of one parsed harnesses.json: `harnesses[].id` in file order, `worker.cli.binary` for
 * each harness that declares one, and `retired[].id`. All frozen. */
function idsFrom(registry: any): HarnessIds {
  const harnesses: any[] = registry?.harnesses ?? [];
  const binaries: Record<string, string> = {};
  for (const harness of harnesses) {
    const binary = harness?.worker?.cli?.binary;
    if (typeof binary === 'string') binaries[harness.id] = binary;
  }
  return {
    active: Object.freeze(harnesses.map((harness) => harness.id)),
    binaries: Object.freeze(binaries),
    retired: Object.freeze((registry?.retired ?? []).map((record: any) => record.id)),
  };
}

const CACHE = new Map<string, HarnessIds>();

function idsAt(repoRoot: string): HarnessIds {
  let ids = CACHE.get(repoRoot);
  if (!ids) {
    ids = idsFrom(JSON.parse(fs.readFileSync(path.join(repoRoot, 'core', 'registry', 'harnesses.json'), 'utf8')));
    CACHE.set(repoRoot, ids);
  }
  return ids;
}

/** Active harness ids in registry order. */
function activeIds(repoRoot: string = REPO_ROOT): readonly string[] { return idsAt(repoRoot).active; }

/** The harness's `worker.cli.binary`, or null when the id is unknown or declares none. */
function binaryOf(id: string, repoRoot: string = REPO_ROOT): string | null {
  const { binaries } = idsAt(repoRoot);
  return Object.hasOwn(binaries, id) ? binaries[id] : null;
}

/** Retired harness ids (`retired[].id`). */
function retiredIds(repoRoot: string = REPO_ROOT): readonly string[] { return idsAt(repoRoot).retired; }

module.exports = { idsFrom, activeIds, binaryOf, retiredIds };
