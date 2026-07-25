#!/usr/bin/env bash
# Codex adapter: post-edit-lint.impl.sh writes no stdout (session-file collector only),
# so there is no output-format compatibility question here, unlike pre-compact.sh.
set -euo pipefail
export DOFLOW_AGENT=codex
exec bash "$(dirname "$0")/post-edit-lint.impl.sh"
