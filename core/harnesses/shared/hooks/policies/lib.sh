#!/usr/bin/env bash
# lib.sh — shared constants and helpers for the Canonical Policy Library
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
#
# Consolidation note (022-normalize-hooks, Phase B): this is the single
# canonical copy every front door's dispatched policy script sources — the
# claude/gemini/kiro/codex copies it replaces were already byte-identical
# except for one Claude-only default (see DOFLOW_AGENT below), confirmed via
# diff before consolidating.

set -euo pipefail

# ── State directories ────────────────────────────────────────────────────────

# XDG-compliant, agent-agnostic store shared by every harness DoFlow supports.
DOFLOW_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/doflow"
STATE_DIR="$DOFLOW_HOME/session-env"
SESSION_DIR="$STATE_DIR/sessions"
PROJECTS_DIR="$STATE_DIR/projects"
# shellcheck disable=SC2034  # used by session-context.sh and stop-check.sh which source this file
SESSIONS_LOG="$DOFLOW_HOME/sessions.log"

# Identifies which harness is running. A front door sets this before sourcing
# this file (e.g. `export DOFLOW_AGENT=gemini; exec bash .../policies/...sh`);
# "unknown" here — not any one harness's name — is the honest fallback when a
# front door omits it, since every prior per-harness copy of this file
# defaulted to "claude-code" regardless of which harness actually shipped it.
export DOFLOW_AGENT="${DOFLOW_AGENT:-unknown}"

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
# For a path that is (or resolves to) an existing directory — the case this
# function exists for — fully resolves it, including a symlink at the path's
# own leaf component, via `(cd "$1" && pwd -P)`, so equivalent directories
# always hash identically. Callers that ever pass a non-directory or
# nonexistent path fall back to the general-purpose canonicalize_path, which
# — being usable by any file or missing path, not just directories — only
# resolves symlinks in the parent chain, not the leaf itself.
#
# Hash fallback chain: sha256sum (Linux, Git Bash) -> shasum -a 256 (macOS,
# every release since 10.6) -> cksum (last resort). The cksum branch is
# normalized via printf '%016x' to the same 16-lowercase-hex-char contract
# every other branch provides (raw cksum output is decimal and shorter).
# Collision risk from the cksum fallback is acceptable here — this is only a
# cache-key namespace, not security-relevant.
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

# ── Git state helpers ────────────────────────────────────────────────────────
#
# Thin wrappers around `git -C <cwd> ...` with the project's standard 1s
# timeout. Each echoes git's own output (or nothing/0 on failure) and leaves
# stderr suppressed — callers keep their own `|| echo <fallback>` around a
# call for a script-specific default, exactly as the inline git calls these
# replace did (022-hooks-remaining-duplication: the same 4 invocations were
# duplicated verbatim across pre-compact.sh/session-end.sh/session-context.sh).

is_git_worktree() {
  run_with_timeout 1 -- git -C "$1" rev-parse --is-inside-work-tree &>/dev/null
}

git_branch_of() {
  run_with_timeout 1 -- git -C "$1" branch --show-current 2>/dev/null
}

git_short_sha_of() {
  run_with_timeout 1 -- git -C "$1" rev-parse --short HEAD 2>/dev/null
}

git_uncommitted_count_of() {
  run_with_timeout 1 -- git -C "$1" status --porcelain 2>/dev/null | wc -l | tr -d ' '
}

has_uncommitted_changes() {
  run_with_timeout 1 -- git -C "$1" status --porcelain 2>/dev/null | grep -q .
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
# and exit 0 (never block the harness — degraded operation is preferable to
# failure).
require_jq() {
  if ! command -v jq &>/dev/null; then
    echo "[hooks] jq not found — install jq to enable session lifecycle hooks (apt install jq / brew install jq)" >&2
    exit 0
  fi
}

# ── Prompt nudge gate helpers ────────────────────────────────────────────────
#
# Used by user-prompt-submit.sh for the once-per-session `/do` suggestion. Function
# definitions only: no top-level statement, no `set`, no `trap`. Each is safe under
# the `set -euo pipefail` above, bash 3.2 and BSD tools. The first four start no
# process; none of them reads the prompt. A probe that cannot decide returns
# non-zero, and the caller treats that as "no nudge".

# Print the nearest ancestor of <cwd> (itself included) holding a `.git` entry — a
# directory, or the file a linked worktree and a submodule have — else <cwd>.
nudge_repo_root() {
  local dir="${1%/}"
  [ -n "$dir" ] || { printf '%s\n' "$1"; return 0; }
  while [ -n "$dir" ]; do
    if [ -e "$dir/.git" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
    dir="${dir%/*}"
  done
  printf '%s\n' "${1%/}"
}

# Print `on` or `off`. The project file <root>/.doflow/prompt-nudge wins, then the
# user file <DoFlow home>/prompt-nudge; neither present is `on`. A present file
# decides alone: its first line trimmed and lowercased must be `on` or `off`, and a
# file that cannot be read, is empty or holds anything else is `off`.
nudge_setting() {
  local root="${1:-}" file line=""
  for file in "${root:+$root/.doflow/prompt-nudge}" "$DOFLOW_HOME/prompt-nudge"; do
    [ -n "$file" ] && [ -e "$file" ] || continue
    line=""
    { IFS= read -r line || true; } 2>/dev/null < "$file" || line=""
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in
      [Oo][Nn]) printf 'on\n' ;;
      *) printf 'off\n' ;;
    esac
    return 0
  done
  printf 'on\n'
}

