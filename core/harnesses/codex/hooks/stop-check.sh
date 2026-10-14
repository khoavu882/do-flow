#!/usr/bin/env bash
# Codex front door: stop-check through the shared lifecycle bridge.
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-codex}"
. "$(dirname "$0")/../../.doflow/shared/hooks/bridge/bridge.sh"
rc=0
output="$(doflow_bridge codex Stop stop-check)" || rc=$?
if [ "$rc" -eq 0 ]; then printf '%s\n' "$output"; fi
exit "$rc"
