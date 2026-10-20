# Task Management Mode

**Purpose**: Hierarchical task organization for complex multi-step operations, using DoFlow's own
native tracking mechanisms — no external memory-server dependency.

## Activation Triggers
- Operations with >3 steps requiring coordination
- Multiple file/directory scope (>2 directories OR >3 files)
- Complex dependencies requiring phases
- Quality improvement requests: polish, refine, enhance

## Task Hierarchy

📋 **Plan** → task-list goal-level entry, or `plan.md`'s Approach when inside a doflow-chain feature
→ 🎯 **Phase** → task-list entry per phase, or `plan.md` §8's `### Phase X` heading
  → 📦 **Task** → task-list entry per deliverable, or `plan.md`'s `- [ ]` task line
    → ✓ **Todo** → task-list entry, marked `completed` immediately on finishing it

## Task Tracking Operations

> **Two tiers, not one.** The session task list (Claude Code's `TodoWrite`) is session-local — it does not survive a compact or a new
> session. For anything that must resume after an interruption, the doflow chain's own
> `agent-docs/doflow/<slug>/state.md` (Completed / In Progress / Blocked / Next Action) is the
> cross-session record — the same file `/do-execute-plan` reads and writes at every checkpoint.
> A task outside an active doflow-chain feature has no cross-session record by default; say so
> plainly rather than assuming persistence that isn't there.
>
> **Note (DoFlow development only):** when the active task is developing DoFlow itself
> (`core/`/`src/`), `.doflow/state/ledger.json` and its `recovery/` journal are a *third*,
> unrelated thing — DoFlow's own install-ownership bookkeeping, not a task-tracking record. Don't
> conflate it with `state.md` or read/write it as if it were a todo.

### Session Start
```
1. Check for an active doflow-chain feature (agent-docs/doflow/<slug>/state.md) → read it if present
2. Write the session task list, seeded from state.md's "Next Action" if resuming
3. No state.md present → this is a same-session-only task; proceed with the session task list alone
```

### During Execution
```
1. Task list: exactly one task "in_progress" at a time
2. Mark a task "completed" immediately on finishing it — never batch completions
3. Inside a doflow-chain feature: check off the matching plan.md task and update state.md's
   Completed/In Progress sections at each checkpoint, not just at session end
```

### Session End
```
1. Assess completion honestly — anything not actually finished stays "pending"/"in_progress"
2. Inside a doflow-chain feature: update state.md's Next Action so a resumed session can pick
   up without re-deriving context
```

## Execution Pattern

1. **Load**: read `state.md` if this task belongs to an active doflow-chain feature; otherwise
   start fresh with an empty session task list
2. **Plan**: write the session task list with the full task breakdown
3. **Track**: the session task list is the single source of truth for this session; `plan.md` checkboxes +
   `state.md` are what survives past it
4. **Execute**: update the session task list in real time, not in batches
5. **Checkpoint**: for a doflow-chain feature, update `state.md` after each phase/checkpoint
6. **Complete**: final task-list pass with everything `completed`; final `state.md` update if
   applicable

## Examples

### Resume after an interruption (inside a doflow-chain feature)
```
Read agent-docs/doflow/<slug>/state.md → "In Progress: middleware and endpoints (Phase 2)"
Session task list: seed it from state.md's In Progress + Next Action
Work → mark each item completed as it finishes → update state.md at the phase checkpoint
```
