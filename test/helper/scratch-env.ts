'use strict';

// A scratch directory and the environment to run a spawned DoFlow process in it (DEC-041). Every
// spawn in a lifecycle test sets HOME and XDG_CONFIG_HOME to a folder under the scratch directory,
// so no test reads or writes the developer's real ~/.config/doflow, and git sees no global config.
// DOFLOW_RETENTION_HOURS is dropped from what is inherited, so a developer's shell cannot make a
// test prune its fixtures, and PI_CODING_AGENT_DIR too, the one harness folder an adapter reads from
// the environment, so pi's writes stay under the scratch HOME; a test that wants either passes it
// in `extra`.
// The shared temp helper registers each scratch for suite and process-exit cleanup; callers may still
// remove it early when a test needs to assert its absence.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { suiteTempDir, removeTree, GIT_NO_MAINTENANCE_ENV } = require('./tmp.ts');

const DROPPED_ENV = ['DOFLOW_RETENTION_HOURS', 'PI_CODING_AGENT_DIR'];

/** Every harness id the registry declares: the `hooks.harnesses` a test passes when it exercises the
 * hooks of harnesses outside the shipped default (maint-hooks). */
const ALL_HARNESS_IDS = Object.freeze(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'registry', 'harnesses.json'), 'utf8'))
  .harnesses.map((harness: any) => harness.id));

/** This process's environment without DROPPED_ENV, for a spawn that builds its own environment. */
function inheritedEnv() {
  const inherited = { ...process.env };
  for (const key of DROPPED_ENV) delete inherited[key];
  return inherited;
}

/**
 * @param {string} [prefix]
 * @param {{prune?: 'on'|'off', hookHarnesses?: string[]}} [options] `hookHarnesses` writes the user layer's
 *   `hooks.harnesses`; left out, the shipped default applies.
 * @returns {{dir: string, home: string, xdg: string, env: (extra?: Object) => Object, apply: () => void, restore: () => void, remove: () => void}}
 *   `dir` is a real path (macOS reaches the temp folder through a symlink, and git reports the real one).
 */
function createScratch(prefix = 'doflow-lifecycle-', { prune = 'off', hookHarnesses }: { prune?: string; hookHarnesses?: readonly string[] } = {}) {
  const dir = suiteTempDir(prefix);
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  fs.mkdirSync(home);
  fs.mkdirSync(xdg);
  fs.mkdirSync(path.join(xdg, 'doflow'));
  fs.writeFileSync(path.join(xdg, 'doflow', 'prune'), prune === 'on' ? 'on\n' : 'off\n');
  if (hookHarnesses) fs.writeFileSync(path.join(xdg, 'doflow', 'settings.json'), `${JSON.stringify({ schema: 1, 'hooks.harnesses': hookHarnesses })}\n`);
  const saved: any = {};
  return {
    dir,
    home,
    xdg,
    env(extra = {}) {
      // os.homedir() reads USERPROFILE, not HOME, on Windows: a scratch HOME alone leaves the spawned
      // node process on the runner's real home. USERPROFILE follows the HOME the spawn ends up with;
      // POSIX environments are unchanged.
      const env: any = {
        ...inheritedEnv(),
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        GIT_CONFIG_GLOBAL: path.join(dir, 'no-gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        // Hook lines (088) go to the .doflow found above the cwd, which for a spawn without a cwd is
        // the checkout's own store; tests write them only when they opt in.
        DOFLOW_TELEMETRY: 'off',
        ...extra,
      };
      if (process.platform === 'win32' && !('USERPROFILE' in extra)) {
        if (env.HOME === undefined) delete env.USERPROFILE; else env.USERPROFILE = env.HOME;
      }
      return env;
    },
    /** Puts the scratch environment into this process, for tests that call services in-process: a
     * service that spawns git or bash inherits it, so it never reads the developer's HOME, XDG
     * folder or global git config (DEC-041). `node --test` runs each file in its own process. */
    apply() {
      const next: any = this.env();
      for (const key of DROPPED_ENV) {
        if (!(key in saved)) saved[key] = process.env[key];
        delete process.env[key];
      }
      for (const key of Object.keys(next)) {
        if (!(key in saved)) saved[key] = process.env[key];
        process.env[key] = next[key];
      }
    },
    /** Undoes `apply`. */
    restore() {
      for (const key of Object.keys(saved)) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
        delete saved[key];
      }
    },
    remove() { removeTree(dir); },
  };
}

/** Fails the test when HOME or XDG_CONFIG_HOME in a spawn's `env` still names the developer's home or
 * ~/.config (086 B.2b: no hook a test starts may append to the developer's ~/.config/doflow). */
function assertScratchHome(env: any) {
  const real = os.homedir();
  const realConfig = path.join(real, '.config');
  for (const key of ['HOME', 'XDG_CONFIG_HOME']) {
    const value = env[key];
    if (typeof value !== 'string' || !path.isAbsolute(value)) continue;
    const resolved = path.resolve(value);
    assert.ok(resolved !== real && resolved !== realConfig && !resolved.startsWith(realConfig + path.sep),
      `${key} must be a scratch folder, not the developer's (${resolved})`);
  }
  return env;
}

/** The scratch env for a spawn, `extra` keys set to null removed, checked by assertScratchHome. */
function childEnv(scratch: any, extra: any = {}) {
  const env = scratch.env(extra);
  for (const [key, value] of Object.entries(extra)) if (value === null) delete env[key];
  return assertScratchHome(env);
}

module.exports = { createScratch, inheritedEnv, ALL_HARNESS_IDS, assertScratchHome, childEnv };
