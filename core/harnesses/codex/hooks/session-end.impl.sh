#!/usr/bin/env bash
case "${OSTYPE:-}" in msys*|cygwin*|win32*) if command -v jq >/dev/null 2>&1; then jq() { command jq -b "$@"; }; fi ;; esac # native jq.exe ends lines with CRLF unless -b
# session-end.sh — SessionEnd hook
#
# Runs when Claude Code closes a session. Responsibilities:
#   1. Append END marker to sessions.log
#   2. Write uncommitted-warning.txt if the working tree is dirty
#   3. Delete the session-scoped state directory (cleanup)
#   4. Trim sessions.log to last 500 lines (lock-guarded for parallel safety,
#      via lib.sh's portable with_file_lock — no flock dependency)
#
# Multi-session safe: with_file_lock prevents concurrent sessions from
# corrupting the log trim. Session directory deletion is per session_id so
# sessions don't interfere.
# Must never exit non-zero or block (SessionEnd is fire-and-forget).

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_jq

INPUT=$(cat)
SESSION_ID=$(json_field "$INPUT" ".session_id")
CWD=$(json_field "$INPUT" ".cwd")

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Start storage cleanup without changing the hook's output, status, or latency.
start_storage_upkeep() {
  (
    SHARED_POLICY_LIB="$(dirname "$0")/../../.doflow/shared/hooks/policies/lib.sh"
    if [[ ! -f "$SHARED_POLICY_LIB" ]]; then
      SHARED_POLICY_LIB="$(dirname "$0")/../../shared/hooks/policies/lib.sh"
    fi
    if [[ -f "$SHARED_POLICY_LIB" ]]; then
      source "$SHARED_POLICY_LIB"
      storage_upkeep_async "$CWD"
    fi
  ) >/dev/null 2>&1 || true
}

# No config home (lib.sh leaves the state paths empty): no session store to write, but the
# storage upkeep still starts (086 IC-010).
if [[ -z "$STATE_DIR" ]]; then
  start_storage_upkeep
  exit 0
fi

# ── 1. Log session end ────────────────────────────────────────────────────────

mkdir -p "$(dirname "$SESSIONS_LOG")"
echo "$TIMESTAMP END ${SESSION_ID:-unknown} ${CWD:-unknown}" >> "$SESSIONS_LOG"

# ── 2. Uncommitted-changes warning ────────────────────────────────────────────

# A worker session never writes the project's warning; it is left for the main session.
if [[ "$(doflow_session_role || echo main)" != "worker" ]] && [[ -n "$CWD" ]] && is_git_worktree "$CWD"; then
  if has_uncommitted_changes "$CWD"; then
    BRANCH=$(git_branch_of "$CWD" || echo "unknown")
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

start_storage_upkeep

# ── 4. Trim sessions.log (lock-guarded) ───────────────────────────────────────

LOCK_FILE="${SESSIONS_LOG}.lock"
# Give up after 5s rather than block indefinitely: if the lock is held, skip
# the trim below and fall through to a normal exit 0 (SessionEnd is
# fire-and-forget and must never exit non-zero or block).
if with_file_lock "$LOCK_FILE" 5; then
  if [[ -f "$SESSIONS_LOG" ]]; then
    TMP=$(mktemp "${SESSIONS_LOG}.XXXXXX")
    if tail -n 500 "$SESSIONS_LOG" > "$TMP"; then
      mv "$TMP" "$SESSIONS_LOG" || rm -f "$TMP"
    else
      rm -f "$TMP"
    fi
  fi
  with_file_lock "$LOCK_FILE" release
fi

exit 0
