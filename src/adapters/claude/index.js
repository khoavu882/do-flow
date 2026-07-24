'use strict';

// Claude native adapter.  It owns only Claude path/format decisions; selection,
// ownership journalling, and native MCP reconciliation remain the lifecycle and
// MCP adapter concerns respectively.  Keeping this boundary narrow lets the
// legacy installer and the registry lifecycle coexist during migration.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { mergeMarkedSection, MARKER_START, MARKER_END } = require('../../claude-md-merge');
const { readAllServers } = require('../../mcp');
const { rewriteHookPathsForProjectScope } = require('../../settings-scope');

const INSTRUCTION_RENDERER = 'claude-instructions';

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

function mcpCatalogPath(context = {}) {
  const repoRoot = context.repoRoot ? path.resolve(context.repoRoot) : process.cwd();
  return path.join(repoRoot, 'core', '.mcp.json');
}

function discover({ scope, scopeRoot, context = {} }) {
  const paths = nativePaths({ scope, scopeRoot });
  const catalog = mcpCatalogPath(context);
  return {
    paths,
    instructions: markerState(paths.instructions),
    settingsExists: fs.existsSync(paths.settings),
    mcpExists: fs.existsSync(paths.mcp),
    knownMcpServers: fs.existsSync(catalog) ? readAllServers(catalog) : [],
  };
}

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
  // A settings renderer is provided for callers that own a native settings
  // asset.  The current registry does not yet declare one, so this remains a
  // render-only compatibility hook rather than an implicit write.
  if (asset?.renderer === 'claude-settings') {
    const source = sourcePath(asset, context);
    return { type: 'settings-json', assetId: asset.id, source, target: paths.settings, content: fs.readFileSync(source, 'utf8') };
  }
  return { type: 'unsupported', assetId: asset?.id, renderer: asset?.renderer ?? null };
}

function plan({ assets, scope, scopeRoot, discovery, context = {} }) {
  const changes = [];
  const conflicts = [];
  const paths = nativePaths({ scope, scopeRoot });
  for (const asset of assets) {
    if (asset?.renderer !== INSTRUCTION_RENDERER) continue;
    if (discovery?.instructions?.malformed) {
      conflicts.push(`Claude instructions contain malformed DoFlow markers: ${paths.instructions}`);
      continue;
    }
    const rendered = render({ asset, scope, scopeRoot, context });
    const removing = context.operation === 'remove';
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
  return { changes, conflicts, prerequisites: [] };
}

function removeManagedSection(file) {
  if (!fs.existsSync(file)) return false;
  const existing = fs.readFileSync(file, 'utf8');
  const start = existing.indexOf(MARKER_START);
  if (start === -1) return false;
  const end = existing.indexOf(MARKER_END, start + MARKER_START.length);
  if (end === -1 || existing.indexOf(MARKER_START, end + MARKER_END.length) !== -1) {
    throw new Error(`Refusing to remove malformed DoFlow markers in ${file}`);
  }
  let after = end + MARKER_END.length;
  if (existing[after] === '\n') after += 1;
  let next = existing.slice(0, start) + existing.slice(after);
  // Do not alter user content; only remove separator whitespace that was added
  // immediately before an appended managed section.
  if (next === '\n') next = '';
  fs.writeFileSync(file, next);
  return true;
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
  return { applied: changes.length };
}

function remove({ changes }) {
  let removed = 0;
  for (const change of changes) {
    if (change.projection?.renderer === INSTRUCTION_RENDERER && removeManagedSection(change.target)) removed += 1;
  }
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
  return { ok: !state.malformed, statuses, resources, conflicts: state.malformed ? [`Claude instructions contain malformed DoFlow markers: ${paths.instructions}`] : [] };
}

// Settings path normalization is intentionally explicit: callers that install a
// settings asset can invoke this after writing it, preserving legacy behavior.
function normalizeProjectSettings(settingsPath) {
  return rewriteHookPathsForProjectScope(settingsPath);
}

module.exports = { nativePaths, discover, render, plan, apply, remove, verify, normalizeProjectSettings };
