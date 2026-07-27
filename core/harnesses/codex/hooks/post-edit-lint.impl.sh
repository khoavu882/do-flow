#!/usr/bin/env bash
# post-edit-lint.impl.sh — PostToolUse(Edit|Write|apply_patch) hook, shared across harnesses
#
# Pure collector: appends the edited/written file_path to a session-scoped
# list. The actual lint work happens in stop-check.sh at the end of each
# turn, where all paths can be batched by extension in one pass.
#
# Multi-session safe: writes only to sessions/{session_id}/edited-files.txt.
# Must complete in <20ms. Must never exit non-zero or produce unexpected output.
# Emits no stdout, so this script's output has no harness-specific compatibility
# question (unlike pre-compact.impl.sh) — every harness accepts a silent exit 0.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
SESSION_ID=$(json_field "$INPUT" ".session_id")
TOOL_NAME=$(json_field "$INPUT" ".tool_name")

# Only handle Edit/Write (Claude, Gemini) and apply_patch (Codex's edit tool name)
[[ "$TOOL_NAME" != "Edit" && "$TOOL_NAME" != "Write" && "$TOOL_NAME" != "apply_patch" ]] && exit 0

# Guard: if we can't determine the session, nothing to do
[[ -z "$SESSION_ID" ]] && exit 0

SESSION_PATH=$(ensure_session_dir "$SESSION_ID")

if [[ "$TOOL_NAME" == "apply_patch" ]]; then
  # Codex's apply_patch has no tool_input.file_path — tool_input is
  # {"command": "<raw patch text>"}, a unified-diff-style patch that can touch
  # multiple files via "*** Add File:" / "*** Update File:" / "*** Delete File:"
  # / "*** Move to:" headers (confirmed against codex-rs/core/prompt_with_apply_patch_instructions.md
  # and apply_patch_tests.rs — there is no single file_path field to read).
  PATCH=$(json_field "$INPUT" ".tool_input.command")
  [[ -z "$PATCH" ]] && exit 0
  echo "$PATCH" | grep -oE '^\*\*\* (Add File|Update File|Delete File|Move to): .+' \
    | sed -E 's/^\*\*\* (Add File|Update File|Delete File|Move to): //' \
    >> "$SESSION_PATH/edited-files.txt" || true
  exit 0
fi

FILE_PATH=$(json_field "$INPUT" ".tool_input.file_path")

# Skip if no file_path (e.g., field absent from input)
[[ -z "$FILE_PATH" ]] && exit 0

# Append path (one per line) — stop-check.sh reads this list atomically
echo "$FILE_PATH" >> "$SESSION_PATH/edited-files.txt"

exit 0
