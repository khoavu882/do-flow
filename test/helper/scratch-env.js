'use strict';

// A scratch directory and the environment to run a spawned DoFlow process in it (DEC-041). Every
// spawn in a lifecycle test sets HOME and XDG_CONFIG_HOME to a folder under the scratch directory,
// so no test reads or writes the developer's real ~/.config/doflow, and git sees no global config.
// Nothing runs at require time; each test file creates its scratch and removes it in an `after`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * @param {string} [prefix]
 * @returns {{dir: string, home: string, xdg: string, env: (extra?: Object) => Object, remove: () => void}}
 *   `dir` is a real path (macOS reaches the temp folder through a symlink, and git reports the real one).
 */
function createScratch(prefix = 'doflow-lifecycle-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  fs.mkdirSync(home);
  fs.mkdirSync(xdg);
  return {
    dir,
    home,
    xdg,
    env(extra = {}) {
      return {
        ...process.env,
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
    remove() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

module.exports = { createScratch };
