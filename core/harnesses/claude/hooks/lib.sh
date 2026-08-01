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

# ── canonicalize_path ─────────────────────────────────────────────────────────

# Print an absolute, symlink-resolved form of <path> to stdout when <path>
# exists; otherwise print <path> unchanged.
#
# Replaces `realpath -e "$1" 2>/dev/null || echo "$1"`, which already fails
# silently on stock macOS (BSD realpath has no -e flag there) and falls back
# to an uncanonicalized path. Uses only primitives present on every target
# (cd, pwd -P, dirname, basename) — no GNU-only flag, no assumed Homebrew
# coreutils.
canonicalize_path() {
  local path="$1"
  if [[ -e "$path" ]]; then
    (cd "$(dirname "$path")" && printf '%s/%s\n' "$(pwd -P)" "$(basename "$path")")
  else
    printf '%s\n' "$path"
  fi
}

# ── cwd_hash ─────────────────────────────────────────────────────────────────

# Derive a stable 16-char hash of an absolute directory path.
# Used to namespace per-project state (compact summaries, warnings).
# Normalizes symlinks and ../ components so equivalent paths hash identically.
#
# Hash fallback chain: sha256sum (Linux, Git Bash) -> shasum -a 256 (macOS,
# every release since 10.6) -> cksum (last resort). Collision risk from the
# cksum fallback is acceptable here — this is only a cache-key namespace, not
# security-relevant.
cwd_hash() {
  local canonical
  canonical=$(canonicalize_path "$1")
  if command -v sha256sum &>/dev/null; then
    echo "$canonical" | sha256sum | cut -c1-16
  elif command -v shasum &>/dev/null; then
    echo "$canonical" | shasum -a 256 | cut -c1-16
  else
    echo "$canonical" | cksum | tr -d ' \t' | cut -c1-16
  fi
}

# ── with_file_lock / release_file_lock ────────────────────────────────────────

# Cross-platform mutual exclusion via atomic `mkdir` (atomic on every
# filesystem DoFlow runs on, including NTFS via MSYS2). Replaces
# `flock -x -w 5 200`, which is entirely absent on stock macOS (util-linux
# only, causing the session-end log-trimming block to silently no-op today).
#
# Usage (caller acquires, then is responsible for releasing — including on
# failure paths, ideally via `trap`):
#
#   if with_file_lock "$LOCK_FILE" 5; then
#     trap 'release_file_lock "$LOCK_FILE"' EXIT
#     ...critical section...
#     release_file_lock "$LOCK_FILE"
#   fi
#
# Polls for the lock (creating "<lockfile>.d" as the lock token) until
# acquired or until <timeout_seconds> elapses. Returns 0 once acquired
# (lock held), or 1 on timeout — callers should treat a timeout the same
# way the old `flock -w 5 200 || exit 0` did: skip the guarded section
# rather than block indefinitely.
with_file_lock() {
  local lockfile="$1"
  local timeout_seconds="$2"
  local lockdir="${lockfile}.d"
  local waited=0
  while ! mkdir "$lockdir" 2>/dev/null; do
    if (( waited >= timeout_seconds )); then
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 0
}

# Companion release for with_file_lock. Idempotent — safe to call even if
# the lock was never acquired or was already released.
release_file_lock() {
  local lockfile="$1"
  rmdir "${lockfile}.d" 2>/dev/null || true
}

# ── run_with_timeout ─────────────────────────────────────────────────────────

# Run <command...>, terminating it if it exceeds <seconds>. When no
# timeout-enforcing binary (`timeout`/`gtimeout`) is on PATH — stock macOS
# lacks GNU coreutils' `timeout` unless Homebrew is installed — runs
# <command...> directly with no enforced budget rather than failing (a soft
# safety net, not a correctness requirement; NFR-002 forbids requiring a new
# dependency).
#
# Usage: run_with_timeout 5 -- git status
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
