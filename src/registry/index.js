'use strict';

// Registry loader and validator.  Registry files deliberately use JSON syntax in
// .yaml files: JSON is a YAML subset, so this is dependency-free while retaining
// a future-compatible declarative file extension.  Do not add a permissive YAML
// parser here; accepting partial/ambiguous YAML would make safety validation less
// reliable than failing with an actionable conversion message.
const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_FILES = Object.freeze({
  harnesses: 'harnesses.yaml',
  assets: 'assets.yaml',
  mcp: 'mcp.yaml',
  lifecycle: 'lifecycle.yaml',
  contracts: 'contracts.yaml',
  externalTools: 'external-tools.yaml',
  models: 'models.yaml',
});
const CAPABILITY_STATUS = new Set(['supported', 'different', 'unavailable']);
const SCOPES = new Set(['project', 'user']);
const MCP_TRANSPORTS = new Set(['stdio', 'http', 'sse']);
const EXTERNAL_TOOL_IDS = new Set(['rtk', 'graphify', 'semble']);
const EXTERNAL_TOOL_ACTIONS = new Set(['install', 'update', 'uninstall']);
const MODEL_KINDS = new Set(['hosted', 'local']);

function issue(errors, location, message) { errors.push(`${location}: ${message}`); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function idsUnique(items, label, errors) {
  const seen = new Set();
  for (const item of items || []) {
    if (!object(item) || typeof item.id !== 'string' || !item.id) continue;
    if (seen.has(item.id)) issue(errors, label, `duplicate id '${item.id}'`);
    seen.add(item.id);
  }
}

function parseRegistryFile(file, fsImpl = fs) {
  let text;
  try { text = fsImpl.readFileSync(file, 'utf8'); } catch (error) {
    throw new Error(`Could not read registry file '${file}': ${error.message}`);
  }
  try { return JSON.parse(text); } catch (error) {
    throw new Error(`Registry file '${file}' must use JSON-compatible YAML (valid JSON in a .yaml file): ${error.message}`);
  }
}

function registryDir(repoRoot) { return path.join(path.resolve(repoRoot), 'core', 'registry'); }

function loadRegistry({ repoRoot, dir, fsImpl = fs } = {}) {
  if (!repoRoot && !dir) throw new Error('loadRegistry requires repoRoot or dir');
  const base = dir ? path.resolve(dir) : registryDir(repoRoot);
  const loaded = {};
  for (const [name, fileName] of Object.entries(REGISTRY_FILES)) {
    loaded[name] = parseRegistryFile(path.join(base, fileName), fsImpl);
  }
  const registry = {
    directory: base,
    repoRoot: repoRoot ? path.resolve(repoRoot) : path.resolve(base, '..', '..'),
    harnesses: loaded.harnesses.harnesses,
    assets: loaded.assets.assets,
    mcp: loaded.mcp.servers,
    lifecycle: loaded.lifecycle.policies,
    contracts: loaded.contracts.contracts,
    externalTools: loaded.externalTools.tools,
    modelProviders: loaded.models.providers,
    modelRoles: loaded.models.roles,
    versions: Object.fromEntries(Object.entries(loaded).map(([name, value]) => [name, value.version])),
  };
  const validation = validateRegistry(registry, { repoRoot: registry.repoRoot, fsImpl });
  if (!validation.ok) {
    const error = new Error(`Invalid DoFlow registry:\n- ${validation.errors.join('\n- ')}`);
    error.validation = validation;
    throw error;
  }
  return Object.freeze({ ...registry, validation });
}

const CONTRACT_COMPLETENESS = new Set(['verified', 'lower-bound']);

/** Validates core/registry/contracts.yaml — what each harness ACCEPTS (legal frontmatter fields,
 * legal hook event names), kept separate from harnesses.yaml's what-DoFlow-SUPPORTS. The split is
 * what keeps the registry-truth guard from validating the registry against itself.
 *
 * `evidence` is required for the same reason capabilities require it: a contract claim with no
 * citation is folklore, and these lists are copied from vendor documentation that moves. */
function validateContract(value, location, errors, harnessIds) {
  if (!object(value)) { issue(errors, location, 'must be an object'); return; }
  if (typeof value.harness !== 'string' || !harnessIds.has(value.harness)) {
    issue(errors, location, `harness must be one of: ${[...harnessIds].join(', ')}`);
  }
  if (!CONTRACT_COMPLETENESS.has(value.completeness)) {
    issue(errors, location, 'completeness must be verified or lower-bound');
  }
  // skillFields/agentFields are optional: shared skills and agent specs are byte-identical across
  // harnesses, so a per-harness field list is necessarily a subset of the union and cannot change
  // any guard outcome. Declaring one anyway would restate an unverified claim as fact — the exact
  // shape of inert declaration these guards exist to remove. hookEvents is required because those
  // genuinely differ per harness and G5 reads them.
  for (const field of ['skillFields', 'agentFields']) {
    if (value[field] === undefined) continue;
    const list = value[field];
    if (!Array.isArray(list) || list.length === 0 || list.some((item) => typeof item !== 'string' || !item)) {
      issue(errors, `${location}.${field}`, 'must be a non-empty array of non-empty strings when present');
      continue;
    }
    if (new Set(list).size !== list.length) issue(errors, `${location}.${field}`, 'must not contain duplicates');
  }
  // An empty hookEvents used to be rejected outright, which assumed every harness wires at least one
  // hook. OpenCode and Pi break that: both implement lifecycle handlers as JS/TS code modules, so
  // DoFlow's shell hooks have nothing to attach to and it wires none. Forcing a non-empty list there
  // would mean declaring a hook DoFlow does not install — an inert claim of exactly the kind these
  // guards exist to remove. Empty is therefore allowed, but only with a note, so the distinction
  // between "wires nothing, deliberately" and "nobody filled this in" stays visible.
  const events = value.hookEvents;
  const noted = typeof value.note === 'string' && value.note.trim().length > 0;
  if (!Array.isArray(events) || events.some((item) => typeof item !== 'string' || !item)) {
    issue(errors, `${location}.hookEvents`, 'must be an array of non-empty strings');
  } else if (events.length === 0 && !noted) {
    issue(errors, `${location}.hookEvents`, 'may only be empty when `note` explains why no hook is wired');
  } else if (new Set(events).size !== events.length) {
    issue(errors, `${location}.hookEvents`, 'must not contain duplicates');
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0
    || value.evidence.some((url) => typeof url !== 'string' || !/^https:\/\//.test(url))) {
    issue(errors, location, 'must include one or more HTTPS evidence URLs');
  }
}

function validateCapability(value, location, errors) {
  if (!object(value)) { issue(errors, location, 'must be an object'); return; }
  if (!CAPABILITY_STATUS.has(value.status)) issue(errors, location, 'status must be supported, different, or unavailable');
  if (!Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.some((url) => typeof url !== 'string' || !/^https:\/\//.test(url))) {
    issue(errors, location, 'must include one or more HTTPS evidence URLs');
  }
  if (typeof value.verification !== 'string' || !value.verification.trim()) issue(errors, location, 'requires a verification instruction');
  if (value.prerequisites !== undefined && (!Array.isArray(value.prerequisites) || value.prerequisites.some((item) => typeof item !== 'string' || !item))) {
    issue(errors, location, 'prerequisites must be an array of non-empty strings');
  }
  // Optional per-event detail, reusing the same three-value status vocabulary. Additive on
  // purpose: a capability without it keeps today's coarse behaviour, so harnesses migrate one at
  // a time instead of all three needing per-event data before any of them can have it.
  if (value.events !== undefined) {
    if (!object(value.events) || Object.keys(value.events).length === 0) {
      issue(errors, `${location}.events`, 'must be a non-empty object when present');
    } else {
      for (const [event, detail] of Object.entries(value.events)) {
        if (!/^[A-Z][A-Za-z]*$/.test(event)) issue(errors, `${location}.events`, `invalid event name '${event}'`);
        if (!object(detail) || !CAPABILITY_STATUS.has(detail.status)) {
          issue(errors, `${location}.events.${event}`, 'status must be supported, different, or unavailable');
        }
        if (detail?.note !== undefined && (typeof detail.note !== 'string' || !detail.note.trim())) {
          issue(errors, `${location}.events.${event}`, 'note must be a non-empty string when present');
        }
      }
    }
  }
}

function validateSource(repoRoot, source, location, errors, fsImpl, expected = 'any') {
  if (typeof source !== 'string' || !source.trim()) { issue(errors, location, 'requires a repository-relative source'); return; }
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, source);
  if (!resolved.startsWith(`${root}${path.sep}`) || !fsImpl.existsSync(resolved)) { issue(errors, location, `source does not exist inside repository: ${source}`); return; }
  if (expected === 'file' && !fsImpl.statSync(resolved).isFile()) issue(errors, location, `source must be a file: ${source}`);
  if (expected === 'directory' && !fsImpl.statSync(resolved).isDirectory()) issue(errors, location, `source must be a directory: ${source}`);
}

function validateNativeProjection(projection, harness, { repoRoot, fsImpl }, errors) {
  const at = `harness '${harness.id}' nativeProjection`;
  if (!object(projection)) { issue(errors, at, 'must be an object'); return; }
  const config = projection.config;
  if (!object(config)) issue(errors, at, 'requires config declaration');
  else {
    validateSource(repoRoot, config.source, `${at} config`, errors, fsImpl, 'file');
    if (!Array.isArray(config.resources) || !config.resources.length) issue(errors, `${at} config`, 'requires non-empty resources');
    for (const resource of config.resources || []) {
      if (!object(resource) || resource.kind !== 'configuration-entry' || typeof resource.identity !== 'string' || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(resource.identity) || !Object.hasOwn(resource, 'value')) {
        issue(errors, `${at} config`, 'resources require kind configuration-entry, dotted identity, and value');
      }
    }
  }
  const mcp = projection.mcp;
  if (!object(mcp) || mcp.catalog !== 'registry.mcp' || !['optional', 'required'].includes(mcp.selection)) issue(errors, `${at} mcp`, 'requires catalog registry.mcp and optional/required selection');
  const agents = projection.agents;
  if (!object(agents)) issue(errors, `${at} agents`, 'requires agents declaration');
  else validateSource(repoRoot, agents.source, `${at} agents`, errors, fsImpl, 'directory');
  const hooks = projection.hooks;
  if (!object(hooks)) issue(errors, `${at} hooks`, 'requires hooks declaration');
  else {
    validateSource(repoRoot, hooks.configSource, `${at} hooks`, errors, fsImpl, 'file');
    validateSource(repoRoot, hooks.scriptsSource, `${at} hooks`, errors, fsImpl, 'directory');
    if (typeof hooks.trusted !== 'boolean') issue(errors, `${at} hooks`, 'trusted must be boolean');
  }
}

function validateCommand(command, location, errors) {
  if (!Array.isArray(command) || command.length === 0
    || command.some((argument) => typeof argument !== 'string' || !argument.trim())) {
    issue(errors, location, 'command must be a non-empty array of non-empty strings');
  }
}

function validateExternalTool(value, location, errors) {
  if (!object(value)) { issue(errors, location, 'must be an object'); return; }
  const allowed = new Set(['id', 'displayName', 'officialEvidence', 'status', 'install', 'update', 'uninstall', 'prerequisites']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(errors, location, `unsupported field '${key}'`);
  }
  if (typeof value.id !== 'string' || !EXTERNAL_TOOL_IDS.has(value.id)) {
    issue(errors, location, `id must be one of: ${[...EXTERNAL_TOOL_IDS].join(', ')}`);
  }
  if (typeof value.displayName !== 'string' || !value.displayName.trim()) issue(errors, location, 'requires displayName');
  if (!Array.isArray(value.officialEvidence) || value.officialEvidence.length === 0
    || value.officialEvidence.some((url) => typeof url !== 'string' || !/^https:\/\//.test(url))) {
    issue(errors, location, 'must include one or more HTTPS officialEvidence URLs');
  }
  if (value.prerequisites !== undefined && (!Array.isArray(value.prerequisites)
    || value.prerequisites.some((item) => typeof item !== 'string' || !item.trim())
    || new Set(value.prerequisites).size !== value.prerequisites.length)) {
    issue(errors, location, 'prerequisites must be an array of unique non-empty strings when present');
  }
  if (!object(value.status) || !Array.isArray(value.status.commands) || value.status.commands.length === 0) {
    issue(errors, location, 'requires status.commands as a non-empty array of command arrays');
  } else {
    const allowedStatus = new Set(['commands']);
    for (const key of Object.keys(value.status)) {
      if (!allowedStatus.has(key)) issue(errors, `${location}.status`, `unsupported field '${key}'`);
    }
    value.status.commands.forEach((command, index) => validateCommand(command, `${location}.status.commands[${index}]`, errors));
  }
  for (const action of EXTERNAL_TOOL_ACTIONS) {
    if (value[action] === undefined) continue;
    if (!object(value[action])) { issue(errors, `${location}.${action}`, 'must be a command contract object'); continue; }
    for (const key of Object.keys(value[action])) {
      if (key !== 'command') issue(errors, `${location}.${action}`, `unsupported field '${key}'`);
    }
    validateCommand(value[action].command, `${location}.${action}.command`, errors);
  }
}

/** Validates core/registry/models.yaml — the provider × role matrix the orchestrator's model
 * router will consume. Shell scope: providers are declared with identity, kind, and
 * evidence (a capability claim without a citation is folklore); roles name routing preferences
 * without binding to concrete model IDs, which stay runtime/user choices resolved at run time. */
function validateModelProvider(value, location, errors) {
  if (!object(value)) { issue(errors, location, 'must be an object'); return; }
  if (typeof value.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value.id)) issue(errors, location, 'id must be a lowercase identifier');
  if (typeof value.displayName !== 'string' || !value.displayName.trim()) issue(errors, location, 'requires displayName');
  if (!MODEL_KINDS.has(value.kind)) issue(errors, location, `kind must be one of: ${[...MODEL_KINDS].join(', ')}`);
  if (!Array.isArray(value.evidence) || value.evidence.length === 0
    || value.evidence.some((url) => typeof url !== 'string' || !/^https:\/\//.test(url))) {
    issue(errors, location, 'must include one or more HTTPS evidence URLs');
  }
}

function validateModelRole(value, location, errors) {
  if (!object(value)) { issue(errors, location, 'must be an object'); return; }
  if (typeof value.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value.id)) issue(errors, location, 'id must be a lowercase identifier');
  for (const field of ['prefer', 'fallback', 'require']) {
    if (value[field] !== undefined && (typeof value[field] !== 'string' || !value[field].trim())) {
      issue(errors, location, `${field} must be a non-empty string when present`);
    }
  }
}

function validateRegistry(registry, { repoRoot, fsImpl = fs } = {}) {
  const errors = [];
  const harnesses = Array.isArray(registry?.harnesses) ? registry.harnesses : null;
  const assets = Array.isArray(registry?.assets) ? registry.assets : null;
  const mcp = Array.isArray(registry?.mcp) ? registry.mcp : null;
  const lifecycle = Array.isArray(registry?.lifecycle) ? registry.lifecycle : null;
  const externalTools = Array.isArray(registry?.externalTools) ? registry.externalTools : null;
  if (!harnesses) issue(errors, 'harnesses', 'must be an array');
  if (!assets) issue(errors, 'assets', 'must be an array');
  if (!mcp) issue(errors, 'mcp', 'must be an array');
  if (!lifecycle) issue(errors, 'lifecycle', 'must be an array');
  if (!externalTools) issue(errors, 'externalTools', 'must be an array');
  const contracts = Array.isArray(registry?.contracts) ? registry.contracts : null;
  if (!contracts) issue(errors, 'contracts', 'must be an array');
  idsUnique(harnesses, 'harnesses', errors); idsUnique(assets, 'assets', errors);
  idsUnique(mcp, 'mcp', errors); idsUnique(lifecycle, 'lifecycle', errors);
  idsUnique(externalTools, 'externalTools', errors);

  const harnessIds = new Set((harnesses || []).filter(object).map((item) => item.id));
  for (const harness of harnesses || []) {
    const at = `harness '${harness?.id ?? '?'}'`;
    if (!object(harness)) { issue(errors, 'harnesses', 'entries must be objects'); continue; }
    if (typeof harness.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(harness.id)) issue(errors, at, 'id must be a lowercase identifier');
    if (typeof harness.displayName !== 'string' || !harness.displayName.trim()) issue(errors, at, 'requires displayName');
    if (typeof harness.adapter !== 'string' || !harness.adapter.trim()) issue(errors, at, 'requires adapter');
    if (!Array.isArray(harness.scopes) || harness.scopes.length === 0 || harness.scopes.some((scope) => !SCOPES.has(scope))) issue(errors, at, 'scopes must contain project and/or user');
    if (!object(harness.nativeTargets)) issue(errors, at, 'nativeTargets must be an object');
    if (!object(harness.capabilities) || Object.keys(harness.capabilities || {}).length === 0) issue(errors, at, 'capabilities must be a non-empty object');
    for (const [capability, declaration] of Object.entries(harness.capabilities || {})) {
      if (!/^[a-z][a-z0-9-]*$/.test(capability)) issue(errors, at, `invalid capability '${capability}'`);
      validateCapability(declaration, `${at} capability '${capability}'`, errors);
    }
    if (harness.id === 'codex') validateNativeProjection(harness.nativeProjection, harness, { repoRoot, fsImpl }, errors);
  }

  const contractHarnesses = new Set();
  for (const contract of contracts || []) {
    validateContract(contract, `contract '${contract?.harness ?? '?'}'`, errors, harnessIds);
    if (object(contract) && typeof contract.harness === 'string') {
      if (contractHarnesses.has(contract.harness)) issue(errors, 'contracts', `duplicate contract for '${contract.harness}'`);
      contractHarnesses.add(contract.harness);
    }
  }
  // Every harness needs a contract: without one there is nothing to validate its shipped
  // frontmatter and hook events against, so drift in that harness would go unnoticed.
  for (const id of harnessIds) {
    if (!contractHarnesses.has(id)) issue(errors, 'contracts', `no contract declared for harness '${id}'`);
  }

  for (const asset of assets || []) {
    const at = `asset '${asset?.id ?? '?'}'`;
    if (!object(asset)) { issue(errors, 'assets', 'entries must be objects'); continue; }
    for (const field of ['id', 'kind', 'source', 'ownership']) if (typeof asset[field] !== 'string' || !asset[field].trim()) issue(errors, at, `requires ${field}`);
    if (typeof asset.source === 'string' && repoRoot) {
      const source = path.resolve(repoRoot, asset.source);
      if (!source.startsWith(`${path.resolve(repoRoot)}${path.sep}`) || !fsImpl.existsSync(source)) issue(errors, at, `source does not exist inside repository: ${asset.source}`);
    }
    if (!Array.isArray(asset.appliesTo) || asset.appliesTo.length === 0) issue(errors, at, 'appliesTo must be a non-empty array');
    if (!object(asset.projection)) issue(errors, at, 'projection must be an object');
    for (const harnessId of asset.appliesTo || []) {
      if (!harnessIds.has(harnessId)) issue(errors, at, `references unknown harness '${harnessId}'`);
      const projection = asset.projection?.[harnessId];
      if (!object(projection) || typeof projection.renderer !== 'string' || !projection.renderer.trim() || typeof projection.capability !== 'string' || !projection.capability.trim()) {
        issue(errors, at, `requires renderer and capability projection for '${harnessId}'`); continue;
      }
      const harness = (harnesses || []).find((item) => item?.id === harnessId);
      const capability = harness?.capabilities?.[projection.capability];
      if (!capability) issue(errors, at, `projection '${harnessId}' references unknown capability '${projection.capability}'`);
      else if (capability.status === 'unavailable') issue(errors, at, `projection '${harnessId}' cannot render unavailable capability '${projection.capability}'`);
    }
  }

  for (const server of mcp || []) {
    const at = `MCP server '${server?.id ?? '?'}'`;
    if (!object(server)) { issue(errors, 'mcp', 'entries must be objects'); continue; }
    if (typeof server.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(server.id)) issue(errors, at, 'id must be a lowercase identifier');
    if (!MCP_TRANSPORTS.has(server.transport)) issue(errors, at, 'transport must be stdio, http, or sse');
    if (server.transport === 'stdio' && (typeof server.command !== 'string' || !server.command.trim())) issue(errors, at, 'stdio transport requires command');
    if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string'))) issue(errors, at, 'args must be an array of strings');
    if (!['optional', 'required'].includes(server.selection)) issue(errors, at, 'selection must be optional or required');
  }

  for (const policy of lifecycle || []) {
    const at = `lifecycle policy '${policy?.id ?? '?'}'`;
    if (!object(policy)) { issue(errors, 'lifecycle', 'entries must be objects'); continue; }
    if (typeof policy.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(policy.id)) issue(errors, at, 'id must be a lowercase identifier');
    if (typeof policy.intent !== 'string' || !policy.intent.trim()) issue(errors, at, 'requires intent');
    if (!Array.isArray(policy.requires) || policy.requires.some((capability) => typeof capability !== 'string')) issue(errors, at, 'requires must be an array of capability names');
    if (!object(policy.mappings)) { issue(errors, at, 'mappings must be an object'); continue; }
    for (const [harnessId, mapping] of Object.entries(policy.mappings)) {
      if (!harnessIds.has(harnessId)) { issue(errors, at, `mapping references unknown harness '${harnessId}'`); continue; }
      if (!object(mapping) || !CAPABILITY_STATUS.has(mapping.status)) { issue(errors, at, `mapping '${harnessId}' needs a valid status`); continue; }
      if (mapping.status !== 'unavailable' && (typeof mapping.event !== 'string' || !mapping.event.trim())) issue(errors, at, `mapping '${harnessId}' requires event for a renderable status`);
      if (mapping.status === 'unavailable' && typeof mapping.fallback !== 'string') issue(errors, at, `unavailable mapping '${harnessId}' requires fallback guidance`);
    }
  }
  for (const tool of externalTools || []) validateExternalTool(tool, `external tool '${tool?.id ?? '?'}'`, errors);

  const modelProviders = Array.isArray(registry?.modelProviders) ? registry.modelProviders : null;
  const modelRoles = Array.isArray(registry?.modelRoles) ? registry.modelRoles : null;
  if (!modelProviders) issue(errors, 'models.providers', 'must be an array');
  if (!modelRoles) issue(errors, 'models.roles', 'must be an array');
  idsUnique(modelProviders, 'models.providers', errors);
  idsUnique(modelRoles, 'models.roles', errors);
  for (const provider of modelProviders || []) validateModelProvider(provider, `model provider '${provider?.id ?? '?'}'`, errors);
  for (const role of modelRoles || []) validateModelRole(role, `model role '${role?.id ?? '?'}'`, errors);
  return { ok: errors.length === 0, errors };
}

function harnessFor(registry, id) {
  const harness = registry.harnesses.find((item) => item.id === id);
  if (!harness) throw new Error(`Unknown registry harness '${id}'`);
  return harness;
}

function selectAssets(registry, { harness, capability, kind } = {}) {
  const declaration = harness ? harnessFor(registry, harness) : null;
  return registry.assets.filter((asset) => {
    if (kind && asset.kind !== kind) return false;
    if (!harness) return true;
    if (!asset.appliesTo.includes(harness)) return false;
    const selectedCapability = asset.projection[harness].capability;
    return (!capability || selectedCapability === capability) && declaration.capabilities[selectedCapability].status !== 'unavailable';
  });
}

function selectMcpServers(registry, ids) {
  if (ids === undefined || ids === null) return [...registry.mcp];
  if (!Array.isArray(ids)) throw new Error('MCP selection must be an array of server ids');
  const wanted = new Set(ids);
  const unknown = [...wanted].filter((id) => !registry.mcp.some((server) => server.id === id));
  if (unknown.length) throw new Error(`Unknown registry MCP server(s): ${unknown.join(', ')}`);
  return registry.mcp.filter((server) => wanted.has(server.id));
}

/** Reshape registry MCP server declarations into the {allServers, serverDefs} catalog shape every
 * harness's native MCP reconciliation (Codex's config.toml writer, Claude's ~/.claude.json/
 * .mcp.json writer) expects — the one place this transform is derived, reused rather than
 * re-implemented per consumer. */
function nativeMcpCatalog(servers = []) {
  const allServers = servers.map((server) => server.id);
  const serverDefs = Object.fromEntries(servers.map((server) => [server.id, {
    command: server.command,
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.url ? { url: server.url } : {}),
  }]));
  return { allServers, serverDefs };
}

function capabilityMapData(registry) {
  return registry.harnesses.flatMap((harness) => Object.entries(harness.capabilities).map(([capability, declaration]) => ({
    harness: harness.id,
    displayName: harness.displayName,
    capability,
    status: declaration.status,
    nativeTarget: harness.nativeTargets[capability] ?? null,
    evidence: [...declaration.evidence],
    prerequisites: [...(declaration.prerequisites || [])],
    verification: declaration.verification,
  })));
}

module.exports = {
  REGISTRY_FILES, CAPABILITY_STATUS, EXTERNAL_TOOL_IDS, EXTERNAL_TOOL_ACTIONS,
  parseRegistryFile, registryDir, loadRegistry, validateRegistry,
  harnessFor, selectAssets, selectMcpServers, nativeMcpCatalog, capabilityMapData,
};
