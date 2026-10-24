'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// Registry loader and validator.  Registry files are plain JSON (core/registry/*.json).
const fs = require('node:fs');
const path = require('node:path');
const { validatePathsSection } = require('../helper/harness-paths.ts');
const { BUILTIN_WORKER_ID_RE, RESERVED_WORKER_IDS } = require('./worker-ids.ts');

const REGISTRY_FILES = Object.freeze({
  harnesses: 'harnesses.json',
  assets: 'assets.json',
  mcp: 'mcp.json',
  lifecycle: 'lifecycle.json',
  contracts: 'contracts.json',
  externalTools: 'external-tools.json',
  models: 'models.json',
});
const CAPABILITY_STATUS = new Set(['supported', 'different', 'unavailable']);
// Kept local to avoid a registry -> adapter import cycle; registry.test.js ties this list to SELECTORS.
const COPY_TREE_SELECTS = new Set(['guidance-manifest']);
// Renderers that materialize through the copy-tree engine and so may carry a `select`: the generic one and
// Copilot's rule renderer, which differs only by its transform and layout.
const COPY_TREE_SELECT_RENDERERS = new Set(['copy-tree', 'copilot-rule-instructions']);
/** The orchestration block's own status vocabulary (074 IC-026): whether a harness exposes a
 * primitive, kept apart from CAPABILITY_STATUS because "unknown" is a recorded state here, not a gap. */
const ORCHESTRATION_STATUS = new Set(['supported', 'unsupported', 'unknown']);
// `nest` (118 IC-004): a subagent can start a subagent.
const ORCHESTRATION_OPS = ['spawn', 'wait', 'status', 'cancel', 'resume', 'nest'];
const ORCHESTRATION_FALLBACK = new Set(['sequential', 'manual']);
// 'core' = must be supported/different (never unavailable) on every currently-integrated harness;
// 'enhanced' = best-effort, wired wherever a harness's native surface allows. Optional field —
// a policy without one is neither tier, and test/guards/registry.test.js's core-tier check simply
// skips it. See agent-docs research backing this (LSP capability negotiation, k8s feature gates,
// progressive enhancement): reducing every policy to the true cross-harness intersection was
// rejected as a design in favor of this, since it deletes real working capability instead of just
// recording where it doesn't reach.
const POLICY_TIERS = new Set(['core', 'enhanced']);
const SCOPES = new Set(['project', 'user']);
const MCP_TRANSPORTS = new Set(['stdio', 'http', 'sse']);
const EXTERNAL_TOOL_IDS = new Set(['rtk', 'graphify', 'semble', 'mermaid-cli', 'plantuml']);
const EXTERNAL_TOOL_ACTIONS = new Set(['install', 'update', 'uninstall']);
const MODEL_KINDS = new Set(['hosted', 'local']);
const MODEL_SLOT_IDS = new Set(['dense', 'rerank']);
const MCP_STEP_KEYS = new Set(['skill', 'file', 'expectedWhen']);
const MCP_NAME = /^[A-Za-z0-9_.-]+$/;
/** How a capability provider answers: from the current files or commands (`live`), or from a built
 * artifact that can lag the source (`index`). Required on every provider (068). */
const PROVIDER_SOURCE_MODES = Object.freeze(['live', 'index']);

