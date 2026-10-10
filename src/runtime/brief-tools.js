'use strict';

/**
 * The tier, tools and report-format block of a generated brief (062 CH7, IC-016 to IC-018).
 *
 * `renderBriefTools` is pure: the registries, the provider probe results, the MCP reach and the run's
 * current stage are all injected, so the same inputs give the same bytes (NFR-001). It names no
 * capability, provider, route intent or MCP server: every name in the block comes from the
 * registries it is handed (NFR-008). `handleBriefToolsCommand` is the `brief-tools` verb that gathers
 * those inputs and prints the block; it writes nothing.
 */

const { REPO_ROOT } = require('../helper/repo-root');
const { loadRegistry } = require('../registry');
const { CapabilityRouter } = require('./capability-router');
const { probeProviders, HEALTHY } = require('./health');
const { mcpReach } = require('./mcp-reach');
const { WorkflowOrchestrator } = require('./workflow-orchestrator');
const { resolveActiveFeature } = require('./feature-resolve');
const { finishRuntime, usageError, captureCaught } = require('./cli-result');

const SCHEMA = 1;
const REACHABLE = new Set(['selected', 'configured']);

/** The state of `server` on a harness: selected or configured on any of its scopes wins, else the
 * first scope's answer, else unknown (no row for it). */
function stateOn(reach, harnessId, server) {
  const rows = (reach?.harnesses || []).filter((row) => row.id === harnessId);
  if (rows.some((row) => row.servers[server] === 'selected')) return 'selected';
  if (rows.some((row) => row.servers[server] === 'configured')) return 'configured';
  return rows.length ? rows[0].servers[server] ?? 'unknown' : 'unknown';
}

/** Whether `server` is selected or configured on the target harness, or on any harness without one. */
function hasServer(reach, harnessId, server) {
  if (!reach) return false;
  return harnessId ? REACHABLE.has(stateOn(reach, harnessId, server)) : reach.harnesses.some((row) => REACHABLE.has(row.servers[server]));
}

/** The target harness: a registry id named by the caller, else the one harness installed at the
 * project scope (the global scope when the project has none), else none. */
function chooseTarget({ registry, reach, harness, missing }) {
  if (harness) {
    if (registry.harnesses.some((item) => item.id === harness)) return harness;
    missing.push(`harness '${harness}' is not a registry harness; ignored`);
  }
  const rows = reach?.harnesses || [];
  for (const scope of ['project', 'global']) {
    const ids = [...new Set(rows.filter((row) => row.scope === scope).map((row) => row.id))];
    if (ids.length) return ids.length === 1 ? ids[0] : null;
  }
  return null;
}

/** Tier for a dispatch: the task line's tier when valid, else the owner's, else the default (IC-004). */
function resolveTier({ dispatchTiers, owner, tier, missing }) {
  if (tier !== undefined && tier !== null && tier !== '') {
    if (dispatchTiers.tiers.includes(tier)) return { tier, source: 'task' };
    missing.push(`tier '${tier}' is not in dispatchTiers.tiers; ignored`);
  }
  if (Object.hasOwn(dispatchTiers.byOwner, owner)) return { tier: dispatchTiers.byOwner[owner], source: 'owner' };
  missing.push(`owner '${owner}' has no tier in models.json dispatchTiers`);
  return { tier: dispatchTiers.default, source: 'default' };
}

/** The first HEALTHY provider of a capability, in registry order, or null. */
function firstHealthy(router, capabilityId, probes) {
  const providers = router.capabilities[capabilityId]?.providers || [];
  const index = providers.findIndex((provider) => probes[provider.id]?.status === HEALTHY);
  return index < 0 ? null : { provider: providers[index], index };
}

/** What answers one route intent on this machine: the first healthy provider of the primary
 * capability, else of the route's fallback capabilities in order, else nothing. */
function resolveRoute(router, route, probes) {
  const primary = firstHealthy(router, route.capability, probes);
  if (primary) return { capability: route.capability, provider: primary.provider, status: primary.index === 0 ? 'HEALTHY' : 'FALLBACK' };
  for (const capability of route.fallback || []) {
    const found = firstHealthy(router, capability, probes);
    if (found) return { capability, provider: found.provider, status: 'FALLBACK' };
  }
  return { capability: route.capability, provider: null, status: 'NONE' };
}

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const trigger = (server) => server.trigger.replace(/\.$/, '');

