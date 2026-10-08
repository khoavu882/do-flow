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
const { planTree, applyTree, removeTree, verifyTree, copyTreeAssets, copyTreeDestDir, ledgerFileResources, ledgerSiblingFingerprints, siblingReplacedNotices, sourceDirFor } = require('../copy-tree');
const { readMcpFiles, planMcpEntries, verifyMcpEntries, ownedMcpIds, writeMcpEntries } = require('../mcp-entries');
const { declaredHarnessPaths, resolveHarnessPaths } = require('../../helper/harness-paths');

const HARNESS = 'kiro';
const MCP_CONTAINER = 'mcpServers';
const MCP_RENDERER = 'kiro-mcp';
// Releases up to 1.18.0 recorded one `kiro:mcp:<id>` row per server (and never a row for the old
// `kiro:mcp:registration` change); they are read as owned rows until a run replaces them.
const LEGACY_MCP_PREFIX = `${HARNESS}:mcp:`;
const LEGACY_MCP_REGISTRATION = `${HARNESS}:mcp:registration`;

/**
 * Native path facts live in core/registry/harnesses.json under this harness's "paths" section and
 * resolve through the shared harness-paths resolver; `.kiro` (project) / `~/.kiro` (global) is the
 * whole native root and every other path here is a fixed subpath under it.
 * createKiroAdapter({ declaredPaths }) is the injection point buildAdapterRegistry() uses;
 * module-level exports delegate to a default-configured instance so direct callers keep their
 * historical shape.
 */
