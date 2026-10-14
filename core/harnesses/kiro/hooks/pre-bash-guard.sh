#!/usr/bin/env bash
# Kiro front door: pre-bash-guard through the shared lifecycle bridge.
set -euo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-kiro}"
here="$(dirname "$0")"
# shellcheck source=lib.sh
source "$here/lib.sh"
raw=$(cat)
payload=$(kiro_bridge_payload <<<"$raw")
event="PreToolUse"
if command -v jq >/dev/null 2>&1; then event=$(printf '%s' "$raw" | jq -r '.hook_event_name // "PreToolUse"' 2>/dev/null) || event="PreToolUse"; fi
bridge="$here/../../.doflow/shared/hooks/bridge/bridge.sh"
if [ ! -f "$bridge" ]; then
  printf '%s\n' '[doflow] shared hooks lack the bridge; run: doflow update -t kiro' >&2
  exit 2
fi
. "$bridge" 2>/dev/null || { printf '%s\n' '[doflow] shared hooks lack the bridge; run: doflow update -t kiro' >&2; exit 2; }
if doflow_bridge kiro "$event" pre-bash-guard <<<"$payload"; then
  status=0
else
  status=$?
fi
if [ "$status" -eq 2 ]; then printf '\n' >&2; fi
exit "$status"
