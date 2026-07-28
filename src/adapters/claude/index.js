'use strict';

// Claude native adapter.  It owns only Claude path/format decisions; selection,
// ownership journalling, and native MCP reconciliation remain the lifecycle and
// MCP adapter concerns respectively.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { mergeMarkedSection, removeMarkedSection, MARKER_START, MARKER_END } = require('../../marker-merge');
const { selectMcpServers } = require('../../registry');
const { GLOBAL_HOOK_PREFIX, PROJECT_HOOK_PREFIX } = require('../../settings-scope');
const { mergeSettings, settingsContains, settingsContainsAny, stripManagedSettings } = require('../../settings-merge');
const { planTree, applyTree, removeTree, verifyTree, copyTreeAssets, copyTreeDestDir, ledgerFileResources } = require('../copy-tree');

const INSTRUCTION_RENDERER = 'claude-instructions';
const SETTINGS_RENDERER = 'claude-settings';
const SETTINGS_FILES = ['settings.json', 'keybindings.json'];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function nativePaths({ scope, scopeRoot }) {
  const root = path.resolve(scopeRoot);
  const configDir = path.join(root, '.claude');
  return {
    root,
    configDir,
    instructions: path.join(configDir, 'CLAUDE.md'),
    settings: path.join(configDir, 'settings.json'),
    // Claude discovers project MCP at the project root and user MCP in the
    // shared Claude JSON file, not under .claude/.
    mcp: scope === 'global' ? path.join(root, '.claude.json') : path.join(root, '.mcp.json'),
  };
}

function sourcePath(asset, context = {}) {
  if (!asset || typeof asset.source !== 'string') throw new Error('Claude asset requires a source path');
  const repoRoot = context.repoRoot ? path.resolve(context.repoRoot) : process.cwd();
  const source = path.resolve(repoRoot, asset.source);
  if (!source.startsWith(`${repoRoot}${path.sep}`) || !fs.existsSync(source)) {
    throw new Error(`Claude asset source is unavailable: ${asset.source}`);
  }
  return source;
}

function markerState(file) {
  if (!fs.existsSync(file)) return { exists: false, managed: false, malformed: false };
  const text = fs.readFileSync(file, 'utf8');
  const starts = text.split(MARKER_START).length - 1;
  const ends = text.split(MARKER_END).length - 1;
  return { exists: true, managed: starts === 1 && ends === 1, malformed: starts !== ends || starts > 1 };
}

function discover({ scope, scopeRoot, context = {}, registry }) {
  const paths = nativePaths({ scope, scopeRoot });
  return {
    paths,
    instructions: markerState(paths.instructions),
    settingsExists: fs.existsSync(paths.settings),
    mcpExists: fs.existsSync(paths.mcp),
    knownMcpServers: registry ? selectMcpServers(registry).map((server) => server.id) : [],
  };
}

// ---- copy-tree assets (rules, skills, agents, templates, scripts, modes, references, hooks) ----

function planCopyTreeAssets({ assets, scope, scopeRoot, context, ledger, removing }) {
  const paths = nativePaths({ scope, scopeRoot });
  const changes = [];
  const conflicts = [];
  for (const asset of copyTreeAssets(assets)) {
    const destDir = copyTreeDestDir(paths.configDir, asset);
    const sourceDir = sourcePath(asset, context);
    const previousResources = ledgerFileResources(ledger?.resources, 'claude', asset.id);
    const result = planTree({ sourceDir, destDir, previousResources, operation: removing ? 'remove' : 'apply' });
    conflicts.push(...result.conflicts.map((reason) => `${asset.id}: ${reason}`));
    for (const change of result.changes) {
      changes.push({
        assetId: asset.id, target: change.target, source: change.source, operation: change.operation,
        ownershipIdentity: `doflow:claude:copy-tree:${asset.id}:${change.relPath}`,
        kind: 'copy-tree-file', identity: change.relPath,
        afterFingerprint: change.fingerprint, fingerprint: change.fingerprint, sourceVersion: 'registry-v1',
        projection: { renderer: 'copy-tree' },
      });
    }
  }
  return { changes, conflicts };
}

