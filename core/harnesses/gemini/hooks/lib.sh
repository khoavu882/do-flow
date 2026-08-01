#!/usr/bin/env bash
# lib.sh — shared constants and helpers for session lifecycle hooks
#
# Usage: source "$(dirname "$0")/lib.sh"
#
# All hooks must:
#   1. source this file at the top
#   2. call require_jq immediately after
#   3. capture stdin once: INPUT=$(cat)
#   4. use: json_field "$INPUT" ".field_name"
#
# Deployment:
#   This file is installed by the doflow CLI and overwritten on update — do
#   not edit an installed copy directly.

set -euo pipefail

# ── State directories ────────────────────────────────────────────────────────

# XDG-compliant, agent-agnostic store shared by Claude Code, Codex, Gemini, etc.
DOFLOW_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/doflow"
STATE_DIR="$DOFLOW_HOME/session-env"
SESSION_DIR="$STATE_DIR/sessions"
PROJECTS_DIR="$STATE_DIR/projects"
# shellcheck disable=SC2034  # used by session-start.sh and session-end.sh which source this file
SESSIONS_LOG="$DOFLOW_HOME/sessions.log"

# Identifies which agent is running. Override via env var for non-Claude agents.
export DOFLOW_AGENT="${DOFLOW_AGENT:-claude-code}"

# ── Portability primitives ───────────────────────────────────────────────────
#
# The helpers in this section replace non-portable GNU/Linux-only dependencies
# (realpath -e, flock, GNU timeout, bare sha256sum) with equivalents that run
# on stock macOS, Git Bash/MSYS2, and common Linux distros without requiring
# any additional package install (no Homebrew coreutils assumed).

# Print an absolute, symlink-resolved form of <path> to stdout when <path>
# exists; otherwise print <path> unchanged. Replaces `realpath -e "$1" ||
# echo "$1"`, which already fails silently on stock macOS (BSD realpath has
# no -e flag) and falls back to an uncanonicalized path. Uses only primitives
# present on every target: cd, pwd -P, dirname, basename.
canonicalize_path() {
  local path="$1"
  if [[ -e "$path" ]]; then
    (cd "$(dirname "$path")" && printf '%s/%s\n' "$(pwd -P)" "$(basename "$path")")
  else
    printf '%s\n' "$path"
  fi
}

# Acquire an exclusive lock on <lockfile>, using atomic mkdir (atomic on
# every filesystem DoFlow runs on, including NTFS via MSYS2). Replaces
# `flock -x -w <seconds> 200`, which is confirmed absent entirely on macOS
# (util-linux only). Gives up after <timeout_seconds> instead of blocking
# indefinitely, returning non-zero on timeout.
#
# Calling convention: the caller acquires the lock, then is responsible for
# releasing it with a matching release_file_lock call — including on
# failure, via trap, so the lock directory is never left stranded:
#
#   if with_file_lock "$lockfile" 5; then
#     trap 'release_file_lock "$lockfile"' RETURN
#     ... guarded section ...
#   else
#     echo "[hooks] timed out waiting for lock: $lockfile" >&2
#   fi
with_file_lock() {
  local lockfile="$1"
  local timeout_seconds="$2"
  local waited=0
  while ! mkdir "$lockfile" 2>/dev/null; do
    if (( waited >= timeout_seconds )); then
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

# Release a lock acquired with with_file_lock.
release_file_lock() {
  local lockfile="$1"
  rmdir "$lockfile" 2>/dev/null || true
}

# Run <command...> (after a literal `--` separator), terminating it if it
# exceeds <seconds>. Replaces a bare dependency on GNU `timeout`, which is
# not installed by default on stock macOS without Homebrew coreutils. When
# neither `timeout` nor `gtimeout` is on PATH, runs <command...> directly
# with no enforced budget (soft safety net, not a correctness requirement).
#
# Usage: run_with_timeout 5 -- some_command --with --args
run_with_timeout() {
  local seconds="$1"
  shift
  if [[ "${1:-}" == "--" ]]; then
    shift
  fi
  if command -v timeout &>/dev/null; then
    timeout "$seconds" "$@"
  elif command -v gtimeout &>/dev/null; then
    gtimeout "$seconds" "$@"
  else
    "$@"
  fi
}

# ── cwd_hash ─────────────────────────────────────────────────────────────────

# Derive a stable 16-char hash of an absolute directory path.
# Used to namespace per-project state (compact summaries, warnings).
# Normalizes symlinks and ../ components so equivalent paths hash identically.
cwd_hash() {
  local canonical
  canonical=$(canonicalize_path "$1")
  if command -v sha256sum &>/dev/null; then
    echo "$canonical" | sha256sum | cut -c1-16
  elif command -v shasum &>/dev/null; then
    echo "$canonical" | shasum -a 256 | cut -c1-16
  else
    echo "$canonical" | cksum | cut -d' ' -f1
  fi
}

# ── Directory helpers ─────────────────────────────────────────────────────────

# Create and return the session-scoped state directory for a given session_id.
# Safe to call multiple times (mkdir -p is idempotent).
ensure_session_dir() {
  local session_id="$1"
  mkdir -p "$SESSION_DIR/$session_id"
  echo "$SESSION_DIR/$session_id"
}

# Create and return the project-scoped state directory for a given cwd.
# Shared across all sessions in the same directory.
ensure_project_dir() {
  local cwd="$1"
  local hash
  hash=$(cwd_hash "$cwd")
  mkdir -p "$PROJECTS_DIR/$hash"
  echo "$PROJECTS_DIR/$hash"
}

# ── JSON helpers ──────────────────────────────────────────────────────────────

# Extract a field from a JSON string.
# Usage: json_field "$INPUT" ".field_name"
# Returns empty string if field is null or jq fails.
json_field() {
  local json="$1"
  local query="$2"
  echo "$json" | jq -r "$query // empty" 2>/dev/null || echo ""
}

# ── Dependency guard ──────────────────────────────────────────────────────────

# Verify jq is available at runtime. If absent, emit a diagnostic to stderr
# and exit 0 (never block Claude Code — degraded operation is preferable to failure).
require_jq() {
  if ! command -v jq &>/dev/null; then
    echo "[hooks] jq not found — install jq to enable session lifecycle hooks (apt install jq / brew install jq)" >&2
    exit 0
  fi
}
