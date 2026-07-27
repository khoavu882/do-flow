#!/usr/bin/env bash
# post-edit-lint.sh — AfterTool(write_file|replace) hook
#
# Pure collector: appends the edited/written file_path to a session-scoped
# list. The actual lint work happens in stop-check.sh at the end of each
# turn, where all paths can be batched by extension in one pass.
#
# Gemini's write_file/replace tools both use a "file_path" tool_input key
# (docs/reference/tools.md) — same field as Claude's
# Edit/Write, unlike Codex's apply_patch (which needed patch-text parsing).
#
# KNOWN GAP: stop-check.sh (Claude's/Codex's consumer of edited-files.txt, run on the
# Stop event) is NOT ported to Gemini — Gemini has no Stop-equivalent event (design.md
# §8, this feature). This collector currently writes data nothing reads. Shipped anyway
# as forward-looking infrastructure, same precedent as this repo's own mcp-policy.conf
# (ships empty, ahead of real usage) — revisit once/if a Gemini turn-end consumer exists.
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

[[ "$TOOL_NAME" != "write_file" && "$TOOL_NAME" != "replace" ]] && exit 0
[[ -z "$SESSION_ID" ]] && exit 0

FILE_PATH=$(json_field "$INPUT" ".tool_input.file_path")
[[ -z "$FILE_PATH" ]] && exit 0

SESSION_PATH=$(ensure_session_dir "$SESSION_ID")
echo "$FILE_PATH" >> "$SESSION_PATH/edited-files.txt"

exit 0
