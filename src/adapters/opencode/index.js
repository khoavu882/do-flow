'use strict';

// OpenCode adapter.
//
// OpenCode gets its own copy of DoFlow's skills tree, the same as Claude, Codex, and Gemini: it
// natively discovers skills under `.opencode/skills/` (project) and `~/.config/opencode/skills/`
// (global) without any settings entry, so the shared copy-tree engine in ../copy-tree.js
// materialises `skills.doflow` there directly. What remains registration, rather than
// materialisation, is `opencode.json`'s `instructions[]` array (OpenCode needs `AGENTS.md` named
// explicitly to read it) and its `mcp` object — neither has a native discovery path the way skills
// now do.
//
// Evidence: https://opencode.ai/docs/skills, https://opencode.ai/docs/config,
// https://opencode.ai/docs/rules
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { planTree, applyTree, removeTree, verifyTree, copyTreeAssets, copyTreeDestDir, ledgerFileResources } = require('../copy-tree');

// Only the marker constants: marker-merge.js reads and writes files itself, which cannot be used
// from plan(), whose contract is to compute changes without touching disk. The gemini adapter
// solves this the same way, with a pure managedInstruction() over strings.
const { MARKER_START, MARKER_END } = require('../../marker-merge');

const HARNESS = 'opencode';
const CONFIG_FILE = 'opencode.json';
const INSTRUCTION_FILE = 'AGENTS.md';

function fingerprint(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

/**
 * Native paths for a scope.
 * Global config lives under `~/.config/opencode/`, NOT `~/.opencode/` — the latter is a plausible
 * guess that OpenCode does not use, and DoFlow's own docs asserted it for several releases.
 */
function nativePaths({ scope, scopeRoot, homeDir }) {
  const root = scope === 'global' ? path.resolve(homeDir || scopeRoot) : path.resolve(scopeRoot);
  const configDir = scope === 'global' ? path.join(root, '.config', 'opencode') : root;
  return {
    root,
    configDir,
    instruction: path.join(configDir, INSTRUCTION_FILE),
    config: path.join(scope === 'global' ? configDir : root, CONFIG_FILE),
  };
}

/** The directory a copy-tree asset (skills) materialises under. Distinct from `configDir` at
 * project scope: `configDir` there is the project root itself, because `AGENTS.md` and
 * `opencode.json` are read from the repo root, but the skills tree is namespaced under
 * `.opencode/` per design.md's native-surfaces table. Global scope has no such split —
 * `~/.config/opencode` already IS the skills root. */
function copyTreeConfigDir(scope, paths) {
  return scope === 'global' ? paths.configDir : path.join(paths.root, '.opencode');
}

function readJson(file, { fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(file)) return { exists: false, value: {}, error: null };
  try { return { exists: true, value: JSON.parse(fsImpl.readFileSync(file, 'utf8')), error: null }; }
  catch (error) { return { exists: true, value: null, error: `Invalid JSON in ${file}: ${error.message}` }; }
}

function discover({ scope, scopeRoot, context = {}, fsImpl = fs }) {
  const paths = nativePaths({ scope, scopeRoot, homeDir: context.homeDir });
  const instruction = fsImpl.existsSync(paths.instruction) ? fsImpl.readFileSync(paths.instruction, 'utf8') : null;
  return { paths, instruction, config: readJson(paths.config, { fsImpl }) };
}

function render({ content = '' } = {}) {
  return `${MARKER_START}\n${String(content).trimEnd()}\n${MARKER_END}\n`;
}

/** Merge DoFlow's entries into opencode.json without disturbing anything else in it. `instructions`
 * is unioned rather than replaced because OpenCode treats it as additive across every config it
 * discovers — replacing would silently drop a user's own entries. Skills are deliberately absent
 * here: they are a materialised directory now, discovered natively, not a registered path. */
function mergeConfig(existing, { mcpServers = [] } = {}) {
  const next = { ...(existing || {}) };
  const union = (current, add) => [...new Set([...(Array.isArray(current) ? current : []), ...add])];

  next.instructions = union(next.instructions, [INSTRUCTION_FILE]);
  if (mcpServers.length) {
    next.mcp = { ...(next.mcp || {}) };
    for (const server of mcpServers) {
      next.mcp[server.id] = {
        type: 'local',
        command: [server.command, ...(server.args || [])],
        enabled: true,
      };
    }
  }
  return next;
}

/** Remove only what mergeConfig added, leaving every user key and every unrelated array entry. */
function unmergeConfig(existing, { mcpServers = [] } = {}) {
  const next = { ...(existing || {}) };
  const without = (current, drop) => (Array.isArray(current) ? current.filter((v) => !drop.includes(v)) : []);

  next.instructions = without(next.instructions, [INSTRUCTION_FILE]);
  if (!next.instructions.length) delete next.instructions;
  if (next.mcp) {
    for (const server of mcpServers) delete next.mcp[server.id];
    if (!Object.keys(next.mcp).length) delete next.mcp;
  }
  return next;
}

/** Replace only the span between DoFlow's markers, leaving everything else byte-identical.
 * An AGENTS.md that exists without a DoFlow section is refused rather than appended to — the same
 * policy the gemini adapter applies to GEMINI.md, and for the same reason: AGENTS.md is a shared,
 * cross-tool file, so where DoFlow's content belongs inside it is a decision for its owner, not a
 * guess for the installer. Add an empty marker pair to opt in. */
function managedInstruction(existing, rendered) {
  if (existing === null) return { ok: true, operation: 'create', content: rendered };
  const start = existing.indexOf(MARKER_START);
  const end = existing.indexOf(MARKER_END);
  if (start === -1 && end === -1) return { ok: false, conflict: `${INSTRUCTION_FILE} exists without a DoFlow managed section` };
  if (start === -1 || end === -1 || end < start) return { ok: false, conflict: `${INSTRUCTION_FILE} has malformed DoFlow managed-section markers` };
  const content = `${existing.slice(0, start)}${rendered}${existing.slice(end + MARKER_END.length).replace(/^\n?/, '')}`;
  return { ok: true, operation: content === existing ? 'none' : 'merge', content };
}

/** Strip DoFlow's span, leaving the rest of a shared AGENTS.md intact. Returns null when there is
 * nothing to do, so remove() can skip the write entirely. */
function strippedInstruction(existing) {
  if (typeof existing !== 'string') return null;
  const start = existing.indexOf(MARKER_START);
  const end = existing.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end < start) return null;
  let after = end + MARKER_END.length;
  if (existing[after] === '\n') after += 1;
  return `${existing.slice(0, start)}${existing.slice(after)}`;
}

