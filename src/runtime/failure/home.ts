'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Where DoFlow's own failures are kept on this machine, and whether capture is on (IC-011, IC-014).
 * One folder per machine, shared by every project (DEC-007), `failures` beside `settings.json` in the
 * config home (`../config-home.ts`, shared with the bash writers so a failure captured by either lands
 * in the one list). No config home means no failure home, and capture is skipped.
 *
 * The switch (IC-005), in order: no home skips; the environment can only turn capture off; the sentinel
 * `<home>/off` file turns it off; a `failure.capture` value in `<config home>/settings.json` other than
 * "on" turns it off (the lexical rule, `../settings/lexical.ts`). Otherwise it is on.
 */

const path = require('node:path');
const { configHome } = require('../config-home.ts');
const { loadSettings } = require('../settings/resolve.ts');

const OFF_VALUES = new Set(['off', '0', 'false', 'no']);

/** @param {Object} [env] defaults to process.env
 * @returns {string|null} the failure home, an absolute path, or null when none can be resolved */
function failureHome(env: any = process.env): string | null {
  const { dir } = configHome(env);
  return dir === null ? null : path.join(dir, 'failures');
}

const sentinelPath = (home: string): string => path.join(home, 'off');
const eventsPath = (home: string): string => path.join(home, 'events.jsonl');
/** `settings.json` sits in the config home, one level above the failure home. */
const settingsPath = (home: string): string => path.join(path.dirname(home), 'settings.json');

/** Resolves the machine-wide setting and returns the file and sentinel parts of the old result shape. */
function resolvedCapture(home: string, env: any): { effective: 'on' | 'off'; sentinel: boolean; settings: 'on' | 'off' | null } {
  const resolverEnv = { ...env, XDG_CONFIG_HOME: path.dirname(path.dirname(home)) };
  const view = loadSettings({ global: true, env: resolverEnv });
  const result = view.get('failure.capture', 'global');
  const sentinel = result.candidates.some((candidate: any) =>
    candidate.legacy && candidate.source === sentinelPath(home) && candidate.value === 'off');
  const file = result.candidates.find((candidate: any) =>
    !candidate.legacy && candidate.layer === 'user' && candidate.source === settingsPath(home));
  const settings = file?.value === 'on' || file?.value === 'off' ? file.value : null;
  return { effective: result.value === 'off' ? 'off' : 'on', sentinel, settings };
}

/** The value of `DOFLOW_FAILURE_CAPTURE` when it is set to anything, else null. */
function envSetting(env: any = process.env): string | null {
  const raw = env.DOFLOW_FAILURE_CAPTURE;
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/**
 * The capture switch (IC-014, IC-005). The resolver applies the global sentinel, lexical settings
 * file value and environment layers; any off value wins. The resolver reads without creating a folder.
 * @param {string|null} home
 * @param {Object} [env]
 * @returns {{effective: 'on'|'off', sentinel: boolean, env: string|null, settings: 'on'|'off'|null}}
 *   `settings` is the lexical read of settings.json: null when the file holds no `failure.capture`
 */
function captureSwitch(home: string | null, env: any = process.env): { effective: 'on' | 'off'; sentinel: boolean; env: string | null; settings: 'on' | 'off' | null } {
  const setting = envSetting(env);
  if (!home) {
    const envOff = setting !== null && OFF_VALUES.has(setting.trim().toLowerCase());
    return { effective: envOff ? 'off' : 'on', sentinel: false, env: setting, settings: null };
  }
  try {
    const resolved = resolvedCapture(home, env);
    return { ...resolved, env: setting };
  } catch {
    return { effective: 'off', sentinel: false, env: setting, settings: null };
  }
}

/** The hot-path check a writer makes; the shared resolver owns sentinel and settings-file reads. */
function captureIsOff(home: string, env: any = process.env): boolean {
  try { return resolvedCapture(home, env).effective === 'off'; } catch { return true; }
}

module.exports = { failureHome, captureSwitch, captureIsOff, sentinelPath, eventsPath, envSetting };
