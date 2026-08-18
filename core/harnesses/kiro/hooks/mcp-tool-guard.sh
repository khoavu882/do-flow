#!/usr/bin/env bash
# mcp-tool-guard.sh — Kiro PreToolUse adapter for the DoFlow MCP tool guard.
#
# Intercepts an MCP tool call and blocks it on a match against mcp-policy.conf, the same
# TAB-separated pattern<TAB>reason convention Claude's and Codex's own mcp-tool-guard.sh use.
# Kiro's own PreToolUse tool-name field is not documented beyond "context is passed as JSON on
# stdin" (kiro.dev/docs/hooks/actions/), so — unlike Claude/Codex, which read `.tool_name`
# directly — this tries a short list of plausible field names and falls open (allow) if none
# resolve. The "mcp__" prefix convention itself is also an inference by analogy with Claude/Codex,
# not a confirmed Kiro naming rule; if Kiro names MCP tools differently, this guard is inert
# (never matches, never blocks) rather than wrong (blocking something it shouldn't).
#
# Ships with mcp-policy.conf empty (zero active patterns), so this is pure infrastructure until
# real usage data justifies specific deny rules — see
# agent-docs/research/hook-governance-agent-tool-mcp-skill.md §3.2.
#
# Multi-session safe: stateless — reads only the conf file, no shared state.
# Must complete in <50ms.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
TOOL_NAME=""
for field in '.tool_name' '.tool' '.toolName' '.name'; do
  TOOL_NAME=$(json_field "$INPUT" "$field")
  [[ -n "$TOOL_NAME" ]] && break
done

# Fast exit for non-MCP tool events (also covers "tool name unresolved").
[[ "$TOOL_NAME" =~ ^mcp__ ]] || exit 0

POLICY_FILE="$(dirname "$0")/mcp-policy.conf"

# If policy file is missing, allow everything (fail open — don't block the agent).
[[ ! -f "$POLICY_FILE" ]] && exit 0

# ── Pattern matching ──────────────────────────────────────────────────────────

while IFS=$'\t' read -r pattern reason || [[ -n "$pattern" ]]; do
  # Skip comments and empty lines
  [[ -z "$pattern" || "$pattern" == \#* ]] && continue

  # "--" stops option parsing so a pattern starting with "-" is never
  # mistaken for a grep flag.
  matched=false
  if (echo "$TOOL_NAME" | grep -qiE -- "$pattern" 2>/dev/null); then
    matched=true
  fi

  if [[ "$matched" == "true" ]]; then
    echo "[mcp-tool-guard] ${reason:-MCP tool call blocked by mcp-tool-guard} (tool: $TOOL_NAME)" >&2
    exit 2
  fi
done < "$POLICY_FILE"

# No match — allow
exit 0
