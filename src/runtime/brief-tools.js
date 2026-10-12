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

const { REPO_ROOT } = require('../helper/repo-root.ts');
const { loadRegistry } = require('../registry/index.ts');
const { CapabilityRouter } = require('./capability-router.ts');
const { probeProviders, HEALTHY, UNVERIFIED } = require('./health');
const { mcpReach } = require('./mcp-reach');
const { WorkflowOrchestrator } = require('./workflow-orchestrator');
const { resolveActiveFeature } = require('./feature-resolve.ts');
const { finishRuntime, usageError, captureCaught } = require('./cli-result.ts');
const fs = require('node:fs');
const path = require('node:path');
const { loadAdviceRegistry } = require('./advice/registry.ts');
const { loadStorageRegistry } = require('./storage/registry.ts');
const { resolveRoots } = require('./storage/roots.ts');
const { resolveSetting } = require('./advice/config.ts');
const { materializeKind } = require('./advice/kinds.ts');
const { createAdviceClient } = require('./advice/client.ts');
const { strengthWords } = require('./advice/strength.ts');

const SCHEMA = 1;
const REACHABLE = new Set(['selected', 'configured']);

/** The state of `server` on a harness: selected or configured on any of its scopes wins; absent
 * only when every scope says so from a complete view (IC-013); else unknown. */
