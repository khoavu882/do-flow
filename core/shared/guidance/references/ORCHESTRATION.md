# Orchestration

Use `references/MODEL_SELECTION.md`; follow `PRINCIPLES.md` and `rules/RULES.md` (RULE_02, RULE_04).

## Role and handoff

Decide, verify, keep records. Check author and trailers after agent commits.

## Finishing

Finish what was asked. Work through an ordinary obstacle (error, timeout); report a
deliberate blocker (denied permission, gate) and continue what does not depend on it. Close with a
self-contained report: result, verified, not verified, what awaits the user.

## Brief and tools

Write each brief in the prompt frame (`"$DOFLOW" prompt-frame --action guide` prints
`PROMPT_FRAME.md`). Put long briefs in files. Keep settled scope
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
Unattended, adopt the recommended option and record its undo (WORKFLOW_HANDOFF.md § Unattended stage).
