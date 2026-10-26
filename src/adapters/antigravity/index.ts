'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// Antigravity CLI adapter (#8). Scope follows the surfaces verified against Antigravity's own
// docs (antigravity.google/docs/cli/*):
//   instructions — marker-managed section in project AGENTS.md and global ~/.gemini/GEMINI.md (left
//     alone while another live harness declares it); a retired harness's span there is taken over in
//     one write (row 127 IC-007), a person-edited file kept until --force. See instructionTarget.
//   rules        — the core set (DOFLOW_CORE.md and the files it imports), flat, in project .agents/rules
//     only; the full guidance tree stays in .doflow/guidance.
//   skills       — folder-form copy-tree into project .agents/skills or user ~/.gemini/config/skills.
//   agents       — copy-tree into project .agents/agents or user ~/.gemini/config/agents.
//   mcp          — entries of the mcpServers object in .agents/mcp_config.json (workspace) or
//     ~/.gemini/config/mcp_config.json (user), owned one at a time through ../mcp-entries.ts;
//     remote url/httpUrl projects to serverUrl.
//   hooks        — native-payload shims (bash + jq translating Antigravity's stdin/stdout
//     {decision} contract): the pre-implementation gate on PreToolUse and the stop check on Stop,
//     each registered under its own named hooks.json group.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MARKER_START, MARKER_END, removeMarkedSection } = require('../../helper/marker-merge.ts');
const { planTree, applyTree, removeTree, verifyTree, resolveTransform, copyTreeAssets, ledgerFileResources, ledgerSiblingFingerprints, siblingReplacedNotices, fingerprint, readJson, sourceDirFor } = require('../copy-tree.ts');
const { declaredHarnessPaths, resolveHarnessPaths } = require('../../helper/harness-paths.ts');
const { renderGuidancePointer } = require('../guidance-pointer.ts');
const { readMcpFiles, planMcpEntries, verifyMcpEntries, ownedMcpIds, writeMcpEntries } = require('../mcp-entries.ts');

const HARNESS = 'antigravity';
const MCP_CONTAINER = 'mcpServers';
const MCP_RENDERER = 'antigravity-mcp';

/** copy-tree's readJson distinguishes absent/unparseable via an {exists,value,error} envelope;
 * every caller here wants the plain object or {}. */
function readJsonObject(file: any, { fsImpl = fs }: any = {}) {
  const result = readJson(file, { fsImpl });
  if (!result || !result.exists || result.error) return {};
  return result.value ?? {};
}
// Precedent: Codex rides its pointer asset's id for every managed row (instructions-section and
// mcp-server alike). The antigravity projection shares that same pointer asset, so its rows do too.
const POINTER_ASSET_ID = 'guidance.codex-pointer';
const HOOKS_ASSET_ID = 'hooks.antigravity';
// One owned hooks.json group per DoFlow policy (the Kiro doflow.json precedent): the two gates
// stay independently removable/enablable, and a user's own groups are never touched. The Stop
// registration is matcher-free — Antigravity documents handlers sitting directly under the event
// key for PreInvocation/PostInvocation/Stop ("the matcher is ignored").
const HOOK_SCRIPTS = ['pre-implementation-gate.sh', 'stop-check.sh'];
const HOOKS_GROUP = 'doflow-pre-implementation-gate';
const STOP_HOOKS_GROUP = 'doflow-stop-check';
// Antigravity's documented file-mutation tools (docs/hooks, Supported Tools) — the exact set the
// gate is meaningful for.
const GATE_MATCHER = 'write_to_file|replace_file_content|multi_replace_file_content';

/** Build DoFlow's hooks.json groups from the projected scripts' on-disk locations. Absolute command
 * path: the docs' own examples use relative ./scripts paths whose resolution base is not stated,
 * and an absolute path is unambiguous for a per-workspace install. */
function hookGroups({ gateCommand, stopCommand }: any) {
  return {
    [HOOKS_GROUP]: { PreToolUse: [{ matcher: GATE_MATCHER, hooks: [{ type: 'command', command: gateCommand }] }] },
    [STOP_HOOKS_GROUP]: { Stop: [{ type: 'command', command: stopCommand }] },
  };
}

function hookScriptTarget(identity: any, paths: any) {
  return identity === 'pre-implementation-gate.sh' ? paths.hookScript : paths.stopHookScript;
}

