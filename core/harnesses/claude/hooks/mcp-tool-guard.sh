#!/usr/bin/env bash
# Claude front door: delegates the mcp-tool-guard decision to the Canonical Policy
# Library, then translates it into Claude Code's verified deny contract.
#
# Schema verified (Phase 8.3, 2026-04-17): hookSpecificOutput.permissionDecision
# "deny" is correctly recognized by Claude Code and blocks execution — exit code
# alone is not sufficient here, so this front door is a translator, not a bare
# exec (unlike session-context/stop-check, which never need this translation).
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-claude}"

command -v jq >/dev/null 2>&1 || exit 0

POLICY="$(dirname "$0")/../../shared/hooks/policies/mcp-tool-guard.sh"
REASON=$(bash "$POLICY" 2>&1 >/dev/null)
CODE=$?

if [ "$CODE" -ne 0 ]; then
  jq -n --arg reason "${REASON:-MCP tool call blocked by mcp-tool-guard}" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
fi
exit 0
