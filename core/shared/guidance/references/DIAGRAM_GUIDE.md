# Diagram Guide — what a good chain diagram looks like

`ARTIFACT_FORMAT.md` §4 says which artifact carries which diagram slot. This file says what belongs
inside one. Read on demand by `do-brainstorm`, `do-design` and `do-plan` at the point each fills a
slot, and never loaded by default.

**Scope.** These rules govern every Mermaid diagram in a feature directory, including ones in
`as-is/`, `target/` or any other subdirectory; the slot registry in `ARTIFACT_FORMAT.md` §4
lists only the slots a template scaffolds.

## 1. Permitted types

| Type | Carries |
|---|---|
| `flowchart` | Structure, scope boundaries, C4 levels, dependency order |
| `sequenceDiagram` | Time-ordered interaction between participants |
| `erDiagram` | Entities with attributes, keys and cardinality |
| `stateDiagram-v2` | States, transitions and the guards between them |

**The admission rule.** A type joins this list when it renders in GitHub, the VS Code Markdown
preview and Obsidian with no reader-installed plugin, and its grammar is not marked
experimental by Mermaid. Both halves matter: a grammar still moving will silently change shape under
artifacts already written.

**C4 is a zoom model here, not a diagram type.** `C4Context`, `C4Container`, `C4Component` and
`C4Dynamic` fail the rule's second half: Mermaid's C4 documentation calls the diagram experimental,
and its labels and layout are hand-placed, one `UpdateRelStyle` call per relationship. Render
every C4 level with `flowchart` plus `subgraph`, which gives explicit direction and puts each label
on its arrow.

**Everything else is excluded too**, including types that render widely (`journey`, `timeline`,
`quadrantChart`, `gitGraph`, `mindmap`) and every `-beta` grammar. Each added type is another set of
conventions that drift between renderers; four cover what the chain needs.

## 2. Choosing between them

| When the content is… | Reach for |
|---|---|
| What is in and out of scope | `flowchart`, `subgraph IN` / `subgraph OUT` |
| Actors and external systems, or deployable units, or a container's internals | `flowchart` with `subgraph` boundaries, one per C4 level |
| Phases, tasks and what must finish before what | `flowchart`, direction `LR` |
| Who calls whom, in what order, with the failure branch | `sequenceDiagram` |
| Entities and the relationships between them, no attributes yet | `flowchart` |
| Entities with their fields, keys and cardinality | `erDiagram` |
| A run, a lifecycle, or anything with named states and guarded transitions | `stateDiagram-v2` |

Two rules of thumb. If a three-column table says the same thing, write the table. If the content
wants two of these at once, it is two diagrams.

## 3. Complexity budget

Each type is bounded on what makes it illegible, not by one number.

| Type | Element ceiling | Link ceiling |
|---|---|---|
| `flowchart` | 12 nodes | 16 edges |
| `sequenceDiagram` | 8 lifelines | none |
| `erDiagram` | 8 entities | none |
| `stateDiagram-v2` | 10 states | none |

`subgraph` containers are grouping and do not count toward the node ceiling.

**Why only `flowchart` carries a link ceiling.** A `sequenceDiagram` lays out in columns, so nothing
tangles. A `flowchart` is routed by the layout engine, and past a certain density its edges
overlap or cross unrelated boxes.

**Where the numbers come from.** 56 Mermaid diagrams in a completed feature. Flowchart node counts
were bimodal (eleven at six or fewer, four at seventeen or more, none from twelve to sixteen), so
the ceiling sits in that empty band. Twenty-three of twenty-six sequence diagrams had eight
lifelines or fewer. Entity and state counts never passed six and seven, so those two ceilings are
intent, not a tested bound. Re-measure before moving one.

## 4. When a diagram is over budget

Split it into an overview and a detail diagram: the overview keeps the boxes a reader needs to
orient, and one of them expands into the detail beneath it. Do not shrink labels, drop arrow labels
or accept the crowding: a diagram past the ceiling is two ideas sharing a frame.

The one alternative is deletion. Two nodes that always travel together are one node, and a
relationship obvious from the layout needs no line.

## 5. Conventions

**Direction is declared.** Write `flowchart TB` or `flowchart LR`: `LR` for a progression (scope,
phases, dependency order), `TB` for containment or hierarchy.

**Labels go on the arrow, not in the node.** `A -->|"reads"| B`, not a node named "reads from B".
An arrow label is a short verb phrase; one that needs a clause wants two arrows or another type.
Quote every label, so a comma or a parenthesis inside it cannot end it early.

**Node ids are short and stable; the text lives in the brackets.** `SVC["Payment service"]`, not
`PaymentService["Payment service"]`. A later edit reuses the id; the label changes freely.

