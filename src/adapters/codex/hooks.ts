'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// Codex hook planning intentionally keeps deployment separate from CLI wiring.  Command hooks
// execute code, so a plan fails closed for malformed definitions, missing wrappers, or wrappers
// that are not executable.  Trust is reported as a prerequisite rather than being bypassed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyHookCommands } = require('../hook-commands.ts');
const { mergeHooks } = require('../../helper/settings-merge.ts');
const { atomicWrite } = require('./config.ts');

const SUPPORTED_EVENTS = new Set([
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
  'UserPromptSubmit', 'SubagentStop', 'Stop', 'SessionStart', 'SubagentStart', 'SessionEnd',
]);

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
      validationError(errors, `Unsupported Codex hook event '${event}'`);
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
function classifyClaudeGuardrails(claudeHooks: any = {}): { supported: any[], unsupported: any[] } {
  const supported: any[] = [];
  const unsupported: any[] = [];
  for (const [event, groups] of Object.entries(claudeHooks || {})) {
    const item = { sourceEvent: event, targetEvent: event, groups: Array.isArray(groups) ? groups.length : 0 };
    if (SUPPORTED_EVENTS.has(event)) supported.push(item);
    else unsupported.push({ ...item, targetEvent: null, reason: `Codex does not support the Claude '${event}' lifecycle event` });
  }
  return { supported, unsupported };
}

