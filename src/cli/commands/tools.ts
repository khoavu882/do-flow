'use strict';
// `doflow tools` — list or manage registered external tools (status/install/update/uninstall).
// Status is read-only and needs no terminal; with no --tool it lists every registered tool.
// --force is deliberately unavailable: every mutation gets its own confirmation.
// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.
const { confirm, promptLine } = require('../../helper/prompt.ts');
const { loadRegistry } = require('../../registry/index.ts');
const { INSPECTION_TIMEOUT_MS, commandText, plainCommand, describeInstall, planToolLifecycle, executeToolLifecycle } = require('../../install/tool-lifecycle.ts');
const { REPO_ROOT } = require('../shared.ts');

function selectExternalTools(registry: any, o: any): any[] {
  let requested = o.tools;
  if (!requested && o.action === 'status') return registry.externalTools;
  if (!requested) {
    const interactive = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
    if (!interactive) throw new Error("doflow tools: --tool is required when stdin is not an interactive terminal");
    const answer = promptLine('Select tools (comma-separated ids; `doflow tools` lists them): ');
    requested = answer.split(',').map((item: string) => item.trim()).filter(Boolean);
  }
  if (!requested.length) throw new Error('doflow tools: select at least one tool');
  const available = new Set(registry.externalTools.map((tool: any) => tool.id));
  const unknown = [...new Set(requested)].filter((id) => !available.has(id));
  if (unknown.length) throw new Error(`doflow tools: unknown tool id(s): ${unknown.join(', ')}; expected: ${[...available].join(', ')}`);
  const wanted = new Set(requested);
  return registry.externalTools.filter((tool: any) => wanted.has(tool.id));
}

/** What happened and what to do when a status check gave no answer in time (a slow first start looks the same as a hang). */
function timeoutNote(item: any): any {
  if (item.state !== 'inspection-timeout') return null;
  const statusCommand = (item.inspections.find((inspection: any) => inspection.result === 'timeout') ?? item.inspections[0]).command;
  const seconds = INSPECTION_TIMEOUT_MS / 1000;
  return { seconds, statusCommand, message: `its status check did not answer within ${seconds} s (a slow first start can do this); run ${plainCommand(statusCommand)} yourself, then run \`doflow tools\` again` };
}

function toolJsonResults(plan: any, execution: any = null): any[] {
  const executed = new Map((execution?.results || []).map((result: any) => [result.tool, result]));
  return plan.tools.map((item: any) => ({
    tool: item.tool.id,
    displayName: item.tool.displayName,
    role: item.tool.role,
    unlocks: item.tool.unlocks,
    state: item.state,
    install: describeInstall(item.install),
    ...(timeoutNote(item) ? { timeout: timeoutNote(item) } : {}),
    inspections: item.inspections,
    prerequisites: item.prerequisites.map((prerequisite: any) => ({ name: prerequisite.name, available: prerequisite.available })),
    action: item.action,
    result: executed.get(item.tool.id) ?? (item.action.applicable
      ? { tool: item.tool.id, status: 'not-attempted', command: [...item.action.command] }
      : { tool: item.tool.id, status: 'skipped', reason: item.action.reason }),
  }));
}

const STATE_LABEL: Record<string, string> = { installed: 'present', absent: 'absent', 'inspection-timeout': 'timeout' };

