# The normalized hook envelope, and each front door's share of the migration

Every shipped bridge places envelope version 1 under `doflow_event`, beside the native fields. Policies read v1 fields only when `version` is the JSON number `1`; an absent envelope or version uses the accepted legacy v0/native-field path, while any other version is unsupported and is evaluated as such (IC-003, DEC-003).

`policies/pre-implementation-gate.sh` prefers one normalized event over every native payload
shape (review R7):

```json
{"doflow_event": {"version": 1, "harness": "claude", "event": "PreToolUse", "operation": "edit", "paths": ["src/a.js"], "projectRoot": "/repo", "taskId": "001-auth"}}
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
| Pi | `tool_call` | The extension is wired to evaluate matching calls before execution; whether it blocks in live use remains unverified pending the V.3 probe. Coverage rows remain `unknown` until then; `tool_execution_start` is observation-only |
| Antigravity | `PreToolUse` | 5-event surface, `hooks.json` + stdin/stdout JSON contract |

Pi 1.1.0 declares 41 `on()` overloads in its shipped extension types. `tool_call` is the enforcement event; `tool_execution_start` is not a gate.

`operation` is `"edit"` for anything that writes source; a decoder maps its native create/replace/
patch tool vocabulary down to that one word. Non-edit operations may be sent (the policy allows
them through), but sending nothing for a non-edit tool is equally correct and cheaper.

## Rules that hold on both paths

- The envelope, when present, **outranks** any native fields beside it.
- Root resolution: `DOFLOW_PROJECT_DIR` beats the envelope's `projectRoot` beats git discovery.
- The envelope changes how the policy hears about an edit. The pre-implementation gate checks the
  required artifacts and reads run and readiness records; it does not consult evidence state.