function issue(errors: string[], location: string, message: string): void { errors.push(`${location}: ${message}`); }
function object(value: any): boolean { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function idsUnique(items: any, label: string, errors: string[]): void {
  const seen = new Set();
  for (const item of items || []) {
    if (!object(item) || typeof item.id !== 'string' || !item.id) continue;
    if (seen.has(item.id)) issue(errors, label, `duplicate id '${item.id}'`);
    seen.add(item.id);
  }
}

function parseRegistryFile(file: string, fsImpl: any = fs): any {
  let text;
  try { text = fsImpl.readFileSync(file, 'utf8'); } catch (error: any) {
    throw new Error(`Could not read registry file '${file}': ${error.message}`);
  }
  try { return JSON.parse(text); } catch (error: any) {
    throw new Error(`Registry file '${file}' is not valid JSON: ${error.message}`);
  }
}

function registryDir(repoRoot: string): string { return path.join(path.resolve(repoRoot), 'core', 'registry'); }

type SourceMode = 'require' | 'skip';

function registrySourceMode(repoRoot: string, fsImpl: any = fs): SourceMode {
  if (typeof repoRoot !== 'string' || !repoRoot.trim()) return 'skip';
  return fsImpl.existsSync(path.join(path.resolve(repoRoot), 'package.json')) ? 'require' : 'skip';
}

function loadRegistry({ repoRoot, dir, fsImpl = fs, sources }: { repoRoot?: string, dir?: string, fsImpl?: any, sources?: SourceMode } = {}): any {
  if (sources !== undefined && sources !== 'require' && sources !== 'skip') {
    throw new TypeError(`sources must be 'require' or 'skip', got ${JSON.stringify(sources)}`);
  }
  if (!repoRoot && !dir) throw new Error('loadRegistry requires repoRoot or dir');
  const base = dir ? path.resolve(dir) : registryDir(repoRoot as string);
  const loaded: any = {};
  for (const [name, fileName] of Object.entries(REGISTRY_FILES)) {
    loaded[name] = parseRegistryFile(path.join(base, fileName), fsImpl);
  }
  // capabilities.json is read by the capability router, not a REGISTRY_FILES entry; the registry
  // only validates it (provider `mcp` descriptors) when the file is present beside the others.
  const capabilitiesFile = path.join(base, 'capabilities.json');
  const capabilities = fsImpl.existsSync(capabilitiesFile) ? parseRegistryFile(capabilitiesFile, fsImpl).capabilities : undefined;
  const registry = {
    directory: base,
    repoRoot: repoRoot ? path.resolve(repoRoot) : path.resolve(base, '..', '..'),
    harnesses: loaded.harnesses.harnesses,
    assets: loaded.assets.assets,
    mcp: loaded.mcp.servers,
    lifecycle: loaded.lifecycle.policies,
    coverage: loaded.lifecycle.coverage ?? null,
    contracts: loaded.contracts.contracts,
    externalTools: loaded.externalTools.tools,
    modelProviders: loaded.models.providers,
    modelRoles: loaded.models.roles,
    retrievalSlots: Array.isArray(loaded.models.slots) ? loaded.models.slots : [],
    dispatchTiers: loaded.models.dispatchTiers,
    capabilities,
    versions: Object.fromEntries((Object.entries(loaded) as [string, any][]).map(([name, value]) => [name, value.version])),
  };
  const sourceMode: SourceMode = sources ?? registrySourceMode(registry.repoRoot, fsImpl);
  const validation = validateRegistry(registry, { repoRoot: registry.repoRoot, fsImpl, sources: sourceMode });
  if (!validation.ok) {
    const error: any = new Error(`Invalid DoFlow registry:\n- ${validation.errors.join('\n- ')}`);
    error.validation = validation;
    throw error;
  }
  return Object.freeze({ ...registry, validation });
}

const CONTRACT_COMPLETENESS = new Set(['verified', 'lower-bound']);

/** Validates core/registry/contracts.json — what each harness ACCEPTS (legal frontmatter fields,
 * legal hook event names), kept separate from harnesses.json's what-DoFlow-SUPPORTS. The split is
 * what keeps the registry-truth guard from validating the registry against itself.
 *
 * `evidence` is required for the same reason capabilities require it: a contract claim with no
 * citation is folklore, and these lists are copied from vendor documentation that moves. */
function validateContract(value: any, location: string, errors: string[], harnessIds: any): void {
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
  // hook. OpenCode has no DoFlow hook projection; Pi uses a code extension only for tool_call.
  // Forcing a non-empty list for an unsupported event would declare a hook DoFlow does not install —
  // an inert claim of exactly the kind these guards exist to remove. Empty is therefore allowed, but
  // only with a note, so deliberate gaps stay distinct from missing registry data.
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
    || value.evidence.some((url: any) => typeof url !== 'string' || !/^https:\/\//.test(url))) {
    issue(errors, location, 'must include one or more HTTPS evidence URLs');
  }
}

/** A harness MCP tool-name template: contains {server} and {tool}, and no other brace text. */
function validToolNameTemplate(value: any): boolean {
  return typeof value === 'string' && value.includes('{server}') && value.includes('{tool}')
    && !value.replace(/\{server\}|\{tool\}/g, '').match(/[{}]/);
}

function validateCapability(value: any, location: string, errors: string[]): void {
  if (!object(value)) { issue(errors, location, 'must be an object'); return; }
  if (!CAPABILITY_STATUS.has(value.status)) issue(errors, location, 'status must be supported, different, or unavailable');
  if (!Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.some((url: any) => typeof url !== 'string' || !/^https:\/\//.test(url))) {
    issue(errors, location, 'must include one or more HTTPS evidence URLs');
  }
  if (typeof value.verification !== 'string' || !value.verification.trim()) issue(errors, location, 'requires a verification instruction');
  if (value.toolName !== undefined && !validToolNameTemplate(value.toolName)) {
    issue(errors, location, 'toolName must be a string with exactly the placeholders {server} and {tool} and no other braces');
  }
  if (value.prerequisites !== undefined && (!Array.isArray(value.prerequisites) || value.prerequisites.some((item: any) => typeof item !== 'string' || !item))) {
    issue(errors, location, 'prerequisites must be an array of non-empty strings');
  }
  // Optional per-event detail, reusing the same three-value status vocabulary. Additive on
  // purpose: a capability without it keeps today's coarse behaviour, so harnesses migrate one at
  // a time instead of all three needing per-event data before any of them can have it.
  if (value.events !== undefined) {
    if (!object(value.events) || Object.keys(value.events).length === 0) {
      issue(errors, `${location}.events`, 'must be a non-empty object when present');
    } else {
      for (const [event, detail] of Object.entries(value.events) as [string, any][]) {
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

function validateSource(repoRoot: any, source: any, location: string, errors: string[], fsImpl: any, expected: string = 'any', sources: SourceMode = 'require'): void {
  if (typeof source !== 'string' || !source.trim()) { issue(errors, location, 'requires a repository-relative source'); return; }
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, source);
  if (!resolved.startsWith(`${root}${path.sep}`)) { issue(errors, location, `source does not exist inside repository: ${source}`); return; }
  if (sources === 'skip') return;
  if (!fsImpl.existsSync(resolved)) { issue(errors, location, `source does not exist inside repository: ${source}`); return; }
  if (expected === 'file' && !fsImpl.statSync(resolved).isFile()) issue(errors, location, `source must be a file: ${source}`);
  if (expected === 'directory' && !fsImpl.statSync(resolved).isDirectory()) issue(errors, location, `source must be a directory: ${source}`);
}

function validateNativeProjection(projection: any, harness: any, { repoRoot, fsImpl, sources }: { repoRoot: any, fsImpl: any, sources?: SourceMode }, errors: string[]): void {
  const at = `harness '${harness.id}' nativeProjection`;
  if (!object(projection)) { issue(errors, at, 'must be an object'); return; }
  const config = projection.config;
  if (!object(config)) issue(errors, at, 'requires config declaration');
  else {
    validateSource(repoRoot, config.source, `${at} config`, errors, fsImpl, 'file', sources);
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
  else validateSource(repoRoot, agents.source, `${at} agents`, errors, fsImpl, 'directory', sources);
  const hooks = projection.hooks;
  if (!object(hooks)) issue(errors, `${at} hooks`, 'requires hooks declaration');
  else {
    validateSource(repoRoot, hooks.configSource, `${at} hooks`, errors, fsImpl, 'file', sources);
    validateSource(repoRoot, hooks.scriptsSource, `${at} hooks`, errors, fsImpl, 'directory', sources);
    if (typeof hooks.trusted !== 'boolean') issue(errors, `${at} hooks`, 'trusted must be boolean');
  }
}

function validateCommand(command: any, location: string, errors: string[]): void {
  if (!Array.isArray(command) || command.length === 0
    || command.some((argument) => typeof argument !== 'string' || !argument.trim())) {
    issue(errors, location, 'command must be a non-empty array of non-empty strings');
  }
}

function validateExternalTool(value: any, location: string, errors: string[]): void {
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
    || value.officialEvidence.some((url: any) => typeof url !== 'string' || !/^https:\/\//.test(url))) {
    issue(errors, location, 'must include one or more HTTPS officialEvidence URLs');
  }
  if (value.prerequisites !== undefined && (!Array.isArray(value.prerequisites)
    || value.prerequisites.some((item: any) => typeof item !== 'string' || !item.trim())
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
    value.status.commands.forEach((command: any, index: number) => validateCommand(command, `${location}.status.commands[${index}]`, errors));
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

/** Validates core/registry/models.json — the provider × role matrix the orchestrator's model
 * router will consume. Shell scope: providers are declared with identity, kind, and
 * evidence (a capability claim without a citation is folklore); roles name routing preferences
 * without binding to concrete model IDs, which stay runtime/user choices resolved at run time. */
function validateModelProvider(value: any, location: string, errors: string[]): void {
  if (!object(value)) { issue(errors, location, 'must be an object'); return; }
  if (typeof value.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value.id)) issue(errors, location, 'id must be a lowercase identifier');
  if (typeof value.displayName !== 'string' || !value.displayName.trim()) issue(errors, location, 'requires displayName');
  if (!MODEL_KINDS.has(value.kind)) issue(errors, location, `kind must be one of: ${[...MODEL_KINDS].join(', ')}`);
  if (!Array.isArray(value.families) || value.families.length === 0
    || value.families.some((family: any) => typeof family !== 'string' || !/^[a-z][a-z0-9-]*$/.test(family))) {
    issue(errors, location, 'families must be a non-empty array of lowercase identifiers');
  } else if (new Set(value.families).size !== value.families.length) {
    issue(errors, location, 'families must not contain duplicate identifiers');
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0
    || value.evidence.some((url: any) => typeof url !== 'string' || !/^https:\/\//.test(url))) {
    issue(errors, location, 'must include one or more HTTPS evidence URLs');
  }
}

function validateModelRole(value: any, location: string, errors: string[]): void {
  if (!object(value)) { issue(errors, location, 'must be an object'); return; }
  if (typeof value.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value.id)) issue(errors, location, 'id must be a lowercase identifier');
  for (const field of ['prefer', 'fallback', 'require']) {
    if (value[field] !== undefined && (typeof value[field] !== 'string' || !value[field].trim())) {
      issue(errors, location, `${field} must be a non-empty string when present`);
    }
  }
}

/** Validates an optional retrieval slot in core/registry/models.json — a dense-embedding or
 * cross-encoder rerank stage bound to one declared provider and the concrete model that provider
 * serves. Absent slots are the shipped posture and keep retrieval lexical-only; malformed ones
 * must fail the load loudly, because a typo reading as "no dense provider" would silently skip
 * the feature instead of surfacing it. `enabled` is therefore required rather than defaulted:
 * a misspelled flag defaulting to off is the same PASS-over-no-evidence defect in miniature. */
function validateModelSlot(value: any, location: string, errors: string[], providerIds: any): void {
  if (!object(value)) { issue(errors, location, 'must be an object'); return; }
  const allowed = new Set(['id', 'provider', 'model', 'enabled', 'evidence']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(errors, location, `unsupported field '${key}'`);
  }
  if (!MODEL_SLOT_IDS.has(value.id)) issue(errors, location, `id must be one of: ${[...MODEL_SLOT_IDS].join(', ')}`);
  if (typeof value.provider !== 'string' || !value.provider.trim()) issue(errors, location, 'requires provider');
  else if (providerIds && !providerIds.has(value.provider)) issue(errors, location, `references unknown model provider '${value.provider}'`);
  if (typeof value.model !== 'string' || !value.model.trim()) issue(errors, location, 'requires model');
  if (typeof value.enabled !== 'boolean') issue(errors, location, 'enabled must be a boolean');
  if (value.evidence !== undefined && (!Array.isArray(value.evidence) || value.evidence.length === 0
    || value.evidence.some((url: any) => typeof url !== 'string' || !/^https:\/\//.test(url)))) {
    issue(errors, location, 'must include one or more HTTPS evidence URLs when evidence is present');
  }
}

/** `trigger` and `steps` on an MCP server (062): when a stage should reach for the server, and
 * which skill files name it. Registry-only; adapters pick fields and never render these keys. */
function validateMcpStageUse(server: any, at: string, errors: string[]): void {
  if (typeof server.trigger !== 'string' || server.trigger.length < 20 || server.trigger.length > 300 || /[\r\n]/.test(server.trigger)) {
    issue(errors, at, 'trigger must be one line of 20 to 300 characters');
  }
  if (!Array.isArray(server.steps)) { issue(errors, at, 'steps must be an array'); return; }
  const seen = new Set();
  server.steps.forEach((step: any, index: number) => {
    const where = `steps[${index}]`;
    if (!object(step)) { issue(errors, at, `${where} must be an object`); return; }
    for (const key of Object.keys(step)) if (!MCP_STEP_KEYS.has(key)) issue(errors, at, `${where} has unknown key '${key}'`);
    if (typeof step.skill !== 'string' || !/^[a-z][a-z0-9-]*$/.test(step.skill)) issue(errors, at, `${where}.skill must be a skill directory name`);
    if (typeof step.file !== 'string' || !step.file.trim() || path.isAbsolute(step.file) || step.file.split(/[\\/]/).includes('..')) {
      issue(errors, at, `${where}.file must be a path relative to the skill directory`);
    }
    if (step.expectedWhen !== undefined && step.expectedWhen !== 'research-request') issue(errors, at, `${where}.expectedWhen must be 'research-request' when present`);
    const key = `${step.skill}\u0000${step.file}`;
    if (seen.has(key)) issue(errors, at, `${where} duplicates skill '${step.skill}' and file '${step.file}'`);
    seen.add(key);
  });
}

/** Provider checks for capabilities.json: required `sourceMode` (068) and optional `mcp: {server, tool}` (062). */
function validateCapabilityProviders(capabilities: any, errors: string[]): void {
  if (capabilities === undefined) return;
  if (!object(capabilities)) { issue(errors, 'capabilities', 'must be an object'); return; }
  for (const [capabilityId, capability] of Object.entries(capabilities) as [string, any][]) {
    for (const provider of object(capability) && Array.isArray(capability.providers) ? capability.providers : []) {
      if (!object(provider)) continue;
      const at = `capability '${capabilityId}' provider '${provider.id ?? '?'}'`;
      if (!PROVIDER_SOURCE_MODES.includes(provider.sourceMode)) {
        issue(errors, at, `sourceMode is required and must be one of: ${PROVIDER_SOURCE_MODES.join(', ')} (got ${provider.sourceMode === undefined ? 'nothing' : JSON.stringify(provider.sourceMode)})`);
      }
      if (provider.mcp === undefined) continue;
      if (!object(provider.mcp)) { issue(errors, at, 'mcp must be an object with server and tool'); continue; }
      for (const field of ['server', 'tool']) {
        if (typeof provider.mcp[field] !== 'string' || !MCP_NAME.test(provider.mcp[field])) issue(errors, at, `mcp.${field} must match ${MCP_NAME}`);
      }
    }
  }
}

/** `dispatchTiers` in models.json (062): the tier vocabulary and the per-owner default a brief names. */
function validateDispatchTiers(value: any, errors: string[]): void {
  if (value === undefined) return;
  const at = 'models.dispatchTiers';
  if (!object(value)) { issue(errors, at, 'must be an object'); return; }
  const tiers = Array.isArray(value.tiers) && value.tiers.length > 0 && value.tiers.every((tier: any) => typeof tier === 'string' && tier) ? value.tiers : null;
  if (!tiers) { issue(errors, at, 'tiers must be a non-empty array of strings'); return; }
  if (new Set(tiers).size !== tiers.length) issue(errors, at, 'tiers must be unique');
  if (!tiers.includes(value.default)) issue(errors, at, `default must be one of: ${tiers.join(', ')}`);
  if (!object(value.byOwner)) { issue(errors, at, 'byOwner must be an object'); return; }
  for (const [owner, tier] of Object.entries(value.byOwner)) {
    if (!tiers.includes(tier)) issue(errors, at, `byOwner '${owner}' must be one of: ${tiers.join(', ')}`);
  }
}

/** Validates one harness's `orchestration` block (074 IC-026): the five subagent primitives a
 * harness exposes (spawn, wait, status, cancel, resume), each with evidence and a re-check
 * instruction. It reads no other harness and no model name; a value is declared, never inferred. */
function validateOrchestration(value: any, location: string, errors: string[]): void {
  if (!object(value)) { issue(errors, location, 'orchestration block is required and must be an object'); return; }
  for (const op of ORCHESTRATION_OPS) {
    if (!Object.hasOwn(value, op)) issue(errors, location, `orchestration is missing operation '${op}'`);
  }
  for (const op of Object.keys(value)) {
    if (!ORCHESTRATION_OPS.includes(op)) issue(errors, location, `orchestration has unknown operation '${op}'`);
  }
  for (const op of ORCHESTRATION_OPS) {
    if (!Object.hasOwn(value, op)) continue;
    const at = `${location} orchestration '${op}'`;
    const entry = value[op];
    if (!object(entry)) { issue(errors, at, 'must be an object'); continue; }
    if (!ORCHESTRATION_STATUS.has(entry.status)) issue(errors, at, 'status must be supported, unsupported, or unknown');
    if (!Array.isArray(entry.evidence) || entry.evidence.some((item: any) => typeof item !== 'string')) {
      issue(errors, at, 'evidence must be an array of strings');
    } else if (entry.evidence.length === 0 && (entry.status === 'supported' || entry.status === 'unsupported')) {
      issue(errors, at, `evidence must not be empty when status is ${entry.status}`);
    }
    if (typeof entry.verification !== 'string' || !entry.verification.trim()) issue(errors, at, 'requires a verification instruction');
    if (typeof entry.verifiedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.verifiedOn)) issue(errors, at, 'requires verifiedOn as an ISO date (YYYY-MM-DD)');
    if (entry.status !== 'supported' && !ORCHESTRATION_FALLBACK.has(entry.fallback)) {
      issue(errors, at, `requires fallback (sequential or manual) when status is ${entry.status}`);
    }
    if (entry.status === 'unknown' && (typeof entry.reason !== 'string' || !entry.reason.trim())) {
      issue(errors, at, 'requires a reason when status is unknown');
    }
  }
}

/** The `agentLimits.readOnly` status vocabulary (118 IC-003): `native` = the harness enforces the
 * limit from keys DoFlow writes into the agent file; `unenforced` = it does not, and says why. */
const AGENT_LIMIT_STATUS = new Set(['native', 'unenforced']);
const AGENT_LIMIT_KEYS = ['readOnly'];
const AGENT_LIMIT_ENTRY_KEYS = new Set(['status', 'apply', 'evidence', 'checked', 'verifiedOn', 'reason']);

/** True when `value` is a non-blank string that parses as an http: or https: URL. */
function isHttpUrl(value: string): boolean {
  if (!value.trim()) return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

/** Validates one harness's `agentLimits` block (118 IC-003): how a `read-only` agent spec is limited
 * on that harness. Declared, never inferred; the adapters read `apply` and nothing else. */
function validateAgentLimits(value: any, location: string, errors: string[]): void {
  if (!object(value)) { issue(errors, location, 'agentLimits block is required and must be an object'); return; }
  for (const key of AGENT_LIMIT_KEYS) {
    if (!Object.hasOwn(value, key)) issue(errors, location, `agentLimits is missing '${key}'`);
  }
  for (const key of Object.keys(value)) {
    if (!AGENT_LIMIT_KEYS.includes(key)) issue(errors, location, `agentLimits has unknown key '${key}'`);
  }
  if (!Object.hasOwn(value, 'readOnly')) return;
  const at = `${location} agentLimits readOnly`;
  const entry = value.readOnly;
  if (!object(entry)) { issue(errors, at, 'must be an object'); return; }
  for (const key of Object.keys(entry)) {
    if (!AGENT_LIMIT_ENTRY_KEYS.has(key)) issue(errors, at, `has unknown key '${key}'`);
  }
  if (!AGENT_LIMIT_STATUS.has(entry.status)) { issue(errors, at, 'status must be native or unenforced'); return; }
  const evidenceOk = Array.isArray(entry.evidence) && entry.evidence.every((item: any) => typeof item === 'string');
  if (!evidenceOk) issue(errors, at, 'evidence must be an array of strings');
  else for (const item of entry.evidence) if (!isHttpUrl(item)) issue(errors, at, `evidence entry ${JSON.stringify(item)} must be an http(s) URL`);
  if (typeof entry.verifiedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.verifiedOn)) issue(errors, at, 'requires verifiedOn as an ISO date (YYYY-MM-DD)');
  if (entry.status === 'native') {
    if (!object(entry.apply) || Object.keys(entry.apply).length === 0) issue(errors, at, 'native requires apply as a non-empty object');
    if (evidenceOk && entry.evidence.length === 0) issue(errors, at, 'native requires non-empty evidence');
    if (entry.checked !== 'docs' && entry.checked !== 'live') issue(errors, at, 'native requires checked as docs or live');
    return;
  }
  if (entry.apply !== undefined) issue(errors, at, 'unenforced must not carry apply');
  if (typeof entry.reason !== 'string' || !entry.reason.trim()) { issue(errors, at, 'unenforced requires a reason'); return; }
  if (evidenceOk && entry.evidence.length === 0 && entry.reason.trim().toLowerCase() !== 'no agent surface') {
    issue(errors, at, 'unenforced requires non-empty evidence unless the reason is "no agent surface"');
  }
}

/** Keys of a harness's `worker` block (081 IC-001) and the recipe fields each capability entry may
 * carry when, and only when, its status is `supported`. `required` lists the fields a `supported`
 * entry must carry. The last three are declared, not implemented, so they take no recipe field. */
const WORKER_CAPABILITIES: Record<string, { allowed: string[], required: string[] }> = Object.freeze({
  cli: { allowed: ['binary', 'versionArgv'], required: ['binary', 'versionArgv'] },
  oneShot: { allowed: ['argv', 'promptVia'], required: ['argv', 'promptVia'] },
  structuredOutput: { allowed: ['argv', 'parser', 'quotaSignals'], required: ['parser'] },
  readOnly: { allowed: ['argv'], required: ['argv'] },
  spawnDenial: { allowed: ['argv'], required: ['argv'] },
  runnableProbe: { allowed: ['argv'], required: ['argv'] },
  hooksProbe: { allowed: ['argv'], required: ['argv'] },
  guidanceProbe: { allowed: ['argv', 'marker'], required: ['argv'] },
  loginProbe: { allowed: ['argv'], required: ['argv'] },
  persistentSession: { allowed: [], required: [] },
  resume: { allowed: [], required: [] },
  steering: { allowed: [], required: [] },
});
/** Capability entries a `worker` block may carry but need not (082 IC-013, DEC-020). Absent reads
 * as `unknown`; present, the entry takes every IC-001 capability-entry rule. */
const WORKER_OPTIONAL_CAPABILITIES: Record<string, { allowed: string[], required: string[] }> = Object.freeze({
  isolatedEdit: { allowed: ['argv'], required: ['argv'] },
});
const WORKER_BILLING = new Set(['free', 'metered', 'unknown']);
const WORKER_KEYS = Object.freeze(['profile', 'billing', ...Object.keys(WORKER_CAPABILITIES), 'modelChecks']);
const WORKER_ALLOWED_KEYS = Object.freeze([...WORKER_KEYS, ...Object.keys(WORKER_OPTIONAL_CAPABILITIES), 'family']);
const WORKER_ENTRY_FIELDS = new Set(['status', 'evidence', 'verification', 'verifiedOn', 'reason']);
const WORKER_RECIPE_FIELDS = new Set(['binary', 'versionArgv', 'argv', 'promptVia', 'parser', 'marker', 'quotaSignals']);
const WORKER_QUOTA_SIGNALS_FIELDS = new Set(['signals', 'basis', 'evidence']);
const WORKER_FACTS = new Set(['hooksLoaded', 'identityForwarded', 'guidanceLoaded', 'login']);
const WORKER_MODEL_CHECK_FIELDS = new Set(['id', 'argv', 'establishes', 'estimateTokens', 'timeoutSeconds']);
const WORKER_ARGV_MAX = 32;
const WORKER_ARG_MAX_CHARS = 200;

/** A worker argv: an array of 0 to 32 strings, each at most 200 characters and free of NUL. */
function workerArgvProblem(value: any): string | null {
  if (!Array.isArray(value) || value.some((item: any) => typeof item !== 'string')) return 'argv must be an array of strings';
  if (value.length > WORKER_ARGV_MAX) return `argv must have at most ${WORKER_ARGV_MAX} elements`;
  if (value.some((item: string) => item.length > WORKER_ARG_MAX_CHARS)) return `argv elements must be at most ${WORKER_ARG_MAX_CHARS} characters`;
  if (value.some((item: string) => item.includes('\0'))) return 'argv elements must not contain NUL';
  return null;
}

/** Validates one harness's `worker` block (081 IC-001): the external-worker capabilities and launch
 * recipe beside `orchestration`. Every message reads `harness '<id>' worker '<key>': ...` and never
 * contains ` orchestration`, so G33.15's orchestration filter reads none of them. Membership of
 * `structuredOutput.parser` in the parser table is checked where that table lives (G41.3, IC-008),
 * not here, so the registry does not require a runtime module. */
function validateWorker(value: any, location: string, errors: string[]): void {
  const fail = (key: string, message: string) => issue(errors, `${location} worker '${key}'`, message);
  if (!object(value)) { fail('*', 'worker block is required and must be an object'); return; }
  for (const key of WORKER_KEYS) if (!Object.hasOwn(value, key)) fail(key, 'is missing');
  for (const key of Object.keys(value)) if (!WORKER_ALLOWED_KEYS.includes(key)) fail(key, 'is not a worker key');

  if (Object.hasOwn(value, 'profile') && value.profile !== null && !COVERAGE_PROFILES.has(value.profile)) {
    fail('profile', 'must be a lifecycle coverage profile or null');
  }
  if (Object.hasOwn(value, 'billing') && !WORKER_BILLING.has(value.billing)) {
    fail('billing', 'must be free, metered, or unknown');
  }
  if (Object.hasOwn(value, 'family') && (typeof value.family !== 'string' || !value.family.trim())) {
    fail('family', 'must be a non-empty string');
  }

  for (const [key, rule] of [...Object.entries(WORKER_CAPABILITIES), ...Object.entries(WORKER_OPTIONAL_CAPABILITIES)]) {
    if (!Object.hasOwn(value, key)) continue;
    const entry = value[key];
    if (!object(entry)) { fail(key, 'must be a capability entry object'); continue; }
    if (!ORCHESTRATION_STATUS.has(entry.status)) fail(key, 'status must be supported, unsupported, or unknown');
    if (!Array.isArray(entry.evidence) || entry.evidence.some((item: any) => typeof item !== 'string')) {
      fail(key, 'evidence must be an array of strings');
    } else if (entry.evidence.length === 0 && (entry.status === 'supported' || entry.status === 'unsupported')) {
      fail(key, `evidence must not be empty when status is ${entry.status}`);
    }
    if (typeof entry.verification !== 'string' || !entry.verification.trim()) fail(key, 'requires a verification instruction');
    if (typeof entry.verifiedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.verifiedOn)) fail(key, 'requires verifiedOn as an ISO date (YYYY-MM-DD)');
    if (entry.status === 'unknown' && (typeof entry.reason !== 'string' || !entry.reason.trim())) fail(key, 'requires a reason when status is unknown');
    if (Object.hasOwn(entry, 'reason') && entry.status !== 'unknown' && (typeof entry.reason !== 'string' || !entry.reason.trim())) fail(key, 'reason must be a non-empty string');

    for (const field of Object.keys(entry)) {
      if (WORKER_ENTRY_FIELDS.has(field)) continue;
      if (!WORKER_RECIPE_FIELDS.has(field) || !rule.allowed.includes(field)) { fail(key, `has unknown field '${field}'`); continue; }
      if (entry.status !== 'supported') fail(key, `recipe field '${field}' is allowed only when status is supported`);
    }
    if (entry.status !== 'supported') continue;
    for (const field of rule.required) if (!Object.hasOwn(entry, field)) fail(key, `requires recipe field '${field}' when status is supported`);

    if (Object.hasOwn(entry, 'binary') && (typeof entry.binary !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.binary))) {
      fail(key, 'binary must be a bare command name');
    }
    for (const field of ['versionArgv', 'argv']) {
      if (!Object.hasOwn(entry, field)) continue;
      const problem = workerArgvProblem(entry[field]);
      if (problem) {
        fail(key, problem.replace(/^argv/, field));
      } else {
        // DEC-066: only oneShot.argv carries the prompt; a second placeholder would duplicate it.
        if (!(key === 'oneShot' && field === 'argv') && entry[field].includes('{prompt}')) {
          fail(key, `${field} must not contain '{prompt}' outside oneShot.argv`);
        }
        if (key === 'structuredOutput' && field === 'argv') {
          const count = entry.argv.filter((item: any) => item === '{lastMessageFile}').length;
          if (count > 1) {
            fail(key, "argv must contain '{lastMessageFile}' only once and only in structuredOutput.argv");
          }
        } else if (entry[field].includes('{lastMessageFile}')) {
          fail(key, "argv must contain '{lastMessageFile}' only once and only in structuredOutput.argv");
        }
      }
    }
    if (Object.hasOwn(entry, 'parser') && (typeof entry.parser !== 'string' || !entry.parser.trim())) fail(key, 'parser must be a parser id');
    if (key === 'structuredOutput' && Object.hasOwn(entry, 'quotaSignals')) {
      const quota = entry.quotaSignals;
      if (!object(quota)) fail(key, 'quotaSignals must be an object');
      else {
        for (const field of Object.keys(quota)) if (!WORKER_QUOTA_SIGNALS_FIELDS.has(field)) fail(key, `quotaSignals has unknown field '${field}'`);
        if (!Array.isArray(quota.signals) || quota.signals.length < 1 || quota.signals.length > 16) fail(key, 'quotaSignals.signals must contain 1 to 16 signals');
        else for (const signal of quota.signals) {
          if (typeof signal !== 'string' || signal !== signal.trim() || signal.length < 3 || signal.length > 64 || /[\u0000-\u001f\u007f]/.test(signal)) {
            fail(key, 'quotaSignals.signals must be trimmed strings of 3 to 64 characters without control characters');
            break;
          }
        }
        if (quota.basis !== 'unverified' && quota.basis !== 'transcript') fail(key, "quotaSignals.basis must be 'unverified' or 'transcript'");
        if (!Array.isArray(quota.evidence) || quota.evidence.some((item: any) => typeof item !== 'string')) fail(key, 'quotaSignals.evidence must be an array of strings');
        else if (quota.basis === 'transcript' && quota.evidence.length === 0) fail(key, 'quotaSignals transcript basis requires evidence');
        else if (quota.basis === 'unverified' && quota.evidence.length !== 0) fail(key, 'quotaSignals unverified basis requires empty evidence');
        else if (quota.basis === 'transcript') {
          const harnessMatch = location.match(/^harness '([^']+)'/);
          for (const item of quota.evidence) {
            if (path.isAbsolute(item) || item.split(/[\\/]/).includes('..')) {
              fail(key, 'quotaSignals transcript evidence must be under its harness worker-evidence directory');
            } else if (harnessMatch) {
              const prefix = `core/worker-evidence/${harnessMatch[1]}/`;
              if (!item.startsWith(prefix)) fail(key, 'quotaSignals transcript evidence must be under its harness worker-evidence directory');
            }
          }
        }
      }
    }
    if (Object.hasOwn(entry, 'marker') && (typeof entry.marker !== 'string' || entry.marker.length < 1 || entry.marker.length > 200)) {
      fail(key, 'marker must be 1 to 200 characters');
    }
    if (key === 'oneShot' && Object.hasOwn(entry, 'promptVia')) {
      const count = Array.isArray(entry.argv) ? entry.argv.filter((item: any) => item === '{prompt}').length : 0;
      if (entry.promptVia === 'argv') {
        if (count !== 1) fail(key, "argv must contain the element '{prompt}' exactly once when promptVia is argv");
      } else if (entry.promptVia === 'stdin') {
        if (count !== 0) fail(key, "argv must not contain '{prompt}' when promptVia is stdin");
      } else {
        fail(key, 'promptVia must be argv or stdin');
      }
    }
  }

  if (!Object.hasOwn(value, 'modelChecks')) return;
  if (!Array.isArray(value.modelChecks)) { fail('modelChecks', 'must be an array'); return; }
  const seen = new Set<string>();
  value.modelChecks.forEach((check: any, index: number) => {
    const key = `modelChecks[${index}]`;
    if (!object(check)) { fail(key, 'must be an object'); return; }
    for (const field of Object.keys(check)) if (!WORKER_MODEL_CHECK_FIELDS.has(field)) fail(key, `has unknown field '${field}'`);
    if (typeof check.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(check.id)) fail(key, 'id must be a lowercase identifier');
    else if (seen.has(check.id)) fail(key, `duplicate id '${check.id}'`);
    else seen.add(check.id);
    const problem = workerArgvProblem(check.argv);
    if (problem) {
      fail(key, problem);
    } else {
      if (check.argv.includes('{prompt}')) fail(key, "argv must not contain '{prompt}' outside oneShot.argv");
      if (check.argv.includes('{lastMessageFile}')) fail(key, "argv must contain '{lastMessageFile}' only once and only in structuredOutput.argv");
    }
    if (!Array.isArray(check.establishes) || check.establishes.length === 0 || check.establishes.some((fact: any) => !WORKER_FACTS.has(fact))) {
      fail(key, `establishes must be a non-empty subset of ${[...WORKER_FACTS].join(', ')}`);
    }
    if (!Number.isInteger(check.estimateTokens) || check.estimateTokens < 1) fail(key, 'estimateTokens must be an integer of at least 1');
    if (!Number.isInteger(check.timeoutSeconds) || check.timeoutSeconds < 1 || check.timeoutSeconds > 600) fail(key, 'timeoutSeconds must be an integer from 1 to 600');
  });
}

const CONTEXT_PROFILE_FIELDS = Object.freeze([
  'capacityTokens',
  'reserveTokens',
  'tokenTelemetry',
  'toolResultLimitBytes',
  'retention',
]);

/** Validates one harness's `contextProfile` block (075 IC-013): capacity, reserve, telemetry,
 * toolResultLimitBytes and retention. Each is a Fact<T> with {value, source, verifiedOn} or
 * {unverified, verifiedOn}. */
function validateContextProfile(value: any, location: string, errors: string[]): void {
  if (!object(value)) {
    issue(errors, location, 'contextProfile block is required and must be an object');
    return;
  }
  for (const field of CONTEXT_PROFILE_FIELDS) {
    if (!Object.hasOwn(value, field)) {
      issue(errors, location, `contextProfile is missing field '${field}'`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!CONTEXT_PROFILE_FIELDS.includes(key)) {
      issue(errors, location, `contextProfile has unknown key '${key}'`);
    }
  }
  for (const field of CONTEXT_PROFILE_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const at = `${location} contextProfile '${field}'`;
    const fact = value[field];
    if (!object(fact)) {
      issue(errors, at, 'must be a Fact object');
      continue;
    }
    const hasUnverified = Object.hasOwn(fact, 'unverified');
    const hasValue = Object.hasOwn(fact, 'value');

    if (hasUnverified) {
      if (typeof fact.unverified !== 'string' || !fact.unverified.trim()) {
        issue(errors, at, 'unverified must be a non-empty string');
      }
      if (hasValue) {
        issue(errors, at, 'cannot declare both value and unverified');
      }
    } else if (hasValue) {
      if (typeof fact.source !== 'string' || !fact.source.trim()) {
        issue(errors, at, 'a declared value requires a non-empty source');
      }
    } else {
      issue(errors, at, 'requires either value with source or a non-empty unverified');
    }

    if (
      typeof fact.verifiedOn !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(fact.verifiedOn) ||
      Number.isNaN(Date.parse(fact.verifiedOn)) ||
      new Date(fact.verifiedOn).toISOString().slice(0, 10) !== fact.verifiedOn
    ) {
      issue(errors, at, 'requires verifiedOn as an ISO date (YYYY-MM-DD)');
    }

    if (hasValue && fact.value !== undefined) {
      const val = fact.value;
      if (field === 'capacityTokens') {
        if (typeof val !== 'number' || !Number.isInteger(val) || val <= 0) {
          issue(errors, at, 'value must be a positive integer');
        }
      } else if (field === 'reserveTokens') {
        if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
          issue(errors, at, 'value must be a non-negative integer');
        }
      } else if (field === 'tokenTelemetry') {
        if (val !== 'harness-reported' && val !== 'none') {
          issue(errors, at, "value must be 'harness-reported' or 'none'");
        }
      } else if (field === 'toolResultLimitBytes') {
        if (typeof val !== 'number' || !Number.isInteger(val) || val <= 0) {
          issue(errors, at, 'value must be a positive integer');
        }
      } else if (field === 'retention') {
        if (val !== 'supported' && val !== 'unsupported') {
          issue(errors, at, "value must be 'supported' or 'unsupported'");
        }
      }
    }
  }
}

function validateRegistry(
  registry: any,
  { repoRoot, fsImpl = fs, sources = 'require' }: { repoRoot?: string, fsImpl?: any, sources?: SourceMode } = {},
): { ok: boolean, errors: string[], sources: SourceMode } {
  if (sources !== 'require' && sources !== 'skip') {
    throw new TypeError(`sources must be 'require' or 'skip', got ${JSON.stringify(sources)}`);
  }
  const errors: string[] = [];
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

  const harnessIds = new Set<string>((harnesses || []).filter(object).map((item: any) => item.id as string));
  for (const harness of harnesses || []) {
    const at = `harness '${harness?.id ?? '?'}'`;
    if (!object(harness)) { issue(errors, 'harnesses', 'entries must be objects'); continue; }
    if (typeof harness.id !== 'string' || !BUILTIN_WORKER_ID_RE.test(harness.id)) issue(errors, at, 'id must be a lowercase identifier');
    else if (RESERVED_WORKER_IDS.includes(harness.id)) issue(errors, at, `id '${harness.id}' is a reserved worker id`);
    if (typeof harness.displayName !== 'string' || !harness.displayName.trim()) issue(errors, at, 'requires displayName');
    if (typeof harness.adapter !== 'string' || !harness.adapter.trim()) issue(errors, at, 'requires adapter');
    if (!Array.isArray(harness.scopes) || harness.scopes.length === 0 || harness.scopes.some((scope: any) => !SCOPES.has(scope))) issue(errors, at, 'scopes must contain project and/or user');
    if (!object(harness.nativeTargets)) issue(errors, at, 'nativeTargets must be an object');
    // Declared native paths (Stage 3): every surface a harness declares must parse into the
    // minimal {base, segments} shape — unknown keys or malformed rules fail the load loudly so a
    // typo can never silently fall back to an adapter's previous hardcoded literal.
    if (harness.paths !== undefined) {
      errors.push(...validatePathsSection(harness.paths, `${at} paths`));
    }
    if (!object(harness.capabilities) || Object.keys(harness.capabilities || {}).length === 0) issue(errors, at, 'capabilities must be a non-empty object');
    for (const [capability, declaration] of Object.entries(harness.capabilities || {})) {
      if (!/^[a-z][a-z0-9-]*$/.test(capability)) issue(errors, at, `invalid capability '${capability}'`);
      validateCapability(declaration, `${at} capability '${capability}'`, errors);
    }
    validateOrchestration(harness.orchestration, at, errors);
    validateAgentLimits(harness.agentLimits, at, errors);
    validateWorker(harness.worker, at, errors);
    const quota = harness.worker?.structuredOutput?.quotaSignals;
    if (object(quota) && quota.basis === 'transcript' && Array.isArray(quota.evidence) && typeof repoRoot === 'string') {
      for (const evidence of quota.evidence) {
        if (typeof evidence === 'string' && !fsImpl.existsSync(path.resolve(repoRoot, evidence))) {
          issue(errors, `${at} worker 'structuredOutput'`, `quotaSignals transcript evidence '${evidence}' does not exist`);
        }
      }
    }
    validateContextProfile(harness.contextProfile, at, errors);
    if (harness.id === 'codex') validateNativeProjection(harness.nativeProjection, harness, { repoRoot, fsImpl, sources }, errors);
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
      const outside = !source.startsWith(`${path.resolve(repoRoot)}${path.sep}`);
      if (outside || (sources === 'require' && !fsImpl.existsSync(source))) issue(errors, at, `source does not exist inside repository: ${asset.source}`);
    }
    if (!Array.isArray(asset.appliesTo) || asset.appliesTo.length === 0) issue(errors, at, 'appliesTo must be a non-empty array');
    if (!object(asset.projection)) issue(errors, at, 'projection must be an object');
    for (const harnessId of asset.appliesTo || []) {
      if (!harnessIds.has(harnessId)) issue(errors, at, `references unknown harness '${harnessId}'`);
      const projection = asset.projection?.[harnessId];
      if (!object(projection) || typeof projection.renderer !== 'string' || !projection.renderer.trim() || typeof projection.capability !== 'string' || !projection.capability.trim()) {
        issue(errors, at, `requires renderer and capability projection for '${harnessId}'`); continue;
      }
      const harness = (harnesses || []).find((item: any) => item?.id === harnessId);
      const capability = harness?.capabilities?.[projection.capability];
      if (!capability) issue(errors, at, `projection '${harnessId}' references unknown capability '${projection.capability}'`);
      else if (capability.status === 'unavailable') issue(errors, at, `projection '${harnessId}' cannot render unavailable capability '${projection.capability}'`);
      if (projection.select !== undefined) {
        if (!COPY_TREE_SELECT_RENDERERS.has(projection.renderer)) issue(errors, at, `projection '${harnessId}' select is only valid for ${[...COPY_TREE_SELECT_RENDERERS].map((name) => `'${name}'`).join(' and ')}`);
        if (typeof projection.select !== 'string' || !COPY_TREE_SELECTS.has(projection.select)) {
          issue(errors, at, `projection '${harnessId}' has unknown select '${projection.select}' (known: ${[...COPY_TREE_SELECTS].join(', ')})`);
        }
      }
    }
  }

  for (const server of mcp || []) {
    const at = `MCP server '${server?.id ?? '?'}'`;
    if (!object(server)) { issue(errors, 'mcp', 'entries must be objects'); continue; }
    if (typeof server.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(server.id)) issue(errors, at, 'id must be a lowercase identifier');
    if (!MCP_TRANSPORTS.has(server.transport)) issue(errors, at, 'transport must be stdio, http, or sse');
    if (server.transport === 'stdio' && (typeof server.command !== 'string' || !server.command.trim())) issue(errors, at, 'stdio transport requires command');
    if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg: any) => typeof arg !== 'string'))) issue(errors, at, 'args must be an array of strings');
    if (!['optional', 'required'].includes(server.selection)) issue(errors, at, 'selection must be optional or required');
    validateMcpStageUse(server, at, errors);
  }

  validateCapabilityProviders(registry?.capabilities, errors);
  validateDispatchTiers(registry?.dispatchTiers, errors);

  for (const policy of lifecycle || []) {
    const at = `lifecycle policy '${policy?.id ?? '?'}'`;
    if (!object(policy)) { issue(errors, 'lifecycle', 'entries must be objects'); continue; }
    if (typeof policy.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(policy.id)) issue(errors, at, 'id must be a lowercase identifier');
    if (typeof policy.intent !== 'string' || !policy.intent.trim()) issue(errors, at, 'requires intent');
    if (policy.tier !== undefined && !POLICY_TIERS.has(policy.tier)) issue(errors, at, `tier must be one of ${[...POLICY_TIERS].join(', ')}`);
    if (!Array.isArray(policy.requires) || policy.requires.some((capability: any) => typeof capability !== 'string')) issue(errors, at, 'requires must be an array of capability names');
    if (!object(policy.mappings)) { issue(errors, at, 'mappings must be an object'); continue; }
    for (const [harnessId, mapping] of Object.entries(policy.mappings) as [string, any][]) {
      if (!harnessIds.has(harnessId)) { issue(errors, at, `mapping references unknown harness '${harnessId}'`); continue; }
      if (!object(mapping) || !CAPABILITY_STATUS.has(mapping.status)) { issue(errors, at, `mapping '${harnessId}' needs a valid status`); continue; }
      if (mapping.status !== 'unavailable' && (typeof mapping.event !== 'string' || !mapping.event.trim())) issue(errors, at, `mapping '${harnessId}' requires event for a renderable status`);
      if (mapping.status === 'unavailable' && typeof mapping.fallback !== 'string') issue(errors, at, `unavailable mapping '${harnessId}' requires fallback guidance`);
    }
  }

  validateCoverage(registry?.coverage, registry?.lifecycle, harnessIds, errors);
  for (const tool of externalTools || []) validateExternalTool(tool, `external tool '${tool?.id ?? '?'}'`, errors);

  const modelProviders = Array.isArray(registry?.modelProviders) ? registry.modelProviders : null;
  const modelRoles = Array.isArray(registry?.modelRoles) ? registry.modelRoles : null;
  if (!modelProviders) issue(errors, 'models.providers', 'must be an array');
  if (!modelRoles) issue(errors, 'models.roles', 'must be an array');
  idsUnique(modelProviders, 'models.providers', errors);
  idsUnique(modelRoles, 'models.roles', errors);
  for (const provider of modelProviders || []) validateModelProvider(provider, `model provider '${provider?.id ?? '?'}'`, errors);
  for (const role of modelRoles || []) validateModelRole(role, `model role '${role?.id ?? '?'}'`, errors);
  // Slots are optional: undefined means the registry does not use them at all and routing stays
  // exactly as it was. Anything present-but-wrong (null, a bare object, malformed entries) fails.
  const modelSlots = registry?.retrievalSlots;
  if (modelSlots === undefined) {
    // default posture — no dense/rerank binding declared
  } else if (!Array.isArray(modelSlots)) {
    issue(errors, 'models.slots', 'must be an array when present');
  } else {
    idsUnique(modelSlots, 'models.slots', errors);
    const providerIds = new Set((modelProviders || []).filter(object).map((item: any) => item.id));
    for (const slot of modelSlots) validateModelSlot(slot, `model slot '${slot?.id ?? '?'}'`, errors, providerIds);
  }
  return { ok: errors.length === 0, errors, sources };
}

const COVERAGE_CLASSES = new Set(['blocking', 'observation', 'advisory', 'unsupported', 'unknown']);
const COVERAGE_TIMINGS = new Set(['pre-tool', 'post-tool', 'session', 'prompt', 'stop', 'compact', 'subagent']);
const COVERAGE_PROFILES = new Set(['any', 'user-interactive', 'user-headless', 'project-interactive', 'project-headless', 'cli-extension', 'no-extensions', 'ide', 'cli-v3', 'cli-v3-agent', 'cli-2x-agent']);
const COVERAGE_KINDS = new Set(['doc', 'types', 'fixture', 'live']);

function validateCoverage(value: any, lifecycle: any[], harnessIds: Set<string>, errors: string[]): void {
  if (value === undefined || value === null) return;
  const at = 'lifecycle.coverage';
  if (!object(value)) { issue(errors, at, 'must be an object'); return; }
  if (value.schemaVersion !== 1) issue(errors, `${at}.schemaVersion`, 'must be 1');
  if (!Number.isInteger(value.revision) || value.revision < 1) issue(errors, `${at}.revision`, 'must be a positive integer');
  if (typeof value.rowsDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.rowsDigest)) issue(errors, `${at}.rowsDigest`, 'must be sha256 followed by 64 lowercase hex characters');
  if (!object(value.refresh) || typeof value.refresh.trigger !== 'string' || !value.refresh.trigger.trim() || typeof value.refresh.owner !== 'string' || !value.refresh.owner.trim()) issue(errors, `${at}.refresh`, 'requires non-empty trigger and owner');
  if (!object(value.profiles) || [...COVERAGE_PROFILES].some((profile) => typeof value.profiles?.[profile] !== 'string' || !value.profiles[profile].trim())) issue(errors, `${at}.profiles`, 'must define every supported profile with a non-empty meaning');
  if (value.endOfTurn !== undefined) validateEndOfTurn(value.endOfTurn, `${at}.endOfTurn`, harnessIds, errors);
  if (value.behaviours !== undefined) validateBehaviours(value.behaviours, `${at}.behaviours`, harnessIds, errors);
  if (!Array.isArray(value.rows)) { issue(errors, `${at}.rows`, 'must be an array'); return; }
  const keys = new Set<string>();
  for (const [index, row] of value.rows.entries()) {
    const rowAt = `${at}.rows[${index}]`;
    if (!object(row)) { issue(errors, rowAt, 'must be an object'); continue; }
    for (const field of ['policy', 'harness', 'event']) if (typeof row[field] !== 'string' || !row[field]) issue(errors, `${rowAt}.${field}`, 'must be a non-empty string');
    if (row.policy !== '*' && !(lifecycle || []).some((policy: any) => policy.id === row.policy)) issue(errors, `${rowAt}.policy`, 'must name a lifecycle policy or *');
    if (!harnessIds.has(row.harness)) issue(errors, `${rowAt}.harness`, 'must name a registry harness');
    if (!COVERAGE_TIMINGS.has(row.timing)) issue(errors, `${rowAt}.timing`, 'has an invalid timing');
    if (!COVERAGE_PROFILES.has(row.profile)) issue(errors, `${rowAt}.profile`, 'has an invalid profile');
    if (typeof row.wired !== 'boolean') issue(errors, `${rowAt}.wired`, 'must be a boolean');
    if (row.configSource !== null && (typeof row.configSource !== 'string' || !row.configSource)) issue(errors, `${rowAt}.configSource`, 'must be a path:line or null');
    if (row.wired && typeof row.configSource !== 'string') issue(errors, `${rowAt}.configSource`, 'is required when wired');
    if (!object(row.harnessVersion) || typeof row.harnessVersion.tested !== 'string' || !row.harnessVersion.tested || (row.harnessVersion.range !== undefined && typeof row.harnessVersion.range !== 'string')) issue(errors, `${rowAt}.harnessVersion`, 'requires tested and optional range strings');
    if (!COVERAGE_CLASSES.has(row.class)) issue(errors, `${rowAt}.class`, 'has an invalid class');
    if (!['verified', 'unverified'].includes(row.verification)) issue(errors, `${rowAt}.verification`, 'must be verified or unverified');
    for (const field of ['prerequisites', 'covers', 'doesNotCover', 'caveats']) if (!Array.isArray(row[field]) || row[field].some((item: any) => typeof item !== 'string')) issue(errors, `${rowAt}.${field}`, 'must be an array of strings');
    if (!Array.isArray(row.provenance) || row.provenance.some((item: any) => !object(item) || !COVERAGE_KINDS.has(item.kind) || typeof item.locator !== 'string' || !item.locator || (['doc', 'types', 'live'].includes(item.kind) && (typeof item.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.date))))) issue(errors, `${rowAt}.provenance`, 'contains malformed provenance');
    const key = JSON.stringify([row.policy, row.harness, row.event, row.profile]);
    if (keys.has(key)) issue(errors, rowAt, 'duplicates a policy/harness/event/profile tuple');
    keys.add(key);
  }
}