/**
 * @param {Object} input
 * @param {Object} input.registry loaded registry (mcp, harnesses, dispatchTiers)
 * @param {CapabilityRouter} input.router carries the capabilities and routes
 * @param {Object} input.probes provider id -> probe result (`status`)
 * @param {Object|null} input.reach `mcpReach()` result, or null when install facts are unavailable
 * @param {string} input.owner
 * @param {string} [input.tier] the task line's tier
 * @param {string} [input.harness] target harness id
 * @param {2|3} [input.headingLevel]
 * @param {{feature:?string, runTaskId:?string, stageId:?string, skill:?string}|null} [input.stage]
 * @returns {{markdown: string, record: Object}} the record is IC-018 without `tasks`
 */
function renderBriefTools({ registry, router, probes, reach, owner, tier, harness, headingLevel = 2, stage = null }) {
  const missing = [];
  const hashes = '#'.repeat(Number(headingLevel) === 3 ? 3 : 2);
  const target = chooseTarget({ registry, reach, harness, missing });
  const targetHarness = target ? registry.harnesses.find((item) => item.id === target) : null;
  const resolved = resolveTier({ dispatchTiers: registry.dispatchTiers, owner, tier, missing });
  const sourceText = resolved.source === 'owner' ? `owner ${owner}`
    : resolved.source === 'task' ? 'task line' : `default; owner ${owner} has no tier`;

  const tools = [];
  const rows = [];
  for (const [intent, route] of Object.entries(router.routes)) {
    const found = resolveRoute(router, route, probes);
    if (!found.provider) {
      rows.push(`| ${cell(intent)} | no healthy provider and no fallback | - |`);
      tools.push({ intent, capability: found.capability, provider: null, status: 'NONE', form: 'none' });
      continue;
    }
    const { provider } = found;
    const execution = router.formatExecution(intent, provider, { query: '<query>', path: '.', command: '<command>' });
    const cli = execution?.cliCommand || null;
    const mcp = provider.mcp || null;
    const template = targetHarness?.capabilities?.mcp?.toolName;
    let form;
    let how;
    if (mcp && template && hasServer(reach, target, mcp.server)) {
      form = 'mcp';
      how = template.replace('{server}', () => mcp.server).replace('{tool}', () => mcp.tool);
    } else if (!cli) {
      form = 'none';
      how = execution?.reason || 'no command form is available';
    } else if (mcp && !target) {
      form = 'neutral';
      how = `${cli}; MCP server ${mcp.server}, tool ${mcp.tool}, where your harness registers it`;
    } else {
      form = 'cli';
      how = cli;
    }
    const use = found.status === 'HEALTHY' ? provider.id : `no healthy ${route.capability} provider; fallback ${provider.id}`;
    rows.push(`| ${cell(intent)} | ${cell(use)} | ${cell(how)} |`);
    tools.push({ intent, capability: found.capability, provider: provider.id, status: found.status, form });
  }

  const skill = stage?.skill || null;
  const expectedServers = skill
    ? registry.mcp.filter((server) => (server.steps || []).some((step) => step.skill === skill && !step.expectedWhen)) : [];
  const expectedIds = new Set(expectedServers.map((server) => server.id));
  const expected = expectedServers.map((server) => {
    let state;
    if (target) state = stateOn(reach, target, server.id);
    else state = reach ? reach.anyHarnessHas(server.id) : 'unknown';
    const reachState = target ? (REACHABLE.has(state) ? 'reachable' : state === 'unknown' ? 'unknown' : 'unreachable')
      : (state === true ? 'reachable' : state === false ? 'unreachable' : 'unknown');
    return { server: server.id, reach: reachState, detail: target ? state : `any-harness:${state}` };
  });
  const also = registry.mcp.filter((server) => !expectedIds.has(server.id) && hasServer(reach, target, server.id));
  const list = (servers) => (servers.length ? servers.map((server) => `\`${server.id}\` (${trigger(server)})`).join('; ') : 'none');
  const targetName = targetHarness ? targetHarness.displayName || targetHarness.id : 'any installed harness';

  const lines = [
    `${hashes} Tier and tools`,
    '',
    `Tier: \`${resolved.tier}\` (${sourceText}), per`,
    '`references/MODEL_SELECTION.md`. Pass it as the model where your host allows.',
    '',
    'Tools this machine answers with, per information need. Searching with them before reading whole',
    'files is recommended where it saves reading; it is not required.',
    '',
    '| Need | Use | How |',
    '|---|---|---|',
    ...rows,
    '',
    `MCP servers. Expected for ${skill || 'the running stage (none found)'}: ${list(expectedServers)}. Also selected here:`,
    `${list(also)}.`,
  ];
  for (const item of expected) {
    if (item.reach === 'unreachable') lines.push(`\`${item.server}\` is not reachable on ${targetName}; report it as \`${item.server}=unavailable\`.`);
  }
  lines.push(
    '',
    `${hashes} Report format`,
    '',
    `End ${Number(headingLevel) === 3 ? "each task's report" : 'your report'} with one line naming every tool and MCP server you used:`,
    '`Tools used: <name>[=used|nothing-usable|unavailable|skipped:<reason>], ...`',
  );

  const record = {
    schema: SCHEMA,
    feature: stage?.feature ?? null,
    runTaskId: stage?.runTaskId ?? null,
    stage: stage?.stageId ?? null,
    stageSkill: skill,
    owner,
    tier: resolved.tier,
    tierSource: resolved.source,
    harness: target,
    expected,
    optional: also.map((server) => server.id),
    tools,
    missing,
  };
  return { markdown: `${lines.join('\n')}\n`, record };
}

