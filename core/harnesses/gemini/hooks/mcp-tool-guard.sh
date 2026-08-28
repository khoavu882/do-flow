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
source "$(dirname "$0")/../../shared/hooks/policies/deny-json.sh"

POLICY="$(dirname "$0")/../../shared/hooks/policies/mcp-tool-guard.sh"
REASON=$(bash "$POLICY" 2>&1 >/dev/null)
CODE=$?

[ "$CODE" -ne 0 ] && emit_pretooluse_deny_flat "${REASON:-MCP tool call blocked by mcp-tool-guard}"
exit 0
