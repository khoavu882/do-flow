'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

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
const crypto = require('node:crypto');
const { verifyHookCommands } = require('../hook-commands.ts');
const { mergeHooks } = require('../../helper/settings-merge.ts');

const SUPPORTED_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'BeforeAgent', 'AfterAgent', 'BeforeModel', 'AfterModel',
  'BeforeToolSelection', 'BeforeTool', 'AfterTool', 'PreCompress', 'Notification',
]);

// Claude guardrail event -> Gemini event, only where a real Gemini event has matching semantics
// (source: geminicli.com/docs/hooks/reference.md). UserPromptSubmit,
// Stop, SubagentStart/Stop, and ConfigChange have no correct Gemini equivalent and are
// intentionally omitted rather than approximated onto BeforeAgent/AfterAgent (design.md §7/§8 —
// no false parity).
const CLAUDE_TO_GEMINI_EVENT: Record<string, string> = {
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  PreToolUse: 'BeforeTool',
  PostToolUse: 'AfterTool',
  PreCompact: 'PreCompress',
};

function validationError(errors: string[], message: string): void { errors.push(message); }

function validateHooksConfig(config: any): { ok: boolean, errors: string[], events: string[] } {
  const errors: string[] = [];
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
    groups.forEach((group: any, groupIndex: number) => {
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
      group.hooks.forEach((handler: any, handlerIndex: number) => {
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
function classifyClaudeGuardrails(claudeHooks: any = {}): { supported: any[], unsupported: any[] } {
  const supported: any[] = [];
  const unsupported: any[] = [];
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
/** Every regular, non-JSON file in the shipped scripts directory: what deployGeminiHooks copies. */
function shippedScripts(scriptsDir: any, fsImpl: any = fs): string[] {
  if (!scriptsDir || !fsImpl.existsSync(scriptsDir)) return [];
  return fsImpl.readdirSync(scriptsDir)
    .filter((name: string) => !name.endsWith('.json') && fsImpl.statSync(path.join(scriptsDir, name)).isFile());
}

/** DoFlow's record of a deployed hook script: the sha256 of its bytes. */
function scriptFingerprint(bytes: any): string { return crypto.createHash('sha256').update(bytes).digest('hex'); }

/** The scripts beside the config that differ from the shipped source (or are absent), by name, and
 * those among them a ledger row says were edited since DoFlow wrote them. A script with no row
 * (an install from before scripts were recorded) is DoFlow's to refresh: the config deploy always
 * overwrote it. `rows` are this harness's script rows: { target, fingerprint }. */
function planHookScripts({ commands, sourceHooksDir, destinationHooksDir, rows = [], force = false, fsImpl = fs }: any) {
  const sources = new Map<string, string>(commands.checks.map((check: any) => [check.script, check.file] as [string, string]));
  for (const name of shippedScripts(sourceHooksDir, fsImpl)) if (!sources.has(name)) sources.set(name, path.join(sourceHooksDir, name));
  const stale: string[] = [];
  const edited: string[] = [];
  for (const [name, source] of sources) {
    const target = path.join(destinationHooksDir, name);
    if (fsImpl.existsSync(target)) {
      const current = fsImpl.readFileSync(target);
      if (current.equals(fsImpl.readFileSync(source))) continue;
      const row = rows.find((item: any) => path.resolve(item.target) === path.resolve(target));
      if (row && row.fingerprint !== scriptFingerprint(current) && !force) edited.push(name);
    }
    stale.push(name);
  }
  return { names: [...sources.keys()], stale, edited };
}

function planGeminiHooks({ config, sourceFile, sourceHooksDir, settingsFile, destinationHooksDir: declaredHooksDir, trusted = false, scriptRows = [], force = false, fsImpl = fs }: any = {}): any {
  let desired = config;
  try {
    if (!desired && sourceFile) desired = JSON.parse(fsImpl.readFileSync(sourceFile, 'utf8'));
  } catch (error: any) {
    return { ok: false, status: 'malformed', changes: [], errors: [`Could not parse ${sourceFile}: ${error.message}`] };
  }
  if (!settingsFile) return { ok: false, status: 'invalid-request', changes: [], errors: ['settingsFile is required'] };
  const schema = validateHooksConfig(desired);
  const commands = verifyHookCommands(desired || {}, { scriptsDir: sourceHooksDir, trusted, fsImpl });
  const errors = [...schema.errors, ...commands.checks.filter((check: any) => !check.ok).map((check: any) => `${check.event}: ${check.reason}${check.script ? ` (${check.script})` : ''}`)];

  let existing: any = {};
  if (fsImpl.existsSync(settingsFile)) {
    try { existing = JSON.parse(fsImpl.readFileSync(settingsFile, 'utf8')); }
    catch (error: any) { return { ok: false, status: 'malformed', changes: [], errors: [`Refusing to touch malformed ${settingsFile}: ${error.message}`] }; }
  }
  if (errors.length) return { ok: false, status: 'invalid-request', settingsFile, existing, changes: [], errors, commands };

  const mergedHooks = existing.hooks ? mergeHooks(existing.hooks, desired.hooks) : desired.hooks;
  const merged = { ...existing, hooks: mergedHooks };
  const configChanged = JSON.stringify(existing.hooks) !== JSON.stringify(mergedHooks);
  // Preferred: the declared hooks directory (harnesses.json "paths".hooksDirectory); the derived
  // sibling-of-settings fallback stays for direct callers passing raw inputs, and resolves to the
  // same location.
  const destinationHooksDir = declaredHooksDir || path.join(path.dirname(settingsFile), 'hooks');
  // The scripts are deployed with the hooks key but are not part of it: a script whose bytes differ
  // from the source is redeployed even when the key is already right.
  const scripts = planHookScripts({ commands, sourceHooksDir, destinationHooksDir, rows: scriptRows, force, fsImpl });
  if (scripts.edited.length) {
    return { ok: false, status: 'conflict', settingsFile, existing, changes: [], commands,
      errors: scripts.edited.map((name: string) => `Gemini hook script '${name}' was modified outside DoFlow`) };
  }
  const scriptsOnly = !configChanged && scripts.stale.length > 0;
  const changed = configChanged || scriptsOnly;
  // The scripts deployGeminiHooks copies beside settings.json, so a backup of this change holds them too.
  const companionTargets = [...new Set([
    ...commands.checks.map((check: any) => path.join(destinationHooksDir, check.script)),
    ...shippedScripts(sourceHooksDir, fsImpl).map((name: string) => path.join(destinationHooksDir, name)),
  ])].sort();
  return { ok: true, status: changed ? 'change' : 'unchanged', settingsFile, existing, merged, scriptsOnly, scriptNames: scripts.names,
    changes: changed ? [{ type: fsImpl.existsSync(settingsFile) ? 'update' : 'create', file: settingsFile, key: 'hooks' }] : [],
    errors: [], commands, trust: commands.trust, scriptsDir: sourceHooksDir, destinationHooksDir, companionTargets };
}

function deployGeminiHooks(plan: any, { dryRun = false, fsImpl = fs }: { dryRun?: boolean, fsImpl?: any } = {}): any {
  if (!plan.ok) return { ...plan, applied: false };
  if (dryRun || plan.status === 'unchanged') return { ...plan, applied: false };
  if (!plan.scriptsOnly) {
    fsImpl.mkdirSync(path.dirname(plan.settingsFile), { recursive: true });
    const content = `${JSON.stringify(plan.merged, null, 2)}\n`;
    const temporary = path.join(path.dirname(plan.settingsFile), `.${path.basename(plan.settingsFile)}.${process.pid}.${Date.now()}.tmp`);
    try {
      fsImpl.writeFileSync(temporary, content, { flag: 'wx' });
      fsImpl.renameSync(temporary, plan.settingsFile);
    } finally {
      if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary);
    }
  }
  const deployed = new Set<string>();
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
function planRemoveGeminiHooks({ settingsFile, fsImpl = fs }: { settingsFile?: string, fsImpl?: any } = {}): any {
  if (!settingsFile) return { ok: false, status: 'invalid-request', changes: [], errors: ['settingsFile is required'] };
  if (!fsImpl.existsSync(settingsFile)) return { ok: true, status: 'unchanged', settingsFile, changes: [] };
  let existing;
  try { existing = JSON.parse(fsImpl.readFileSync(settingsFile, 'utf8')); }
  catch (error: any) { return { ok: false, status: 'malformed', changes: [], errors: [`Could not parse ${settingsFile}: ${error.message}`] }; }
  if (existing.hooks === undefined) return { ok: true, status: 'unchanged', settingsFile, changes: [] };
  const { hooks: _dropped, ...merged } = existing;
  return { ok: true, status: 'change', settingsFile, merged, changes: [{ type: 'update', file: settingsFile, key: 'hooks', operation: 'remove' }] };
}

function deployRemoveGeminiHooks(plan: any, { dryRun = false, fsImpl = fs }: { dryRun?: boolean, fsImpl?: any } = {}): any {
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

module.exports = { SUPPORTED_EVENTS, validateHooksConfig, classifyClaudeGuardrails, verifyHookCommands, planGeminiHooks, deployGeminiHooks, scriptFingerprint, shippedScripts, planRemoveGeminiHooks, deployRemoveGeminiHooks };
