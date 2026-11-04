#!/usr/bin/env bash
case "${OSTYPE:-}" in msys*|cygwin*|win32*) if command -v jq >/dev/null 2>&1; then jq() { command jq -b "$@"; }; fi ;; esac # native jq.exe ends lines with CRLF unless -b
# deny-json.sh — shared PreToolUse deny-JSON and advice-JSON emitters for front-door dispatchers.
#
# Deliberately carries no `set` directive (unlike lib.sh, which sets -euo
# pipefail on source): a front door needs `set -e` OFF while it captures a
# policy script's exit code via `REASON=$(bash "$POLICY" ...); CODE=$?` — under
# `set -e` that assignment's own nonzero exit status (the deny case) would abort
# the front door right there, before it ever reached the code below that emits
# the deny JSON. Sourcing this file must never change the caller's shell options.
#
# Usage: source "<policy-dir>/deny-json.sh"

_DOFLOW_SRC=${BASH_SOURCE[0]//\\//}; case $_DOFLOW_SRC in */*) _DOFLOW_DENY_JSON_DIR=${_DOFLOW_SRC%/*} ;; *) _DOFLOW_DENY_JSON_DIR=. ;; esac

# Escape a string as a JSON string body without external tools. Work bytewise so
# every control byte is handled the same way regardless of the caller's locale.
doflow_json_escape() {
  local LC_ALL=C input="${1-}" output="" char ordinal i
  for ((i = 0; i < ${#input}; i++)); do
    char="${input:i:1}"
    case "$char" in
      '\') output="$output\\\\" ;;
      '"') output="$output\\\"" ;;
      $'\n') output="$output\\n" ;;
      $'\r') output="$output\\r" ;;
      $'\t') output="$output\\t" ;;
      *)
        printf -v ordinal '%d' "'${char}"
        if [ "$ordinal" -ge 32 ]; then output="$output$char"; fi
        ;;
    esac
  done
  printf '%s' "$output"
}

_doflow_json_reason() {
  printf '"%s"' "$(doflow_json_escape "$1")"
}

# Claude/Codex shape: nested under hookSpecificOutput.permissionDecision.
emit_pretooluse_deny_nested() {
  local reason="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
    }'
  else
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' "$(_doflow_json_reason "$reason")"
  fi
}

# Advice emitters (D1, advise-only hooks). An advisory outcome never changes a decision; these put its
# one line where a harness shows it. Claude/Codex PreToolUse: additionalContext reaches the model, and
# carries no permissionDecision, so the user's own permission prompt still applies. Claude/Codex Stop:
# systemMessage is shown to the user and, unlike additionalContext, does not continue the turn.
emit_pretooluse_advice() {
  local line="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg line "$line" '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $line}}'
  else
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":%s}}\n' "$(_doflow_json_reason "$line")"
  fi
}

emit_stop_advice() {
  local line="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg line "$line" '{systemMessage: $line}'
  else
    printf '{"systemMessage":%s}\n' "$(_doflow_json_reason "$line")"
  fi
}
