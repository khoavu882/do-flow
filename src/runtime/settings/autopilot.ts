'use strict';

/**
 * The roadmap autopilot kill switch (feature 108 IC-011, FR-016; decisions C9, C4, C20). It lives
 * with the settings it reads, so the orchestrator and the roadmap loop share one reader without the
 * orchestrator importing the loop.
 */

const fs = require('node:fs');
const path = require('node:path');

type SwitchLayer = 'env' | 'sentinel' | 'setting';

/** `<config home>/autopilot/off`, or null with no config home (which already reads as off). */
function sentinelFile(env: any): string | null {
  const { configHome } = require('../config-home.ts');
  const home = configHome(env).dir;
  return home ? path.join(home, 'autopilot', 'off') : null;
}

/**
 * Read fresh on every call (never memoised: a copied env defeats the resolver cache), so a switch
 * set between two boundaries stops the next one. Any layer saying off wins and is named, in the
 * order env (DOFLOW_AUTOPILOT_ENABLED), the `autopilot/off` sentinel, the settings file. The
 * sentinel is stat'ed here: any error but ENOENT (EACCES, ENOTDIR) reads as present, because the
 * resolver reads every stat error as absent. Absent, invalid or unreadable settings read as off.
 */
function readKillSwitch(env: any = process.env, fsImpl: any = fs): { enabled: boolean; switch: SwitchLayer | null } {
  const off = (layer: SwitchLayer) => ({ enabled: false, switch: layer });
  try {
    const { loadSettings } = require('./resolve.ts');
    const resolution = loadSettings({ global: true, env: { ...env } }).get('autopilot.enabled', 'global');
    if (resolution.candidates.some((c: any) => c.layer === 'env' && c.value === 'off')) return off('env');
    const file = sentinelFile(env);
    if (file) {
      try { fsImpl.statSync(file); return off('sentinel'); }
      catch (error: any) { if (error?.code !== 'ENOENT') return off('sentinel'); }
    }
    if (resolution.candidates.some((c: any) => c.legacy && c.value === 'off')) return off('sentinel');
    return resolution.value === 'on' ? { enabled: true, switch: null } : off('setting');
  } catch {
    return off('setting');
  }
}

/** Seed writes require an independently verified durable off, so uncertainty refuses the write. */
function readSeedSwitch(env: any = process.env, fsImpl: any = fs): { enabled: boolean; switch: SwitchLayer | null } {
  const refuse = () => ({ enabled: true, switch: null });
  const off = (layer: SwitchLayer) => ({ enabled: false, switch: layer });
  try {
    const { configHome } = require('../config-home.ts');
    const home = configHome(env).dir;
    if (!home) return refuse();

    const settingsEnv = { ...env };
    delete settingsEnv.DOFLOW_AUTOPILOT_ENABLED;
    const { loadSettings } = require('./resolve.ts');
    const settings = loadSettings({ global: true, env: settingsEnv, fsImpl });
    const resolution = settings.get('autopilot.enabled', 'global');
    if (resolution.state === 'invalid' || resolution.candidates.some((candidate: any) => candidate.status === 'invalid')) {
      return refuse();
    }
    if (settings.errors.some((entry: any) => entry.key === 'autopilot.enabled' || entry.key === null)) {
      return refuse();
    }

    const file = path.join(home, 'autopilot', 'off');
    try {
      fsImpl.statSync(file);
      return off('sentinel');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') return off('sentinel');
    }

    const legacyOff = resolution.candidates.some((candidate: any) => candidate.legacy && candidate.value === 'off');
    if (resolution.value === 'off' || legacyOff) return off('setting');
    return refuse();
  } catch {
    return refuse();
  }
}

/** Tripwire (narrowing only): writes the kill-switch sentinel; only a person removes it. */
function tripSentinel(env: any, line: string, fsImpl: any = fs): boolean {
  const file = sentinelFile(env);
  // No config home already reads as off (needsConfigHome), so there is nothing to narrow.
  if (!file) return false;
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  try { fsImpl.writeFileSync(file, `${line}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  return true;
}

module.exports = { readKillSwitch, readSeedSwitch, tripSentinel };
