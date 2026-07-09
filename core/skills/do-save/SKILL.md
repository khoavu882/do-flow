---
name: do-save
description: "Session lifecycle management with native file-based persistence for session context"
argument-hint: "[--type session|learnings|context|all] [--summarize] [--checkpoint]"
disable-model-invocation: true
effort: low
---

# do-save

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-save [--type session|learnings|context|all] [--summarize] [--checkpoint]
```

## Metadata
- Category: `session`
- Complexity: `standard`
- Effort: `low`
- Suggested MCP/tooling: native (filesystem) — no MCP server required

## Triggers
- Session completion and project context persistence needs
- Cross-session memory management and checkpoint creation requests
- Project understanding preservation and discovery archival scenarios
- Session lifecycle management and progress tracking requirements

## Behavioral Flow
1. **Analyze**: Examine session progress and identify discoveries worth preserving
2. **Persist**: Save session context and learnings to native memory — `agent-docs/` markdown (patterns/mistakes), durable facts via Claude memory, and the session-env compact summary
3. **Checkpoint**: Create recovery points for complex sessions and progress tracking
4. **Validate**: Ensure session data integrity and cross-session compatibility
5. **Prepare**: Ready session context for seamless continuation in future sessions

Key behaviors:
- Native file-based persistence (`agent-docs/` + Claude `MEMORY.md` + session-env compact summary) — no MCP server required
- Automatic checkpoint creation based on session progress and critical tasks
- Session context preservation with comprehensive discovery and pattern archival
- Cross-session learning with accumulated project insights and technical decisions

## Key Patterns
- **Session Preservation**: Discovery analysis → memory persistence → checkpoint creation
- **Cross-Session Learning**: Context accumulation → pattern archival → enhanced project understanding
- **Progress Tracking**: Task completion → automatic checkpoints → session continuity
- **Recovery Planning**: State preservation → checkpoint validation → restoration readiness

## Boundaries
**Will:**
- Save session context to native file-based memory for cross-session persistence
- Create automatic checkpoints based on session progress and task completion
- Preserve discoveries and patterns for enhanced project understanding

**Will Not:**
- Persist session data outside the project's native memory locations (`agent-docs/`, Claude memory, session-env)
- Save session data without validation and integrity verification
- Override existing session context without proper checkpoint preservation