**`subgraph` marks a boundary, and its label is quoted**: `subgraph boundary["Payment platform"]`.
Use it for a trust boundary, a deployable unit, a C4 level or a scope partition, not to group things
that look similar.

**In a `sequenceDiagram`, prefer `rect` over `par` to mark a region.** `par` reads as "these happen
at once", which most groupings cannot support. Reserve `par` for real parallelism and use `alt` for
a branch.

**Keep edges inside their boundary.** An edge that crosses a `subgraph` boundary is the one the
layout engine routes across others, leaving overlapped arrows and stranded labels. The node ceiling
does not catch it: six nodes with two crossing edges tangle where nine fanning into one sink stay
clean. Prefer edges within a boundary, or between two boundaries at the same level; when a node must
reach out of a nested one, the boundary is usually in the wrong place: move it, or lift the node out.

**Secondary and asynchronous relations use `-.->`.** The dashed arrow means optional, deferred or
out of band, and nothing else.

**Skipping a slot is `N/A: [why]`**, defined once in `ARTIFACT_FORMAT.md` §4. A slot left silently
empty reads as an oversight.

## 6. Authored sources

Some features author diagrams in PlantUML under `design/c4/` and commit the render. These apply on top of everything above.

**C4 divides by level**: `context.puml`, `container.puml`, `component.puml`, one file each; a level not drawn has no file. The Mermaid in `design.md` System Overview (C4) is generated from these, so editing it by hand
is a change the next render discards.

**The generated view drops seven things** — element type, technology, description, sprite, tag, link
and the legend — keeping nodes, edges, labels and boundaries. Need any of the seven, open the image:
the generated block names its source.

**Which tool**: Mermaid for working diagrams in an artifact; PlantUML for lanes and full C4 with
technology; draw.io only for a presentation copy that `render-drawio` writes into
`design/presentation/`, never the source of truth.

**A flow gets one lane per actor**, ordered by who acts first, with the failure branch reaching its
own terminal. One file per flow, `flow-<name>.puml`, matching its `#### Flow: <name>` heading. Skip
with `N/A: [why]` for a single-actor flow.

## 7. Anti-patterns

| Pattern | Why it fails |
|---|---|
| A node per step of a process that has no branches | A numbered list says it in fewer words |
| Every node the same shape and weight | Shape is the only hierarchy a diagram has; spending none of it flattens everything |
| An arrow with no label | The reader can see two things are connected and has to guess how |
| A label long enough to wrap | A wrapped label pushes its own arrow around and reads as a sentence, not an annotation |
| Restating a table that sits directly above it | Two representations of one fact drift apart |
| Colour or `classDef` styling as the only way to read it | Styling varies by renderer and theme; anything load-bearing belongs in the structure or the labels |

## 8. What each slot has to show

The ceilings in §3 stop a diagram carrying too much. This is the other bound: a diagram that carries
less than the sentence beside it. Of 130 flowcharts in sixteen completed features, about one in six
had three edges or fewer.

**The test.** A diagram stays when it shows at least one thing the prose or table next to it does
not: a boundary, a branch, a direction of flow, or an order. Three boxes in a row are a sentence;
write the sentence and mark the slot `N/A: [why]`.

| Slot | Has to show |
|---|---|
| Scope boundary | Each in-scope item with the outcome it produces, and each excluded item a reader would otherwise assume is in |
| C4 Level 1 | Each actor that starts a journey as its own box; each external system, tool or file store the feature reads or writes; this system as one box. An edge label says what crosses, in the direction it moves |
| C4 Level 2 | Each process, deployable unit and data store the feature spans, files on disk included; the technology or runtime on a node's second line; the call form and the payload on an edge; a `subgraph` at each trust boundary |
| C4 Level 3 | The components of Components & Boundaries by name, a new or changed one marked in its label (`(new)`, `(changed)`), and the store each reads or writes |
| Concepts | Each noun the journeys use, with the cardinality or the rule on each relationship |
| Journey | The trigger, each decision, and for each decision the failure outcome as the actor sees it; the record the journey leaves behind. With three or more participants, a `sequenceDiagram` with the failure in an `alt` |
| State | Each state the record can hold, terminal ones included, and on each transition the event and its guard |
| Task dependency | The phase boundaries, the edges that force the order, and the `[P]` mark on a task that may run in parallel |
| ER view | Keys, the cardinality on each relation, and each field a contract or a rule names |

**Name the real thing in `data-model.md`.** A label there carries the name a reader can search for
(the file, the table, the field), not its category. `design.md` keeps plain nouns through Journeys.

When this floor and a ceiling collide, split as §4 says.
