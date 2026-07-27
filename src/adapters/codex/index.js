'use strict';

// Codex adapter boundary. Native parsing and mutation remain in the existing
// codex-* modules; this module composes their non-mutating plans into the
// common adapter shape without changing legacy CLI ownership.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { configPath, fingerprint: configFingerprint, parseToml, planCodexConfig, applyCodexConfig } = require('../../codex-config');
const { renderServer, planCodexMcp, applyCodexMcp } = require('../../codex-mcp');
const { agentDirectory, discoverCodexAgents, planCodexAgents, applyCodexAgents } = require('../../codex-agents');
const { planCodexHooks, deployCodexHooks } = require('../../codex-hooks');
const { planTree, applyTree, removeTree, verifyTree, copyTreeAssets, copyTreeDestDir, ledgerFileResources } = require('../copy-tree');
const { mergeMarkedSection, removeMarkedSection, MARKER_START, MARKER_END } = require('../../marker-merge');
const { nativeMcpCatalog } = require('../../registry');

const HARNESS = 'codex';

function normalizeContext({ scope, scopeRoot, projectRoot, codexDir, homeDir } = {}) {
  if (!['project', 'global', 'user'].includes(scope)) throw new Error(`Unsupported Codex scope '${scope}'`);
  if (scope === 'project') {
    // scopeRoot is accepted as the selected repository root for generic
    // lifecycle callers. A workspace container is never substituted here: the
    // caller must pass that container as projectRoot only when it is itself the
    // repository being configured.
    const root = projectRoot ?? scopeRoot;
    if (!root) throw new Error('Codex project scope requires the selected repository projectRoot');
    return { scope: 'project', projectRoot: path.resolve(root) };
  }
  // Native modules name user scope "global". The generic lifecycle may pass
  // either global or user; both target the actual user configuration root.
  const home = homeDir ?? os.homedir();
  return { scope: 'global', codexDir: codexDir ? path.resolve(codexDir) : path.join(path.resolve(home), '.codex') };
}

const nativeContext = normalizeContext;

function discover(options, { fsImpl = fs } = {}) {
  const context = nativeContext(options);
  const config = configPath(context);
  const agents = agentDirectory(context);
  const hooks = context.scope === 'project'
    ? path.join(context.projectRoot, '.codex', 'hooks.json')
    : path.join(context.codexDir, 'hooks.json');
  return {
    harness: HARNESS,
    scope: options.scope,
    config: { file: config, exists: fsImpl.existsSync(config) },
    agents: { directory: agents, exists: fsImpl.existsSync(agents) },
    hooks: { file: hooks, exists: fsImpl.existsSync(hooks) },
  };
}

function render({ registry, asset }) {
  if (!registry || !asset) throw new Error('render requires registry and asset');
  const harness = registry.harnesses.find((item) => item.id === HARNESS);
  if (!harness) throw new Error('Registry does not define the Codex harness');
  const projection = asset.projection?.[HARNESS];
  if (!projection) return { harness: HARNESS, assetId: asset.id, status: 'not-applicable' };
  const capability = harness.capabilities?.[projection.capability];
  if (!capability) throw new Error(`Codex projection '${asset.id}' references unknown capability '${projection.capability}'`);
  return {
    harness: HARNESS,
    assetId: asset.id,
    renderer: projection.renderer,
    capability: projection.capability,
    capabilityStatus: capability.status,
    target: harness.nativeTargets?.[projection.capability] ?? null,
    status: capability.status === 'unavailable' ? 'unavailable' : 'renderable',
    prerequisites: [...(capability.prerequisites || [])],
  };
}

function assetIdFor(options, componentName) {
  const explicit = options.projection?.assetIds?.[componentName];
  if (explicit) return explicit;
  const assets = options.assets || [];
  if (componentName === 'agents') return assets.find((asset) => asset.id === 'agents.shared')?.id ?? assets[0]?.id;
  return assets.find((asset) => asset.id === 'guidance.codex-pointer')?.id ?? assets[0]?.id ?? `codex.${componentName}`;
}

function ownershipKind(componentName) {
  return ({ config: 'configuration-entry', mcp: 'mcp-server', agents: 'custom-agent', hooks: 'hooks-file' })[componentName] ?? componentName;
}
function ownershipIdentity(componentName, identity) { return `doflow:codex:${ownershipKind(componentName)}:${identity}`; }

