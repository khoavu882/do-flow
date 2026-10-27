'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The per-machine config home (086 IC-003, DD-7): the one place Node code asks where `<home>/doflow`
 * lives. `XDG_CONFIG_HOME` when it is set, non-empty and absolute, else `$HOME/.config` when `HOME` is
 * set, non-empty and absolute, else no config home. A relative or empty value is ignored, never read
 * against the working directory. It reads the `HOME` variable and never `os.homedir()`, so Node and
 * the shell blocks (`doflow_config_home` in `doflow-run`, `policies/lib.sh`, ...) agree on every
 * environment, and an unset HOME is "no home" rather than the account's home.
 */

const path = require('node:path');

type Env = Record<string, string | undefined>;

interface ConfigHome {
  /** The XDG-style base (`<base>/doflow` is DoFlow's folder), or null when none resolves. */
  base: string | null;
  /** `<base>/doflow`, or null when none resolves. */
  dir: string | null;
  /** Each variable that was set non-empty but relative, so a caller can say why it was not used. */
  ignored: Array<'XDG_CONFIG_HOME' | 'HOME'>;
}

function configHome(env: Env = process.env): ConfigHome {
  const ignored: ConfigHome['ignored'] = [];
  const usable = (name: 'XDG_CONFIG_HOME' | 'HOME'): string | null => {
    const value = env[name];
    if (typeof value !== 'string' || value === '') return null;
    if (path.isAbsolute(value)) return value;
    ignored.push(name);
    return null;
  };
  const xdg = usable('XDG_CONFIG_HOME');
  const home = usable('HOME');
  const base = xdg !== null ? xdg : home !== null ? path.join(home, '.config') : null;
  return { base, dir: base === null ? null : path.join(base, 'doflow'), ignored };
}

module.exports = { configHome };
