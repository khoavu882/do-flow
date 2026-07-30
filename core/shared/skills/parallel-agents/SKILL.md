---
name: parallel-agents
description: Use when there are 2+ independent tasks, failures, files, subsystems, or investigations that can be handled concurrently without shared state, sequential dependency, or overlapping write scope.
when_to_use: Trigger for unrelated test failures, independent bug reports, parallel codebase investigations, or disjoint implementation slices. Do not use when tasks may share one root cause, require full-system reasoning first, or would edit the same files.
argument-hint: "[optional: describe current tasks to analyze for parallelization]"
user-invocable: true
effort: high
---

# Dispatching Parallel Agents

Use this skill from the main coordination context. Do not fork this skill itself; the coordinator needs the current conversation, repo state, and task constraints to decide whether parallelization is safe.

This skill fans out tasks whose independence is already known. If that classification hasn't
happened yet — an ambiguous or multi-part request where routing itself is the open question — use
`/do-pm` first; it decides *what* to route and *where*, this skill handles *executing* that
routing concurrently once decided.

## How Concurrency Actually Happens

**Dispatches issued together in one response run in parallel. One dispatch per response runs
sequentially.** This is the whole mechanism — batching is not an optimisation applied afterwards,
it is the only thing that makes the work concurrent. A correctly decomposed plan dispatched one
agent per turn is a sequential plan that took the same tokens to write.

## Why Isolation Matters

A dispatched agent inherits none of this conversation — not the history, not the files already read,
not the decisions already made. That is the point, and it cuts both ways:

- **You construct exactly what it needs.** Anything you leave out, it cannot infer. A prompt that
  says "fix the race condition" without naming the file describes a problem the agent cannot find.
- **Your own context stays free for coordination.** Delegating the reading and the edits is what
  leaves you able to integrate several results at the end. Everything you paste into a dispatch, and
  everything an agent prints back, stays resident for the rest of the session and is re-read on
  every later turn — so hand over paths and ask for summaries, not file contents.

**Name a model tier on every dispatch** — see `references/MODEL_SELECTION.md`. An omitted tier
inherits this session's model, typically the most capable and most expensive one available.

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

## Example Dispatch

Requirements above are the checklist; this is what one looks like filled in. Note that it names the
file, quotes the actual failures, states the diagnosis, constrains the fix, and specifies the return.

```text
Fix the 3 failing tests in src/queue/retry.test.ts:

1. "retries a failed job" — expects 3 attempts, observes 1
2. "gives up after maxAttempts" — hangs, never resolves
3. "preserves job payload across retries" — payload is undefined on attempt 2

These look like timing issues in the retry scheduler, but confirm before assuming.

1. Read the test file and the scheduler it exercises
2. Identify the root cause — a real bug, or a test racing the implementation?
3. Fix it by correcting the implementation, or by replacing arbitrary
   timeouts with event-based waiting

Do NOT increase timeouts to make these pass — that hides the cause.
You own src/queue/ only; do not edit other agents' files or revert their work.

Return: root cause, what you changed, files changed, and the test output.
```

## Common Mistakes

| ❌ | ✅ |
|---|---|
| "Fix all the failing tests" — scope so broad the agent wanders | "Fix src/queue/retry.test.ts" — one named file |
| "Fix the race condition" — no location, nothing to act on | Quote the failing names and the error output |
| No ownership stated — the agent refactors adjacent code | "You own src/queue/ only" |
| "Report back when done" — you cannot verify what changed | "Return: root cause, changes, files, test output" |
| One dispatch per response — silently sequential | All dispatches in a single response |
| Model tier omitted — inherits the session's most expensive | Tier named per dispatch, scaled to the task |

## Integration Rules

When agents return:
- Read each summary before accepting changes
- Check for overlapping edits or conflicting assumptions
- Verify the combined result, not only each individual result
- Run the relevant full test or validation command when available
- Resolve conflicts in the main context
- **Spot-check the work itself, not just the summaries.** Agents given similar prompts fail in
  similar ways, so a mistake made once is often made in every result — and reading N summaries that
  agree is not evidence, because the agreement is what a shared wrong assumption produces. Open at
  least one agent's actual diff.

## Output

Report:
- Whether parallelization was used
- The domains dispatched
- Agent ownership boundaries
- Integration outcome
- Verification performed