/** The stage a feature's run is at, or null when there is no readable run or it is not at a stage. */
function currentStageOf({ repoRoot = REPO_ROOT, projectRoot, taskId }) {
  try {
    const run = new WorkflowOrchestrator({ repoRoot, projectRoot }).readRun(taskId);
    const node = run && run.cursor < run.program.length ? run.program[run.cursor] : null;
    return node && node.type === 'stage' ? { stageId: node.id, skill: node.skill } : null;
  } catch { return null; }
}

/** The feature (`--slug`, else the resolved one) and its current stage, with a note for what is missing. */
function stageFor({ repoRoot, projectRoot, slug, missing }) {
  let feature = slug || null;
  if (!feature) {
    const resolved = resolveActiveFeature({ projectRoot });
    if (resolved.error) { missing.push(`feature: ${resolved.error}`); return null; }
    feature = resolved.paths.feature_slug || null;
    if (!feature) { missing.push('feature: no feature slug resolved'); return null; }
  }
  const current = currentStageOf({ repoRoot, projectRoot, taskId: feature });
  if (!current) {
    missing.push(`run: no run at a stage for feature '${feature}'`);
    return { feature, runTaskId: null, stageId: null, skill: null };
  }
  return { feature, runTaskId: feature, ...current };
}

/**
 * The `brief-tools` verb (IC-016). Exit 0 on every outcome except a usage error (2); an unexpected
 * failure exits 1, and the brief generator fails open on any non-zero status.
 * @param {Object} options
 * @param {Function} [options.buildAdapters] builds the adapter registry `mcpReach` reads installs through
 * @param {Function} [options.probe] injection seam for `probeProviders`
 */
function handleBriefToolsCommand({ owner, tier, harness, slug, headingLevel, json = false, repoRoot = REPO_ROOT, projectRoot = process.cwd(), buildAdapters = null, probe = probeProviders } = {}) {
  if (!owner) return usageError('brief-tools', '--owner is required (the agent type the brief is for)', json);
  const level = headingLevel === undefined ? 2 : Number(headingLevel);
  if (level !== 2 && level !== 3) return usageError('brief-tools', `--heading-level must be 2 or 3, got '${headingLevel}'`, json);
  try {
    const registry = loadRegistry({ repoRoot });
    const router = new CapabilityRouter({ repoRoot, projectRoot });
    const probes = probe({ repoRoot, projectRoot, router });
    const notes = [];
    let reach = null;
    try { reach = mcpReach({ registry, projectRoot, adapters: buildAdapters ? buildAdapters() : undefined }); } catch { notes.push('install facts unavailable; MCP reach unknown'); }
    const stage = stageFor({ repoRoot, projectRoot, slug, missing: notes });
    const { markdown, record } = renderBriefTools({ registry, router, probes, reach, owner, tier, harness, headingLevel: level, stage });
    record.missing.push(...notes);
    if (json) console.log(JSON.stringify({ markdown, record }, null, 2));
    else process.stdout.write(markdown);
    return finishRuntime(0);
  } catch (error) {
    captureCaught(error, 'brief-tools', 1);
    console.error(`[ERROR] brief-tools: ${error.message}`);
    return finishRuntime(1);
  }
}

module.exports = { renderBriefTools, currentStageOf, handleBriefToolsCommand };
