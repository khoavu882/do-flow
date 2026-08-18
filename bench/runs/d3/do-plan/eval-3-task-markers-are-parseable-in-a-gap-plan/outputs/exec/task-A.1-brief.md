# Task brief: A.1

> Composed from plan.md, requirement.md and design.md. This brief is your requirements —
> use the exact values it gives, verbatim. You do not need to open the plan.

## The task

A.1 [P] [US-none] Run /do-brainstorm to produce requirement.md with problem, user stories and FR/NFR, closing every [NEEDS CLARIFICATION] it raises — owner: spec-analyst; files: agent-docs/doflow/bench-d3-do-plan-3/requirement.md

Phase: Phase A — Recover the upstream artifacts

Files you own: agent-docs/doflow/bench-d3-do-plan-3/requirement.md

## Where this fits

Run the chain's missing stages in order — `/do-brainstorm` for `requirement.md`, `/do-design` for
`design.md` — record the gap in `state.md` while that happens, then re-run `/do-plan` so the real
feature plan supersedes this one. Nothing under `src/` is touched by any task here.
Task class **feature**, validated by `doflow classify --task-class feature --json` →
`outcome: ACCEPTED`, workflow "Feature Delivery"
(discovery → design → planning → implementation → verification → review), gates gate-0, gate-a,
gate-b. This skill is that workflow's `planning` stage (`readinessTemplate: null`); the
implementation stage's template is `feature`. Signal the class rests on: declared in §3 D4 as an

## Verification bar

- After Phase A: `doflow paths --json` reports both inputs present and `doflow validate` passes on each; commit `docs(doflow): recover requirement and design for bench-d3-do-plan-3`

