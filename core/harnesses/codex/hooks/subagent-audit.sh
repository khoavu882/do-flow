#!/usr/bin/env bash
# Codex front door: subagent-audit through the shared lifecycle bridge.
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-codex}"
. "$(dirname "$0")/../../.doflow/shared/hooks/bridge/bridge.sh"
payload=$(cat)
event=$(printf '%s' "$payload" | jq -r '.hook_event_name // "SubagentStart"' 2>/dev/null || printf 'SubagentStart')
has_jq=1
command -v jq >/dev/null 2>&1 || has_jq=0
rc=0
doflow_bridge codex "$event" subagent-audit <<<"$payload" || rc=$?
if [ "$has_jq" -eq 0 ]; then
  printf '{}\n'
  exit 0
fi
if [ "$rc" -eq 0 ]; then
  case "$DF_BRIDGE_OUTCOME" in allow|advisory) printf '{}\n' ;; esac
fi
exit "$rc"