# Succeed when <id> is a safe session id: 1 to 128 of [A-Za-z0-9._-], first one
# alphanumeric. No process.
nudge_safe_id() {
  local LC_ALL=C
  local id="${1:-}"
  [ -n "$id" ] && [ "${#id}" -le 128 ] || return 1
  case "$id" in
    [!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) return 1 ;;
  esac
  return 0
}

# Print the marker path for a session id. The caller checks nudge_safe_id first.
nudge_marker_file() {
  printf '%s\n' "$STATE_DIR/nudge/$1"
}

# Create the marker for <id> holding <nudged|suppressed>. Succeeds only when this call
# created it: the create is exclusive, so a second call for the same id fails and
# leaves the first content. After a create, markers untouched for over 30 days are
# removed. Silent on every failure.
nudge_mark() {
  local id="${1:-}" word="${2:-}" dir="$STATE_DIR/nudge" file
  nudge_safe_id "$id" || return 1
  case "$word" in nudged|suppressed) ;; *) return 1 ;; esac
  file="$dir/$id"
  mkdir -p "$dir" 2>/dev/null || return 1
  ( set -o noclobber; : > "$file" ) 2>/dev/null || return 1
  printf '%s\n' "$word" > "$file" 2>/dev/null || true
  find "$dir" -type f -mtime +30 -delete 2>/dev/null || true
  return 0
}

# S2: succeed when the active branch has chain artifacts at <root>/agent-docs/doflow/<slug>
# (slug = the branch after its last `/`). <session_path> is the per-session folder; the
# branch is the one its git-context.json recorded, else the one git reports for <cwd>.
# The branches main, master, develop, trunk, HEAD and the empty one never fire.
nudge_feature_active() {
  local cwd="${1:-}" root="${2:-}" session="${3:-}" branch="" slug
  [ -n "$root" ] || return 1
  if [ -n "$session" ] && [ -f "$session/git-context.json" ]; then
    branch=$(jq -r 'if (.branch | type) == "string" then "B:" + .branch else empty end' \
      "$session/git-context.json" 2>/dev/null) || branch=""
  fi
  if [ -n "$branch" ]; then
    branch="${branch#B:}"
  elif [ -n "$cwd" ]; then
    branch=$(git_branch_of "$cwd" 2>/dev/null) || branch=""
  fi
  case "$branch" in ""|main|master|develop|trunk|HEAD) return 1 ;; esac
  slug="${branch##*/}"
  case "$slug" in ""|.|..) return 1 ;; esac
  [ -d "$root/agent-docs/doflow/$slug" ]
}

# S3: succeed when a `/do-*` skill already ran this session, read from the run ledger:
# the lexically last <config>/state/runs/*.jsonl, whose last line's timestamp is not
# earlier than the session's captured_at (both YYYY-MM-DDTHH:MM:SSZ). Config dir:
# $DOFLOW_CONFIG_DIR, else the nearest `.doflow` at or above <cwd>, else $HOME/.doflow.
# Without a captured_at the ledger counts when it is named for today's UTC date; a last
# line without a usable timestamp counts too. No ledger, or an empty one, does not.
nudge_ledger_active() {
  local LC_ALL=C
  local cwd="${1:-}" session="${2:-}" config dir f ledger="" last ts captured="" tsre
  tsre='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
  if [ -n "${DOFLOW_CONFIG_DIR:-}" ]; then
    config="$DOFLOW_CONFIG_DIR"
  else
    config="$HOME/.doflow"
    dir="${cwd%/}"
    while [ -n "$dir" ]; do
      if [ -d "$dir/.doflow" ]; then config="$dir/.doflow"; break; fi
      dir="${dir%/*}"
    done
  fi
  for f in "$config"/state/runs/*.jsonl; do
    [ -f "$f" ] && ledger="$f"
  done
  [ -n "$ledger" ] && [ -s "$ledger" ] || return 1
  if [ -n "$session" ] && [ -f "$session/git-context.json" ]; then
    captured=$(jq -r '.captured_at // empty | strings' "$session/git-context.json" 2>/dev/null) || captured=""
  fi
  last=$(tail -n 1 "$ledger" 2>/dev/null) || last=""
  ts=$(printf '%s' "$last" | jq -r '.timestamp // empty | strings' 2>/dev/null) || ts=""
  [[ "$ts" =~ $tsre ]] || return 0
  if [[ "$captured" =~ $tsre ]]; then
    [[ ! "$ts" < "$captured" ]]
  else
    [ "${ledger##*/}" = "$(date -u +%Y-%m-%d).jsonl" ]
  fi
}

# Print the workflow registry's path: <policy_dir> is the physical directory of the
# policy script (empty when unknown), <root> the repository root. First existing
# regular file of IC-006's list wins: the install copy, the source tree's, the
# project's install, the global install. Fails when none exists.
nudge_registry() {
  local policy_dir="${1:-}" root="${2:-}" candidate
  for candidate in \
    "${policy_dir:+$policy_dir/../../../runtime/core/registry/workflows.json}" \
    "${policy_dir:+$policy_dir/../../../../registry/workflows.json}" \
    "${root:+$root/.doflow/runtime/core/registry/workflows.json}" \
    "$HOME/.doflow/runtime/core/registry/workflows.json"; do
    if [ -n "$candidate" ] && [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}
