def nonempty($v): if ($v | type) == "string" and $v != "" then $v else null end;
def valid_model_id($v):
  ($v | type) == "string" and ($v | length) >= 1 and ($v | length) <= 120 and
  ($v | test("^[A-Za-z0-9][A-Za-z0-9 ._:/@()\\[\\]#+-]*$")) and
  (($v | endswith(" ")) | not);
def model_identity($v):
  if ($v | type) != "string" then {}
  elif valid_model_id($v) then {model:$v}
  else {modelUnparsed:true} end;
# Same reading as identity.ts and policies/identity.sh: ASCII-lowercased, main or worker kept, any other non-empty value is worker. Unset or empty stays null.
def norm_role($v): if ($v | type) == "string" and $v != "" then ($v | ascii_downcase) as $l | if $l == "main" or $l == "worker" then $l else "worker" end else null end;
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
  elif $e == "PreCompact" then "compact"
  elif $e == "PostToolUse" then "post-tool"
  else "tool" end;
def canonical_tool($name; $harness):
  if ($name | type) != "string" then {operation:"tool"}
  elif (($harness == "claude" or $harness == "codex" or $harness == "kiro" or $harness == "copilot") and ($name | test("^mcp__"))) or ($harness == "antigravity" and ($name | test("^mcp_"))) or ($harness == "pi" and ($name | test("^mcp__"))) then {operation:"mcp",tool:$name}
  elif (($harness == "claude" or $harness == "codex" or $harness == "kiro" or $harness == "copilot") and (["Edit","Write","MultiEdit","apply_patch"] | index($name)) != null) or ($harness == "antigravity" and (["write_to_file","replace_file_content","multi_replace_file_content","edit_file","write_file","create_file","replace_file","replace","Edit","Write","MultiEdit","apply_patch"] | index($name)) != null) or ($harness == "pi" and (["edit","write"] | index($name)) != null) then {operation:"edit",tool:$name}
  elif (($harness == "claude" or $harness == "codex" or $harness == "kiro" or $harness == "copilot") and $name == "Bash") or ($harness == "antigravity" and (["run_command","run_shell_command","Bash","bash"] | index($name)) != null) or ($harness == "pi" and $name == "bash") then {operation:"command",tool:$name}
  else {operation:"tool",tool:$name} end;
