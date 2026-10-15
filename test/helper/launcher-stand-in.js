'use strict';

// launcher-stand-in.js — feature 078, IC-006 (DEC-001). Test-only, never shipped.
//
// A stand-in for the launcher 081 will ship: `launch()` names a launched session in the
// environment and takes its launch emission in process, the way a launcher does before it starts
// the harness; `firstPrompt()` then runs that harness's SessionStart and UserPromptSubmit front
// doors from an install mirror (test/helper/hook-fixtures buildInstallMirror) with the same
// environment. 081 re-runs every scenario that uses this stand-in with its real launcher.

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { emitContext } = require('../../src/runtime/context-pack.ts');
const { grantSummary } = require('../../src/runtime/context/summary-store.ts');

/**
 * The launched session's environment: `env` plus the five IC-007 launcher variables. A value left
 * undefined is removed, so nothing from `env` stands in for it.
 */
function launchEnv({ env = {}, run, lineage, attempt = '1', role = 'worker', worktree } = {}) {
  const next = { ...env };
  const set = { DOFLOW_RUN_ID: run, DOFLOW_ATTEMPT: attempt, DOFLOW_LINEAGE_ID: lineage, DOFLOW_SESSION_ROLE: role, DOFLOW_WORKTREE: worktree };
  for (const [key, value] of Object.entries(set)) {
    if (value === undefined || value === null) delete next[key];
    else next[key] = String(value);
  }
  return next;
}

/**
 * IC-006 launch: grants first when `grant` is given (grantSummary() with the caller's own `env`, the
 * launcher granting from its scope to the child's run and lineage), then emitContext({event:
 * 'launch'}) in process with the launched environment.
 * @returns {{ launched: object, grant: object | null, env: object }} `env` is the launched
 *   environment, for the firstPrompt() that follows.
 */
function launch({ mirror, env = {}, cwd, run, lineage, attempt = '1', role = 'worker', worktree, taskId, grant } = {}) {
  void mirror; // the launch emission runs in process; the mirror is the front doors' (firstPrompt)
  const launchedEnv = launchEnv({ env, run, lineage, attempt, role, worktree });
  let granted = null;
  if (grant) granted = grantSummary({ toRun: run, toLineage: lineage, env, ...grant });
  const launched = emitContext({ event: 'launch', cwd, env: launchedEnv, ...(taskId ? { taskId } : {}) });
  return { launched, grant: granted, env: launchedEnv };
}

/** One front door from the mirror; a non-zero exit is an error, since hooks always exit 0. */
function frontDoor(mirror, harness, script, payload, cwd, env) {
  const r = spawnSync('bash', [path.join(mirror, `.${harness}`, 'hooks', script)], {
    cwd, input: `${JSON.stringify(payload)}\n`, env, encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`${harness}/${script} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

/**
 * IC-006 firstPrompt: session-start.sh, then user-prompt-submit.sh, from the mirror with the same
 * env. `prompt` is the prompt text (default `continue`); `start: false` skips SessionStart, for a
 * later prompt of the same session.
 * @returns {{ stdout: string, additionalContext: string }} additionalContext is '' when silent.
 */
function firstPrompt({ mirror, harness = 'claude', sessionId, cwd, env = {}, prompt = 'continue', start = true } = {}) {
  if (start) frontDoor(mirror, harness, 'session-start.sh', { session_id: sessionId, cwd, hook_event_name: 'SessionStart', source: 'startup' }, cwd, env);
  const stdout = frontDoor(mirror, harness, 'user-prompt-submit.sh', { session_id: sessionId, cwd, hook_event_name: 'UserPromptSubmit', prompt }, cwd, env);
  const out = stdout.trim() === '' ? {} : JSON.parse(stdout);
  return { stdout, additionalContext: out.additionalContext ?? out.hookSpecificOutput?.additionalContext ?? '' };
}

module.exports = { firstPrompt, launch, launchEnv };
