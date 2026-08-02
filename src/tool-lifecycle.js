'use strict';

// External-tool lifecycle coordination deliberately uses execFile-style argument vectors.
// Commands in the registry are data, never shell snippets, so neither inspection nor mutation
// needs interpolation or a shell process.
const { execFileSync } = require('node:child_process');

const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux']);

function isSupportedPlatform(platform = process.platform) {
  return SUPPORTED_PLATFORMS.has(platform);
}

function commandText(command) {
  return command.map((part) => JSON.stringify(part)).join(' ');
}

function failureKind(error) {
  return error?.code === 'ENOENT' ? 'absent' : 'failed';
}

function runInspection(command, execFileSyncImpl) {
  try {
    const output = execFileSyncImpl(command[0], command.slice(1), { encoding: 'utf8', stdio: 'pipe' });
    return { command: [...command], result: 'succeeded', output: output == null ? '' : String(output) };
  } catch (error) {
    return {
      command: [...command], result: failureKind(error),
      error: error?.message || String(error),
    };
  }
}

/** Reduce every status command result to a safe tool state. */
function normalizeToolState(inspections) {
  if (inspections.every((inspection) => inspection.result === 'succeeded')) return 'installed';
  if (inspections.every((inspection) => inspection.result === 'absent')) return 'absent';
  if (inspections.some((inspection) => inspection.result === 'succeeded')) return 'unknown';
  return 'inspection-failed';
}

function inspectTool(tool, { execFileSyncImpl = execFileSync } = {}) {
  const inspections = tool.status.commands.map((command) => runInspection(command, execFileSyncImpl));
  return { state: normalizeToolState(inspections), inspections };
}

function inspectPrerequisites(tool, { execFileSyncImpl = execFileSync } = {}) {
  return (tool.prerequisites || []).map((name) => {
    const inspection = runInspection([name, '--version'], execFileSyncImpl);
    return { name, available: inspection.result === 'succeeded', inspection };
  });
}

function actionEligibility(tool, state, action, prerequisites) {
  if (action === 'status') return { applicable: false, reason: 'status inspection only' };
  const contract = tool[action];
  if (!contract) return { applicable: false, reason: `no verified ${action} command is registered` };
  const missing = prerequisites.filter((prerequisite) => !prerequisite.available);
  if (missing.length) return { applicable: false, reason: `missing prerequisite: ${missing.map((item) => item.name).join(', ')}` };
  if (state === 'unknown' || state === 'inspection-failed') {
    return { applicable: false, reason: `tool state is ${state}` };
  }
  if (action === 'install' && state !== 'absent') return { applicable: false, reason: 'tool is already installed' };
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
function planToolLifecycle({ registry, action = 'status', platform = process.platform, execFileSyncImpl = execFileSync } = {}) {
  if (!['install', 'update', 'uninstall', 'status'].includes(action)) {
    throw new Error(`Unsupported external-tool action '${action}'`);
  }
  const supported = isSupportedPlatform(platform);
  const tools = (registry?.externalTools || []).map((tool) => {
    if (!supported) {
      return {
        tool, state: 'unknown', inspections: [], prerequisites: [],
        action: { applicable: false, reason: `unsupported platform: ${platform}` },
      };
    }
    const { state, inspections } = inspectTool(tool, { execFileSyncImpl });
    const prerequisites = inspectPrerequisites(tool, { execFileSyncImpl });
    return { tool, state, inspections, prerequisites, action: actionEligibility(tool, state, action, prerequisites) };
  });
  return { action, platform, supported, tools };
}

function defaultDisplay(command) { console.error(`[INFO]  ${commandText(command)}`); }

/**
 * Display and separately confirm every planned mutation.  A failed command never prevents later
 * commands from being independently offered and executed.
 */
function executeToolLifecycle({ plan, execFileSyncImpl = execFileSync, displayCommand = defaultDisplay, confirmCommand } = {}) {
  if (!plan) throw new Error('executeToolLifecycle requires a plan');
  if (typeof confirmCommand !== 'function') throw new Error('executeToolLifecycle requires confirmCommand');

  const notAttempted = plan.tools
    .filter((item) => item.action.applicable)
    .map((item) => ({ tool: item.tool.id, status: 'not-attempted', command: [...item.action.command] }));
  const results = [];
  for (const item of plan.tools) {
    const action = item.action;
    if (!plan.supported || !action.applicable) {
      results.push({ tool: item.tool.id, status: 'skipped', reason: action.reason });
      continue;
    }
    const command = action.command;
    displayCommand([...command], item.tool, plan.action);
    if (!confirmCommand([...command], item.tool, plan.action)) {
      results.push({ tool: item.tool.id, status: 'declined', command: [...command] });
      continue;
    }
    try {
      const output = execFileSyncImpl(command[0], command.slice(1), { encoding: 'utf8', stdio: 'pipe' });
      results.push({ tool: item.tool.id, status: 'succeeded', command: [...command], output: output == null ? '' : String(output) });
    } catch (error) {
      results.push({ tool: item.tool.id, status: 'failed', command: [...command], error: error?.message || String(error) });
    }
  }
  return { action: plan.action, notAttempted, results };
}

function runToolLifecycle(options = {}) {
  const plan = planToolLifecycle(options);
  const execution = executeToolLifecycle({ ...options, plan });
  return { plan, ...execution };
}

module.exports = {
  SUPPORTED_PLATFORMS,
  isSupportedPlatform,
  commandText,
  normalizeToolState,
  inspectTool,
  inspectPrerequisites,
  planToolLifecycle,
  executeToolLifecycle,
  runToolLifecycle,
};
