'use strict';

// One way to spawn bash for the tests that run it without a HOME (FU-85a127). On the macOS runner
// of the beta.6 Release, a HOME-less `bash` printed `Error: $HOME must be set to run brew.` before
// the script ran, which broke the "writes nothing to stderr" asserts. The real trigger is not
// proven (agent-docs/doflow/085a-release-pipeline/research/brew-stderr-diagnosis.md); this helper
// removes the two ways a HOME-less bash could reach brew that a test controls, and every assert
// stays as it was:
//   - bash starts with `--noprofile --norc` and the child environment has no BASH_ENV or ENV;
//   - with HOME absent, the Homebrew directories leave PATH, unless a tool the hooks use would then
//     disappear (jq, shasum, git, ...); then PATH stays whole, because a missing tool is a worse
//     failure than a brew line. Ceiling: Intel `/usr/local/bin` is not treated as a Homebrew prefix.
// `DOFLOW_TEST_BASH` swaps the bash binary, as in test/settings/capture-agreement.test.js.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { bashPath } = require('./bash-locator.ts');

const BASH = bashPath();
const HOMEBREW_DIR = /(^|\/)opt\/homebrew(\/|$)|(^|\/)usr\/local\/Homebrew(\/|$)|(^|\/)home\/linuxbrew(\/|$)/;
const HOOK_TOOLS = ['jq', 'shasum', 'git', 'sed', 'awk', 'grep', 'date', 'mktemp'];

function reachable(tool: any, dirs: any) {
  return dirs.some((dir: any) => {
    try { fs.accessSync(path.join(dir, tool), fs.constants.X_OK); return true; } catch { return false; }
  });
}

/** PATH without Homebrew directories, or the PATH itself when that would hide a hook tool. */
function pathWithoutHomebrew(value: any) {
  const dirs = String(value ?? '').split(path.delimiter).filter(Boolean);
  const kept = dirs.filter((dir) => !HOMEBREW_DIR.test(dir));
  if (kept.length === dirs.length) return value;
  const lost = HOOK_TOOLS.some((tool) => reachable(tool, dirs) && !reachable(tool, kept));
  return lost ? value : kept.join(path.delimiter);
}

/** The child environment: `env` as given, minus bash start-up hooks, and with a brew-free PATH when HOME is absent. */
function bashEnv(env: any) {
  const out = { ...env };
  delete out.BASH_ENV;
  delete out.ENV;
  if (out.HOME === undefined && out.PATH !== undefined) out.PATH = pathWithoutHomebrew(out.PATH);
  return out;
}

/** spawnSync of bash with `args` and options (`env` is required: nothing is inherited here; `bash` swaps the binary). */
function spawnBash(args: any, { bash = BASH, ...options }) {
  return spawnSync(bash, ['--noprofile', '--norc', ...args], { ...options, env: bashEnv(options.env) });
}

module.exports = { BASH, bashEnv, pathWithoutHomebrew, spawnBash };
