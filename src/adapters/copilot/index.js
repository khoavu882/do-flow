'use strict';

// GitHub Copilot CLI adapter.
//
// Copilot has no single native root the way Claude's `.claude` is one — instructions, skills,
// agents, and MCP each live under a different path, split further by scope. Skills and agents are
// both trees materialised via the shared copy-tree engine in ../copy-tree.js; the single instruction
// pointer is a marker-merged section in a shared file, the same shape opencode/pi/gemini already use;
// MCP is a read-merge-write of one JSON key, the same posture opencode's own `mergeConfig` and
// Claude's `src/mcp.js` already take (union/preserve foreign entries, touch only DoFlow's own keys).
//
// Native paths (see design.md §4's harness-native-surfaces table and src/targets.js's toolDirs()):
//   instructions -> <projectRoot>/.github/copilot-instructions.md (project only — Copilot documents
//                   no global instructions file, so global scope installs nothing for this asset)
//   skills       -> ~/.agents/skills (global) / <projectRoot>/.agents/skills (project)
//   agents       -> ~/.copilot/agents (global) / <projectRoot>/.github/agents (project)
//   mcp          -> ~/.copilot/mcp-config.json (global) / <projectRoot>/.mcp.json (project)
//
// Evidence: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot,
// https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills,
// https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli,
// https://docs.github.com/en/copilot/reference/custom-agents-configuration
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { MARKER_START, MARKER_END } = require('../../marker-merge');
const { planTree, applyTree, removeTree, verifyTree, copyTreeDestDir, ledgerFileResources } = require('../copy-tree');

const HARNESS = 'copilot';
const INSTRUCTION_FILE = 'copilot-instructions.md';

