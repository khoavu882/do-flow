'use strict';

// GitHub Copilot CLI adapter.
//
// Copilot has no single native root the way Claude's `.claude` is one — instructions, skills,
// agents, and MCP each live under a different path, split further by scope. Skills and agents are
// both trees materialised via the shared copy-tree engine in ../copy-tree.js; the single instruction
// pointer is a marker-merged section in a shared file, the same shape opencode/pi/gemini already use;
// MCP servers are entries of one JSON map that DoFlow owns one at a time through ../mcp-entries.js,
// never touching an entry it does not own.
//
// Native paths (see design.md §4's harness-native-surfaces table):
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

const { MARKER_START, MARKER_END } = require('../../helper/marker-merge');
const { planTree, applyTree, removeTree, verifyTree, copyTreeDestDir, ledgerFileResources, ledgerSiblingFingerprints, siblingReplacedNotices, fingerprint, sourceDirFor, resolveTransform } = require('../copy-tree');
const { readMcpFiles, planMcpEntries, verifyMcpEntries, ownedMcpIds, writeMcpEntries } = require('../mcp-entries');
const { declaredHarnessPaths, resolveHarnessPaths } = require('../../helper/harness-paths');

const HARNESS = 'copilot';
/** Message text naming the instruction file the declared paths.instruction surface installs.
 * Prose inside conflict messages and a config-payload literal — not an install destination. */
const INSTRUCTION_FILE = 'copilot-instructions.md';
const MCP_CONTAINER = 'mcpServers';
const MCP_RENDERER = 'copilot-mcp';
// Releases up to 1.18.0 recorded one row for the whole server map, which cannot say which entries
// DoFlow wrote; every plan releases it, and the entries are adopted per server instead.
const LEGACY_MCP_REGISTRATION = `${HARNESS}:mcp:registration`;

/**
 * Native path facts live in core/registry/harnesses.json under this harness's "paths" section and
 * resolve through the shared harness-paths resolver. Unlike Claude/Codex/Kiro, Copilot has no
 * single root: every capability resolves against its own conventional directory.
 *   - `skillsConfigDir` is the parent of `skills/` and is identical in shape across scopes
 *     (`.agents`, rooted at whichever `root` the scope resolves to) — Copilot's skills discovery
 *     list per https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills.
 *   - `agentsConfigDir` is genuinely asymmetric: `~/.copilot` globally, `.github` at project scope,
 *     because that is where Copilot's own custom-agents documentation places each.
 *   - `instruction` is project-only: Copilot documents no global instructions file, so no user-scope
 *     rule is declared and it resolves to null rather than inventing a path with no reader.
 * createCopilotAdapter({ declaredPaths }) is the injection point buildAdapterRegistry() uses;
 * module-level exports delegate to a default-configured instance so direct callers keep their
 * historical shape.
 */
