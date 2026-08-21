'use strict';

// Shared copy-tree engine — the generic "own a tree of files" implementation every asset
// declaring `renderer: "copy-tree"` in core/registry/assets.yaml needs. Codex's adapter already
// proved this per-file fingerprint/conflict model for agents and hooks (ownedRemovalPlan,
// nativeManagedResources); this module generalizes it so Claude, Gemini, and Codex's own
// tree-shaped assets (skills, rules, agent-specs, templates, scripts, modes, references) share
// one implementation instead of three adapter-specific copies.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function walkRelFiles(dir, fsImpl) {
  const out = [];
  for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkRelFiles(abs, fsImpl).map((rel) => path.join(entry.name, rel)));
    else if (entry.isFile()) out.push(entry.name);
  }
  return out;
}

/** Destination layouts. A copy-tree normally mirrors source paths exactly, but a harness may
 * require a different shape for the same content: Antigravity discovers a custom agent at
 * `.agents/agents/<name>/agent.md`, a directory per agent, so DoFlow's flat `<name>.md` specs were
 * written where that harness never looks. Declared per projection in the registry rather than
 * branched on inside an adapter, so the shape stays visible next to the asset it applies to.
 * @type {Record<string, (sourceRel: string) => string>}
 */
const LAYOUTS = {
  /** `spec-analyst.md` -> `spec-analyst/agent.md` */
  'dir-per-file:agent.md': (sourceRel) => {
    const ext = path.extname(sourceRel);
    return path.join(sourceRel.slice(0, sourceRel.length - ext.length), `agent${ext || '.md'}`);
  },
};

/** Resolve a declared layout name to its mapper. Unknown names fail loudly rather than silently
 * mirroring, because a typo would otherwise install to the wrong shape and look like it worked. */
function resolveLayout(name) {
  if (!name) return (rel) => rel;
  const layout = LAYOUTS[name];
  if (!layout) throw new Error(`Unknown copy-tree layout '${name}' (known: ${Object.keys(LAYOUTS).join(', ')})`);
  return layout;
}

/** List every source file with its would-be destination and content fingerprint. Does not touch
 * the destination tree beyond checking existence. `relPath` is destination-relative and doubles as
 * the ledger identity, so a layout change relocates the recorded resource too — planTree's
 * relocation handling then removes the old path rather than orphaning it. */
function discoverTree({ sourceDir, destDir, fsImpl = fs, layout }) {
  if (!fsImpl.existsSync(sourceDir)) throw new Error(`copy-tree source is missing: ${sourceDir}`);
  const mapRel = typeof layout === 'function' ? layout : resolveLayout(layout);
  const files = walkRelFiles(sourceDir, fsImpl).map((sourceRel) => {
    const relPath = mapRel(sourceRel);
    const sourceAbs = path.join(sourceDir, sourceRel);
    const destAbs = path.join(destDir, relPath);
    return { relPath, sourceAbs, destAbs, exists: fsImpl.existsSync(destAbs), fingerprint: sha256(fsImpl.readFileSync(sourceAbs)) };
  });
  return { files };
}

/**
 * Diff the source tree against `previousResources` (the ledger's prior per-file ownership
 * records: `{relPath, fingerprint}`) to produce create/update/remove changes, refusing to touch
 * any destination file whose on-disk content doesn't match its last-recorded fingerprint (or, for
 * a never-before-owned file, doesn't match the source it would be overwritten with) — the same
 * conflict-safety Codex's adapter already applies to agents and hooks.
 * `operation: 'remove'` skips the source tree entirely and only proposes removals for every
 * previously-owned file, mirroring Codex's `ownedRemovalPlan`.
 */
