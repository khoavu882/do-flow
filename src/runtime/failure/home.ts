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

const fs = require('node:fs');
const path = require('node:path');
const { configHome } = require('../config-home.ts');
const { readLexicalCapture } = require('../settings/lexical.ts');

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

/** The value of `DOFLOW_FAILURE_CAPTURE` when it is set to anything, else null. */
function envSetting(env: any = process.env): string | null {
  const raw = env.DOFLOW_FAILURE_CAPTURE;
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/**
 * The capture switch (IC-014, IC-005). The sentinel file and a settings.json value other than "on"
 * turn capture off, and the environment can only turn capture off, never on over either. One `stat`
 * and one bounded read, no folder created.
 * @param {string|null} home
 * @param {Object} [env]
 * @returns {{effective: 'on'|'off', sentinel: boolean, env: string|null, settings: 'on'|'off'|null}}
 *   `settings` is the lexical read of settings.json: null when the file holds no `failure.capture`
 */
function captureSwitch(home: string | null, env: any = process.env): { effective: 'on' | 'off'; sentinel: boolean; env: string | null; settings: 'on' | 'off' | null } {
  let sentinel = false;
  let settings: 'on' | 'off' | null = null;
  if (home) {
    try { sentinel = fs.statSync(sentinelPath(home)).isFile(); } catch { sentinel = false; }
    settings = readLexicalCapture(settingsPath(home));
  }
  const setting = envSetting(env);
  const envOff = setting !== null && OFF_VALUES.has(setting.trim().toLowerCase());
  return { effective: sentinel || envOff || settings === 'off' ? 'off' : 'on', sentinel, env: setting, settings };
}

/** The hot-path check a writer makes: the environment first, then one `stat` of the sentinel, then settings.json. */
function captureIsOff(home: string, env: any = process.env): boolean {
  const setting = envSetting(env);
  if (setting !== null && OFF_VALUES.has(setting.trim().toLowerCase())) return true;
  try { if (fs.statSync(sentinelPath(home)).isFile()) return true; } catch { /* no sentinel */ }
  return readLexicalCapture(settingsPath(home)) === 'off';
}

module.exports = { failureHome, captureSwitch, captureIsOff, sentinelPath, eventsPath, envSetting };
