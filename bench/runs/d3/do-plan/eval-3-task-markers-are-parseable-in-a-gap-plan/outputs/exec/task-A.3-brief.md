# Task brief: A.3

> Composed from plan.md, requirement.md and design.md. This brief is your requirements —
> use the exact values it gives, verbatim. You do not need to open the plan.

## The task

A.3 [US-none] Run /do-design against the recovered requirement to produce design.md with C1/C2 diagrams, components, data contracts and risks, depends A.1 — owner: system-architect; files: agent-docs/doflow/bench-d3-do-plan-3/design.md

Phase: Phase A — Recover the upstream artifacts

Files you own: agent-docs/doflow/bench-d3-do-plan-3/design.md

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

