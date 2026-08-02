# Model Selection — choosing a tier per dispatch

How a skill that dispatches subagents picks the model for each one. Loaded on demand by the skills
that dispatch — it has no other trigger and is not part of any always-loaded context.

**The rule:** use the lowest capability tier that can do the job, and name it explicitly on every
dispatch.

## Tiers are capabilities, not model names

Tiers are described by capability because the available models differ per harness and turn over
faster than shipped guidance does. A named model here would be stale advice at best, and wrong on
any harness that never offered it.

| Tier | What it is for |
|---|---|
| `light` | Transcription and mechanical work — the exact values to write are already in the task |
| `standard` | Integration, pattern matching, debugging — judgement within a known shape |
| `frontier` | Architecture, design decisions, broad codebase reasoning, final whole-scope review |

## Choosing a tier for implementation

| Signal | Tier |
|---|---|
| Touches 1–2 files, spec is complete, values given verbatim | `light` |
| Touches several files, has integration concerns, must match existing patterns | `standard` |
| Requires a design decision, or understanding a subsystem before changing it | `frontier` |

## Choosing a tier for review

Scale the reviewer to the diff's size, complexity and risk — never default it high. A small
mechanical diff does not need the top tier; a subtle concurrency, auth, or data-migration change
does. A re-review scoped to one small fix diff sits at `light`–`standard`. A final whole-scope
review sits at `frontier`, not at whatever the session happens to be running.

## Turn count beats token price

Wall-clock and context cost scale with how many turns a subagent takes, and the cheapest tier
routinely takes several times the turns on multi-step work — costing more overall than the tier
above it. So `standard` is the **floor** for reviewers, and for implementers working from a prose
description rather than a fully specified task. Reserve `light` for the two cases where it genuinely
wins: the task text already contains the exact code or values to write, or the change is a
single-file mechanical fix.

## Escalation inside a fix loop

A fix round that follows a stuck implementer goes at least one tier above the tier that got stuck. A
loop surviving repeated resumes usually means the implementer cannot see its own problem — a fresh
context and a capability bump are the same move, so make both at once rather than spending another
round at the tier that already failed.

## Always name the tier

An omitted model inherits the session's model — typically the most capable and most expensive one
available — which silently defeats everything above. A dispatch with no tier named is not "using the
default"; it is opting out of this policy. Every dispatch names its tier.

## Where per-dispatch choice is unavailable

Some harnesses cannot express a model per dispatch: the choice lives in the dispatched agent's own
definition instead. There the policy is satisfied **declaratively** — fix the tier in the agent
definition, and treat an unset tier as a defect rather than as inheritance. On at least one harness
the session's model selection provably does not reach its subagents, so leaving it unset is not
equivalent to inheriting it; it is an unpredictable choice made elsewhere.

Consult the harness's own capability notes before assuming which form applies.
