#!/usr/bin/env bash
# summary-store.sh — Canonical Policy Library: scoped compact summaries, grants and the legacy
# adopter (feature 078, IC-010, IC-011 store write, IC-012, IC-014; DEC-003, DEC-012, DEC-014).
#
# Layout under STATE_DIR (${XDG_CONFIG_HOME:-$HOME/.config}/doflow/session-env):
#   summaries/<worktreeKey>/<run>/<lineage>/summary.md            one pending summary per scope
#   summaries/<worktreeKey>/<run>/<lineage>/.summary.XXXXXX       write temporary
#   summaries/<worktreeKey>/<run>/<lineage>/.claimed.<unitId>     claim temporary
#   grants/<run>/<lineage>/<summaryId>.md                         grant addressed to a recipient
#   grants/<run>/<lineage>/.claimed.<unitId>.<summaryId>          claim temporary
# worktreeKey is cwd_hash of the identity worktree (DEC-027), so the caller must have sourced
# lib.sh, which defines cwd_hash, STATE_DIR and PROJECTS_DIR.
#
# Sourcing this file defines functions only: no option, no variable, no trap, no output. bash 3.2
# safe and safe under the caller's `set -euo pipefail`. Peek functions always return 0; write,
# claim and adopt return 0 when they did their work and 1 otherwise, so call them from `if` or
# with `||`. Results are DF_SUMMARY_* and DF_GRANT_* variables. A claimed file is left in place for
# the caller to pass to emission.jq (--rawfile summary or grant) and to remove after rendering.

# The id pattern of IC-007 (DEC-024) and the summary id pattern of IC-010.
_doflow_ss_id_ok() { [[ ${1:-} =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$ ]]; }
_doflow_ss_summary_id_ok() { [[ ${1:-} =~ ^s-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9]{6}$ ]]; }
# A unit id (L.<run>.<lineage>.<attempt> or a harness session id) is one path segment.
_doflow_ss_unit_ok() { [[ ${1:-} =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; }

_doflow_ss_root() {
  _DF_SS_ROOT="${STATE_DIR:-${XDG_CONFIG_HOME:-${HOME:-}/.config}/doflow/session-env}"
  return 0
}

# _doflow_ss_key <dir>: _DF_SS_KEY = cwd_hash <dir>, remembered for the last directory asked.
_doflow_ss_key() {
  if [ -n "${_DF_SS_KEY_FOR:-}" ] && [ "$_DF_SS_KEY_FOR" = "$1" ] && [ -n "${_DF_SS_KEY:-}" ]; then
    return 0
  fi
  _DF_SS_KEY=""
  _DF_SS_KEY_FOR=""
  [ -n "$1" ] || return 1
  declare -F cwd_hash >/dev/null 2>&1 || return 1
  _DF_SS_KEY=$(cwd_hash "$1" 2>/dev/null) || _DF_SS_KEY=""
  [[ $_DF_SS_KEY =~ ^[0-9a-f]{16}$ ]] || { _DF_SS_KEY=""; return 1; }
  _DF_SS_KEY_FOR=$1
  return 0
}

# doflow_summary_scope <worktree> <run> <lineage>
# DF_SUMMARY_SCOPE = summaries/<worktreeKey>/<run>/<lineage>, or empty (return 1) when run or
# lineage is not an id, or the lineage is `solo`, which has no scope directory.
doflow_summary_scope() {
  DF_SUMMARY_SCOPE=""
  _doflow_ss_id_ok "${2:-}" && _doflow_ss_id_ok "${3:-}" && [ "$3" != solo ] || return 1
  _doflow_ss_key "${1:-}" || return 1
  _doflow_ss_root
  DF_SUMMARY_SCOPE="$_DF_SS_ROOT/summaries/$_DF_SS_KEY/$2/$3"
  return 0
}

# _doflow_ss_head <file>: reads the frontmatter the way emission.jq's parse_record does (\r removed,
# fields between the first two `---` lines, first match wins, leading spaces of a value dropped),
# never more than 65536 bytes. Sets _DF_SS_SESSION, _DF_SS_SID, and for the grant header
# _DF_SS_FROM (from_lineage), _DF_SS_AT (compacted_at) and _DF_SS_BRANCH (branch).
_doflow_ss_head() {
  local LC_ALL=C line="" left=65536 fences=0 key value seen=" "
  _DF_SS_SESSION=""
  _DF_SS_SID=""
  _DF_SS_FROM=""
  _DF_SS_AT=""
  _DF_SS_BRANCH=""
  {
    while [ "$left" -gt 0 ] && [ "$fences" -lt 2 ]; do
      IFS= read -r -n "$left" line || [ -n "$line" ] || break
      left=$((left - ${#line} - 1))
      line=${line//$'\r'/}
      if [ "$line" = "---" ]; then
        fences=$((fences + 1))
      elif [ "$fences" = 1 ] && [[ $line == ?*:* ]]; then
        key=${line%%:*}
        value=${line#*:}
        while [ "${value# }" != "$value" ]; do value=${value# }; done
        # The first match of a key wins: a wanted key is recorded in $seen once it is read.
        case "$key" in
          session_id | summary_id | from_lineage | compacted_at | branch)
            case "$seen" in *" $key "*) key="" ;; esac ;;
          *) key="" ;;
        esac
        case "$key" in
          session_id) _DF_SS_SESSION=$value ;;
          summary_id) _DF_SS_SID=$value ;;
          from_lineage) _DF_SS_FROM=$value ;;
          compacted_at) _DF_SS_AT=$value ;;
          branch) _DF_SS_BRANCH=$value ;;
        esac
        [ -z "$key" ] || seen="$seen$key "
      fi
      line=""
    done
  } <"$1" 2>/dev/null || true
  return 0
}

