---
name: parallel-agents
description: Use when there are 2+ independent tasks, failures, files, subsystems, or investigations that can be handled concurrently without shared state, sequential dependency, or overlapping write scope.
when_to_use: Trigger for unrelated test failures, independent bug reports, parallel codebase investigations, or disjoint implementation slices. Do not use when tasks may share one root cause, require full-system reasoning first, or would edit the same files.
argument-hint: "[optional: describe current tasks to analyze for parallelization]"
disable-model-invocation: false
user-invocable: true
effort: high
---

# Dispatching Parallel Agents

Use this skill from the main coordination context. Do not fork this skill itself; the coordinator needs the current conversation, repo state, and task constraints to decide whether parallelization is safe.

## Decision Gate

Parallelize only when all conditions are true:
- There are two or more distinct problem domains
- Each domain can be understood without results from the others
- Each agent can receive a self-contained prompt
- Write ownership is disjoint, or the work is read-only
- One fix is unlikely to resolve the other domains

Do not parallelize when:
- Failures may share a root cause
- Agents would edit the same files
- One task depends on another task's result
- Full-system reasoning is required before decomposition
- The work is exploratory and domains are not known yet

## Workflow

1. Identify candidate tasks, failures, files, or subsystems.
2. Group them by likely root-cause domain.
3. Check independence and write-scope overlap.
4. Choose agent type:
   - Use explorers for read-only investigation.
   - Use workers only for disjoint implementation scopes.
5. Dispatch one agent per independent domain with a focused prompt.
6. Continue coordination work locally while agents run.
7. Review each result before integrating.
8. Run verification that covers the combined result.

## Agent Prompt Requirements

Each delegated prompt must include:
- Specific scope: one file, subsystem, failure group, or task slice
- Clear goal: what the agent should determine or fix
- Context: relevant errors, test names, paths, or constraints
- Ownership: files or modules the agent may edit, if any
- Non-interference rule: do not revert or overwrite other agents' work
- Expected output: root cause, changes made, files changed, and verification

For implementation agents, assign disjoint write sets. If write ownership cannot be made disjoint, keep the work local or sequence the agents.

## Integration Rules

When agents return:
- Read each summary before accepting changes
- Check for overlapping edits or conflicting assumptions
- Verify the combined result, not only each individual result
- Run the relevant full test or validation command when available
- Resolve conflicts in the main context

## Output

Report:
- Whether parallelization was used
- The domains dispatched
- Agent ownership boundaries
- Integration outcome
- Verification performed
