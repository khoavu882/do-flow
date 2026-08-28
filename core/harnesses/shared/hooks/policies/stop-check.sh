#!/usr/bin/env bash
# stop-check.sh — Canonical Policy Library: Stop hook
#
# Two responsibilities:
#   1. Batch lint dispatch: reads the list of files edited this turn
#      (written by a harness's own post-edit-lint hook), dispatches
#      formatters async and linters sync with a 2s timeout, then clears the
#      list. Only runs when the incoming payload carries a session_id — a
#      harness with no edited-files queue of its own (e.g. Antigravity, which
#      wires no PostToolUse editor hook yet) simply has nothing to drain here.
#   2. Stub detection: parses the JSONL transcript to extract ONLY the last
#      assistant message content, then checks for unfinished-work markers.
#      Exits non-zero if stubs are found (blocks the session from stopping).
#      Runs independently of (1) — it only needs a transcript path, not a
#      session_id, so it still fires for a harness that has no edited-files
#      queue.
#   3. Process-leak scan: DoFlow's own identifiers (FR-###, agent-docs/, chain
#      artifact names) reaching files that ship. Warns, never blocks.
#
# Multi-session safe: reads/writes only from sessions/{session_id}/.
# Async lint uses </dev/null >/dev/null to avoid holding stdin fd.
#
# Canonical Policy Script Contract (design.md §4):
#   env    DOFLOW_PROJECT_DIR, DOFLOW_AGENT (both optional here)
#   stdin  a Stop-shaped JSON payload. session_id and transcript path field
#          names both vary by harness (transcript_path vs. Antigravity's
#          camelCase transcriptPath) — this script reads the union of known
#          field names rather than assuming one, since a native front door
#          (Claude/Codex/Kiro) execs this script directly with no payload
#          translation of its own.
#   exit   0 = allow the stop, non-zero = deny (block the stop) with the
#          reason on stderr.
#
# Depends on lib.sh (require_jq, json_field, ensure_session_dir,
# run_with_timeout) being discoverable next to this script when it runs — see
# session-context.sh's header note; the same front-door responsibility
# applies here.
#
# Reconciliation note (022-normalize-hooks, Phase A): claude's own copy of
# this policy additionally ran a process-leak scan (step 3) that
# codex/kiro's copies did not have; that step is folded in here as the more
# complete, already-proven behavior (D3) rather than dropped. Antigravity's
# copy runs stub detection only (no lint dispatch, no leak scan — it has no
# edited-files queue to drain), gated on session_id being absent being a
# no-op rather than an early exit, so stub detection still fires for it.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
SESSION_ID=$(json_field "$INPUT" ".session_id")

TRANSCRIPT_PATH=$(json_field "$INPUT" ".transcript_path")
[ -z "$TRANSCRIPT_PATH" ] && TRANSCRIPT_PATH=$(json_field "$INPUT" ".transcriptPath")

# ── 1. Lint dispatch (only when we have a session-scoped edited-files queue) ──

