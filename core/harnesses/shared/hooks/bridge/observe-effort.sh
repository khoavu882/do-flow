#!/usr/bin/env bash
case "${OSTYPE:-}" in msys*|cygwin*|win32*) if command -v jq >/dev/null 2>&1; then jq() { command jq -b "$@"; }; fi ;; esac # native jq.exe ends lines with CRLF unless -b
# observe-effort.sh — the shared bridge step `observe-effort` (row 180 IC-180-E1).
#
# Defines doflow_observe_effort <harness> <envelope>. Sourcing defines it only. bridge.sh calls it beside
# observe-model, after the envelope is built, in a subshell with every stream discarded:
#
#   ( . "<bridge-dir>/observe-effort.sh" && doflow_observe_effort "$harness" "$payload" ) >/dev/null 2>&1 </dev/null || true
#
# so it never changes the decision, the exit code or the output, and every I/O error is ignored.
#
# When the envelope carries identity.effort (a level, EFFORT_RE) and a session id, and the session is the main one
# (DOFLOW_SESSION_ROLE unset or main), it records the level in one file under lib.sh's STATE_DIR
# (<config home>/doflow/session-env): effort/<sessionKey>.json, where sessionKey is the first 16 hex of the sha256 of
# the session id's bytes. The file holds exactly
#   {"schema":1,"harness":"<id>","level":"<level>","event":"<event>","observedAt":"<UTC>","session":"<sessionKey>"}
# and is written only when absent or when its level differs: a tmp file in the same folder, then a rename, mode 0600.
# Nothing is written for a worker role, a payload with a non-empty agent_id or a Subagent* event (a subagent's level
# is not the session's), with no config home or no sha256 tool, or with a link in place of the file.
# src/runtime/context/effort-store.ts reads it; the storage store effort-observations bounds the folder, and the
# Claude SessionEnd hook removes the ending session's file.

_DOFLOW_SRC=${BASH_SOURCE[0]//\\//}; case $_DOFLOW_SRC in */*) _DOFLOW_OBSERVE_EFFORT_DIR=${_DOFLOW_SRC%/*} ;; *) _DOFLOW_OBSERVE_EFFORT_DIR=. ;; esac

doflow_observe_effort() {
  local harness="${1:-}" envelope="${2:-}" fields="" level="" session="" event="" now="" key="" dir="" file="" current="" tmp=""
  case "$harness" in ''|*[!a-z0-9-]*) return 0 ;; esac
  # lib.sh gives STATE_DIR (the config-home rule) and identity.sh's role reading.
  . "$_DOFLOW_OBSERVE_EFFORT_DIR/../policies/lib.sh" || return 0
  [ -n "${STATE_DIR:-}" ] || return 0
  _doflow_role_resolve
  [ "$_DF_ROLE" = main ] || return 0
  fields=$(jq -r '
    def text: type == "string" and length > 0 and (test("[[:cntrl:]]") | not);
    .doflow_event as $e
    | select(($e.identity.effort | text) and ($e.identity.effort | test("^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$"))
        and ($e.identity.session | text) and (.agent_id == null or .agent_id == "")
        and ($e.event | text) and ($e.event | test("^[A-Za-z][A-Za-z0-9_.:-]{0,63}$")) and ($e.event | startswith("Subagent") | not))
    | $e.identity.effort, $e.identity.session, $e.event, (now | strftime("%Y-%m-%dT%H:%M:%SZ"))' 2>/dev/null <<<"$envelope") || return 0
  { IFS= read -r level && IFS= read -r session && IFS= read -r event && IFS= read -r now; } <<<"$fields" || return 0

  if command -v sha256sum >/dev/null 2>&1; then key=$(printf '%s' "$session" | sha256sum)
  elif command -v shasum >/dev/null 2>&1; then key=$(printf '%s' "$session" | shasum -a 256)
  else return 0; fi
  key=${key:0:16}
  [[ $key =~ ^[0-9a-f]{16}$ ]] || return 0

  dir="$STATE_DIR/effort"
  file="$dir/$key.json"
  [ ! -L "$file" ] || return 0
  if [ -f "$file" ]; then
    # The file is one line this step wrote; the same level means nothing to record.
    IFS= read -r current <"$file" || :
    case "$current" in *"\"level\":\"$level\","*) return 0 ;; esac
  fi
  umask 077
  [ -d "$dir" ] || mkdir -p "$dir" || return 0
  tmp="$file.tmp.$$"
  if printf '{"schema":1,"harness":"%s","level":"%s","event":"%s","observedAt":"%s","session":"%s"}\n' \
      "$harness" "$level" "$event" "$now" "$key" >"$tmp" && mv -f "$tmp" "$file"; then
    return 0
  fi
  rm -f "$tmp"
  return 0
}
