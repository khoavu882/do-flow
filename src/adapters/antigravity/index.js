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
//   hooks        — native-payload shims (bash + jq translating Antigravity's stdin/stdout
//     {decision} contract): the pre-implementation gate on PreToolUse and the stop check on Stop,
//     each registered under its own named hooks.json group.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MARKER_START, MARKER_END } = require('../../helper/marker-merge');
const { planTree, applyTree, removeTree, verifyTree, copyTreeAssets, ledgerFileResources, fingerprint, readJson, sourceDirFor } = require('../copy-tree');
const { declaredHarnessPaths, resolveHarnessPaths } = require('../../helper/harness-paths');

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
function hookGroups({ gateCommand, stopCommand }) {
  return {
    [HOOKS_GROUP]: { PreToolUse: [{ matcher: GATE_MATCHER, hooks: [{ type: 'command', command: gateCommand }] }] },
    [STOP_HOOKS_GROUP]: { Stop: [{ type: 'command', command: stopCommand }] },
  };
}

function hookScriptTarget(identity, paths) {
  return identity === 'pre-implementation-gate.sh' ? paths.hookScript : paths.stopHookScript;
}

function planHooks({ paths, scope, neutralResources, removing, fsImpl = fs }) {
  const changes = [];
  const conflicts = [];
  if (scope !== 'project') {
    // The shims resolve the workspace via git/transcriptPath; a user-scope hooks.json would fire
    // against every project including non-git ones. Project-only until a documented user story exists.
    return { changes, conflicts };
  }
  const target = paths.hooksJson;
  const scriptSource = sourceDirFor({ source: 'core/harnesses/antigravity/hooks' }, { repoRoot: process.cwd() }, fsImpl, HARNESS);

  const previousHookRows = (neutralResources || []).filter((r) => r.harness === HARNESS && r.assetId === HOOKS_ASSET_ID && r.kind === 'hooks-json');
  const previousScriptRows = (neutralResources || []).filter((r) => r.harness === HARNESS && r.assetId === HOOKS_ASSET_ID && r.kind === 'copy-tree-file');
  const docRow = previousHookRows.find((r) => r.target === target);

  if (removing) {
    if (docRow || fsImpl.existsSync(target)) {
      changes.push({ assetId: HOOKS_ASSET_ID, target, operation: 'remove',
        ownershipIdentity: `${HARNESS}:hooks:registration`, kind: 'hooks-json',
        fingerprint: fingerprint('{}'), managed: null,
        projection: { renderer: 'antigravity-hooks' } });
    }
    for (const identity of HOOK_SCRIPTS) {
      const scriptTarget = hookScriptTarget(identity, paths);
      const scriptRow = previousScriptRows.find((r) => r.identity === identity);
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

function sha256File(fsImpl, file) {
  return require('node:crypto').createHash('sha256').update(fsImpl.readFileSync(file)).digest('hex');
}

/** Native paths per scope, resolved from the declaration in core/registry/harnesses.json
 * ("paths"): project customization lives at <root>/.agents, global config at ~/.gemini/config
 * (the shared-customization root); instructions and skills are project-only surfaces, so no user
 * rule is declared for them and they resolve to null there. */
function resolveNativePaths(declaredPaths, { scope, scopeRoot, homeDir } = {}) {
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
function createAntigravityAdapter({ declaredPaths = DEFAULT_DECLARED_PATHS } = {}) {
  const nativePathsFor = (options) => resolveNativePaths(declaredPaths, options);
  return {
    nativePaths: nativePathsFor,
    discover: (options, impl = {}) => discover(options, { ...impl, nativePaths: nativePathsFor }),
    render,
    plan: (options, impl = {}) => plan(options, { ...impl, nativePaths: nativePathsFor }),
    apply,
    remove,
    verify: (options, impl = {}) => verify(options, { ...impl, nativePaths: nativePathsFor }),
  };
}

const singleton = createAntigravityAdapter();

function discover(options, { fsImpl = fs, nativePaths: resolvePaths = singleton.nativePaths } = {}) {
  const paths = resolvePaths(options);
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
    // Project-only: the user-scope skills format contradiction is unresolved upstream. The
    // registry's own nativeDir (.agents/skills) is root-relative, so this joins the ROOT.
    return scope === 'project' ? path.join(paths.root, nativeDir) : null;
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

function planTrees({ assets, paths, scope, neutralResources, removing, repoRoot, force = false, fsImpl = fs }) {
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
    const result = planTree({ sourceDir, destDir, previousResources, operation: removing ? 'remove' : 'apply', fsImpl, layout: asset.layout,
      // Forwarded so the CLI's --force reaches planTree's conflict check; omitting it let
      // planTree's own `force = false` default stand in silently. Gated on `!removing` for the
      // reason codex/index.js states in full: force heals drift on apply, but a hand-edited file
      // is never deleted on removal, forced or not. This adapter needed `force` threaded through
      // planTrees as well, since its signature did not carry the context the others already had.
      force: !removing && force === true });
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
  // Route by what each change IS, not by which verb invoked us: remove() delegates here with a
  // plan full of operation:'remove' changes, and applyTree deliberately skips those — so routing
  // everything through one engine call silently deleted nothing (verification then correctly
  // refused to journal the no-op). Writes go to applyTree, removals to removeTree, always.
  void mode;
  const treeChanges = changes
    .filter((c) => c.projection?.renderer === 'copy-tree' || c.kind === 'copy-tree-file')
    .map((c) => ({ relPath: c.identity ?? c.relPath, target: c.target,
      source: c._text ? undefined : c.source, operation: c.operation,
      fingerprint: c.fingerprint, ...(c._text ? { _text: c._text } : {}) }));
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
    ...(function () {
      const plain = treeChanges.filter((t) => t._text === undefined);
      const writes = plain.filter((c) => c.operation !== 'remove');
      const removals = plain.filter((c) => c.operation === 'remove');
      const applied = writes.length ? applyTree({ changes: writes }).applied : 0;
      const removed = removals.length ? removeTree({ changes: removals }).removed : 0;
      return { applied, removed };
    })(),
  };
  const writes = treeChanges.filter((c) => c.operation !== 'remove');
  const removals = treeChanges.filter((c) => c.operation === 'remove');
  const applied = writes.length ? applyTree({ changes: writes }).applied : 0;
  const removed = removals.length ? removeTree({ changes: removals }).removed : 0;
  return { applied, removed };
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
  const paths = (impl.nativePaths ?? singleton.nativePaths)({ ...options, scope, homeDir: context.homeDir });
  const removing = context.operation === 'remove';
  const neutralResources = options.ledger?.resources ?? options.managedResources ?? [];
  const selectedServers = Array.isArray(options.mcp) ? options.mcp : [];

  const instructions = planInstructions({ paths, assets: options.assets, removing, repoRoot: context.repoRoot, fsImpl });
  const trees = planTrees({ assets: options.assets, paths, scope, neutralResources, removing, repoRoot: context.repoRoot, force: context.force === true, fsImpl });
  const mcp = planMcp({ paths, selectedServers, neutralResources, removing, fsImpl });
  const hooksPlan = planHooks({ paths, scope, neutralResources, removing, fsImpl });

  const changes = [...instructions.changes, ...trees.changes, ...mcp.changes, ...hooksPlan.changes];
  const conflicts = [...instructions.conflicts, ...trees.conflicts, ...hooksPlan.conflicts];
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
  // they re-derive paths instead of trusting plan-private state. `paths` itself is unused here —
  // every change carries its own absolute target — but resolving it keeps scope validation (and
  // the fail-loud contract) identical to plan().
  (impl.nativePaths ?? singleton.nativePaths)(options);
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
  for (const change of changes.filter((c) => c.projection?.renderer === 'antigravity-hooks')) {
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
  const paths = (impl.nativePaths ?? singleton.nativePaths)({ ...options, scope, homeDir: context.homeDir });
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
    const result = verifyTree({ sourceDir, destDir, fsImpl, layout: asset.layout });
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

  // Hooks projection (project scope): the shims' bytes and the registered groups.
  if (scope === 'project') {
    const hooksTarget = paths.hooksJson;
    const scriptTargets = {
      'pre-implementation-gate.sh': paths.hookScript,
      'stop-check.sh': paths.stopHookScript,
    };
    // Source-side residue: reads the shims from THIS checkout (the authored source of the
    // projection, not an install destination — the destination is declared as the paths above).
    const scriptSourceDir = path.join(path.resolve(registryRepoRoot(options)), 'core', 'harnesses', 'antigravity', 'hooks');
    const removingOp = (context.operation ?? options.operation ?? '') === 'remove';
    const fingerprints = {};
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
  }

  const conflicts = statuses.filter((s) => s.status === 'conflict').map((s) => s.reason ?? s.identity);
  return { ok: conflicts.length === 0, statuses, resources, conflicts };
}

function registryRepoRoot(options) {
  return options.registry?.repoRoot ?? process.cwd();
}

function conflictsToStatuses(conflicts, assetId, statuses) {
  for (const reason of conflicts) statuses.push({ assetId, capability: 'scripts', status: 'conflict', reason });
}

module.exports = {
  HARNESS, nativePaths: singleton.nativePaths, discover, render, plan, apply, remove, verify,
  createAntigravityAdapter,
};
