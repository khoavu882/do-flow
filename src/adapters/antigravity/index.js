'use strict';

// Antigravity CLI adapter (#8). Scope follows the surfaces verified against Antigravity's own
// docs (antigravity.google/docs/cli/*):
//   instructions — marker-managed section in PROJECT AGENTS.md only. Global memory is
//     ~/.gemini/GEMINI.md, shared with the Gemini CLI harness; two adapters writing one file with
//     one marker pair would fight, so global instructions are reported, never written.
//   skills       — folder-form copy-tree into project .agents/skills (user scope deliberately
//     skipped: CLI pages document flat files there while desktop docs document folders).
//   agents       — copy-tree into project .agents/agents or user ~/.gemini/config/agents.
//   mcp          — mcpServers object merged into .agents/mcp_config.json (workspace) or
//     ~/.gemini/config/mcp_config.json (user); remote url/httpUrl projects to serverUrl.
// Hooks are NOT wired: Antigravity's blocking contract is stdout JSON {decision}, incompatible
// with DoFlow's exit-code scripts until translated shims exist (see registry note).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MARKER_START, MARKER_END } = require('../../helper/marker-merge');
const { planTree, applyTree, removeTree, verifyTree, copyTreeAssets, ledgerFileResources, fingerprint, readJson, sourceDirFor } = require('../copy-tree');

const HARNESS = 'antigravity';

/** copy-tree's readJson distinguishes absent/unparseable via an {exists,value,error} envelope;
 * every caller here wants the plain object or {}. */
function readJsonObject(file, { fsImpl = fs } = {}) {
  const result = readJson(file, { fsImpl });
  if (!result || !result.exists || result.error) return {};
  return result.value ?? {};
}
// Precedent: Codex rides its pointer asset's id for every managed row (instructions-section and
// mcp-server alike). The antigravity projection shares that same pointer asset, so its rows do too.
const POINTER_ASSET_ID = 'guidance.codex-pointer';

/** Native paths per scope. Global config lives at ~/.gemini/config (shared-customization root);
 * project customization lives at <root>/.agents. */
function nativePaths({ scope, scopeRoot, homeDir } = {}) {
  if (scope !== 'project' && scope !== 'global') throw new Error(`Unsupported Antigravity scope '${scope}'`);
  const base = scope === 'project' ? path.resolve(scopeRoot) : path.resolve(homeDir || scopeRoot);
  const configDir = scope === 'project' ? path.join(base, '.agents') : path.join(base, '.gemini', 'config');
  return {
    scope,
    root: base,
    configDir,
    instruction: scope === 'project' ? path.join(base, 'AGENTS.md') : null,
    mcpFile: path.join(configDir, 'mcp_config.json'),
    skillsDir: scope === 'project' ? path.join(base, '.agents', 'skills') : null,
    agentsDir: path.join(configDir, 'agents'),
  };
}

function discover(options, { fsImpl = fs } = {}) {
  const paths = nativePaths(options);
  const instruction = paths.instruction && fsImpl.existsSync(paths.instruction)
    ? fsImpl.readFileSync(paths.instruction, 'utf8') : null;
  return { paths, instruction, mcp: readJsonObject(paths.mcpFile, { fsImpl }) };
}

function render({ content = '' } = {}) {
  return `${MARKER_START}\n${String(content).trimEnd()}\n${MARKER_END}\n`;
}

function managedInstruction(existing, rendered) {
  if (existing === null) return { ok: true, operation: 'create', content: rendered };
  const start = existing.indexOf(MARKER_START);
  const end = existing.indexOf(MARKER_END);
  if (start === -1 && end === -1) return { ok: false, conflict: 'AGENTS.md exists without a DoFlow managed section' };
  if (start === -1 || end === -1 || end < start) return { ok: false, conflict: 'AGENTS.md has malformed DoFlow managed-section markers' };
  const content = `${existing.slice(0, start)}${rendered}${existing.slice(end + MARKER_END.length).replace(/^\n?/, '')}`;
  return { ok: true, operation: content === existing ? 'none' : 'merge', content };
}

