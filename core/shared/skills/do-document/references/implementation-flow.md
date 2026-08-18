# {Feature Name} — Implementation Flow

> **Template version**: 1.0
>
> Reference for `/do-document --type impl`. It explains what each section of a generated
> `implementation-flow.md` must contain and where to pull the content from — it is not itself a
> filled-in implementation doc. Replace `{placeholders}` with real content when writing the actual
> file to `agent-docs/doflow/<slug>/implementation-flow.md` for the active feature (same
> slug-resolution mechanism the rest of the doflow chain already uses for
> `requirement.md`/`design.md`/`plan.md` — do not introduce a second one).
>
> Every section below is narrative except **Changed Surfaces**, which is a table — comparative,
> evidentiary data (a set of paths each paired with what changed) falls under the guidance tree's
> `references/ARTIFACT_FORMAT.md` §6's rule to lay that out column-wise rather than as prose or
> nested bullets.
>
> No section here is ID-bearing. This file — and any `implementation-flow.md` generated from it —
> does not participate in `validate-artifacts.sh`'s index/detail check.

---

## Header [Required]

Mirrors the metadata-header convention `design-template.md` already uses — a single line of
bold-label/value pairs separated by `·`, with chain artifacts cross-referenced as plain relative
paths (not markdown link syntax, matching `design-template.md`'s `./requirement.md`) — extended
with `Branch` and links to `./design.md` and `./plan.md` in addition to `./requirement.md`, since an
implementation summary sits downstream of all three:

**Feature:** `[NNN-slug]` · **Branch:** `[branch-name]` · **Status:** Draft · **Created:** `[DATE]`
· **Requirement:** ./requirement.md · **Design:** ./design.md · **Plan:** ./plan.md

- **Feature / Branch** — resolved via the same active-feature mechanism the rest of the doflow
  chain uses; do not hand-derive the slug from the directory name or guess it from `git branch`
  independently.
- **Status** — `Draft` while the summary is being written, `In-Review` once posted for review,
  `Done` once accepted. This is the impl doc's own status, not `plan.md`'s task-checklist status.
- **Created** — the date this implementation summary was generated, not when the feature started.
- **Requirement / Design / Plan** — relative links into the same feature directory, exactly like
  `design-template.md`'s header links to `./requirement.md`. Every doflow feature has all three by
  the time `--type impl` is run (implementation follows planning), so none of these three links is
  optional.

## Summary [Required]

1–3 sentences: what was built, in plain language a reader who has not touched the chain artifacts
can follow. State the outcome, not the process — "added X so that Y" rather than a chronology of
commits.

`{one-to-three-sentence summary of what shipped}`

## Key Decisions [Required]

Narrative, not a table — decisions read as reasoning, not comparable rows. Cover the choices made
*during* implementation that a reader would otherwise have to reconstruct from the diff: which
approach was taken when more than one was viable, why a particular library/pattern/boundary was
used, and anywhere the build surfaced a question `design.md` left open.

Where a decision traces back to something `design.md` already recorded, reference it by section and
ID rather than restating it — e.g. "Followed design.md §3 C2's boundary: the adapter owns
serialization, per the Components & Boundaries split" or "Accepted the risk noted in design.md §7
R2; see below for what that cost in practice." Decisions with no design.md antecedent (something
that only became a decision once code was being written) still belong here, just without a
back-reference.

`{narrative: what was decided and why, cross-referencing design.md §3/§7 where applicable}`

## Deviations from Plan/Design [Required]

Narrative. Anywhere the actual implementation diverged from what `plan.md`'s tasks or `design.md`'s
shape called for — a task done differently than scoped, a component boundary that moved, a step
skipped or added — explain what changed and why. This is what lets a future reader trust
`plan.md`/`design.md` as history without re-diffing them against the code.

If nothing diverged, write exactly:

`None — implemented as designed.`

## Changed Surfaces [Required]

A table, populated from `git diff` (or the equivalent comparison against the branch's base) for the
feature's commits — not hand-recalled from memory. One row per changed path; "what changed" is a
short phrase, not a full diff.

| Path | What Changed |
|------|---------------|
| `{path/to/file}` | `{one-line description of the change}` |

## Testing & Verification [Required]

Narrative: what was run and how the change was verified — unit/integration tests executed, manual
checks performed, and their outcome. Reference the plan's verification bar or design's acceptance
criteria where the testing directly maps to one of them, but describe what actually happened, not
what was merely planned.

`{narrative: tests run, manual verification performed, and results}`

## Follow-ups / Known Gaps [Required]

Narrative. Anything intentionally left undone — known limitations, deferred work, follow-up tasks
worth tracking separately — belongs here so it isn't lost once the feature is marked complete.

If there are none, write exactly:

`None.`
