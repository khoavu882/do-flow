#!/usr/bin/env bash
# Codex front door: stop-check through the shared lifecycle bridge.
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-codex}"
if ! . "$(dirname "$0")/../../.doflow/shared/hooks/bridge/bridge.sh" 2>/dev/null; then printf '{}\n'; exit 0; fi
rc=0
output="$(doflow_bridge codex Stop stop-check)" || rc=$?
if [ "$rc" -eq 0 ]; then printf '%s\n' "$output"; fi
exit "$rc"