const nonEmptyString = (item: any): boolean => typeof item === 'string' && item.trim() !== '';
const provenanceItemOk = (item: any): boolean => object(item) && COVERAGE_KINDS.has(item.kind) && nonEmptyString(item.locator)
  && (!['doc', 'types', 'live'].includes(item.kind) || (typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date)));

/** Each registry harness appears exactly once under `key`; reports missing, unknown and duplicate entries. */
function oncePerHarness(entries: any[], at: string, harnessIds: Set<string>, key: (entry: any) => string, label: (entry: any) => string, groups: string[], errors: string[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!object(entry)) continue;
    const id = key(entry);
    if (seen.has(id)) issue(errors, at, `duplicates ${label(entry)}`);
    seen.add(id);
  }
  for (const group of groups) for (const harness of harnessIds) if (!seen.has(JSON.stringify([group, harness]))) issue(errors, at, `missing an entry for ${group ? `${group} × ` : ''}harness '${harness}'`);
}

/** IC-017: one end-of-turn entry per harness; `none` when no event, provenance when any. */
function validateEndOfTurn(value: any, at: string, harnessIds: Set<string>, errors: string[]): void {
  if (!Array.isArray(value)) { issue(errors, at, 'must be an array'); return; }
  for (const [index, entry] of value.entries()) {
    const entryAt = `${at}[${index}]`;
    if (!object(entry)) { issue(errors, entryAt, 'must be an object'); continue; }
    if (!harnessIds.has(entry.harness)) issue(errors, `${entryAt}.harness`, 'must name a registry harness');
    if (!Array.isArray(entry.events) || !entry.events.every(nonEmptyString)) { issue(errors, `${entryAt}.events`, 'must be an array of event names'); continue; }
    if (!Array.isArray(entry.provenance) || !entry.provenance.every(provenanceItemOk)) issue(errors, `${entryAt}.provenance`, 'must be an array of well-formed provenance items');
    if (entry.events.length === 0 && !nonEmptyString(entry.none)) issue(errors, `${entryAt}.none`, 'is required, non-empty, when events is empty');
    if (entry.events.length > 0 && !(Array.isArray(entry.provenance) && entry.provenance.some((item: any) => object(item) && ['doc', 'types'].includes(item.kind)))) issue(errors, `${entryAt}.provenance`, 'needs a doc or types item when events is non-empty');
  }
  oncePerHarness(value, at, harnessIds, (entry) => JSON.stringify(['', entry.harness]), (entry) => `harness '${entry.harness}'`, [''], errors);
}

