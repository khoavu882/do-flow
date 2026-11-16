'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('./repo-root.ts');

/**
 * Where a bash helper (`do-paths.sh`, `do-git-state.sh`) is: inside the package (a checkout or a
 * source install), else projected next to the runtime. An installed runtime lives at
 * `<install>/.doflow/runtime` and carries only bin/, src/ and core/registry/; the helpers are
 * projected at `<install>/.doflow/scripts/doflow/bash/`, a sibling of the runtime directory.
 * The package copy wins when both exist. Null when neither does, which callers report as a
 * missing install rather than as the question the helper would have answered.
 * @param name file name under `scripts/doflow/bash/`
 * @param repoRoot the runtime root; only a test moves it
 */
function resolveBashHelper(
  name: string,
  repoRoot: string = REPO_ROOT,
  existsImpl: (file: string) => boolean = fs.existsSync,
): string | null {
  const candidates = [
    path.join(repoRoot, 'core', 'shared', 'scripts', 'doflow', 'bash', name),
    path.resolve(repoRoot, '..', 'scripts', 'doflow', 'bash', name),
  ];
  return candidates.find((candidate: string) => existsImpl(candidate)) || null;
}

module.exports = { resolveBashHelper };
