#!/usr/bin/env bash
# post-tool-failure.sh — PostToolUse*Failure* hook (pure observability, no deny path)
#
# A failed tool call is the one outcome no other hook records. post-edit-lint.sh
# deliberately does NOT serve this event: it queues a path for end-of-turn linting,
# and on a failure the file was never written — queuing it would lint content that
# does not exist. This hook is the separate handler that failure case needs.
#
# Appends {timestamp, session_id, event, tool_name, file_path, error} to a
# session-scoped log. Fields beyond the common envelope (session_id,
# hook_event_name, tool_name) are best-effort: json_field yields empty for any
# absent key, so a payload shape change degrades to a thinner record rather than
# a broken hook.
#
# Multi-session safe: writes only to sessions/{session_id}/tool-failures.log.
# Must complete in <20ms. Must never exit non-zero or block the turn.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
SESSION_ID=$(json_field "$INPUT" ".session_id")

# Guard: if we can't determine the session, nothing to do
[[ -z "$SESSION_ID" ]] && exit 0

EVENT=$(json_field "$INPUT" ".hook_event_name")
TOOL_NAME=$(json_field "$INPUT" ".tool_name")
FILE_PATH=$(json_field "$INPUT" ".tool_input.file_path")
ERROR=$(json_field "$INPUT" ".tool_response.error")
TIMESTAMP=$(date -u +%FT%TZ)

SESSION_PATH=$(ensure_session_dir "$SESSION_ID")

jq -nc \
  --arg ts "$TIMESTAMP" \
  --arg session "$SESSION_ID" \
  --arg event "$EVENT" \
  --arg tool "$TOOL_NAME" \
  --arg file "$FILE_PATH" \
  --arg error "$ERROR" \
  '{timestamp: $ts, session_id: $session, event: $event, tool_name: $tool, file_path: $file, error: $error}' \
  >> "$SESSION_PATH/tool-failures.log" 2>/dev/null || true

exit 0