const COVERAGE_BEHAVIOURS = Object.freeze(['context-authority', 'default-silence', 'summary-scope', 'summary-grant', 'identity', 'check-freshness']);

/** IC-018: one entry per behaviour × harness; `enforced` names tests, `limitation` states its reason. */
function validateBehaviours(value: any, at: string, harnessIds: Set<string>, errors: string[]): void {
  if (!Array.isArray(value)) { issue(errors, at, 'must be an array'); return; }
  for (const [index, entry] of value.entries()) {
    const entryAt = `${at}[${index}]`;
    if (!object(entry)) { issue(errors, entryAt, 'must be an object'); continue; }
    if (!COVERAGE_BEHAVIOURS.includes(entry.behaviour)) issue(errors, `${entryAt}.behaviour`, `must be one of ${COVERAGE_BEHAVIOURS.join(', ')}`);
    if (!harnessIds.has(entry.harness)) issue(errors, `${entryAt}.harness`, 'must name a registry harness');
    if (entry.status === 'enforced') {
      if (!Array.isArray(entry.tests) || entry.tests.length === 0 || !entry.tests.every(nonEmptyString)) issue(errors, `${entryAt}.tests`, 'must be a non-empty array of test paths when enforced');
    } else if (entry.status === 'limitation') {
      if (!nonEmptyString(entry.limitation)) issue(errors, `${entryAt}.limitation`, 'must be non-empty when status is limitation');
    } else issue(errors, `${entryAt}.status`, 'must be enforced or limitation');
  }
  oncePerHarness(value, at, harnessIds, (entry) => JSON.stringify([entry.behaviour, entry.harness]), (entry) => `behaviour '${entry.behaviour}' × harness '${entry.harness}'`, [...COVERAGE_BEHAVIOURS], errors);
}

