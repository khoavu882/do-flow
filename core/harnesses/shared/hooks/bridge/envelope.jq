def nonempty($v): if ($v | type) == "string" and $v != "" then $v else null end;
def put($o; $k; $v): if $v == null then $o else $o + {($k): $v} end;
def event_name($fallback): if (.hook_event_name | type) == "string" then .hook_event_name else $fallback end;
def path_values($obj; $keys): first([$keys[] as $k | $obj[$k] | select(type == "string" and length > 0)][]) // null | if . == null then null else [.] end;
def string_value($obj; $keys): first([$keys[] as $k | $obj[$k] | select(type == "string") ][]) // null;
def session_identity($s): {session: nonempty($s)};
def correlation($id;$parent): {toolCallId:nonempty($id),parentToolCallId:nonempty($parent)};
def event_operation($e):
  if $e == "SessionStart" or $e == "agentSpawn" then "session-start"
  elif $e == "SessionEnd" then "session-end"
  elif $e == "UserPromptSubmit" then "prompt"
  elif $e == "Stop" or $e == "stop" then "stop"
  elif $e == "SubagentStart" then "subagent-start"
  elif $e == "SubagentStop" then "subagent-stop"
  elif $e == "PreCompact" or $e == "PreCompress" then "compact"
  elif $e == "PostToolUse" or $e == "AfterTool" then "post-tool"
  else "tool" end;
def canonical_tool($name):
  if ($name | type) != "string" then {operation:"tool"}
  elif ($name | test("^mcp__")) or ($name | test("^mcp_")) then {operation:"mcp",tool:$name}
  elif (["Edit","Write","MultiEdit","apply_patch","write_file","replace","write_to_file","replace_file_content","multi_replace_file_content","edit","write"] | index($name)) != null then {operation:"edit",tool:$name}
  elif (["Bash","run_shell_command","bash"] | index($name)) != null then {operation:"command",tool:$name}
  else {operation:"tool",tool:$name} end;
def decode_claude:
  (canonical_tool(.tool_name // "")) as $t |
  if .tool_name == null then {operation: event_operation($event), identity: session_identity(.session_id)}
  else {operation:$t.operation, tool:$t.tool, paths:(path_values(.tool_input; ["file_path"])), command:(string_value(.tool_input; ["command"])), identity:session_identity(.session_id)} end;
def decode_codex:
  decode_claude as $d |
  if .tool_name == "apply_patch" then $d + {patch:(string_value(.tool_input; ["command"]))} else $d end;
def decode_gemini:
  (canonical_tool(.tool_name // "")) as $t |
  if .tool_name == null then {operation:event_operation($event),identity:session_identity(.session_id)}
  else {operation:$t.operation,tool:$t.tool,paths:(path_values(.tool_input; ["file_path","path"])),command:(string_value(.tool_input; ["command"])),identity:session_identity(.session_id)} end;
def decode_kiro: decode_claude;
def decode_antigravity:
  if .toolCall == null then {operation:event_operation($event),identity:session_identity(.session_id)}
  else (canonical_tool(.toolCall.name // "")) as $t |
    {operation:$t.operation,tool:$t.tool,paths:(path_values(.toolCall.args; ["TargetFile","FilePath","file_path","path"])),command:(string_value(.toolCall.args; ["CommandLine","command"])),identity:session_identity(.session_id)} end;
def decode_pi:
  (canonical_tool(.toolName // "")) as $t |
  {operation:$t.operation,tool:$t.tool,paths:(path_values(.input; ["path"])),command:(string_value(.input; ["command"])),identity:session_identity(.sessionId),correlation:(correlation(.toolCallId;.parentToolCallId))};
if type != "object" then . else
  . as $native |
  ($ENV.DOFLOW_TASK_ID | nonempty(.)) as $task |
  ($ENV.DOFLOW_RUN_ID | nonempty(.)) as $run |
  ($ENV.DOFLOW_ATTEMPT | try tonumber catch null) as $attempt |
  (if $ENV.DOFLOW_SESSION_ROLE == "main" or $ENV.DOFLOW_SESSION_ROLE == "worker" then $ENV.DOFLOW_SESSION_ROLE else null end) as $role |
  (if $harness == "claude" then decode_claude elif $harness == "codex" then decode_codex elif $harness == "gemini" then decode_gemini elif $harness == "kiro" then decode_kiro elif $harness == "antigravity" then decode_antigravity elif $harness == "pi" then decode_pi else {operation:"tool"} end) as $d |
  ({version:1,harness:$harness,event:(event_name($event)),operation:$d.operation,tool:$d.tool,paths:$d.paths,command:$d.command,patch:$d.patch,taskId:$task,
    identity:($d.identity + {run:$run,attempt:$attempt,role:$role} | with_entries(select(.value != null)) | if length > 0 then . else null end),
    correlation:(($d.correlation // {}) | with_entries(select(.value != null)) | if length > 0 then . else null end) } | with_entries(select(.value != null))) as $envelope |
  $native + {doflow_event:$envelope}
end
