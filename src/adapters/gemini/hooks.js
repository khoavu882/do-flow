'use strict';

// Gemini hook planning. Unlike Codex (which owns a standalone hooks.json file), Gemini's hooks
// live as a "hooks" key inside settings.json — a file DoFlow does not fully own (it commonly
// pre-exists with unrelated content: mcpServers, ui, telemetry, model, etc.). planGeminiHooks
// therefore returns a key-scoped merge plan, never a full-file replace.
//
// NOTE: validateHooksConfig below intentionally duplicates codex-hooks.js's shape-checking logic
// (event -> array of {matcher, hooks:[{type,command,...}]} groups) rather than sharing it, since
// unifying it would mean introducing a new shared module beyond this feature's planned scope
// (agent-docs/doflow/013-codex-gemini-hooks-parity/plan.md's component list). Worth factoring out
// if a third harness with the same shape is ever added.
const fs = require('node:fs');
const path = require('node:path');
const { verifyHookCommands } = require('../hook-commands');

const SUPPORTED_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'BeforeAgent', 'AfterAgent', 'BeforeModel', 'AfterModel',
  'BeforeToolSelection', 'BeforeTool', 'AfterTool', 'PreCompress', 'Notification',
]);

// Claude guardrail event -> Gemini event, only where a real Gemini event has matching semantics
// (source: geminicli.com/docs/hooks/reference.md). UserPromptSubmit,
// Stop, SubagentStart/Stop, and ConfigChange have no correct Gemini equivalent and are
// intentionally omitted rather than approximated onto BeforeAgent/AfterAgent (design.md §7/§8 —
// no false parity).
const CLAUDE_TO_GEMINI_EVENT = {
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  PreToolUse: 'BeforeTool',
  PostToolUse: 'AfterTool',
  PreCompact: 'PreCompress',
};

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
      validationError(errors, `Unsupported Gemini hook event '${event}'`);
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
          validationError(errors, `${label} must be an object`); return;
        }
        if (handler.type !== 'command') validationError(errors, `${label} must have type 'command'`);
        if (typeof handler.command !== 'string' || !handler.command.trim()) {
          validationError(errors, `${label} requires a non-empty command string`);
        }
        if (handler.timeout !== undefined && typeof handler.timeout !== 'number') {
          validationError(errors, `${label} timeout must be a number`);
        }
      });
    });
  }
  return { ok: errors.length === 0, errors, events: Object.keys(config.hooks) };
}

/** Maps Claude guardrail intent, never fabricating a Gemini equivalent for unavailable events. */
function classifyClaudeGuardrails(claudeHooks = {}) {
  const supported = [];
  const unsupported = [];
  for (const [event, groups] of Object.entries(claudeHooks || {})) {
    const targetEvent = CLAUDE_TO_GEMINI_EVENT[event] || null;
    const item = { sourceEvent: event, targetEvent, groups: Array.isArray(groups) ? groups.length : 0 };
    if (targetEvent) supported.push(item);
    else unsupported.push({ ...item, reason: `Gemini has no equivalent lifecycle event for Claude's '${event}'` });
  }
  return { supported, unsupported };
}

/**
 * Plan a key-scoped merge of a "hooks" config into an existing (or absent) settings.json, never
 * touching any other key. Mirrors src/mcp.js's readJsonOrThrow discipline: a settings.json that
 * exists but fails to parse is a hard error, not silently treated as empty (this path merges
 * into content DoFlow does not own — a malformed-file work-around here risks losing it).
 */
