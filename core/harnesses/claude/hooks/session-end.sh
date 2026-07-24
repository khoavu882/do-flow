#!/usr/bin/env bash
# session-end.sh — SessionEnd hook
#
# Runs when Claude Code closes a session. Responsibilities:
#   1. Append END marker to sessions.log
#   2. Write uncommitted-warning.txt if the working tree is dirty
#   3. Delete the session-scoped state directory (cleanup)
#   4. Trim sessions.log to last 500 lines (flock-guarded for parallel safety)
#
# Multi-session safe: flock prevents concurrent sessions from corrupting the log
# trim. Session directory deletion is per session_id so sessions don't interfere.
# Must never exit non-zero or block (SessionEnd is fire-and-forget).

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
SESSION_ID=$(json_field "$INPUT" ".session_id")
CWD=$(json_field "$INPUT" ".cwd")

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ── 1. Log session end ────────────────────────────────────────────────────────

mkdir -p "$(dirname "$SESSIONS_LOG")"
echo "$TIMESTAMP END ${SESSION_ID:-unknown} ${CWD:-unknown}" >> "$SESSIONS_LOG"

# ── 2. Uncommitted-changes warning ────────────────────────────────────────────

if [[ -n "$CWD" ]] && timeout 1 git -C "$CWD" rev-parse --is-inside-work-tree &>/dev/null; then
  if timeout 1 git -C "$CWD" status --porcelain 2>/dev/null | grep -q .; then
    BRANCH=$(timeout 1 git -C "$CWD" branch --show-current 2>/dev/null || echo "unknown")
    PROJECT_DIR=$(ensure_project_dir "$CWD")
    echo "Session ${SESSION_ID:-unknown} ended with uncommitted changes on branch ${BRANCH}" \
      > "$PROJECT_DIR/uncommitted-warning.txt"
  fi
fi

# ── 2b. Update meta.json last_active ─────────────────────────────────────────

if [[ -n "$CWD" ]]; then
  PROJECT_DIR=$(ensure_project_dir "$CWD")
  if [[ -f "$PROJECT_DIR/meta.json" ]]; then
    META_TMP=$(mktemp "$PROJECT_DIR/.meta.XXXXXX")
    jq --arg ts "$TIMESTAMP" '.last_active = $ts' "$PROJECT_DIR/meta.json" \
      > "$META_TMP" && mv "$META_TMP" "$PROJECT_DIR/meta.json" \
      || rm -f "$META_TMP" 2>/dev/null || true
  fi
fi

# ── 3. Delete session directory ───────────────────────────────────────────────

if [[ -n "$SESSION_ID" ]]; then
  SESSION_PATH="$SESSION_DIR/$SESSION_ID"
  rm -rf "$SESSION_PATH" 2>/dev/null || true
fi

# ── 4. Trim sessions.log (flock-guarded) ──────────────────────────────────────

LOCK_FILE="${SESSIONS_LOG}.lock"
(
  flock -x -w 5 200 || exit 0  # Give up after 5s rather than block indefinitely
  if [[ -f "$SESSIONS_LOG" ]]; then
    TMP=$(mktemp "${SESSIONS_LOG}.XXXXXX")
    if tail -n 500 "$SESSIONS_LOG" > "$TMP"; then
      mv "$TMP" "$SESSIONS_LOG" || rm -f "$TMP"
    else
      rm -f "$TMP"
    fi
  fi
) 200>"$LOCK_FILE"

exit 0
