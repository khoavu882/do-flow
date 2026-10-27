#!/usr/bin/env bash
case "${OSTYPE:-}" in msys*|cygwin*|win32*) if command -v jq >/dev/null 2>&1; then jq() { command jq -b "$@"; }; fi ;; esac # native jq.exe ends lines with CRLF unless -b
# Native hook response renderers for the shared lifecycle bridge.
_DOFLOW_SRC=${BASH_SOURCE[0]//\\//}; case $_DOFLOW_SRC in */*) _DOFLOW_RESPOND_DIR=${_DOFLOW_SRC%/*} ;; *) _DOFLOW_RESPOND_DIR=. ;; esac
. "$_DOFLOW_RESPOND_DIR/../policies/deny-json.sh"

doflow_bridge_native_event_var() {
  DF_NE=$2
  case "$1:$2" in
    kiro:preToolUse) DF_NE=PreToolUse ;;
    kiro:agentSpawn) DF_NE=SessionStart ;;
    kiro:stop) DF_NE=Stop ;;
  esac
}

doflow_bridge_native_event() {
  local harness="$1" event="$2"
  case "$harness:$event" in
    kiro:preToolUse) event=PreToolUse ;;
    kiro:agentSpawn) event=SessionStart ;;
    kiro:stop) event=Stop ;;
  esac
  printf '%s\n' "$event"
}

doflow_render_response() {
  local harness="$1" event="$2" outcome="$3" reason="$4" status="$5" engine="${DOFLOW_KIRO_ENGINE:-2x}"
  doflow_bridge_native_event_var "$harness" "$event"; event=$DF_NE
  if [ "$outcome" = deny ]; then
    case "$harness:$event" in
      claude:PreToolUse|codex:PreToolUse) emit_pretooluse_deny_nested "$reason" || return $?; return 0 ;;
      kiro:PreToolUse) printf '%s' "$reason" >&2; return 2 ;;
      antigravity:PreToolUse)
        if command -v jq >/dev/null 2>&1; then jq -cn --arg reason "$reason" '{decision:"deny",reason:$reason}'
        else printf '{"decision":"deny","reason":%s}\n' "$( _doflow_json_reason "$reason" )"; fi
        return $? ;;
      antigravity:Stop)
        if command -v jq >/dev/null 2>&1; then jq -cn --arg reason "$reason" '{decision:"continue",reason:$reason}'
        else printf '{"decision":"continue","reason":%s}\n' "$( _doflow_json_reason "$reason" )"; fi
        return $? ;;
      pi:tool_call)
        if command -v jq >/dev/null 2>&1; then jq -cn --arg reason "$reason" '{block:true,reason:$reason}'
        else printf '{"block":true,"reason":%s}\n' "$( _doflow_json_reason "$reason" )"; fi
        return $? ;;
      kiro:Stop|kiro:stop)
        if [ "$engine" = v3 ]; then
          if command -v jq >/dev/null 2>&1; then jq -cn --arg reason "$reason" '{decision:"block",reason:$reason}'
          else printf '{"decision":"block","reason":%s}\n' "$( _doflow_json_reason "$reason" )"; fi
          return $?
        fi
        printf '%s' "$reason" >&2; return 2 ;;
      codex:Stop|codex:stop) printf '%s\n' '{}' >&1; printf '%s\n' "$reason" >&2; return 2 ;;
      *) printf '%s\n' "$reason" >&2; return 2 ;;
    esac
  fi
  case "$harness:$event" in
    codex:Stop|codex:stop) printf '%s\n' '{}' ;;
    antigravity:PreToolUse) printf '%s\n' '{"decision":"allow"}' ;;
    kiro:PreToolUse|claude:Stop) if [ "$status" -ne 0 ]; then printf '%s' "$reason" >&2; fi ;;
  esac
  return "$status"
}