function harnessFor(registry: any, id: string): any {
  const harness = registry.harnesses.find((item: any) => item.id === id);
  if (!harness) throw new Error(`Unknown registry harness '${id}'`);
  return harness;
}

function selectAssets(registry: any, { harness, capability, kind }: { harness?: string, capability?: string, kind?: string } = {}): any[] {
  const declaration = harness ? harnessFor(registry, harness) : null;
  return registry.assets.filter((asset: any) => {
    if (kind && asset.kind !== kind) return false;
    if (!harness) return true;
    if (!asset.appliesTo.includes(harness)) return false;
    const selectedCapability = asset.projection[harness].capability;
    return (!capability || selectedCapability === capability) && declaration.capabilities[selectedCapability].status !== 'unavailable';
  });
}

function selectMcpServers(registry: any, ids?: string[] | null): any[] {
  if (ids === undefined || ids === null) return [...registry.mcp];
  if (!Array.isArray(ids)) throw new Error('MCP selection must be an array of server ids');
  const wanted = new Set(ids);
  const unknown = [...wanted].filter((id) => !registry.mcp.some((server: any) => server.id === id));
  if (unknown.length) throw new Error(`Unknown registry MCP server(s): ${unknown.join(', ')}`);
  return registry.mcp.filter((server: any) => wanted.has(server.id));
}