function fingerprint(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

/**
 * Native paths for a scope. Unlike Claude/Codex/Kiro, Copilot has no single root: every capability
 * resolves against its own conventional directory.
 *   - `skillsConfigDir` is the parent of `skills/` and is identical in shape across scopes
 *     (`.agents`, rooted at whichever `root` the scope resolves to) — Copilot's skills discovery
 *     list per https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills.
 *   - `agentsConfigDir` is genuinely asymmetric: `~/.copilot` globally, `.github` at project scope,
 *     because that is where Copilot's own custom-agents documentation places each.
 *   - `instruction` is project-only: Copilot documents no global instructions file, so global scope
 *     resolves it to `null` rather than inventing a path with no reader.
 */
function nativePaths({ scope, scopeRoot, homeDir }) {
  const root = scope === 'global' ? path.resolve(homeDir || scopeRoot) : path.resolve(scopeRoot);
  const skillsConfigDir = path.join(root, '.agents');
  const agentsConfigDir = scope === 'global' ? path.join(root, '.copilot') : path.join(root, '.github');
  return {
    root,
    skillsConfigDir,
    agentsConfigDir,
    skills: path.join(skillsConfigDir, 'skills'),
    agents: path.join(agentsConfigDir, 'agents'),
    instruction: scope === 'global' ? null : path.join(root, '.github', INSTRUCTION_FILE),
    mcp: scope === 'global' ? path.join(agentsConfigDir, 'mcp-config.json') : path.join(root, '.mcp.json'),
  };
}

/** Copilot's MCP-merge change has no asset of its own in core/registry/assets.yaml (it's a
 * registration side-effect of the selected MCP servers, not a projected asset), so it piggybacks on
 * a real asset id already routed to this harness — the same "pseudo-component" technique
 * src/adapters/gemini/index.js#hooksAssetId and src/adapters/kiro/index.js#pseudoAssetId use. The
 * lifecycle layer validates every change's assetId against the harness's actual asset list, so an
 * invented id like a literal 'copilot.mcp' string is rejected as unknown. */
function pseudoAssetId(assets) {
  return assets.find((asset) => asset.capability === 'instructions')?.id ?? assets[0]?.id;
}

function readJson(file, { fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(file)) return { exists: false, value: {}, error: null };
  try { return { exists: true, value: JSON.parse(fsImpl.readFileSync(file, 'utf8')), error: null }; }
  catch (error) { return { exists: true, value: null, error: `Invalid JSON in ${file}: ${error.message}` }; }
}

function discover({ scope, scopeRoot, context = {}, fsImpl = fs }) {
  const paths = nativePaths({ scope, scopeRoot, homeDir: context.homeDir });
  const instruction = paths.instruction && fsImpl.existsSync(paths.instruction) ? fsImpl.readFileSync(paths.instruction, 'utf8') : null;
  return { paths, instruction, mcp: readJson(paths.mcp, { fsImpl }) };
}

function render({ content = '' } = {}) {
  return `${MARKER_START}\n${String(content).trimEnd()}\n${MARKER_END}\n`;
}

/** Replace only the span between DoFlow's markers. A copilot-instructions.md that exists with no
 * DoFlow section is refused rather than appended to — the same policy opencode/pi/gemini apply to
 * their own shared instruction files, and for the same reason: where DoFlow's content belongs in a
 * file it doesn't fully own is a decision for the file's owner, not a guess for the installer. Add
 * an empty marker pair to opt in. */
function managedInstruction(existing, rendered) {
  if (existing === null) return { ok: true, operation: 'create', content: rendered };
  const start = existing.indexOf(MARKER_START);
  const end = existing.indexOf(MARKER_END);
  if (start === -1 && end === -1) return { ok: false, conflict: `${INSTRUCTION_FILE} exists without a DoFlow managed section` };
  if (start === -1 || end === -1 || end < start) return { ok: false, conflict: `${INSTRUCTION_FILE} has malformed DoFlow managed-section markers` };
  const content = `${existing.slice(0, start)}${rendered}${existing.slice(end + MARKER_END.length).replace(/^\n?/, '')}`;
  return { ok: true, operation: content === existing ? 'none' : 'merge', content };
}

/** Strip DoFlow's span, leaving the rest of a shared copilot-instructions.md intact. Returns null
 * when there is nothing to do, so plan() can skip the change entirely. */
function strippedInstruction(existing) {
  if (typeof existing !== 'string') return null;
  const start = existing.indexOf(MARKER_START);
  const end = existing.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end < start) return null;
  let after = end + MARKER_END.length;
  if (existing[after] === '\n') after += 1;
  return `${existing.slice(0, start)}${existing.slice(after)}`;
}

/** Plan the single instructions change (or none). Global scope always yields no change and no
 * conflict — Copilot documents no global instructions file, so there is nothing to skip *to*,
 * mirroring how other adapters skip a capability with no native equivalent for a given scope. */
function planInstructionsChange({ assets, found, context, removing, fsImpl }) {
  if (!found.paths.instruction) return { changes: [], conflicts: [] };
  const guidance = assets.find((asset) => asset.capability === 'instructions');
  if (!guidance) return { changes: [], conflicts: [] };
  const outcome = removing
    ? { ok: true, operation: 'remove', content: strippedInstruction(found.instruction) }
    : managedInstruction(found.instruction, render({ content: fsImpl.readFileSync(path.resolve(context.repoRoot, guidance.source), 'utf8') }));
  if (!outcome.ok) return { changes: [], conflicts: [outcome.conflict] };
  if (outcome.operation === 'none' || outcome.content === null) return { changes: [], conflicts: [] };
  return {
    changes: [{
      assetId: guidance.id, target: found.paths.instruction, operation: outcome.operation,
      content: outcome.content, ownershipIdentity: `${HARNESS}:instructions:managed-section`,
      fingerprint: fingerprint(outcome.content), harness: HARNESS, projection: { renderer: 'copilot-instructions' },
    }],
    conflicts: [],
  };
}

// ---- copy-tree assets (skills, agents) ----