// ---- copy-tree assets (skills) ----

function sourceDirFor(asset, context = {}, fsImpl = fs) {
  if (!asset || typeof asset.source !== 'string') throw new Error('OpenCode asset requires a source path');
  const repoRoot = context.repoRoot ? path.resolve(context.repoRoot) : process.cwd();
  const source = path.resolve(repoRoot, asset.source);
  if (!source.startsWith(`${repoRoot}${path.sep}`) || !fsImpl.existsSync(source)) {
    throw new Error(`OpenCode asset source is unavailable: ${asset.source}`);
  }
  return source;
}

function planCopyTreeAssets({ assets, scope, scopeRoot, context, ledger, removing, fsImpl = fs }) {
  const paths = nativePaths({ scope, scopeRoot, homeDir: context.homeDir });
  const treeConfigDir = copyTreeConfigDir(scope, paths);
  const changes = [];
  const conflicts = [];
  for (const asset of copyTreeAssets(assets)) {
    const destDir = copyTreeDestDir(treeConfigDir, asset);
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

function verifyCopyTreeAssets({ assets, scope, scopeRoot, context, fsImpl = fs }) {
  const paths = nativePaths({ scope, scopeRoot, homeDir: context.homeDir });
  const treeConfigDir = copyTreeConfigDir(scope, paths);
  const statuses = [];
  const resources = [];
  const conflicts = [];
  for (const asset of copyTreeAssets(assets)) {
    const destDir = copyTreeDestDir(treeConfigDir, asset);
    const sourceDir = sourceDirFor(asset, context, fsImpl);
    const result = verifyTree({ sourceDir, destDir, fsImpl, layout: asset.layout });
    conflicts.push(...result.conflicts.map((reason) => `${asset.id}: ${reason}`));
    for (const resource of result.resources) {
      resources.push({
        assetId: asset.id, target: resource.target, ownershipIdentity: `doflow:${HARNESS}:copy-tree:${asset.id}:${resource.relPath}`,
        kind: 'copy-tree-file', identity: resource.relPath,
        fingerprint: resource.fingerprint, sourceVersion: 'registry-v1',
        projection: { renderer: 'copy-tree' },
      });
    }
    statuses.push({ assetId: asset.id, capability: asset.capability, status: result.ok ? 'managed' : 'conflict', target: destDir });
  }
  return { statuses, resources, conflicts };
}

// ---- shared adapter contract ----

function plan({ scope, scopeRoot, assets = [], mcp = [], context = {}, ledger, fsImpl = fs }) {
  const found = discover({ scope, scopeRoot, context, fsImpl });
  const changes = [];
  const conflicts = [];
  const removing = context.operation === 'remove';

  if (found.config.error) conflicts.push(found.config.error);

  const guidance = assets.find((asset) => asset.capability === 'instructions');
  if (guidance) {
    const rendered = render({ content: fsImpl.readFileSync(context.sourceFor(guidance), 'utf8') });
    const outcome = removing
      ? { ok: true, operation: 'remove', content: strippedInstruction(found.instruction) }
      : managedInstruction(found.instruction, rendered);
    if (!outcome.ok) conflicts.push(outcome.conflict);
    else if (outcome.operation !== 'none' && outcome.content !== null) {
      changes.push({ assetId: guidance.id, target: found.paths.instruction, operation: outcome.operation,
        content: outcome.content, ownershipIdentity: `${HARNESS}:instructions:managed-section`,
        fingerprint: fingerprint(outcome.content), harness: HARNESS, projection: { renderer: 'opencode-instructions' } });
    }
  }

  if (!found.config.error) {
    const current = found.config.value || {};
    const next = removing ? unmergeConfig(current, { mcpServers: mcp }) : mergeConfig(current, { mcpServers: mcp });
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      changes.push({ assetId: 'opencode.config', target: found.paths.config,
        operation: found.config.exists ? 'update' : 'create', content: `${JSON.stringify(next, null, 2)}\n`,
        ownershipIdentity: `${HARNESS}:config:registration`, fingerprint: fingerprint(next),
        harness: HARNESS, projection: { renderer: 'opencode-config' } });
    }
  }

  const copyTree = planCopyTreeAssets({ assets, scope, scopeRoot, context, ledger, removing, fsImpl });
  changes.push(...copyTree.changes);
  conflicts.push(...copyTree.conflicts);

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

  const hasSection = typeof found.instruction === 'string'
    && found.instruction.includes(MARKER_START) && found.instruction.includes(MARKER_END);
  statuses.push({ harness: HARNESS, assetId: 'guidance.core', capability: 'instructions',
    status: hasSection ? 'managed' : 'absent', target: found.paths.instruction,
    ownershipIdentity: `${HARNESS}:instructions:managed-section` });
  if (hasSection) {
    resources.push({ assetId: 'guidance.core', target: found.paths.instruction,
      ownershipIdentity: `${HARNESS}:instructions:managed-section`, fingerprint: fingerprint(found.instruction),
      sourceVersion: context.sourceVersion ?? 'unknown', projection: { renderer: 'opencode-instructions' } });
  }

  if (found.config.error) {
    conflicts.push(found.config.error);
    statuses.push({ harness: HARNESS, assetId: 'opencode.config', capability: 'settings', status: 'invalid', target: found.paths.config });
  } else {
    const value = found.config.value || {};
    const registered = Array.isArray(value.instructions) && value.instructions.includes(INSTRUCTION_FILE);
    statuses.push({ harness: HARNESS, assetId: 'opencode.config', capability: 'settings',
      status: registered ? 'managed' : 'absent', target: found.paths.config,
      ownershipIdentity: `${HARNESS}:config:registration` });
    if (registered) {
      resources.push({ assetId: 'opencode.config', target: found.paths.config,
        ownershipIdentity: `${HARNESS}:config:registration`, fingerprint: fingerprint(value),
        sourceVersion: context.sourceVersion ?? 'unknown', projection: { renderer: 'opencode-config' } });
    }
    const missingMcp = mcp.filter((server) => !value.mcp?.[server.id]);
    for (const server of missingMcp) {
      statuses.push({ harness: HARNESS, assetId: 'opencode.config', capability: 'mcp', status: 'missing',
        identity: server.id, target: found.paths.config });
    }
  }

  const copyTree = verifyCopyTreeAssets({ assets, scope, scopeRoot, context, fsImpl });
  resources.push(...copyTree.resources);
  statuses.push(...copyTree.statuses.map((status) => ({ harness: HARNESS, ...status })));
  conflicts.push(...copyTree.conflicts);

  return { ok: conflicts.length === 0 && !statuses.some((s) => s.status === 'invalid' || s.status === 'conflict'), resources, statuses, conflicts };
}

module.exports = {
  HARNESS, MARKER_START, MARKER_END, nativePaths, discover, render, plan, apply, remove, verify,
  managedInstruction, strippedInstruction,
  mergeConfig, unmergeConfig,
  createOpenCodeAdapter: () => ({ discover, render, plan, apply, remove, verify }),
};