function applyCopyTreeAssets(changes) {
  const treeChanges = changes.filter((change) => change.projection?.renderer === 'copy-tree' && change.operation !== 'remove')
    .map((change) => ({ relPath: change.identity, target: change.target, source: change.source, operation: change.operation, fingerprint: change.fingerprint }));
  return applyTree({ changes: treeChanges }).applied;
}

function removeCopyTreeAssets(changes) {
  const treeChanges = changes.filter((change) => change.projection?.renderer === 'copy-tree' && change.operation === 'remove')
    .map((change) => ({ relPath: change.identity, target: change.target, operation: 'remove', fingerprint: change.fingerprint }));
  return removeTree({ changes: treeChanges }).removed;
}

function verifyCopyTreeAssets({ assets, scope, scopeRoot, context }) {
  const paths = nativePaths({ scope, scopeRoot });
  const statuses = [];
  const resources = [];
  const conflicts = [];
  for (const asset of copyTreeAssets(assets)) {
    const destDir = copyTreeDestDir(paths.configDir, asset);
    const sourceDir = sourcePath(asset, context);
    const result = verifyTree({ sourceDir, destDir });
    conflicts.push(...result.conflicts.map((reason) => `${asset.id}: ${reason}`));
    for (const resource of result.resources) {
      resources.push({
        assetId: asset.id, target: resource.target, ownershipIdentity: `doflow:claude:copy-tree:${asset.id}:${resource.relPath}`,
        kind: 'copy-tree-file', identity: resource.relPath,
        fingerprint: resource.fingerprint, sourceVersion: 'registry-v1',
        projection: { renderer: 'copy-tree' },
      });
    }
    statuses.push({ assetId: asset.id, capability: asset.capability, status: result.ok ? 'managed' : 'conflict', target: destDir });
  }
  return { statuses, resources, conflicts };
}

// ---- claude-settings asset (settings.json + keybindings.json) ----

function settingsAsset(assets) { return (assets || []).find((asset) => asset?.renderer === SETTINGS_RENDERER); }
function settingsTarget(fileName, paths) { return fileName === 'settings.json' ? paths.settings : path.join(paths.configDir, fileName); }
function settingsContent(fileName, raw, scope) {
  return fileName === 'settings.json' && scope !== 'global' ? raw.split(GLOBAL_HOOK_PREFIX).join(PROJECT_HOOK_PREFIX) : raw;
}
function settingsLedgerResources(ledger, assetId) {
  const byFile = new Map();
  for (const resource of ledger?.resources || []) {
    if (resource.harness === 'claude' && resource.assetId === assetId && resource.kind === 'settings-file') byFile.set(resource.identity, resource);
  }
  return byFile;
}
const settingsChangeExtras = (fileName) => ({ kind: 'settings-file', identity: fileName });
// Single serialization form for every settings write, so repeated runs are byte-stable.
const serializeSettings = (value) => `${JSON.stringify(value, null, 2)}\n`;