function sourceDirFor(asset, context = {}, fsImpl = fs) {
  if (!asset || typeof asset.source !== 'string') throw new Error('Copilot asset requires a source path');
  const repoRoot = context.repoRoot ? path.resolve(context.repoRoot) : process.cwd();
  const source = path.resolve(repoRoot, asset.source);
  if (!source.startsWith(`${repoRoot}${path.sep}`) || !fsImpl.existsSync(source)) {
    throw new Error(`Copilot asset source is unavailable: ${asset.source}`);
  }
  return source;
}

function treeAssetsFor(assets, renderer) {
  return (assets || []).filter((asset) => asset?.renderer === renderer);
}

/**
 * Rename `<name>.md` to `<name>.agent.md` on the way out. Copilot's custom-agent reference
 * (https://docs.github.com/en/copilot/reference/custom-agents-configuration) requires the
 * `.agent.md` extension, while `core/shared/agent-specs/*.md` — already `name`/`description`
 * YAML-frontmatter files, the same shape `.agent.md` expects — carries a plain `.md` extension.
 * This is the same class of shape mismatch Gemini/Antigravity's `dir-per-file:agent.md` layout in
 * copy-tree.js already solves for a directory-per-agent requirement; here the mismatch is only the
 * extension, so a flat rename is enough and no directory restructuring is needed. Declared as a
 * function (rather than a name registered in copy-tree.js's LAYOUTS) because it is specific to this
 * one adapter's asset, not a shape another harness also needs.
 */
function agentFileLayout(sourceRel) {
  const ext = path.extname(sourceRel);
  const base = sourceRel.slice(0, sourceRel.length - ext.length);
  return `${base}.agent${ext || '.md'}`;
}

