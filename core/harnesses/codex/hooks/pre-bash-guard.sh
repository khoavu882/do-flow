#!/usr/bin/env bash
# Codex front door: pre-bash-guard through the shared lifecycle bridge.
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-codex}"
if ! . "$(dirname "$0")/../../.doflow/shared/hooks/bridge/bridge.sh" 2>/dev/null; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[doflow] shared hooks lack the bridge; run: doflow update -t codex"}}'
  exit 0
fi
doflow_bridge codex PreToolUse pre-bash-guard
exit $?
