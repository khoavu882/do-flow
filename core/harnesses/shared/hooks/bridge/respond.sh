#!/usr/bin/env bash
# Native hook response renderers for the shared lifecycle bridge.
BRIDGE_RESPOND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$BRIDGE_RESPOND_DIR/../policies/deny-json.sh"

doflow_render_response() {
  local harness="$1" event="$2" outcome="$3" reason="$4" status="$5" engine="${DOFLOW_KIRO_ENGINE:-2x}"
  if [ "$outcome" = deny ]; then
    case "$harness:$event" in
      claude:PreToolUse|codex:PreToolUse) emit_pretooluse_deny_nested "$reason"; return 0 ;;
      gemini:BeforeTool) emit_pretooluse_deny_flat "$reason"; return 0 ;;
      kiro:PreToolUse) printf '%s' "$reason" >&2; return 2 ;;
      antigravity:PreToolUse) jq -cn --arg reason "$reason" '{decision:"deny",reason:$reason}'; return 0 ;;
      antigravity:Stop) jq -cn --arg reason "$reason" '{decision:"continue",reason:$reason}'; return 0 ;;
      pi:tool_call) jq -cn --arg reason "$reason" '{block:true,reason:$reason}'; return 0 ;;
      kiro:Stop|kiro:stop)
        if [ "$engine" = v3 ]; then jq -cn --arg reason "$reason" '{decision:"block",reason:$reason}'; return 0; fi
        printf '%s' "$reason" >&2; return 2 ;;
      codex:Stop|codex:stop) printf '%s\n' '{}'; return 2 ;;
      *) printf '%s\n' "$reason" >&2; return 2 ;;
    esac
  fi
  case "$harness:$event" in
    codex:Stop|codex:stop) printf '%s\n' '{}' ;;
    antigravity:PreToolUse) printf '%s\n' '{"decision":"allow"}' ;;
  esac
  return "$status"
}
