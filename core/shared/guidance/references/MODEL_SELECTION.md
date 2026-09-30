# Model Selection — choosing a tier per dispatch

Choose the lowest capable tier. Name it on every dispatch; omission may inherit the session model.

## Capability tiers

Tiers are capabilities; models vary by harness.

| Tier | Work |
|---|---|
| `light` | Verbatim extraction, classification, and mechanical edits. |
| `standard` | Normal coding, debugging, writing, and integration; discovery, code search, evidence gathering, and doc edits unless verbatim. |
| `frontier` | Architecture, difficult debugging, broad refactors, consequential analysis, and reviews. |

Consequential: a verdict or decision gating money paths, a release or test gate, a history rewrite,
a design choice, or unchecked user action. Gather evidence at `standard`; judge at `frontier`.
Split mixed-tier tasks or use the higher tier.

## Choosing a tier for implementation

| Signal | Tier |
|---|---|
| Touches 1–2 files, spec is complete, values given verbatim | `light` |
| Touches several files, has integration concerns, must match existing patterns | `standard` |
| Requires a design decision, or understanding a subsystem before changing it | `frontier` |

## Turn count beats token price

Wall-clock and context cost scale with how many turns a subagent takes, and the cheapest tier
routinely takes several times the turns on multi-step work — costing more overall than the tier
above it. So `standard` is the **floor** for implementers working from a prose description rather
than a fully specified task. Reserve `light` for the two cases where it genuinely wins: the task
text already contains the exact code or values to write, or the change is a single-file mechanical
fix.

## Reviews

Review read-only at `frontier`, using neither the author's agent nor model. Report if unavailable.
Review once per phase or fix batch. Re-review only for an open blocker tests cannot settle, after
asking. For deep review, use two independent reviewers with different lenses; merge their findings.

## Briefs and inheritance

Give `light` and `standard` agents exact files, values or a `path:line` pattern, steps, a check
command, and no open design choices. Give `frontier` agents intent, constraints, evidence, settled
decisions, and choices they own.

Include this line in any brief for an agent that may spawn agents:

Tier policy: `light` verbatim; `standard` routine work/evidence; `frontier` design, hard debugging, broad refactors, consequential judgement/reviews. Name each tier; split mixed work or use higher.

## Escalation inside a fix loop

A fix round that follows a stuck implementer goes at least one tier above the tier that got stuck. A
loop surviving repeated resumes usually means the implementer cannot see its own problem — a fresh
context and a capability bump are the same move, so make both at once rather than spending another
round at the tier that already failed.

## Where per-dispatch choice is unavailable

Some harnesses cannot express a model per dispatch: the choice lives in the dispatched agent's own
definition instead. There the policy is satisfied **declaratively** — fix the tier in the agent
definition, and treat an unset tier as a defect rather than as inheritance. On at least one harness
the session's model selection provably does not reach its subagents, so leaving it unset is not
equivalent to inheriting it; it is an unpredictable choice made elsewhere.

Consult the harness's own capability notes before assuming which form applies.