if [ -n "$SESSION_ID" ]; then
  SESSION_PATH=$(ensure_session_dir "$SESSION_ID")
  EDITED_FILES="$SESSION_PATH/edited-files.txt"
  PROC_FILE="$SESSION_PATH/edited-files.txt.proc"

  # Atomic read-and-clear: mv before reading so concurrent PostToolUse writes
  # go to a fresh edited-files.txt, not the file we're about to process.
  mv "$EDITED_FILES" "$PROC_FILE" 2>/dev/null || true

  if [ -f "$PROC_FILE" ] && [ -s "$PROC_FILE" ]; then
    # Partition paths by extension
    py_files=()
    js_files=()
    go_files=()
    leak_files=()
    java_has_files=false

    # The resolver for the leak-scan verb. Absent install -> the scan is
    # skipped, like every other tool below: this hook has never required
    # anything to be present.
    DOFLOW_RUN=""
    for candidate in \
      "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bin/doflow-run" \
      "$HOME/.doflow/scripts/doflow/bin/doflow-run"
    do
      [ -x "$candidate" ] && { DOFLOW_RUN="$candidate"; break; }
    done

    while IFS= read -r path; do
      [ -z "$path" ] && continue
      case "$path" in
        *.py)                   py_files+=("$path") ;;
        *.ts|*.tsx|*.js|*.jsx)  js_files+=("$path") ;;
        *.go)                   go_files+=("$path") ;;
        *.java)                 java_has_files=true ;;
      esac
      # Every edited path is a leak-scan candidate regardless of language;
      # the verb decides what it can read and reports the rest as unscanned.
      case "$path" in
        */agent-docs/*|agent-docs/*) ;;   # correct usage there; the verb excludes it too
        *)                          leak_files+=("$path") ;;
      esac
    done < "$PROC_FILE"

    # Python: async format, sync check (errors reach the caller via stderr)
    if [ ${#py_files[@]} -gt 0 ]; then
      if command -v ruff &>/dev/null; then
        nohup ruff format "${py_files[@]}" </dev/null >/dev/null 2>&1 &
        run_with_timeout 2 -- ruff check "${py_files[@]}" 2>&1 || true
      fi
    fi

    # JS/TS: async fix only (eslint --fix rarely needs the caller's immediate attention)
    if [ ${#js_files[@]} -gt 0 ]; then
      if command -v eslint &>/dev/null; then
        nohup eslint --fix "${js_files[@]}" </dev/null >/dev/null 2>&1 &
      fi
    fi

    # Go: sync format (gofmt is fast, <100ms for typical files)
    if [ ${#go_files[@]} -gt 0 ]; then
      if command -v gofmt &>/dev/null; then
        run_with_timeout 2 -- gofmt -w "${go_files[@]}" 2>&1 || true
      fi
    fi

    # Java: async spotlessApply (slow — only if gradlew exists in cwd)
    if [ "$java_has_files" = "true" ]; then
      if [ -x "./gradlew" ]; then
        nohup ./gradlew spotlessApply </dev/null >/dev/null 2>&1 &
      fi
    fi

    # Process-leak scan: DoFlow's own identifiers (FR-###, agent-docs/, chain
    # artifact names) reaching files that ship. Warns, never blocks — a
    # legitimate occurrence exists in docs *about* DoFlow, and a false
    # positive that failed a turn would cost more than the leak it prevented.
    if [ ${#leak_files[@]} -gt 0 ]; then
      leak_args=()
      for p in "${leak_files[@]}"; do leak_args+=(--path "$p"); done
      if [ -n "$DOFLOW_RUN" ]; then
        leak_out="$(run_with_timeout 2 -- "$DOFLOW_RUN" leak-scan "${leak_args[@]}" 2>/dev/null || true)"
        if [ -n "$leak_out" ] && printf '%s' "$leak_out" | grep -q ':[0-9]'; then
          printf 'doflow: internal identifiers found in shipped files (warning, not a block):\n%s\n' \
            "$leak_out" >&2
        fi
      fi
    fi

    rm -f "$PROC_FILE"
  fi
fi

# ── 2. Stub detection ─────────────────────────────────────────────────────────

# Only parse transcript if we have a path to it
[ -z "$TRANSCRIPT_PATH" ] && exit 0
[ -f "$TRANSCRIPT_PATH" ] || exit 0

# Extract last assistant message content from JSONL.
# tail-scan is O(constant) regardless of transcript size — the last assistant
# entry is always near the end of the file. 200 lines covers any realistic
# single response without loading the entire (potentially multi-MB) transcript.
LAST_ASSISTANT_CONTENT=$(
  tail -n 200 "$TRANSCRIPT_PATH" \
    | jq -rs '[.[] | select(.role == "assistant")] | last | .content // ""' 2>/dev/null
)

[ -z "$LAST_ASSISTANT_CONTENT" ] && exit 0

# Search extracted content for unfinished-work markers
# Match stubs only inside code comment context to avoid false positives from
# explanatory prose (e.g. "I removed the TODO comment" should not trigger).
# POSIX ERE has no \b; require what follows TODO/FIXME/stub to be a
# non-word character or end-of-string instead, so "TODOX" doesn't match.
STUB_PATTERN='(#|//)[[:space:]]*(TODO|FIXME)([^[:alnum:]_]|$)|raise NotImplementedError|throw new Error\(.*[Nn]ot [Ii]mplemented|(#|//)[[:space:]]*stub([^[:alnum:]_]|$)'

if echo "$LAST_ASSISTANT_CONTENT" | grep -qiE -- "$STUB_PATTERN" 2>/dev/null; then
  echo "[stop-check] Unfinished stub or TODO detected in last response — please complete the implementation before stopping." >&2
  exit 2
fi

exit 0