function planSettingsAsset({ assets, scope, scopeRoot, context, ledger, removing }) {
  const asset = settingsAsset(assets);
  const changes = [];
  const conflicts = [];
  if (!asset) return { changes, conflicts };
  const paths = nativePaths({ scope, scopeRoot });
  const sourceDir = sourcePath(asset, context);
  const previous = settingsLedgerResources(ledger, asset.id);
  if (removing) {
    for (const fileName of SETTINGS_FILES) {
      const prev = previous.get(fileName);
      if (!prev) continue;
      const target = settingsTarget(fileName, paths);
      if (!fs.existsSync(target)) continue;
      const sourceAbs = path.join(sourceDir, fileName);
      if (!fs.existsSync(sourceAbs)) continue;
      // No fingerprint gate on removal any more: a shared file is *expected* to have drifted
      // (the user edited it, another tool registered a hook). removeSettingsAsset subtracts only our own
      // entries, so a drifted file is safe to process rather than a reason to refuse.
      changes.push({ assetId: asset.id, target, operation: 'remove', ownershipIdentity: `doflow:claude:settings:${fileName}`,
        ...settingsChangeExtras(fileName), fingerprint: prev.fingerprint,
        managed: settingsContent(fileName, fs.readFileSync(sourceAbs, 'utf8'), scope),
        projection: { renderer: SETTINGS_RENDERER } });
    }
    return { changes, conflicts };
  }
  for (const fileName of SETTINGS_FILES) {
    const sourceAbs = path.join(sourceDir, fileName);
    if (!fs.existsSync(sourceAbs)) continue;
    const managedRaw = settingsContent(fileName, fs.readFileSync(sourceAbs, 'utf8'), scope);
    const target = settingsTarget(fileName, paths);
    const prev = previous.get(fileName);
    // Both the fresh-install and merge paths emit re-serialized JSON so the on-disk bytes are
    // identical either way. Writing raw source bytes on create and re-serialized bytes on every
    // later run would make each update look like a change and break idempotency.
    let content;
    try { content = serializeSettings(JSON.parse(managedRaw)); }
    catch { conflicts.push(`${fileName} source is not valid JSON`); continue; }
    let operation = prev ? 'update' : 'create';

    if (fs.existsSync(target)) {
      // settings.json is shared with the user and with third-party installers, so "the file
      // differs from our source" is the normal steady state, not drift. Merge our keys in and
      // leave everything else alone; only genuinely unreadable JSON is a conflict now. The old
      // byte-identity check made a first install impossible on any already-configured machine.
      const currentRaw = fs.readFileSync(target, 'utf8');
      let merged;
      try {
        merged = mergeSettings(JSON.parse(currentRaw), JSON.parse(managedRaw));
      } catch {
        conflicts.push(`${fileName} is not valid JSON and cannot be merged`);
        continue;
      }
      content = serializeSettings(merged);
      if (sha256(currentRaw) === sha256(content)) continue;   // already contains our keys verbatim
      // 'merge' is the same operation the marker-merged instructions file reports — it is the
      // lifecycle's existing vocabulary for "fold our content into a file we do not own".
      operation = 'merge';
    }

    const fingerprint = sha256(content);
    changes.push({ assetId: asset.id, target, source: sourceAbs, content, operation,
      ownershipIdentity: `doflow:claude:settings:${fileName}`, ...settingsChangeExtras(fileName),
      afterFingerprint: fingerprint, fingerprint, sourceVersion: 'registry-v1',
      projection: { renderer: SETTINGS_RENDERER } });
  }
  return { changes, conflicts };
}

// Sets the destination's mtime to match its source file's, not the write time, mirroring every
// other copy-tree/settings write in this codebase — planSettingsAsset's own change detection is
// fingerprint(sha256)-based, not mtime-based, so this is a consistency convention, not a
// correctness requirement.
function applySettingsAsset(changes) {
  let applied = 0;
  for (const change of changes) {
    if (change.projection?.renderer !== SETTINGS_RENDERER || change.operation === 'remove') continue;
    fs.mkdirSync(path.dirname(change.target), { recursive: true });
    fs.writeFileSync(change.target, change.content);
    const sourceStat = fs.statSync(change.source);
    fs.utimesSync(change.target, Math.floor(sourceStat.atimeMs / 1000), Math.floor(sourceStat.mtimeMs / 1000));
    applied += 1;
  }
  return applied;
}

// Strips only DoFlow's own hook entries and leaves the rest of a shared file standing. The file
// is deleted outright only when nothing but schema pointers remains — i.e. DoFlow created it.
// Previously this rmSync'd unconditionally, which on a user-maintained settings.json would have
// destroyed their model, permissions, env, and every foreign tool's hooks along with ours.
function removeSettingsAsset(changes) {
  let removed = 0;
  for (const change of changes) {
    if (change.projection?.renderer !== SETTINGS_RENDERER || change.operation !== 'remove') continue;
    if (!fs.existsSync(change.target)) continue;
    let remaining = null;
    if (change.managed) {
      try {
        remaining = stripManagedSettings(JSON.parse(fs.readFileSync(change.target, 'utf8')), JSON.parse(change.managed));
      } catch { remaining = undefined; }        // unreadable -> leave the file untouched
    }
    if (remaining === undefined) continue;
    if (remaining === null) fs.rmSync(change.target, { force: true });
    else fs.writeFileSync(change.target, serializeSettings(remaining));
    removed += 1;
  }
  return removed;
}

