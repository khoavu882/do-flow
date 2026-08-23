'use strict';

// Pi adapter — a marker-merged instruction file plus copy-tree materialisation, the same shape
// Claude/Codex/Gemini already use for their own skills trees.
//
// Skills materialise into Pi's own directories (`~/.pi/agent/skills` global, `.pi/skills` project)
// via the shared copy-tree engine, rather than pointing Pi's settings.json at DoFlow's already
// -installed `~/.claude/skills` tree. Whether Pi discovers that directory unaided, or needs a
// `settings.json` entry naming it, is untested here — that is task B.3's job, not this adapter's;
// this adapter deliberately leaves settings.json untouched.
//
// MCP is deliberately absent: Pi reaches MCP servers through the separate pi-mcp-adapter extension,
// not a native config key, so there is nothing here for DoFlow to merge into. Hooks are absent for
// the same class of reason — Pi lifecycle handlers are TypeScript modules registered via pi.on(),
// executing with full system permissions, which is a different trust model from the shell scripts
// DoFlow ships.
//
// Evidence: https://pi.dev/docs/latest/settings, https://pi.dev/docs/latest/skills,
// https://pi.dev/docs/latest/quickstart, https://pi.dev/docs/latest/extensions
const fs = require('node:fs');
const path = require('node:path');

const { MARKER_START, MARKER_END } = require('../../helper/marker-merge');
const { planTree, applyTree, removeTree, verifyTree, copyTreeAssets, copyTreeDestDir, ledgerFileResources, fingerprint, sourceDirFor } = require('../copy-tree');
const { declaredHarnessPaths, resolveHarnessPaths } = require('../../helper/harness-paths');

const HARNESS = 'pi';

