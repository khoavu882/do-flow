#!/usr/bin/env bash
# Claude front door: mcp-tool-guard through the shared lifecycle bridge.
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-claude}"
if ! . "$(dirname "$0")/../../.doflow/shared/hooks/bridge/bridge.sh" 2>/dev/null; then
  # D1: a missing bridge allows. Only DOFLOW_FAULT_PROFILE=strict-1, a person's opt-in, denies.
  if [ "${DOFLOW_FAULT_PROFILE:-}" = strict-1 ]; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[doflow] shared hooks lack the bridge; run: doflow update -t claude"}}'
  fi
  exit 0
fi
doflow_bridge claude PreToolUse mcp-tool-guard
exit $?