function verifySettingsAsset({ assets, scope, scopeRoot, context }) {
  const asset = settingsAsset(assets);
  const statuses = [];
  const resources = [];
  const conflicts = [];
  if (!asset) return { statuses, resources, conflicts };
  const paths = nativePaths({ scope, scopeRoot });
  const sourceDir = sourcePath(asset, context);
  for (const fileName of SETTINGS_FILES) {
    const sourceAbs = path.join(sourceDir, fileName);
    if (!fs.existsSync(sourceAbs)) continue;
    const fingerprint = sha256(settingsContent(fileName, fs.readFileSync(sourceAbs, 'utf8'), scope));
    const target = settingsTarget(fileName, paths);
    // 'absent' (not 'missing') matches the same convention the instructions asset already uses
    // for "no file here" — 'missing' is reserved by the lifecycle layer's removal reconciliation
    // as a hard-failure status, which would make every successful remove look like a verification
    // failure (nothing to overwrite it back to 'removed', since this is a per-file, not a
    // Codex-style shared-container-with-ownershipIdentity-matched status).
    if (!fs.existsSync(target)) { statuses.push({ assetId: asset.id, capability: 'settings', status: 'absent', target }); continue; }
    // Containment, not equality: a shared file legitimately holds the user's own keys and other
    // tools' hook entries. Verification asks only "are DoFlow's keys still here and intact?" —
    // byte-equality would report every user edit as a conflict forever.
    let current;
    let managed;
    try {
      current = JSON.parse(fs.readFileSync(target, 'utf8'));
      managed = JSON.parse(settingsContent(fileName, fs.readFileSync(sourceAbs, 'utf8'), scope));
    } catch {
      conflicts.push(`${fileName} is not valid JSON`);
      statuses.push({ assetId: asset.id, capability: 'settings', status: 'conflict', target });
      continue;
    }
    if (!settingsContains(current, managed)) {
      // None of our hook entries left -> this is a removed/never-installed file that legitimately
      // still holds the user's own content, not damage. Only a partial presence is a conflict.
      if (!settingsContainsAny(current, managed)) {
        statuses.push({ assetId: asset.id, capability: 'settings', status: 'absent', target });
        continue;
      }
      conflicts.push(`${fileName} is missing DoFlow-managed settings`);
      statuses.push({ assetId: asset.id, capability: 'settings', status: 'conflict', target });
      continue;
    }
    statuses.push({ assetId: asset.id, capability: 'settings', status: 'managed', target });
    resources.push({ assetId: asset.id, target, ownershipIdentity: `doflow:claude:settings:${fileName}`,
      ...settingsChangeExtras(fileName), fingerprint, sourceVersion: 'registry-v1', projection: { renderer: SETTINGS_RENDERER } });
  }
  return { statuses, resources, conflicts };
}

// ---- shared adapter contract ----

/** Render native Claude input without writing it.
 * `asset` is the lifecycle-projected shape (flat `renderer`/`capability` fields — see
 * src/adapters/index.js#projectAdapterInput), not the raw registry asset's nested
 * `asset.projection.claude`. Every adapter method below shares that same expectation. */
function render({ asset, scope, scopeRoot, context = {} }) {
  const paths = nativePaths({ scope, scopeRoot });
  if (asset?.renderer === INSTRUCTION_RENDERER) {
    const source = sourcePath(asset, context);
    const content = fs.readFileSync(source, 'utf8');
    return { type: 'managed-section', assetId: asset.id, source, target: paths.instructions, content, fingerprint: sha256(content) };
  }
  if (asset?.renderer === 'copy-tree') {
    const sourceDir = sourcePath(asset, context);
    return { type: 'copy-tree', assetId: asset.id, sourceDir, destDir: copyTreeDestDir(paths, asset) };
  }
  if (asset?.renderer === SETTINGS_RENDERER) {
    const sourceDir = sourcePath(asset, context);
    return { type: 'settings-tree', assetId: asset.id, sourceDir, files: SETTINGS_FILES, targets: SETTINGS_FILES.map((fileName) => settingsTarget(fileName, paths)) };
  }
  return { type: 'unsupported', assetId: asset?.id, renderer: asset?.renderer ?? null };
}

