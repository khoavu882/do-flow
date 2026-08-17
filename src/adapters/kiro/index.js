'use strict';

// Kiro adapter.
//
// Kiro's native root is symmetric across scopes — `.kiro/` (project) / `~/.kiro/` (global) is the
// one directory that holds everything Kiro reads: steering, agents, hooks, and settings/mcp.json
// (see src/targets.js's toolDirs() for the same convention this adapter's own nativePaths()
// mirrors). Unlike every other harness in this codebase, Kiro receives DoFlow's *full* guidance
// tree as steering files rather than a single marker-wrapped pointer file plus a separately-copied
// tree (design.md §4's "research decision D3"): there is no single-file instruction surface here
// at all, so — unlike src/adapters/gemini or src/adapters/opencode — this adapter never renders a
// marker-wrapped instruction file.
//
// Evidence: https://kiro.dev/docs/steering/, https://kiro.dev/docs/mcp/configuration/,
// https://kiro.dev/docs/hooks/
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { planTree, applyTree, removeTree, verifyTree, copyTreeAssets, copyTreeDestDir, ledgerFileResources } = require('../copy-tree');

const HARNESS = 'kiro';
const MCP_FILE = path.join('settings', 'mcp.json');

function fingerprint(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

/**
 * Native paths for a scope. `.kiro` (project) / `~/.kiro` (global) is the whole native root; every
 * other path here is a fixed subpath under it, per kiro.dev's docs cited above.
 */
function nativePaths({ scope, scopeRoot, homeDir }) {
  const root = scope === 'global' ? path.resolve(homeDir || scopeRoot) : path.resolve(scopeRoot);
  const kiroDir = path.join(root, '.kiro');
  return {
    root,
    configDir: kiroDir,
    steering: path.join(kiroDir, 'steering'),
    skills: path.join(kiroDir, 'skills'),
    agents: path.join(kiroDir, 'agents'),
    hooks: path.join(kiroDir, 'hooks'),
    mcp: path.join(kiroDir, MCP_FILE),
  };
}

function readJson(file, { fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(file)) return { exists: false, value: {}, error: null };
  try { return { exists: true, value: JSON.parse(fsImpl.readFileSync(file, 'utf8')), error: null }; }
  catch (error) { return { exists: true, value: null, error: `Invalid JSON in ${file}: ${error.message}` }; }
}

function discover({ scope, scopeRoot, context = {}, fsImpl = fs }) {
  const paths = nativePaths({ scope, scopeRoot, homeDir: context.homeDir });
  return { paths, mcp: readJson(paths.mcp, { fsImpl }) };
}

/**
 * Kiro has no single-file, marker-managed instruction surface for this adapter to render into —
 * the guidance tree is projected file-for-file by the copy-tree engine below, and there is no
 * other renderer-driven asset routed to this harness (see core/registry/assets.yaml: only
 * guidance.context-layer and agents.shared apply to 'kiro', both `renderer: copy-tree`/
 * `kiro-agents`). This is kept as a pure passthrough only to satisfy the six-function adapter
 * contract every harness must implement identically.
 */
function render({ content = '' } = {}) {
  return String(content);
}

// ---- copy-tree assets (steering tree, agents) ----

/**
 * Kiro has a dedicated skills system (https://kiro.dev/docs/skills/): a folder containing
 * `SKILL.md` with YAML frontmatter, optionally alongside scripts/references/assets — the same open
 * Agent Skills standard DoFlow already authors, scanned from `.kiro/skills/` (workspace) and
 * `~/.kiro/skills/` (global). `skills.doflow` therefore materialises like every other harness's
 * skills tree, no exclusion needed.
 *
 * `agents.shared` is included alongside the generic `copy-tree` renderer even though its own
 * projection declares `renderer: 'kiro-agents'` — a distinct name chosen so the registry can tell
 * the two apart, but both are, underneath, a plain mirrored file copy (Kiro accepts flat `.md`
 * agent files natively, so no layout transform is declared or needed).
 */
function kiroTreeAssets(assets) {
  return [...copyTreeAssets(assets), ...(assets || []).filter((asset) => asset.renderer === 'kiro-agents')];
}

function sourceDirFor(asset, context = {}, fsImpl = fs) {
  if (!asset || typeof asset.source !== 'string') throw new Error('Kiro asset requires a source path');
  const repoRoot = context.repoRoot ? path.resolve(context.repoRoot) : process.cwd();
  const source = path.resolve(repoRoot, asset.source);
  if (!source.startsWith(`${repoRoot}${path.sep}`) || !fsImpl.existsSync(source)) {
    throw new Error(`Kiro asset source is unavailable: ${asset.source}`);
  }
  return source;
}

function planCopyTreeAssets({ assets, scope, scopeRoot, context, ledger, removing, fsImpl = fs }) {
  const paths = nativePaths({ scope, scopeRoot, homeDir: context.homeDir });
  const changes = [];
  const conflicts = [];
  for (const asset of kiroTreeAssets(assets)) {
    const destDir = copyTreeDestDir(paths.configDir, asset);
    const sourceDir = sourceDirFor(asset, context, fsImpl);
    const previousResources = ledgerFileResources(ledger?.resources, HARNESS, asset.id);
    const result = planTree({ sourceDir, destDir, previousResources, operation: removing ? 'remove' : 'apply', fsImpl, layout: asset.layout });
    conflicts.push(...result.conflicts.map((reason) => `${asset.id}: ${reason}`));
    for (const change of result.changes) {
      changes.push({
        assetId: asset.id, target: change.target, source: change.source, operation: change.operation,
        ownershipIdentity: `doflow:${HARNESS}:copy-tree:${asset.id}:${change.relPath}`,
        kind: 'copy-tree-file', identity: change.relPath,
        afterFingerprint: change.fingerprint, fingerprint: change.fingerprint, sourceVersion: 'registry-v1',
        projection: { renderer: asset.renderer },
      });
    }
  }
  return { changes, conflicts };
}

function applyCopyTreeAssets(changes, { fsImpl = fs } = {}) {
  const treeChanges = changes.filter((change) => change.kind === 'copy-tree-file' && change.operation !== 'remove')
    .map((change) => ({ relPath: change.identity, target: change.target, source: change.source, operation: change.operation, fingerprint: change.fingerprint }));
  return applyTree({ changes: treeChanges, fsImpl }).applied;
}

function removeCopyTreeAssets(changes, { fsImpl = fs } = {}) {
  const treeChanges = changes.filter((change) => change.kind === 'copy-tree-file' && change.operation === 'remove')
    .map((change) => ({ relPath: change.identity, target: change.target, operation: 'remove', fingerprint: change.fingerprint }));
  return removeTree({ changes: treeChanges, fsImpl }).removed;
}

function verifyCopyTreeAssets({ assets, scope, scopeRoot, context, fsImpl = fs }) {
  const paths = nativePaths({ scope, scopeRoot, homeDir: context.homeDir });
  const statuses = [];
  const resources = [];
  const conflicts = [];
  for (const asset of kiroTreeAssets(assets)) {
    const destDir = copyTreeDestDir(paths.configDir, asset);
    const sourceDir = sourceDirFor(asset, context, fsImpl);
    const result = verifyTree({ sourceDir, destDir, fsImpl, layout: asset.layout });
    conflicts.push(...result.conflicts.map((reason) => `${asset.id}: ${reason}`));
    for (const resource of result.resources) {
      resources.push({
        assetId: asset.id, target: resource.target, ownershipIdentity: `doflow:${HARNESS}:copy-tree:${asset.id}:${resource.relPath}`,
        kind: 'copy-tree-file', identity: resource.relPath,
        fingerprint: resource.fingerprint, sourceVersion: 'registry-v1',
        projection: { renderer: asset.renderer },
      });
    }
    statuses.push({ assetId: asset.id, capability: asset.capability, status: result.ok ? 'managed' : 'conflict', target: destDir });
  }
  return { statuses, resources, conflicts };
}

// ---- MCP (.kiro/settings/mcp.json) ----

/**
 * Shape one registry MCP server declaration into Kiro's own per-server schema (confirmed against
 * kiro.dev/docs/mcp/configuration/): a local (stdio) server carries `command`/`args`/`env`/
 * `disabled`/`autoApprove`/`disabledTools`; a remote server carries `url`/`headers` instead. The
 * registry (core/registry/mcp.yaml) only ever declares stdio servers today, so only the fields it
 * actually carries are emitted — this never invents a field the registry doesn't supply.
 */
function buildServerEntry(server) {
  if (server.url) return { url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
  return { command: server.command, ...(server.args?.length ? { args: server.args } : {}) };
}

/** Merge selected servers into `mcpServers`, touching only the ids DoFlow selected — a foreign
 * server entry a user added by hand, or any other top-level key in mcp.json, passes through
 * untouched. This adapter only ever reconciles its own scope's file, exactly like every other
 * adapter's native MCP merge; Kiro's own runtime handles workspace/global precedence on its own. */
function mergeMcpConfig(existing, servers = []) {
  const next = { ...(existing || {}) };
  if (!servers.length) return next; // nothing selected: leave mcpServers (present or absent) untouched
  next.mcpServers = { ...(next.mcpServers || {}) };
  for (const server of servers) next.mcpServers[server.id] = buildServerEntry(server);
  return next;
}

/** Remove only the server ids passed in, leaving every other entry (and any other top-level key)
 * intact. Deletes the now-empty `mcpServers` key rather than leaving `{}` behind, mirroring
 * src/adapters/opencode/index.js's unmergeConfig. */
function unmergeMcpConfig(existing, servers = []) {
  const next = { ...(existing || {}) };
  if (next.mcpServers) {
    next.mcpServers = { ...next.mcpServers };
    for (const server of servers) delete next.mcpServers[server.id];
    if (!Object.keys(next.mcpServers).length) delete next.mcpServers;
  }
  return next;
}

/** Kiro has no hooks or mcp asset of its own in core/registry/assets.yaml (mcp servers come from
 * core/registry/mcp.yaml, not an asset), so an mcp-registration change piggybacks on an asset id
 * this harness actually receives — the same "pseudo-component" technique
 * src/adapters/gemini/index.js#hooksAssetId already uses for its own settings-only component. */
function pseudoAssetId(assets) {
  return assets.find((asset) => asset.id === 'guidance.context-layer')?.id ?? assets[0]?.id;
}

// ---- shared adapter contract ----

function atomicWrite(file, content, { fsImpl = fs } = {}) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fsImpl.writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
    fsImpl.renameSync(temp, file);
  } finally {
    if (fsImpl.existsSync(temp)) fsImpl.rmSync(temp, { force: true });
  }
}

