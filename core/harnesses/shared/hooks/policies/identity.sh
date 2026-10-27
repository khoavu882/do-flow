#!/usr/bin/env bash
# identity.sh — Canonical Policy Library: session role and identity (feature 078, IC-007, IC-009)
#
# The only definition of doflow_session_role and doflow_identity (DEC-011). policies/lib.sh sources
# it from its own directory; the Claude and Codex hooks/lib.sh copies source it through
# ../../.doflow/shared/hooks/policies/identity.sh.
#
# Sourcing this file defines functions only: it sets no shell option, no variable and no trap, and
# prints nothing. Every function is bash 3.2 safe (no ${var,,}, no associative arrays) and safe
# under the caller's `set -euo pipefail`.

# Sets _DF_ROLE to `main` or `worker` from DOFLOW_SESSION_ROLE, matched case-insensitively, without
# a subshell. Unset or empty is `main`; any other value is `worker` and writes one stderr line, once
# per process (a call inside $(...) cannot mark the parent, so each such call still warns).
_doflow_role_resolve() {
  case "${DOFLOW_SESSION_ROLE:-}" in
    ""|[Mm][Aa][Ii][Nn]) _DF_ROLE=main ;;
    [Ww][Oo][Rr][Kk][Ee][Rr]) _DF_ROLE=worker ;;
    *)
      _DF_ROLE=worker
      if [ -z "${_DF_ROLE_WARNED:-}" ]; then
        echo "[doflow] unknown DOFLOW_SESSION_ROLE; treating session as worker" >&2
        _DF_ROLE_WARNED=1
      fi
      ;;
  esac
  return 0
}

# Print `main` or `worker` for this session, read from DOFLOW_SESSION_ROLE (matched
# case-insensitively). Unset or empty is `main`; a value that is neither `main` nor
# `worker` is `worker` and writes one line to stderr. A worker never writes or claims the
# project's compact summary or warning. Always returns 0. bash 3.2 safe (no ${var,,}).
doflow_session_role() {
  _doflow_role_resolve
  printf '%s\n' "$_DF_ROLE"
  return 0
}