function planTreeAssets({ assets, renderer, destRoot, layout, context, ledger, removing, fsImpl = fs }) {
  const changes = [];
  const conflicts = [];
  for (const asset of treeAssetsFor(assets, renderer)) {
    const destDir = copyTreeDestDir(destRoot, asset);
    const sourceDir = sourceDirFor(asset, context, fsImpl);
    const previousResources = ledgerFileResources(ledger?.resources, HARNESS, asset.id);
    const result = planTree({ sourceDir, destDir, previousResources, operation: removing ? 'remove' : 'apply', fsImpl, layout: layout || asset.layout });
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
  return { changes, conflicts };
}

function applyCopyTreeAssets(changes, { fsImpl = fs } = {}) {
  const treeChanges = changes.filter((change) => change.projection?.renderer === 'copy-tree' && change.operation !== 'remove')
    .map((change) => ({ relPath: change.identity, target: change.target, source: change.source, operation: change.operation, fingerprint: change.fingerprint }));
  return applyTree({ changes: treeChanges, fsImpl }).applied;
}

function removeCopyTreeAssets(changes, { fsImpl = fs } = {}) {
  const treeChanges = changes.filter((change) => change.projection?.renderer === 'copy-tree' && change.operation === 'remove')
    .map((change) => ({ relPath: change.identity, target: change.target, operation: 'remove', fingerprint: change.fingerprint }));
  return removeTree({ changes: treeChanges, fsImpl }).removed;
}

function verifyTreeAssets({ assets, renderer, destRoot, layout, context, fsImpl = fs }) {
  const statuses = [];
  const resources = [];
  const conflicts = [];
  for (const asset of treeAssetsFor(assets, renderer)) {
    const destDir = copyTreeDestDir(destRoot, asset);
    const sourceDir = sourceDirFor(asset, context, fsImpl);
    const result = verifyTree({ sourceDir, destDir, fsImpl, layout: layout || asset.layout });
    conflicts.push(...result.conflicts.map((reason) => `${asset.id}: ${reason}`));
    for (const resource of result.resources) {
      resources.push({
        assetId: asset.id, target: resource.target, ownershipIdentity: `doflow:${HARNESS}:copy-tree:${asset.id}:${resource.relPath}`,
        kind: 'copy-tree-file', identity: resource.relPath,
        fingerprint: resource.fingerprint, sourceVersion: 'registry-v1',
        projection: { renderer: 'copy-tree' },
      });
    }
    statuses.push({ harness: HARNESS, assetId: asset.id, capability: asset.capability, status: result.ok ? 'managed' : 'conflict', target: destDir });
  }
  return { statuses, resources, conflicts };
}

// ---- mcp (.mcp.json project / ~/.copilot/mcp-config.json global) ----

/** Merge DoFlow's selected servers into the `mcpServers` object, touching only the ids it ships.
 * Every other top-level key, and every server entry not among `mcpServers` (including one a user
 * or another tool — e.g. Claude Code's own project `.mcp.json` — added), survives untouched. */
function mergeMcpConfig(existing, { mcpServers = [] } = {}) {
  const next = { ...(existing || {}) };
  if (!mcpServers.length) return next;
  next.mcpServers = { ...(next.mcpServers || {}) };
  for (const server of mcpServers) {
    const entry = { command: server.command };
    if (server.args?.length) entry.args = [...server.args];
    if (server.env && Object.keys(server.env).length) entry.env = { ...server.env };
    next.mcpServers[server.id] = entry;
  }
  return next;
}

/** Remove only what mergeMcpConfig added, leaving every other server entry and top-level key. */
function unmergeMcpConfig(existing, { mcpServers = [] } = {}) {
  const next = { ...(existing || {}) };
  if (!next.mcpServers) return next;
  next.mcpServers = { ...next.mcpServers };
  for (const server of mcpServers) delete next.mcpServers[server.id];
  if (!Object.keys(next.mcpServers).length) delete next.mcpServers;
  return next;
}

// ---- shared adapter contract ----

function plan({ scope, scopeRoot, assets = [], mcp = [], context = {}, ledger, fsImpl = fs }) {
  const found = discover({ scope, scopeRoot, context, fsImpl });
  const changes = [];
  const conflicts = [];
  const removing = context.operation === 'remove';

  const instructions = planInstructionsChange({ assets, found, context, removing, fsImpl });
  changes.push(...instructions.changes);
  conflicts.push(...instructions.conflicts);

  const skills = planTreeAssets({ assets, renderer: 'copy-tree', destRoot: found.paths.skillsConfigDir, layout: null, context, ledger, removing, fsImpl });
  changes.push(...skills.changes);
  conflicts.push(...skills.conflicts);

  const agents = planTreeAssets({ assets, renderer: 'copilot-agents', destRoot: found.paths.agentsConfigDir, layout: agentFileLayout, context, ledger, removing, fsImpl });
  changes.push(...agents.changes);
  conflicts.push(...agents.conflicts);

  if (found.mcp.error) {
    conflicts.push(found.mcp.error);
  } else {
    const current = found.mcp.value || {};
    const next = removing ? unmergeMcpConfig(current, { mcpServers: mcp }) : mergeMcpConfig(current, { mcpServers: mcp });
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      changes.push({
        assetId: pseudoAssetId(assets), target: found.paths.mcp,
        // Tagged 'remove' during a remove operation (rather than always 'update'/'create') so this
        // adapter's own apply()/remove() dispatch — which routes strictly on `operation` — writes
        // the unmerged file during removal instead of silently skipping it.
        operation: removing ? 'remove' : (found.mcp.exists ? 'update' : 'create'),
        content: `${JSON.stringify(next, null, 2)}\n`,
        ownershipIdentity: `${HARNESS}:mcp:registration`, fingerprint: fingerprint(next),
        harness: HARNESS, projection: { renderer: 'copilot-mcp' },
      });
    }
  }

  return { changes, conflicts, paths: found.paths };
}

function writeChange(change, fsImpl) {
  fsImpl.mkdirSync(path.dirname(change.target), { recursive: true });
  fsImpl.writeFileSync(change.target, change.content, 'utf8');
}

function apply({ changes = [], fsImpl = fs }) {
  let applied = 0;
  for (const change of changes) {
    if (change.operation === 'remove') continue;
    if (change.projection?.renderer === 'copy-tree') continue;
    writeChange(change, fsImpl);
    applied += 1;
  }
  applied += applyCopyTreeAssets(changes, { fsImpl });
  return { applied };
}

