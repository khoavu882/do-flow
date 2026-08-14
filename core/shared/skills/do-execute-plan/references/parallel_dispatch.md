# Parallel Subagent Orchestration Reference

Protocol for safe concurrent task execution by specialist subagents:

## Dispatch Rules
1. **Grouping by Phase & Dependency**:
   - Only tasks marked with `[P]` (parallel-safe) in `plan.md` that have no mutual write-set overlap may run concurrently.
2. **Write-Set Precheck**:
   - Verify disjoint file sets before launching concurrent subagents.
   - If two tasks touch the same file, serialize them deterministically.
3. **Phase-Level Quality Review**:
   - Once all tasks in a phase report complete, run an integrated phase quality review before proceeding to the next phase.
   - Max 2 fix iterations per phase review finding.

## Behavioral Posture
For complex multi-step orchestration and execution checkpoints, consult `modes/MODE_Task_Management.md`.
