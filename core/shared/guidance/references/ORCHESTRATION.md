# Orchestration

Use `references/MODEL_SELECTION.md`; follow `PRINCIPLES.md`, `rules/RULE_02_WORKFLOW.md`, and
`rules/RULE_04_QUESTIONS.md`.

## Role and handoff

Decide, brief, verify, and keep records. Delegate discovery, research, and source/build edits; own
briefs, workflow calls, state, and between-task checks. Edit only own bookkeeping; return verification
defects to an agent. Verify material claims and check author and trailers after agent commits.

## Brief and tools

Brief with **Goal**, **Context** (`path:line`), **Write set**, **Rules**, **Acceptance and
verification**, **Report format**, and a model/tier. Put long briefs in scratch files. Keep settled
scope in the dispatch; mid-run messages may be ignored, so verify the hand-back. Resume finished
agents, and use a fresh agent when scope grows.

The orchestrator chooses tools from each task's evidence needs and names local, web, and MCP tools
and their read/write scope in the brief. For current facts, specifications, or external patterns, use
web search/fetch or relevant documentation/retrieval MCPs; prefer primary sources, fetch support,
and return citations or locators. Routine read-only research needs no user choice. Shared archetypes
omit tool allowlists, so agents may use the session tool pool within host permissions and sandboxes.
Check a host exposes needed tools; otherwise gather the source in the orchestrator or report the gap.
Keep repository search distinct from external research.

## Running work

Dispatch due phases before questions. Parallelize only disjoint write sets; keep reviewers read-only.
Use throwaway worktrees for build/container tests and serialize shared stacks. Commit green logical
items with the required author. After a failed/stopped agent, check status, log, stashes, and reflog.

## Asking

Use sensible defaults. Ask one structured question only when a contract or behavior changes beyond
the request; resolve agent questions rather than forwarding a list.