def decode_claude:
  (canonical_tool(.tool_name // ""; "claude")) as $t |
  (if event_name($event) == "SessionStart" then model_identity(.model) else {} end) as $model |
  if .tool_name == null then {operation: event_operation($event), identity: (session_identity(.session_id) + $model)}
  else {operation:$t.operation, tool:$t.tool, paths:(if $t.operation == "edit" then path_values(.tool_input; ["file_path"]) else null end), command:(if $t.operation == "command" then string_value(.tool_input; ["command"]) else null end), identity:(session_identity(.session_id) + $model)} end;
def decode_codex:
  decode_claude as $d |
  (model_identity(.model)) as $model |
  (if .tool_name == "apply_patch" then $d + {patch:(string_value(.tool_input; ["command"]))} else $d end) |
  .identity += $model;
# Copilot CLI payloads (normalised to the Claude shape by the front door) carry no model, so the
# envelope names none, whatever a payload happens to hold under .model.
def decode_copilot:
  decode_claude as $d |
  (if .tool_name == "apply_patch" then $d + {patch:(string_value(.tool_input; ["command"]))} else $d end) |
  .identity |= del(.model, .modelUnparsed);
def decode_kiro:
  (if ((.tool_name // "") | type) == "string" and ((.tool_name // "") | startswith("mcp_")) then {operation:"mcp",tool:.tool_name}
   elif ((.tool_name // "") | type) == "string" and ((.tool_name // "") | test("^@[^/]+/.+")) then
     ((.tool_name | capture("^@(?<server>[^/]+)/(?<tool>.+)$")) as $m | {operation:"mcp",tool:("mcp__" + $m.server + "__" + $m.tool)})
   else canonical_tool(.tool_name // ""; "kiro") end) as $t |
  if .tool_name == null then {operation:event_operation($event),identity:session_identity(.session_id)}
  else {operation:$t.operation,tool:$t.tool,paths:(if $t.operation == "edit" then path_values(.tool_input; ["file_path"]) else null end),command:(if $t.operation == "command" then string_value(.tool_input; ["command"]) else null end),identity:session_identity(.session_id)} end;
def decode_antigravity:
  (model_identity(.modelName)) as $model |
  (session_identity(if (.session_id | type) == "string" and .session_id != "" then .session_id else .conversationId end) + $model) as $identity |
  if .toolCall == null then {operation:event_operation($event),identity:$identity}
  else (canonical_tool(.toolCall.name // ""; "antigravity")) as $t |
    {operation:$t.operation,tool:$t.tool,paths:(if $t.operation == "edit" then path_values(.toolCall.args; ["AbsolutePath","TargetFile","Path","file_path","path"]) else null end),command:(if $t.operation == "command" then string_value(.toolCall.args; ["CommandLine","command"]) else null end),identity:$identity} end;
def decode_pi:
  (canonical_tool(.toolName // ""; "pi")) as $t |
  {operation:$t.operation,tool:$t.tool,paths:(if $t.operation == "edit" then path_values(.input; ["path"]) else null end),command:(if $t.operation == "command" then string_value(.input; ["command"]) else null end),identity:(session_identity(.sessionId) + model_identity(.model)),correlation:(correlation(.toolCallId;.parentToolCallId))};
# IC-005: only this closed vocabulary enters telemetry. The policy envelope keeps its command.
def command_segment_class:
  gsub("^\\s+|\\s+$"; "") | sub("^([A-Za-z_][A-Za-z0-9_]*=[^\\s]*\\s+)+"; "") |
  if test("^cd\\s+") then "none"
  elif test("^(doflow-run|doflow) verify( |$)") then "verify.verb"
  elif test("^(npm|pnpm|yarn|bun)( run)? test$|^node --test( --[^ ]+)*( test/?)?$|^pytest( -[^ ]+)*$|^go test \\./\\.\\.\\.$|^cargo test$") then "test.full"
  elif test("^(npm|pnpm|yarn|bun)( run)? test |^node --test |^pytest |^go test |^cargo test ") then "test.scoped"
  elif test("(^| )(jest|vitest|mocha|playwright test)( |$)|^(npm|pnpm|yarn|bun) run test:[^ ]+") then "test.other"
  else "none" end;
def classify($cmd):
  try (if ($cmd | type) != "string" then "none" else
    ["verify.verb", "test.full", "test.scoped", "test.other", "none"] as $rank |
    [$cmd | splits("&&|\\|\\||;|\\|") | command_segment_class | . as $c | $rank | index($c)] |
    (min // 4) as $best | $rank[$best]
  end) catch "none";
# Telemetry tuple (IC-003): the first line in explicit `--arg mode encode`, read and stripped by
# bridge.sh. Every telemetry expression sits inside the `try`, so a fault here yields {dft:1} and
# never reaches the envelope; exactly one value comes out whatever the inside yields.
def dft_token($v): if ($v | type) == "string" and ($v | test("^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")) then $v else null end;
def dft_id($v): if ($v | type) == "string" and ($v | test("^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$")) then $v else null end;
def dft_tuple_base($native; $d):
  if $ENV.DOFLOW_TELEMETRY == "off" then {dft:1} else
  [try (now as $n | ($n | floor) as $s |
    {dft:1, date:($s | strftime("%Y-%m-%d")),
     timestamp:(($s | strftime("%Y-%m-%dT%H:%M:%S")) + "." + (((($n - $s) * 1000 | floor) + 1000 | tostring)[1:]) + "Z"),
     session:dft_token($d.identity.session),
     tool:(if $d.operation == "mcp" then null else dft_token($d.tool) end),
     tool_call_id:dft_token(if $harness == "pi" then $native.toolCallId elif $harness == "claude" or $harness == "codex" then $native.tool_use_id else null end),
     run:(dft_id($ENV.DOFLOW_RUN_ID) | if . == "local" then null else . end),
     lineage:dft_id($ENV.DOFLOW_LINEAGE_ID),
     attempt:($ENV.DOFLOW_ATTEMPT | if type == "string" and test("^[1-9][0-9]{0,3}$") then tonumber else null end),
     role:norm_role($ENV.DOFLOW_SESSION_ROLE),
     worker_run:($ENV.DOFLOW_WORKER_RUN | if type == "string" and test("\\Aw-[0-9a-f]{12}\\z") then . else null end)}) catch {dft:1}]
  | if length == 1 then .[0] else {dft:1} end end;
def dft_tuple($native; $d):
  dft_tuple_base($native; $d) |
  [try (
    if . == {dft:1} then . else
      (if $ARGS.named.mode == "observe" then . + {duration_ms:null, tool_duration_ms:($native.duration_ms |
        if type == "number" and . >= 0 and . <= 9007199254740991 and . == floor then . else null end)} else . + {tool_duration_ms:null} end) |
      if ($policy == "pre-bash-guard" or $ARGS.named.mode == "observe") and $d.operation == "command"
      then . + {test_class:classify($d.command)} else . + {test_class:null} end
    end) catch {dft:1}] | if length == 1 then .[0] else {dft:1} end;
if ($ARGS.named.mode // "encode") == "minimal" then {doflow_event:{version:(1),harness:$harness,event:(event_name($event)),operation:event_operation($event)}} elif type != "object" then . else
  . as $native |
  ($ENV.DOFLOW_TASK_ID | nonempty(.)) as $task |
  ($ENV.DOFLOW_RUN_ID | nonempty(.)) as $run |
  ($ENV.DOFLOW_ATTEMPT | try tonumber catch null) as $attempt |
  ($ENV.DOFLOW_LINEAGE_ID | nonempty(.)) as $lineage |
  ($ENV.DOFLOW_WORKTREE | nonempty(.)) as $worktree |
  norm_role($ENV.DOFLOW_SESSION_ROLE) as $role |
  (if $harness == "claude" then decode_claude elif $harness == "codex" then decode_codex elif $harness == "kiro" then decode_kiro elif $harness == "copilot" then decode_copilot elif $harness == "antigravity" then decode_antigravity elif $harness == "pi" then decode_pi else {operation:"tool"} end) as $d |
  if $ARGS.named.mode == "observe" then
    if $harness == "claude" and $d.operation == "command" and $native.hook_event_name == $event and
      ($event == "PostToolUse" or $event == "PostToolUseFailure")
    then dft_tuple($native; $d) else {dft:1} end
  else
  ({version:1,harness:$harness,event:(event_name($event)),operation:$d.operation,tool:$d.tool,paths:$d.paths,command:$d.command,patch:$d.patch,taskId:$task,
    identity:($d.identity + {run:$run,attempt:$attempt,lineage:$lineage,role:$role,worktree:$worktree} | with_entries(select(.value != null)) | if length > 0 then . else null end),
    correlation:(($d.correlation // {}) | with_entries(select(.value != null)) | if length > 0 then . else null end) } | with_entries(select(.value != null))) as $envelope |
  (if $ARGS.named.mode == "encode" then dft_tuple($native; $d) else empty end),
  $native + {doflow_event:$envelope}
  end
end
