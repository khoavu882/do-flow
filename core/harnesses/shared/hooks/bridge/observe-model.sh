#!/usr/bin/env bash
# observe-model.sh — the shared bridge step `observe-model` (row 120 IC-005).
#
# Defines doflow_observe_model <harness> <envelope>. Sourcing defines it only. bridge.sh calls it once
# per event, after the envelope is built, in a subshell with every stream discarded:
#
#   ( . "<bridge-dir>/observe-model.sh" && doflow_observe_model "$harness" "$payload" ) >/dev/null 2>&1 </dev/null || true
#
# so it never changes the decision, the exit code or the output, and every I/O error is ignored.
#
# When the envelope carries identity.model and a session id it records the model in one file under
# lib.sh's STATE_DIR (<config home>/doflow/session-env):
#   - main session (DOFLOW_SESSION_ROLE unset or main): primary/<cwd_hash cwd>/<harness>/<sessionKey>.json,
#     where cwd is the payload's absolute `cwd`, else the hook's working directory;
#   - worker (any other role, identity.sh's reading) with a launched identity (DOFLOW_RUN_ID other
#     than `local`, DOFLOW_LINEAGE_ID and DOFLOW_ATTEMPT, identity.sh's patterns):
#     worker-model/L.<run>.<lineage>.<attempt>.json. A worker without one writes nothing.
# sessionKey is the first 16 hex of the sha256 of the session id's bytes. The file holds exactly
#   {"schema":1,"harness":"<id>","model":"<model-id>","event":"<event>","observedAt":"<UTC>","session":"<sessionKey>"}
# and is written only when absent or when its model differs: a tmp file in the same folder, then a
# rename, mode 0600. With no config home, no sha256 tool or a link in place of the file, nothing.
# The storage stores model-observations and worker-model-observations bound both folders.

_DOFLOW_SRC=${BASH_SOURCE[0]//\\//}; case $_DOFLOW_SRC in */*) _DOFLOW_OBSERVE_DIR=${_DOFLOW_SRC%/*} ;; *) _DOFLOW_OBSERVE_DIR=. ;; esac

doflow_observe_model() {
  local harness="${1:-}" envelope="${2:-}" fields="" model="" model_json="" session="" cwd="" event="" now=""
  local key="" dir="" file="" current="" tmp="" run="${DOFLOW_RUN_ID:-}" lineage="${DOFLOW_LINEAGE_ID:-}" attempt="${DOFLOW_ATTEMPT:-}"
  case "$harness" in ''|*[!a-z0-9-]*) return 0 ;; esac
  # lib.sh gives STATE_DIR (the config-home rule), cwd_hash and identity.sh's role reading.
  . "$_DOFLOW_OBSERVE_DIR/../policies/lib.sh" || return 0
  [ -n "${STATE_DIR:-}" ] || return 0
  fields=$(printf '%s\n' "$envelope" | jq -r '
    def text: type == "string" and length > 0 and (test("[[:cntrl:]]") | not);
    .doflow_event as $e
    | select(($e.identity.model | text) and ($e.identity.session | text))
    | $e.identity.model, ($e.identity.model | tojson), $e.identity.session,
      (if (.cwd | text) and (.cwd | startswith("/")) then .cwd else "-" end),
      ($e.event | tojson), (now | strftime("%Y-%m-%dT%H:%M:%SZ"))' 2>/dev/null) || return 0
  { IFS= read -r model && IFS= read -r model_json && IFS= read -r session && IFS= read -r cwd \
    && IFS= read -r event && IFS= read -r now; } <<<"$fields" || return 0

  if command -v sha256sum >/dev/null 2>&1; then key=$(printf '%s' "$session" | sha256sum | cut -c1-16)
  elif command -v shasum >/dev/null 2>&1; then key=$(printf '%s' "$session" | shasum -a 256 | cut -c1-16)
  else return 0; fi
  [[ $key =~ ^[0-9a-f]{16}$ ]] || return 0

  _doflow_role_resolve
  if [ "$_DF_ROLE" = main ]; then
    case "$cwd" in /*) ;; *) cwd=$PWD ;; esac
    dir="$STATE_DIR/primary/$(cwd_hash "$cwd")/$harness"
    file="$dir/$key.json"
  else
    [ "$run" != local ] && [[ $run =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$ ]] || return 0
    [[ $lineage =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$ ]] && [[ $attempt =~ ^[1-9][0-9]{0,3}$ ]] || return 0
    dir="$STATE_DIR/worker-model"
    file="$dir/L.$run.$lineage.$attempt.json"
  fi

  [ ! -L "$file" ] || return 0
  if [ -f "$file" ]; then
    current=$(jq -r 'if (.model | type) == "string" then .model else empty end' "$file" 2>/dev/null) || current=""
    [ "$current" != "$model" ] || return 0
  fi
  umask 077
  mkdir -p "$dir" || return 0
  tmp="$file.tmp.$$"
  if printf '{"schema":1,"harness":"%s","model":%s,"event":%s,"observedAt":"%s","session":"%s"}\n' \
      "$harness" "$model_json" "$event" "$now" "$key" >"$tmp" && mv -f "$tmp" "$file"; then
    return 0
  fi
  rm -f "$tmp"
  return 0
}
