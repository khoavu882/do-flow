# The normalized hook envelope, and each front door's share of the migration

`policies/pre-implementation-gate.sh` prefers one normalized event over every native payload
shape (review R7):

```json
{"doflow_event": {"operation": "edit", "paths": ["src/a.js"], "projectRoot": "/repo", "taskId": "001-auth"}}
```

A front door that sends this envelope needs none of the policy's legacy union parsing — the four
tool-name spellings, five file-path field names, and Codex `apply_patch` diff extraction exist
only for front doors still forwarding raw native payloads. Each adapter that adopts the envelope
retires its share of that union; when the last one does, the union decoder is deleted.

## Which native event each front door decodes

Per-harness pre-edit event names, from the hook-event inventory compiled 2026-08-28 against each
tool's official docs (cross-checked against tool source where docs were incomplete):

| Harness | Native pre-edit event | Notes for the decoder |
|---|---|---|
| Claude Code | `PreToolUse` | `tool_name` Edit/Write/MultiEdit; `tool_input.file_path` |
| Codex | `PreToolUse` | `apply_patch` carries paths inside a unified diff under `tool_input.command` — the ONE decoder that must parse patch text |
| Gemini CLI | `BeforeTool` | also offers `BeforeToolSelection` (pre-selection restriction), which the gate does not use |
| GitHub Copilot | `preToolUse` | camelCase event names; `permissionRequest` is CLI-only, not fired in the cloud agent |
| OpenCode | `tool.execute.before` | a pluggable hook method, not a sub-event of the generic `event` hook |
| Pi | `tool_execution_start` | Pi's 36-event surface also exposes `tool_call`; the execution-start event is the gate's anchor |
| Antigravity | `PreToolUse` | 5-event surface, `hooks.json` + stdin/stdout JSON contract |

`operation` is `"edit"` for anything that writes source; a decoder maps its native create/replace/
patch tool vocabulary down to that one word. Non-edit operations may be sent (the policy allows
them through), but sending nothing for a non-edit tool is equally correct and cheaper.

## Rules that hold on both paths

- The envelope, when present, **outranks** any native fields beside it.
- Root resolution: `DOFLOW_PROJECT_DIR` beats the envelope's `projectRoot` beats git discovery.
- The policy remains a pure file-existence gate (FR-012): the envelope changes how it hears about
  an edit, never what it decides, and it must never consult readiness or evidence state.
