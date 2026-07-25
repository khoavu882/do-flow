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
const { planTree, applyTree, removeTree, verifyTree } = require('../copy-tree');

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

function copyTreeAssets(assets) { return (assets || []).filter((asset) => asset?.renderer === 'copy-tree'); }
function copyTreeDestDir(paths, asset) { return path.join(paths.configDir, asset.nativeDir || ''); }

function ledgerFileResources(ledger, assetId) {
  return (ledger?.resources || [])
    .filter((resource) => resource.harness === 'claude' && resource.assetId === assetId && resource.kind === 'copy-tree-file')
    .map((resource) => ({ relPath: resource.identity, fingerprint: resource.fingerprint }));
}

function planCopyTreeAssets({ assets, scope, scopeRoot, context, ledger, removing }) {
  const paths = nativePaths({ scope, scopeRoot });
  const changes = [];
  const conflicts = [];
  for (const asset of copyTreeAssets(assets)) {
    const destDir = copyTreeDestDir(paths, asset);
    const sourceDir = sourcePath(asset, context);
    const previousResources = ledgerFileResources(ledger, asset.id);
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
    const destDir = copyTreeDestDir(paths, asset);
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
      const current = sha256(fs.readFileSync(target, 'utf8'));
      if (current !== prev.fingerprint) { conflicts.push(`${fileName} was modified outside DoFlow`); continue; }
      changes.push({ assetId: asset.id, target, operation: 'remove', ownershipIdentity: `doflow:claude:settings:${fileName}`,
        ...settingsChangeExtras(fileName), fingerprint: prev.fingerprint, projection: { renderer: SETTINGS_RENDERER } });
    }
    return { changes, conflicts };
  }
  for (const fileName of SETTINGS_FILES) {
    const sourceAbs = path.join(sourceDir, fileName);
    if (!fs.existsSync(sourceAbs)) continue;
    const content = settingsContent(fileName, fs.readFileSync(sourceAbs, 'utf8'), scope);
    const fingerprint = sha256(content);
    const target = settingsTarget(fileName, paths);
    const prev = previous.get(fileName);
    if (fs.existsSync(target)) {
      const current = sha256(fs.readFileSync(target, 'utf8'));
      const knownGood = prev ? current === prev.fingerprint : current === fingerprint;
      if (!knownGood) { conflicts.push(`${fileName} was modified outside DoFlow`); continue; }
      if (current === fingerprint) continue;
    }
    changes.push({ assetId: asset.id, target, source: sourceAbs, content, operation: prev ? 'update' : 'create',
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

function removeSettingsAsset(changes) {
  let removed = 0;
  for (const change of changes) {
    if (change.projection?.renderer !== SETTINGS_RENDERER || change.operation !== 'remove') continue;
    if (!fs.existsSync(change.target)) continue;
    fs.rmSync(change.target, { force: true });
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
    const current = sha256(fs.readFileSync(target, 'utf8'));
    if (current !== fingerprint) {
      conflicts.push(`${fileName} does not match source`);
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