// Native path facts live in core/registry/harnesses.json under this harness's "paths" section and
// resolve through the shared harness-paths resolver; nothing below hardcodes them.
// createPiAdapter({ declaredPaths }) is the injection point buildAdapterRegistry() uses;
// module-level exports delegate to a default-configured instance so direct callers keep their
// historical shape.
function createPiAdapter({ declaredPaths = declaredHarnessPaths()[HARNESS] } = {}) {
  // Parity note: Pi's historical nativePaths() derived even its user-scope root from scopeRoot
  // (the CLI passes $HOME there for -g installs), never from a separate homeDir argument — so the
  // resolver is fed no homeDir and "root" keeps resolving exactly as before.
  function nativePaths({ scope, scopeRoot } = {}) {
    return resolveHarnessPaths(declaredPaths, { scope, scopeRoot });
  }

  function discover({ scope, scopeRoot, context = {}, fsImpl = fs }) {
    const paths = nativePaths({ scope, scopeRoot });
    const instruction = fsImpl.existsSync(paths.instruction) ? fsImpl.readFileSync(paths.instruction, 'utf8') : null;
    return { paths, instruction };
  }

  function render({ content = '' } = {}) {
    return `${MARKER_START}\n${String(content).trimEnd()}\n${MARKER_END}\n`;
  }

  /** Replace only the span between DoFlow's markers. An AGENTS.md with no DoFlow section is refused
   * rather than appended to — Pi shares AGENTS.md with every other agent that reads it, so where
   * DoFlow's content belongs is its owner's decision. Add an empty marker pair to opt in. */
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

  // ---- copy-tree assets (skills) ----

  function planCopyTreeAssets({ assets, scope, scopeRoot, context, ledger, removing, fsImpl = fs }) {
    const paths = nativePaths({ scope, scopeRoot });
    const changes = [];
    const conflicts = [];
    for (const asset of copyTreeAssets(assets)) {
      const destDir = copyTreeDestDir(paths.configDir, asset);
      const sourceDir = sourceDirFor(asset, context, fsImpl, 'Pi');
      const previousResources = ledgerFileResources(ledger?.resources, HARNESS, asset.id);
      const result = planTree({ sourceDir, destDir, previousResources, operation: removing ? 'remove' : 'apply', fsImpl, layout: asset.layout });
      conflicts.push(...result.conflicts.map((reason) => `${asset.id}: ${reason}`));
      for (const change of result.changes) {
        changes.push({
          assetId: asset.id, target: change.target, source: change.source, operation: change.operation,
          ownershipIdentity: `doflow:pi:copy-tree:${asset.id}:${change.relPath}`,
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
    const treeChanges = changes.filter((change) => change.kind === 'copy-tree-file' && change.operation === 'remove')
      .map((change) => ({ relPath: change.identity, target: change.target, operation: 'remove', fingerprint: change.fingerprint }));
    return removeTree({ changes: treeChanges, fsImpl }).removed;
  }

  function verifyCopyTreeAssets({ assets, scope, scopeRoot, context, fsImpl = fs }) {
    const paths = nativePaths({ scope, scopeRoot });
    const statuses = [];
    const resources = [];
    const conflicts = [];
    for (const asset of copyTreeAssets(assets)) {
      const destDir = copyTreeDestDir(paths.configDir, asset);
      const sourceDir = sourceDirFor(asset, context, fsImpl, 'Pi');
      const result = verifyTree({ sourceDir, destDir, fsImpl, layout: asset.layout });
      conflicts.push(...result.conflicts.map((reason) => `${asset.id}: ${reason}`));
      for (const resource of result.resources) {
        resources.push({
          assetId: asset.id, target: resource.target, ownershipIdentity: `doflow:pi:copy-tree:${asset.id}:${resource.relPath}`,
          kind: 'copy-tree-file', identity: resource.relPath,
          fingerprint: resource.fingerprint, sourceVersion: 'registry-v1',
          projection: { renderer: 'copy-tree' },
        });
      }
      statuses.push({ harness: HARNESS, assetId: asset.id, capability: asset.capability, status: result.ok ? 'managed' : 'conflict', target: destDir });
    }
    return { statuses, resources, conflicts };
  }

  // ---- shared adapter contract ----

  function plan({ scope, scopeRoot, assets = [], context = {}, ledger, fsImpl = fs }) {
    const found = discover({ scope, scopeRoot, context, fsImpl });
    const changes = [];
    const conflicts = [];
    const removing = context.operation === 'remove';

    const guidance = assets.find((asset) => asset.capability === 'instructions');
    if (guidance) {
      const rendered = render({ content: fsImpl.readFileSync(path.resolve(context.repoRoot, guidance.source), 'utf8') });
      const outcome = removing
        ? { ok: true, operation: 'remove', content: strippedInstruction(found.instruction) }
        : managedInstruction(found.instruction, rendered);
      if (!outcome.ok) conflicts.push(outcome.conflict);
      else if (outcome.operation !== 'none' && outcome.content !== null) {
        changes.push({ assetId: guidance.id, target: found.paths.instruction, operation: outcome.operation,
          content: outcome.content, ownershipIdentity: `${HARNESS}:instructions:managed-section`,
          fingerprint: fingerprint(outcome.content), harness: HARNESS, projection: { renderer: 'pi-instructions' } });
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
      if (change.operation === 'remove' || change.projection?.renderer === 'copy-tree') continue;
      writeChange(change, fsImpl);
      applied += 1;
    }
    applied += applyCopyTreeAssets(changes, { fsImpl });
    return { applied };
  }

  function remove({ changes = [], fsImpl = fs }) {
    let removed = 0;
    for (const change of changes) {
      if (change.operation !== 'remove' || change.projection?.renderer === 'copy-tree') continue;
      if (change.content === null) continue;
      writeChange(change, fsImpl);
      removed += 1;
    }
    removed += removeCopyTreeAssets(changes, { fsImpl });
    return { removed };
  }

  function verify({ scope, scopeRoot, assets = [], context = {}, fsImpl = fs }) {
    const found = discover({ scope, scopeRoot, context, fsImpl });
    const statuses = [];
    const resources = [];
    const conflicts = [];
    const instructionsAssetId = assets.find((asset) => asset.capability === 'instructions')?.id ?? assets[0]?.id;

    const hasSection = typeof found.instruction === 'string'
      && found.instruction.includes(MARKER_START) && found.instruction.includes(MARKER_END);
    statuses.push({ harness: HARNESS, assetId: instructionsAssetId, capability: 'instructions',
      status: hasSection ? 'managed' : 'absent', target: found.paths.instruction,
      ownershipIdentity: `${HARNESS}:instructions:managed-section` });
    if (hasSection) {
      resources.push({ assetId: instructionsAssetId, target: found.paths.instruction,
        ownershipIdentity: `${HARNESS}:instructions:managed-section`, fingerprint: fingerprint(found.instruction),
        sourceVersion: context.sourceVersion ?? 'unknown', projection: { renderer: 'pi-instructions' } });
    }

    const copyTree = verifyCopyTreeAssets({ assets, scope, scopeRoot, context, fsImpl });
    statuses.push(...copyTree.statuses);
    resources.push(...copyTree.resources);
    conflicts.push(...copyTree.conflicts);

    return { ok: conflicts.length === 0 && !statuses.some((s) => s.status === 'invalid' || s.status === 'conflict'), resources, statuses, conflicts };
  }

  return { nativePaths, discover, render, plan, apply, remove, verify };
}

const singleton = createPiAdapter();

module.exports = {
  HARNESS, nativePaths: singleton.nativePaths, discover: singleton.discover, render: singleton.render,
  plan: singleton.plan, apply: singleton.apply, remove: singleton.remove, verify: singleton.verify,
  managedInstruction: singleton.managedInstruction, strippedInstruction: singleton.strippedInstruction,
  createPiAdapter,
};
