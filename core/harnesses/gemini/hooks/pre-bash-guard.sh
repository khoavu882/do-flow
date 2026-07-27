#!/usr/bin/env bash
# pre-bash-guard.impl.sh — BeforeTool(run_shell_command) hook
#
# Intercepts every shell-command tool call and blocks dangerous commands by matching
# against patterns in blocked-patterns.conf. Same TAB-separated pattern<TAB>reason
# convention as Claude's/Codex's pre-bash-guard.sh — the field paths
# (.tool_name, .tool_input.command) are identical (docs/reference/tools.md confirms
# run_shell_command uses a "command" key), only the tool name and the deny-output
# shape differ from Claude/Codex.
#
# Gemini's hook output schema (packages/core/src/hooks/types.ts, confirmed this
# session) is a top-level {"decision": "deny", "reason": "..."} — NOT nested under
# hookSpecificOutput.permissionDecision like Claude/Codex. Do not port that nesting.
#
# Multi-session safe: stateless — reads only the conf file, no shared state.
# Must complete in <50ms.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

if ! echo "test" | grep -qP "test" 2>/dev/null; then
  echo "[pre-bash-guard] WARNING: PCRE grep unavailable on this system — command pattern guard is inactive" >&2
  echo "[pre-bash-guard] Install a PCRE-capable grep (e.g. sudo apt install grep / brew install grep) for full protection" >&2
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(json_field "$INPUT" ".tool_name")

# Fast exit for non-shell-command tool events
[[ "$TOOL_NAME" != "run_shell_command" ]] && exit 0

COMMAND=$(json_field "$INPUT" ".tool_input.command")
[[ -z "$COMMAND" ]] && exit 0

PATTERNS_FILE="$(dirname "$0")/blocked-patterns.conf"
[[ ! -f "$PATTERNS_FILE" ]] && exit 0

while IFS=$'\t' read -r pattern reason || [[ -n "$pattern" ]]; do
  [[ -z "$pattern" || "$pattern" == \#* ]] && continue

  matched=false
  if (echo "$COMMAND" | grep -qiP "$pattern" 2>/dev/null); then
    matched=true
  fi

  if [[ "$matched" == "true" ]]; then
    jq -n --arg reason "${reason:-Command blocked by pre-bash-guard}" '{decision: "deny", reason: $reason}'
    exit 0
  fi
done < "$PATTERNS_FILE"

exit 0
