#!/usr/bin/env bash
# Copilot CLI front-door helpers: translate a camelCase Copilot hook payload into the canonical
# Claude-style payload the shared lifecycle bridge and policies read, and render nothing else.
# Installed by the doflow CLI and overwritten on update; do not edit an installed copy.
#
# Payload facts are from the live capture of 2026-10-27 (Copilot CLI 1.0.103), not the docs alone:
#   - camelCase fields: sessionId, toolName, toolArgs, transcriptPath, agentId, agentType, parentAgentId
#   - toolArgs arrives as a JSON OBJECT for bash/skill/task and as a raw STRING for apply_patch (the
#     freeform patch text). The docs type it `unknown`; this accepts an object, a JSON string and a
#     raw string.
#   - tool names are lowercase: bash, apply_patch, edit, task, skill

# copilot_bridge_payload <event>: native payload on stdin, canonical payload on stdout. <event> is
# the PascalCase name the bridge and policies know (PreToolUse, Stop, SessionStart, ...). When jq is
# missing or rejects the payload the original payload is printed unchanged.
#   - tool_name: bash|powershell -> Bash, edit -> Edit, create -> Write, apply_patch stays; any
#     other name passes through unchanged, so an unmapped tool fails open as it does without a bridge
#   - tool_input: toolArgs as an object (a JSON string is parsed; any other string becomes
#     {command: <string>}, which is where the shared policies read an apply_patch body); for Edit
#     and Write tool_input.file_path is copied from path when absent
#   - response (subagentStop) -> last_assistant_message
copilot_bridge_payload() {
  local event="${1:-}" payload rewritten
  payload=$(cat)
  if command -v jq >/dev/null 2>&1 \
    && rewritten=$(printf '%s' "$payload" | jq -c --arg event "$event" '
      (.toolName // .tool_name // "") as $raw
      | ($raw | ascii_downcase) as $t
      | (if $t == "bash" or $t == "powershell" then "Bash"
         elif $t == "edit" then "Edit"
         elif $t == "create" then "Write"
         else $raw end) as $name
      | ((.toolArgs // .tool_input) as $a
         | if $a == null then null
           elif ($a | type) == "object" then $a
           elif ($a | type) == "string" then ((try ($a | fromjson) catch $a) | if type == "object" then . else {command: $a} end)
           else {command: ($a | tostring)} end) as $input
      | (if ($name == "Edit" or $name == "Write") and ($input | type) == "object" and ($input.file_path == null) and ($input.path != null)
         then $input + {file_path: $input.path} else $input end) as $input
      | {
          hook_event_name: $event,
          session_id: (.sessionId // .session_id),
          cwd: .cwd,
          transcript_path: (.transcriptPath // .transcript_path),
          stop_hook_active: .stop_hook_active,
          stop_reason: (.stopReason // .stop_reason),
          source: .source,
          reason: .reason,
          prompt: .prompt,
          initial_prompt: (.initialPrompt // .initial_prompt),
          agent_id: (.agentId // .agent_id),
          agent_type: (.agentType // .agent_type),
          agent_name: (.agentName // .agent_name),
          parent_agent_id: (.parentAgentId // .parent_agent_id),
          last_assistant_message: (.response // .last_assistant_message),
          tool_name: (if $raw == "" then null else $name end),
          tool_input: $input,
          tool_result: (.toolResult // .tool_result)
        }
      | with_entries(select(.value != null))
    ' 2>/dev/null) \
    && [ -n "$rewritten" ]; then
    printf '%s\n' "$rewritten"
  else
    printf '%s\n' "$payload"
  fi
}

# copilot_front_door <script-dir> <event> <policy> <fail>: run one shared policy through the bridge.
# <fail> is `deny` for a pre-tool policy (a missing bridge denies the tool call, as Copilot's
# preToolUse hooks are fail-closed on a non-zero exit anyway) or `open` for every other event.
copilot_front_door() {
  local dir="$1" event="$2" policy="$3" fail="${4:-open}" raw payload bridge status=0
  raw=$(cat)
  if [ "$event" = Stop ] && command -v jq >/dev/null 2>&1 \
    && [ -n "$(printf '%s' "$raw" | jq -r '.agentId // .agent_id // empty' 2>/dev/null)" ]; then
    return 0   # a subagent's own stop; SubagentStop covers it, as it does for Claude
  fi
  payload=$(copilot_bridge_payload "$event" <<<"$raw")
  bridge="$dir/../../.doflow/shared/hooks/bridge/bridge.sh"
  if [ ! -f "$bridge" ] || ! . "$bridge" 2>/dev/null; then
    if [ "$fail" = deny ]; then
      printf '%s\n' '{"permissionDecision":"deny","permissionDecisionReason":"[doflow] shared hooks lack the bridge; run: doflow update -t copilot"}'
    fi
    return 0
  fi
  doflow_bridge copilot "$event" "$policy" <<<"$payload" || status=$?
  return "$status"
}
