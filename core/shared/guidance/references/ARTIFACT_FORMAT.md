# Artifact Format — authoring convention for chain artifacts

How `requirement.md`, `design.md` and `plan.md` are structured so an engineer who did not write a
feature can learn what it contains without reading it end to end. Loaded on demand by
`do-brainstorm`, `do-design` and `do-plan`; not part of any always-loaded context.

Checked mechanically by `scripts/doflow/bash/validate-artifacts.sh` — advisory, never blocking.
`state.md` and contract docs are out of scope; they are already list-shaped.

## 1. Index then detail

Every enumerated, ID-bearing section opens with a table summarising its items, followed by
`**Detail**` and the full normative text of each one.

```markdown
| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-001 | One-line summary | P1 | Live |

**Detail**

- **FR-001:** The system MUST [full normative text, every qualifier and exception intact].
```

Rules:

- The **index is navigation, not a substitute.** Detail carries the full text; a reviewer must be
  able to rely on it alone for correctness. Adding an index never shortens what was already there.
- **Every index row has exactly one detail entry, and vice versa.** Orphans on either side are
  what the validator reports first.
- The first column header must be literally `ID`, and the status column header literally `Status` —
  the checker locates them by name, so a column added to the right cannot shift the check.
- A detail entry starts `- **<ID>**`. A trailing colon or a parenthetical qualifier inside the bold
  is fine: `- **FR-001:**` and `- **NFR-002 (Backward compatible):**` both parse.

Which sections take an index: `requirement.md` §3 Functional Requirements, §4 Non-Functional
Requirements and §8 Assumptions; `design.md` §3 Components & Boundaries, §7 Risks and §8
Assumptions; `plan.md` §4 Components & Changes and §6 Risks. Prose sections do not.

## 2. Status — a closed vocabulary

| Value | Meaning |
|---|---|
| `Live` | In force as written |
| `Superseded → <ref>` | Replaced; `<ref>` names what replaced it |

Nothing else is permitted — no `TBD`, `Draft`, `Done` or `WIP`. Emphasis is ignored, so
`**Superseded → FR-009**` reads the same as the bare form.

An item is **never silently deleted** once another artifact references its ID. Supersession is
recorded so a reference encountered elsewhere always resolves. An item dropped before anything
references it may simply be removed.

## 3. History — the live body stays current

When an item is superseded, its obsolete prose leaves the `**Detail**` block and moves to §9
History. The index row stays as a tombstone. Reading the body top to bottom therefore yields
current truth with no historical detours, while the supersession is still visible at a glance.

History is itself index-then-detail — a table so changes can be listed and compared, with detail
below so the reasoning behind a reversal is not compressed into a cell:

```markdown
## 9. History

| Date | ID | Change | Replaced by |
|---|---|---|---|
| 2026-07-29 | FR-001 | Field renamed during design | design §4.1 |

**Detail**

- **FR-001** — [what it said before, why it changed, what is true now].
```

A new artifact writes `None — initial version.` Every ID marked `Superseded` must appear here.

## 4. Diagrams

### Scope boundary — `requirement.md` §1

A `flowchart` showing what is in scope, what is explicitly excluded, and what outcome each
in-scope item produces, so the shape of the change is visible before the prose. Use
`subgraph IN["In scope"]` / `subgraph OUT["Out of scope"]`. Write `N/A: <why>` for a change too
small to have a meaningful boundary.

### C4 levels — `design.md` §2

C4 is kept as the **conceptual zoom model** — Context, Container, Component, each with its own
heading — and rendered with Mermaid `flowchart` plus `subgraph` blocks marking C4 boundaries.

> **Do not use the `C4Context` / `C4Container` diagram types.** They are experimental in Mermaid:
> the layout engine offers no direction control and routes relationship arrows so labels collide
> with arrowheads, and output varies across renderer versions — some decline to draw them at all.
> `flowchart` is the most widely supported type, gives explicit `TB`/`LR` direction, and puts
> relationship labels legibly on the arrow.

| Level | Shows | Required? |
|---|---|---|
| C1 Context | Actors and external systems. One box per actor or external system — no internals | yes |
| C2 Container | Independently deployable units and how they talk | yes |
| C3 Component | Internals of one container | only when the feature touches 3+ components in a single container |

Put the interaction on the arrow — `-->|"reads"|` — and distinguish secondary or asynchronous
relations with `-.->`. Skip a level with `N/A: <why>`; for C3 that is normally
`N/A: covered by §3 Components & Boundaries`.

## 5. plan.md — phase rollup

§8 gains a phase-level summary above the checklists:

```markdown
### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 2 | Verification layer | yes |
```

The heading is `### Task Summary`, not `### Phase Summary` — the latter collides with the
`### Phase <X>` pattern the checker uses to find phase sections.

**The per-task `- [ ]` checklist is the single source of truth for tasks and is never mirrored
into a per-task index table.** Duplicating every task line would recreate exactly the
hand-maintained-inventory drift this convention exists to prevent, in the one file where drift is
most costly — and `/do-execute-plan` parses those markers as an execution contract, so their
syntax must not change.

Each rollup row's task count must match the `- [ ]` lines under its `### Phase <X>` heading.

## 6. Tables for comparison

Where an artifact presents comparative or evidentiary data — several items measured on the same
axes, a before/after contrast, a list of changes — lay it out as a table rather than prose or
nested bullets, so items compare column-wise at a glance.

## 7. What the checker does and does not do

Run `validate-artifacts.sh [--json] [--slug=<slug>] [<path>...]` after writing. Exit `0` clean,
`1` on findings, `0` plus a printed note when it cannot work out what to check (no active feature,
resolver or `jq` unavailable).

A file that was named explicitly but cannot be read or parsed is a **finding**, not a fail-open —
it exits `1` and says the file was not checked. Silence there would report a clean result for a
file nobody looked at.

Checked: index/detail parity both directions · `Status` vocabulary · ID-shaped supersede targets
resolve · superseded items have a History entry · plan rollup counts match the checklist.

Not checked: whether an index summary faithfully describes its detail, whether a diagram is
accurate, whether a required section exists at all. It is a **consistency** checker, not a
conformance checker — which is also why artifacts written before this convention, having no index
tables, pass without needing a version marker.

Findings are reported to the author and never repaired automatically: when an index and its detail
disagree, deciding which one is wrong is authoring judgement, not a mechanical fix.
