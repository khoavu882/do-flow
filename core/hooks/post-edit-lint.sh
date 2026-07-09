#!/usr/bin/env bash
# post-edit-lint.sh — PostToolUse(Edit|Write) hook
#
# Pure collector: appends the edited/written file_path to a session-scoped
# list. The actual lint work happens in stop-check.sh at the end of each
# Claude turn, where all paths can be batched by extension in one pass.
#
# Multi-session safe: writes only to sessions/{session_id}/edited-files.txt.
# Must complete in <20ms. Must never exit non-zero or produce unexpected output.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
SESSION_ID=$(json_field "$INPUT" ".session_id")
TOOL_NAME=$(json_field "$INPUT" ".tool_name")

# Only handle Edit and Write events
[[ "$TOOL_NAME" != "Edit" && "$TOOL_NAME" != "Write" ]] && exit 0

# Guard: if we can't determine the session, nothing to do
[[ -z "$SESSION_ID" ]] && exit 0

FILE_PATH=$(json_field "$INPUT" ".tool_input.file_path")

# Skip if no file_path (e.g., field absent from input)
[[ -z "$FILE_PATH" ]] && exit 0

SESSION_PATH=$(ensure_session_dir "$SESSION_ID")

# Append path (one per line) — stop-check.sh reads this list atomically
echo "$FILE_PATH" >> "$SESSION_PATH/edited-files.txt"

exit 0
