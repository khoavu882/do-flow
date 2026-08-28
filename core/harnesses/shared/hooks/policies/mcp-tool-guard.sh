#!/usr/bin/env bash
# mcp-tool-guard.sh — Canonical Policy Library: PreToolUse(mcp_*) hook
#
# Intercepts every MCP tool call and blocks matches against mcp-policy.conf, the
# same TAB-separated pattern<TAB>reason convention pre-bash-guard.sh uses for
# shell commands. Ships with mcp-policy.conf carrying zero active patterns, so
# this is pure infrastructure until real usage data justifies specific deny
# rules — see agent-docs/research/hook-governance-agent-tool-mcp-skill.md §3.2.
#
# Multi-session safe: stateless — reads only the conf file, no shared state.
# Must complete in <50ms.
#
# Canonical Policy Script Contract (design.md §4):
#   env    DOFLOW_PROJECT_DIR, DOFLOW_AGENT (both optional; not required to
#          evaluate this policy)
#   stdin  a PreToolUse-shaped JSON payload; tool name is read from the union
#          of field names harnesses use (tool_name/tool/toolName/name), since
#          a native front door (Claude/Codex/Kiro) execs this script directly
#          with no payload translation of its own.
#   exit   0 = allow, non-zero = deny with the reason on stderr.
#
# Reconciliation note (022-normalize-hooks, Phase A): MCP tool-name
# vocabularies differ per harness — Claude/Codex/Kiro use a double-underscore
# "mcp__<server>__<tool>" convention, Gemini documents a single-underscore
# "mcp_<server>_<tool>" convention. A single-underscore prefix check ("^mcp_")
# matches both conventions (the double-underscore form is a superset match of
# the single-underscore prefix), so this script uses that one generic check
# instead of hardcoding either harness's exact convention.
#
# mcp-policy.conf's shape (TAB-separated regex<TAB>reason, '#'-comments,
# blank lines skipped) is identical across every harness that ships one today
# (claude/codex/gemini/kiro) — reconciliation found no divergence to resolve
# there.

set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0          # no jq -> cannot evaluate -> allow

INPUT=$(cat)

TOOL_NAME=""
for field in '.tool_name' '.tool' '.toolName' '.name'; do
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r "${field} // empty" 2>/dev/null)
  [ -n "$TOOL_NAME" ] && break
done

# Fast exit for non-MCP tool events (also covers "tool name unresolved").
# "mcp_" (single underscore) matches both Claude/Codex/Kiro's "mcp__" and
# Gemini's "mcp_" naming conventions. Matched case-insensitively: the caller
# (stream-hook-runner.js's MCP_TOOL_PATTERN) classifies case-insensitively
# before ever routing here, so this check must not be stricter than the
# classification that decided to invoke it (022-code-review finding).
shopt -s nocasematch 2>/dev/null || true
case "$TOOL_NAME" in
  mcp_*) ;;
  *) exit 0 ;;
esac
shopt -u nocasematch 2>/dev/null || true

POLICY_FILE="$(dirname "$0")/mcp-policy.conf"

# If policy file is missing, allow everything (fail open — don't block the agent).
[ -f "$POLICY_FILE" ] || exit 0

# ── Pattern matching ──────────────────────────────────────────────────────────

while IFS=$'\t' read -r pattern reason || [ -n "$pattern" ]; do
  # Skip comments and empty lines
  [ -z "$pattern" ] && continue
  case "$pattern" in \#*) continue ;; esac

  # "--" stops option parsing so a pattern starting with "-" is never
  # mistaken for a grep flag.
  matched=false
  if (echo "$TOOL_NAME" | grep -qiE -- "$pattern" 2>/dev/null); then
    matched=true
  fi

  if [ "$matched" = "true" ]; then
    echo "[mcp-tool-guard] ${reason:-MCP tool call blocked by mcp-tool-guard} (tool: $TOOL_NAME)" >&2
    exit 2
  fi
done < "$POLICY_FILE"

# No match — allow
exit 0