function createCopilotAdapter({ declaredPaths = declaredHarnessPaths()[HARNESS] } = {}) {
  // Parity note: Copilot's historical nativePaths() derived even its user-scope root from scopeRoot
  // (the CLI passes $HOME there for -g installs), never from a separate homeDir argument — so the
  // resolver is fed no homeDir and "root" keeps resolving exactly as before.
  function nativePaths({ scope, scopeRoot } = {}) {
    return resolveHarnessPaths(declaredPaths, { scope, scopeRoot });
  }

  /** Discovery keeps the MCP files as plan read them (`mcpSnapshot`), which verify compares against,
   * and reports the servers DoFlow owns in Copilot's MCP config now (`mcpOwned`). */
  function discover({ scope, scopeRoot, mcp = [], mcpAdoptable = [], ledger, fsImpl = fs }) {
    const paths = nativePaths({ scope, scopeRoot });
    const instruction = paths.instruction && fsImpl.existsSync(paths.instruction) ? fsImpl.readFileSync(paths.instruction, 'utf8') : null;
    const entries = mcpEntriesInput({ paths, mcp, mcpAdoptable, ledger });
    const mcpSnapshot = readMcpFiles({ file: entries.file, ownRows: entries.ownRows, container: MCP_CONTAINER, fsImpl });
    return { paths, instruction, mcpSnapshot, mcpOwned: ownedMcpIds({ ...entries, files: mcpSnapshot }) };
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
    // The marker-managed instruction file is one specific asset: exclude tree-projected rule
    // assets (copilot-rule-instructions), whose `source` is a directory, not a file.
    const guidance = assets.find((asset) => asset.capability === 'instructions' && asset.renderer !== 'copilot-rule-instructions');
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

  /**
   * Rename `<name>.md` to `<name>.agent.md` on the way out. Copilot's custom-agent reference
   * (https://docs.github.com/en/copilot/reference/custom-agents-configuration) requires the
   * `.agent.md` extension, while `core/shared/agent-specs/*.md` — already `name`/`description`
   * YAML-frontmatter files, the same shape `.agent.md` expects — carries a plain `.md` extension.
   * This is the same class of shape mismatch Gemini/Antigravity's `dir-per-file:agent.md` layout in
   * copy-tree.js already solves for a directory-per-agent requirement; here the mismatch is only the
   * extension, so a flat rename is enough and no directory restructuring is needed. Declared as a
   * function (rather than a name registered in copy-tree.js's LAYOUTS) because it is specific to this
   * one adapter's asset, not a shape another harness also needs. Format logic, not a path fact —
   * it stays code rather than moving into the registry's path declarations.
   */
  function agentFileLayout(sourceRel) {
    const ext = path.extname(sourceRel);
    const base = sourceRel.slice(0, sourceRel.length - ext.length);
    return `${base}.agent${ext || '.md'}`;
  }

  function planTreeAssets({ assets, renderer, destRoot, scopeRoot, layout, context, ledger, removing, fsImpl = fs }) {
    const changes = [];
    const conflicts = [];
    const treeResults = [];
    const notices = [];
    for (const asset of treeAssetsFor(assets, renderer)) {
      const destDir = copyTreeDestDir(destRoot, asset);
      const sourceDir = sourceDirFor(asset, context, fsImpl, 'Copilot');
      const previousResources = ledgerFileResources(ledger?.resources, HARNESS, asset.id);
      const result = planTree({ sourceDir, destDir, previousResources, siblingFingerprints: ledgerSiblingFingerprints(ledger?.resources, HARNESS), operation: removing ? 'remove' : 'apply', fsImpl, layout: layout || asset.layout, transform: asset.transform, keepModified: !removing,
        // Forwarded so the CLI's --force reaches planTree's conflict check; omitting it let
        // planTree's own `force = false` default stand in silently. Gated on `!removing` for the
        // reason codex/index.js states in full: force heals drift on apply, but a hand-edited file
        // is never deleted on removal, forced or not.
        force: !removing && context?.force === true, });
      treeResults.push(result);
      conflicts.push(...result.conflicts.map((reason) => `${asset.id}: ${reason}`));
      // A hand-edited file at a path DoFlow no longer writes is the user's: it stays, only its
      // ownership row is released.
      notices.push(...result.kept.map((item) => `kept hand-edited ${path.relative(scopeRoot, item.target)}; DoFlow no longer manages it`));
      for (const change of result.changes) {
        changes.push({
          assetId: asset.id, target: change.target, source: change.source, operation: change.operation,
          ownershipIdentity: `doflow:${HARNESS}:copy-tree:${asset.id}:${change.relPath}`,
          kind: 'copy-tree-file', identity: change.relPath,
          afterFingerprint: change.fingerprint, fingerprint: change.fingerprint, sourceVersion: 'registry-v1',
          transformName: asset.transform || null,
          ...(change.kept ? { retained: true, retainedFor: [] } : {}),
          projection: { renderer: 'copy-tree' },
        });
      }
    }
    return { changes, conflicts, notices: [...siblingReplacedNotices(treeResults), ...notices] };
  }

  function applyCopyTreeAssets(changes, { fsImpl = fs } = {}) {
    let applied = 0;
    const grouped = new Map();
    for (const change of changes) {
      if (change.projection?.renderer !== 'copy-tree' || change.operation === 'remove') continue;
      const key = change.transformName || null;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push({ relPath: change.identity, target: change.target, source: change.source, operation: change.operation, fingerprint: change.fingerprint });
    }
    for (const [transformName, treeChanges] of grouped) {
      applied += applyTree({ changes: treeChanges, fsImpl, transform: resolveTransform(transformName) }).applied;
    }
    return applied;
  }

  function removeCopyTreeAssets(changes, { fsImpl = fs } = {}) {
    const treeChanges = changes.filter((change) => change.projection?.renderer === 'copy-tree' && change.operation === 'remove' && !change.retained)
      .map((change) => ({ relPath: change.identity, target: change.target, operation: 'remove', fingerprint: change.fingerprint }));
    return removeTree({ changes: treeChanges, fsImpl }).removed;
  }

  function verifyTreeAssets({ assets, renderer, destRoot, layout, context, fsImpl = fs }) {
    const statuses = [];
    const resources = [];
    const conflicts = [];
    for (const asset of treeAssetsFor(assets, renderer)) {
      const destDir = copyTreeDestDir(destRoot, asset);
      const sourceDir = sourceDirFor(asset, context, fsImpl, 'Copilot');
      const result = verifyTree({ sourceDir, destDir, fsImpl, layout: layout || asset.layout, transform: asset.transform });
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

  /** Copilot's own per-server shape. The file may be shared with another tool (Claude Code reads the
   * same project `.mcp.json`), so DoFlow only ever writes the entries it owns. */
  function buildServerEntry(server) {
    return {
      command: server.command,
      ...(server.args?.length ? { args: [...server.args] } : {}),
      ...(server.env && Object.keys(server.env).length ? { env: { ...server.env } } : {}),
    };
  }

  function ownershipIdentity(id) { return `doflow:${HARNESS}:mcp-server:${id}`; }

  /** Everything the shared entry-ownership rules (../mcp-entries.js) need from this adapter. */
  function mcpEntriesInput({ paths, mcp = [], mcpAdoptable = [], ledger, assets = [] }) {
    const rendered = (servers) => servers.map((server) => ({ id: server.id, entry: buildServerEntry(server) }));
    const rows = (ledger?.resources || []).filter((row) => row.kind === 'mcp-server');
    return {
      file: paths.mcp, selected: rendered(mcp), adoptable: rendered(mcpAdoptable),
      ownRows: rows.filter((row) => row.harness === HARNESS).map((row) => ({
        identity: row.identity, target: row.target, fingerprint: row.fingerprint ?? null, ownershipIdentity: row.ownershipIdentity, legacy: false,
      })),
      foreignRows: rows.filter((row) => row.harness !== HARNESS).map((row) => ({ harness: row.harness, identity: row.identity, target: row.target })),
      identityFor: ownershipIdentity, assetId: pseudoAssetId(assets), renderer: MCP_RENDERER, label: 'Copilot MCP',
    };
  }

  /** The release of the 1.18.0 whole-map row, under the asset id it was recorded with so the ledger
   * drops exactly that row. The file is not touched. */
  function legacyRegistrationReleases(ledger) {
    return (ledger?.resources || []).filter((row) => row.harness === HARNESS && row.ownershipIdentity === LEGACY_MCP_REGISTRATION)
      .map((row) => ({ assetId: row.assetId, target: row.target, operation: 'remove', release: true,
        ownershipIdentity: row.ownershipIdentity, harness: HARNESS, projection: { renderer: MCP_RENDERER } }));
  }

  /** Copilot's MCP entry changes have no asset of their own in core/registry/assets.json (they are a
   * registration side-effect of the selected MCP servers, not a projected asset), so they piggyback
   * on a real asset id already routed to this harness — the same "pseudo-component" technique
   * src/adapters/gemini/index.js#hooksAssetId and src/adapters/kiro/index.js#pseudoAssetId use. The
   * lifecycle layer validates every change's assetId against the harness's actual asset list, so an
   * invented id like a literal 'copilot.mcp' string is rejected as unknown. */
  function pseudoAssetId(assets) {
    return assets.find((asset) => asset.capability === 'instructions')?.id ?? assets[0]?.id;
  }

  // ---- shared adapter contract ----

  function plan({ scope, scopeRoot, assets = [], mcp = [], mcpAdoptable = [], discovery, context = {}, ledger, fsImpl = fs }) {
    const found = discovery || discover({ scope, scopeRoot, mcp, mcpAdoptable, ledger, fsImpl });
    const changes = [];
    const conflicts = [];
    const removing = context.operation === 'remove';

    const instructions = planInstructionsChange({ assets, found, context, removing, fsImpl });
    changes.push(...instructions.changes);
    conflicts.push(...instructions.conflicts);

    const skills = planTreeAssets({ assets, renderer: 'copy-tree', scopeRoot, destRoot: found.paths.skillsConfigDir, layout: null, context, ledger, removing, fsImpl });
    changes.push(...skills.changes);
    conflicts.push(...skills.conflicts);

    const agents = planTreeAssets({ assets, renderer: 'copilot-agents', scopeRoot, destRoot: found.paths.agentsConfigDir, layout: agentFileLayout, context, ledger, removing, fsImpl });
    changes.push(...agents.changes);
    conflicts.push(...agents.conflicts);

    const rules = planTreeAssets({ assets, renderer: 'copilot-rule-instructions', scopeRoot, destRoot: found.paths.ruleInstructionsConfigDir, context, ledger, removing, fsImpl });
    changes.push(...rules.changes);
    conflicts.push(...rules.conflicts);

    const mcpPlan = planMcpEntries({
      ...mcpEntriesInput({ paths: found.paths, mcp, mcpAdoptable, ledger, assets }), files: found.mcpSnapshot, removing,
    });
    changes.push(...legacyRegistrationReleases(ledger), ...mcpPlan.changes);
    conflicts.push(...mcpPlan.conflicts);

    return { changes, conflicts, notices: [...skills.notices, ...agents.notices, ...rules.notices, ...mcpPlan.notices], paths: found.paths };
  }

  function writeChange(change, fsImpl) {
    fsImpl.mkdirSync(path.dirname(change.target), { recursive: true });
    fsImpl.writeFileSync(change.target, change.content, 'utf8');
  }

  function apply({ changes = [], fsImpl = fs }) {
    let applied = 0;
    for (const change of changes) {
      if (change.operation === 'remove') continue;
      if (change.projection?.renderer === 'copy-tree' || change.kind === 'mcp-server') continue;
      writeChange(change, fsImpl);
      applied += 1;
    }
    applied += writeMcpEntries(changes, { container: MCP_CONTAINER, fsImpl });
    applied += applyCopyTreeAssets(changes, { fsImpl });
    // An update that drops a copy-tree asset carries its rows as removals inside the apply batch;
    // the lifecycle calls remove() only for `doflow remove`.
    removeCopyTreeAssets(changes, { fsImpl });
    return { applied };
  }

  function remove({ changes = [], fsImpl = fs }) {
    let removed = 0;
    for (const change of changes) {
      if (change.operation !== 'remove') continue;
      if (change.projection?.renderer === 'copy-tree' || change.kind === 'mcp-server') continue;
      if (typeof change.content !== 'string') continue;
      writeChange(change, fsImpl);
      removed += 1;
    }
    removed += writeMcpEntries(changes, { container: MCP_CONTAINER, fsImpl });
    removed += removeCopyTreeAssets(changes, { fsImpl });
    return { removed };
  }

  function verify({ scope, scopeRoot, assets = [], mcp = [], mcpAdoptable = [], discovery, ledger, operation, context = {}, fsImpl = fs }) {
    const found = discover({ scope, scopeRoot, mcp, mcpAdoptable, ledger, fsImpl });
    const statuses = [];
    const resources = [];
    const conflicts = [];

    if (found.paths.instruction) {
      // The marker-managed instruction file is one specific asset: exclude tree-projected rule
      // assets (copilot-rule-instructions), whose `source` is a directory, not a file.
      const guidance = assets.find((asset) => asset.capability === 'instructions' && asset.renderer !== 'copilot-rule-instructions');
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

    const rules = verifyTreeAssets({ assets, renderer: 'copilot-rule-instructions', destRoot: found.paths.ruleInstructionsConfigDir, context, fsImpl });
    resources.push(...rules.resources);
    statuses.push(...rules.statuses);
    conflicts.push(...rules.conflicts);

    const mcpResult = verifyMcpEntries({
      ...mcpEntriesInput({ paths: found.paths, mcp, mcpAdoptable, ledger, assets }), files: found.mcpSnapshot,
      snapshot: discovery?.mcpSnapshot ?? found.mcpSnapshot, removing: (operation ?? context.operation) === 'remove',
      harness: HARNESS, sourceVersion: context.sourceVersion ?? 'unknown',
    });
    resources.push(...mcpResult.resources);
    statuses.push(...mcpResult.statuses);
    conflicts.push(...mcpResult.conflicts);

    return { ok: conflicts.length === 0 && !statuses.some((s) => s.status === 'invalid' || s.status === 'conflict'), resources, statuses, conflicts };
  }

  return { nativePaths, discover, render, plan, apply, remove, verify,
    managedInstruction, strippedInstruction,
    agentFileLayout };
}

function treeAssetsFor(assets, renderer) {
  return (assets || []).filter((asset) => asset?.renderer === renderer);
}

const singleton = createCopilotAdapter();

module.exports = {
  HARNESS, MARKER_START, MARKER_END,
  nativePaths: singleton.nativePaths, discover: singleton.discover, render: singleton.render,
  plan: singleton.plan, apply: singleton.apply, remove: singleton.remove, verify: singleton.verify,
  managedInstruction: singleton.managedInstruction, strippedInstruction: singleton.strippedInstruction,
  agentFileLayout: singleton.agentFileLayout,
  createCopilotAdapter,
};