function planTree({ sourceDir, destDir, previousResources = [], operation = 'apply', fsImpl = fs, layout, force = false }) {
  const prevByPath = new Map(previousResources.map((resource) => [resource.relPath, resource]));
  const changes = [];
  const conflicts = [];

  // Fingerprints the CURRENT source would write, keyed by destination. Resolved lazily and only
  // when a recorded fingerprint has already failed to match, so the common removal path still
  // never reads the source tree. A missing source directory is not an error here — an asset can be
  // removed after its source moved — it simply leaves the recorded fingerprint as the only signal.
  let sourceByDest;
  const sourceFingerprint = (destAbs) => {
    if (sourceByDest === undefined) {
      sourceByDest = sourceDir && fsImpl.existsSync(sourceDir)
        ? new Map(discoverTree({ sourceDir, destDir, fsImpl, layout }).files.map((file) => [file.destAbs, file.fingerprint]))
        : new Map();
    }
    return sourceByDest.get(destAbs);
  };

  const proposeRemoval = (prev) => {
    // prev's OWN recorded location, not the current destDir — an asset whose nativeDir changed
    // since prev was recorded must be removed from where it actually is, not from where it would
    // land today. Absent (pre-this-fix data, or a caller-constructed previousResources entry with
    // no target) falls back to the old destDir-relative computation, unchanged.
    const destAbs = prev.target ?? path.join(destDir, prev.relPath);
    if (!fsImpl.existsSync(destAbs)) return;
    const current = sha256(fsImpl.readFileSync(destAbs));
    // Untampered on removal means the same two signals the apply path below already accepts: the
    // bytes this harness last recorded, or the bytes the current source would write. The second
    // one matters because a destination tree can be claimed by several harnesses (scripts.doflow
    // is one `<project>/.doflow/scripts` for claude, codex and gemini), so a sibling's update
    // legitimately rewrites files this harness's rows still describe — the same "a sibling
    // changed bytes my row still describes" case the apply path had to be taught, arriving here
    // as an un-releasable claim instead of a refused install. A hand edit matches neither and is
    // still refused. The OBSERVED fingerprint travels with the change so removeTree's own
    // pre-delete re-check agrees with the decision taken here rather than throwing mid-apply.
    if (!force && current !== prev.fingerprint && current !== sourceFingerprint(destAbs)) {
      conflicts.push(`${prev.relPath} was modified outside DoFlow`);
      return;
    }
    changes.push({ relPath: prev.relPath, target: destAbs, operation: 'remove', fingerprint: current });
  };

  if (operation === 'remove') {
    for (const prev of previousResources) proposeRemoval(prev);
    return { changes, conflicts };
  }

  const { files } = discoverTree({ sourceDir, destDir, fsImpl, layout });
  const satisfiedAtSameLocation = new Set();
  for (const file of files) {
    const prev = prevByPath.get(file.relPath);
    // prev.target === undefined means "location unknown" (pre-this-fix ledger data, or a
    // caller-constructed previousResources entry) — treat as same-location, matching pre-fix
    // behavior exactly, rather than misreading "no data" as "relocated" and spuriously removing
    // it. Only an explicit, differing target means the asset's nativeDir actually changed.
    const sameLocation = prev !== undefined && (prev.target === undefined || prev.target === file.destAbs);
    if (sameLocation) satisfiedAtSameLocation.add(file.relPath);
    if (file.exists) {
      // A destination file is untampered if it matches the source we are about to write, OR the
      // fingerprint this harness last recorded AT THIS LOCATION. Source-match is checked FIRST and
      // unconditionally: it is the stronger signal, and a present-but-stale `prev` must not shadow
      // it.
      //
      // This matters because guidance.context-layer projects one destination for all three
      // harnesses while ownership is recorded per harness, so a sibling's install legitimately
      // changes bytes that this harness's row still describes. Comparing only against `prev` made
      // that indistinguishable from a hand edit and refused the whole install. Ordering the
      // disjunction this way adds no new notion of safety — it stops a weaker signal from
      // preempting a check that would have passed. Gating the fallback on `sameLocation` (rather
      // than `prev !== undefined` alone, as before) is strictly more precise: a relocated asset's
      // old row describes different bytes at a different path, so it must not be consulted here.
      const current = sha256(fsImpl.readFileSync(file.destAbs));
      const knownGood = force || current === file.fingerprint || (sameLocation && current === prev.fingerprint);
      if (!knownGood) { conflicts.push(`${file.relPath} was modified outside DoFlow`); continue; }
    }
    if (sameLocation && prev.fingerprint === file.fingerprint && file.exists) continue; // unchanged, no-op
    changes.push({ relPath: file.relPath, target: file.destAbs, source: file.sourceAbs,
      operation: sameLocation ? 'update' : 'create', fingerprint: file.fingerprint });
  }
  for (const prev of previousResources) {
    if (!satisfiedAtSameLocation.has(prev.relPath)) proposeRemoval(prev);
  }
  return { changes, conflicts };
}

/** Write every create/update change. Preserves the source file's mode (so a hook script's +x
 * bit survives the copy without a separate chmod pass) and mtime, matching this codebase's
 * general convention for a lifecycle-owned write (see src/adapters/claude/index.js's
 * applySettingsAsset for the same pattern applied to a transformed-content file). */
