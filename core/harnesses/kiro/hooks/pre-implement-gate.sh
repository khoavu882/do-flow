#!/usr/bin/env bash
# Kiro front door: pre-implementation-gate through the shared lifecycle bridge.
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-kiro}"
here="$(dirname "$0")"
# shellcheck source=lib.sh
source "$here/lib.sh"
raw=$(cat)
payload=$(kiro_bridge_payload <<<"$raw")
event="PreToolUse"
if command -v jq >/dev/null 2>&1; then event=$(printf '%s' "$raw" | jq -r '.hook_event_name // "PreToolUse"' 2>/dev/null) || event="PreToolUse"; fi
. "$here/../../.doflow/shared/hooks/bridge/bridge.sh"
if doflow_bridge kiro "$event" pre-implementation-gate <<<"$payload"; then
  status=0
else
  status=$?
fi
if [ "$status" -eq 2 ]; then printf '\n' >&2; fi
exit "$status"