# _doflow_ss_body_bytes <file>: _DF_SS_BODY = the UTF-8 byte length of the record body exactly as
# parse_record yields it (\r removed, from the first non-empty line after the second `---`,
# trailing newlines dropped). The caller has bounded the file's size.
_doflow_ss_body_bytes() {
  local LC_ALL=C line="" fences=0 started=0 gap=0
  _DF_SS_BODY=0
  {
    while IFS= read -r line || [ -n "$line" ]; do
      line=${line//$'\r'/}
      if [ "$fences" -lt 2 ]; then
        [ "$line" != "---" ] || fences=$((fences + 1))
      elif [ -z "$line" ]; then
        [ "$started" = 0 ] || gap=$((gap + 1))
      elif [ "$started" = 0 ]; then
        started=1
        _DF_SS_BODY=${#line}
      else
        _DF_SS_BODY=$((_DF_SS_BODY + gap + 1 + ${#line}))
        gap=0
      fi
      line=""
    done
  } <"$1" 2>/dev/null || true
  return 0
}

# _doflow_ss_size <file>: _DF_SS_SIZE = the file's size in bytes, or empty.
_doflow_ss_size() {
  _DF_SS_SIZE=$(wc -c <"$1" 2>/dev/null) || _DF_SS_SIZE=""
  _DF_SS_SIZE=${_DF_SS_SIZE//[!0-9]/}
  return 0
}

# doflow_summary_write <worktree> <run> <lineage> <attempt> <compacted_at> <session_id> <trigger>
#                      <branch> <role> <body>
# IC-011 step 3: mkdir -p the scope, mktemp .summary.XXXXXX in it, write the IC-010 record, mv it to
# summary.md (a newer compaction replaces the pending one). compacted_at is UTC ISO-8601 to the
# second (YYYY-MM-DDTHH:MM:SSZ). Sets DF_SUMMARY_ID and DF_SUMMARY_PATH. Returns 1 with nothing left
# behind on an invalid argument, an empty body or a failed step.
doflow_summary_write() {
  local worktree="${1:-}" run="${2:-}" lineage="${3:-}" attempt="${4:-}" at="${5:-}"
  local session="${6:-}" trigger="${7:-}" branch="${8:-}" role="${9:-}" body="${10:-}"
  local tmp="" stamp suffix nl=$'\n' cr=$'\r'
  DF_SUMMARY_ID=""
  DF_SUMMARY_PATH=""
  [ -n "$body" ] || return 1
  [[ $at =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
  [ -z "$attempt" ] || [[ $attempt =~ ^[1-9][0-9]{0,3}$ ]] || return 1
  doflow_summary_scope "$worktree" "$run" "$lineage" || return 1
  # A frontmatter value is one line: an embedded line break would forge a key.
  session=${session//[$nl$cr]/ }; trigger=${trigger//[$nl$cr]/ }; branch=${branch//[$nl$cr]/ }
  role=${role//[$nl$cr]/ }; worktree=${worktree//[$nl$cr]/ }
  mkdir -p "$DF_SUMMARY_SCOPE" 2>/dev/null || return 1
  tmp=$(mktemp "$DF_SUMMARY_SCOPE/.summary.XXXXXX" 2>/dev/null) || return 1
  suffix=${tmp##*.summary.}
  stamp=${at//[-:]/}
  DF_SUMMARY_ID="s-$stamp-$suffix"
  if ! _doflow_ss_summary_id_ok "$DF_SUMMARY_ID" \
    || ! printf -- '---\ncompacted_at: %s\nsession_id: %s\ntrigger: %s\nbranch: %s\nrole: %s\nsummary_id: %s\nrun: %s\nlineage: %s\nattempt:%s\nworktree: %s\n---\n\n%s\n' \
      "$at" "${session:-unknown}" "${trigger:-unknown}" "${branch:-unknown}" "${role:-main}" \
      "$DF_SUMMARY_ID" "$run" "$lineage" "${attempt:+ $attempt}" "$worktree" "$body" >"$tmp" 2>/dev/null \
    || ! mv -f "$tmp" "$DF_SUMMARY_SCOPE/summary.md" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    DF_SUMMARY_ID=""
    return 1
  fi
  DF_SUMMARY_PATH="$DF_SUMMARY_SCOPE/summary.md"
  return 0
}

# doflow_summary_peek <worktree> <run> <lineage> <session_id>
# IC-012 owner steps 1 and 2, for the state vector: DF_SUMMARY_OWN is `none` (no regular,
# non-symlink summary.md in the scope), `own-write` (its frontmatter session_id is this session's)
# or `pending`; DF_SUMMARY_FILE is its path when not `none`. Always returns 0.
doflow_summary_peek() {
  local f
  DF_SUMMARY_OWN=none
  DF_SUMMARY_FILE=""
  doflow_summary_scope "${1:-}" "${2:-}" "${3:-}" || return 0
  f="$DF_SUMMARY_SCOPE/summary.md"
  [ -f "$f" ] && [ ! -L "$f" ] || return 0
  _doflow_ss_head "$f"
  DF_SUMMARY_FILE=$f
  if [ -n "${4:-}" ] && [ "$_DF_SS_SESSION" = "$4" ]; then DF_SUMMARY_OWN=own-write; else DF_SUMMARY_OWN=pending; fi
  return 0
}

# doflow_summary_claim <worktree> <run> <lineage> <unit_id> <session_id>
# IC-012 owner steps 1 to 3: peek, then rename summary.md to .claimed.<unitId>; a summary written
# after the rename is a new summary.md and survives. The claimed copy is cut to its first 65536
# bytes. Sets DF_SUMMARY_OWN (as peek, `none` after a lost rename), DF_SUMMARY_CLAIMED (the claimed
# path, for --rawfile summary) and DF_SUMMARY_BYTES (its full size before the cut, for
# plan.summaryBytes). Returns 0 when this caller claimed it; the caller removes the claimed file.
doflow_summary_claim() {
  local unit="${4:-}" claimed
  DF_SUMMARY_CLAIMED=""
  DF_SUMMARY_BYTES=0
  doflow_summary_peek "${1:-}" "${2:-}" "${3:-}" "${5:-}"
  [ "$DF_SUMMARY_OWN" = pending ] || return 1
  _doflow_ss_unit_ok "$unit" || return 1
  claimed="$DF_SUMMARY_SCOPE/.claimed.$unit"
  if ! mv "$DF_SUMMARY_FILE" "$claimed" 2>/dev/null; then
    DF_SUMMARY_OWN=none
    return 1
  fi
  _doflow_ss_size "$claimed"
  DF_SUMMARY_BYTES=${_DF_SS_SIZE:-0}
  if [ "$DF_SUMMARY_BYTES" -gt 65536 ]; then
    if ! { head -c 65536 "$claimed" >"$claimed.read" 2>/dev/null && mv -f "$claimed.read" "$claimed" 2>/dev/null; }; then
      rm -f "$claimed" "$claimed.read" 2>/dev/null || true
      return 1
    fi
  fi
  DF_SUMMARY_CLAIMED=$claimed
  return 0
}

# _doflow_ss_known <value>: _DF_SS_KNOWN = emission.jq's `known`: `]` removed, then empty when it
# is "unknown".
_doflow_ss_known() {
  _DF_SS_KNOWN=${1//]/}
  [ "$_DF_SS_KNOWN" != unknown ] || _DF_SS_KNOWN=""
  return 0
}

# doflow_grant_peek <run> <lineage> <max_bytes>
# IC-012 grant steps 1 and 2: the oldest grants/<run>/<lineage>/<summaryId>.md by name among regular,
# non-symlink files whose name matches the summary id pattern. DF_GRANT is `none`, `fits` or `over`.
# It fits exactly when emission.jq would render it whole: the UTF-8 bytes of render_grant's segment
# "[Granted summary from lineage <from_lineage><header_tail>]\n<body>" are at most max_bytes, so a
# body that fits under a header that does not is `over` and is never claimed. DF_GRANT_FILE,
# DF_GRANT_ID and DF_GRANT_BYTES (the body's bytes, for the pointer; empty when the file is too large
# to be worth reading) describe it. Always returns 0.
doflow_grant_peek() {
  local LC_ALL=C run="${1:-}" lineage="${2:-}" max="${3:-}" dir f name header tail=""
  DF_GRANT=none
  DF_GRANT_FILE=""
  DF_GRANT_ID=""
  DF_GRANT_BYTES=""
  _doflow_ss_id_ok "$run" && _doflow_ss_id_ok "$lineage" || return 0
  [[ $max =~ ^[1-9][0-9]{0,9}$ ]] || return 0
  _doflow_ss_root
  dir="$_DF_SS_ROOT/grants/$run/$lineage"
  [ -d "$dir" ] && [ ! -L "$dir" ] || return 0
  # Glob expansion is sorted (C collation here), and summary ids sort by time.
  for f in "$dir"/s-*.md; do
    name=${f##*/}
    name=${name%.md}
    _doflow_ss_summary_id_ok "$name" || continue
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    DF_GRANT_FILE=$f
    DF_GRANT_ID=$name
    break
  done
  [ -n "$DF_GRANT_FILE" ] || return 0
  _doflow_ss_size "$DF_GRANT_FILE"
  # A frontmatter needs far less than 65536 bytes: anything larger than that plus the budget is over.
  if [ -n "$_DF_SS_SIZE" ] && [ "$_DF_SS_SIZE" -le $((max + 65536)) ]; then
    _doflow_ss_body_bytes "$DF_GRANT_FILE"
    DF_GRANT_BYTES=$_DF_SS_BODY
    # render_grant's header, from the same bounded head pass parse_record's fields come from.
    _doflow_ss_head "$DF_GRANT_FILE"
    _doflow_ss_known "$_DF_SS_AT"
    [ -z "$_DF_SS_KNOWN" ] || tail=", compacted $_DF_SS_KNOWN"
    _doflow_ss_known "$_DF_SS_BRANCH"
    [ -z "$_DF_SS_KNOWN" ] || tail="$tail on branch $_DF_SS_KNOWN"
    header="[Granted summary from lineage $_DF_SS_FROM$tail]"
    if [ $((${#header} + 1 + DF_GRANT_BYTES)) -le "$max" ]; then DF_GRANT=fits; else DF_GRANT=over; fi
  else
    DF_GRANT=over
  fi
  return 0
}

# doflow_grant_claim <run> <lineage> <unit_id> <max_bytes>
# IC-012 grant step 3: peek; when the oldest grant fits, rename it to
# .claimed.<unitId>.<summaryId> and set DF_GRANT_CLAIMED (for --rawfile grant); the caller removes
# it after rendering. An `over` grant stays in place (DF_GRANT_FILE renders the pointer). One grant
# per event. Returns 0 only when this caller claimed a grant.
doflow_grant_claim() {
  local unit="${3:-}" claimed
  DF_GRANT_CLAIMED=""
  doflow_grant_peek "${1:-}" "${2:-}" "${4:-}"
  [ "$DF_GRANT" = fits ] || return 1
  _doflow_ss_unit_ok "$unit" || return 1
  claimed="${DF_GRANT_FILE%/*}/.claimed.$unit.$DF_GRANT_ID"
  if ! mv "$DF_GRANT_FILE" "$claimed" 2>/dev/null; then
    DF_GRANT=none
    return 1
  fi
  DF_GRANT_CLAIMED=$claimed
  return 0
}

# doflow_summary_adopt_legacy <cwd> <worktree>
# IC-014, on action `adopt` only: the pre-078 project summary under projects/<cwd_hash cwd>/, a
# regular file and not a symlink, moves once into summaries/<worktreeKey>/local/main/summary.md
# with its frontmatter kept. When a summary is already pending there it is newer by construction
# and the old file is removed instead. The move is a hard link that refuses to replace, then an
# unlink, so a summary written meanwhile is never overwritten. Nothing writes the old path. Returns
# 0 when a legacy file was adopted or retired.
doflow_summary_adopt_legacy() {
  local cwd="${1:-}" worktree="${2:-}" projects old new
  [ -n "$cwd" ] || return 1
  [ -n "$worktree" ] || worktree=$cwd
  _doflow_ss_key "$cwd" || return 1
  _doflow_ss_root
  projects="${PROJECTS_DIR:-$_DF_SS_ROOT/projects}"
  old="$projects/$_DF_SS_KEY/last-compact-summary.md"
  [ -f "$old" ] && [ ! -L "$old" ] || return 1
  doflow_summary_scope "$worktree" local main || return 1
  new="$DF_SUMMARY_SCOPE/summary.md"
  mkdir -p "$DF_SUMMARY_SCOPE" 2>/dev/null || return 1
  if [ -e "$new" ] || [ -L "$new" ] || ln "$old" "$new" 2>/dev/null; then
    rm -f "$old" 2>/dev/null || return 1
    return 0
  fi
  # No hard links on this filesystem: re-check, then rename.
  [ -e "$new" ] || [ -L "$new" ] || mv "$old" "$new" 2>/dev/null || return 1
  rm -f "$old" 2>/dev/null || true
  return 0
}