function applyTree({ changes = [], fsImpl = fs }) {
  let applied = 0;
  for (const change of changes) {
    if (change.operation === 'remove') continue;
    fsImpl.mkdirSync(path.dirname(change.target), { recursive: true });
    fsImpl.copyFileSync(change.source, change.target);
    const sourceStat = fsImpl.statSync(change.source);
    fsImpl.chmodSync(change.target, sourceStat.mode & 0o777);
    fsImpl.utimesSync(change.target, Math.floor(sourceStat.atimeMs / 1000), Math.floor(sourceStat.mtimeMs / 1000));
    applied += 1;
  }
  return { applied };
}

/** Delete every remove change, re-checking each file's fingerprint immediately before deletion —
 * refuses (throws) rather than silently deleting a file modified since planTree ran. */
function removeTree({ changes = [], fsImpl = fs }) {
  let removed = 0;
  for (const change of changes) {
    if (change.operation !== 'remove') continue;
    if (!fsImpl.existsSync(change.target)) continue;
    const current = sha256(fsImpl.readFileSync(change.target));
    if (current !== change.fingerprint) throw new Error(`Refusing to remove modified copy-tree resource: ${change.relPath}`);
    fsImpl.rmSync(change.target, { force: true });
    removed += 1;
  }
  return { removed };
}

/** Re-derive ownership resources from what's actually on disk right now, for status/verify. */
function verifyTree({ sourceDir, destDir, fsImpl = fs, layout }) {
  const { files } = discoverTree({ sourceDir, destDir, fsImpl, layout });
  const resources = [];
  const conflicts = [];
  for (const file of files) {
    if (!file.exists) continue;
    const current = sha256(fsImpl.readFileSync(file.destAbs));
    if (current !== file.fingerprint) { conflicts.push(`${file.relPath} does not match source`); continue; }
    resources.push({ relPath: file.relPath, target: file.destAbs, fingerprint: file.fingerprint });
  }
  return { ok: conflicts.length === 0, resources, conflicts };
}

// ---- per-adapter copy-tree glue, shared so codex/claude/gemini don't each carry their own copy ----

/** Filter a harness's asset list down to the ones this engine handles. */
function copyTreeAssets(assets) {
  return (assets || []).filter((asset) => asset?.renderer === 'copy-tree');
}

/** Recursively sort object keys before serializing, so two logically-equal objects with
 * differently-ordered keys (e.g. after a settings file is merged and re-merged) fingerprint
 * identically instead of spuriously registering as changed. */
function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableSort(value[key])]));
}

/** Content fingerprint every adapter uses to track what it owns: sha256 of a string as-is, or of
 * a stably key-sorted JSON serialization of anything else. */
function fingerprint(value) {
  return sha256(typeof value === 'string' ? value : JSON.stringify(stableSort(value)));
}

/** Read and parse a native JSON file an adapter merges into. Distinguishes "absent" (safe to
 * create) from "present but unparseable" (a conflict to report, never silently overwritten) —
 * every adapter that merges into a native JSON settings/config file needs exactly this. */
function readJson(file, { fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(file)) return { exists: false, value: {}, error: null };
  try { return { exists: true, value: JSON.parse(fsImpl.readFileSync(file, 'utf8')), error: null }; }
  catch (error) { return { exists: true, value: null, error: `Invalid JSON in ${file}: ${error.message}` }; }
}

/** Resolve an asset's source directory against the repo root, refusing a path that escapes the
 * repository or does not exist. `harnessName` only shapes the thrown error message. */
function sourceDirFor(asset, context = {}, fsImpl = fs, harnessName = 'Adapter') {
  if (!asset || typeof asset.source !== 'string') throw new Error(`${harnessName} asset requires a source path`);
  const repoRoot = context.repoRoot ? path.resolve(context.repoRoot) : process.cwd();
  const source = path.resolve(repoRoot, asset.source);
  if (!source.startsWith(`${repoRoot}${path.sep}`) || !fsImpl.existsSync(source)) {
    throw new Error(`${harnessName} asset source is unavailable: ${asset.source}`);
  }
  return source;
}

/** Resolve an asset's native destination directory under the harness's already-resolved config dir. */
function copyTreeDestDir(configDir, asset) {
  return path.join(configDir, asset.nativeDir || '');
}

/** Narrow a harness's flat neutral-resource list to one asset's previously-owned copy-tree files. */
function ledgerFileResources(resources, harness, assetId) {
  return (resources || [])
    .filter((resource) => resource.harness === harness && resource.assetId === assetId && resource.kind === 'copy-tree-file')
    .map((resource) => ({ relPath: resource.identity, fingerprint: resource.fingerprint, target: resource.target }));
}

module.exports = { discoverTree, planTree, applyTree, removeTree, verifyTree, copyTreeAssets, copyTreeDestDir, ledgerFileResources, resolveLayout, LAYOUTS, fingerprint, readJson, sourceDirFor };
