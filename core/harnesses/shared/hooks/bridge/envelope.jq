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
def canonical_tool($name; $harness):
  if ($name | type) != "string" then {operation:"tool"}
  elif (($harness == "claude" or $harness == "codex" or $harness == "kiro") and ($name | test("^mcp__"))) or (($harness == "gemini" or $harness == "antigravity") and ($name | test("^mcp_"))) or ($harness == "pi" and ($name | test("^mcp__"))) then {operation:"mcp",tool:$name}
  elif (($harness == "claude" or $harness == "codex" or $harness == "kiro") and (["Edit","Write","MultiEdit","apply_patch"] | index($name)) != null) or ($harness == "gemini" and (["write_file","replace"] | index($name)) != null) or ($harness == "antigravity" and (["write_to_file","replace_file_content","multi_replace_file_content","edit_file","write_file","create_file","replace_file","replace","Edit","Write","MultiEdit","apply_patch"] | index($name)) != null) or ($harness == "pi" and (["edit","write"] | index($name)) != null) then {operation:"edit",tool:$name}
  elif (($harness == "claude" or $harness == "codex" or $harness == "kiro") and $name == "Bash") or ($harness == "gemini" and $name == "run_shell_command") or ($harness == "antigravity" and (["run_command","run_shell_command","Bash","bash"] | index($name)) != null) or ($harness == "pi" and $name == "bash") then {operation:"command",tool:$name}
  else {operation:"tool",tool:$name} end;
def decode_claude:
  (canonical_tool(.tool_name // ""; "claude")) as $t |
  if .tool_name == null then {operation: event_operation($event), identity: session_identity(.session_id)}
  else {operation:$t.operation, tool:$t.tool, paths:(if $t.operation == "edit" then path_values(.tool_input; ["file_path"]) else null end), command:(if $t.operation == "command" then string_value(.tool_input; ["command"]) else null end), identity:session_identity(.session_id)} end;
def decode_codex:
  decode_claude as $d |
  if .tool_name == "apply_patch" then $d + {patch:(string_value(.tool_input; ["command"]))} else $d end;
def decode_gemini:
  (canonical_tool(.tool_name // ""; "gemini")) as $t |
  if .tool_name == null then {operation:event_operation($event),identity:session_identity(.session_id)}
  else {operation:$t.operation,tool:$t.tool,paths:(if $t.operation == "edit" then path_values(.tool_input; ["file_path","path"]) else null end),command:(if $t.operation == "command" then string_value(.tool_input; ["command"]) else null end),identity:session_identity(.session_id)} end;
def decode_kiro:
  (if ((.tool_name // "") | type) == "string" and ((.tool_name // "") | startswith("mcp_")) then {operation:"mcp",tool:.tool_name}
   elif ((.tool_name // "") | type) == "string" and ((.tool_name // "") | test("^@[^/]+/.+")) then
     ((.tool_name | capture("^@(?<server>[^/]+)/(?<tool>.+)$")) as $m | {operation:"mcp",tool:("mcp__" + $m.server + "__" + $m.tool)})
   else canonical_tool(.tool_name // ""; "kiro") end) as $t |
  if .tool_name == null then {operation:event_operation($event),identity:session_identity(.session_id)}
  else {operation:$t.operation,tool:$t.tool,paths:(if $t.operation == "edit" then path_values(.tool_input; ["file_path"]) else null end),command:(if $t.operation == "command" then string_value(.tool_input; ["command"]) else null end),identity:session_identity(.session_id)} end;
def decode_antigravity:
  if .toolCall == null then {operation:event_operation($event),identity:session_identity(.session_id)}
  else (canonical_tool(.toolCall.name // ""; "antigravity")) as $t |
    {operation:$t.operation,tool:$t.tool,paths:(if $t.operation == "edit" then path_values(.toolCall.args; ["AbsolutePath","TargetFile","Path","file_path","path"]) else null end),command:(if $t.operation == "command" then string_value(.toolCall.args; ["CommandLine","command"]) else null end),identity:session_identity(.session_id)} end;
def decode_pi:
  (canonical_tool(.toolName // ""; "pi")) as $t |
  {operation:$t.operation,tool:$t.tool,paths:(if $t.operation == "edit" then path_values(.input; ["path"]) else null end),command:(if $t.operation == "command" then string_value(.input; ["command"]) else null end),identity:session_identity(.sessionId),correlation:(correlation(.toolCallId;.parentToolCallId))};
if ($ARGS.named.mode // "encode") == "minimal" then {doflow_event:{version:(1),harness:$harness,event:(event_name($event)),operation:event_operation($event)}} elif type != "object" then . else
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
