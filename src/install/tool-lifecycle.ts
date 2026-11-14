'use strict';

// External-tool lifecycle coordination deliberately uses execFile-style argument vectors.
// Commands in the registry are data, never shell snippets, so neither inspection nor mutation
// needs interpolation or a shell process.
//
// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): authored as `.ts`, run directly by Node
// native type-stripping — no build step, no runtime dependency. Body stays CommonJS so a `.js`
// caller's `require('../install/tool-lifecycle.ts')` keeps working while the tree is still `.js`.
const { execFileSync } = require('node:child_process');

const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux']);

type ExecFileSyncImpl = (file: string, args: string[], opts: any) => any;

function isSupportedPlatform(platform: string = process.platform): boolean {
  return SUPPORTED_PLATFORMS.has(platform);
}

function commandText(command: string[]): string {
  return command.map((part) => JSON.stringify(part)).join(' ');
}

/** A command as a person would type it: parts with spaces or shell characters are quoted, the rest are not. */
function plainCommand(command: string[]): string {
  return command.map((part) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}

function failureKind(error: any): 'absent' | 'failed' {
  return error?.code === 'ENOENT' ? 'absent' : 'failed';
}

function runInspection(command: string[], execFileSyncImpl: ExecFileSyncImpl): any {
  try {
    const output = execFileSyncImpl(command[0], command.slice(1), { encoding: 'utf8', stdio: 'pipe' });
    return { command: [...command], result: 'succeeded', output: output == null ? '' : String(output) };
  } catch (error: any) {
    return {
      command: [...command], result: failureKind(error),
      error: error?.message || String(error),
    };
  }
}

/** Reduce every status command result to a safe tool state. */
function normalizeToolState(inspections: any[]): string {
  if (inspections.every((inspection) => inspection.result === 'succeeded')) return 'installed';
  if (inspections.every((inspection) => inspection.result === 'absent')) return 'absent';
  if (inspections.some((inspection) => inspection.result === 'succeeded')) return 'unknown';
  return 'inspection-failed';
}

function inspectTool(tool: any, { execFileSyncImpl = execFileSync }: { execFileSyncImpl?: ExecFileSyncImpl } = {}): any {
  const inspections = tool.status.commands.map((command: string[]) => runInspection(command, execFileSyncImpl));
  return { state: normalizeToolState(inspections), inspections };
}

function inspectPrerequisites(tool: any, { execFileSyncImpl = execFileSync }: { execFileSyncImpl?: ExecFileSyncImpl } = {}): any[] {
  return (tool.prerequisites || []).map((name: string) => {
    const inspection = runInspection([name, '--version'], execFileSyncImpl);
    return { name, available: inspection.result === 'succeeded', inspection };
  });
}

/** Every way the registry knows to install a tool: its `routes`, or its single `command` as one route. */
function installRoutes(tool: any): any[] {
  if (!tool.install) return [];
  if (tool.install.routes) return tool.install.routes;
  return [{ installer: tool.install.command[0], command: tool.install.command, evidence: tool.officialEvidence[0] }];
}

/**
 * The first install route that fits this machine: its platform matches and its installer is on PATH.
 * `isInstalled(name)` answers whether an installer is present. Without a route the result says why
 * and names the documentation page, so a person can still install the tool by hand.
 */
function chooseInstallRoute(tool: any, { platform = process.platform, isInstalled }: { platform?: string; isInstalled: (name: string) => boolean }): any {
  const docs = tool.officialEvidence[0];
  const routes = installRoutes(tool).filter((route) => !route.platforms || route.platforms.includes(platform));
  if (!routes.length) return { reason: `no verified install command is registered for ${platform}; see ${docs}`, docs };
  const route = routes.find((candidate) => isInstalled(candidate.installer));
  if (route) {
    return { route: { installer: route.installer, command: [...route.command], after: (route.after || []).map((step: string[]) => [...step]), privileged: route.privileged === true, evidence: route.evidence } };
  }
  const needs = [...new Set(routes.map((candidate) => candidate.installer))].join(', ');
  return { reason: `missing installer: needs ${needs} on PATH; see ${docs}`, docs };
}

/** `chooseInstallRoute`'s answer as plain data: the command chosen, or why there is none and where to read. */
function describeInstall(chosen: any): any {
  if (!chosen) return null;
  const { route, reason, docs } = chosen;
  if (!route) return { command: null, reason, docs };
  return { command: route.command, after: route.after, privileged: route.privileged, runnable: !route.privileged, evidence: route.evidence };
}

function actionEligibility(tool: any, state: string, action: string, prerequisites: any[], chosen: any = null): any {
  if (action === 'status') return { applicable: false, reason: 'status inspection only' };
  if (action === 'install') {
    if (state === 'unknown' || state === 'inspection-failed') return { applicable: false, reason: `tool state is ${state}` };
    if (state !== 'absent') return { applicable: false, reason: 'tool is already installed' };
    if (!chosen.route) return { applicable: false, reason: chosen.reason };
    if (chosen.route.privileged) {
      return { applicable: false, reason: `needs administrator rights, so DoFlow does not run it; run it yourself: ${plainCommand(chosen.route.command)}` };
    }
    return { applicable: true, command: chosen.route.command, followUps: chosen.route.after, status: 'not-attempted' };
  }
  const contract = tool[action];
  if (!contract) return { applicable: false, reason: `no verified ${action} command is registered` };
  const missing = prerequisites.filter((prerequisite) => !prerequisite.available);
  if (missing.length) return { applicable: false, reason: `missing prerequisite: ${missing.map((item) => item.name).join(', ')}` };
  if (state === 'unknown' || state === 'inspection-failed') {
    return { applicable: false, reason: `tool state is ${state}` };
  }
  if ((action === 'update' || action === 'uninstall') && state !== 'installed') {
    return { applicable: false, reason: 'tool is not installed' };
  }
  // The plan records a command before execution begins; callers can show this preview without
  // implying that it has run. executeToolLifecycle replaces this with a terminal result.
  return { applicable: true, command: [...contract.command], status: 'not-attempted' };
}

/**
 * Inspect all status command vectors, then create a non-mutating action plan.
 * The registry can be the loaded registry or an { externalTools } fixture.
 */
function planToolLifecycle({ registry, action = 'status', platform = process.platform, execFileSyncImpl = execFileSync }: { registry?: any; action?: string; platform?: string; execFileSyncImpl?: ExecFileSyncImpl } = {}): any {
  if (!['install', 'update', 'uninstall', 'status'].includes(action)) {
    throw new Error(`Unsupported external-tool action '${action}'`);
  }
  const supported = isSupportedPlatform(platform);
  // One plan asks each distinct command once: two tools needing `uv` share one `uv --version`.
  const answers = new Map<string, { value?: any; error?: any }>();
  const execOnce: ExecFileSyncImpl = (file, args, opts) => {
    const key = JSON.stringify([file, ...args]);
    if (!answers.has(key)) {
      try { answers.set(key, { value: execFileSyncImpl(file, args, opts) }); } catch (error) { answers.set(key, { error }); }
    }
    const answer = answers.get(key) as { value?: any; error?: any };
    if ('error' in answer) throw answer.error;
    return answer.value;
  };
  const isInstalled = (name: string): boolean => runInspection([name, '--version'], execOnce).result === 'succeeded';
  const tools = (registry?.externalTools || []).map((tool: any) => {
    if (!supported) {
      return {
        tool, state: 'unknown', inspections: [], prerequisites: [],
        action: { applicable: false, reason: `unsupported platform: ${platform}` },
      };
    }
    const { state, inspections } = inspectTool(tool, { execFileSyncImpl: execOnce });
    const prerequisites = inspectPrerequisites(tool, { execFileSyncImpl: execOnce });
    // Installers are probed only for a tool that is absent: a present tool needs no install route.
    const install = state === 'absent' ? chooseInstallRoute(tool, { platform, isInstalled }) : null;
    return { tool, state, inspections, prerequisites, install, action: actionEligibility(tool, state, action, prerequisites, install) };
  });
  return { action, platform, supported, tools };
}

function defaultDisplay(command: string[]): void { console.error(`[INFO]  ${commandText(command)}`); }

/**
 * Display and separately confirm every planned mutation.  A failed command never prevents later
 * commands from being independently offered and executed.
 */
function executeToolLifecycle({ plan, execFileSyncImpl = execFileSync, displayCommand = defaultDisplay, confirmCommand }: { plan?: any; execFileSyncImpl?: ExecFileSyncImpl; displayCommand?: (command: string[], tool?: any, action?: string) => void; confirmCommand?: (command: string[], tool?: any, action?: string) => boolean } = {}): any {
  if (!plan) throw new Error('executeToolLifecycle requires a plan');
  if (typeof confirmCommand !== 'function') throw new Error('executeToolLifecycle requires confirmCommand');

  const notAttempted = plan.tools
    .filter((item: any) => item.action.applicable)
    .map((item: any) => ({ tool: item.tool.id, status: 'not-attempted', command: [...item.action.command] }));
  const results = [];
  for (const item of plan.tools) {
    const action = item.action;
    if (!plan.supported || !action.applicable) {
      results.push({ tool: item.tool.id, status: 'skipped', reason: action.reason });
      continue;
    }
    const run = (command: string[]): any => {
      displayCommand([...command], item.tool, plan.action);
      if (!confirmCommand([...command], item.tool, plan.action)) return { status: 'declined', command: [...command] };
      try {
        const output = execFileSyncImpl(command[0], command.slice(1), { encoding: 'utf8', stdio: 'pipe' });
        return { status: 'succeeded', command: [...command], output: output == null ? '' : String(output) };
      } catch (error: any) {
        return { status: 'failed', command: [...command], error: error?.message || String(error) };
      }
    };
    const result: any = { tool: item.tool.id, ...run(action.command) };
    // A step that follows the install (a browser download, say) is shown and confirmed on its own,
    // and only after the install command itself succeeded; the first one that does not succeed ends the chain.
    if (result.status === 'succeeded' && action.followUps?.length) {
      result.followUps = [];
      for (const step of action.followUps) {
        const outcome = run(step);
        result.followUps.push(outcome);
        if (outcome.status !== 'succeeded') break;
      }
    }
    results.push(result);
  }
  return { action: plan.action, notAttempted, results };
}

// Deliberately no plan-then-execute convenience wrapper. One existed and nothing called it: the
// only caller, `doflow tools`, plans and executes as two steps precisely so a confirmation lands
// between them (`src/cli/commands/tools.js` refuses `--force` for that reason). A single call that
// did both would be the one code path able to run an install command unconfirmed, so the gap is
// the safety property rather than an omission to fill.
module.exports = {
  SUPPORTED_PLATFORMS,
  isSupportedPlatform,
  commandText,
  plainCommand,
  installRoutes,
  chooseInstallRoute,
  describeInstall,
  normalizeToolState,
  inspectTool,
  inspectPrerequisites,
  planToolLifecycle,
  executeToolLifecycle,
};