function destinationFor(context: any = {}): string {
  // Preferred: the declared path resolved by the adapter (harnesses.json "paths".hooksFile).
  if (context.paths?.hooksFile) return context.paths.hooksFile;
  // Legacy derivation for direct callers passing raw scope inputs; kept byte-compatible with the
  // declaration the lifecycle path always supplies.
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

/** DoFlow's record of a deployed hook script, in the ledger's fingerprint form: sha256 of its bytes. */
function scriptFingerprint(bytes: any): string { return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`; }

/** The scripts beside the config that differ from the shipped source (or are absent), by name, and
 * those among them a ledger row says were edited since DoFlow wrote them. A script with no row
 * (an install from before scripts were recorded) is DoFlow's to refresh: the config deploy always
 * overwrote it. `rows` are this harness's script rows: { target, fingerprint }. */
function planHookScripts({ commands, sourceHooksDir, destinationHooksDir, rows = [], force = false, fsImpl = fs }: any) {
  const sources = new Map<string, string>(commands.checks.map((check: any) => [check.script, check.file] as [string, string]));
  for (const name of shippedHookScripts(sourceHooksDir, fsImpl)) if (!sources.has(name)) sources.set(name, path.join(sourceHooksDir, name));
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

function planCodexHooks({ config, sourceFile, sourceHooksDir, destinationContext = {}, trusted = false, scriptRows = [], force = false, fsImpl = fs }: any = {}): any {
  let desired = config;
  try {
    if (!desired && sourceFile) desired = JSON.parse(fsImpl.readFileSync(sourceFile, 'utf8'));
  } catch (error: any) {
    return { ok: false, status: 'malformed', changes: [], errors: [`Could not parse ${sourceFile}: ${error.message}`] };
  }
  const schema = validateHooksConfig(desired);
  let destination;
  try { destination = destinationFor(destinationContext); } catch (error: any) {
    return { ok: false, status: 'invalid-request', changes: [], errors: [...schema.errors, error.message] };
  }
  const commands = verifyHookCommands(desired || {}, { scriptsDir: sourceHooksDir, trusted, fsImpl });
  const errors = [...schema.errors, ...commands.checks.filter((check: any) => !check.ok).map((check: any) => `${check.event}: ${check.reason}${check.script ? ` (${check.script})` : ''}`)];
  let mergedDesired = desired;
  const original = fsImpl.existsSync(destination) ? fsImpl.readFileSync(destination, 'utf8') : '';
  if (original.trim()) {
    try {
      const existing = JSON.parse(original);
      if (existing?.hooks && desired?.hooks) {
        mergedDesired = { ...existing, ...desired, hooks: mergeHooks(existing.hooks, desired.hooks) };
      }
    } catch {
      // malformed existing will be flagged or left for schema validation
    }
  }
  const content = schema.ok && mergedDesired ? `${JSON.stringify(mergedDesired, null, 2)}\n` : null;
  if (errors.length) return { ok: false, status: 'invalid-request', destination, original, changes: [], errors, commands };
  const configChanged = original !== content;
  const destinationHooksDir = destinationContext.paths?.hooksDirectory
    || destinationContext.hooksDir
    || path.join(path.dirname(destination), 'hooks');
  // The scripts are deployed with the config but are not part of it: a script whose bytes differ
  // from the source is redeployed even when the config is already right.
  const scripts = planHookScripts({ commands, sourceHooksDir, destinationHooksDir, rows: scriptRows, force, fsImpl });
  if (scripts.edited.length) {
    return { ok: false, status: 'conflict', destination, original, changes: [], commands,
      errors: scripts.edited.map((name: string) => `Codex hook script '${name}' was modified outside DoFlow`) };
  }
  const scriptsOnly = !configChanged && scripts.stale.length > 0;
  const changed = configChanged || scriptsOnly;
  // The scripts deployCodexHooks copies beside hooks.json, so a backup of this change holds them too.
  const companionTargets = [...new Set([
    ...commands.checks.map((check: any) => path.join(destinationHooksDir, check.script)),
    ...shippedHookScripts(sourceHooksDir, fsImpl).map((name: string) => path.join(destinationHooksDir, name)),
  ])].sort();
  return { ok: true, status: changed ? 'change' : 'unchanged', destination, original, content, scriptsOnly, scriptNames: scripts.names,
    changes: changed ? [{ type: fsImpl.existsSync(destination) ? 'update' : 'create', file: destination, companionTargets }] : [],
    errors: [], commands, trust: commands.trust, scriptsDir: sourceHooksDir, destinationHooksDir };
}

function deployCodexHooks(plan: any, { dryRun = false, fsImpl = fs }: { dryRun?: boolean, fsImpl?: any } = {}): any {
  if (!plan.ok) return { ...plan, applied: false };
  if (dryRun || plan.status === 'unchanged') return { ...plan, applied: false };
  if (!plan.scriptsOnly) atomicWrite(plan.destination, plan.content, fsImpl);
  const deployed = new Set<string>();
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
  for (const name of shippedHookScripts(plan.scriptsDir, fsImpl)) {
    if (deployed.has(name)) continue;
    const source = path.join(plan.scriptsDir, name);
    const target = path.join(plan.destinationHooksDir, name);
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.copyFileSync(source, target);
    fsImpl.chmodSync(target, fsImpl.statSync(source).mode & 0o777);
  }
  return { ...plan, applied: true };
}

/** Every file deployCodexHooks copies beside hooks.json: each regular, non-JSON file in the
 * shipped scripts directory (the command-named scripts are among them). */
function shippedHookScripts(scriptsDir: any, fsImpl: any = fs): string[] {
  if (!scriptsDir || !fsImpl.existsSync(scriptsDir)) return [];
  return fsImpl.readdirSync(scriptsDir)
    .filter((name: string) => !name.endsWith('.json') && fsImpl.statSync(path.join(scriptsDir, name)).isFile());
}

/** Undo deployCodexHooks' script copies. The ledger records only hooks.json, so ownership of a
 * script is proven by its bytes: one still identical to the shipped source is deleted, one the
 * user edited or added stays. The directory goes only once it is empty. */
function removeCodexHookScripts({ scriptsDir, destinationHooksDir }: { scriptsDir?: string, destinationHooksDir?: string } = {}, { dryRun = false, fsImpl = fs }: { dryRun?: boolean, fsImpl?: any } = {}): { removed: number } {
  if (!destinationHooksDir || !fsImpl.existsSync(destinationHooksDir)) return { removed: 0 };
  let removed = 0;
  for (const name of shippedHookScripts(scriptsDir, fsImpl)) {
    const target = path.join(destinationHooksDir, name);
    // lstat, not stat: a symlink (even to a file with the shipped bytes) is not DoFlow's copy.
    let stat;
    try { stat = fsImpl.lstatSync(target); } catch { continue; }
    if (!stat.isFile()) continue;
    if (!fsImpl.readFileSync(target).equals(fsImpl.readFileSync(path.join(scriptsDir, name)))) continue;
    if (!dryRun) fsImpl.unlinkSync(target);
    removed += 1;
  }
  if (!dryRun) { try { fsImpl.rmdirSync(destinationHooksDir); } catch { /* still holds user files */ } }
  return { removed };
}

module.exports = { SUPPORTED_EVENTS, validateHooksConfig, classifyClaudeGuardrails, verifyHookCommands, planCodexHooks, deployCodexHooks, scriptFingerprint, shippedHookScripts, removeCodexHookScripts };