function strippedInstruction(existing) {
  if (typeof existing !== 'string') return null;
  const start = existing.indexOf(MARKER_START);
  const end = existing.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end < start) return null;
  let after = end + MARKER_END.length;
  if (existing[after] === '\n') after += 1;
  return `${existing.slice(0, start)}${existing.slice(after)}`;
}

// ---- copy-tree components (skills, agents, locator) ----

/** Scope policy mirrors the registry notes, resolved from each asset's own flat nativeDir:
 *   ../x or .agents/x or .doflow/x  → rooted at the install root (project scope)
 *   plain names (bin, agents)       → inside the scope's config dir (.agents | ~/.gemini/config)
 * Skills are additionally project-only (the user-scope format contradiction is unresolved). */
function treeDestFor(asset, paths, scope) {
  const nativeDir = asset.nativeDir;
  if (!nativeDir) return null;
  if (asset.id === 'skills.doflow') {
    return scope === 'project' ? path.join(paths.root, nativeDir) : null;
  }
  if (asset.id === 'agents.shared') {
    return scope === 'project' ? path.join(paths.root, nativeDir) : path.join(paths.configDir, 'agents');
  }
  if (asset.id === 'locator.doflow') {
    return path.join(paths.configDir, nativeDir);
  }
  if (nativeDir.startsWith('../')) return path.join(paths.root, nativeDir.replace(/^\.\.\//, ''));
  if (nativeDir.startsWith('.')) return path.join(paths.root, nativeDir);
  return path.join(paths.configDir, nativeDir);
}

function planTrees({ assets, paths, scope, neutralResources, removing, repoRoot, fsImpl = fs }) {
  const changes = [];
  const conflicts = [];
  const targets = [];
  for (const asset of copyTreeAssets(assets)) {
    const destDir = treeDestFor(asset, paths, scope);
    if (!destDir) continue;
    targets.push({ asset, destDir });
  }
  for (const { asset, destDir } of targets) {
    const sourceDir = sourceDirFor(asset, { repoRoot }, fsImpl, HARNESS);
    const previousResources = ledgerFileResources(neutralResources, HARNESS, asset.id);
    const result = planTree({ sourceDir, destDir, previousResources, operation: removing ? 'remove' : 'apply', fsImpl });
    conflicts.push(...result.conflicts.map((reason) => `${asset.id}: ${reason}`));
    for (const change of result.changes) {
      changes.push({
        assetId: asset.id, target: change.target, source: change.source, operation: change.operation,
        ownershipIdentity: `doflow:${HARNESS}:copy-tree:${asset.id}:${change.relPath}`,
        kind: 'copy-tree-file', identity: change.relPath,
        afterFingerprint: change.fingerprint, fingerprint: change.fingerprint, sourceVersion: 'registry-v1',
        projection: { renderer: 'copy-tree' },
      });
    }
  }
  return { changes, conflicts, targets };
}

function runTreeChanges(changes, mode) {
  const treeChanges = changes
    .filter((c) => c.projection?.renderer === 'copy-tree' && (mode === 'all' || c.operation === 'remove'))
    .map((c) => ({ relPath: c.identity ?? c.relPath, target: c.target, source: c.source, operation: c.operation, fingerprint: c.fingerprint }));
  return (mode === 'remove' ? removeTree : applyTree)({ changes: treeChanges });
}

// ---- instructions component ----

function planInstructions({ paths, assets, removing, repoRoot, fsImpl = fs }) {
  if (scopeOf(paths) !== 'project') return { changes: [], conflicts: [] };
  void repoRoot;
  if (removing) {
    // Removal must strip the section DoFlow owns while leaving foreign bytes untouched — same
    // contract as the other AGENTS-style adapters.
    if (!fsImpl.existsSync(paths.instruction)) return { changes: [], conflicts: [] };
    const text = fsImpl.readFileSync(paths.instruction, 'utf8');
    if (!text.includes(MARKER_START)) return { changes: [], conflicts: [] };
    return {
      changes: [{
        assetId: POINTER_ASSET_ID, target: paths.instruction, operation: 'remove',
        ownershipIdentity: `doflow:${HARNESS}:instructions:managed-section`,
        kind: 'instructions-section', identity: 'AGENTS.md',
        projection: { renderer: 'antigravity-instructions' },
      }],
      conflicts: [],
    };
  }
  const sourceText = pointerBody(fsImpl);
  if (!sourceText) return { changes: [], conflicts: [] };
  const existing = fsImpl.existsSync(paths.instruction) ? fsImpl.readFileSync(paths.instruction, 'utf8') : null;
  const outcome = managedInstruction(existing, render({ content: sourceText }));
  if (!outcome.ok) return { changes: [], conflicts: [outcome.conflict] };
  if (outcome.operation === 'none') return { changes: [], conflicts: [] };
  return {
    changes: [{
      assetId: POINTER_ASSET_ID, target: paths.instruction, operation: existing === null ? 'create' : 'update',
      ownershipIdentity: `doflow:${HARNESS}:instructions:managed-section`,
      kind: 'instructions-section', identity: 'AGENTS.md',
      afterFingerprint: fingerprint(outcome.content), sourceVersion: 'registry-v1',
      projection: { renderer: 'antigravity-instructions' },
      _content: outcome.content,
    }],
    conflicts: [],
  };
}

function pointerBody(fsImpl) {
  // The shared pointer prose ships once; read it through the same repo-relative anchor the other
  // AGENTS-style adapters use.
  try {
    return fsImpl.readFileSync(path.resolve(__dirname, '../../../core/shared/guidance/pointers/codex.md'), 'utf8').trimEnd();
  } catch { return null; }
}

function scopeOf(paths) { return paths.scope; }

// ---- MCP component ----

function mcpDefinitionFor(server) {
  // Remote transports project url/httpUrl -> serverUrl per the current Antigravity schema.
  if (server.transport === 'stdio') {
    return { command: server.command, ...(server.args?.length ? { args: server.args } : {}) };
  }
  return { serverUrl: server.url ?? server.httpUrl };
}

function planMcp({ paths, selectedServers, neutralResources, removing, fsImpl = fs }) {
  const changes = [];
  const conflicts = [];
  const resources = [];
  if (!Array.isArray(selectedServers) || !selectedServers.length) return { changes, conflicts, resources };
  const existing = readJsonObject(paths.mcpFile, { fsImpl });
  const servers = { ...(existing.mcpServers ?? {}) };
  const owned = new Set((neutralResources || [])
    .filter((r) => r.harness === HARNESS && r.kind === 'mcp-server').map((r) => r.identity));
  const wanted = new Set(selectedServers.map((s) => s.id));

  if (removing) {
    for (const id of [...owned]) {
      if (Object.prototype.hasOwnProperty.call(servers, id)) {
        delete servers[id];
        changes.push({ assetId: POINTER_ASSET_ID, target: paths.mcpFile, operation: 'remove',
          ownershipIdentity: `doflow:${HARNESS}:mcp-server:${id}`, kind: 'mcp-server', identity: id,
          projection: { renderer: 'antigravity-mcp' } });
      }
    }
    return { changes, conflicts, resources };
  }

  for (const server of selectedServers) {
    const definition = mcpDefinitionFor(server);
    const before = JSON.stringify(servers[server.id] ?? null);
    const after = JSON.stringify(definition);
    if (before !== after) {
      servers[server.id] = definition;
      changes.push({
        assetId: POINTER_ASSET_ID, target: paths.mcpFile,
        operation: Object.prototype.hasOwnProperty.call(existing.mcpServers ?? {}, server.id) ? 'update' : 'create',
        ownershipIdentity: `doflow:${HARNESS}:mcp-server:${server.id}`, kind: 'mcp-server', identity: server.id,
        projection: { renderer: 'antigravity-mcp' },
        _servers: null, // filled once below so every change in one plan writes the same final file
      });
    }
  }
  // Every mutating change carries the final intended map; apply() writes it once.
  const finalServers = JSON.stringify(servers);
  for (const change of changes) change._servers = finalServers;
  for (const server of selectedServers) {
    resources.push({
      assetId: POINTER_ASSET_ID, target: paths.mcpFile,
      ownershipIdentity: `doflow:${HARNESS}:mcp-server:${server.id}`, kind: 'mcp-server', identity: server.id,
      fingerprint: null, sourceVersion: 'registry-v1', projection: { renderer: 'antigravity-mcp' },
    });
  }
  return { changes, conflicts: [], resources };
}

// ---- required six-function surface ----

function plan(options = {}, impl = {}) {
  const fsImpl = impl.fsImpl || fs;
  const context = options.context ?? {};
  const scope = options.scope ?? 'project';
  const paths = nativePaths({ ...options, scope, homeDir: context.homeDir });
  const removing = context.operation === 'remove';
  const neutralResources = options.ledger?.resources ?? options.managedResources ?? [];
  const selectedServers = Array.isArray(options.mcp) ? options.mcp : [];

  const instructions = planInstructions({ paths, assets: options.assets, removing, repoRoot: context.repoRoot, fsImpl });
  const trees = planTrees({ assets: options.assets, paths, scope, neutralResources, removing, repoRoot: context.repoRoot, fsImpl });
  const mcp = planMcp({ paths, selectedServers, neutralResources, removing, fsImpl });

  const changes = [...instructions.changes, ...trees.changes, ...mcp.changes];
  const conflicts = [...instructions.conflicts, ...trees.conflicts];
  return {
    changes,
    conflicts,
    prerequisites: [],
    requiredNativeResources: changes,
  };
}

function apply(options = {}, impl = {}) {
  const fsImpl = impl.fsImpl || fs;
  // apply()/verify() are reached through the lifecycle with the same scope inputs plan() saw, so
  // they re-derive paths instead of trusting plan-private state.
  const paths = nativePaths(options);
  const changes = options.changes ?? [];

  for (const change of changes.filter((c) => c.projection?.renderer === 'antigravity-instructions')) {
    if (change.operation === 'remove') {
      // pi precedent: strip only the managed span; the file survives even when nothing remains.
      if (!fsImpl.existsSync(change.target)) continue;
      const next = strippedInstruction(fsImpl.readFileSync(change.target, 'utf8'));
      if (next !== null) fsImpl.writeFileSync(change.target, next, 'utf8');
      continue;
    }
    fsImpl.mkdirSync(path.dirname(change.target), { recursive: true });
    fsImpl.writeFileSync(change.target, change._content ?? render({ content: '' }), 'utf8');
  }
  runTreeChanges(changes, 'all');

  const mcpTargets = new Set(changes.filter((c) => c.projection?.renderer === 'antigravity-mcp').map((c) => c.target));
  for (const target of mcpTargets) {
    const scoped = changes.filter((c) => c.target === target && c.projection?.renderer === 'antigravity-mcp');
    let doc = readJsonObject(target, { fsImpl });
    // A create/update change carries the plan's authoritative final map (foreign servers already
    // preserved in it). Remove-only flows delete exactly the owned ids instead — never the rest.
    const finalMap = [...scoped].reverse().find((c) => c.operation !== 'remove' && c._servers);
    if (finalMap) {
      doc.mcpServers = JSON.parse(finalMap._servers);
    } else {
      doc.mcpServers = { ...(doc.mcpServers ?? {}) };
      for (const change of scoped) if (change.operation === 'remove') delete doc.mcpServers[change.identity];
    }
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fsImpl.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    fsImpl.renameSync(tmp, target);
  }
  return { applied: changes.length };
}

// Removal flows through apply(): plan(context.operation='remove') emits operation:'remove'
// changes, and the branches above already know how to execute each kind. The six-function
// contract still requires the verb itself.
function remove(options = {}, impl = {}) {
  return apply(options, impl);
}

function verify(options = {}, impl = {}) {
  const fsImpl = impl.fsImpl || fs;
  const context = options.context ?? {};
  const scope = options.scope ?? 'project';
  const paths = nativePaths({ ...options, scope, homeDir: context.homeDir });
  const removing = (context.operation ?? options.operation) === 'remove';
  const statuses = [];
  const resources = [];

  const instruction = paths.instruction && fsImpl.existsSync(paths.instruction)
    ? fsImpl.readFileSync(paths.instruction, 'utf8') : null;
  const managed = instruction !== null && instruction.includes(MARKER_START) && instruction.includes(MARKER_END);
  if (paths.instruction) {
    // Removal verification asks "did our section go away?"; install/update asks "is it managed?".
    statuses.push({
      assetId: POINTER_ASSET_ID, capability: 'instructions',
      status: removing ? (managed ? 'retained' : 'absent') : (managed ? 'managed' : 'missing'),
      target: paths.instruction,
    });
    if (managed && !removing) {
      resources.push({
        assetId: POINTER_ASSET_ID, target: paths.instruction,
        ownershipIdentity: `doflow:${HARNESS}:instructions:managed-section`,
        kind: 'instructions-section', identity: 'AGENTS.md',
        fingerprint: fingerprint(instruction), sourceVersion: 'registry-v1',
        projection: { renderer: 'antigravity-instructions' },
      });
    }
  }

  for (const asset of copyTreeAssets(options.assets ?? [])) {
    const destDir = treeDestFor(asset, paths, scope);
    if (!destDir) continue;
    const sourceDir = sourceDirFor(asset, { repoRoot: context.repoRoot }, fsImpl, HARNESS);
    const result = verifyTree({ sourceDir, destDir, fsImpl });
    conflictsToStatuses(result.conflicts, asset.id, statuses);
    for (const resource of result.resources) {
      resources.push({
        assetId: asset.id, target: resource.target,
        ownershipIdentity: `doflow:${HARNESS}:copy-tree:${asset.id}:${resource.relPath}`,
        kind: 'copy-tree-file', identity: resource.relPath,
        fingerprint: resource.fingerprint, sourceVersion: 'registry-v1',
        projection: { renderer: 'copy-tree' },
      });
    }
  }

  const mcpDoc = readJsonObject(paths.mcpFile, { fsImpl });
  const servers = mcpDoc.mcpServers ?? {};
  const ownedIds = (options.ledger?.resources ?? [])
    .filter((r) => r.harness === HARNESS && r.kind === 'mcp-server').map((r) => r.identity);
  for (const id of ownedIds) {
    const present = Object.prototype.hasOwnProperty.call(servers, id);
    statuses.push({ assetId: POINTER_ASSET_ID, capability: 'mcp', status: present && !removing ? 'managed' : (removing ? (present ? 'retained' : 'absent') : 'missing'), identity: id, target: paths.mcpFile });
    if (present && !removing) {
      resources.push({
        assetId: POINTER_ASSET_ID, target: paths.mcpFile,
        ownershipIdentity: `doflow:${HARNESS}:mcp-server:${id}`, kind: 'mcp-server', identity: id,
        fingerprint: null, sourceVersion: 'registry-v1', projection: { renderer: 'antigravity-mcp' },
      });
    }
  }

  const conflicts = statuses.filter((s) => s.status === 'conflict').map((s) => s.reason ?? s.identity);
  return { ok: conflicts.length === 0, statuses, resources, conflicts };
}

function conflictsToStatuses(conflicts, assetId, statuses) {
  for (const reason of conflicts) statuses.push({ assetId, capability: 'scripts', status: 'conflict', reason });
}

module.exports = {
  HARNESS, nativePaths, discover, render, plan, apply, remove, verify,
  createAntigravityAdapter: () => ({ discover, render, plan, apply, remove, verify }),
};