function planHooks({ paths, scope, neutralResources, removing, repoRoot, fsImpl = fs }: any) {
  const changes: any[] = [];
  const conflicts: any[] = [];
  if (scope !== 'project') {
    // The shims resolve the workspace via git/transcriptPath; a user-scope hooks.json would fire
    // against every project including non-git ones. Project-only until a documented user story exists.
    return { changes, conflicts };
  }
  const target = paths.hooksJson;
  const scriptSource = sourceDirFor({ source: 'core/harnesses/antigravity/hooks' }, { repoRoot }, fsImpl, HARNESS);

  const previousHookRows = (neutralResources || []).filter((r: any) => r.harness === HARNESS && r.assetId === HOOKS_ASSET_ID && r.kind === 'hooks-json');
  const previousScriptRows = (neutralResources || []).filter((r: any) => r.harness === HARNESS && r.assetId === HOOKS_ASSET_ID && r.kind === 'copy-tree-file');
  const docRow = previousHookRows.find((r: any) => r.target === target);

  if (removing) {
    if (docRow || fsImpl.existsSync(target)) {
      changes.push({ assetId: HOOKS_ASSET_ID, target, operation: 'remove',
        ownershipIdentity: `${HARNESS}:hooks:registration`, kind: 'hooks-json',
        fingerprint: fingerprint('{}'), managed: null,
        projection: { renderer: 'antigravity-hooks' } });
    }
    for (const identity of HOOK_SCRIPTS) {
      const scriptTarget = hookScriptTarget(identity, paths);
      const scriptRow = previousScriptRows.find((r: any) => r.identity === identity);
      if (scriptRow && fsImpl.existsSync(scriptTarget)) {
        const current = sha256File(fsImpl, scriptTarget);
        if (current === scriptRow.fingerprint) {
          changes.push({ assetId: HOOKS_ASSET_ID, target: scriptTarget, source: path.join(scriptSource, identity),
            operation: 'remove', ownershipIdentity: `${HARNESS}:copy-tree:${HOOKS_ASSET_ID}:${identity}`,
            kind: 'copy-tree-file', identity,
            fingerprint: current, projection: { renderer: 'antigravity-hooks' } });
        }
      }
    }
    return { changes, conflicts };
  }

  // Scripts first: the JSON references them, so apply order must never leave a dangling reference.
  for (const identity of HOOK_SCRIPTS) {
    const scriptTarget = hookScriptTarget(identity, paths);
    const scriptText = fsImpl.readFileSync(path.join(scriptSource, identity), 'utf8');
    const scriptFp = fingerprint(scriptText);
    if (!fsImpl.existsSync(scriptTarget) || sha256File(fsImpl, scriptTarget) !== scriptFp) {
      changes.push({ assetId: HOOKS_ASSET_ID, target: scriptTarget, source: path.join(scriptSource, identity),
        operation: fsImpl.existsSync(scriptTarget) ? 'update' : 'create',
        ownershipIdentity: `${HARNESS}:copy-tree:${HOOKS_ASSET_ID}:${identity}`,
        kind: 'copy-tree-file', identity,
        afterFingerprint: scriptFp, fingerprint: scriptFp,
        _text: scriptText, projection: { renderer: 'antigravity-hooks' } });
    }
  }

  const currentDoc = readJsonObject(target, { fsImpl }) ?? {};
  const next = { ...currentDoc, ...hookGroups({ gateCommand: paths.hookScript, stopCommand: paths.stopHookScript }) };
  if (JSON.stringify(next) !== JSON.stringify(currentDoc)) {
    changes.push({ assetId: HOOKS_ASSET_ID, target, operation: fsImpl.existsSync(target) ? 'update' : 'create',
      content: `${JSON.stringify(next, null, 2)}\n`,
      ownershipIdentity: `${HARNESS}:hooks:registration`, kind: 'hooks-json',
      fingerprint: fingerprint(next), harness: HARNESS,
      projection: { renderer: 'antigravity-hooks' } });
  }
  return { changes, conflicts };
}

function sha256File(fsImpl: any, file: any) {
  return require('node:crypto').createHash('sha256').update(fsImpl.readFileSync(file)).digest('hex');
}

/** Native paths per scope, resolved from the declaration in core/registry/harnesses.json
 * ("paths"): project customization lives at <root>/.agents, global config at ~/.gemini/config
 * (the shared-customization root); instructions are AGENTS.md in the project and ~/.gemini/GEMINI.md
 * globally; the hook surfaces are project-only, so no user rule is declared and they resolve to null. */
function resolveNativePaths(declaredPaths: any, { scope, scopeRoot, homeDir }: any = {}) {
  if (scope !== 'project' && scope !== 'global') throw new Error(`Unsupported Antigravity scope '${scope}'`);
  const resolved = resolveHarnessPaths(declaredPaths, { scope, scopeRoot, homeDir });
  return {
    scope,
    root: resolved.root,
    configDir: resolved.configDir,
    instruction: resolved.instruction,
    mcpFile: resolved.mcpFile,
    skillsDir: resolved.skillsDir,
    agentsDir: resolved.agentsDir,
    // Declared project-scope hook surfaces (null at user scope — see the paths declaration).
    hooksJson: resolved.hooksJson,
    hookScript: resolved.hookScript,
    stopHookScript: resolved.stopHookScript,
  };
}

const DEFAULT_DECLARED_PATHS = declaredHarnessPaths()[HARNESS];

function nativePaths(options = {}) {
  return resolveNativePaths(DEFAULT_DECLARED_PATHS, options);
}

/**
 * createAntigravityAdapter({ declaredPaths }) is the injection point buildAdapterRegistry() uses:
 * it rebinds the contract methods to the given declaration. Unlike the smaller adapters this one
 * keeps its planners module-level (they already thread resolved `paths` explicitly), so injection
 * flows through an optional `impl.nativePaths` seam instead of a full closure rewrite.
 */
