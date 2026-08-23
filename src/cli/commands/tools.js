'use strict';
// `doflow tools` — inspect or manage registered external tools (status/install/update/uninstall).
// --force is deliberately unavailable: every mutation gets its own confirmation.
const { confirm, promptLine } = require('../../helper/prompt');
const { loadRegistry } = require('../../registry');
const { commandText, planToolLifecycle, executeToolLifecycle } = require('../../install/tool-lifecycle');
const { REPO_ROOT } = require('../shared');

function selectExternalTools(registry, o) {
  let requested = o.tools;
  if (!requested) {
    const interactive = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
    if (!interactive) throw new Error("doflow tools: --tool is required when stdin is not an interactive terminal");
    const answer = promptLine('Select tools (rtk, graphify; comma-separated): ');
    requested = answer.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (!requested.length) throw new Error('doflow tools: select at least one tool');
  const available = new Set(registry.externalTools.map((tool) => tool.id));
  const unknown = [...new Set(requested)].filter((id) => !available.has(id));
  if (unknown.length) throw new Error(`doflow tools: unknown tool id(s): ${unknown.join(', ')}; expected: ${[...available].join(', ')}`);
  const wanted = new Set(requested);
  return registry.externalTools.filter((tool) => wanted.has(tool.id));
}

function toolJsonResults(plan, execution = null) {
  const executed = new Map((execution?.results || []).map((result) => [result.tool, result]));
  return plan.tools.map((item) => ({
    tool: item.tool.id,
    state: item.state,
    inspections: item.inspections,
    prerequisites: item.prerequisites.map((prerequisite) => ({ name: prerequisite.name, available: prerequisite.available })),
    action: item.action,
    result: executed.get(item.tool.id) ?? (item.action.applicable
      ? { tool: item.tool.id, status: 'not-attempted', command: [...item.action.command] }
      : { tool: item.tool.id, status: 'skipped', reason: item.action.reason }),
  }));
}

function cmdTools(o) {
  if (o.force) throw new Error("doflow tools: --force is not supported; each lifecycle command requires its own confirmation");
  if (!['status', 'install', 'update', 'uninstall'].includes(o.action)) {
    throw new Error(`doflow tools: unsupported action '${o.action}'; expected: status, install, update, uninstall`);
  }
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const tools = selectExternalTools(registry, o);
  const plan = planToolLifecycle({ registry: { ...registry, externalTools: tools }, action: o.action });

  if (o.dryRun) {
    if (!o.json) {
      console.log(`[DRY] External-tool ${o.action} plan:`);
      for (const item of plan.tools) {
        if (item.action.applicable) console.log(`[DRY]  ${item.tool.id}: ${commandText(item.action.command)}`);
        else console.log(`[DRY]  ${item.tool.id}: skipped (${item.action.reason})`);
      }
      console.log('[DRY] Dry run complete — no lifecycle commands executed');
    }
    if (o.json) console.log(JSON.stringify({ action: o.action, dryRun: true, results: toolJsonResults(plan) }, null, 2));
    return;
  }

  if (o.action === 'status') {
    if (o.json) {
      console.log(JSON.stringify({ action: o.action, dryRun: false, results: toolJsonResults(plan) }, null, 2));
      return;
    }
    for (const item of plan.tools) {
      console.log(`${item.tool.displayName}: ${item.state}${item.action.reason ? ` (${item.action.reason})` : ''}`);
    }
    return;
  }

  const execution = executeToolLifecycle({
    plan,
    displayCommand: (command, tool) => console.error(`[INFO]  ${tool.displayName}: ${commandText(command)}`),
    confirmCommand: (command, tool, action) => confirm(`Run ${tool.displayName} ${action}: ${commandText(command)}?`, false),
  });
  // Keep processing independent tools so the user receives every outcome, but make a confirmed
  // command failure visible to scripts and CI through the process result as well as the report.
  const hasFailures = execution.results.some((result) => result.status === 'failed');
  if (o.json) {
    console.log(JSON.stringify({ action: o.action, dryRun: false, results: toolJsonResults(plan, execution) }, null, 2));
    if (hasFailures) process.exitCode = 1;
    return;
  }
  for (const result of execution.results) {
    console.log(`${result.tool}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  }
  if (hasFailures) process.exitCode = 1;
}

module.exports = cmdTools;
