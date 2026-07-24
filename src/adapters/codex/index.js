'use strict';

// Codex adapter boundary. Native parsing and mutation remain in the existing
// codex-* modules; this module composes their non-mutating plans into the
// common adapter shape without changing legacy CLI ownership.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { configPath, fingerprint: configFingerprint, parseToml, planCodexConfig, applyCodexConfig } = require('../../codex-config');
const { readCodexMcpCatalog, renderServer, planCodexMcp, applyCodexMcp } = require('../../codex-mcp');
const { agentDirectory, discoverCodexAgents, planCodexAgents, applyCodexAgents } = require('../../codex-agents');
const { planCodexHooks, deployCodexHooks } = require('../../codex-hooks');

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
  return assets.find((asset) => asset.id === 'guidance.core')?.id ?? assets[0]?.id ?? `codex.${componentName}`;
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

function nativeMcpCatalog(servers = []) {
  const allServers = servers.map((server) => server.id);
  const serverDefs = Object.fromEntries(servers.map((server) => [server.id, {
    command: server.command,
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.url ? { url: server.url } : {}),
  }]));
  return { allServers, serverDefs };
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

function resourcesFromApplied({ components, scope, sourceVersion, recoveryRef }) {
  const resources = [];
  const config = components.config;
  for (const record of config?.managedResources || []) {
    if (record.kind !== 'configuration-entry' && record.kind !== 'config-entry') continue;
    resources.push(lifecycleResource({ scope, assetId: 'guidance.core', kind: 'configuration-entry', identity: record.identity,
      target: config.file, fingerprint: record.fingerprint, sourceVersion: record.sourceVersion ?? sourceVersion, recoveryRef,
      projection: { renderer: 'codex-config' } }));
  }
  const mcp = components.mcp;
  for (const record of mcp?.managedResources || []) {
    if (record.kind !== 'mcp-server') continue;
    resources.push(lifecycleResource({ scope, assetId: 'guidance.core', kind: 'mcp-server', identity: record.identity,
      target: mcp.file, fingerprint: record.fingerprint, sourceVersion: record.sourceVersion ?? sourceVersion, selection: record.selection, recoveryRef,
      projection: { renderer: 'codex-mcp' } }));
  }
  const agents = components.agents;
  for (const record of agents?.managedResources || []) {
    if (record.kind !== 'custom-agent') continue;
    const name = record.identity.replace(/^agent:/, '');
    resources.push(lifecycleResource({ scope, assetId: 'agents.shared', kind: 'custom-agent', identity: record.identity,
      target: path.join(agents.directory, `${name}.toml`), fingerprint: record.fingerprint, sourceVersion: record.sourceVersion ?? sourceVersion, recoveryRef,
      projection: { renderer: 'codex-agent' } }));
  }
  const hooks = components.hooks;
  if (hooks?.applied && hooks.destination) resources.push(lifecycleResource({ scope, assetId: 'guidance.core', kind: 'hooks-file', identity: 'hooks.json',
    target: hooks.destination, fingerprint: sha256(fs.readFileSync(hooks.destination, 'utf8')), sourceVersion, recoveryRef,
    projection: { renderer: 'codex-hooks' } }));
  return resources;
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
  const components = {};
  const removing = options.context?.operation === 'remove';
  if (native.configResources !== undefined) {
    const managedResources = nativeManagedResources(neutralResources, context, { kind: 'configuration-entry', target: configFile });
    components.config = planCodexConfig({ file: configFile, scope: context.scope, managedResources, desiredResources: removing ? [] : native.configResources });
    components.config.scope = context.scope;
    components.config.desiredResources = removing ? [] : native.configResources;
    // The next ledger intentionally omits a removed record. Keep the pre-plan
    // ownership proof solely for apply's immediate replan over the current file.
    components.config.reconciliationManagedResources = managedResources;
  }
  if (native.selectedMcp !== undefined) {
    const catalog = options.mcpCatalogFile ? readCodexMcpCatalog(options.mcpCatalogFile) : nativeMcpCatalog(native.mcpCatalog);
    const managedResources = nativeManagedResources(neutralResources, context, { kind: 'mcp-server', target: configFile });
    components.mcp = planCodexMcp({ file: configFile, scope: context.scope, managedResources, selected: removing ? [] : native.selectedMcp,
      ...catalog, sourceVersion: options.sourceVersion ?? options.context?.sourceVersion, recoveryPoint: options.recoveryPoint });
  }
  if (removing) {
    components.agents = ownedRemovalPlan(neutralResources, context, 'custom-agent', agentsDirectory);
    components.hooks = ownedRemovalPlan(neutralResources, context, 'hooks-file');
  } else if (native.agentsSourceDir !== undefined) {
    const managedResources = nativeManagedResources(neutralResources, context, { kind: 'custom-agent', directory: agentsDirectory });
    components.agents = planCodexAgents({ ...context, managedResources, sourceDir: native.agentsSourceDir, sourceVersion: options.sourceVersion ?? options.context?.sourceVersion });
  }
  if (!removing && (native.hooksSourceFile !== undefined || native.hooksConfig !== undefined)) {
    components.hooks = planCodexHooks({ config: native.hooksConfig, sourceFile: native.hooksSourceFile,
      sourceHooksDir: native.hooksSourceDir, trusted: native.hooksTrusted, destinationContext: context });
    const hooksFile = components.hooks.destination;
    const hookRecords = nativeManagedResources(neutralResources, context, { kind: 'hooks-file', target: hooksFile });
    if (components.hooks.ok && fs.existsSync(hooksFile)) {
      const record = hookRecords[0];
      const current = sha256(fs.readFileSync(hooksFile, 'utf8'));
      if (!record) {
        components.hooks = { ...components.hooks, ok: false, status: 'conflict', changes: [], errors: ['Codex hooks.json exists but is not owned by the neutral ledger'] };
      } else if (record.fingerprint !== current) {
        components.hooks = { ...components.hooks, ok: false, status: 'conflict', changes: [], errors: ['Codex hooks.json was modified outside DoFlow'] };
      }
    }
  }
  const failures = Object.entries(components).filter(([, component]) => !component.ok);
  const changes = [];
  addChanges(changes, assetIdFor(options, 'config'), components.config, 'config');
  addChanges(changes, assetIdFor(options, 'mcp'), components.mcp, 'mcp');
  addChanges(changes, assetIdFor(options, 'agents'), components.agents, 'agents');
  addChanges(changes, assetIdFor(options, 'hooks'), components.hooks, 'hooks');
  const requiredNativeResources = Object.entries(components).flatMap(([component, result]) => (result.changes || []).map((change) => ({
    harness: HARNESS, component, target: change.target ?? change.file ?? result.file ?? result.destination ?? result.directory,
    operation: change.operation ?? change.type, identity: change.identity ?? null,
  })));
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
  const nativeComponents = { mcp, config, agents, hooks };
  return { harness: HARNESS, applied: [mcp, config, agents, hooks].filter((result) => result?.applied).length,
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
  return { ...result, removed: changes.filter((change) => (change.operation ?? change.type) === 'remove').length };
}

function verify(options = {}) {
  const { registry, assets = [], discovery: found, plan: proposed } = options;
  const context = nativeContext(options);
  const native = projectedNativeOptions(options);
  const discovery = found || discover(options);
  const statuses = []; const resources = []; const conflicts = [];
  const sourceVersion = options.sourceVersion ?? options.context?.sourceVersion;
  const recoveryRef = options.recoveryRef;
  let configText = '';
  if (fs.existsSync(configPath(context))) configText = fs.readFileSync(configPath(context), 'utf8');
  let parsed;
  try { parsed = parseToml(configText); } catch (error) { conflicts.push(`Malformed Codex config: ${error.message}`); }
  for (const resource of native.configResources || []) {
    const entry = parsed?.entries.get(resource.identity);
    const status = entry && configFingerprint(entry.value) === configFingerprint(resource.value) ? 'managed' : 'missing';
    statuses.push({ assetId: assetIdFor(options, 'config'), capability: 'settings', status, identity: resource.identity,
      ownershipIdentity: ownershipIdentity('config', resource.identity), target: configPath(context) });
    if (status === 'managed') resources.push(lifecycleResource({ scope: options.scope, assetId: assetIdFor(options, 'config'), kind: 'configuration-entry', identity: resource.identity,
      target: configPath(context), fingerprint: configFingerprint(entry.value), sourceVersion, recoveryRef, projection: { renderer: 'codex-config' } }));
  }
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
  if (native.agentsSourceDir) {
    for (const agent of discoverCodexAgents(native.agentsSourceDir)) {
      const target = path.join(agentDirectory(context), agent.fileName);
      const present = fs.existsSync(target) && fs.readFileSync(target, 'utf8') === agent.source;
      const identity = `agent:${agent.name}`;
      statuses.push({ assetId: assetIdFor(options, 'agents'), capability: 'agents', status: present ? 'managed' : 'missing', identity,
        ownershipIdentity: ownershipIdentity('agents', identity), target });
      if (present) resources.push(lifecycleResource({ scope: options.scope, assetId: assetIdFor(options, 'agents'), kind: 'custom-agent', identity: `agent:${agent.name}`,
        target, fingerprint: agent.fingerprint, sourceVersion, recoveryRef, projection: { renderer: 'codex-agent' } }));
    }
  }
  if (native.hooksSourceFile || native.hooksConfig) {
    const hooks = planCodexHooks({ config: native.hooksConfig, sourceFile: native.hooksSourceFile, sourceHooksDir: native.hooksSourceDir,
      trusted: native.hooksTrusted, destinationContext: context });
    const status = hooks.ok && hooks.status === 'unchanged' ? 'managed' : (hooks.ok ? 'missing' : 'conflict');
    statuses.push({ assetId: assetIdFor(options, 'hooks'), capability: 'hooks', status, identity: 'hooks.json',
      ownershipIdentity: ownershipIdentity('hooks', 'hooks.json'), target: hooks.destination });
    if (!hooks.ok) conflicts.push(...hooks.errors);
    if (status === 'managed') resources.push(lifecycleResource({ scope: options.scope, assetId: assetIdFor(options, 'hooks'), kind: 'hooks-file', identity: 'hooks.json',
      target: hooks.destination, fingerprint: sha256(fs.readFileSync(hooks.destination, 'utf8')), sourceVersion, recoveryRef, projection: { renderer: 'codex-hooks' } }));
  }
  for (const asset of assets) {
    const rendered = render({ registry, asset });
    if (rendered.status !== 'renderable') statuses.push(rendered);
  }
  const componentFailures = Object.values(proposed?.components || {}).filter((component) => !component.ok);
  for (const component of componentFailures) conflicts.push(...(component.conflicts || component.errors || []));
  return { ok: conflicts.length === 0 && statuses.every((status) => status.status !== 'missing' && status.status !== 'conflict'), resources, statuses, conflicts };
}

module.exports = { HARNESS, normalizeContext, nativeContext, projectedNativeOptions, nativeManagedResources, ownershipIdentity, discover, render, plan, apply, remove, verify };
