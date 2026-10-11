# Model Selection — choosing a tier per dispatch

Choose the lowest capable tier. Name it on every dispatch, and pass `model:` whenever the API
supports it. Never assume the parent's choice reaches subagents; where per-call selection is
unavailable, set the model in the agent definition. An unset tier is a defect.

## Capability tiers

Tiers describe capability; model names vary by harness. Map each to the harness's supported
identifier at dispatch; never hardcode a vendor model name here.

| Tier | Work |
|---|---|
| `light` | Verbatim extraction, classification, mechanical or high-volume work. |
| `standard` | Normal coding, debugging, writing, analysis, routine research, and evidence gathering. |
| `frontier` | Architecture, hard debugging, broad refactors, consequential decisions, and every review. |

Use the harness's supported model identifier; never invent or probe one. Consequential decisions
gate money paths, releases or tests, rewrite history, set design, or authorize unchecked action.
Gather evidence at `standard`; judge it at `frontier`. Split mixed-tier work or use the higher tier.

## Choosing a tier for implementation

| Signal | Tier |
|---|---|
| 1–2 files, complete spec, exact values | `light` |
| Several files or integration with existing patterns | `standard` |
| Design decision or subsystem investigation | `frontier` |

`standard` is the floor for prose-led implementation; use `light` only for verbatim or single-file
mechanical work. Fewer turns can cost less than a cheaper model that needs repeated correction.

## Reviews

Reviews are read-only `frontier` work by an agent and model different from the author. Report if that
tier is unavailable. Review once per phase or fix batch; re-review only an open blocker tests cannot
settle, after asking. Deep reviews use two independent reviewers with different lenses.

## Archetype dispatch tiers

> **Authoritative:** this section governs each archetype's default dispatch tier.
> `core/registry/models.json` `dispatchTiers.byOwner` mirrors it and G29 asserts they match;
> change both together.

| Archetype | Tier | Why |
|---|---|---|
| `system-architect` | `frontier` | Architecture sets system shape: a consequential decision. |
| `core-implementer` | `standard` | Routine coding against a settled spec. |
| `quality-guardian` | `standard` | Its testing and evidence work; a review runs at `frontier` per-dispatch (`## Reviews`), not via `byOwner`. |
| `spec-analyst` | `standard` | Requirements analysis and routine research. |
| `research-writer` | `standard` | Documentation and routine research. |

## Briefs and inheritance

Give `light` and `standard` agents exact files, values or `path:line`, steps, and a check command.
Give `frontier` agents intent, constraints, evidence, settled decisions, and their open choices.
Agents that may spawn agents inherit this policy: `light` = verbatim/mechanical;
`standard` = routine work/research/evidence; `frontier` = architecture, hard debugging,
broad refactors, consequential decisions, and reviews. Name the tier/model per dispatch.

## Escalation inside a fix loop

After a stuck implementer, raise the tier at least once and use a fresh context.

Consult the harness's capability notes before assuming its per-dispatch model selection behavior.
