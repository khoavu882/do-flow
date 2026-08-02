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

# Internal: age in whole seconds of <path>'s mtime, or nothing (and a
# non-zero return) if it cannot be determined. Handles both GNU stat
# (-c %Y) and BSD/macOS stat (-f %m) since this file assumes neither.
lock_dir_age_seconds() {
  local path="$1"
  local mtime
  mtime=$(stat -c %Y "$path" 2>/dev/null) || mtime=$(stat -f %m "$path" 2>/dev/null) || return 1
  echo $(( $(date +%s) - mtime ))
}

# A lock dir older than this is presumed abandoned (holder crashed or was
# killed before it could release) and eligible for reclaim. Deliberately
# independent of any given with_file_lock call's own <timeout_seconds>: a
# caller's polling budget is "how long am I willing to wait," which is
# unrelated to "is the current holder still plausibly alive." Reusing
# timeout_seconds for both would let a live holder's lock get stolen out
# from under it the moment a contending caller's own wait approaches its
# timeout — reclaim needs a threshold generous enough that no legitimate
# hook invocation is still running, not tied to a contender's patience.
LOCK_STALE_SECONDS=${LOCK_STALE_SECONDS:-300}

# Acquire an exclusive lock on <lockfile>, using atomic mkdir (atomic on
# every filesystem DoFlow runs on, including NTFS via MSYS2). Replaces
# `flock -x -w <seconds> 200`, which is confirmed absent entirely on macOS
# (util-linux only). Gives up after <timeout_seconds> instead of blocking
# indefinitely, returning non-zero on timeout.
#
# Unlike `flock`, a `mkdir`-based lock has no kernel-backed release on
# holder crash/kill, so this also reclaims the lock directory once it is
# older than LOCK_STALE_SECONDS (treating it as abandoned), and separately
# clears — rather than waits out the full timeout on — a non-directory
# occupying <lockfile>, since a live holder created here always makes a
# directory. That second case matters on upgrade: hosts that ran the old
# `flock -x 200>"$LOCK_FILE"` implementation already have a *regular file*
# at that path, which `mkdir` would otherwise EEXIST against forever.
#
# Calling convention: on success, installs a matching release via an EXIT
# trap (fires on normal exit, on `set -e` abort, and on a killed subshell —
# unlike a RETURN trap, which never fires for a top-level script, only for
# a function return), so the caller does not need to remember to release:
#
#   if with_file_lock "$lockfile" 5; then
#     ... guarded section ...
#   else
#     echo "[hooks] timed out waiting for lock: $lockfile" >&2
#   fi
with_file_lock() {
  local lockfile="$1"
  local timeout_seconds="$2"
  local waited=0 age
  while true; do
    if mkdir "$lockfile" 2>/dev/null; then
      trap 'release_file_lock "'"$lockfile"'"' EXIT
      return 0
    fi
    if [[ -e "$lockfile" && ! -d "$lockfile" ]]; then
      rm -f "$lockfile" 2>/dev/null || true
      continue
    fi
    if [[ -d "$lockfile" ]]; then
      age=$(lock_dir_age_seconds "$lockfile") || age=""
      if [[ -n "$age" ]] && (( age >= LOCK_STALE_SECONDS )); then
        rmdir "$lockfile" 2>/dev/null || true
        continue
      fi
    fi
    if (( waited >= timeout_seconds )); then
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

# Release a lock acquired with with_file_lock. Normally invoked via the
# EXIT trap with_file_lock installs on success; safe to call directly too.
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
# `command -v timeout` is verified to actually be GNU coreutils' `timeout`
# before use: Git Bash inherits the Windows PATH, where `timeout` can
# resolve to System32's interactive delay command instead — a completely
# different, incompatible CLI that would reject our arguments and prevent
# the wrapped command from running at all. `timeout --version` succeeds
# only on the GNU coreutils build; the Windows binary errors on it.
#
# Usage: run_with_timeout 5 -- some_command --with --args
run_with_timeout() {
  local seconds="$1"
  shift
  if [[ "${1:-}" == "--" ]]; then
    shift
  fi
  if command -v timeout &>/dev/null && timeout --version &>/dev/null; then
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
#
# For a path that is (or resolves to) an existing directory — the case this
# function exists for — fully resolves it, including a symlink at the path's
# own leaf component, via `(cd "$1" && pwd -P)`, so equivalent directories
# always hash identically. Callers that ever pass a non-directory or
# nonexistent path fall back to the general-purpose canonicalize_path, which
# — being usable by any file or missing path, not just directories — only
# resolves symlinks in the parent chain, not the leaf itself.
cwd_hash() {
  local canonical
  if [ -d "$1" ]; then
    canonical=$(cd "$1" && pwd -P)
  else
    canonical=$(canonicalize_path "$1")
  fi
  if command -v sha256sum &>/dev/null; then
    echo "$canonical" | sha256sum | cut -c1-16
  elif command -v shasum &>/dev/null; then
    echo "$canonical" | shasum -a 256 | cut -c1-16
  else
    printf '%016x\n' "$(echo "$canonical" | cksum | cut -d' ' -f1)"
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
