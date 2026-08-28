#!/usr/bin/env bash
# Gemini front door: delegates the mcp-tool-guard decision to the Canonical
# Policy Library, then translates it into Gemini's verified deny contract.
#
# Gemini's hook output schema (packages/core/src/hooks/types.ts, confirmed this
# session) is a top-level {"decision": "deny", "reason": "..."} — NOT nested
# under hookSpecificOutput.permissionDecision like Claude/Codex. Exit code alone
# is not sufficient here, so this front door is a translator, not a bare exec
# (unlike session-context, which never needs this translation).
set -uo pipefail
export DOFLOW_AGENT="${DOFLOW_AGENT:-gemini}"

command -v jq >/dev/null 2>&1 || exit 0

POLICY="$(dirname "$0")/../../shared/hooks/policies/mcp-tool-guard.sh"
REASON=$(bash "$POLICY" 2>&1 >/dev/null)
CODE=$?

if [ "$CODE" -ne 0 ]; then
  jq -n --arg reason "${REASON:-MCP tool call blocked by mcp-tool-guard}" '{decision: "deny", reason: $reason}'
fi
exit 0
