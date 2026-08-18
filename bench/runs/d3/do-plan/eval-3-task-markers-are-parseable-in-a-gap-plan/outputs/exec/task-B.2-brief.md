# Task brief: B.2

> Composed from plan.md, requirement.md and design.md. This brief is your requirements —
> use the exact values it gives, verbatim. You do not need to open the plan.

## The task

B.2 [US-none] Re-run /do-plan and supersede this document, moving its content to the new plan's section 9 History, depends B.1 — owner: system-architect; files: agent-docs/doflow/bench-d3-do-plan-3/plan.md

Phase: Phase B — Re-plan on real inputs

Files you own: agent-docs/doflow/bench-d3-do-plan-3/plan.md

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

- After Phase B: this gap plan is superseded; commit `docs(doflow): replace gap plan with a derived feature plan`

