'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * C5 — sibling inspector (design C5, FR-007, R6).
 *
 * Reports files DoFlow does not manage that sit in a directory the harness loads **wholesale** —
 * every file present becomes operative context — and that also holds a managed asset. Such a file
 * is live context DoFlow did not put there, whatever it is called.
 *
 * **What this module deliberately does not report.** A directory the harness resolves **by name**
 * is not inspected at all, not even to count its entries. There the harness loads the named file
 * and nothing else, so a neighbouring file cannot take effect however it is named: a superseded
 * `SKILL.md.pre-v1.2.0-backup-*` sitting beside `SKILL.md` is inert, and reporting it is noise.
 * Within one scope DoFlow owns the path a same-named asset would occupy, so a same-scope name
 * collision cannot arise either; genuine cross-scope outranking is FR-004's question, answered by
 * `precedence.js`. This module therefore applies no filename heuristic whatsoever — in an inspected
 * directory, presence is the whole test (requirement §9, 2026-09-27; design §9, C5).
 *
 * **The bound on cost (R6).** Only the parent directories of assets already enumerated from the
 * ledger are read — one level, never recursed into. A managed tree that nests (Kiro's steering tree
 * mirrors `core/shared/guidance/`, `rules/` and `mcp/` included) is still covered completely
 * without a walk, because every subdirectory holding a managed file is itself the parent of a
 * managed resource and so is inspected on its own account. `mcp-builder/` and `skill-creator/`
 * sitting beside a managed skills directory are never enumerated: neither is the parent of a
 * managed asset (requirement §5, "Out of Scope").
 *
 * Two hard rules follow directly from the design:
 *   - No currency verdict is ever attached to a candidate (data-model `UNMANAGED_CANDIDATE`): there
 *     is no recorded fingerprint for a file DoFlow does not manage, so it is reported as present,
 *     never as diverged.
 *   - Read-only throughout (NFR-001). Nothing here writes, moves, or deletes.
 *
 * Follows this repo's directory-reading idiom (`src/runtime/knowledge/index-store.js`): a bare
 * `readdirSync(dir, { withFileTypes: true })` inside a try/catch that skips on failure. A managed
 * asset's parent directory may legitimately not exist — a recorded resource whose file was since
 * removed by hand — and that is not an error this read-only module raises.
 */

/**
 * The asset/harness pairs whose native directory the harness loads wholesale.
 *
 * **Nothing in the registry declares load semantics.** This set is derived from adapter behaviour,
 * read off two locators in this repository:
 *
 *   - `src/adapters/copy-tree.js` — the `copilot-rule-instructions` transform (line ~80) renders
 *     *every* file it copies under an `applyTo: '**'` front-matter header, so every file landing in
 *     `.github/instructions/` is always applied. Asset `instructions.copilot`, native dir
 *     `instructions`.
 *   - `src/adapters/kiro/index.js` (header comment, lines 8-12) — "Kiro receives DoFlow's *full*
 *     guidance tree as steering files", with no single-file instruction surface at all. Asset
 *     `guidance.context-layer` for the `kiro` harness only, native dir `steering`; the same asset's
 *     `../.doflow/guidance` projection for claude/codex/gemini/antigravity is name-resolved by
 *     explicit import and is not in this set.
 *
 * This is the single place to change. If the registry later declares load semantics per projection,
 * replace this constant's contents with that lookup — do not add a second source of the fact, and
 * do not infer it from a directory's name. An asset/harness pair absent here is name-resolved and
 * its directory is skipped entirely.
 *
 * @type {Readonly<Object<string, ReadonlyArray<string>>>} harness id -> registry asset ids
 */
const WHOLESALE_ASSETS = Object.freeze({
  copilot: Object.freeze(['instructions.copilot']),
  kiro: Object.freeze(['guidance.context-layer']),
});

/**
 * @typedef {Object} UnmanagedCandidate The `UNMANAGED_CANDIDATE` entity of the feature's data model.
 * @property {string} name The entry's own filename, exactly as read from the directory.
 * @property {string} path The entry's absolute path.
 * @property {string} parentDir The absolute directory it was found in — a managed asset's own
 *   parent, and one the harness loads wholesale.
 * @property {'file'|'directory'} kind What the entry is. A `directory` is an unmanaged directory
 *   inside a wholesale tree: its contents are loaded too, and were not enumerated because this
 *   module does not recurse. A directory that itself holds a managed asset is not a candidate at
 *   all — it is the managed tree's own structure.
 * @property {string} harness The harness whose wholesale load makes this file operative.
 * @property {string} assetId The registry asset whose directory it shares.
 *
 * No `currency` field exists on this shape, deliberately: an unmanaged file carries no recorded
 * fingerprint, so it can never be judged to match or diverge from anything.
 */

