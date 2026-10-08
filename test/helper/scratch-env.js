'use strict';

// A scratch directory and the environment to run a spawned DoFlow process in it (DEC-041). Every
// spawn in a lifecycle test sets HOME and XDG_CONFIG_HOME to a folder under the scratch directory,
// so no test reads or writes the developer's real ~/.config/doflow, and git sees no global config.
// DOFLOW_RETENTION_HOURS is dropped from what is inherited, so a developer's shell cannot make a
// test prune its fixtures, and PI_CODING_AGENT_DIR too, the one harness folder an adapter reads from
// the environment, so pi's writes stay under the scratch HOME; a test that wants either passes it
// in `extra`.
// Nothing runs at require time; each test file creates its scratch and removes it in an `after`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DROPPED_ENV = ['DOFLOW_RETENTION_HOURS', 'PI_CODING_AGENT_DIR'];

/** This process's environment without DROPPED_ENV, for a spawn that builds its own environment. */
function inheritedEnv() {
  const inherited = { ...process.env };
  for (const key of DROPPED_ENV) delete inherited[key];
  return inherited;
}

/**
 * @param {string} [prefix]
 * @returns {{dir: string, home: string, xdg: string, env: (extra?: Object) => Object, apply: () => void, restore: () => void, remove: () => void}}
 *   `dir` is a real path (macOS reaches the temp folder through a symlink, and git reports the real one).
 */
function createScratch(prefix = 'doflow-lifecycle-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  fs.mkdirSync(home);
  fs.mkdirSync(xdg);
  const saved = {};
  return {
    dir,
    home,
    xdg,
    env(extra = {}) {
      return {
        ...inheritedEnv(),
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        GIT_CONFIG_GLOBAL: path.join(dir, 'no-gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        ...extra,
      };
    },
    /** Puts the scratch environment into this process, for tests that call services in-process: a
     * service that spawns git or bash inherits it, so it never reads the developer's HOME, XDG
     * folder or global git config (DEC-041). `node --test` runs each file in its own process. */
    apply() {
      const next = this.env();
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
    remove() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

module.exports = { createScratch, inheritedEnv };