# Record one failure-capture point for the calling policy, never on stdout or stderr. The policy
# name is the running script's name without `.sh` or `.impl.sh`; capture-failure.sh replaces a name
# outside its pattern with `unknown`.
_doflow_identity_capture() {
  local point="$1" policy="${0##*/}" dir
  policy="${policy%.sh}"
  policy="${policy%.impl}"
  # Inside a function, BASH_SOURCE[0] is the file that defined it: this file's directory.
  _DOFLOW_SRC=${BASH_SOURCE[0]//\\//}; case $_DOFLOW_SRC in */*) dir=${_DOFLOW_SRC%/*} ;; *) dir=. ;; esac
  if declare -F doflow_capture_failure >/dev/null 2>&1; then
    ( doflow_capture_failure "$policy" "$point" ) >/dev/null 2>&1 || true
  else
    ( . "$dir/capture-failure.sh" && doflow_capture_failure "$policy" "$point" ) >/dev/null 2>&1 || true
  fi
  return 0
}

# doflow_identity <session_id> <cwd>
# Sets DF_ID_RUN, DF_ID_ATTEMPT, DF_ID_LINEAGE, DF_ID_ROLE, DF_ID_WORKTREE, DF_ID_KIND and
# DF_ID_UNIT per IC-007. Reads only the launcher variables, the payload session_id and cwd; never
# git or the harness's idea of a main session. Built-ins only, except `pwd -P` in a `cd` subshell
# when DOFLOW_WORKTREE is set and `mkdir -p` when a launched unit binds. An invalid run or lineage
# is captured as `identity-invalid` and never reaches a path. Always returns 0.
doflow_identity() {
  local session_id="${1:-}" cwd="${2:-}" LC_ALL=C
  local run="${DOFLOW_RUN_ID:-}" attempt="${DOFLOW_ATTEMPT:-}" lineage="${DOFLOW_LINEAGE_ID:-}"
  local worktree="${DOFLOW_WORKTREE:-}" invalid=0 run_ok=0 lineage_ok=0 attempt_ok=0
  local sessions dir bound="" had_c=0 mine=0 tries

  _doflow_role_resolve
  DF_ID_ROLE=$_DF_ROLE

  # run: id pattern and not `local`; unset is `local`; invalid is unlaunched with lineage solo.
  if [ -z "$run" ]; then
    DF_ID_RUN=local
  elif [ "$run" != local ] && [[ $run =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$ ]]; then
    DF_ID_RUN=$run
    run_ok=1
  else
    DF_ID_RUN=local
    invalid=1
  fi

  # attempt: integer 1 to 9999; invalid is as unset.
  DF_ID_ATTEMPT=""
  if [[ $attempt =~ ^[1-9][0-9]{0,3}$ ]]; then
    DF_ID_ATTEMPT=$attempt
    attempt_ok=1
  fi

  # lineage: id pattern; unset is `main` for main and `solo` for worker; invalid is `solo`.
  if [ -z "$lineage" ]; then
    if [ "$DF_ID_ROLE" = main ]; then DF_ID_LINEAGE=main; else DF_ID_LINEAGE=solo; fi
  elif [[ $lineage =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$ ]]; then
    DF_ID_LINEAGE=$lineage
    lineage_ok=1
  else
    DF_ID_LINEAGE=solo
    invalid=1
  fi
  if [ -n "$run" ] && [ "$run_ok" = 0 ]; then
    DF_ID_LINEAGE=solo
    lineage_ok=0
  fi
  [ "$invalid" = 0 ] || _doflow_identity_capture identity-invalid

  # worktree: an absolute path to an existing directory, canonicalised; otherwise the payload cwd.
  DF_ID_WORKTREE=$cwd
  case "$worktree" in
    /*)
      if [ -d "$worktree" ]; then
        worktree=$(CDPATH= cd -P -- "$worktree" 2>/dev/null && pwd -P) || worktree=""
        [ -z "$worktree" ] || DF_ID_WORKTREE=$worktree
      fi
      ;;
  esac

  if [ "$run_ok" = 1 ] && [ "$lineage_ok" = 1 ] && [ "$attempt_ok" = 1 ]; then
    DF_ID_KIND=launched
    DF_ID_UNIT="L.$DF_ID_RUN.$DF_ID_LINEAGE.$DF_ID_ATTEMPT"
  elif [ "$DF_ID_RUN" = local ] && [ "$DF_ID_LINEAGE" = main ]; then
    # default-main: run unset and lineage main, whether main was defaulted or set explicitly.
    DF_ID_KIND=default-main
    DF_ID_UNIT=$session_id
  else
    DF_ID_KIND=solo
    DF_ID_UNIT=$session_id
  fi

  # Binding (DEC-008, DEC-044): the first session to present a launched unit creates `bound`
  # exclusively; a session whose id differs from the bound one is inherited and gets its own solo
  # unit. A unit that cannot be bound with a session id (store unwritable, `bound` a symlink, which is
  # never followed, or `bound` still empty after one retry) is inherited too. With no session id the
  # unit is solo with an empty unit id and no capture.
  if [ "$DF_ID_KIND" = launched ]; then
    # The store is lib.sh's SESSION_DIR. Sourced without lib.sh, the config-home rule of
    # src/runtime/config-home.ts is applied inline (an absolute XDG_CONFIG_HOME, else an absolute
    # HOME + /.config); with no config home there is no store and the unit is not bound (086 IC-010).
    sessions="${SESSION_DIR:-}"
    # doflow-config-home v1 inline copy: no marked block here, identity.sh defines only its four functions (086 B.2).
    if [ -z "$sessions" ]; then
      case "${XDG_CONFIG_HOME:-}" in
        /*) sessions="$XDG_CONFIG_HOME/doflow/session-env/sessions" ;;
        *) case "${HOME:-}" in /*) sessions="$HOME/.config/doflow/session-env/sessions" ;; esac ;;
      esac
    fi
    dir="${sessions:+$sessions/$DF_ID_UNIT}"
    if [ -n "$session_id" ] && [ -n "$dir" ] && mkdir -p "$dir" 2>/dev/null; then
      case $- in *C*) had_c=1 ;; esac
      set -C
      { printf '%s\n' "$session_id" >"$dir/bound"; } 2>/dev/null && mine=1
      [ "$had_c" = 1 ] || set +C
      if [ "$mine" = 0 ]; then
        # An empty first line may be a concurrent binder between its create and its write.
        for tries in 1 2; do
          [ -f "$dir/bound" ] && [ ! -L "$dir/bound" ] || break
          IFS= read -r bound 2>/dev/null <"$dir/bound" || true
          [ -z "$bound" ] || break
        done
        [ -z "$bound" ] || [ "$bound" != "$session_id" ] || mine=1
      fi
    fi
    if [ "$mine" = 0 ]; then
      DF_ID_KIND=solo
      DF_ID_LINEAGE=solo
      DF_ID_UNIT=$session_id
      if [ -n "$session_id" ] && [ -z "${_DF_ID_INHERITED_CAPTURED:-}" ]; then
        _doflow_identity_capture identity-inherited
        _DF_ID_INHERITED_CAPTURED=1
      fi
    fi
  fi
  return 0
}