/** Whether this harness loads this asset's native directory wholesale. `Array.isArray` also guards
 * a harness id that collides with an `Object.prototype` key. */
function loadsWholesale(harness, assetId) {
  const assets = WHOLESALE_ASSETS[harness];
  return Array.isArray(assets) && assets.includes(assetId);
}

/** Groups managed resources by parent directory. Every well-formed resource contributes its leaf
 * filename (so a managed file is never mistaken for an unmanaged one) and its directory (so a
 * subdirectory holding managed assets is recognised as structure, not as a foreign entry); only
 * resources whose harness loads them wholesale contribute a `wholesale` target, and only a
 * directory with at least one of those is ever read. */
function groupByParentDir(resources) {
  const byDir = new Map();
  const managedDirs = new Set();
  for (const resource of resources ?? []) {
    const target = resource?.target;
    if (typeof target !== 'string' || target === '') continue;
    const dir = path.dirname(target);
    managedDirs.add(dir);
    if (!byDir.has(dir)) byDir.set(dir, { basenames: new Set(), wholesale: [] });
    const entry = byDir.get(dir);
    entry.basenames.add(path.basename(target));
    if (loadsWholesale(resource.harness, resource.assetId)) {
      entry.wholesale.push({ target, harness: resource.harness, assetId: resource.assetId });
    }
  }
  return { byDir, managedDirs };
}

/** Whether a directory entry is part of the managed tree's own structure — it is, or contains at
 * some depth, the parent directory of a managed resource. Scans `managedDirs`, which is bounded by
 * the number of managed resources rather than by directory size (R6). */
function holdsManagedAsset(candidatePath, managedDirs) {
  const prefix = candidatePath + path.sep;
  for (const dir of managedDirs) {
    if (dir === candidatePath || dir.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Inspects the wholesale-loaded parent directories of already-enumerated managed resources for
 * files DoFlow does not manage.
 *
 * @param {Object} options
 * @param {Array<{harness: string, assetId: string, target: string}>} options.resources Managed
 *   resources exactly as recorded — from one scope or both concatenated; this module does not care
 *   which scope a resource came from, only where it lives on disk and how its harness loads it.
 * @param {Object} [options.fsImpl] Injectable `node:fs`-shaped module, for hermetic tests.
 * @returns {{
 *   candidatesByTarget: Object<string, UnmanagedCandidate[]>,
 *   directoriesInspected: number,
 * }} `candidatesByTarget` maps a managed resource's absolute `target` to the unmanaged entries
 *   sharing its directory (present only for targets whose directory held at least one);
 *   `directoriesInspected` is how many wholesale directories actually existed and were read.
 *
 * **Nothing inspected is ever withheld, so no count of withheld entries is returned.** IC-002 names
 * such a count, and this module used to return it as a literal 0 to satisfy that name. Under the
 * narrowed FR-007 the two halves of this module's behaviour leave it no other value to hold: an
 * inspected directory is read in full and every entry that is neither a managed basename nor
 * managed structure is listed, and a directory that is not inspected is never read, so its entries
 * are not inspected either. A field with one reachable value states nothing — and reporting 0
 * beside eight reported siblings invited the reading that eight more had been hidden. IC-002's
 * final field is dropped with it (task F.3); see `index.js#buildInventoryReport`.
 */
function inspectSiblings({ resources, fsImpl = fs } = {}) {
  const { byDir, managedDirs } = groupByParentDir(resources);
  const candidatesByTarget = {};
  let directoriesInspected = 0;

  for (const [dir, { basenames, wholesale }] of byDir) {
    if (wholesale.length === 0) continue; // name-resolved: never read, not even to count.

    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // the managed asset's parent legitimately may not exist; not an error.
    }
    directoriesInspected += 1;

    const unmanaged = [];
    for (const entry of entries) {
      const name = entry.name;
      if (basenames.has(name)) continue; // the managed file itself.
      const entryPath = path.join(dir, name);
      const isDirectory = entry.isDirectory?.() === true;
      if (isDirectory && holdsManagedAsset(entryPath, managedDirs)) continue; // managed structure.
      unmanaged.push({ name, path: entryPath, parentDir: dir, kind: isDirectory ? 'directory' : 'file' });
    }
    if (unmanaged.length === 0) continue;

    // Attributed per managed target rather than shared, so each candidate names the harness and
    // asset whose wholesale load is the reason it is operative at all.
    for (const { target, harness, assetId } of wholesale) {
      candidatesByTarget[target] = unmanaged.map((found) => ({ ...found, harness, assetId }));
    }
  }

  return { candidatesByTarget, directoriesInspected };
}

module.exports = { inspectSiblings, WHOLESALE_ASSETS };
