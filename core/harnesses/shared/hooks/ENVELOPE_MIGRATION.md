# The normalized hook envelope, and each front door's share of the migration

Every shipped bridge places envelope version 1 under `doflow_event`, beside the native fields. Policies read v1 fields only when `version` is the JSON number `1`; any other version is unsupported and is evaluated as such (IC-034, DEC-030).

`policies/pre-implementation-gate.sh` prefers one normalized event over every native payload
shape (review R7):

```json
{"doflow_event": {"version": 1, "harness": "claude", "event": "PreToolUse", "operation": "edit", "paths": ["src/a.js"], "projectRoot": "/repo", "taskId": "001-auth"}}
```

The envelope is the only policy input contract. A caller outside a shipped bridge must either
send a v1 envelope itself or pipe its native payload through
`bash .doflow/shared/hooks/bridge/bridge.sh <harness> <event> <policy>`.

## Which native event each front door decodes

Per-harness pre-edit event names, from the hook-event inventory compiled 2026-08-28 against each
tool's official docs (cross-checked against tool source where docs were incomplete):

| Harness | Native pre-edit event | Notes for the decoder |
|---|---|---|
| Claude Code | `PreToolUse` | `tool_name` Edit/Write/MultiEdit; `tool_input.file_path` |
| Codex | `PreToolUse` | `apply_patch` carries paths inside a unified diff under `tool_input.command` — the ONE decoder that must parse patch text |
| GitHub Copilot | `preToolUse` | camelCase event names; `permissionRequest` is CLI-only, not fired in the cloud agent |
| OpenCode | `tool.execute.before` | a pluggable hook method, not a sub-event of the generic `event` hook |
| Pi | `tool_call` | The live-observed `cli-extension` pre-implementation gate row blocks. Project-interactive and user-interactive rows remain unknown; interactive loading and project-trust behavior were not observed. `tool_execution_start` is observation-only |
| Antigravity | `PreToolUse` | 5-event surface, `hooks.json` + stdin/stdout JSON contract |

Pi 1.1.0 declares 41 `on()` overloads in its shipped extension types. `tool_call` is the enforcement event; `tool_execution_start` is not a gate.

`operation` is `"edit"` for anything that writes source; a decoder maps its native create/replace/
patch tool vocabulary down to that one word. Non-edit operations may be sent (the policy allows
them through), but sending nothing for a non-edit tool is equally correct and cheaper.

## Version and mixed-install rules

- A missing envelope or version, empty or non-object input, or a missing `contract.sh` is out of
  step. The gate, bash guard and MCP guard deny with `DoFlow hooks out of step; run: doflow update
  -t <harness>`; Stop and context policies exit silently, except the prompt hook emits its `{}`
  no-op. Other envelope versions are unsupported and policies evaluate nothing.
- If a door cannot load `bridge/bridge.sh`, it renders its fixed native out-of-step response. The
  Pi extension blocks with the fixed native out-of-step reason; a present bridge that fails to spawn or answer follows
  the configured bridge-fault behavior.

Other current bridge behavior: Codex Stop crash stderr is suppressed (DEC-037). Stop-check
enforcement is answered from Stop coverage rows (DEC-038). Strict-1 never fault-blocks Stop, though
a real Stop deny still blocks (DEC-039). Bridge capture uses no temporary file, so an unwritable
`TMPDIR` does not turn a gate deny into an allow; background jobs do not hold Stop or SessionStart
open; strict-1 renders native denies without `jq`. `doflow update -t codex -f` re-merges edited
Codex `hooks.json` while keeping user entries (DEC-040).
- Root resolution: `DOFLOW_PROJECT_DIR` beats the envelope's `projectRoot` beats git discovery.
- The pre-implementation gate checks required artifacts and reads run and readiness records; it
  does not consult evidence state.
