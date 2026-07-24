---
name: do-spec-panel
description: "Multi-expert specification review and improvement using renowned specification and software engineering experts"
argument-hint: "[specification_content|@file] [--mode discussion|critique|socratic] [--experts \"name1,name2\"] [--focus requirements|architecture|testing|compliance] [--iterations N] [--format standard|structured|detailed]"
effort: high
---

# do-spec-panel

Reviews a specification (requirement/design doc) through multiple named expert lenses applied in
sequence within one response — not separate subagent spawns unless the input is large enough to
warrant parallelizing per lens via `/parallel-agents`.

## Invocation
```text
/do-spec-panel [specification_content|@file] [--mode discussion|critique|socratic] [--experts "name1,name2"] [--focus requirements|architecture|testing|compliance] [--iterations N] [--format standard|structured|detailed]
```

## Behavioral Flow
1. **Load the spec** — `@file` reads the actual file (typically `requirement.md`/`design.md` for a
   doflow feature); inline content is used as-is.
2. **Select the panel** — default experts by `--focus`: `requirements` → a completeness/
   ambiguity-focused reviewer (unstated assumptions, untestable acceptance criteria);
   `architecture` → a systems-design reviewer (coupling, failure modes, scalability); `testing` →
   a verifiability reviewer (is every FR/AC actually checkable); `compliance` → a
   standards/regulatory reviewer if the spec touches a regulated domain. `--experts` overrides
   with named lenses instead of the focus-based default.
3. **Review** by `--mode`: `critique` — each lens produces its findings independently, no
   cross-talk. `discussion` — lenses respond to each other's findings where they conflict.
   `socratic` — each lens asks the spec's author probing questions instead of stating verdicts
   directly (mirrors `/do-brainstorm`'s Socratic approach, applied to critique instead of
   discovery).
4. **Synthesize**: consolidate findings across lenses, dedupe overlapping points, flag genuine
   disagreements between lenses rather than averaging them away.
5. **Rank recommendations** by impact (would this cause a real defect or rework if unaddressed) —
   not just by which lens raised it.
6. **`--iterations N`**: repeat steps 3-5 against a revised spec if the user applies feedback
   between rounds; `N` caps how many rounds this runs unattended before stopping to check in.

## Boundaries
**Will:** review an existing spec through multiple named expert lenses; produce ranked,
actionable findings; flag genuine cross-lens disagreement.
**Will Not:** write a specification from scratch (needs existing content to review); modify the
spec file directly — findings are a report, applying them is a separate, explicit step; claim
regulatory/legal compliance sign-off (advisory only).

## Next Step
Apply the accepted recommendations to the spec (by hand, or `/do-brainstorm`/`/do-design` to
re-run discovery on the flagged gaps), then `/do-plan` once the spec is settled.