function planGeminiHooks({ config, sourceFile, sourceHooksDir, settingsFile, trusted = false, fsImpl = fs } = {}) {
  let desired = config;
  try {
    if (!desired && sourceFile) desired = JSON.parse(fsImpl.readFileSync(sourceFile, 'utf8'));
  } catch (error) {
    return { ok: false, status: 'malformed', changes: [], errors: [`Could not parse ${sourceFile}: ${error.message}`] };
  }
  if (!settingsFile) return { ok: false, status: 'invalid-request', changes: [], errors: ['settingsFile is required'] };
  const schema = validateHooksConfig(desired);
  const commands = verifyHookCommands(desired || {}, { scriptsDir: sourceHooksDir, trusted, fsImpl });
  const errors = [...schema.errors, ...commands.checks.filter((check) => !check.ok).map((check) => `${check.event}: ${check.reason}${check.script ? ` (${check.script})` : ''}`)];

  let existing = {};
  if (fsImpl.existsSync(settingsFile)) {
    try { existing = JSON.parse(fsImpl.readFileSync(settingsFile, 'utf8')); }
    catch (error) { return { ok: false, status: 'malformed', changes: [], errors: [`Refusing to touch malformed ${settingsFile}: ${error.message}`] }; }
  }
  if (errors.length) return { ok: false, status: 'invalid-request', settingsFile, existing, changes: [], errors, commands };

  const merged = { ...existing, hooks: desired.hooks };
  const changed = JSON.stringify(existing.hooks) !== JSON.stringify(desired.hooks);
  return { ok: true, status: changed ? 'change' : 'unchanged', settingsFile, existing, merged,
    changes: changed ? [{ type: fsImpl.existsSync(settingsFile) ? 'update' : 'create', file: settingsFile, key: 'hooks' }] : [],
    errors: [], commands, trust: commands.trust, scriptsDir: sourceHooksDir,
    destinationHooksDir: path.join(path.dirname(settingsFile), 'hooks') };
}

function deployGeminiHooks(plan, { dryRun = false, fsImpl = fs } = {}) {
  if (!plan.ok) return { ...plan, applied: false };
  if (dryRun || plan.status === 'unchanged') return { ...plan, applied: false };
  fsImpl.mkdirSync(path.dirname(plan.settingsFile), { recursive: true });
  const content = `${JSON.stringify(plan.merged, null, 2)}\n`;
  const temporary = path.join(path.dirname(plan.settingsFile), `.${path.basename(plan.settingsFile)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fsImpl.writeFileSync(temporary, content, { flag: 'wx' });
    fsImpl.renameSync(temporary, plan.settingsFile);
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

/**
 * Plan stripping just the "hooks" key back out of settings.json — mirrors this codebase's
 * existing GEMINI.md-instructions removal (structural presence check, not a ledger fingerprint
 * cross-check): if the key isn't present, there's nothing to do; otherwise propose removing only
 * that key, leaving every other key in the shared file untouched (FR-002).
 */
function planRemoveGeminiHooks({ settingsFile, fsImpl = fs } = {}) {
  if (!settingsFile) return { ok: false, status: 'invalid-request', changes: [], errors: ['settingsFile is required'] };
  if (!fsImpl.existsSync(settingsFile)) return { ok: true, status: 'unchanged', settingsFile, changes: [] };
  let existing;
  try { existing = JSON.parse(fsImpl.readFileSync(settingsFile, 'utf8')); }
  catch (error) { return { ok: false, status: 'malformed', changes: [], errors: [`Could not parse ${settingsFile}: ${error.message}`] }; }
  if (existing.hooks === undefined) return { ok: true, status: 'unchanged', settingsFile, changes: [] };
  const { hooks: _dropped, ...merged } = existing;
  return { ok: true, status: 'change', settingsFile, merged, changes: [{ type: 'update', file: settingsFile, key: 'hooks', operation: 'remove' }] };
}

function deployRemoveGeminiHooks(plan, { dryRun = false, fsImpl = fs } = {}) {
  if (!plan.ok || plan.status !== 'change' || dryRun) return { ...plan, applied: false };
  fsImpl.mkdirSync(path.dirname(plan.settingsFile), { recursive: true });
  const content = `${JSON.stringify(plan.merged, null, 2)}\n`;
  const temporary = path.join(path.dirname(plan.settingsFile), `.${path.basename(plan.settingsFile)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fsImpl.writeFileSync(temporary, content, { flag: 'wx' });
    fsImpl.renameSync(temporary, plan.settingsFile);
  } finally {
    if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary);
  }
  return { ...plan, applied: true };
}

module.exports = { SUPPORTED_EVENTS, validateHooksConfig, classifyClaudeGuardrails, verifyHookCommands, planGeminiHooks, deployGeminiHooks, planRemoveGeminiHooks, deployRemoveGeminiHooks };
