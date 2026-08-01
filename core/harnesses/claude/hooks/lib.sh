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
#
# Hardening notes:
#   - `CDPATH=` resets CDPATH for the internal `cd` so a user's exported
#     CDPATH can't redirect it to an unrelated directory of the same name
#     (and can't make `cd` echo a stray "found via CDPATH" line to stdout).
#   - `--` guards `dirname`/`basename`/`cd` against a path that begins with
#     `-` being parsed as an option.
#   - if the internal `cd` fails for any reason, `||` falls through to the
#     uncanonicalized-path branch instead of aborting under this file's
#     `set -e` (matching the old `realpath ... || echo "$1"` degrade path).
#   - a root-level parent directory ("/") is special-cased so the result
#     never gets a leading `//`, which POSIX leaves undefined and which
#     Cygwin/MSYS2 (a DoFlow target platform) interprets as a UNC path.
canonicalize_path() {
  local path="$1" dir base
  if [[ -e "$path" ]] \
    && dir=$(CDPATH= cd -P -- "$(dirname -- "$path")" 2>/dev/null && pwd -P); then
    base=$(basename -- "$path")
    if [[ "$dir" == "/" ]]; then
      printf '/%s\n' "$base"
    else
      printf '%s/%s\n' "$dir" "$base"
    fi
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
#
# Stale-lock recovery: unlike `flock`, an `mkdir` lock is not released
# automatically if the holder is killed or crashes — a leftover lockdir
# would otherwise wedge every future acquisition permanently. To guard
# against that, the holder's PID is written to "<lockfile>.d/pid" at
# acquire time; when this function finds the lockdir already taken, it
# checks whether that PID is still alive (`kill -0`) and, if not, treats
# the lock as abandoned and reclaims it immediately instead of waiting out
# the full timeout. This is a best-effort check (a PID can in principle be
# reused by an unrelated process before we look), not a hard guarantee —
# acceptable here because the guarded sections this protects are idempotent
# log/state maintenance, not a correctness-critical resource.
with_file_lock() {
  local lockfile="$1"
  local timeout_seconds="$2"
  local lockdir="${lockfile}.d"
  local pidfile="${lockdir}/pid"
  local waited=0 holder_pid
  while true; do
    if mkdir "$lockdir" 2>/dev/null; then
      echo "$$" >"$pidfile" 2>/dev/null || true
      return 0
    fi
    # Someone else holds the lock (or a stale one was left behind) — check
    # whether the recorded holder is still alive before waiting on it.
    holder_pid=$(cat "$pidfile" 2>/dev/null || echo "")
    if [[ -n "$holder_pid" ]] && ! kill -0 "$holder_pid" 2>/dev/null; then
      rm -rf "$lockdir" 2>/dev/null || true
      continue
    fi
    if (( waited >= timeout_seconds )); then
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

# Companion release for with_file_lock. Idempotent — safe to call even if
# the lock was never acquired or was already released.
release_file_lock() {
  local lockfile="$1"
  local lockdir="${lockfile}.d"
  rm -f "${lockdir}/pid" 2>/dev/null || true
  rmdir "$lockdir" 2>/dev/null || true
}

# ── run_with_timeout ─────────────────────────────────────────────────────────

# Run <command...>, terminating it if it exceeds <seconds>. When no
# GNU-compatible timeout-enforcing binary (`timeout`/`gtimeout`) is on
# PATH — stock macOS lacks GNU coreutils' `timeout` unless Homebrew is
# installed — runs <command...> directly with no enforced budget rather
# than failing (a soft safety net, not a correctness requirement; NFR-002
# forbids requiring a new dependency).
#
# GNU-ness check: on Git Bash, PATH includes Windows' System32, which ships
# its own `timeout.exe` — an interactive countdown/delay command with
# incompatible syntax, not GNU coreutils' `timeout`. If it resolved first
# and were trusted blindly, `timeout 5 git status` would fail on argument
# parsing and the wrapped command would never run at all — strictly worse
# than the no-timeout-found fallback below. So a candidate binary is only
# trusted after `<bin> --version` succeeds (GNU coreutils understands
# `--version`; Windows' `timeout.exe` does not and errors out), otherwise
# the next candidate is tried and, failing that, the command runs directly.
#
# Usage: run_with_timeout 5 -- git status
run_with_timeout() {
  local seconds="$1"
  shift
  if [[ "${1:-}" == "--" ]]; then
    shift
  fi
  local timeout_bin=""
  if command -v timeout &>/dev/null && timeout --version >/dev/null 2>&1; then
    timeout_bin="timeout"
  elif command -v gtimeout &>/dev/null && gtimeout --version >/dev/null 2>&1; then
    timeout_bin="gtimeout"
  fi
  if [[ -n "$timeout_bin" ]]; then
    "$timeout_bin" "$seconds" "$@"
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
