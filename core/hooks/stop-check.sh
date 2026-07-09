#!/usr/bin/env bash
# stop-check.sh — Stop hook
#
# Two responsibilities:
#   1. Batch lint dispatch: reads the list of files edited this turn
#      (written by post-edit-lint.sh), dispatches formatters async and
#      linters sync with a 2s timeout, then clears the list.
#   2. Stub detection: parses the JSONL transcript to extract ONLY the
#      last assistant message content, then checks for unfinished markers.
#      Exits 2 if stubs are found (blocks Claude from stopping).
#
# Multi-session safe: reads/writes only from sessions/{session_id}/.
# Async lint uses </dev/null >/dev/null to avoid holding stdin fd.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
SESSION_ID=$(json_field "$INPUT" ".session_id")
TRANSCRIPT_PATH=$(json_field "$INPUT" ".transcript_path")

[[ -z "$SESSION_ID" ]] && exit 0

SESSION_PATH=$(ensure_session_dir "$SESSION_ID")
EDITED_FILES="$SESSION_PATH/edited-files.txt"
PROC_FILE="$SESSION_PATH/edited-files.txt.proc"

# ── 1. Lint dispatch ──────────────────────────────────────────────────────────

# Atomic read-and-clear: mv before reading so concurrent PostToolUse writes
# go to a fresh edited-files.txt, not the file we're about to process.
mv "$EDITED_FILES" "$PROC_FILE" 2>/dev/null || true

if [[ -f "$PROC_FILE" ]] && [[ -s "$PROC_FILE" ]]; then
  # Partition paths by extension
  py_files=()
  js_files=()
  go_files=()
  java_has_files=false

  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    case "$path" in
      *.py)                   py_files+=("$path") ;;
      *.ts|*.tsx|*.js|*.jsx)  js_files+=("$path") ;;
      *.go)                   go_files+=("$path") ;;
      *.java)                 java_has_files=true ;;
    esac
  done < "$PROC_FILE"

  # Python: async format, sync check (errors reach Claude via stderr)
  if [[ ${#py_files[@]} -gt 0 ]]; then
    if command -v ruff &>/dev/null; then
      nohup ruff format "${py_files[@]}" </dev/null >/dev/null 2>&1 &
      timeout 2 ruff check "${py_files[@]}" 2>&1 || true
    fi
  fi

  # JS/TS: async fix only (eslint --fix rarely needs Claude's immediate attention)
  if [[ ${#js_files[@]} -gt 0 ]]; then
    if command -v eslint &>/dev/null; then
      nohup eslint --fix "${js_files[@]}" </dev/null >/dev/null 2>&1 &
    fi
  fi

  # Go: sync format (gofmt is fast, <100ms for typical files)
  if [[ ${#go_files[@]} -gt 0 ]]; then
    if command -v gofmt &>/dev/null; then
      timeout 2 gofmt -w "${go_files[@]}" 2>&1 || true
    fi
  fi

  # Java: async spotlessApply (slow — only if gradlew exists in cwd)
  if [[ "$java_has_files" == "true" ]]; then
    if [[ -x "./gradlew" ]]; then
      nohup ./gradlew spotlessApply </dev/null >/dev/null 2>&1 &
    fi
  fi

  rm -f "$PROC_FILE"
fi

# ── 2. Stub detection ─────────────────────────────────────────────────────────

# Only parse transcript if we have a path to it
[[ -z "$TRANSCRIPT_PATH" || ! -f "$TRANSCRIPT_PATH" ]] && exit 0

# Extract last assistant message content from JSONL.
# tail-scan is O(constant) regardless of transcript size — the last assistant
# entry is always near the end of the file. 200 lines covers any realistic
# single response without loading the entire (potentially multi-MB) transcript.
LAST_ASSISTANT_CONTENT=$(
  tail -n 200 "$TRANSCRIPT_PATH" \
    | jq -rs '[.[] | select(.role == "assistant")] | last | .content // ""' 2>/dev/null
)

[[ -z "$LAST_ASSISTANT_CONTENT" ]] && exit 0

# Search extracted content for unfinished-work markers
# Match stubs only inside code comment context to avoid false positives from
# explanatory prose (e.g. "I removed the TODO comment" should not trigger).
STUB_PATTERN='(?:#|//)\s*(?:TODO|FIXME)\b|raise NotImplementedError|throw new Error\(.*[Nn]ot [Ii]mplemented|(?:#|//)\s*stub\b'

if echo "$LAST_ASSISTANT_CONTENT" | grep -qiP "$STUB_PATTERN" 2>/dev/null; then
  echo "[stop-check] Unfinished stub or TODO detected in last response — please complete the implementation before stopping." >&2
  exit 2
fi

exit 0
