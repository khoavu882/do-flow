#!/usr/bin/env bash
# Kiro Stop front door: translate the native payload, then render the bridge verdict for its engine.
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-kiro}"
here="$(dirname "$0")"
# shellcheck source=lib.sh
source "$here/lib.sh"
raw=$(cat)
payload=$(kiro_bridge_payload <<<"$raw")
raw_sid=""
event="Stop"
if command -v jq >/dev/null 2>&1; then
  raw_sid=$(printf '%s' "$raw" | jq -r '.session_id // empty' 2>/dev/null) || raw_sid=""
  event=$(printf '%s' "$raw" | jq -r '.hook_event_name // "Stop"' 2>/dev/null) || event="Stop"
fi
if [ -n "$raw_sid" ]; then
  export DOFLOW_KIRO_ENGINE=v3
else
  export DOFLOW_KIRO_ENGINE=2x
fi
. "$here/../../.doflow/shared/hooks/bridge/bridge.sh"
exec 4>&1
if bridge_stderr=$(doflow_bridge kiro "$event" stop-check <<<"$payload" 2>&1 1>&4); then
  status=0
else
  status=$?
fi
exec 4>&-
if [ "$status" -eq 2 ] && [ "$DOFLOW_KIRO_ENGINE" = 2x ]; then
  printf '%s\n' "$bridge_stderr" >&2
fi
exit "$status"