function createAntigravityAdapter({ declaredPaths = DEFAULT_DECLARED_PATHS }: any = {}) {
  const nativePathsFor = (options: any) => resolveNativePaths(declaredPaths, options);
  return {
    nativePaths: nativePathsFor,
    discover: (options: any, impl = {}) => discover(options, { ...impl, nativePaths: nativePathsFor }),
    render,
    plan: (options: any, impl = {}) => plan(options, { ...impl, nativePaths: nativePathsFor }),
    apply,
    remove,
    verify: (options: any, impl = {}) => verify(options, { ...impl, nativePaths: nativePathsFor }),
    planHookDoors: (options: any, impl = {}) => planHookDoors(options, { ...impl, nativePaths: nativePathsFor }),
    verifyHookDoors: (options: any, impl = {}) => verifyHookDoors(options, { ...impl, nativePaths: nativePathsFor }),
  };
}

const singleton = createAntigravityAdapter();

/** The scope's paths exactly as plan() and verify() resolve them, so discovery reads the same files. */
function scopePaths(options: any, resolvePaths = singleton.nativePaths) {
  return resolvePaths({ ...options, scope: options.scope ?? 'project', homeDir: options.context?.homeDir });
}

function ledgerResources(options: any) {
  return options.ledger?.resources ?? options.managedResources ?? [];
}

/** Discovery keeps the MCP files as plan read them (`mcpSnapshot`), which verify compares against,
 * and reports the servers DoFlow owns in mcp_config.json now (`mcpOwned`). */
function discover(options: any, { fsImpl = fs, nativePaths: resolvePaths = singleton.nativePaths }: any = {}) {
  const paths = scopePaths(options, resolvePaths);
  const instruction = paths.instruction && fsImpl.existsSync(paths.instruction)
    ? fsImpl.readFileSync(paths.instruction, 'utf8') : null;
  const entries = mcpEntriesInput({ paths, mcp: options.mcp, mcpAdoptable: options.mcpAdoptable, resources: ledgerResources(options) });
  const mcpSnapshot = readMcpFiles({ file: entries.file, ownRows: entries.ownRows, container: MCP_CONTAINER, fsImpl });
  const read = mcpSnapshot[entries.file];
  // `null` while the file is absent, unreadable or has no server map; every name in it otherwise, whoever wrote it.
  const mcpConfigured = read?.ok && read.servers ? Object.keys(read.servers).sort() : null;
  return { paths, instruction, mcpSnapshot, mcpOwned: ownedMcpIds({ ...entries, files: mcpSnapshot }), mcpConfigured };
}

function render({ content = '' }: any = {}) {
  return `${MARKER_START}\n${String(content).trimEnd()}\n${MARKER_END}\n`;
}

const INSTRUCTIONS_IDENTITY = `doflow:${HARNESS}:instructions:managed-section`;
/** The short start marker the retired harness wrote into ~/.gemini/GEMINI.md (row 127). It is read
 * only in a file this adapter is taking over, never written: the span it opens is replaced with ours. */
const PREDECESSOR_MARKER_START = '<!-- doflow:start -->';

/** The file's content with `rendered` as its DoFlow span: created, appended to a file with none, or
 * replacing the span in place. `predecessor` also accepts the retired harness's start marker, for a
 * file being taken over. `name` is the file's name in the conflict. */
function managedInstruction(existing: any, rendered: any, { name = 'AGENTS.md', predecessor = false }: any = {}) {
  if (existing === null) return { ok: true, operation: 'create', content: rendered };
  let start = existing.indexOf(MARKER_START);
  if (start === -1 && predecessor) start = existing.indexOf(PREDECESSOR_MARKER_START);
  const end = existing.indexOf(MARKER_END);
  if (start === -1 && end === -1) {
    const separator = existing === '' || existing.endsWith('\n') ? '\n' : '\n\n';
    const content = `${existing}${separator}${rendered}`;
    return { ok: true, operation: 'merge', content };
  }
  if (start === -1 || end === -1 || end < start) return { ok: false, conflict: `${name} has malformed DoFlow managed-section markers` };
  const content = `${existing.slice(0, start)}${rendered}${existing.slice(end + MARKER_END.length).replace(/^\n?/, '')}`;
  return { ok: true, operation: content === existing ? 'none' : 'merge', content };
}