function createKiroAdapter({ declaredPaths = declaredHarnessPaths()[HARNESS] } = {}) {
  // Parity note: Kiro's historical nativePaths() derived even its user-scope root from scopeRoot
  // (the CLI passes $HOME there for -g installs), never from a separate homeDir argument — so the
  // resolver is fed no homeDir and "root" keeps resolving exactly as before.
  function nativePaths({ scope, scopeRoot } = {}) {
    return resolveHarnessPaths(declaredPaths, { scope, scopeRoot });
  }

  /** Discovery keeps the MCP files as plan read them (`mcpSnapshot`), which verify compares against,
   * and reports the servers DoFlow owns in Kiro's mcp.json now (`mcpOwned`). */
  function discover({ scope, scopeRoot, mcp = [], mcpAdoptable = [], ledger, fsImpl = fs }) {
    const paths = nativePaths({ scope, scopeRoot });
    const entries = mcpEntriesInput({ paths, mcp, mcpAdoptable, ledger });
    const mcpSnapshot = readMcpFiles({ file: entries.file, ownRows: entries.ownRows, container: MCP_CONTAINER, fsImpl });
    return { paths, mcpSnapshot, mcpOwned: ownedMcpIds({ ...entries, files: mcpSnapshot }) };
  }

  /**
   * Kiro has no single-file, marker-managed instruction surface for this adapter to render into —
   * the guidance tree is projected file-for-file by the copy-tree engine below, once as steering
   * (guidance.context-layer) and once into the shared `.doflow/guidance` (kiro.guidance-tree). Every
   * asset routed to 'kiro' in core/registry/assets.json uses `renderer: copy-tree` or
   * `kiro-agents`, so nothing reaches this function. It is kept as a pure passthrough only to
   * satisfy the six-function adapter contract every harness must implement identically.
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

  function planCopyTreeAssets({ assets, scope, scopeRoot, context, ledger, removing, fsImpl = fs }) {
    const paths = nativePaths({ scope, scopeRoot });
    const changes = [];
    const conflicts = [];
    const treeResults = [];
    const notices = [];
    for (const asset of kiroTreeAssets(assets)) {
      const destDir = copyTreeDestDir(paths.configDir, asset);
      const sourceDir = sourceDirFor(asset, context, fsImpl, 'Kiro');
      const previousResources = ledgerFileResources(ledger?.resources, HARNESS, asset.id);
      const result = planTree({ sourceDir, destDir, previousResources, siblingFingerprints: ledgerSiblingFingerprints(ledger?.resources, HARNESS), operation: removing ? 'remove' : 'apply', fsImpl, layout: asset.layout, keepModified: !removing,
        // Forwarded so the CLI's --force reaches planTree's conflict check; omitting it let
        // planTree's own `force = false` default stand in silently. Gated on `!removing` for the
        // reason codex/index.js states in full: force heals drift on apply, but a hand-edited file
        // is never deleted on removal, forced or not.
        force: !removing && context?.force === true, });
      treeResults.push(result);
      conflicts.push(...result.conflicts.map((reason) => `${asset.id}: ${reason}`));
      // A hand-edited file at a path DoFlow no longer writes is the user's: it stays, only its
      // ownership row is released.
      notices.push(...result.kept.map((item) => `kept hand-edited ${path.relative(paths.root, item.target)}; DoFlow no longer manages it`));
      for (const change of result.changes) {
        changes.push({
          assetId: asset.id, target: change.target, source: change.source, operation: change.operation,
          ownershipIdentity: `doflow:${HARNESS}:copy-tree:${asset.id}:${change.relPath}`,
          kind: 'copy-tree-file', identity: change.relPath,
          afterFingerprint: change.fingerprint, fingerprint: change.fingerprint, sourceVersion: 'registry-v1',
          ...(change.kept ? { retained: true, retainedFor: [] } : {}),
          projection: { renderer: asset.renderer },
        });
      }
    }
    return { changes, conflicts, notices: [...siblingReplacedNotices(treeResults), ...notices] };
  }

  function applyCopyTreeAssets(changes, { fsImpl = fs } = {}) {
    const treeChanges = changes.filter((change) => change.kind === 'copy-tree-file' && change.operation !== 'remove')
      .map((change) => ({ relPath: change.identity, target: change.target, source: change.source, operation: change.operation, fingerprint: change.fingerprint }));
    return applyTree({ changes: treeChanges, fsImpl }).applied;
  }

  function removeCopyTreeAssets(changes, { fsImpl = fs } = {}) {
    const treeChanges = changes.filter((change) => change.kind === 'copy-tree-file' && change.operation === 'remove' && !change.retained)
      .map((change) => ({ relPath: change.identity, target: change.target, operation: 'remove', fingerprint: change.fingerprint }));
    return removeTree({ changes: treeChanges, fsImpl }).removed;
  }

  function verifyCopyTreeAssets({ assets, scope, scopeRoot, context, fsImpl = fs }) {
    const paths = nativePaths({ scope, scopeRoot });
    const statuses = [];
    const resources = [];
    const conflicts = [];
    for (const asset of kiroTreeAssets(assets)) {
      const destDir = copyTreeDestDir(paths.configDir, asset);
      const sourceDir = sourceDirFor(asset, context, fsImpl, 'Kiro');
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
   * registry (core/registry/mcp.json) only ever declares stdio servers today, so only the fields it
   * actually carries are emitted — this never invents a field the registry doesn't supply.
   */
  function buildServerEntry(server) {
    if (server.url) return { url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
    return { command: server.command, ...(server.args?.length ? { args: server.args } : {}) };
  }

  function ownershipIdentity(id) { return `doflow:${HARNESS}:mcp-server:${id}`; }

  function mcpOwnRows(ledger) {
    return (ledger?.resources || []).filter((row) => row.harness === HARNESS).flatMap((row) => {
      if (row.kind === 'mcp-server') {
        return [{ identity: row.identity, target: row.target, fingerprint: row.fingerprint ?? null, ownershipIdentity: row.ownershipIdentity, legacy: false }];
      }
      const legacyIdentity = row.ownershipIdentity;
      if (typeof legacyIdentity !== 'string' || !legacyIdentity.startsWith(LEGACY_MCP_PREFIX) || legacyIdentity === LEGACY_MCP_REGISTRATION) return [];
      return [{ identity: legacyIdentity.slice(LEGACY_MCP_PREFIX.length), target: row.target, fingerprint: row.fingerprint ?? null, ownershipIdentity: legacyIdentity, legacy: true }];
    });
  }

  /** Everything the shared entry-ownership rules (../mcp-entries.js) need from this adapter. */
  function mcpEntriesInput({ paths, mcp = [], mcpAdoptable = [], ledger, assets = [] }) {
    const rendered = (servers) => servers.map((server) => ({ id: server.id, entry: buildServerEntry(server) }));
    return {
      file: paths.mcp, selected: rendered(mcp), adoptable: rendered(mcpAdoptable),
      ownRows: mcpOwnRows(ledger),
      foreignRows: (ledger?.resources || []).filter((row) => row.kind === 'mcp-server' && row.harness !== HARNESS)
        .map((row) => ({ harness: row.harness, identity: row.identity, target: row.target })),
      identityFor: ownershipIdentity, assetId: pseudoAssetId(assets), renderer: MCP_RENDERER, label: 'Kiro MCP',
    };
  }

  /** Kiro has no hooks or mcp asset of its own in core/registry/assets.json (mcp servers come from
   * core/registry/mcp.json, not an asset), so an MCP entry change piggybacks on an asset id
   * this harness actually receives — the same "pseudo-component" technique
   * src/adapters/gemini/index.js#hooksAssetId already uses for its own settings-only component. */
  function pseudoAssetId(assets) {
    return assets.find((asset) => asset.id === 'guidance.context-layer')?.id ?? assets[0]?.id;
  }

  // ---- shared adapter contract ----

  /**
   * `.kiro/hooks/` is now a real, populated native surface: `kiro.hooks-scripts`
   * (core/registry/assets.json) is a copy-tree asset like skills/agents, so `kiroTreeAssets()` above
   * already plans/applies/removes it alongside them. This function only reports the
   * declarative capability surface — same unconditional shape `plan()` already uses for
   * instructions/skills/agents — not whether that asset happens to be present in a given call's
   * `assets` array; per-file installed status for the hooks tree itself is reported through
   * `copyTree.statuses`/`copyTree.resources`, exactly like it is for skills and agents.
   */
  function hooksSurface(paths) {
    return { status: 'supported', target: paths.hooks };
  }

  function plan({ scope, scopeRoot, assets = [], mcp = [], mcpAdoptable = [], discovery, context = {}, ledger, fsImpl = fs }) {
    const found = discovery || discover({ scope, scopeRoot, mcp, mcpAdoptable, ledger, fsImpl });
    const changes = [];
    const conflicts = [];
    const removing = context.operation === 'remove';

    const copyTree = planCopyTreeAssets({ assets, scope, scopeRoot, context, ledger, removing, fsImpl });
    changes.push(...copyTree.changes);
    conflicts.push(...copyTree.conflicts);

    const mcpPlan = planMcpEntries({
      ...mcpEntriesInput({ paths: found.paths, mcp, mcpAdoptable, ledger, assets }), files: found.mcpSnapshot, removing,
    });
    changes.push(...mcpPlan.changes);
    conflicts.push(...mcpPlan.conflicts);

    return {
      changes, conflicts, prerequisites: [], notices: [...copyTree.notices, ...mcpPlan.notices],
      surfaces: {
        instructions: { status: 'supported', target: found.paths.steering },
        skills: { status: 'supported', target: found.paths.skills },
        agents: { status: 'supported', target: found.paths.agents },
        hooks: hooksSurface(found.paths),
        mcp: { status: found.mcpSnapshot[found.paths.mcp].ok ? 'supported' : 'blocked', target: found.paths.mcp, selected: mcp.map((item) => item.id) },
      },
    };
  }

  function apply({ changes = [], fsImpl = fs }) {
    writeMcpEntries(changes, { container: MCP_CONTAINER, fsImpl });
    applyCopyTreeAssets(changes, { fsImpl });
    // An update that no longer ships a copy-tree file carries its rows as removals inside the
    // apply batch; the lifecycle calls remove() only for `doflow remove`.
    removeCopyTreeAssets(changes, { fsImpl });
  }

  function remove({ changes = [], fsImpl = fs }) {
    writeMcpEntries(changes, { container: MCP_CONTAINER, fsImpl });
    removeCopyTreeAssets(changes, { fsImpl });
  }

  function verify({ scope, scopeRoot, assets = [], mcp = [], mcpAdoptable = [], discovery, ledger, operation, context = {}, fsImpl = fs }) {
    const paths = nativePaths({ scope, scopeRoot });
    const resources = [];
    const conflicts = [];

    const copyTree = verifyCopyTreeAssets({ assets, scope, scopeRoot, context, fsImpl });
    resources.push(...copyTree.resources);
    conflicts.push(...copyTree.conflicts);

    const entries = mcpEntriesInput({ paths, mcp, mcpAdoptable, ledger, assets });
    const files = readMcpFiles({ file: entries.file, ownRows: entries.ownRows, container: MCP_CONTAINER, fsImpl });
    const mcpResult = verifyMcpEntries({
      ...entries, files, snapshot: discovery?.mcpSnapshot ?? files,
      removing: (operation ?? context.operation) === 'remove', harness: HARNESS, sourceVersion: context.sourceVersion ?? 'unknown',
    });
    resources.push(...mcpResult.resources);
    conflicts.push(...mcpResult.conflicts);

    return {
      ok: conflicts.length === 0,
      resources,
      statuses: { copyTree: copyTree.statuses, mcp: mcpResult.statuses, hooks: hooksSurface(paths) },
      conflicts,
    };
  }

  return { nativePaths, discover, render, plan, apply, remove, verify, buildServerEntry };
}

const singleton = createKiroAdapter();

module.exports = {
  nativePaths: singleton.nativePaths, discover: singleton.discover, render: singleton.render,
  plan: singleton.plan, apply: singleton.apply, remove: singleton.remove, verify: singleton.verify,
  buildServerEntry: singleton.buildServerEntry,
  createKiroAdapter,
};
