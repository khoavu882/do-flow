#!/usr/bin/env bash
# Shared lifecycle bridge. Sourcing defines functions only; it sets no shell options or traps.
case ${BASH_SOURCE[0]} in */*) _DOFLOW_BRIDGE_DIR=${BASH_SOURCE[0]%/*} ;; *) _DOFLOW_BRIDGE_DIR=. ;; esac

doflow_bridge_failure() {
  local policy="$1" point="$2"
  ( . "$_DOFLOW_BRIDGE_DIR/../policies/capture-failure.sh"; doflow_capture_failure "$policy" "$point" ) >/dev/null 2>&1 || true
}

doflow_bridge_classify() {
  local code="$1" record="$2" outcome="" decision_code="" version=0 reason="$3"
  if [ -n "$record" ]; then
    outcome="${record#*\"outcome\":\"}"; outcome="${outcome%%\"*}"
    decision_code="${record#*\"code\":\"}"; decision_code="${decision_code%%\"*}"
    version="${record#*\"policyVersion\":}"; version="${version%%,*}"
    case "$version" in ''|*[^0-9]*) version=0;; esac
  fi
  DF_BRIDGE_OUTCOME=error; DF_BRIDGE_CODE=exit-"$code"; DF_BRIDGE_VERSION="$version"; DF_BRIDGE_REASON="$DF_BRIDGE_CODE"; DF_BRIDGE_POINT="eval-error:exit-$code"
  if [ "$code" -eq 2 ] 2>/dev/null; then
    if [ "$outcome" = deny ]; then DF_BRIDGE_OUTCOME=deny; DF_BRIDGE_CODE="$decision_code"; DF_BRIDGE_REASON="$reason"; DF_BRIDGE_POINT=""
    else DF_BRIDGE_CODE=exit-2-unmarked; DF_BRIDGE_REASON=exit-2-unmarked; DF_BRIDGE_POINT=eval-error:exit-2-unmarked; fi
  elif [ "$code" -eq 0 ] 2>/dev/null; then
    case "$outcome" in
      allow|advisory|error|unsupported) DF_BRIDGE_OUTCOME="$outcome"; DF_BRIDGE_CODE="$decision_code"; DF_BRIDGE_REASON="$decision_code"; DF_BRIDGE_POINT="" ;;
      deny) DF_BRIDGE_OUTCOME=allow; DF_BRIDGE_CODE=decision-mismatch; DF_BRIDGE_REASON=decision-mismatch; DF_BRIDGE_POINT=decision-mismatch ;;
      *) DF_BRIDGE_OUTCOME=allow; DF_BRIDGE_CODE=allow; DF_BRIDGE_REASON=allow; DF_BRIDGE_POINT=""; DF_BRIDGE_VERSION=0 ;;
    esac
  elif [ "$code" -ge 129 ] && [ "$code" -le 255 ] && [ "$code" -ne 255 ] 2>/dev/null; then
    local sig=""
    sig="$(kill -l "$((code - 128))" 2>/dev/null)" || sig=""
    sig="${sig#SIG}"
    case "$sig" in ''|*[!A-Za-z0-9_-]*) return;; esac
    DF_BRIDGE_OUTCOME=error; DF_BRIDGE_CODE=signal-"$sig"; DF_BRIDGE_REASON="$DF_BRIDGE_CODE"; DF_BRIDGE_POINT="eval-error:signal-$sig"
  fi
}

doflow_bridge_effect() {
  local harness="$1" event="$2" policy="$3" outcome="$4" profile="${DOFLOW_FAULT_PROFILE:-compat-1}" block=0
  doflow_bridge_native_event_var "$harness" "$event"; event=$DF_NE
  if [ "$profile" != compat-1 ] && [ "$profile" != strict-1 ]; then
    profile=compat-1; doflow_bridge_failure "$policy" fault-profile-unknown
  fi
  DF_BRIDGE_PROFILE="$profile"
  case "$policy" in pre-implementation-gate|pre-bash-guard|mcp-tool-guard|stop-check) block=1;; esac
  DF_BRIDGE_EFFECT=proceed
  if [ "$outcome" = deny ]; then DF_BRIDGE_EFFECT=block
  elif [ "$profile" = strict-1 ] && [ "$block" -eq 1 ] && [ "$policy" != stop-check ] && { [ "$outcome" = error ] || [ "$outcome" = unsupported ] || [ "$DF_BRIDGE_CODE" = bridge-spawn ] || [ "$DF_BRIDGE_CODE" = envelope-encode ]; }; then DF_BRIDGE_EFFECT=block
  elif [ "$outcome" = error ] && [ "$DF_BRIDGE_CODE" != bridge-spawn ] && [ -n "$DF_BRIDGE_POINT" ] && [ "$profile" = compat-1 ]; then
    case "$harness:$event" in
      claude:PreToolUse|codex:PreToolUse|gemini:BeforeTool|pi:tool_call) DF_BRIDGE_EFFECT=block ;;
      antigravity:PreToolUse|antigravity:Stop) case "$DF_BRIDGE_CODE" in signal-*) DF_BRIDGE_EFFECT=proceed;; *) DF_BRIDGE_EFFECT=block;; esac ;;
      kiro:PreToolUse) [ "$DF_BRIDGE_CODE" = exit-2-unmarked ] && DF_BRIDGE_EFFECT=block ;;
      claude:Stop) [ "$DF_BRIDGE_CODE" = exit-2-unmarked ] && DF_BRIDGE_EFFECT=block ;;
      codex:Stop|codex:stop|kiro:Stop|kiro:stop) [ "$DF_BRIDGE_CODE" = exit-2-unmarked ] && DF_BRIDGE_EFFECT=block || DF_BRIDGE_EFFECT=proceed ;;
    esac
  fi
}

doflow_bridge_drops_tool_streams() {
  case "$1" in
    pre-implementation-gate|pre-bash-guard|mcp-tool-guard) ;;
    *) return 1 ;;
  esac
  case "$2:$3" in
    claude:PreToolUse|codex:PreToolUse|gemini:BeforeTool|kiro:PreToolUse|antigravity:PreToolUse|antigravity:Stop|pi:tool_call) return 0 ;;
    *) return 1 ;;
  esac
}

doflow_bridge_drops_tool_stderr() {
  case "$1:$2:$3" in
    pre-implementation-gate:kiro:PreToolUse|pre-bash-guard:kiro:PreToolUse|mcp-tool-guard:kiro:PreToolUse) return 1 ;;
  esac
  doflow_bridge_drops_tool_streams "$1" "$2" "$3"
}

# One hook line (IC-004) for an allowlisted surface, from the encode tuple in DF_TUPLE, appended to
# <config>/state/runs/telemetry/<UTC date>.jsonl. Builtins only on the path that writes; every step
# returns 0, and nothing reaches stdout or stderr. Args: harness, normalised event, policy.
doflow_bridge_hook_line() {
  local d="" f="" day="" rest="" duration=null t1=""
  [ "${DOFLOW_TELEMETRY:-}" != off ] || return 0
  case "$DF_TUPLE" in ''|'{"dft":1}') return 0 ;; esac
  case "$1:$3:$2" in
    claude:pre-bash-guard:PreToolUse|codex:pre-bash-guard:PreToolUse|gemini:pre-bash-guard:BeforeTool|kiro:pre-bash-guard:PreToolUse|antigravity:pre-bash-guard:PreToolUse|pi:pre-bash-guard:tool_call|claude:user-prompt-submit:UserPromptSubmit|codex:user-prompt-submit:UserPromptSubmit) ;;
    *) return 0 ;;
  esac
  if [ -n "${DOFLOW_CONFIG_DIR:-}" ]; then
    d=$DOFLOW_CONFIG_DIR
  else
    d=${PWD:-}
    case "$d" in /*) ;; *) return 0 ;; esac
    while :; do
      if [ -d "$d/.doflow" ]; then
        case "$d/" in
          */.doflow/*) ;;
          *) d=${d%/}/.doflow; break ;;
        esac
      fi
      [ -n "$d" ] && [ "$d" != "/" ] || return 0
      d=${d%/*}
    done
  fi
  [ -d "$d/state" ] || return 0
  day=${DF_TUPLE:17:10}
  case "$day" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) return 0 ;; esac
  rest=${DF_TUPLE#\{\"dft\":1,\"date\":\"??????????\",}
  case "$rest" in \"timestamp\":*\}) ;; *) return 0 ;; esac
  if [ -n "$_df_t0" ]; then
    t1=${EPOCHREALTIME:-}; t1=${t1/[.,]/}; _df_t0=${_df_t0/[.,]/}
    case "$t1$_df_t0" in ''|*[!0-9]*) ;; *) duration=$(( (t1 - _df_t0) / 1000 )); [ "$duration" -ge 0 ] || duration=null ;; esac
  fi
  [ -d "$d/state/runs/telemetry" ] || mkdir "$d/state/runs/telemetry" 2>/dev/null || return 0
  f=$d/state/runs/telemetry/$day.jsonl
  [ ! -e "$f" ] || [ -f "$f" ] || return 0
  { printf '{"kind":"hook","harness":"%s","event":"%s","policy":"%s","verdict":"%s","duration_ms":%s,%s\n' "$1" "$2" "$3" "$DF_BRIDGE_OUTCOME" "$duration" "$rest" >>"$f"; } 2>/dev/null || true
  return 0
}

doflow_bridge() {
  local harness="${1:-}" event="${2:-}" policy="${3:-}" response_event="" emit="native" payload="" encoded="" policy_path="" captured="" err="" code=0 policy_code=0 record="" reason="" decision_reason="" stdout="" status=0 decision="" line="" spawn_failed=0 encode_failed=0 _df_t0=""
  DF_TUPLE=""
  if [ "${BASH_VERSINFO[0]:-0}" -ge 5 ] 2>/dev/null; then _df_t0=${EPOCHREALTIME:-}; fi
  . "$_DOFLOW_BRIDGE_DIR/respond.sh"
  doflow_bridge_native_event_var "$harness" "$event"; response_event=$DF_NE
  if [ "${4:-}" = --emit ]; then emit="${5:-native}"; fi
  payload="$(cat)"
  if command -v jq >/dev/null 2>&1; then
    encoded="$(printf '%s\n' "$payload" | DOFLOW_TASK_ID="${DOFLOW_TASK_ID:-}" DOFLOW_RUN_ID="${DOFLOW_RUN_ID:-}" DOFLOW_ATTEMPT="${DOFLOW_ATTEMPT:-}" DOFLOW_LINEAGE_ID="${DOFLOW_LINEAGE_ID:-}" DOFLOW_SESSION_ROLE="${DOFLOW_SESSION_ROLE:-}" DOFLOW_WORKTREE="${DOFLOW_WORKTREE:-}" jq -c --arg harness "$harness" --arg event "$event" --arg policy "$policy" --arg mode encode -f "$_DOFLOW_BRIDGE_DIR/envelope.jq" 2>/dev/null)" || encode_failed=1
    # The telemetry tuple is the first line; without an envelope line after it there is no envelope.
    case "$encoded" in
      '{"dft"'*)
        DF_TUPLE=${encoded%%$'\n'*}
        case "$encoded" in *$'\n'*) encoded=${encoded#*$'\n'} ;; *) encoded="" ;; esac
        ;;
    esac
    if [ "$encode_failed" -eq 0 ]; then
      case "$encoded" in \{*) payload="$encoded" ;; *) encode_failed=1 ;; esac
    fi
    if [ "$encode_failed" -eq 1 ]; then
      encoded="$(jq -cn --arg harness "$harness" --arg event "$event" --arg policy "$policy" --arg mode minimal -f "$_DOFLOW_BRIDGE_DIR/envelope.jq" 2>/dev/null)" || encoded=""
      case "$encoded" in \{*) payload="$encoded" ;; *) payload="{\"doflow_event\":{\"version\":1,\"harness\":\"$harness\",\"event\":\"$event\",\"operation\":\"tool\"}}" ;; esac
      doflow_bridge_failure "$policy" envelope-encode
    fi
  else
    doflow_bridge_failure "$policy" dependency-missing:jq
  fi
  case "$policy" in
    pre-implementation-gate|pre-bash-guard|mcp-tool-guard|stop-check|session-context|user-prompt-submit|subagent-audit) ;;
    *) spawn_failed=1 ;;
  esac
  policy_path="$_DOFLOW_BRIDGE_DIR/../policies/$policy.sh"
  if [ "$spawn_failed" -eq 1 ] || [ ! -f "$policy_path" ]; then
    code=127; err=""; spawn_failed=1
  else
    if [ "$emit" = decision ] || doflow_bridge_drops_tool_streams "$policy" "$harness" "$response_event" || { [ "$harness" = kiro ] && [ "$response_event" = Stop ]; }; then exec 5>/dev/null; else exec 5>&1; fi
    captured="$( {
      if DOFLOW_AGENT="${DOFLOW_AGENT:-$harness}" DOFLOW_DECISION_FD=3 bash "$policy_path" 2>&1 3>&1 1>&5 5>&- <<<"$payload"; then policy_code=0; else policy_code=$?; fi
      printf '\037%s' "$policy_code"
    } )"
    exec 5>&-
    code="${captured##*$'\037'}"
    captured="${captured%$'\037'*}"
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      *$'\036'*)
        local prefix="${line%%$'\036'*}"
        record="${line#*$'\036'}"
        [ -z "$prefix" ] || err="$err$prefix"$'\n'
        ;;
      *) err="$err$line"$'\n' ;;
    esac
  done < <(printf '%s' "$captured")
  reason="${err%$'\n'}"
  doflow_bridge_classify "$code" "$record" "$reason"
  if [ "$encode_failed" -eq 1 ] && [ "$DF_BRIDGE_OUTCOME" != deny ]; then DF_BRIDGE_CODE=envelope-encode; DF_BRIDGE_POINT=envelope-encode; fi
  if [ "$spawn_failed" -eq 1 ]; then DF_BRIDGE_OUTCOME=error; DF_BRIDGE_CODE=bridge-spawn; DF_BRIDGE_REASON=bridge-spawn; DF_BRIDGE_VERSION=0; DF_BRIDGE_POINT=bridge-spawn; fi
  if [ -n "$DF_BRIDGE_POINT" ] && [ "$DF_BRIDGE_POINT" != decision-mismatch ] && [ "$DF_BRIDGE_POINT" != eval-error:signal-TERM ] && [ "$DF_BRIDGE_POINT" != eval-error:signal-INT ] && [ "$DF_BRIDGE_POINT" != eval-error:signal-PIPE ]; then doflow_bridge_failure "$policy" "$DF_BRIDGE_POINT"; fi
  doflow_bridge_effect "$harness" "$event" "$policy" "$DF_BRIDGE_OUTCOME"
  doflow_bridge_hook_line "$harness" "$response_event" "$policy"
  if [ "$DF_BRIDGE_EFFECT" = block ] && [ "$DF_BRIDGE_OUTCOME" != deny ]; then reason="[$policy] DoFlow policy error; details: doflow-run failure list"; fi
  if [ "$DF_BRIDGE_OUTCOME" != deny ] && [ "$DF_BRIDGE_EFFECT" = proceed ]; then
    case "$harness:$response_event:$DF_BRIDGE_OUTCOME" in
      kiro:PreToolUse:error|claude:Stop:error)
        case "$DF_BRIDGE_CODE" in
          exit-*|signal-*)
            reason="[$policy] DoFlow policy error; details: doflow-run failure list"
            if [ "$harness:$response_event" = claude:Stop ]; then reason="$reason"$'\n'; fi
            ;;
        esac
        ;;
      *) reason="$DF_BRIDGE_CODE" ;;
    esac
  fi
  decision_reason="$DF_BRIDGE_CODE"
  if [ "$DF_BRIDGE_OUTCOME" = deny ]; then decision_reason="$reason"; fi
  if [ "$emit" = decision ] || [ -n "${DOFLOW_BRIDGE_TRACE:-}" ]; then
    decision="$(jq -cn --arg harness "$harness" --arg event "$event" --arg policy "$policy" --arg outcome "$DF_BRIDGE_OUTCOME" --arg code "$DF_BRIDGE_CODE" --arg reason "$decision_reason" --arg profile "$DF_BRIDGE_PROFILE" --arg effect "$DF_BRIDGE_EFFECT" --argjson version "$DF_BRIDGE_VERSION" '{v:1,harness:$harness,event:$event,policy:$policy,policyVersion:$version,outcome:$outcome,code:$code,reason:$reason,faultProfile:$profile,effect:$effect}')"
  fi
  if [ -n "${DOFLOW_BRIDGE_TRACE:-}" ]; then printf '%s\n' "$decision" >>"$DOFLOW_BRIDGE_TRACE" 2>/dev/null || true; fi
  if [ "$emit" = decision ]; then
    printf '%s\n' "$decision"
    return 0
  fi
  if [ "$DF_BRIDGE_EFFECT" = block ]; then
    status=2
  else
    status=0
    if [ "$DF_BRIDGE_OUTCOME" = error ]; then
      case "$policy:$harness:$response_event" in
        session-context:*:*|user-prompt-submit:*:*|subagent-audit:*:*|*:kiro:PreToolUse|*:claude:Stop) status="$code" ;;
      esac
    fi
  fi
  if [ "$spawn_failed" -eq 1 ] && [ "$DF_BRIDGE_EFFECT" = proceed ]; then status=0; fi
  if [ "$DF_BRIDGE_EFFECT" = block ]; then
    doflow_render_response "$harness" "$event" deny "$reason" "$status"
    local render_status=$?
    return "$render_status"
  fi
  case "$policy:$DF_BRIDGE_OUTCOME:$harness:$response_event:$DF_BRIDGE_CODE" in
    session-context:error:*:*:*|user-prompt-submit:error:*:*:*|subagent-audit:error:*:*:*|session-context:unsupported:*:*:*|user-prompt-submit:unsupported:*:*:*|subagent-audit:unsupported:*:*:*) ;;
    *:error:codex:Stop:exit-*|*:error:codex:Stop:signal-*|*:error:codex:stop:exit-*|*:error:codex:stop:signal-*|*:error:kiro:PreToolUse:exit-*|*:error:kiro:PreToolUse:signal-*|*:error:kiro:Stop:exit-*|*:error:kiro:Stop:signal-*|*:error:claude:Stop:exit-*|*:error:claude:Stop:signal-*) ;;
    *)
      if ! doflow_bridge_drops_tool_stderr "$policy" "$harness" "$response_event" && [ -n "$err" ]; then printf '%s' "$err" >&2; fi
      ;;
  esac
  doflow_render_response "$harness" "$event" "$DF_BRIDGE_OUTCOME" "$reason" "$status"
  local render_status=$?
  return "$render_status"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  . "$_DOFLOW_BRIDGE_DIR/respond.sh"
  doflow_bridge "${1:-}" "${2:-}" "${3:-}" "${4:-}" "${5:-}"
  exit $?
fi