/** Every planned tool, required first, then optional: present or absent, what it unlocks, and for an absent one how to get it. */
function printToolList(plan: any): void {
  const rows = plan.tools.map((item: any) => ({ item, label: STATE_LABEL[item.state] ?? 'unknown' }));
  const width = Math.max(...rows.map(({ item }: any) => item.tool.id.length));
  for (const role of ['required', 'optional']) {
    const group = rows.filter(({ item }: any) => item.tool.role === role);
    if (!group.length) continue;
    console.log(`${role === 'required' ? 'Required' : 'Optional'} tools`);
    for (const { item, label } of group) {
      const pad = ' '.repeat(11);
      console.log(`  ${label.padEnd(8)} ${item.tool.id.padEnd(width)}  ${item.tool.unlocks}`);
      if (!plan.supported) console.log(`${pad}${' '.repeat(width + 2)}${item.action.reason}`);
      const indent = `${pad}${' '.repeat(width + 2)}`;
      const timedOut = timeoutNote(item);
      if (timedOut) console.log(`${indent}${timedOut.message}`);
      const install = describeInstall(item.install);
      if (!install) continue;
      const steps = (command: string[], after: string[][] = []) => [command, ...after].map((part: string[]) => plainCommand(part)).join(', then ');
      if (!install.command) console.log(`${indent}install: ${install.reason}`);
      else {
        console.log(`${indent}install: ${steps(install.command, install.after)}${install.privileged ? ' (needs administrator rights; DoFlow does not run it)' : ''}`);
        if (install.runnable) console.log(`${indent}or run:  doflow tools --tool ${item.tool.id} --action install`);
        for (const step of install.manual) console.log(`${indent}run it yourself: ${plainCommand(step.command)} (${step.reason})`);
      }
      for (const route of install.alternatives || []) {
        console.log(`${indent}also: ${steps(route.command, route.after)}${route.privileged ? ' (needs administrator rights)' : ''} (${route.evidence})`);
      }
      if (install.alternatives?.length) console.log(`${indent}DoFlow updates and removes only what it installed through its first route, and runs no other.`);
    }
  }
}

function cmdTools(o: any): void {
  if (o.force) throw new Error("doflow tools: --force is not supported; each lifecycle command requires its own confirmation");
  if (!['status', 'install', 'update', 'uninstall'].includes(o.action)) {
    throw new Error(`doflow tools: unsupported action '${o.action}'; expected: status, install, update, uninstall`);
  }
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const tools = selectExternalTools(registry, o);
  const plan = planToolLifecycle({ registry: { ...registry, externalTools: tools }, action: o.action });

  if (o.action === 'status') {
    if (o.json) console.log(JSON.stringify({ action: o.action, dryRun: Boolean(o.dryRun), results: toolJsonResults(plan) }, null, 2));
    else printToolList(plan);
    return;
  }

  if (o.dryRun) {
    if (!o.json) {
      console.log(`[DRY] External-tool ${o.action} plan:`);
      for (const item of plan.tools) {
        if (item.action.applicable) {
          console.log(`[DRY]  ${item.tool.id}: ${commandText(item.action.command)}`);
          for (const step of item.action.followUps || []) console.log(`[DRY]  ${item.tool.id}: then ${commandText(step)}`);
          for (const step of item.action.manual || []) console.log(`[DRY]  ${item.tool.id}: run it yourself ${commandText(step.command)} (${step.reason}); DoFlow does not run it`);
        } else console.log(`[DRY]  ${item.tool.id}: skipped (${item.action.reason})`);
      }
      console.log('[DRY] Dry run complete — no lifecycle commands executed');
    }
    if (o.json) console.log(JSON.stringify({ action: o.action, dryRun: true, results: toolJsonResults(plan) }, null, 2));
    return;
  }

  const execution = executeToolLifecycle({
    plan,
    displayCommand: (command: string[], tool: any) => console.error(`[INFO]  ${tool.displayName}: ${commandText(command)}`),
    confirmCommand: (command: string[], tool: any, action: string) => confirm(`Run ${tool.displayName} ${action}: ${commandText(command)}?`, false),
  });
  // Keep processing independent tools so the user receives every outcome, but make a confirmed
  // command failure visible to scripts and CI through the process result as well as the report.
  const hasFailures = execution.results.some((result: any) => ['failed', 'refused'].includes(result.status)
    || (result.followUps || []).some((step: any) => ['failed', 'refused'].includes(step.status)));
  if (o.json) {
    console.log(JSON.stringify({ action: o.action, dryRun: false, results: toolJsonResults(plan, execution) }, null, 2));
    if (hasFailures) process.exitCode = 1;
    return;
  }
  for (const result of execution.results) {
    console.log(`${result.tool}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    for (const step of result.followUps || []) console.log(`${result.tool}: then ${commandText(step.command)}: ${step.status}${step.reason ? ` (${step.reason})` : ''}`);
    for (const step of result.manual || []) console.log(`${result.tool}: run it yourself: ${plainCommand(step.command)} (${step.reason})`);
  }
  if (hasFailures) process.exitCode = 1;
}

module.exports = cmdTools;
