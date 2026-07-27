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

/** List every source file with its would-be destination and content fingerprint. Does not touch
 * the destination tree beyond checking existence. */
function discoverTree({ sourceDir, destDir, fsImpl = fs }) {
  if (!fsImpl.existsSync(sourceDir)) throw new Error(`copy-tree source is missing: ${sourceDir}`);
  const files = walkRelFiles(sourceDir, fsImpl).map((relPath) => {
    const sourceAbs = path.join(sourceDir, relPath);
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
function planTree({ sourceDir, destDir, previousResources = [], operation = 'apply', fsImpl = fs }) {
  const prevByPath = new Map(previousResources.map((resource) => [resource.relPath, resource]));
  const changes = [];
  const conflicts = [];

  const proposeRemoval = (prev) => {
    const destAbs = path.join(destDir, prev.relPath);
    if (!fsImpl.existsSync(destAbs)) return;
    const current = sha256(fsImpl.readFileSync(destAbs));
    if (current !== prev.fingerprint) { conflicts.push(`${prev.relPath} was modified outside DoFlow`); return; }
    changes.push({ relPath: prev.relPath, target: destAbs, operation: 'remove', fingerprint: prev.fingerprint });
  };

  if (operation === 'remove') {
    for (const prev of previousResources) proposeRemoval(prev);
    return { changes, conflicts };
  }

  const { files } = discoverTree({ sourceDir, destDir, fsImpl });
  const seen = new Set();
  for (const file of files) {
    seen.add(file.relPath);
    const prev = prevByPath.get(file.relPath);
    if (file.exists) {
      const current = sha256(fsImpl.readFileSync(file.destAbs));
      const knownGood = prev ? current === prev.fingerprint : current === file.fingerprint;
      if (!knownGood) { conflicts.push(`${file.relPath} was modified outside DoFlow`); continue; }
    }
    if (prev && prev.fingerprint === file.fingerprint && file.exists) continue; // unchanged, no-op
    changes.push({ relPath: file.relPath, target: file.destAbs, source: file.sourceAbs,
      operation: prev ? 'update' : 'create', fingerprint: file.fingerprint });
  }
  for (const prev of previousResources) {
    if (!seen.has(prev.relPath)) proposeRemoval(prev);
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
function verifyTree({ sourceDir, destDir, fsImpl = fs }) {
  const { files } = discoverTree({ sourceDir, destDir, fsImpl });
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

/** Resolve an asset's native destination directory under the harness's already-resolved config dir. */
function copyTreeDestDir(configDir, asset) {
  return path.join(configDir, asset.nativeDir || '');
}

/** Narrow a harness's flat neutral-resource list to one asset's previously-owned copy-tree files. */
function ledgerFileResources(resources, harness, assetId) {
  return (resources || [])
    .filter((resource) => resource.harness === harness && resource.assetId === assetId && resource.kind === 'copy-tree-file')
    .map((resource) => ({ relPath: resource.identity, fingerprint: resource.fingerprint }));
}

module.exports = { discoverTree, planTree, applyTree, removeTree, verifyTree, copyTreeAssets, copyTreeDestDir, ledgerFileResources };