/** True when the harness takes servers from the shared MCP catalog; the lifecycle and the selection
 * resolver read this one predicate. */
function mcpCapable(registry: any, harnessId: string): boolean {
  return harnessFor(registry, harnessId).capabilities.mcp?.status === 'supported';
}

/** Reshape registry MCP server declarations into the {allServers, serverDefs} catalog shape every
 * harness's native MCP reconciliation (Codex's config.toml writer, Claude's ~/.claude.json/
 * .mcp.json writer) expects — the one place this transform is derived, reused rather than
 * re-implemented per consumer. */
function nativeMcpCatalog(servers: any[] = []): { allServers: string[], serverDefs: any } {
  const allServers = servers.map((server) => server.id);
  const serverDefs = Object.fromEntries(servers.map((server) => [server.id, {
    command: server.command,
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.url ? { url: server.url } : {}),
  }]));
  return { allServers, serverDefs };
}

function capabilityMapData(registry: any): any[] {
  return registry.harnesses.flatMap((harness: any) => (Object.entries(harness.capabilities) as [string, any][]).map(([capability, declaration]) => ({
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
  REGISTRY_FILES, CAPABILITY_STATUS, COPY_TREE_SELECTS, ORCHESTRATION_STATUS, ORCHESTRATION_OPS, validateOrchestration, AGENT_LIMIT_STATUS, validateAgentLimits, WORKER_KEYS, WORKER_CAPABILITIES, WORKER_OPTIONAL_CAPABILITIES, validateWorker, CONTEXT_PROFILE_FIELDS, validateContextProfile, PROVIDER_SOURCE_MODES, validateCapabilityProviders, EXTERNAL_TOOL_IDS, EXTERNAL_TOOL_ACTIONS, validateCoverage,
  parseRegistryFile, registryDir, loadRegistry, validateRegistry, registrySourceMode,
  harnessFor, selectAssets, selectMcpServers, mcpCapable, nativeMcpCatalog, capabilityMapData,
};
