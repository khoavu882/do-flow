#!/usr/bin/env bash
# Kiro front door: session-context through the shared lifecycle bridge.
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-kiro}"
here="$(dirname "$0")"
# shellcheck source=lib.sh
source "$here/lib.sh"
raw=$(cat)
payload=$(kiro_bridge_payload <<<"$raw")
event="SessionStart"
if command -v jq >/dev/null 2>&1; then event=$(printf '%s' "$raw" | jq -r '.hook_event_name // "SessionStart"' 2>/dev/null) || event="SessionStart"; fi
. "$here/../../.doflow/shared/hooks/bridge/bridge.sh"
doflow_bridge kiro "$event" session-context <<<"$payload"
