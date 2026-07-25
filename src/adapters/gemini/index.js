'use strict';

// Gemini CLI adapter.  Native settings are JSON and Gemini's extension installation is a host
// workflow, so this adapter deliberately plans only safe instruction projection while exposing
// settings/MCP/extensions as first-class native-surface results for the lifecycle UI.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { planTree, applyTree, removeTree, verifyTree } = require('../copy-tree');

const MARKER_START = '<!-- doflow:start -->';
const MARKER_END = '<!-- doflow:end -->';
const DEFAULTS_FILE = path.resolve(__dirname, '../../../core/harnesses/gemini/settings/adapter-defaults.json');
const HARNESS = 'gemini';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function fingerprint(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stable(value))).digest('hex'); }
function defaults({ fsImpl = fs } = {}) { return JSON.parse(fsImpl.readFileSync(DEFAULTS_FILE, 'utf8')); }

function nativePaths({ scope, scopeRoot, homeDir, fsImpl = fs }) {
  const config = defaults({ fsImpl });
  const root = scope === 'global' ? path.resolve(homeDir || scopeRoot) : path.resolve(scopeRoot);
  const geminiDir = path.join(root, '.gemini');
  // Project-scope config deliberately lives under .agents/, not .gemini/ — src/targets.js's own
  // Antigravity-customization convention (see its toolDirs()); only global scope uses .gemini/ for
  // anything beyond the instruction file (which project scope already places at the repo root).
  const configDir = scope === 'global' ? geminiDir : path.join(root, '.agents');
  return {
    root,
    configDir,
    instruction: scope === 'global' ? path.join(geminiDir, config.instructionFile) : path.join(root, config.instructionFile),
    settings: path.join(root, config.settingsFile),
    extensionMode: config.extensionInstall,
  };
}

function readJson(file, { fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(file)) return { exists: false, value: {}, error: null };
  try { return { exists: true, value: JSON.parse(fsImpl.readFileSync(file, 'utf8')), error: null }; }
  catch (error) { return { exists: true, value: null, error: `Invalid JSON in ${file}: ${error.message}` }; }
}

function discover({ scope, scopeRoot, context = {}, fsImpl = fs }) {
  const paths = nativePaths({ scope, scopeRoot, homeDir: context.homeDir, fsImpl });
  const instruction = fsImpl.existsSync(paths.instruction) ? fsImpl.readFileSync(paths.instruction, 'utf8') : null;
  return { paths, instruction, settings: readJson(paths.settings, { fsImpl }) };
}

function render({ content = '' } = {}) {
  const body = String(content).trimEnd();
  return `${MARKER_START}\n${body}\n${MARKER_END}\n`;
}

function managedInstruction(existing, rendered) {
  if (existing === null) return { ok: true, operation: 'create', content: rendered };
  const start = existing.indexOf(MARKER_START);
  const end = existing.indexOf(MARKER_END);
  if (start === -1 && end === -1) return { ok: false, conflict: 'GEMINI.md exists without a DoFlow managed section' };
  if (start === -1 || end === -1 || end < start) return { ok: false, conflict: 'GEMINI.md has malformed DoFlow managed-section markers' };
  const content = `${existing.slice(0, start)}${rendered}${existing.slice(end + MARKER_END.length).replace(/^\n?/, '')}`;
  return { ok: true, operation: content === existing ? 'none' : 'merge', content };
}

function instructionContent({ assets, context, fsImpl = fs }) {
  if (context.instructionContent !== undefined) return String(context.instructionContent);
  const asset = assets.find((item) => item.id === 'guidance.core');
  if (!asset || !context.repoRoot) return null;
  const source = path.resolve(context.repoRoot, asset.source);
  return fsImpl.existsSync(source) ? fsImpl.readFileSync(source, 'utf8') : null;
}

function policyStatuses(policies = []) {
  return policies.map((policy) => ({ id: policy.id, status: 'unavailable', fallback: 'guidance', reason: 'Gemini policy automation is not rendered by this adapter' }));
}