/**
 * `.kiro/hooks/` is a confirmed, writable native surface, but projecting DoFlow's hook
 * definitions into it is a separate task (plan.md D.1) that extends this adapter later. Until
 * then, this adapter's only job for hooks is to expose the native path/verify surface: report it
 * as present-but-not-yet-populated ('pending'), never as an error and never as something already
 * installed.
 */
function hooksSurface(paths) {
  return { status: 'pending', target: paths.hooks, note: 'Kiro hook projection is not yet implemented; .kiro/hooks/ is exposed as a native surface only (see plan.md D.1).' };
}

function plan({ scope, scopeRoot, assets = [], mcp = [], discovery, context = {}, ledger, fsImpl = fs }) {
  const found = discovery || discover({ scope, scopeRoot, context, fsImpl });
  const changes = [];
  const conflicts = [];
  const removing = context.operation === 'remove';

  const copyTree = planCopyTreeAssets({ assets, scope, scopeRoot, context, ledger, removing, fsImpl });
  changes.push(...copyTree.changes);
  conflicts.push(...copyTree.conflicts);

  if (found.mcp.error) {
    conflicts.push(found.mcp.error);
  } else {
    const current = found.mcp.value || {};
    const next = removing ? unmergeMcpConfig(current, mcp) : mergeMcpConfig(current, mcp);
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      changes.push({
        assetId: pseudoAssetId(assets), target: found.paths.mcp,
        operation: found.mcp.exists ? 'update' : 'create',
        content: `${JSON.stringify(next, null, 2)}\n`,
        ownershipIdentity: `${HARNESS}:mcp:registration`,
        afterFingerprint: fingerprint(next), fingerprint: fingerprint(next), sourceVersion: 'registry-v1',
        projection: { renderer: 'kiro-mcp' },
      });
    }
  }

  return {
    changes, conflicts, prerequisites: [],
    surfaces: {
      instructions: { status: 'supported', target: found.paths.steering },
      skills: { status: 'supported', target: found.paths.skills },
      agents: { status: 'supported', target: found.paths.agents },
      hooks: hooksSurface(found.paths),
      mcp: { status: found.mcp.error ? 'blocked' : 'supported', target: found.paths.mcp, selected: mcp.map((item) => item.id) },
    },
  };
}