function plan({ assets, scope, scopeRoot, discovery, context = {}, ledger }) {
  const changes = [];
  const conflicts = [];
  const paths = nativePaths({ scope, scopeRoot });
  const removing = context.operation === 'remove';
  for (const asset of assets) {
    if (asset?.renderer !== INSTRUCTION_RENDERER) continue;
    if (discovery?.instructions?.malformed) {
      conflicts.push(`Claude instructions contain malformed DoFlow markers: ${paths.instructions}`);
      continue;
    }
    const rendered = render({ asset, scope, scopeRoot, context });
    // Outside of removal, only report a change when the merge would actually alter the file —
    // otherwise every install/update run would report a pending Claude change even when nothing
    // changed, breaking the idempotent "already up to date" convergence every other mapping gets.
    if (!removing && !mergeMarkedSection(rendered.source, rendered.target, { dryRun: true }).changed) continue;
    changes.push({
      assetId: asset.id,
      target: rendered.target,
      source: rendered.source,
      operation: removing ? 'remove' : (discovery?.instructions?.managed ? 'merge' : 'create'),
      ownershipIdentity: 'doflow:claude:instructions:managed-section',
      afterFingerprint: rendered.fingerprint,
      sourceVersion: 'registry-v1',
      projection: { renderer: INSTRUCTION_RENDERER, target: 'CLAUDE.md' },
    });
  }
  const copyTree = planCopyTreeAssets({ assets, scope, scopeRoot, context, ledger, removing });
  changes.push(...copyTree.changes); conflicts.push(...copyTree.conflicts);
  const settings = planSettingsAsset({ assets, scope, scopeRoot, context, ledger, removing });
  changes.push(...settings.changes); conflicts.push(...settings.conflicts);
  return { changes, conflicts, prerequisites: [] };
}

function apply({ changes, scope, scopeRoot, context = {} }) {
  for (const change of changes) {
    if (change.projection?.renderer !== INSTRUCTION_RENDERER) continue;
    // A plan records the resolved source. This keeps apply self-contained when
    // the lifecycle supplies normalized changes rather than the original asset
    // array, while still avoiding any implicit source discovery at write time.
    const source = change.source ?? sourcePath((context.assets || []).find((item) => item.id === change.assetId), context);
    mergeMarkedSection(source, change.target ?? nativePaths({ scope, scopeRoot }).instructions);
  }
  applyCopyTreeAssets(changes);
  applySettingsAsset(changes);
  return { applied: changes.length };
}

function remove({ changes }) {
  let removed = 0;
  for (const change of changes) {
    if (change.projection?.renderer === INSTRUCTION_RENDERER && removeMarkedSection(change.target)) removed += 1;
  }
  removed += removeCopyTreeAssets(changes);
  removed += removeSettingsAsset(changes);
  return { removed };
}

function verify({ assets, scope, scopeRoot, context = {} }) {
  const paths = nativePaths({ scope, scopeRoot });
  const statuses = [];
  const resources = [];
  const instruction = assets.find((asset) => asset?.renderer === INSTRUCTION_RENDERER);
  const state = markerState(paths.instructions);
  if (instruction) {
    statuses.push({ assetId: instruction.id, status: state.managed ? 'managed' : 'absent', target: paths.instructions });
    if (state.managed) {
      const rendered = render({ asset: instruction, scope, scopeRoot, context });
      resources.push({ assetId: instruction.id, target: paths.instructions, ownershipIdentity: 'doflow:claude:instructions:managed-section', fingerprint: rendered.fingerprint, sourceVersion: 'registry-v1', projection: { renderer: INSTRUCTION_RENDERER } });
    }
  }
  const copyTree = verifyCopyTreeAssets({ assets, scope, scopeRoot, context });
  statuses.push(...copyTree.statuses); resources.push(...copyTree.resources);
  const settings = verifySettingsAsset({ assets, scope, scopeRoot, context });
  statuses.push(...settings.statuses); resources.push(...settings.resources);
  const conflicts = [
    ...(state.malformed ? [`Claude instructions contain malformed DoFlow markers: ${paths.instructions}`] : []),
    ...copyTree.conflicts, ...settings.conflicts,
  ];
  return { ok: conflicts.length === 0, statuses, resources, conflicts };
}

module.exports = { nativePaths, discover, render, plan, apply, remove, verify };