// ---- copy-tree assets (rules, skills, agents, modes, references) ----

function copyTreeAssets(assets) { return (assets || []).filter((asset) => asset?.renderer === 'copy-tree'); }
function copyTreeDestDir(paths, asset) { return path.join(paths.configDir, asset.nativeDir || ''); }
function sourceDirFor(asset, context = {}, fsImpl = fs) {
  if (!asset || typeof asset.source !== 'string') throw new Error('Gemini asset requires a source path');
  const repoRoot = context.repoRoot ? path.resolve(context.repoRoot) : process.cwd();
  const source = path.resolve(repoRoot, asset.source);
  if (!source.startsWith(`${repoRoot}${path.sep}`) || !fsImpl.existsSync(source)) {
    throw new Error(`Gemini asset source is unavailable: ${asset.source}`);
  }
  return source;
}

function ledgerFileResources(ledger, assetId) {
  return (ledger?.resources || [])
    .filter((resource) => resource.harness === HARNESS && resource.assetId === assetId && resource.kind === 'copy-tree-file')
    .map((resource) => ({ relPath: resource.identity, fingerprint: resource.fingerprint }));
}

function planCopyTreeAssets({ assets, scope, scopeRoot, context, ledger, removing, fsImpl = fs }) {
  const paths = nativePaths({ scope, scopeRoot, homeDir: context.homeDir, fsImpl });
  const changes = [];
  const conflicts = [];
  for (const asset of copyTreeAssets(assets)) {
    const destDir = copyTreeDestDir(paths, asset);
    const sourceDir = sourceDirFor(asset, context, fsImpl);
    const previousResources = ledgerFileResources(ledger, asset.id);
    const result = planTree({ sourceDir, destDir, previousResources, operation: removing ? 'remove' : 'apply', fsImpl });
    conflicts.push(...result.conflicts.map((reason) => `${asset.id}: ${reason}`));
    for (const change of result.changes) {
      changes.push({
        assetId: asset.id, target: change.target, source: change.source, operation: change.operation,
        ownershipIdentity: `doflow:gemini:copy-tree:${asset.id}:${change.relPath}`,
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
  const paths = nativePaths({ scope, scopeRoot, homeDir: context.homeDir, fsImpl });
  const statuses = [];
  const resources = [];
  const conflicts = [];
  for (const asset of copyTreeAssets(assets)) {
    const destDir = copyTreeDestDir(paths, asset);
    const sourceDir = sourceDirFor(asset, context, fsImpl);
    const result = verifyTree({ sourceDir, destDir, fsImpl });
    conflicts.push(...result.conflicts.map((reason) => `${asset.id}: ${reason}`));
    for (const resource of result.resources) {
      resources.push({
        assetId: asset.id, target: resource.target, ownershipIdentity: `doflow:gemini:copy-tree:${asset.id}:${resource.relPath}`,
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

function plan({ scope, scopeRoot, assets = [], mcp = [], discovery, context = {}, ledger, fsImpl = fs }) {
  const found = discovery || discover({ scope, scopeRoot, context, fsImpl });
  const changes = []; const conflicts = [];
  const removing = context.operation === 'remove';
  if (removing) {
    // Removal only ever targets a section this adapter itself owns — a foreign or absent
    // GEMINI.md yields no change, never a forced deletion of user content.
    const owns = found.instruction !== null && found.instruction.includes(MARKER_START) && found.instruction.includes(MARKER_END);
    if (assets.some((asset) => asset.id === 'guidance.core') && owns) {
      changes.push({ assetId: 'guidance.core', target: found.paths.instruction, operation: 'remove', ownershipIdentity: 'gemini:instructions', projection: { renderer: 'gemini-instructions' } });
    }
  } else {
    const content = instructionContent({ assets, context, fsImpl });
    if (content !== null) {
      const next = managedInstruction(found.instruction, render({ content }));
      if (!next.ok) conflicts.push(next.conflict);
      else if (next.operation !== 'none') changes.push({ assetId: 'guidance.core', target: found.paths.instruction, operation: next.operation, ownershipIdentity: 'gemini:instructions', afterFingerprint: fingerprint(next.content), content: next.content, projection: { renderer: 'gemini-instructions' } });
    }
  }
  const copyTree = planCopyTreeAssets({ assets, scope, scopeRoot, context, ledger, removing, fsImpl });
  changes.push(...copyTree.changes); conflicts.push(...copyTree.conflicts);
  if (found.settings.error) conflicts.push(found.settings.error);
  return {
    changes, conflicts, prerequisites: [],
    surfaces: {
      instructions: { status: 'supported', target: found.paths.instruction },
      settings: { status: found.settings.error ? 'invalid' : 'supported', target: found.paths.settings },
      mcp: { status: found.settings.error ? 'blocked' : 'supported', target: found.paths.settings, selected: mcp.map((item) => item.id) },
      extensions: { status: 'different', mode: found.paths.extensionMode, action: 'use Gemini CLI extension management' },
      policies: policyStatuses(context.policies),
    },
  };
}

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
function apply({ changes = [], fsImpl = fs }) {
  for (const change of changes) if (change.content !== undefined) atomicWrite(change.target, change.content, { fsImpl });
  applyCopyTreeAssets(changes, { fsImpl });
}

/** Strip only the DoFlow-managed span, exactly like the Claude adapter's removeManagedSection —
 * a file with user content before/after the managed section must keep that content. Only delete
 * the file outright once nothing but the managed section (and its separator) remains. */
function removeManagedSection(file, { fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(file)) return false;
  const existing = fsImpl.readFileSync(file, 'utf8');
  const start = existing.indexOf(MARKER_START);
  if (start === -1) return false;
  const end = existing.indexOf(MARKER_END, start + MARKER_START.length);
  if (end === -1 || existing.indexOf(MARKER_START, end + MARKER_END.length) !== -1) {
    throw new Error(`Refusing to remove malformed DoFlow markers in ${file}`);
  }
  let after = end + MARKER_END.length;
  if (existing[after] === '\n') after += 1;
  let next = existing.slice(0, start) + existing.slice(after);
  if (next === '\n') next = '';
  if (next === '') fsImpl.rmSync(file, { force: true });
  else fsImpl.writeFileSync(file, next);
  return true;
}
function remove({ changes = [], fsImpl = fs }) {
  for (const change of changes) if (change.target && change.projection?.renderer === 'gemini-instructions') removeManagedSection(change.target, { fsImpl });
  removeCopyTreeAssets(changes, { fsImpl });
}

function verify({ scope, scopeRoot, assets = [], context = {}, fsImpl = fs }) {
  const found = discover({ scope, scopeRoot, context, fsImpl });
  const resources = [];
  if (assets.some((asset) => asset.id === 'guidance.core') && found.instruction?.includes(MARKER_START) && found.instruction.includes(MARKER_END)) {
    resources.push({ assetId: 'guidance.core', target: found.paths.instruction, ownershipIdentity: 'gemini:instructions', fingerprint: fingerprint(found.instruction), sourceVersion: context.sourceVersion ?? 'unknown', projection: { renderer: 'gemini-instructions' } });
  }
  const copyTree = verifyCopyTreeAssets({ assets, scope, scopeRoot, context, fsImpl });
  resources.push(...copyTree.resources);
  return { ok: !found.settings.error && copyTree.conflicts.length === 0, resources,
    statuses: { settings: found.settings.error ? 'invalid' : 'supported', extensions: 'different', policies: policyStatuses(context.policies), copyTree: copyTree.statuses },
    conflicts: [...(found.settings.error ? [found.settings.error] : []), ...copyTree.conflicts] };
}

module.exports = { MARKER_START, MARKER_END, nativePaths, discover, render, managedInstruction, plan, apply, remove, verify, createGeminiAdapter: () => ({ discover, render, plan, apply, remove, verify }) };
