'use strict';

/**
 * Where DoFlow's own failures are kept on this machine, and whether capture is on (IC-011, IC-014).
 * One folder per machine, shared by every project (DEC-007). Node and the bash writers resolve the
 * home the same way, so a failure captured by either lands in the one list: `XDG_CONFIG_HOME` when it
 * is set, non-empty and absolute, else `$HOME/.config` when `HOME` is set and absolute. Node reads the
 * `HOME` variable and not `os.homedir()`, so both sides agree. A relative or missing base means
 * there is no home, and capture is skipped.
 */

const fs = require('node:fs');
const path = require('node:path');

const OFF_VALUES = new Set(['off', '0', 'false', 'no']);

/** @param {Object} [env] defaults to process.env
 * @returns {string|null} the failure home, an absolute path, or null when none can be resolved */
function failureHome(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME;
  if (typeof xdg === 'string' && xdg !== '') {
    return path.isAbsolute(xdg) ? path.join(xdg, 'doflow', 'failures') : null;
  }
  const home = env.HOME;
  if (typeof home === 'string' && path.isAbsolute(home)) return path.join(home, '.config', 'doflow', 'failures');
  return null;
}

const sentinelPath = (home) => path.join(home, 'off');
const eventsPath = (home) => path.join(home, 'events.jsonl');

/** The value of `DOFLOW_FAILURE_CAPTURE` when it is set to anything, else null. */
function envSetting(env = process.env) {
  const raw = env.DOFLOW_FAILURE_CAPTURE;
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/**
 * The capture switch (IC-014). The sentinel file wins over everything and the environment can only
 * turn capture off, never on over a sentinel. One `stat`, no folder created.
 * @param {string|null} home
 * @param {Object} [env]
 * @returns {{effective: 'on'|'off', sentinel: boolean, env: string|null}}
 */
function captureSwitch(home, env = process.env) {
  let sentinel = false;
  if (home) {
    try { sentinel = fs.statSync(sentinelPath(home)).isFile(); } catch { sentinel = false; }
  }
  const setting = envSetting(env);
  const envOff = setting !== null && OFF_VALUES.has(setting.trim().toLowerCase());
  return { effective: sentinel || envOff ? 'off' : 'on', sentinel, env: setting };
}

/** The hot-path check a writer makes: the environment first, then one `stat` of the sentinel. */
function captureIsOff(home, env = process.env) {
  const setting = envSetting(env);
  if (setting !== null && OFF_VALUES.has(setting.trim().toLowerCase())) return true;
  try { return fs.statSync(sentinelPath(home)).isFile(); } catch { return false; }
}

module.exports = { failureHome, captureSwitch, captureIsOff, sentinelPath, eventsPath, envSetting };