function apply({ changes = [], fsImpl = fs }) {
  for (const change of changes) {
    if (change.kind !== 'copy-tree-file' && change.content !== undefined) atomicWrite(change.target, change.content, { fsImpl });
  }
  applyCopyTreeAssets(changes, { fsImpl });
}

function remove({ changes = [], fsImpl = fs }) {
  for (const change of changes) {
    if (change.kind !== 'copy-tree-file' && change.content !== undefined) atomicWrite(change.target, change.content, { fsImpl });
  }
  removeCopyTreeAssets(changes, { fsImpl });
}

function verify({ scope, scopeRoot, assets = [], mcp = [], context = {}, fsImpl = fs }) {
  const found = discover({ scope, scopeRoot, context, fsImpl });
  const resources = [];
  const conflicts = [];

  const copyTree = verifyCopyTreeAssets({ assets, scope, scopeRoot, context, fsImpl });
  resources.push(...copyTree.resources);
  conflicts.push(...copyTree.conflicts);

  const mcpStatuses = [];
  if (found.mcp.error) {
    conflicts.push(found.mcp.error);
  } else {
    const value = found.mcp.value || {};
    for (const server of mcp) {
      const entry = value.mcpServers?.[server.id];
      const expected = buildServerEntry(server);
      const matches = Boolean(entry) && JSON.stringify(entry) === JSON.stringify(expected);
      mcpStatuses.push({ assetId: pseudoAssetId(assets), identity: server.id, capability: 'mcp', status: matches ? 'managed' : 'missing', target: found.paths.mcp });
      if (matches) {
        resources.push({
          assetId: pseudoAssetId(assets), target: found.paths.mcp, ownershipIdentity: `${HARNESS}:mcp:${server.id}`,
          identity: server.id, fingerprint: fingerprint(entry), sourceVersion: context.sourceVersion ?? 'unknown',
          projection: { renderer: 'kiro-mcp' },
        });
      }
    }
  }

  return {
    ok: conflicts.length === 0 && !found.mcp.error,
    resources,
    statuses: { copyTree: copyTree.statuses, mcp: mcpStatuses, hooks: hooksSurface(found.paths) },
    conflicts,
  };
}

module.exports = {
  nativePaths, discover, render, plan, apply, remove, verify,
  mergeMcpConfig, unmergeMcpConfig, buildServerEntry,
  createKiroAdapter: () => ({ discover, render, plan, apply, remove, verify }),
};
