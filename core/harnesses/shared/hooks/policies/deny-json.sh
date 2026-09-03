#!/usr/bin/env bash
# deny-json.sh — shared PreToolUse deny-JSON emitters for front-door dispatchers.
#
# Deliberately carries no `set` directive (unlike lib.sh, which sets -euo
# pipefail on source): a front door needs `set -e` OFF while it captures a
# policy script's exit code via `REASON=$(bash "$POLICY" ...); CODE=$?` — under
# `set -e` that assignment's own nonzero exit status (the deny case) would abort
# the front door right there, before it ever reached the code below that emits
# the deny JSON. Sourcing this file must never change the caller's shell options.
#
# Usage: source "$(dirname "$0")/../../shared/hooks/policies/deny-json.sh"

# Claude/Codex shape: nested under hookSpecificOutput.permissionDecision.
emit_pretooluse_deny_nested() {
  local reason="$1"
  jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
}

# Gemini shape: flat {decision, reason} (packages/core/src/hooks/types.ts).
emit_pretooluse_deny_flat() {
  local reason="$1"
  jq -n --arg reason "$reason" '{decision: "deny", reason: $reason}'
}