function stateOn(reach, harnessId, server) {
  const rows = (reach?.harnesses || []).filter((row) => row.id === harnessId);
  if (rows.some((row) => row.servers[server] === 'selected')) return 'selected';
  if (rows.some((row) => row.servers[server] === 'configured')) return 'configured';
  const states = rows.map((row) => row.servers[server] ?? 'unknown');
  return states.length && !states.includes('unknown') ? states[0] : 'unknown';
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

/** Tier for a dispatch: the task line's tier when valid, else the owner's, else the default (IC-004).
 * A registry without `dispatchTiers` (the key is optional) gives `standard` with a note. */
function resolveTier({ dispatchTiers, owner, tier, missing }) {
  if (!dispatchTiers) {
    missing.push('models.json has no dispatchTiers; tier standard assumed');
    return { tier: 'standard', source: 'default', note: 'models.json has no dispatchTiers' };
  }
  if (tier !== undefined && tier !== null && tier !== '') {
    if (dispatchTiers.tiers.includes(tier)) return { tier, source: 'task' };
    missing.push(`tier '${tier}' is not in dispatchTiers.tiers; ignored`);
  }
  if (Object.hasOwn(dispatchTiers.byOwner, owner)) return { tier: dispatchTiers.byOwner[owner], source: 'owner' };
  missing.push(`owner '${owner}' has no tier in models.json dispatchTiers`);
  return { tier: dispatchTiers.default, source: 'default' };
}

/** The first provider of a capability whose probe status is `status`, in registry order, or null. */
function firstWith(router, capabilityId, probes, status) {
  return (router.capabilities[capabilityId]?.providers || []).find((provider) => probes[provider.id]?.status === status) || null;
}

/** What answers one route intent on this machine: a healthy provider of the primary capability,
 * else of the route's fallback capabilities in order; failing those, a provider that has no probe
 * (UNVERIFIED) in the same order; else nothing. An unhealthy provider is never chosen. */
function resolveRoute(router, route, probes) {
  const chain = [route.capability, ...(route.fallback || [])];
  for (const status of [HEALTHY, UNVERIFIED]) {
    for (const capability of chain) {
      const provider = firstWith(router, capability, probes, status);
      if (!provider) continue;
      const via = capability === route.capability ? null : 'fallback';
      return { capability, provider, status: status === UNVERIFIED ? 'UNVERIFIED' : via ? 'FALLBACK' : 'HEALTHY', via };
    }
  }
  return { capability: route.capability, provider: null, status: 'NONE', via: null };
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
    : resolved.source === 'task' ? 'task line' : `default; ${resolved.note || `owner ${owner} has no tier`}`;

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
    const named = found.status === 'UNVERIFIED' ? `${provider.id} (unverified: no probe)` : provider.id;
    const use = found.via === 'fallback' ? `no healthy ${route.capability} provider; fallback ${named}` : named;
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
    else state = reach ? reach.anyHarnessHas(server.id) ?? 'unknown' : 'unknown';
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
    '`references/MODEL_SELECTION.md`.',
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
  // `unreachable` is written only where every config the harness merges was read (IC-013), so it is
  // stated; a server DoFlow cannot confirm either way is hedged.
  for (const item of expected) {
    if (item.reach === 'unreachable') lines.push(`\`${item.server}\` is not reachable on ${targetName}; report it as \`${item.server}=unavailable\`.`);
    else if (item.reach === 'unknown') lines.push(`\`${item.server}\` may not be reachable on ${targetName}; if no tool answers, report \`${item.server}=unavailable\`.`);
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
function taskLinesForAdvice({ projectRoot, feature, tasks }) {
  if (!feature || !Array.isArray(tasks) || tasks.length === 0) throw new Error('feature or task ids are unavailable');
  const planPath = path.join(projectRoot, 'agent-docs', 'doflow', feature, 'plan.md');
  const plan = fs.readFileSync(planPath, 'utf8');
  return tasks.map((id) => {
    const line = plan.split(/\r?\n/).find((candidate) => candidate.match(/^- \[[ x]\] (\S+)/)?.[1] === id);
    if (!line) throw new Error(`task '${id}' was not found in ${planPath}`);
    return line;
  });
}

function adviceRecord(result) {
  if (result?.status === 'answered' && result.answers?.[0]) {
    const answer = result.answers[0];
    return {
      kind: 'tier', status: 'answered', pickId: answer.pickId, pick: answer.pick,
      strength: answer.strength?.word || 'leaning', between: answer.strength?.between ?? null,
      agrees: answer.agrees,
    };
  }
  if (result?.status === 'unavailable') return { kind: 'tier', status: 'unavailable', reason: result.reason || 'config-invalid' };
  return null;
}

/**
 * The tier renderer remains synchronous/pure; optional local advice is requested afterward.
 */
async function handleBriefToolsCommand({ owner, tier, harness, slug, headingLevel, tasks, json = false, repoRoot = REPO_ROOT, projectRoot = process.cwd(), buildAdapters = null, probe = probeProviders, adviceClient = null } = {}) {
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
    const rendered = renderBriefTools({ registry, router, probes, reach, owner, tier, harness, headingLevel: level, stage });
    let markdown = rendered.markdown;
    const record = rendered.record;
    record.missing.push(...notes);

    const taskIds = Array.isArray(tasks) ? tasks : typeof tasks === 'string' ? tasks.split(',').filter(Boolean) : [];
    if (taskIds.length) {
      try {
        const adviceRegistry = loadAdviceRegistry({ repoRoot });
        const storageRegistry = loadStorageRegistry({ repoRoot });
        const roots = resolveRoots({ registry: storageRegistry, projectRoot: path.resolve(projectRoot) });
        if (adviceRegistry.ok && (adviceClient || resolveSetting({ adviceRegistry: adviceRegistry.registry, roots }).state === 'on')) {
          const lines = taskLinesForAdvice({ projectRoot, feature: stage?.feature || slug, tasks: taskIds });
          const built = materializeKind('tier', { adviceRegistry: adviceRegistry.registry });
          const client = adviceClient || createAdviceClient({ adviceRegistry: adviceRegistry.registry, roots });
          const result = built.ok ? await client.ask({
            questionSet: { state: `${owner}\n${lines.join('\n')}`, questions: [built.question] },
            kind: 'tier', staticAnswer: record.tier, caller: 'brief-tools', taskId: stage?.feature || slug,
          }) : { status: 'unavailable', reason: built.reason || 'config-invalid' };
          const added = adviceRecord(result);
          if (added) {
            record.advice = added;
            if (added.status === 'answered') {
              const line = `Decision model: \`${added.pick}\` (${strengthWords({ word: added.strength, between: added.between })}), advisory. The tier above stands unless you change it.`;
              markdown = markdown.replace(/(Tier: `[^`]+`[^\n]*\n`references\/MODEL_SELECTION\.md`\.)\n\n/, `$1\n${line}\n\n`);
            }
          }
        }
      } catch (error) {
        record.advice = { kind: 'tier', status: 'unavailable', reason: error?.reason || 'config-invalid' };
      }
    }
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
