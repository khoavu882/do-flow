#!/usr/bin/env bash
# mcp-tool-guard.sh — BeforeTool(mcp_.*) hook
#
# Same TAB-separated pattern<TAB>reason convention as pre-bash-guard.sh, applied to
# MCP tool names instead of shell commands. Gemini's MCP tool naming is
# mcp_{serverName}_{toolName} — a single underscore prefix (docs/tools/mcp-server.md,
# confirmed), NOT Claude's/Codex's double-underscore mcp__server__tool.
# Ships with mcp-policy.conf empty (zero active patterns), matching Claude's/Codex's
# same pure-infrastructure starting point.
#
# Multi-session safe: stateless — reads only the conf file, no shared state.
# Must complete in <50ms.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

if ! echo "test" | grep -qP "test" 2>/dev/null; then
  echo "[mcp-tool-guard] WARNING: PCRE grep unavailable on this system — MCP tool pattern guard is inactive" >&2
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(json_field "$INPUT" ".tool_name")

# Fast exit for non-MCP tool events
[[ ! "$TOOL_NAME" =~ ^mcp_ ]] && exit 0

POLICY_FILE="$(dirname "$0")/mcp-policy.conf"
[[ ! -f "$POLICY_FILE" ]] && exit 0

while IFS=$'\t' read -r pattern reason || [[ -n "$pattern" ]]; do
  [[ -z "$pattern" || "$pattern" == \#* ]] && continue

  matched=false
  if (echo "$TOOL_NAME" | grep -qiP "$pattern" 2>/dev/null); then
    matched=true
  fi

  if [[ "$matched" == "true" ]]; then
    jq -n --arg reason "${reason:-MCP tool call blocked by mcp-tool-guard}" '{decision: "deny", reason: $reason}'
    exit 0
  fi
done < "$POLICY_FILE"

exit 0
