'use strict';

// External-tool lifecycle coordination deliberately uses execFile-style argument vectors.
// Commands in the registry are data, never shell snippets, so neither inspection nor mutation
// needs interpolation or a shell process.
//
// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): authored as `.ts`, run directly by Node
// native type-stripping — no build step, no runtime dependency. Body stays CommonJS so a `.js`
// caller's `require('../install/tool-lifecycle.ts')` keeps working while the tree is still `.js`.
const { execFileSync, spawnSync } = require('node:child_process');

const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux']);
// A status command or an installer probe that has not answered by then leaves the tool's state at
// `inspection-timeout`; a hung binary must not hold up the whole list. Install commands have no limit.
const INSPECTION_TIMEOUT_MS = 5000;

// A command that hands another command to a more privileged user, and a wrapper that hides what runs
// (`env sudo ...`, `sh -c "..."`). The registry holds argv arrays, so neither belongs in a command
// DoFlow runs; the registry validator rejects both and `executeToolLifecycle` refuses them again.
const PRIVILEGE_WORDS = new Set(['sudo', 'doas', 'su', 'pkexec', 'run0']);
const WRAPPER_WORDS = new Set(['env', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh']);

/** The program a command runs, as a name: the last path segment (either separator), without a `.exe`/`.cmd`/`.bat` ending, in lower case. */
function programName(word: any): string {
  return String(word ?? '').split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

/** Why DoFlow will not run this command, or null when it may. A status check may be `<shell> --version` (the bash tool's own
 * check): it runs nothing but the program asked, so a wrapper word is allowed there and only there. */
function refusalReason(command: string[], { statusCheck = false }: { statusCheck?: boolean } = {}): string | null {
  const name = programName(command?.[0]);
  if (PRIVILEGE_WORDS.has(name)) return `a command starting with '${command[0]}' needs administrator rights, so DoFlow does not run it`;
  if (WRAPPER_WORDS.has(name) && !(statusCheck && command.length === 2 && command[1] === '--version')) return `a command starting with '${command[0]}' hides what it runs, so DoFlow does not run it`;
  return null;
}

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

/** End a probe's whole process tree. `spawnSync`'s timeout signals only the direct child, so a wrapper script that
 * started `sleep` would leave it running. On POSIX the probe is its own process group and the group is killed;
 * on Windows `taskkill /T /F` ends the tree (written from its documentation, not run on this machine). */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* the group is already gone */ }
}

/** `execFileSync` for a status check or installer probe: the same contract (stdout, or a thrown error whose `code` is
 * ENOENT or ETIMEDOUT), but past the timeout nothing the probe started is left running. */
function probeExec(file: string, args: string[], opts: any): any {
  const result = spawnSync(file, args, { encoding: 'utf8', stdio: 'pipe', timeout: opts.timeout, killSignal: 'SIGKILL', detached: process.platform !== 'win32' });
  if (result.error) {
    if ((result.error as any).code === 'ETIMEDOUT') killTree(result.pid);
    throw result.error;
  }
  if (result.status !== 0) {
    const error: any = new Error(`Command failed: ${file} ${args.join(' ')}${result.stderr ? `\n${result.stderr}` : ''}`);
    error.status = result.status;
    throw error;
  }
  return result.stdout;
}

function failureKind(error: any): 'absent' | 'timeout' | 'failed' {
  if (error?.code === 'ENOENT') return 'absent';
  return error?.code === 'ETIMEDOUT' ? 'timeout' : 'failed';
}

function runInspection(command: string[], execFileSyncImpl: ExecFileSyncImpl, timeoutMs: number = INSPECTION_TIMEOUT_MS): any {
  const refusal = refusalReason(command, { statusCheck: true });
  if (refusal) return { command: [...command], result: 'failed', error: refusal };
  try {
    const output = execFileSyncImpl(command[0], command.slice(1), { encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs });
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
  if (inspections.some((inspection) => inspection.result === 'timeout')) return 'inspection-timeout';
  if (inspections.every((inspection) => inspection.result === 'absent')) return 'absent';
  if (inspections.some((inspection) => inspection.result === 'succeeded')) return 'unknown';
  return 'inspection-failed';
}

function inspectTool(tool: any, { execFileSyncImpl = probeExec, timeoutMs = INSPECTION_TIMEOUT_MS }: { execFileSyncImpl?: ExecFileSyncImpl; timeoutMs?: number } = {}): any {
  const inspections = tool.status.commands.map((command: string[]) => runInspection(command, execFileSyncImpl, timeoutMs));
  return { state: normalizeToolState(inspections), inspections };
}

function inspectPrerequisites(tool: any, { execFileSyncImpl = probeExec, timeoutMs = INSPECTION_TIMEOUT_MS }: { execFileSyncImpl?: ExecFileSyncImpl; timeoutMs?: number } = {}): any[] {
  return (tool.prerequisites || []).map((name: string) => {
    const inspection = runInspection([name, '--version'], execFileSyncImpl, timeoutMs);
    return { name, available: inspection.result === 'succeeded', inspection };
  });
}

/** Every way the registry knows to install a tool: its `routes`, or its single `command` as one route. */
function installRoutes(tool: any): any[] {
  if (!tool.install) return [];
  if (tool.install.routes) return tool.install.routes;
  return [{ installer: tool.install.command[0], command: tool.install.command, evidence: tool.officialEvidence[0] }];
}

/** A route as plain data for the plan and the report. */
function routeView(route: any): any {
  return {
    installer: route.installer,
    command: [...route.command],
    after: (route.after || []).map((step: string[]) => [...step]),
    manual: (route.manual || []).map((step: any) => ({ command: [...step.command], reason: step.reason })),
    privileged: route.privileged === true,
    evidence: route.evidence,
  };
}

/** The routes that fit a platform, in registry order. The first is the managed one. */
function routesFor(tool: any, platform: string): any[] {
  return installRoutes(tool).filter((route) => !route.platforms || route.platforms.includes(platform));
}

/**
 * The managed install route for this machine: the first route of its platform. It is the only route
 * DoFlow runs, because it is the one `update` and `uninstall` are registered to handle; every other
 * route of the platform comes back as an `alternative` to show, never to run. `isInstalled(name)` answers
 * whether an installer is present. Without a usable route the result says why and names the page.
 */
function chooseInstallRoute(tool: any, { platform = process.platform, isInstalled }: { platform?: string; isInstalled: (name: string) => boolean }): any {
  const docs = tool.officialEvidence[0];
  const [managed, ...others] = routesFor(tool, platform);
  if (!managed) return { reason: `no verified install command is registered for ${platform}; see ${docs}`, docs };
  const alternatives = others.map(routeView);
  if (isInstalled(managed.installer)) return { route: routeView(managed), alternatives };
  return { reason: `missing installer: needs ${managed.installer} on PATH; see ${docs}`, docs, alternatives };
}

/** `chooseInstallRoute`'s answer as plain data: the command chosen, or why there is none and where to read. */
function describeInstall(chosen: any): any {
  if (!chosen) return null;
  const { route, reason, docs } = chosen;
  const alternatives = chosen.alternatives?.length ? { alternatives: chosen.alternatives } : {};
  if (!route) return { command: null, reason, docs, ...alternatives };
  return { command: route.command, after: route.after, manual: route.manual, privileged: route.privileged, runnable: !route.privileged, evidence: route.evidence, ...alternatives };
}

function actionEligibility(tool: any, state: string, action: string, prerequisites: any[], chosen: any = null, platform: string = process.platform): any {
  if (action === 'status') return { applicable: false, reason: 'status inspection only' };
  // update and uninstall handle what the managed route installed, and a route may carry its own pair.
  const contract = action === 'install' ? tool.install : (routesFor(tool, platform)[0]?.[action] ?? tool[action]);
  if (!contract) {
    return { applicable: false, reason: action === 'install' && chosen ? chosen.reason : `no verified ${action} command is registered` };
  }
  const missing = prerequisites.filter((prerequisite) => !prerequisite.available);
  if (missing.length) return { applicable: false, reason: `missing prerequisite: ${missing.map((item) => item.name).join(', ')}` };
  if (state === 'unknown' || state === 'inspection-failed' || state === 'inspection-timeout') {
    return { applicable: false, reason: `tool state is ${state}` };
  }
  if (action === 'install') {
    if (state !== 'absent') return { applicable: false, reason: 'tool is already installed' };
    if (!chosen.route) return { applicable: false, reason: chosen.reason };
    if (chosen.route.privileged) {
      return { applicable: false, reason: `needs administrator rights, so DoFlow does not run it; run it yourself: ${plainCommand(chosen.route.command)}` };
    }
    // Only the managed route is ever planned. Its steps that need administrator rights are `manual`: listed, never run.
    return { applicable: true, command: chosen.route.command, followUps: chosen.route.after, manual: chosen.route.manual, status: 'not-attempted' };
  }
  if (state !== 'installed') return { applicable: false, reason: 'tool is not installed' };
  // The plan records a command before execution begins; callers can show this preview without
  // implying that it has run. executeToolLifecycle replaces this with a terminal result.
  return { applicable: true, command: [...contract.command], status: 'not-attempted' };
}

/**
 * Inspect all status command vectors, then create a non-mutating action plan.
 * The registry can be the loaded registry or an { externalTools } fixture.
 */
function planToolLifecycle({ registry, action = 'status', platform = process.platform, execFileSyncImpl = probeExec, timeoutMs = INSPECTION_TIMEOUT_MS }: { registry?: any; action?: string; platform?: string; execFileSyncImpl?: ExecFileSyncImpl; timeoutMs?: number } = {}): any {
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
  const isInstalled = (name: string): boolean => runInspection([name, '--version'], execOnce, timeoutMs).result === 'succeeded';
  const tools = (registry?.externalTools || []).map((tool: any) => {
    if (!supported) {
      return {
        tool, state: 'unknown', inspections: [], prerequisites: [],
        action: { applicable: false, reason: `unsupported platform: ${platform}` },
      };
    }
    const { state, inspections } = inspectTool(tool, { execFileSyncImpl: execOnce, timeoutMs });
    const prerequisites = inspectPrerequisites(tool, { execFileSyncImpl: execOnce, timeoutMs });
    // Installers are probed only for a tool that is absent: a present tool needs no install route.
    const install = state === 'absent' ? chooseInstallRoute(tool, { platform, isInstalled }) : null;
    return { tool, state, inspections, prerequisites, install, action: actionEligibility(tool, state, action, prerequisites, install, platform) };
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
      // The registry validator rejects these too; this stays as the last line before the runner, for a registry it never saw.
      const refusal = refusalReason(command);
      if (refusal) return { status: 'refused', command: [...command], reason: refusal };
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
    if (result.status === 'succeeded' && action.manual?.length) result.manual = action.manual;
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
  INSPECTION_TIMEOUT_MS,
  PRIVILEGE_WORDS,
  WRAPPER_WORDS,
  programName,
  refusalReason,
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
