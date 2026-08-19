'use strict';

// Codex hook planning intentionally keeps deployment separate from CLI wiring.  Command hooks
// execute code, so a plan fails closed for malformed definitions, missing wrappers, or wrappers
// that are not executable.  Trust is reported as a prerequisite rather than being bypassed.
const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED_EVENTS = new Set([
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
  'UserPromptSubmit', 'SubagentStop', 'Stop', 'SessionStart', 'SubagentStart', 'SessionEnd',
]);

function validationError(errors, message) { errors.push(message); }

function validateHooksConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, errors: ['Hook configuration must be an object'], events: [] };
  }
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) {
    return { ok: false, errors: ['Hook configuration requires a hooks object'], events: [] };
  }
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!SUPPORTED_EVENTS.has(event)) {
      validationError(errors, `Unsupported Codex hook event '${event}'`);
      continue;
    }
    if (!Array.isArray(groups) || groups.length === 0) {
      validationError(errors, `Hook event '${event}' requires a non-empty array of matcher groups`);
      continue;
    }
    groups.forEach((group, groupIndex) => {
      if (!group || typeof group !== 'object' || Array.isArray(group)) {
        validationError(errors, `Hook event '${event}' group ${groupIndex} must be an object`);
        return;
      }
      if (group.matcher !== undefined && typeof group.matcher !== 'string') {
        validationError(errors, `Hook event '${event}' group ${groupIndex} matcher must be a string`);
      }
      if (!Array.isArray(group.hooks) || group.hooks.length === 0) {
        validationError(errors, `Hook event '${event}' group ${groupIndex} requires a non-empty hooks array`);
        return;
      }
      group.hooks.forEach((handler, handlerIndex) => {
        const label = `Hook event '${event}' group ${groupIndex} handler ${handlerIndex}`;
        if (!handler || typeof handler !== 'object' || Array.isArray(handler)) {
          validationError(errors, `${label} must be an object`);
          return;
        }
        if (handler.type !== 'command') validationError(errors, `${label} must use type 'command'`);
        if (typeof handler.command !== 'string' || !handler.command.trim()) {
          validationError(errors, `${label} requires a non-empty command`);
        }
        if (handler.timeout !== undefined && (!Number.isFinite(handler.timeout) || handler.timeout <= 0)) {
          validationError(errors, `${label} timeout must be a positive number`);
        }
        if (event === 'SessionEnd' && handler.timeout !== undefined && handler.timeout > 3) {
          validationError(errors, `${label} timeout may not exceed 3 seconds for SessionEnd`);
        }
        if (handler.statusMessage !== undefined && typeof handler.statusMessage !== 'string') {
          validationError(errors, `${label} statusMessage must be a string`);
        }
      });
    });
  }
  return { ok: errors.length === 0, errors, events: Object.keys(config.hooks) };
}

/** Maps Claude guardrail intent, never fabricating a Codex equivalent for unavailable events. */
function classifyClaudeGuardrails(claudeHooks = {}) {
  const supported = [];
  const unsupported = [];
  for (const [event, groups] of Object.entries(claudeHooks || {})) {
    const item = { sourceEvent: event, targetEvent: event, groups: Array.isArray(groups) ? groups.length : 0 };
    if (SUPPORTED_EVENTS.has(event)) supported.push(item);
    else unsupported.push({ ...item, targetEvent: null, reason: `Codex does not support the Claude '${event}' lifecycle event` });
  }
  return { supported, unsupported };
}

function commandScriptNames(command) {
  // DoFlow's wrappers are shell scripts selected from a project or CODEX_HOME hooks directory.
  // Extracting the basename works for both literal and command-substitution based paths.
  return [...new Set((command.match(/[A-Za-z0-9][A-Za-z0-9_-]*\.sh\b/g) || []))];
}

function hookHandlers(config) {
  return Object.entries(config.hooks || {}).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((group) =>
      (Array.isArray(group?.hooks) ? group.hooks : []).map((handler) => ({ event, handler }))));
}

function verifyHookCommands(config, { scriptsDir, trusted = false, fsImpl = fs } = {}) {
  const checks = [];
  for (const { event, handler } of hookHandlers(config)) {
    if (!handler || handler.type !== 'command' || typeof handler.command !== 'string' || !handler.command.trim()) continue;
    const names = commandScriptNames(handler.command);
    if (names.length === 0) {
      checks.push({ event, command: handler.command, ok: false, reason: 'Command does not identify a hook script', requiresTrust: true, trusted });
      continue;
    }
    for (const name of names) {
      const file = scriptsDir ? path.join(scriptsDir, name) : null;
      const exists = Boolean(file && fsImpl.existsSync(file));
      const executable = exists && Boolean(fsImpl.statSync(file).mode & 0o111);
      checks.push({ event, command: handler.command, script: name, file, exists, executable,
        ok: exists && executable, reason: !exists ? 'Hook script is missing' : (!executable ? 'Hook script is not executable' : null),
        requiresTrust: true, trusted });
    }
  }
  return { ok: checks.every((check) => check.ok), checks, trust: { required: checks.length > 0, trusted: Boolean(trusted), status: trusted ? 'trusted' : 'review-required' } };
}

