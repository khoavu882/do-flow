---
name: do-load
description: "Session lifecycle management — restore compact summary, surface cross-agent handoff info, load native project memory"
argument-hint: "[--refresh] [--resume]"
disable-model-invocation: true
effort: low
---

# do-load

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-load [--refresh] [--resume]
```

## Flag Contract

| Flag | Behaviour |
|------|-----------|
| _(none)_ | Load compact summary if present; skip if absent |
| `--refresh` | Skip summary load entirely — start with a clean context |
| `--resume` | Force-load summary even if already injected this session |

## Metadata
- Category: `session`
- Complexity: `standard`
- Effort: `low`
- Suggested MCP/tooling: native (filesystem) — no MCP server required

## Triggers
- Session initialization and project context loading requests
- Cross-session persistence and memory retrieval needs
- Project activation and context management requirements
- Session lifecycle management and checkpoint loading scenarios

## Behavioral Flow

**Step 1 — Compute project state directory**
- Run `echo "$PWD" | sha256sum | cut -c1-16` to get `{cwd_hash}`
- Project dir: `${XDG_CONFIG_HOME:-~/.config}/doflow/session-env/projects/{cwd_hash}/`

**Step 2 — Cross-agent handoff check**
- Read `{project_dir}/meta.json` if it exists
- If `last_agent` ≠ `claude-code` (or is absent): surface a notice:
  ```
  ⚠ Prior session was run by {last_agent} on {last_active}. Context may differ.
  ```
- Proceed regardless — the notice is informational only

**Step 2a — Compact Summary Recovery**
- Skip entirely when `--refresh` is passed
- Otherwise check `{project_dir}/last-compact-summary.md`
- If present:
  - Read its content
  - Inject as a context block:
    ```
    --- Prior session compact summary ---
    {content}
    --- End compact summary ---
    ```
  - Report: "Compact summary from {compacted_at} loaded"
- If absent: skip silently (fresh project — no prior compaction)

**Step 2b — Uncommitted Warning**
- Check `{project_dir}/uncommitted-warning.txt`
- If present:
  - Surface as a warning: "Prior session ended with uncommitted changes: {content}"
  - Delete the file after surfacing (one-time warning only)
- If absent: skip silently

**Step 3 — Native project memory + context establishment**
- Review the Claude-native memory index (`MEMORY.md`, first 200 lines / 25 KB) and read only the topic files relevant to the current task
- Load durable project context from `agent-docs/` (patterns, mistakes, prior decisions) on demand
- Establish project context and prepare for the development workflow
- Validate loaded context integrity and session readiness

Key behaviors:
- Native file-based memory (Claude `MEMORY.md` index + on-demand topic files + `agent-docs/`) for cross-session persistence — no MCP server required
- Progressive disclosure: load the capped index first, read topic files only when relevant
- Low-overhead initialization (reads only the capped index up front)
- Session lifecycle management coordinating compact summary, session-env state, and project memory

## Key Patterns
- **Project Activation**: Directory analysis → memory retrieval → context establishment
- **Session Restoration**: Checkpoint loading → context validation → workflow preparation
- **Memory Management**: Cross-session persistence → context continuity → development efficiency
- **Performance Critical**: Fast initialization → immediate productivity → session readiness

## Boundaries
**Will:**
- Load project context from native file-based memory (`MEMORY.md` index + `agent-docs/`)
- Provide session lifecycle management with cross-session persistence
- Establish project activation with comprehensive context loading
- Load compact summary from disk and inject into context when available (unless `--refresh`)
- Surface uncommitted-change warnings from prior sessions (one-time, then delete)
- Surface cross-agent handoff notices when `last_agent` differs from current agent

**Will Not:**
- Modify project structure or configuration without explicit permission
- Load context without validating its integrity
- Override existing session context without checkpoint preservation
