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

# ── canonicalize_path ────────────────────────────────────────────────────────

# Print an absolute, symlink-resolved form of $1 when it exists; otherwise
# print $1 unchanged. Replaces `realpath -e "$1" 2>/dev/null || echo "$1"`,
# which silently falls back to an uncanonicalized path on stock macOS (BSD
# realpath has no -e flag). Uses only primitives present on every target
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

# ── with_file_lock ───────────────────────────────────────────────────────────

# Internal: break in on $1 (a lock directory) if it looks abandoned — its
# recorded owner PID is no longer alive, or it's older than 5x the caller's
# timeout (floored at 30s so short test timeouts don't make legitimately-held
# locks look stale). Best-effort: mkdir-based locking has no kernel-enforced
# ownership the way flock did, so a PID can in principle be reused by an
# unrelated process — the age check is the backstop for that race. The
# guarded section this protects (session-log trimming) tolerates a rare
# double-run; this is a soft safety net against a lock leaking forever after
# its owner is SIGKILLed, not a hard mutual-exclusion guarantee.
_with_file_lock_break_if_stale() {
  local lockfile="$1"
  local timeout_seconds="$2"

  local owner_pid=""
  [ -f "$lockfile/pid" ] && owner_pid=$(cat "$lockfile/pid" 2>/dev/null || true)
  local owner_dead=0
  if [ -n "$owner_pid" ] && ! kill -0 "$owner_pid" 2>/dev/null; then
    owner_dead=1
  fi

  local too_old=0
  local mtime
  mtime=$(stat -f %m "$lockfile" 2>/dev/null || stat -c %Y "$lockfile" 2>/dev/null || echo "")
  if [ -n "$mtime" ]; then
    local max_age=$((timeout_seconds * 5))
    [ "$max_age" -lt 30 ] && max_age=30
    if [ $(($(date +%s) - mtime)) -gt "$max_age" ]; then
      too_old=1
    fi
  fi

  if [ "$owner_dead" -eq 1 ] || [ "$too_old" -eq 1 ]; then
    rm -rf "$lockfile" 2>/dev/null || true
  fi
}

# Acquire a lock via atomic `mkdir` (atomic on every filesystem DoFlow runs
# on, including NTFS via MSYS2) — replaces `flock -x -w 5 200`, which is
# util-linux-only and confirmed absent entirely on macOS.
#
# Usage: call to acquire, run the guarded section in the same shell/subshell,
# then call again with "release" to release. The lock is also released
# automatically on exit (normal or error) via an EXIT trap, so a crashed or
# early-exiting guarded section never leaves the lock held.
#
#   if with_file_lock "$LOCK_FILE" 5; then
#     ...guarded section...
#     with_file_lock "$LOCK_FILE" release
#   fi
#
# Returns 1 (without acquiring the lock) if timeout_seconds elapses first.
# A lock whose owner process is gone, or that has sat far longer than the
# caller's own timeout, is treated as abandoned and broken into rather than
# waited out (see _with_file_lock_break_if_stale) — a `flock`-held lock was
# always released by the kernel on process death; a bare `mkdir` lock is not,
# so this replaces that guarantee instead of silently dropping it.
#
# Any EXIT trap the caller already had installed (e.g. its own temp-file
# cleanup) is preserved: it still runs at real process exit (after this
# lock's own cleanup), and is still armed as the active EXIT trap after an
# explicit "release" call — acquiring/releasing this lock never discards it.
with_file_lock() {
  local lockfile="$1"
  local arg="$2"

  if [ "$arg" = "release" ]; then
    rm -f "$lockfile/pid" 2>/dev/null || true
    rmdir "$lockfile" 2>/dev/null || true
    if [ -n "${_DOFLOW_LOCK_PREV_TRAP:-}" ]; then
      eval "$_DOFLOW_LOCK_PREV_TRAP"
    else
      trap - EXIT
    fi
    unset _DOFLOW_LOCK_PREV_TRAP
    return 0
  fi

  local timeout_seconds="$arg"
  local waited=0
  while ! mkdir "$lockfile" 2>/dev/null; do
    _with_file_lock_break_if_stale "$lockfile" "$timeout_seconds"
    if [ "$waited" -ge "$timeout_seconds" ]; then
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "$$" >"$lockfile/pid" 2>/dev/null || true

  # Capture the caller's existing EXIT trap (if any) so releasing this lock
  # can restore it verbatim, and so real process exit runs both this lock's
  # cleanup and the caller's original cleanup rather than only the latest
  # one registered.
  _DOFLOW_LOCK_PREV_TRAP=$(trap -p EXIT)
  local prev_cmd=""
  if [ -n "$_DOFLOW_LOCK_PREV_TRAP" ]; then
    local prev_body="${_DOFLOW_LOCK_PREV_TRAP#trap -- }"
    prev_body="${prev_body% EXIT}"
    eval "prev_cmd=$prev_body"
  fi
  # shellcheck disable=SC2064  # intentional immediate expansion of $lockfile/$prev_cmd
  trap "rm -f '$lockfile/pid' 2>/dev/null; rmdir '$lockfile' 2>/dev/null; $prev_cmd" EXIT
  return 0
}

# ── run_with_timeout ─────────────────────────────────────────────────────────

# Run <command...> and terminate it if it exceeds <seconds>. Replaces bare
# GNU `timeout` calls, which are not installed by default on stock macOS
# without Homebrew coreutils. When neither a verified-GNU `timeout` nor
# `gtimeout` (the Homebrew coreutils name) is on PATH, runs the command
# directly with no enforced budget — a soft safety net, not a correctness
# requirement.
#
# `timeout` is not trusted just because something by that name is on PATH:
# on Git Bash/MSYS2, PATH can resolve it to Windows' native
# `System32\timeout.exe`, whose syntax (`timeout /T n`) is incompatible —
# invoking it the GNU way would fail the command outright instead of just
# running it unbounded. `timeout --version` is a cheap, side-effect-free way
# to confirm it's the GNU coreutils build before trusting it (Windows'
# timeout.exe doesn't understand --version and errors).
#
# Usage: run_with_timeout <seconds> -- <command...>
run_with_timeout() {
  local seconds="$1"
  shift
  if [ "${1:-}" = "--" ]; then
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
#
# For a path that is (or resolves to) an existing directory — the case this
# function exists for — fully resolves it, including a symlink at the path's
# own leaf component, via `(cd "$1" && pwd -P)`, so equivalent directories
# always hash identically. Callers that ever pass a non-directory or
# nonexistent path fall back to the general-purpose canonicalize_path, which
# — being usable by any file or missing path, not just directories — only
# resolves symlinks in the parent chain, not the leaf itself.
#
# Hash fallback chain: sha256sum -> shasum -a 256 -> cksum (last resort).
# The cksum branch is normalized via printf '%016x' to the same 16-char
# hex contract every other branch provides — raw cksum output is a decimal
# CRC, not hex, and not guaranteed to be 16 characters. Collision risk from
# the cksum fallback is acceptable here — this is only a cache-key
# namespace, not security-relevant.
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
