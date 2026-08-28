#!/usr/bin/env bash
# Antigravity front door: delegates the stop-check decision to the Canonical
# Policy Library via the Cross-Harness Hook Runner (design.md C2), which owns
# Antigravity's native JSON stdin/stdout translation (adapters/antigravity.js,
# including its fail-open "silence lets the session end" Stop contract) — this
# file no longer implements the check or the translation itself, both of which
# moved to the shared runtime.
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-antigravity}"
exec node "$(dirname "$0")/../../shared/hooks/stream-hook-runner.js" Stop
