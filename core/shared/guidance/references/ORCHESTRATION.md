# Orchestration

Use `references/MODEL_SELECTION.md`; follow `PRINCIPLES.md` and `rules/RULES.md` (RULE_02, RULE_04).

## Role and handoff

Decide, verify, keep records. Delegate for what it buys: parallel work on disjoint write sets,
a reader not anchored on your view, a review of your own change, a long task kept out of your
context. Otherwise work in the session; a
subagent costs a context load and a lossy summary each way. Check author and trailers after agent
commits.

## Finishing

Finish what was asked. Work through an ordinary obstacle (error, timeout); report a
deliberate blocker (denied permission, gate) and continue what does not depend on it. Close with a
self-contained report: result, verified, not verified, what awaits the user.

## Brief and tools

Brief with **Goal**, **Context** (`path:line`), **Write set**, **Rules**, **Acceptance and
verification**, **Report format**, and a model/tier. Put long briefs in files. Keep settled scope
in the dispatch; a mid-run message may be ignored, so verify the hand-back. Use a fresh agent when
scope grows.

Choose tools from each task's evidence needs and name local, web, and MCP tools and their
read/write scope in the brief. For current facts or external patterns, use web
search/fetch or documentation/retrieval MCPs; prefer primary sources and return citations or
locators. Routine read-only research needs no user choice. Check a host exposes needed tools;
otherwise gather the source yourself or report the gap.

## Running work

Dispatch due phases before questions. Parallelize only disjoint write sets; keep reviewers read-only.
Use throwaway worktrees for build/container tests and serialize shared stacks. Commit green logical
items with the required author. After a failed/stopped agent, check status, log, stashes, and reflog.

## Asking

Use sensible defaults. Ask one structured question only when a contract or behavior changes beyond
the request; resolve agent questions rather than forwarding a list.
Unattended, that same case halts per RULE_04 (WORKFLOW_HANDOFF.md § Unattended stage): the
recommended default is not adopted.
