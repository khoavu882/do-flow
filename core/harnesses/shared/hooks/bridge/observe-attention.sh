#!/usr/bin/env bash
case "${OSTYPE:-}" in msys*|cygwin*|win32*) if command -v jq >/dev/null 2>&1; then jq() { command jq -b "$@"; }; fi ;; esac # native jq.exe ends lines with CRLF unless -b
# observe-attention.sh — the shared bridge step `observe-attention` (row 180 IC-180-D1, IC-180-D2).
#
# Defines two functions; sourcing defines them only. Each runs in a subshell with every stream discarded, so it never
# changes a decision, an exit code or an output, and every I/O error is ignored:
#
#   ( . "<bridge-dir>/observe-attention.sh" && doflow_observe_attention <harness> <event> ) >/dev/null 2>&1 || true
#   ( . "<bridge-dir>/observe-attention.sh" && doflow_attention_answered <harness> <event> <session id> ) >/dev/null 2>&1 </dev/null || true
#
# The mechanism is data, never a harness name in this file: each harness's `attention` entry in
# core/registry/harnesses.json, projected to the map installed at .doflow/shared/hooks/bridge/attention.json
# (test/registry/attention.test.ts keeps the two equal). A harness or an event the map does not list does nothing.
#
# doflow_observe_attention reads the native hook payload on stdin. When the map lists <event> as an ask of <harness>,
# one jq call reads the map's `sessionField`, the ask's `kindField` and `toolField` from the payload, and no other
# field: no message text and no tool input reach the record (O-1 a). It appends one line to
# <config home>/doflow/session-env/sessions/<session id>/attention.log:
#   {"schema":1,"at":"<UTC>","event":"<native event>","kind":"permission|question|idle|other","tool":"<tool or empty>"}
# A kindField value in the ask's `skip` writes nothing; one not in its `kinds` is its `otherwise`. An ask is not
# written again while the log's newest line is an open ask of the same kind whose tool equals the new one, or when the
# new one names no tool (a PermissionRequest followed by its permission_prompt Notification, which the vendor sends
# about six seconds later). A log over 256 KiB, a link in place of the log or its folder, or no config home writes
# nothing.
#
# doflow_attention_answered: when no attention.log exists for the session it returns after that one file test (it
# rides every tool hook). Else, when the newest line is an open ask and <event> is in the harness's `answeredBy`, it
# appends {"schema":1,"at":"<UTC>","event":"answered","via":"<event>"}.
# Ceilings: two hooks of one event that run at once can both append `answered`; an allowed tool with no answering
# hook stays pending until the next prompt, answering hook or Stop.
# src/runtime/events/layers.ts reads the log; the session-dirs store bounds the folder and SessionEnd removes it.

_DOFLOW_SRC=${BASH_SOURCE[0]//\\//}; case $_DOFLOW_SRC in */*) _DOFLOW_OBSERVE_ATTENTION_DIR=${_DOFLOW_SRC%/*} ;; *) _DOFLOW_OBSERVE_ATTENTION_DIR=. ;; esac

# SESSION_DIR from the lib.sh a front door already sourced, else from the shared one (the config-home rule).
_doflow_attention_home() {
  if [ -z "${SESSION_DIR+set}" ]; then . "$_DOFLOW_OBSERVE_ATTENTION_DIR/../policies/lib.sh" || return 1; fi
  [ -n "${SESSION_DIR:-}" ]
}

# A log this step may append to: no link in place of it or its folder, and at most 256 KiB.
_doflow_attention_room() {
  local size=""
  [ ! -L "$1" ] && [ ! -L "${1%/*}" ] || return 1
  [ -e "$1" ] || return 0
  [ -f "$1" ] || return 1
  size=$(wc -c <"$1") || return 1
  size=${size//[!0-9]/}
  [ -n "$size" ] && [ "$size" -le 262144 ]
}

doflow_observe_attention() {
  local harness="${1:-}" event="${2:-}" map="$_DOFLOW_OBSERVE_ATTENTION_DIR/attention.json" fields="" session="" kind="" tool="" line="" log="" last=""
  case "$harness" in ''|*[!a-z0-9-]*) return 0 ;; esac
  case "$event" in ''|*[!A-Za-z0-9_]*) return 0 ;; esac
  [ -f "$map" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  _doflow_attention_home || return 0
  fields=$(jq -r --arg h "$harness" --arg e "$event" --slurpfile m "$map" '
    def named($n): if ($n | type) == "string" then .[$n] else null end;
    ($m[0][$h] // empty) as $d
    | ([$d.asks[]? | select(.event == $e)] | first // empty) as $a
    | named($d.sessionField) as $s
    | select(($s | type) == "string" and ($s | test("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")))
    | (if $a.kind != null then $a.kind
       else named($a.kindField) as $v
         | if ($v | type) == "string" and any(($a.skip // [])[]; . == $v) then empty
           elif ($v | type) == "string" and ($a.kinds | has($v)) then $a.kinds[$v]
           else $a.otherwise end
       end) as $k
    | select($k == "permission" or $k == "question" or $k == "idle" or $k == "other")
    | (if $a.toolField != null then named($a.toolField) else null end
       | if type == "string" and test("^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$") then . else "" end) as $t
    | $s, $k, $t, ({schema: 1, at: (now | strftime("%Y-%m-%dT%H:%M:%SZ")), event: $e, kind: $k, tool: $t} | tojson)' 2>/dev/null) || return 0
  { IFS= read -r session && IFS= read -r kind && IFS= read -r tool && IFS= read -r line; } <<<"$fields" || return 0
  [ -n "$session" ] && [ -n "$line" ] || return 0

  log="$SESSION_DIR/$session/attention.log"
  _doflow_attention_room "$log" || return 0
  if [ -f "$log" ]; then
    last=$(tail -n 1 "$log") || last=""
    case "$last" in
      *'"event":"answered"'*) ;;
      *"\"kind\":\"$kind\",\"tool\":\"$tool\"}"*) return 0 ;;
      *"\"kind\":\"$kind\","*) [ -n "$tool" ] || return 0 ;;
    esac
  fi
  umask 077
  [ -d "$SESSION_DIR/$session" ] || mkdir -p "$SESSION_DIR/$session" || return 0
  printf '%s\n' "$line" >>"$log" || :
  return 0
}

doflow_attention_answered() {
  local harness="${1:-}" event="${2:-}" session="${3:-}" map="$_DOFLOW_OBSERVE_ATTENTION_DIR/attention.json" log="" last="" line=""
  case "$session" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) return 0 ;; esac
  [ "${#session}" -le 128 ] || return 0
  _doflow_attention_home || return 0
  log="$SESSION_DIR/$session/attention.log"
  [ -f "$log" ] || return 0
  case "$harness" in ''|*[!a-z0-9-]*) return 0 ;; esac
  case "$event" in ''|*[!A-Za-z0-9_]*) return 0 ;; esac
  last=$(tail -n 1 "$log") || return 0
  case "$last" in ''|*'"event":"answered"'*) return 0 ;; esac
  [ -f "$map" ] && command -v jq >/dev/null 2>&1 || return 0
  line=$(jq -nr --arg h "$harness" --arg e "$event" --slurpfile m "$map" '
    select(any(($m[0][$h].answeredBy // [])[]; . == $e))
    | {schema: 1, at: (now | strftime("%Y-%m-%dT%H:%M:%SZ")), event: "answered", via: $e} | tojson' 2>/dev/null) || return 0
  [ -n "$line" ] || return 0
  _doflow_attention_room "$log" || return 0
  printf '%s\n' "$line" >>"$log" || :
  return 0
}
