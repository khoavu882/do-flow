#!/usr/bin/env bash
# pre-bash-guard.sh — PreToolUse(Bash) hook
#
# Intercepts every Bash tool call and blocks dangerous commands by matching
# against patterns in blocked-patterns.conf. Returns a JSON deny decision
# with a human-readable reason so Claude can understand and self-correct.
#
# Multi-session safe: stateless — reads only the conf file, no shared state.
# Must complete in <50ms.
#
# Schema verified (Phase 8.3, 2026-04-17): hookSpecificOutput.permissionDecision
# "deny" is correctly recognized by Claude Code and blocks execution.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

# Verify PCRE grep is available. Without it, the patterns in blocked-patterns.conf
# (which use PCRE syntax: (?:...), \s, negative lookahead (?!...)) cannot match.
# Emit a visible warning rather than silently failing open, so the operator knows
# pattern protection is inactive and can install PCRE grep (e.g. grep with --perl-regexp).
if ! echo "test" | grep -qP "test" 2>/dev/null; then
  echo "[pre-bash-guard] WARNING: PCRE grep unavailable on this system — command pattern guard is inactive" >&2
  echo "[pre-bash-guard] Install a PCRE-capable grep (e.g. sudo apt install grep / brew install grep) for full protection" >&2
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(json_field "$INPUT" ".tool_name")

# Fast exit for non-Bash tool events
[[ "$TOOL_NAME" != "Bash" ]] && exit 0

COMMAND=$(json_field "$INPUT" ".tool_input.command")

# Nothing to check if command is empty
[[ -z "$COMMAND" ]] && exit 0

PATTERNS_FILE="$(dirname "$0")/blocked-patterns.conf"

# If patterns file is missing, allow everything (fail open — don't block Claude)
[[ ! -f "$PATTERNS_FILE" ]] && exit 0

# ── Pattern matching ──────────────────────────────────────────────────────────

while IFS=$'\t' read -r pattern reason || [[ -n "$pattern" ]]; do
  # Skip comments and empty lines
  [[ -z "$pattern" || "$pattern" == \#* ]] && continue

  # Match pattern against command (case-insensitive, extended regex)
  # Wrap in subshell so a bad regex exits the subshell, not the script
  matched=false
  if (echo "$COMMAND" | grep -qiP "$pattern" 2>/dev/null); then
    matched=true
  fi

  if [[ "$matched" == "true" ]]; then
    # Output deny decision as JSON — Claude receives the reason and can self-correct
    jq -n \
      --arg reason "${reason:-Command blocked by pre-bash-guard}" \
      '{
        "hookSpecificOutput": {
          "hookEventName": "PreToolUse",
          "permissionDecision": "deny",
          "permissionDecisionReason": $reason
        }
      }'
    exit 0
  fi
done < "$PATTERNS_FILE"

# No match — allow
exit 0