function destinationFor(context = {}) {
  if (context.hooksFile) return context.hooksFile;
  if (context.destination) return context.destination;
  if (context.scope === 'project') {
    if (!context.projectRoot) throw new Error('projectRoot is required for project Codex hooks');
    return path.join(context.projectRoot, '.codex', 'hooks.json');
  }
  if (context.scope === 'global') {
    if (!context.codexDir) throw new Error('codexDir is required for global Codex hooks');
    return path.join(context.codexDir, 'hooks.json');
  }
  throw new Error('A hook destination or Codex scope is required');
}

function planCodexHooks({ config, sourceFile, sourceHooksDir, destinationContext = {}, trusted = false, fsImpl = fs } = {}) {
  let desired = config;
  try {
    if (!desired && sourceFile) desired = JSON.parse(fsImpl.readFileSync(sourceFile, 'utf8'));
  } catch (error) {
    return { ok: false, status: 'malformed', changes: [], errors: [`Could not parse ${sourceFile}: ${error.message}`] };
  }
  const schema = validateHooksConfig(desired);
  let destination;
  try { destination = destinationFor(destinationContext); } catch (error) {
    return { ok: false, status: 'invalid-request', changes: [], errors: [...schema.errors, error.message] };
  }
  const commands = verifyHookCommands(desired || {}, { scriptsDir: sourceHooksDir, trusted, fsImpl });
  const errors = [...schema.errors, ...commands.checks.filter((check) => !check.ok).map((check) => `${check.event}: ${check.reason}${check.script ? ` (${check.script})` : ''}`)];
  const content = schema.ok ? `${JSON.stringify(desired, null, 2)}\n` : null;
  const original = fsImpl.existsSync(destination) ? fsImpl.readFileSync(destination, 'utf8') : '';
  if (errors.length) return { ok: false, status: 'invalid-request', destination, original, changes: [], errors, commands };
  const changed = original !== content;
  return { ok: true, status: changed ? 'change' : 'unchanged', destination, original, content,
    changes: changed ? [{ type: fsImpl.existsSync(destination) ? 'update' : 'create', file: destination }] : [],
    errors: [], commands, trust: commands.trust, scriptsDir: sourceHooksDir,
    destinationHooksDir: destinationContext.hooksDir || path.join(path.dirname(destination), 'hooks') };
}

function deployCodexHooks(plan, { dryRun = false, fsImpl = fs } = {}) {
  if (!plan.ok) return { ...plan, applied: false };
  if (dryRun || plan.status === 'unchanged') return { ...plan, applied: false };
  fsImpl.mkdirSync(path.dirname(plan.destination), { recursive: true });
  const temporary = path.join(path.dirname(plan.destination), `.${path.basename(plan.destination)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fsImpl.writeFileSync(temporary, plan.content, { flag: 'wx' });
    fsImpl.renameSync(temporary, plan.destination);
  } finally {
    if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary);
  }
  const deployed = new Set();
  for (const check of plan.commands.checks) {
    const target = path.join(plan.destinationHooksDir, check.script);
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.copyFileSync(check.file, target);
    fsImpl.chmodSync(target, fsImpl.statSync(check.file).mode & 0o777);
    deployed.add(check.script);
  }
  // A script named directly in a hooks.json command isn't the only file a hook can depend on —
  // sourced helper libraries (lib.sh) and runtime-read config (*.conf) are never named in a
  // command string, so commandScriptNames() can't discover them. Deploy every other file in
  // scriptsDir too, so a hook that resolves a sibling path at runtime (not just at invocation)
  // finds it. hooks.json itself lives alongside the scripts but is deployed separately above.
  if (plan.scriptsDir && fsImpl.existsSync(plan.scriptsDir)) {
    for (const name of fsImpl.readdirSync(plan.scriptsDir)) {
      if (deployed.has(name) || name.endsWith('.json')) continue;
      const source = path.join(plan.scriptsDir, name);
      if (!fsImpl.statSync(source).isFile()) continue;
      const target = path.join(plan.destinationHooksDir, name);
      fsImpl.mkdirSync(path.dirname(target), { recursive: true });
      fsImpl.copyFileSync(source, target);
      fsImpl.chmodSync(target, fsImpl.statSync(source).mode & 0o777);
    }
  }
  return { ...plan, applied: true };
}

module.exports = { SUPPORTED_EVENTS, validateHooksConfig, classifyClaudeGuardrails, verifyHookCommands, planCodexHooks, deployCodexHooks };