function remove({ changes = [], fsImpl = fs }) {
  let removed = 0;
  for (const change of changes) {
    if (change.operation !== 'remove') continue;
    if (change.projection?.renderer === 'copy-tree') continue;
    if (change.content === null) continue;
    writeChange(change, fsImpl);
    removed += 1;
  }
  removed += removeCopyTreeAssets(changes, { fsImpl });
  return { removed };
}

function verify({ scope, scopeRoot, assets = [], mcp = [], context = {}, fsImpl = fs }) {
  const found = discover({ scope, scopeRoot, context, fsImpl });
  const statuses = [];
  const resources = [];
  const conflicts = [];

  if (found.paths.instruction) {
    const guidance = assets.find((asset) => asset.capability === 'instructions');
    const hasSection = typeof found.instruction === 'string' && found.instruction.includes(MARKER_START) && found.instruction.includes(MARKER_END);
    const assetId = guidance?.id ?? 'guidance.codex-pointer';
    statuses.push({ harness: HARNESS, assetId, capability: 'instructions',
      status: hasSection ? 'managed' : 'absent', target: found.paths.instruction,
      ownershipIdentity: `${HARNESS}:instructions:managed-section` });
    if (hasSection) {
      resources.push({ assetId, target: found.paths.instruction,
        ownershipIdentity: `${HARNESS}:instructions:managed-section`, fingerprint: fingerprint(found.instruction),
        sourceVersion: context.sourceVersion ?? 'unknown', projection: { renderer: 'copilot-instructions' } });
    }
  }

  const skills = verifyTreeAssets({ assets, renderer: 'copy-tree', destRoot: found.paths.skillsConfigDir, layout: null, context, fsImpl });
  resources.push(...skills.resources);
  statuses.push(...skills.statuses);
  conflicts.push(...skills.conflicts);

  const agents = verifyTreeAssets({ assets, renderer: 'copilot-agents', destRoot: found.paths.agentsConfigDir, layout: agentFileLayout, context, fsImpl });
  resources.push(...agents.resources);
  statuses.push(...agents.statuses);
  conflicts.push(...agents.conflicts);

  if (found.mcp.error) {
    conflicts.push(found.mcp.error);
    statuses.push({ harness: HARNESS, assetId: pseudoAssetId(assets), capability: 'mcp', status: 'invalid', target: found.paths.mcp });
  } else {
    const value = found.mcp.value || {};
    const registered = mcp.filter((server) => value.mcpServers?.[server.id]);
    const missing = mcp.filter((server) => !value.mcpServers?.[server.id]);
    if (registered.length) {
      statuses.push({ harness: HARNESS, assetId: pseudoAssetId(assets), capability: 'mcp', status: 'managed',
        target: found.paths.mcp, ownershipIdentity: `${HARNESS}:mcp:registration` });
      resources.push({ assetId: pseudoAssetId(assets), target: found.paths.mcp,
        ownershipIdentity: `${HARNESS}:mcp:registration`, fingerprint: fingerprint(value.mcpServers),
        sourceVersion: context.sourceVersion ?? 'unknown', projection: { renderer: 'copilot-mcp' } });
    }
    for (const server of missing) {
      statuses.push({ harness: HARNESS, assetId: pseudoAssetId(assets), capability: 'mcp', status: 'missing', identity: server.id, target: found.paths.mcp });
    }
  }

  return { ok: conflicts.length === 0 && !statuses.some((s) => s.status === 'invalid' || s.status === 'conflict'), resources, statuses, conflicts };
}

module.exports = {
  HARNESS, MARKER_START, MARKER_END, nativePaths, discover, render, plan, apply, remove, verify,
  managedInstruction, strippedInstruction,
  mergeMcpConfig, unmergeMcpConfig,
  agentFileLayout,
  createCopilotAdapter: () => ({ discover, render, plan, apply, remove, verify }),
};