function strippedInstruction(existing: any) {
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
 *   plain names (bin, agents)       → inside the scope's config dir (.agents | ~/.gemini/config) */
function treeDestFor(asset: any, paths: any, scope: any) {
  const nativeDir = asset.nativeDir;
  if (!nativeDir) return null;
  if (asset.id === 'skills.doflow') {
    return paths.skillsDir || path.join(paths.configDir, nativeDir);
  }
  if (asset.id === 'rules.antigravity' || asset.id === 'workflows.antigravity') {
    // Workspace-scope surfaces under .agents/: Antigravity documents workspace rules
    // (.agents/rules) and workflows (.agents/workflows) with no user-scope home — a global
    // install deliberately projects neither rather than guessing one. These nativeDirs are
    // config-relative.
    return scope === 'project' ? path.join(paths.configDir, nativeDir) : null;
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

function planTrees({ assets, paths, scope, neutralResources, removing, repoRoot, force = false, fsImpl = fs }: any) {
  const changes = [];
  const conflicts = [];
  const treeResults = [];
  const notices = [];
  const targets = [];
  for (const asset of copyTreeAssets(assets)) {
    const destDir = treeDestFor(asset, paths, scope);
    if (!destDir) continue;
    targets.push({ asset, destDir });
  }
  for (const { asset, destDir } of targets) {
    const sourceDir = sourceDirFor(asset, { repoRoot }, fsImpl, HARNESS);
    const previousResources = ledgerFileResources(neutralResources, HARNESS, asset.id);
    const result = planTree({ sourceDir, destDir, previousResources, siblingFingerprints: ledgerSiblingFingerprints(neutralResources, HARNESS), operation: removing ? 'remove' : 'apply', fsImpl, layout: asset.layout, transform: asset.transform, select: asset.select, keepModified: !removing,
      // Forwarded so the CLI's --force reaches planTree's conflict check; omitting it let
      // planTree's own `force = false` default stand in silently. Gated on `!removing` for the
      // reason codex/index.ts states in full: force heals drift on apply, but a hand-edited file
      // is never deleted on removal, forced or not. This adapter needed `force` threaded through
      // planTrees as well, since its signature did not carry the context the others already had.
      force: !removing && force === true });
    treeResults.push(result);
    conflicts.push(...result.conflicts.map((reason: any) => `${asset.id}: ${reason}`));
    // A hand-edited file at a path DoFlow no longer writes is the user's: it stays, only its
    // ownership row is released.
    notices.push(...result.kept.map((item: any) => `kept hand-edited ${path.relative(paths.root, item.target)}; DoFlow no longer manages it`));
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
  return { changes, conflicts, targets, notices: [...siblingReplacedNotices(treeResults), ...notices] };
}

function runTreeChanges(changes: any, mode: any) {
  // Route by what each change IS, not by which verb invoked us: remove() delegates here with a
  // plan full of operation:'remove' changes, and applyTree deliberately skips those — so routing
  // everything through one engine call silently deleted nothing (verification then correctly
  // refused to journal the no-op). Writes go to applyTree, removals to removeTree, always.
  void mode;
  const treeChanges = changes
    .filter((c: any) => c.projection?.renderer === 'copy-tree' || c.kind === 'copy-tree-file')
    .map((c: any) => ({ relPath: c.identity ?? c.relPath, target: c.target,
      source: c._text ? undefined : c.source, operation: c.operation,
      fingerprint: c.fingerprint, pruneGuard: c.pruneGuard, transformName: c.transformName || null,
      ...(c._text ? { _text: c._text } : {}) }));
  // Content-managed tree files (hook scripts): write rendered text with +x, not a byte copy.
  for (const t of treeChanges) {
    if (t._text === undefined) continue;
    if (t.operation === 'remove') { fs.rmSync(t.target, { force: true }); continue; }
    fs.mkdirSync(path.dirname(t.target), { recursive: true });
    fs.writeFileSync(t.target, t._text);
    fs.chmodSync(t.target, 0o755);
  }
  return {
    applied: 0, removed: 0,
    ...(function (): any {
      const plain = treeChanges.filter((t: any) => t._text === undefined);
      const writes = plain.filter((c: any) => c.operation !== 'remove');
      const removals = plain.filter((c: any) => c.operation === 'remove');
      // A projection that declares a transform (the rules' always_on header) is re-derived from the
      // source at write time, so each change is applied under its own transform.
      const byTransform = new Map<string | null, any[]>();
      for (const change of writes) byTransform.set(change.transformName, [...(byTransform.get(change.transformName) || []), change]);
      let applied = 0;
      for (const [transformName, group] of byTransform) {
        applied += applyTree({ changes: group, transform: transformName ? resolveTransform(transformName) : undefined }).applied;
      }
      const removed = removals.length ? removeTree({ changes: removals }).removed : 0;
      return { applied, removed };
    })(),
  };
}

// ---- instructions component ----

/** The instruction file this run manages, or null: project AGENTS.md as ever; the global GEMINI.md
 * only when the pointer asset is selected and no other live harness in `registry` declares that same
 * file (until the harness that owned it retires, its adapter keeps it and this one stays out). */
function instructionTarget({ paths, assets, registry }: any) {
  if (!paths.instruction) return null;
  if (scopeOf(paths) === 'project') return paths.instruction;
  if (!(assets ?? []).some((asset: any) => asset.id === POINTER_ASSET_ID)) return null;
  const declaredBy = (harness: any) => {
    if (harness?.id === HARNESS || !harness?.paths?.instruction) return false;
    try { return resolveHarnessPaths({ instruction: harness.paths.instruction }, { scope: 'global', scopeRoot: paths.root, homeDir: paths.root }).instruction === paths.instruction; } catch { return false; }
  };
  return (registry?.harnesses ?? []).some(declaredBy) ? null : paths.instruction;
}

/** How this run stands to a section it took over (IC-007): the lifecycle's handover verdict for the
 * file, this harness's own row on it, and whether a person-edited file stays as it is (`retained`:
 * edited before the handover, or kept since, and no --force). `predecessor` lets the retired
 * harness's span count as the section to replace; `keptRow` is a row recorded as kept. A handover
 * file whose DoFlow span already is this harness's render was written by DoFlow itself (a run that
 * threw after that write and before its ledger write), so it does not count as edited. */
function instructionState({ target, context, resources, paths, fsImpl = fs }: any) {
  const handover = (context.handovers ?? []).find((item: any) => item.target === target) ?? null;
  const ownRow = (resources ?? []).find((row: any) => row.harness === HARNESS && row.target === target && row.ownershipIdentity === INSTRUCTIONS_IDENTITY) ?? null;
  const ownWrite = () => {
    const rendered = renderedInstruction(paths, fsImpl);
    if (rendered === null || !fsImpl.existsSync(target)) return false;
    const outcome = managedInstruction(fsImpl.readFileSync(target, 'utf8'), rendered);
    return outcome.ok && outcome.operation === 'none';
  };
  const edited = (handover?.edited === true && !ownWrite()) || ownRow?.retainedEdit === true;
  return { predecessor: Boolean(handover) || ownRow?.retainedEdit === true, retained: edited && context.force !== true,
    keptRow: ownRow?.retainedEdit === true };
}

function instructionsChange(target: any, fields: any) {
  return { assetId: POINTER_ASSET_ID, target, ownershipIdentity: INSTRUCTIONS_IDENTITY,
    kind: 'instructions-section', identity: path.basename(target), projection: { renderer: 'antigravity-instructions' }, ...fields };
}

function planInstructions({ paths, target, removing, state, fsImpl = fs }: any) {
  const none = { changes: [], conflicts: [], notices: [] };
  if (!target) return none;
  if (removing) {
    // Removal must strip the section DoFlow owns while leaving foreign bytes untouched — same
    // contract as the other AGENTS-style adapters.
    if (!fsImpl.existsSync(target)) return none;
    const text = fsImpl.readFileSync(target, 'utf8');
    // A kept edited file with no span left still carries this harness's row: the remove change
    // releases the row, and apply finds no span to strip, so the person's file is not touched.
    if (!text.includes(MARKER_START) && !state.keptRow) return none;
    return { ...none, changes: [instructionsChange(target, { operation: 'remove' })] };
  }
  if (state.retained) {
    const shown = scopeOf(paths) === 'global' ? `~/${path.relative(paths.root, target)}` : path.relative(paths.root, target);
    return { ...none, notices: [`kept ${shown}: changed before handover; --force replaces the DoFlow section`] };
  }
  const rendered = renderedInstruction(paths, fsImpl);
  if (rendered === null) return none;
  const existing = fsImpl.existsSync(target) ? fsImpl.readFileSync(target, 'utf8') : null;
  const outcome = managedInstruction(existing, rendered, { name: path.basename(target), predecessor: state.predecessor });
  if (!outcome.ok) return { ...none, conflicts: [outcome.conflict] };
  if (outcome.operation === 'none') return none;
  return {
    ...none,
    changes: [instructionsChange(target, {
      operation: existing === null ? 'create' : 'update',
      afterFingerprint: fingerprint(outcome.content), sourceVersion: 'registry-v1',
      _content: outcome.content,
    })],
  };
}

/** This scope's DoFlow section: the shared pointer rendered for the scope, inside the markers. */
function renderedInstruction(paths: any, fsImpl: any) {
  const sourceText = pointerBody(fsImpl);
  return sourceText ? render({ content: renderGuidancePointer(sourceText, { scope: scopeOf(paths), scopeRoot: paths.root }) }) : null;
}

function pointerBody(fsImpl: any) {
  // The shared pointer prose ships once; read it through the same repo-relative anchor the other
  // AGENTS-style adapters use.
  try {
    return fsImpl.readFileSync(path.resolve(__dirname, '../../../core/shared/guidance/pointers/codex.md'), 'utf8').trimEnd();
  } catch { return null; }
}

function scopeOf(paths: any) { return paths.scope; }

// ---- MCP component ----

function mcpDefinitionFor(server: any) {
  // Remote transports project url/httpUrl -> serverUrl per the current Antigravity schema.
  if (server.transport === 'stdio') {
    return { command: server.command, ...(server.args?.length ? { args: server.args } : {}) };
  }
  return { serverUrl: server.url ?? server.httpUrl };
}

function ownershipIdentity(id: any) { return `doflow:${HARNESS}:mcp-server:${id}`; }

/** Everything the shared entry-ownership rules (../mcp-entries.ts) need from this adapter. Rows
 * recorded before entries were fingerprinted carry `fingerprint: null`; such a row owns its entry
 * only while the entry still equals DoFlow's rendering. */
function mcpEntriesInput({ paths, mcp = [], mcpAdoptable = [], resources = [] }: any) {
  const rendered = (servers: any) => servers.map((server: any) => ({ id: server.id, entry: mcpDefinitionFor(server) }));
  const rows = resources.filter((row: any) => row.kind === 'mcp-server');
  return {
    file: paths.mcpFile, selected: rendered(mcp), adoptable: rendered(mcpAdoptable),
    ownRows: rows.filter((row: any) => row.harness === HARNESS).map((row: any) => ({
      identity: row.identity, target: row.target, fingerprint: row.fingerprint ?? null, ownershipIdentity: row.ownershipIdentity, legacy: false,
    })),
    foreignRows: rows.filter((row: any) => row.harness !== HARNESS).map((row: any) => ({ harness: row.harness, identity: row.identity, target: row.target })),
    identityFor: ownershipIdentity, assetId: POINTER_ASSET_ID, renderer: MCP_RENDERER, label: 'Antigravity MCP',
  };
}

// ---- required six-function surface ----

function plan(options: any = {}, impl: any = {}) {
  const fsImpl = impl.fsImpl || fs;
  const context = options.context ?? {};
  const scope = options.scope ?? 'project';
  const paths = (impl.nativePaths ?? singleton.nativePaths)({ ...options, scope, homeDir: context.homeDir });
  const removing = context.operation === 'remove';
  const neutralResources = ledgerResources(options);
  const selectedServers = Array.isArray(options.mcp) ? options.mcp : [];
  const discovery = options.discovery ?? discover(options, impl);

  const instructionFile = instructionTarget({ paths, assets: options.assets, registry: options.registry });
  const instructions = planInstructions({ paths, target: instructionFile, removing, fsImpl,
    state: instructionState({ target: instructionFile, context, resources: neutralResources, paths, fsImpl }) });
  const trees = planTrees({ assets: options.assets, paths, scope, neutralResources, removing, repoRoot: context.repoRoot, force: context.force === true, fsImpl });
  const mcp = planMcpEntries({
    ...mcpEntriesInput({ paths, mcp: selectedServers, mcpAdoptable: options.mcpAdoptable, resources: neutralResources }),
    files: discovery.mcpSnapshot, removing,
  });
  // Hook tiers (maint-hooks): outside `hooks.harnesses` this plan carries no hook change; the lifecycle
  // plans the removal of what an earlier run wrote, from the ledger, against the full registry.
  const hooksPlan = context.hooksOff === true && !removing ? { changes: [], conflicts: [] }
    : planHooks({ paths, scope, neutralResources, removing, repoRoot: context.repoRoot, fsImpl });

  const changes = [...instructions.changes, ...trees.changes, ...mcp.changes, ...hooksPlan.changes];
  const conflicts = [...instructions.conflicts, ...trees.conflicts, ...mcp.conflicts, ...hooksPlan.conflicts];
  return {
    changes,
    conflicts,
    prerequisites: [],
    requiredNativeResources: changes,
    notices: [...instructions.notices, ...trees.notices, ...mcp.notices],
  };
}

/** The hook front doors (IC-037): the shims and the hooks.json groups that run them, planned and
 * verified alone. Project scope only, and only when the harness selected the hooks asset. */
function planHookDoors(options: any = {}, impl: any = {}) {
  const fsImpl = impl.fsImpl || fs;
  const context = options.context ?? {};
  const scope = options.scope ?? 'project';
  if (!(options.assets ?? []).some((asset: any) => asset.id === HOOKS_ASSET_ID)) return { changes: [], conflicts: [], prerequisites: [], notices: [] };
  const paths = (impl.nativePaths ?? singleton.nativePaths)({ ...options, scope, homeDir: context.homeDir });
  const doors = planHooks({ paths, scope, neutralResources: ledgerResources(options), removing: false, repoRoot: context.repoRoot, fsImpl });
  return { changes: doors.changes, conflicts: doors.conflicts, prerequisites: [], notices: [] };
}

function verifyHookDoors(options: any = {}, impl: any = {}) {
  const fsImpl = impl.fsImpl || fs;
  const context = options.context ?? {};
  const scope = options.scope ?? 'project';
  if (scope !== 'project' || !(options.assets ?? []).some((asset: any) => asset.id === HOOKS_ASSET_ID)) return { ok: true, statuses: [], resources: [], conflicts: [] };
  const paths = (impl.nativePaths ?? singleton.nativePaths)({ ...options, scope, homeDir: context.homeDir });
  const doors = verifyHooks({ options, paths, context, fsImpl });
  const conflicts = doors.statuses.filter((status: any) => status.status === 'conflict').map((status: any) => status.reason ?? status.identity);
  return { ok: conflicts.length === 0, ...doors, conflicts };
}

function apply(options: any = {}, impl: any = {}) {
  const fsImpl = impl.fsImpl || fs;
  // apply()/verify() are reached through the lifecycle with the same scope inputs plan() saw, so
  // they re-derive paths instead of trusting plan-private state. `paths` itself is unused here —
  // every change carries its own absolute target — but resolving it keeps scope validation (and
  // the fail-loud contract) identical to plan().
  (impl.nativePaths ?? singleton.nativePaths)(options);
  const changes = options.changes ?? [];

  for (const change of changes.filter((c: any) => c.projection?.renderer === 'antigravity-instructions')) {
    if (change.operation === 'remove') {
      if (!fsImpl.existsSync(change.target)) continue;
      // The global file is the person's: the span goes with the one newline put before it, so their
      // bytes come back exactly (and a file that held only the span goes with it). A kept file taken
      // over from the retired harness may still hold that harness's span, under its short marker.
      if ((options.scope ?? 'project') === 'global') { removeMarkedSection(change.target, { startMarkers: [MARKER_START, PREDECESSOR_MARKER_START] }); continue; }
      // pi precedent: strip only the managed span; the file survives even when nothing remains.
      const next = strippedInstruction(fsImpl.readFileSync(change.target, 'utf8'));
      if (next !== null) fsImpl.writeFileSync(change.target, next, 'utf8');
      continue;
    }
    // One rename onto the file: no reader, and no failure, ever sees it without its DoFlow span.
    fsImpl.mkdirSync(path.dirname(change.target), { recursive: true });
    const tmp = `${change.target}.${process.pid}.tmp`;
    try {
      fsImpl.writeFileSync(tmp, change._content ?? render({ content: '' }), 'utf8');
      fsImpl.renameSync(tmp, change.target);
    } catch (error) {
      fsImpl.rmSync(tmp, { force: true });
      throw error;
    }
  }
  for (const change of changes.filter((c: any) => c.projection?.renderer === 'antigravity-hooks')) {
    if (change.kind === 'copy-tree-file') continue;          // handled by runTreeChanges below
    if (change.operation === 'remove') {
      // Unmerge only DoFlow's groups (one per policy); a user's own hook groups survive.
      if (!fsImpl.existsSync(change.target)) continue;
      let doc = readJsonObject(change.target, { fsImpl });
      if (!doc) continue;
      for (const group of [HOOKS_GROUP, STOP_HOOKS_GROUP]) delete doc[group];
      if (Object.keys(doc).length === 0) fsImpl.rmSync(change.target, { force: true });
      else { const tmp = `${change.target}.${process.pid}.tmp`;
        fsImpl.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8'); fsImpl.renameSync(tmp, change.target); }
      continue;
    }
    if (change.content !== undefined) {
      fsImpl.mkdirSync(path.dirname(change.target), { recursive: true });
      const tmp = `${change.target}.${process.pid}.tmp`;
      fsImpl.writeFileSync(tmp, change.content, 'utf8'); fsImpl.renameSync(tmp, change.target);
    }
  }
  // Projected hook scripts ride the copy-tree engine (kind copy-tree-file), but their renderer is
  // ours; teach the tree router to include them.
  runTreeChanges(changes, 'all');

  // Script writes carry pre-rendered text (_text) because they are content-managed, not mirrored:
  // execute them after the generic tree pass so the executable bit lands last and survives.

  writeMcpEntries(changes, { container: MCP_CONTAINER, keepEmptyContainer: true, fsImpl });
  return { applied: changes.length };
}

// Removal flows through apply(): plan(context.operation='remove') emits operation:'remove'
// changes, and the branches above already know how to execute each kind. The six-function
// contract still requires the verb itself.
function remove(options: any = {}, impl: any = {}) {
  return apply(options, impl);
}

/** The hook shims' bytes and the registered groups (project scope), as statuses and resources. */
function verifyHooks({ options, paths, context, fsImpl }: any) {
  const statuses: any[] = [];
  const resources: any[] = [];
  const hooksTarget = paths.hooksJson;
  const scriptTargets: Record<string, any> = {
    'pre-implementation-gate.sh': paths.hookScript,
    'stop-check.sh': paths.stopHookScript,
  };
  // Source-side residue: reads the shims from THIS checkout (the authored source of the
  // projection, not an install destination — the destination is declared as the paths above).
  const scriptSourceDir = path.join(path.resolve(registryRepoRoot(options)), 'core', 'harnesses', 'antigravity', 'hooks');
  const removingOp = (context.operation ?? options.operation ?? '') === 'remove';
  const fingerprints: Record<string, any> = {};
  let scriptsOk = true;
  let anyPresent = false;
  for (const identity of HOOK_SCRIPTS) {
    let sourceFp = null;
    try { sourceFp = sha256File(fsImpl, path.join(scriptSourceDir, identity)); } catch { /* checkout without that shim */ }
    fingerprints[identity] = sourceFp;
    const target = scriptTargets[identity];
    const current = fsImpl.existsSync(target) ? sha256File(fsImpl, target) : null;
    if (current !== null) anyPresent = true;
    if (current === null || current !== sourceFp) scriptsOk = false;
  }
  const doc = readJsonObject(hooksTarget, { fsImpl });
  const gate = doc?.[HOOKS_GROUP];
  const stop = doc?.[STOP_HOOKS_GROUP];
  const gateOk = Boolean(gate?.PreToolUse?.[0]?.hooks?.[0]?.command)
    && gate.PreToolUse[0].hooks[0].command === scriptTargets['pre-implementation-gate.sh']
    && gate.PreToolUse[0].matcher === GATE_MATCHER;
  // Stop registration is matcher-free: handlers sit directly under the event key.
  const stopOk = Array.isArray(stop?.Stop) && stop.Stop.length > 0
    && stop.Stop[0]?.command === scriptTargets['stop-check.sh'];
  const groupsOk = gateOk && stopOk;
  statuses.push({ assetId: HOOKS_ASSET_ID, capability: 'hooks', status:
    removingOp ? (!anyPresent && !groupsOk ? 'absent' : 'retained')
      : (scriptsOk && groupsOk ? 'managed' : (!anyPresent && !groupsOk ? 'absent' : 'missing')),
    ownershipIdentity: `${HARNESS}:hooks:registration`, target: hooksTarget });
  if (!removingOp && scriptsOk && groupsOk) {
    resources.push({ assetId: HOOKS_ASSET_ID, target: hooksTarget,
      ownershipIdentity: `${HARNESS}:hooks:registration`, kind: 'hooks-json',
      fingerprint: fingerprint(JSON.stringify(doc)), sourceVersion: 'registry-v1',
      projection: { renderer: 'antigravity-hooks' } });
    for (const identity of HOOK_SCRIPTS) {
      resources.push({ assetId: HOOKS_ASSET_ID, target: scriptTargets[identity],
        ownershipIdentity: `${HARNESS}:copy-tree:${HOOKS_ASSET_ID}:${identity}`,
        kind: 'copy-tree-file', identity, fingerprint: fingerprints[identity],
        sourceVersion: 'registry-v1', projection: { renderer: 'antigravity-hooks' } });
    }
  }
  return { statuses, resources };
}

function verify(options: any = {}, impl: any = {}) {
  const fsImpl = impl.fsImpl || fs;
  const context = options.context ?? {};
  const scope = options.scope ?? 'project';
  const paths = (impl.nativePaths ?? singleton.nativePaths)({ ...options, scope, homeDir: context.homeDir });
  const removing = (context.operation ?? options.operation) === 'remove';
  const statuses = [];
  const resources = [];

  const instructionFile = instructionTarget({ paths, assets: options.assets, registry: options.registry });
  const state = instructionState({ target: instructionFile, context, resources: ledgerResources(options), paths, fsImpl });
  const instruction = instructionFile && fsImpl.existsSync(instructionFile)
    ? fsImpl.readFileSync(instructionFile, 'utf8') : null;
  const managed = instruction !== null && instruction.includes(MARKER_END)
    && (instruction.includes(MARKER_START) || (state.predecessor && instruction.includes(PREDECESSOR_MARKER_START)));
  // A kept, person-edited file (IC-007) is owned as it is now, markers or not: an edit can drop the
  // span, and without its row the next run would see no owner and append the section unasked.
  const kept = !removing && state.retained && instruction !== null;
  if (instructionFile) {
    // Removal verification asks "did our section go away?"; install/update asks "is it managed?".
    statuses.push({
      assetId: POINTER_ASSET_ID, capability: 'instructions',
      status: removing ? (managed ? 'retained' : 'absent') : (managed ? 'managed' : (kept ? 'retained' : 'missing')),
      target: instructionFile,
    });
    if (!removing && (managed || kept)) {
      // Recorded with the file as it is now; a kept one is flagged so later runs keep it until --force.
      resources.push(instructionsChange(instructionFile, {
        fingerprint: fingerprint(instruction), sourceVersion: 'registry-v1',
        ...(state.retained ? { retainedEdit: true } : {}),
      }));
    }
  }

  for (const asset of copyTreeAssets(options.assets ?? [])) {
    const destDir = treeDestFor(asset, paths, scope);
    if (!destDir) continue;
    const sourceDir = sourceDirFor(asset, { repoRoot: context.repoRoot }, fsImpl, HARNESS);
    const result = verifyTree({ sourceDir, destDir, fsImpl, layout: asset.layout, transform: asset.transform, select: asset.select, plannedWrites: context.plannedWrites });
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

  const entries = mcpEntriesInput({ paths, mcp: options.mcp, mcpAdoptable: options.mcpAdoptable, resources: ledgerResources(options) });
  const mcpFiles = readMcpFiles({ file: entries.file, ownRows: entries.ownRows, container: MCP_CONTAINER, fsImpl });
  const mcp = verifyMcpEntries({
    ...entries, files: mcpFiles, snapshot: options.discovery?.mcpSnapshot ?? mcpFiles, removing,
    harness: HARNESS, sourceVersion: context.sourceVersion ?? 'unknown',
  });
  statuses.push(...mcp.statuses);
  resources.push(...mcp.resources);

  // Hooks projection (project scope): the shims' bytes and the registered groups.
  if (scope === 'project' && context.hooksOff !== true) {
    const hooks = verifyHooks({ options, paths, context, fsImpl });
    statuses.push(...hooks.statuses);
    resources.push(...hooks.resources);
  }

  const conflicts = [...statuses.filter((s) => s.status === 'conflict').map((s) => s.reason ?? s.identity), ...mcp.conflicts];
  return { ok: conflicts.length === 0, statuses, resources, conflicts };
}

function registryRepoRoot(options: any) {
  return options.registry?.repoRoot ?? process.cwd();
}

function conflictsToStatuses(conflicts: any, assetId: any, statuses: any) {
  for (const reason of conflicts) statuses.push({ assetId, capability: 'scripts', status: 'conflict', reason });
}

module.exports = {
  HARNESS, nativePaths: singleton.nativePaths, discover, render, plan, apply, remove, verify,
  planHookDoors: singleton.planHookDoors, verifyHookDoors: singleton.verifyHookDoors,
  createAntigravityAdapter,
};
