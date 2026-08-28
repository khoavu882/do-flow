#!/usr/bin/env bash
# build-install-mirror.sh — builds a scratch, install-shaped mirror of core/harnesses/ under
# tmp/, so tests can execute front-door hook scripts exactly as they run post-install.
#
# Why this exists (022-hooks-shared-install-gap): front doors resolve the Canonical Policy
# Library via a literal relative path ("../../.doflow/shared/hooks/...") that is correct from an
# installed script's location (.claude/hooks/foo.sh, 2 levels below the project root) but wrong
# from its source location (core/harnesses/claude/hooks/foo.sh, 2 levels below core/harnesses/,
# not the repo root). A prior fix that instead symlinked core/harnesses/.doflow/shared into place
# silently broke npm test for every other clone: .gitignore's bare `.doflow` pattern ignores any
# directory of that name anywhere in the tree, so the symlink worked locally but was never
# committed. This mirror is regenerated fresh under the already-gitignored tmp/ instead, exactly
# like tmp/test-home/ already is for hook state — nothing here is meant to be committed.
#
# Usage: bash test/hooks/build-install-mirror.sh <mirror-dir>
# Populates <mirror-dir>/.{claude,codex,gemini,kiro,antigravity}/hooks/ and
# <mirror-dir>/.doflow/shared/hooks/, mirroring each harness's real install destination depth.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIRROR="${1:?usage: build-install-mirror.sh <mirror-dir>}"

rm -rf "$MIRROR"
mkdir -p "$MIRROR"

for harness in claude codex gemini kiro antigravity; do
  src="$REPO_ROOT/core/harnesses/$harness/hooks"
  [ -d "$src" ] || continue
  dest="$MIRROR/.$harness/hooks"
  mkdir -p "$dest"
  cp -R "$src/." "$dest/"
done

mkdir -p "$MIRROR/.doflow/shared"
cp -R "$REPO_ROOT/core/harnesses/shared/hooks" "$MIRROR/.doflow/shared/hooks"

find "$MIRROR" -name '*.sh' -exec chmod +x {} +
