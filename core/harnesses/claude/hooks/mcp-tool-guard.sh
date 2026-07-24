#!/usr/bin/env bash
# mcp-tool-guard.sh — PreToolUse(mcp__.*) hook
#
# Intercepts every MCP tool call and blocks matches against mcp-policy.conf, the same
# TAB-separated pattern<TAB>reason convention pre-bash-guard.sh already uses for Bash — this is a
# near copy-paste of that script with a different input field (tool_name instead of
# tool_input.command) and a different config file. Ships with mcp-policy.conf empty (zero active
# patterns), so this is pure infrastructure until real usage data (via subagent-audit.sh, or
# manual observation) justifies specific deny rules — see
# agent-docs/research/hook-governance-agent-tool-mcp-skill.md §3.2.
#
# Multi-session safe: stateless — reads only the conf file, no shared state.
# Must complete in <50ms.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

# Verify PCRE grep is available — same guard pre-bash-guard.sh uses, same reason:
# blocked-patterns-style regex (lookahead, \s) requires it.
if ! echo "test" | grep -qP "test" 2>/dev/null; then
  echo "[mcp-tool-guard] WARNING: PCRE grep unavailable on this system — MCP tool pattern guard is inactive" >&2
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(json_field "$INPUT" ".tool_name")

# Fast exit for non-MCP tool events
[[ ! "$TOOL_NAME" =~ ^mcp__ ]] && exit 0

POLICY_FILE="$(dirname "$0")/mcp-policy.conf"

# If policy file is missing, allow everything (fail open — don't block Claude)
[[ ! -f "$POLICY_FILE" ]] && exit 0

# ── Pattern matching ──────────────────────────────────────────────────────────

while IFS=$'\t' read -r pattern reason || [[ -n "$pattern" ]]; do
  # Skip comments and empty lines
  [[ -z "$pattern" || "$pattern" == \#* ]] && continue

  matched=false
  if (echo "$TOOL_NAME" | grep -qiP "$pattern" 2>/dev/null); then
    matched=true
  fi

  if [[ "$matched" == "true" ]]; then
    jq -n \
      --arg reason "${reason:-MCP tool call blocked by mcp-tool-guard}" \
      '{
        "hookSpecificOutput": {
          "hookEventName": "PreToolUse",
          "permissionDecision": "deny",
          "permissionDecisionReason": $reason
        }
      }'
    exit 0
  fi
done < "$POLICY_FILE"

# No match — allow
exit 0
