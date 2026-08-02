'use strict';

// Preflight for FR-003: hook-bearing installs require an invocable bash interpreter
// (POSIX bash, Git Bash/MSYS2, or WSL's own bash all satisfy this — from Node's
// perspective they are indistinguishable, and design.md calls that out explicitly:
// "is a bash-capable shell invocable" is the same question regardless of harness).
const { execFileSync } = require('node:child_process');

/** Whether a bash interpreter is invocable from the current process. Actually invokes
 * `bash --version` rather than checking PATH/`command -v` presence — a same-named
 * unrelated binary could satisfy a mere PATH check, but only a real bash exits cleanly
 * on `--version`. ENOENT, a non-zero exit, or any other spawn error are all treated as
 * "not available"; the caller does not need to distinguish the reason. */
function hasBashCapableShell(execFileSyncImpl = execFileSync) {
  try {
    execFileSyncImpl('bash', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

module.exports = { hasBashCapableShell };