function addChanges(output, assetId, component, componentName) {
  for (const change of component?.changes || []) output.push({
    harness: HARNESS,
    assetId,
    nativeComponent: componentName,
    nativePlan: component,
    operation: change.operation ?? change.type,
    target: change.target ?? change.file ?? component.file ?? component.destination ?? component.directory,
    ownershipIdentity: change.ownershipIdentity ?? ownershipIdentity(componentName, change.identity ?? (componentName === 'hooks' ? 'hooks.json' : assetId)),
    ...change,
  });
}

function sha256(text) { return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`; }
function lifecycleResource({ scope, assetId, kind, identity, target, fingerprint, sourceVersion, selection, recoveryRef, projection }) {
  return { harness: HARNESS, scope, assetId, kind, identity, target, ownershipIdentity: `doflow:codex:${kind}:${identity}`,
    fingerprint, sourceVersion: sourceVersion ?? 'unknown', selection: selection ?? true, recoveryRef: recoveryRef ?? null, projection };
}

/** Convert neutral ledger entries to the legacy planner's ownership record.
 * An absolute target must match the exact native file this component will
 * reconcile; a record from another Codex project cannot authorize this plan. */
function nativeManagedResources(resources, context, { kind, target, directory } = {}) {
  return (resources || []).flatMap((resource) => {
    if (!resource || resource.kind !== kind) return [];
    // Retain the pre-registry native record shape for direct callers/tests.
    if (!resource.harness && resource.target === HARNESS) {
      return [{ ...resource, scope: context.scope, target: HARNESS }];
    }
    if (resource.harness !== HARNESS) return [];
    const expected = directory && resource.identity?.startsWith('agent:')
      ? path.join(directory, `${resource.identity.slice('agent:'.length)}.toml`) : target;
    if (typeof resource.target !== 'string' || path.resolve(resource.target) !== path.resolve(expected)) return [];
    return [{ target: HARNESS, scope: context.scope, kind, identity: resource.identity, fingerprint: resource.fingerprint,
      sourceVersion: resource.sourceVersion, selection: resource.selection, recoveryPoint: resource.recoveryRef }];
  });
}

function ownedRemovalPlan(resources, context, kind, directory) {
  const entries = (resources || []).filter((resource) => resource?.harness === HARNESS && resource.kind === kind);
  const changes = []; const conflicts = [];
  for (const resource of entries) {
    const target = kind === 'custom-agent'
      ? path.join(directory, `${resource.identity.replace(/^agent:/, '')}.toml`)
      : resource.target;
    if (path.resolve(target) !== path.resolve(resource.target)) continue;
    if (fs.existsSync(target) && sha256(fs.readFileSync(target, 'utf8')) !== resource.fingerprint) {
      conflicts.push(`${kind} '${resource.identity}' was modified outside DoFlow`);
      continue;
    }
    changes.push({ type: 'remove', identity: resource.identity, file: target, fingerprint: resource.fingerprint });
  }
  return { ok: conflicts.length === 0, status: conflicts.length ? 'conflict' : (changes.length ? 'change' : 'unchanged'), changes, conflicts, directRemove: true };
}

function configResourcesFrom(config, { scope, sourceVersion, recoveryRef }) {
  return (config?.managedResources || [])
    .filter((record) => record.kind === 'configuration-entry' || record.kind === 'config-entry')
    .map((record) => lifecycleResource({ scope, assetId: 'guidance.codex-pointer', kind: 'configuration-entry', identity: record.identity,
      target: config.file, fingerprint: record.fingerprint, sourceVersion: record.sourceVersion ?? sourceVersion, recoveryRef,
      projection: { renderer: 'codex-config' } }));
}

function mcpResourcesFrom(mcp, { scope, sourceVersion, recoveryRef }) {
  return (mcp?.managedResources || [])
    .filter((record) => record.kind === 'mcp-server')
    .map((record) => lifecycleResource({ scope, assetId: 'guidance.codex-pointer', kind: 'mcp-server', identity: record.identity,
      target: mcp.file, fingerprint: record.fingerprint, sourceVersion: record.sourceVersion ?? sourceVersion, selection: record.selection, recoveryRef,
      projection: { renderer: 'codex-mcp' } }));
}

function agentResourcesFrom(agents, { scope, sourceVersion, recoveryRef }) {
  return (agents?.managedResources || [])
    .filter((record) => record.kind === 'custom-agent')
    .map((record) => lifecycleResource({ scope, assetId: 'agents.shared', kind: 'custom-agent', identity: record.identity,
      target: path.join(agents.directory, `${record.identity.replace(/^agent:/, '')}.toml`), fingerprint: record.fingerprint,
      sourceVersion: record.sourceVersion ?? sourceVersion, recoveryRef, projection: { renderer: 'codex-agent' } }));
}

function hooksResourceFrom(hooks, { scope, sourceVersion, recoveryRef }) {
  if (!hooks?.applied || !hooks.destination) return [];
  return [lifecycleResource({ scope, assetId: 'guidance.codex-pointer', kind: 'hooks-file', identity: 'hooks.json',
    target: hooks.destination, fingerprint: sha256(fs.readFileSync(hooks.destination, 'utf8')), sourceVersion, recoveryRef,
    projection: { renderer: 'codex-hooks' } })];
}

function resourcesFromApplied({ components, scope, sourceVersion, recoveryRef }) {
  const shared = { scope, sourceVersion, recoveryRef };
  return [
    ...configResourcesFrom(components.config, shared),
    ...mcpResourcesFrom(components.mcp, shared),
    ...agentResourcesFrom(components.agents, shared),
    ...hooksResourceFrom(components.hooks, shared),
  ];
}

// ---- copy-tree assets (rules, skills, agents, templates, scripts, references) ----

function codexConfigDir(context) { return context.scope === 'global' ? context.codexDir : path.join(context.projectRoot, '.codex'); }
function sourceDirFor(asset, repoRoot) {
  if (!asset || typeof asset.source !== 'string') throw new Error('Codex asset requires a source path');
  const root = repoRoot ? path.resolve(repoRoot) : process.cwd();
  const source = path.resolve(root, asset.source);
  if (!source.startsWith(`${root}${path.sep}`) || !fs.existsSync(source)) {
    throw new Error(`Codex asset source is unavailable: ${asset.source}`);
  }
  return source;
}

// ---- guidance.codex-pointer instructions (AGENTS.md managed-section merge) ----
// The registry declares this asset's codex projection as renderer "codex-agents" (see
// core/registry/assets.yaml), but nothing previously implemented it — Codex's AGENTS.md merge was
// silently carried entirely by the legacy mappings.conf copier (its `dst === 'AGENTS.md'`
// special-case in bin/doflow.js), invisible until Phase E emptied that copier's mappings.

function instructionsAsset(assets) { return (assets || []).find((asset) => asset?.renderer === 'codex-agents'); }
function instructionsPath(context) { return path.join(codexConfigDir(context), 'AGENTS.md'); }
function sha256Text(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

function planInstructionsAsset({ assets, context, removing, repoRoot }) {
  const asset = instructionsAsset(assets);
  const changes = [];
  const conflicts = [];
  if (!asset) return { changes, conflicts };
  const target = instructionsPath(context);
  if (removing) {
    if (!fs.existsSync(target)) return { changes, conflicts };
    const existing = fs.readFileSync(target, 'utf8');
    if (!existing.includes(MARKER_START)) return { changes, conflicts };
    changes.push({ assetId: asset.id, target, operation: 'remove', ownershipIdentity: 'doflow:codex:instructions:managed-section',
      kind: 'instructions-section', identity: 'AGENTS.md', projection: { renderer: 'codex-agents' } });
    return { changes, conflicts };
  }
  const source = sourceDirFor(asset, repoRoot);
  if (!mergeMarkedSection(source, target, { dryRun: true }).changed) return { changes, conflicts };
  const content = fs.readFileSync(source, 'utf8').replace(/\s+$/, '');
  changes.push({ assetId: asset.id, target, source, operation: fs.existsSync(target) ? 'update' : 'create',
    ownershipIdentity: 'doflow:codex:instructions:managed-section', kind: 'instructions-section', identity: 'AGENTS.md',
    afterFingerprint: sha256Text(content), sourceVersion: 'registry-v1', projection: { renderer: 'codex-agents' } });
  return { changes, conflicts };
}

function applyInstructionsAsset(changes) {
  for (const change of changes) {
    if (change.projection?.renderer !== 'codex-agents' || change.operation === 'remove') continue;
    mergeMarkedSection(change.source, change.target);
  }
}

function removeInstructionsAsset(changes) {
  for (const change of changes) {
    if (change.projection?.renderer === 'codex-agents' && change.operation === 'remove') removeMarkedSection(change.target);
  }
}

function verifyInstructionsAsset({ assets, context, repoRoot }) {
  const asset = instructionsAsset(assets);
  const statuses = []; const resources = [];
  if (!asset) return { statuses, resources };
  const target = instructionsPath(context);
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  const managed = existing !== null && existing.includes(MARKER_START) && existing.includes(MARKER_END);
  statuses.push({ assetId: asset.id, capability: asset.capability, status: managed ? 'managed' : 'absent', target });
  if (managed) {
    resources.push({ assetId: asset.id, target, ownershipIdentity: 'doflow:codex:instructions:managed-section',
      kind: 'instructions-section', identity: 'AGENTS.md', fingerprint: sha256Text(existing), sourceVersion: 'registry-v1',
      projection: { renderer: 'codex-agents' } });
  }
  return { statuses, resources };
}

function planCopyTreeAssets({ assets, context, neutralResources, removing, repoRoot, sourceVersion }) {
  const changes = [];
  const conflicts = [];
  for (const asset of copyTreeAssets(assets)) {
    const destDir = copyTreeDestDir(codexConfigDir(context), asset);
    const sourceDir = sourceDirFor(asset, repoRoot);
    const previousResources = ledgerFileResources(neutralResources, HARNESS, asset.id);
    const result = planTree({ sourceDir, destDir, previousResources, operation: removing ? 'remove' : 'apply' });
    conflicts.push(...result.conflicts.map((reason) => `${asset.id}: ${reason}`));
    for (const change of result.changes) {
      changes.push({
        assetId: asset.id, target: change.target, source: change.source, operation: change.operation,
        ownershipIdentity: `doflow:codex:copy-tree:${asset.id}:${change.relPath}`,
        kind: 'copy-tree-file', identity: change.relPath,
        afterFingerprint: change.fingerprint, fingerprint: change.fingerprint, sourceVersion: sourceVersion ?? 'unknown',
        projection: { renderer: 'copy-tree' },
      });
    }
  }
  return { changes, conflicts };
}

function applyCopyTreeAssets(changes) {
  const treeChanges = changes.filter((change) => change.projection?.renderer === 'copy-tree' && change.operation !== 'remove')
    .map((change) => ({ relPath: change.identity, target: change.target, source: change.source, operation: change.operation, fingerprint: change.fingerprint }));
  return applyTree({ changes: treeChanges }).applied;
}

function removeCopyTreeAssets(changes) {
  const treeChanges = changes.filter((change) => change.projection?.renderer === 'copy-tree' && change.operation === 'remove')
    .map((change) => ({ relPath: change.identity, target: change.target, operation: 'remove', fingerprint: change.fingerprint }));
  return removeTree({ changes: treeChanges }).removed;
}

function verifyCopyTreeAssets({ assets, context, repoRoot, sourceVersion }) {
  const statuses = [];
  const resources = [];
  const conflicts = [];
  for (const asset of copyTreeAssets(assets)) {
    const destDir = copyTreeDestDir(codexConfigDir(context), asset);
    const sourceDir = sourceDirFor(asset, repoRoot);
    const result = verifyTree({ sourceDir, destDir });
    conflicts.push(...result.conflicts.map((reason) => `${asset.id}: ${reason}`));
    for (const resource of result.resources) {
      resources.push({
        assetId: asset.id, target: resource.target, ownershipIdentity: `doflow:codex:copy-tree:${asset.id}:${resource.relPath}`,
        kind: 'copy-tree-file', identity: resource.relPath,
        fingerprint: resource.fingerprint, sourceVersion: sourceVersion ?? 'unknown',
        projection: { renderer: 'copy-tree' },
      });
    }
    statuses.push({ assetId: asset.id, capability: asset.capability, status: result.ok ? 'managed' : 'conflict', target: destDir });
  }
  return { statuses, resources, conflicts };
}

/** Resolve the explicit projected-native shape. During the migration, direct
 * callers may still use legacy option names; lifecycle callers pass `assets`,
 * `mcp`, `policies`, and optionally `projection` for source-bearing surfaces.
 * Native source paths are never guessed from an asset's renderer. */
function projectedNativeOptions(options) {
  const projection = options.projection || {};
  const configResources = projection.configResources ?? options.configResources ?? options.context?.codexConfigResources;
  const mcpCatalog = projection.mcp?.catalog ?? options.mcpCatalog ?? options.mcp ?? [];
  const selectedMcp = projection.mcp?.selected ?? options.selectedMcp ?? (options.mcp ? options.mcp.map((server) => server.id) : undefined);
  const agentsSourceDir = projection.agents?.sourceDir ?? options.agentsSourceDir ?? options.context?.codexAgentsSourceDir;
  const hooksSourceFile = projection.hooks?.sourceFile ?? options.hooksSourceFile ?? options.context?.codexHooksSourceFile;
  const hooksSourceDir = projection.hooks?.sourceHooksDir ?? options.hooksSourceDir ?? options.context?.codexHooksSourceDir;
  const hooksConfig = projection.hooks?.config ?? options.hooksConfig;
  const hooksTrusted = projection.hooks?.trusted ?? options.hooksTrusted;
  return { configResources, mcpCatalog, selectedMcp, agentsSourceDir, hooksSourceFile, hooksSourceDir, hooksConfig, hooksTrusted };
}

function planConfigComponent({ native, neutralResources, context, configFile, removing }) {
  if (native.configResources === undefined) return undefined;
  const managedResources = nativeManagedResources(neutralResources, context, { kind: 'configuration-entry', target: configFile });
  const component = planCodexConfig({ file: configFile, scope: context.scope, managedResources, desiredResources: removing ? [] : native.configResources });
  component.scope = context.scope;
  component.desiredResources = removing ? [] : native.configResources;
  // The next ledger intentionally omits a removed record. Keep the pre-plan
  // ownership proof solely for apply's immediate replan over the current file.
  component.reconciliationManagedResources = managedResources;
  return component;
}

function planMcpComponent({ native, neutralResources, context, configFile, removing, options }) {
  if (native.selectedMcp === undefined) return undefined;
  const catalog = nativeMcpCatalog(native.mcpCatalog);
  const managedResources = nativeManagedResources(neutralResources, context, { kind: 'mcp-server', target: configFile });
  return planCodexMcp({ file: configFile, scope: context.scope, managedResources, selected: removing ? [] : native.selectedMcp,
    ...catalog, sourceVersion: options.sourceVersion ?? options.context?.sourceVersion, recoveryPoint: options.recoveryPoint });
}

/** Codex hooks.json is only replaced when the file on disk still matches the ledger's last-known
 * fingerprint — a foreign edit (or a record the ledger never owned) downgrades an otherwise-clean
 * plan to a conflict rather than silently overwriting it. */
function planHooksComponent({ native, neutralResources, context }) {
  let hooks = planCodexHooks({ config: native.hooksConfig, sourceFile: native.hooksSourceFile,
    sourceHooksDir: native.hooksSourceDir, trusted: native.hooksTrusted, destinationContext: context });
  const hooksFile = hooks.destination;
  if (hooks.ok && fs.existsSync(hooksFile)) {
    const [record] = nativeManagedResources(neutralResources, context, { kind: 'hooks-file', target: hooksFile });
    const current = sha256(fs.readFileSync(hooksFile, 'utf8'));
    if (!record) {
      hooks = { ...hooks, ok: false, status: 'conflict', changes: [], errors: ['Codex hooks.json exists but is not owned by the neutral ledger'] };
    } else if (record.fingerprint !== current) {
      hooks = { ...hooks, ok: false, status: 'conflict', changes: [], errors: ['Codex hooks.json was modified outside DoFlow'] };
    }
  }
  return hooks;
}

/** Agents/hooks share one removing-vs-planning fork: removal always owns both via the neutral
 * ledger's own records, regardless of what native input the caller provided this run. */
function planAgentsAndHooksComponents({ native, neutralResources, context, agentsDirectory, removing, options }) {
  if (removing) {
    return {
      agents: ownedRemovalPlan(neutralResources, context, 'custom-agent', agentsDirectory),
      hooks: ownedRemovalPlan(neutralResources, context, 'hooks-file'),
    };
  }
  const components = {};
  if (native.agentsSourceDir !== undefined) {
    const managedResources = nativeManagedResources(neutralResources, context, { kind: 'custom-agent', directory: agentsDirectory });
    components.agents = planCodexAgents({ ...context, managedResources, sourceDir: native.agentsSourceDir, sourceVersion: options.sourceVersion ?? options.context?.sourceVersion });
  }
  if (native.hooksSourceFile !== undefined || native.hooksConfig !== undefined) {
    components.hooks = planHooksComponent({ native, neutralResources, context });
  }
  return components;
}

/**
 * Compose native, non-mutating plans. Callers opt into a component by providing
 * its desired input, which prevents a generic plan from accidentally removing
 * an owned configuration entry or MCP server merely because it was omitted.
 */
function plan(options) {
  const context = nativeContext(options);
  const neutralResources = options.managedResources || options.ledger?.resources || [];
  const native = projectedNativeOptions(options);
  const configFile = configPath(context);
  const agentsDirectory = agentDirectory(context);
  const removing = options.context?.operation === 'remove';
  const components = {};
  const configComponent = planConfigComponent({ native, neutralResources, context, configFile, removing });
  if (configComponent) components.config = configComponent;
  const mcpComponent = planMcpComponent({ native, neutralResources, context, configFile, removing, options });
  if (mcpComponent) components.mcp = mcpComponent;
  Object.assign(components, planAgentsAndHooksComponents({ native, neutralResources, context, agentsDirectory, removing, options }));
  const copyTree = planCopyTreeAssets({ assets: options.assets, context, neutralResources, removing,
    repoRoot: options.context?.repoRoot, sourceVersion: options.sourceVersion ?? options.context?.sourceVersion });
  const instructions = planInstructionsAsset({ assets: options.assets, context, removing, repoRoot: options.context?.repoRoot });
  // Two pseudo-components: their changes are already in final adapter shape (unlike the other
  // components' native shape, which addChanges() below converts), so they're appended to `changes`
  // directly rather than run through addChanges. Registering them in `components` still gets their
  // conflicts picked up by both the existing `failures` reduction and the lifecycle's own
  // adapterConflicts() component scan, with no special-casing needed in either.
  components.copyTree = { ok: copyTree.conflicts.length === 0, conflicts: copyTree.conflicts };
  components.instructions = { ok: instructions.conflicts.length === 0, conflicts: instructions.conflicts };
  const failures = Object.entries(components).filter(([, component]) => !component.ok);
  const changes = [];
  addChanges(changes, assetIdFor(options, 'config'), components.config, 'config');
  addChanges(changes, assetIdFor(options, 'mcp'), components.mcp, 'mcp');
  addChanges(changes, assetIdFor(options, 'agents'), components.agents, 'agents');
  addChanges(changes, assetIdFor(options, 'hooks'), components.hooks, 'hooks');
  changes.push(...copyTree.changes, ...instructions.changes);
  const requiredNativeResources = [
    ...Object.entries(components).flatMap(([component, result]) => (result.changes || []).map((change) => ({
      harness: HARNESS, component, target: change.target ?? change.file ?? result.file ?? result.destination ?? result.directory,
      operation: change.operation ?? change.type, identity: change.identity ?? null,
    }))),
    ...copyTree.changes.map((change) => ({ harness: HARNESS, component: 'copyTree', target: change.target, operation: change.operation, identity: change.identity })),
    ...instructions.changes.map((change) => ({ harness: HARNESS, component: 'instructions', target: change.target, operation: change.operation, identity: change.identity })),
  ];
  return { harness: HARNESS, scope: options.scope, ok: failures.length === 0, safe: failures.length === 0, components, failures, changes, requiredNativeResources };
}

/** Apply only native plans emitted by this adapter. MCP is first because it and
 * config.toml share a file; config is then re-planned over the MCP result so it
 * cannot overwrite an adjacent MCP table. */
function apply({ changes = [], dryRun = false, scope, sourceVersion, recoveryRef } = {}) {
  const components = new Map();
  for (const change of changes) if (change?.nativeComponent && change.nativePlan) components.set(change.nativeComponent, change.nativePlan);
  let mcp = components.get('mcp');
  if (mcp) mcp = applyCodexMcp(mcp, { dryRun });
  let config = components.get('config');
  if (config) {
    const managedResources = mcp
      ? [...(config.reconciliationManagedResources ?? config.managedResources ?? []), ...(mcp.managedResources ?? [])]
      : null;
    const replan = managedResources ? planCodexConfig({ file: config.file, scope: config.scope, managedResources,
      desiredResources: config.desiredResources ?? [] }) : config;
    config = applyCodexConfig(replan, { dryRun });
  }
  const agentsPlan = components.get('agents'); const hooksPlan = components.get('hooks');
  const agents = agentsPlan && !agentsPlan.directRemove ? applyCodexAgents(agentsPlan, { dryRun }) : null;
  const hooks = hooksPlan && !hooksPlan.directRemove ? deployCodexHooks(hooksPlan, { dryRun }) : null;
  // applyCopyTreeAssets/applyInstructionsAsset already filter to non-remove operations, so calling
  // them unconditionally here (including when apply() is invoked from remove(), below) is safe.
  const copyTreeApplied = dryRun ? 0 : applyCopyTreeAssets(changes);
  if (!dryRun) applyInstructionsAsset(changes);
  const nativeComponents = { mcp, config, agents, hooks };
  return { harness: HARNESS, applied: [mcp, config, agents, hooks].filter((result) => result?.applied).length + copyTreeApplied,
    components: nativeComponents, resources: resourcesFromApplied({ components: nativeComponents, scope: scope ?? 'project', sourceVersion, recoveryRef }) };
}

/** Removal reuses the same fingerprint-checked native plans. Only config/MCP
 * plans generated with context.operation=remove contain safe removals; hooks
 * and agents are intentionally never blindly deleted. */
function remove({ changes = [], dryRun = false } = {}) {
  const result = apply({ changes, dryRun });
  const direct = new Map();
  for (const change of changes) if (change?.nativePlan?.directRemove) direct.set(change.target, change);
  for (const change of direct.values()) {
    if (!fs.existsSync(change.target)) continue;
    const current = sha256(fs.readFileSync(change.target, 'utf8'));
    if (current !== change.fingerprint) throw new Error(`Refusing to remove modified Codex resource '${change.identity}'`);
    if (!dryRun) fs.unlinkSync(change.target);
  }
  if (!dryRun) { removeCopyTreeAssets(changes); removeInstructionsAsset(changes); }
  return { ...result, removed: changes.filter((change) => (change.operation ?? change.type) === 'remove').length };
}

function verifyConfigResources({ native, parsed, context, options, sourceVersion, recoveryRef }) {
  const statuses = []; const resources = [];
  for (const resource of native.configResources || []) {
    const entry = parsed?.entries.get(resource.identity);
    const status = entry && configFingerprint(entry.value) === configFingerprint(resource.value) ? 'managed' : 'missing';
    statuses.push({ assetId: assetIdFor(options, 'config'), capability: 'settings', status, identity: resource.identity,
      ownershipIdentity: ownershipIdentity('config', resource.identity), target: configPath(context) });
    if (status === 'managed') resources.push(lifecycleResource({ scope: options.scope, assetId: assetIdFor(options, 'config'), kind: 'configuration-entry', identity: resource.identity,
      target: configPath(context), fingerprint: configFingerprint(entry.value), sourceVersion, recoveryRef, projection: { renderer: 'codex-config' } }));
  }
  return { statuses, resources };
}

function verifyMcpResources({ native, configText, context, options, sourceVersion, recoveryRef }) {
  const statuses = []; const resources = [];
  const catalog = nativeMcpCatalog(native.mcpCatalog);
  for (const id of native.selectedMcp || []) {
    const definition = catalog.serverDefs[id];
    const header = `[mcp_servers.${id}]`;
    const present = Boolean(definition && configText.includes(header));
    statuses.push({ assetId: assetIdFor(options, 'mcp'), capability: 'mcp', status: present ? 'managed' : 'missing', identity: id,
      ownershipIdentity: ownershipIdentity('mcp', id), target: configPath(context) });
    if (present) resources.push(lifecycleResource({ scope: options.scope, assetId: assetIdFor(options, 'mcp'), kind: 'mcp-server', identity: id,
      target: configPath(context), fingerprint: configFingerprint(renderServer(id, definition)), sourceVersion, recoveryRef,
      projection: { renderer: 'codex-mcp' } }));
  }
  return { statuses, resources };
}

function verifyAgentResources({ native, context, options, sourceVersion, recoveryRef }) {
  const statuses = []; const resources = [];
  if (!native.agentsSourceDir) return { statuses, resources };
  for (const agent of discoverCodexAgents(native.agentsSourceDir)) {
    const target = path.join(agentDirectory(context), agent.fileName);
    const present = fs.existsSync(target) && fs.readFileSync(target, 'utf8') === agent.source;
    const identity = `agent:${agent.name}`;
    statuses.push({ assetId: assetIdFor(options, 'agents'), capability: 'agents', status: present ? 'managed' : 'missing', identity,
      ownershipIdentity: ownershipIdentity('agents', identity), target });
    if (present) resources.push(lifecycleResource({ scope: options.scope, assetId: assetIdFor(options, 'agents'), kind: 'custom-agent', identity: `agent:${agent.name}`,
      target, fingerprint: agent.fingerprint, sourceVersion, recoveryRef, projection: { renderer: 'codex-agent' } }));
  }
  return { statuses, resources };
}

function verifyHooksResource({ native, context, options, sourceVersion, recoveryRef }) {
  const statuses = []; const resources = []; const conflicts = [];
  if (!native.hooksSourceFile && !native.hooksConfig) return { statuses, resources, conflicts };
  const hooks = planCodexHooks({ config: native.hooksConfig, sourceFile: native.hooksSourceFile, sourceHooksDir: native.hooksSourceDir,
    trusted: native.hooksTrusted, destinationContext: context });
  const status = hooks.ok && hooks.status === 'unchanged' ? 'managed' : (hooks.ok ? 'missing' : 'conflict');
  statuses.push({ assetId: assetIdFor(options, 'hooks'), capability: 'hooks', status, identity: 'hooks.json',
    ownershipIdentity: ownershipIdentity('hooks', 'hooks.json'), target: hooks.destination });
  if (!hooks.ok) conflicts.push(...hooks.errors);
  if (status === 'managed') resources.push(lifecycleResource({ scope: options.scope, assetId: assetIdFor(options, 'hooks'), kind: 'hooks-file', identity: 'hooks.json',
    target: hooks.destination, fingerprint: sha256(fs.readFileSync(hooks.destination, 'utf8')), sourceVersion, recoveryRef, projection: { renderer: 'codex-hooks' } }));
  return { statuses, resources, conflicts };
}

function verifyAssetRenderStatuses({ registry, assets }) {
  return assets.map((asset) => render({ registry, asset })).filter((rendered) => rendered.status !== 'renderable');
}

function verify(options = {}) {
  const { registry, assets = [], plan: proposed } = options;
  const context = nativeContext(options);
  const native = projectedNativeOptions(options);
  const sourceVersion = options.sourceVersion ?? options.context?.sourceVersion;
  const recoveryRef = options.recoveryRef;
  let configText = '';
  if (fs.existsSync(configPath(context))) configText = fs.readFileSync(configPath(context), 'utf8');
  let parsed;
  const conflicts = [];
  try { parsed = parseToml(configText); } catch (error) { conflicts.push(`Malformed Codex config: ${error.message}`); }

  const shared = { context, options, sourceVersion, recoveryRef };
  const config = verifyConfigResources({ native, parsed, ...shared });
  const mcp = verifyMcpResources({ native, configText, ...shared });
  const agents = verifyAgentResources({ native, ...shared });
  const hooks = verifyHooksResource({ native, ...shared });
  const copyTree = verifyCopyTreeAssets({ assets, context, repoRoot: options.context?.repoRoot, sourceVersion });
  const instructions = verifyInstructionsAsset({ assets, context, repoRoot: options.context?.repoRoot });

  const statuses = [
    ...config.statuses, ...mcp.statuses, ...agents.statuses, ...hooks.statuses,
    ...verifyAssetRenderStatuses({ registry, assets }),
    ...copyTree.statuses, ...instructions.statuses,
  ];
  const resources = [...config.resources, ...mcp.resources, ...agents.resources, ...hooks.resources, ...copyTree.resources, ...instructions.resources];
  conflicts.push(...hooks.conflicts, ...copyTree.conflicts);
  const componentFailures = Object.values(proposed?.components || {}).filter((component) => !component.ok);
  for (const component of componentFailures) conflicts.push(...(component.conflicts || component.errors || []));

  return { ok: conflicts.length === 0 && statuses.every((status) => status.status !== 'missing' && status.status !== 'conflict'), resources, statuses, conflicts };
}

module.exports = { HARNESS, normalizeContext, nativeContext, projectedNativeOptions, nativeManagedResources, ownershipIdentity, discover, render, plan, apply, remove, verify };
